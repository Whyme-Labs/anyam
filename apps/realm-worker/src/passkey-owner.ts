import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";

import type {
  AnyamRealmOAuthAuthorization,
  AnyamRealmOAuthAuthorizationAdapter,
  AnyamRealmOAuthAuthorizationDecision,
  AnyamRealmOAuthEnv,
} from "./oauth-provider.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "./coordinator-protocol.ts";
import { toOAuthSubject } from "../../../src/identity/oauth-subject.ts";

export const ANYAM_PASSKEY_OWNER_PROTOCOL = "anyam.passkey-owner/v1" as const;
export const ANYAM_PASSKEY_CHALLENGE_TTL_SECONDS = 300;
export const ANYAM_OWNER_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const ANYAM_PASSKEY_SIZING_RECEIPT = "challengeTtl=300s; sessionTtl=28800s; sizing=qualification-tripwire; remeasure-before-production" as const;

const SESSION_PREFIX = "anyam:passkey:session:";
const OWNER_BOOTSTRAP_HEADER = "x-anyam-owner-bootstrap-token";
const COOKIE_NAME = "anyam_owner_session";

type PasskeyChallenge = {
  readonly ceremony: "registration" | "authentication";
  readonly challenge: string;
  readonly realmId: string;
  readonly userId?: string;
  readonly displayName?: string;
  readonly createdAt: string;
};

type OwnerSession = {
  readonly protocol: typeof ANYAM_PASSKEY_OWNER_PROTOCOL;
  readonly sessionId: string;
  readonly realmId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly credentialId: string;
  readonly kernelSessionId: string;
  readonly actorId: string;
  readonly expiresAt: string;
  readonly createdAt: string;
};

type PasskeyRow = {
  credential_id: string;
  realm_id: string;
  user_id: string;
  display_name: string;
  public_key: string;
  counter: number;
  transports: string;
};

type OwnerRow = {
  realm_id: string;
  user_id: string;
  display_name: string;
  credential_id: string;
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function realmId(env: AnyamRealmOAuthEnv): string {
  return `realm:${env.ANYAM_INSTALLATION_ID ?? "unconfigured"}`;
}

function configuredRelyingPartyId(env: AnyamRealmOAuthEnv, request: Request): string {
  return env.ANYAM_REALM_RP_ID?.trim() || new URL(request.url).hostname;
}

export async function requestAnyamRealmCoordinator(env: AnyamRealmOAuthEnv, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const binding = env.REALM_COORDINATOR as unknown as DurableObjectNamespace | undefined;
  if (!binding || typeof binding.idFromName !== "function") throw new Error("realm_coordinator_unavailable");
  const stub = binding.get(binding.idFromName(realmId(env)));
  const response = await stub.fetch(new Request(`https://anyam-realm-coordinator${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE },
    body: JSON.stringify(body),
  }));
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof payload.code === "string" ? payload.code : "realm_coordinator_rejected";
    const message = typeof payload.message === "string" ? payload.message : "coordinator rejected the request";
    const recoveryAction = typeof payload.recoveryAction === "string" ? payload.recoveryAction : "inspect the coordinator receipt and retry the same operation only when safe";
    const receipt = typeof payload.receipt === "string" ? payload.receipt : "receipt=not-returned";
    throw new Error(`realm_coordinator_${code}; message=${message}; recoveryAction=${recoveryAction}; ${receipt}`);
  }
  return payload;
}

const realmCoordinatorRequest = requestAnyamRealmCoordinator;

async function issuePasskeyChallenge(env: AnyamRealmOAuthEnv, input: { challengeId: string; ceremony: "registration" | "authentication"; challenge: string; userId?: string; displayName?: string }): Promise<void> {
  const expiresAt = new Date(Date.now() + ANYAM_PASSKEY_CHALLENGE_TTL_SECONDS * 1000).toISOString();
  await realmCoordinatorRequest(env, "/identity/passkey-challenge/issue", {
    challengeId: input.challengeId,
    ceremony: input.ceremony,
    challenge: input.challenge,
    realmId: realmId(env),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    expiresAt,
  });
}

async function consumePasskeyChallenge(env: AnyamRealmOAuthEnv, challengeId: string, ceremony: "registration" | "authentication"): Promise<PasskeyChallenge> {
  const result = await realmCoordinatorRequest(env, "/identity/passkey-challenge/consume", { challengeId, ceremony });
  const value = result.challenge;
  if (value === null || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).ceremony !== ceremony || typeof (value as Record<string, unknown>).challenge !== "string" || typeof (value as Record<string, unknown>).realmId !== "string") throw new Error("realm_coordinator_challenge_malformed");
  return value as PasskeyChallenge;
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return `${prefix}:${value}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie") ?? "";
  return Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter(([key, value]) => Boolean(key && value)).map(([key, ...values]) => [key, values.join("=")]));
}

function sessionCookie(sessionId: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; Max-Age=${ANYAM_OWNER_SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function expiredSessionCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function ownerPage(mode: "claim" | "login"): Response {
  const claim = mode === "claim";
  const title = claim ? "Claim Anyam Realm" : "Sign in to Anyam Realm";
  const heading = claim ? "Claim this Realm" : "Sign in to this Realm";
  const bootstrapField = claim ? `
      <label>One-time bootstrap secret
        <input id="bootstrap" type="password" autocomplete="off" spellcheck="false" required>
      </label>
      <p class="hint">The secret is kept in memory for this ceremony only. It is never placed in the URL or stored by this page.</p>` : "";
  const script = String.raw`
    const mode = ${JSON.stringify(mode)};
    const result = document.getElementById("result");
    const button = document.getElementById("continue");
    const status = (message) => { result.textContent = message; };
    const decode = (value) => {
      const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    };
    const encode = (value) => {
      const bytes = new Uint8Array(value);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    };
    const creationOptions = (options) => {
      if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(options);
      return {
        ...options,
        challenge: decode(options.challenge),
        user: { ...options.user, id: decode(options.user.id) },
        excludeCredentials: (options.excludeCredentials ?? []).map((credential) => ({ ...credential, id: decode(credential.id) })),
      };
    };
    const requestOptions = (options) => {
      if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(options);
      return {
        ...options,
        challenge: decode(options.challenge),
        allowCredentials: (options.allowCredentials ?? []).map((credential) => ({ ...credential, id: decode(credential.id) })),
      };
    };
    const responseJSON = (credential) => {
      if (credential.toJSON) return credential.toJSON();
      const response = credential.response;
      const output = { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response: { clientDataJSON: encode(response.clientDataJSON) } };
      if ("attestationObject" in response) output.response.attestationObject = encode(response.attestationObject);
      if ("authenticatorData" in response) output.response.authenticatorData = encode(response.authenticatorData);
      if ("signature" in response) output.response.signature = encode(response.signature);
      if ("userHandle" in response && response.userHandle) output.response.userHandle = encode(response.userHandle);
      return output;
    };
    const call = async (path, body, bootstrap) => {
      const headers = { "content-type": "application/json" };
      if (bootstrap) headers["x-anyam-owner-bootstrap-token"] = bootstrap;
      const response = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({ code: "invalid_json_response" }));
      if (!response.ok) throw new Error(payload.recoveryAction ? payload.code + ": " + payload.recoveryAction : payload.code ?? "request_failed");
      return payload;
    };
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("webauthn_unavailable: use a browser with WebAuthn support");
        const bootstrap = mode === "claim" ? document.getElementById("bootstrap").value : undefined;
        if (mode === "claim" && !bootstrap) throw new Error("owner_bootstrap_required: enter the one-time bootstrap secret");
        const displayName = mode === "claim" ? (document.getElementById("displayName").value.trim() || "Anyam Realm owner") : undefined;
        const options = await call(mode === "claim" ? "/api/owner/passkey/register/options" : "/api/owner/passkey/auth/options", mode === "claim" ? { displayName } : {}, bootstrap);
        const credential = mode === "claim"
          ? await navigator.credentials.create({ publicKey: creationOptions(options.options) })
          : await navigator.credentials.get({ publicKey: requestOptions(options.options) });
        if (!credential) throw new Error("webauthn_cancelled: no credential returned");
        const verified = await call(mode === "claim" ? "/api/owner/passkey/register/verify" : "/api/owner/passkey/auth/verify", { challengeId: options.challengeId, response: responseJSON(credential) }, bootstrap);
        status(JSON.stringify(verified, null, 2));
        button.textContent = mode === "claim" ? "Realm claimed" : "Signed in";
      } catch (error) {
        status(error instanceof Error ? error.message : "owner_authentication_failed");
        button.disabled = false;
      }
    });
  `;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#17202a}main{border:1px solid #d6dbe1;border-radius:12px;padding:2rem}label{display:grid;gap:.4rem;margin:1rem 0}input{font:inherit;padding:.65rem;border:1px solid #9aa5b1;border-radius:6px}button{font:inherit;padding:.7rem 1rem;border:0;border-radius:6px;background:#14532d;color:white;cursor:pointer}button:disabled{opacity:.6;cursor:wait}.hint{font-size:.9rem;color:#52606d}pre{white-space:pre-wrap;background:#f4f6f8;padding:1rem;border-radius:6px;min-height:2rem}</style></head>
<body><main><h1>${heading}</h1><p>Anyam verifies this Realm-bound passkey in the customer-owned Worker.</p>
${claim ? `<label>Display name<input id="displayName" autocomplete="name" value="Anyam Realm owner"></label>` : ""}${bootstrapField}
<button id="continue" type="button">${claim ? "Create owner passkey" : "Use passkey"}</button><pre id="result" aria-live="polite"></pre></main>
  <script>${script.replaceAll("</script>", "<\\/script>")}</script></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'" } });
}

function qualificationPage(): Response {
  const script = String.raw`
    const result = document.getElementById("result");
    const providerResult = document.getElementById("providerResult");
    const providerSurface = document.getElementById("providerSurface");
    const providerFailureMode = document.getElementById("providerFailureMode");
    const providerOperationId = document.getElementById("providerOperationId");
    const state = { delegation: undefined, recovery: undefined, providerRecovery: undefined };
    const show = (value) => { result.textContent = JSON.stringify(value, null, 2); };
    const summary = (value) => {
      if (!value || typeof value !== "object") return value;
      const output = {};
      for (const key of ["protocol", "status", "receipt", "agentId", "agentSessionId", "taskId", "grantId", "workspaceId", "recoveryStatus", "ownerPrincipalId", "identity", "credentialClasses"]) if (key in value) output[key] = value[key];
      if (Array.isArray(value.credentials)) output.credentials = value.credentials.map((credential) => ({ id: credential.id, class: credential.class, audience: credential.audience, expiresAt: credential.expiresAt, token: "[redacted]" }));
      if (value.snapshot && typeof value.snapshot === "object") output.snapshot = { credentialFree: value.snapshot.credentialFree, realmId: value.snapshot.realm?.id, principalCount: Object.keys(value.snapshot.principals ?? {}).length, sessionCount: Object.keys(value.snapshot.sessions ?? {}).length, grantCount: Object.keys(value.snapshot.grants ?? {}).length };
      return output;
    };
    const call = async (path, body = {}) => {
      const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({ code: "invalid_json_response" }));
      if (!response.ok) throw payload;
      return payload;
    };
    const showProvider = (value) => { providerResult.textContent = JSON.stringify(value, null, 2); };
    const providerDigest = async (value) => {
      const bytes = new TextEncoder().encode(value);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return "sha256:" + Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const ensureProviderOperationId = () => {
      if (!providerOperationId.value.trim()) providerOperationId.value = "qualification-" + crypto.randomUUID();
      return providerOperationId.value.trim();
    };
    const providerRun = async () => {
      const operationId = ensureProviderOperationId();
      const surface = providerSurface.value;
      const failureMode = providerFailureMode.value;
      return call("/api/owner/qualification/provider-operation", {
        operationId,
        idempotencyKey: "idempotency:" + operationId,
        surface,
        failureMode,
        payloadDigest: await providerDigest("anyam.p3-24.customer-provider/" + surface + "/" + operationId),
      });
    };
    const providerRunAction = async (operation) => {
      try {
        if (operation === "new") {
          providerOperationId.value = "qualification-" + crypto.randomUUID();
          showProvider({ status: "ready", operationId: providerOperationId.value, receipt: "new-operation-identity; provider-mutation=not-started" });
          return;
        }
        if (operation === "run") {
          showProvider(await providerRun());
          return;
        }
        const operationId = ensureProviderOperationId();
        if (operation === "resume") {
          showProvider(await call("/api/owner/qualification/provider-operation/resume", { operationId }));
          return;
        }
        if (operation === "cleanup") {
          showProvider(await call("/api/owner/qualification/provider-operation/cleanup", { operationId }));
          return;
        }
        if (operation === "export") {
          state.providerRecovery = await call("/api/owner/qualification/provider-recovery/export");
          showProvider(state.providerRecovery);
          return;
        }
        if (operation === "restore") {
          if (!state.providerRecovery?.bundle) throw { code: "provider_recovery_export_required", recoveryAction: "Export the provider-operation Recovery bundle first in this page." };
          showProvider(await call("/api/owner/qualification/provider-recovery/restore", { bundle: state.providerRecovery.bundle }));
          return;
        }
      } catch (error) {
        showProvider(error);
      }
    };
    const run = async (operation) => {
      try {
        if (operation === "delegate") {
          state.delegation = await call("/api/owner/qualification/delegate", { agentName: "Anyam qualification agent", runtime: "qualification-browser", modelProvider: "qualification-model" });
          show(summary(state.delegation));
          return;
        }
        if (operation === "credentials") {
          if (!state.delegation?.agent || !state.delegation.session || !state.delegation.task || !state.delegation.grant) throw { code: "qualification_delegate_required", recoveryAction: "Run delegation first in this page." };
          const value = await call("/api/owner/qualification/credentials", { agentId: state.delegation.agent.id, agentSessionId: state.delegation.session.id, taskId: state.delegation.task.id, grantId: state.delegation.grant.id, credentialClasses: ["git", "mcp"] });
          show(summary(value));
          return;
        }
        if (operation === "revoke") {
          const value = await call("/api/owner/qualification/revoke", { agentId: state.delegation?.agent?.id });
          show(summary(value));
          return;
        }
        if (operation === "export") {
          state.recovery = await call("/api/owner/qualification/recovery/export");
          show(summary(state.recovery));
          return;
        }
        if (operation === "restore") {
          if (!state.recovery?.snapshot) throw { code: "qualification_recovery_export_required", recoveryAction: "Export a fresh recovery snapshot first." };
          const value = await call("/api/owner/qualification/recovery/restore", { snapshot: state.recovery.snapshot });
          show(summary(value));
          return;
        }
      } catch (error) {
        show(error);
      }
    };
    for (const button of document.querySelectorAll("button[data-operation]")) button.addEventListener("click", () => run(button.dataset.operation));
    for (const button of document.querySelectorAll("button[data-provider-operation]")) button.addEventListener("click", () => providerRunAction(button.dataset.providerOperation));
  `;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anyam Realm qualification</title>
<style>body{font:16px system-ui,sans-serif;max-width:54rem;margin:3rem auto;padding:0 1rem;color:#17202a}main{border:1px solid #d6dbe1;border-radius:12px;padding:2rem}button{font:inherit;margin:.25rem;padding:.65rem .8rem;border:0;border-radius:6px;background:#14532d;color:white;cursor:pointer}p{color:#52606d}pre{white-space:pre-wrap;background:#f4f6f8;padding:1rem;border-radius:6px;min-height:8rem}</style></head>
<body><main><h1>Realm qualification</h1><p>These controls use the current opaque owner session. Credential values are never displayed; recovery remains in memory for this page only.</p>
<div><button type="button" data-operation="delegate">Delegate agent</button><button type="button" data-operation="credentials">Issue Git + MCP credentials</button><button type="button" data-operation="revoke">Revoke delegated agent</button><button type="button" data-operation="export">Export recovery snapshot</button><button type="button" data-operation="restore">Restore recovery snapshot</button></div>
<pre id="result" aria-live="polite"></pre>
<hr>
<h2>Customer-provider qualification</h2>
<p>These owner-only controls exercise the named disposable D1, R2, Queue, Workflow, and Worker adapters. They never return provider credentials or canonical-write authority.</p>
<label>Surface<select id="providerSurface"><option value="d1">D1</option><option value="r2">R2</option><option value="queue">Queue</option><option value="workflow">Workflow</option><option value="worker">Worker</option></select></label>
<label>Failure mode<select id="providerFailureMode"><option value="none">none</option><option value="provider-outage">provider-outage</option><option value="authorization-revoked">authorization-revoked</option><option value="timeout">timeout</option><option value="duplicate-delivery">duplicate-delivery</option><option value="partial-mutation">partial-mutation</option></select></label>
<label>Operation identity<input id="providerOperationId" autocomplete="off" placeholder="Generated when Run operation is clicked"></label>
<div><button type="button" data-provider-operation="new">New operation identity</button><button type="button" data-provider-operation="run">Run operation</button><button type="button" data-provider-operation="resume">Resume exact operation</button><button type="button" data-provider-operation="cleanup">Cleanup exact operation</button><button type="button" data-provider-operation="export">Export provider recovery</button><button type="button" data-provider-operation="restore">Restore provider recovery</button></div>
<pre id="providerResult" aria-live="polite"></pre></main><script>${script.replaceAll("</script>", "<\\/script>")}</script></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'" } });
}

async function ownerBootstrapTokenMatches(request: Request, env: AnyamRealmOAuthEnv): Promise<boolean> {
  const expected = env.ANYAM_OWNER_BOOTSTRAP_TOKEN?.trim();
  const presented = request.headers.get(OWNER_BOOTSTRAP_HEADER)?.trim();
  if (!expected || !presented) return false;
  const [expectedDigest, presentedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(presented)),
  ]);
  const expectedBytes = new Uint8Array(expectedDigest);
  const presentedBytes = new Uint8Array(presentedDigest);
  let difference = expectedBytes.length ^ presentedBytes.length;
  for (let index = 0; index < expectedBytes.length; index += 1) difference |= (expectedBytes[index] ?? 0) ^ (presentedBytes[index] ?? 0);
  return difference === 0;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new Error("json_invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("json_object_required");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field}_required`);
  return value.trim();
}

async function ensureSchema(env: AnyamRealmOAuthEnv): Promise<void> {
  await env.ANYAM_METADATA_DB.prepare(`
    CREATE TABLE IF NOT EXISTS anyam_realm_owners (
      realm_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
  await env.ANYAM_METADATA_DB.prepare(`
    CREATE TABLE IF NOT EXISTS anyam_realm_passkeys (
      credential_id TEXT PRIMARY KEY,
      realm_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL,
      transports TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
}

async function owner(env: AnyamRealmOAuthEnv, id: string): Promise<OwnerRow | undefined> {
  const result = await env.ANYAM_METADATA_DB.prepare("SELECT realm_id, user_id, display_name, credential_id FROM anyam_realm_owners WHERE realm_id = ?1").bind(id).first<OwnerRow>();
  return result ?? undefined;
}

async function passkeys(env: AnyamRealmOAuthEnv, id: string): Promise<PasskeyRow[]> {
  const result = await env.ANYAM_METADATA_DB.prepare("SELECT credential_id, realm_id, user_id, display_name, public_key, counter, transports FROM anyam_realm_passkeys WHERE realm_id = ?1").bind(id).all<PasskeyRow>();
  return result.results;
}

async function issueSession(env: AnyamRealmOAuthEnv, input: Omit<OwnerSession, "protocol" | "sessionId" | "createdAt">): Promise<{ sessionId: string; cookie: string }> {
  const sessionId = randomId("owner-session");
  const session: OwnerSession = {
    protocol: ANYAM_PASSKEY_OWNER_PROTOCOL,
    sessionId,
    ...input,
    createdAt: new Date().toISOString(),
  };
  await env.OAUTH_KV.put(`${SESSION_PREFIX}${sessionId}`, JSON.stringify(session), { expirationTtl: ANYAM_OWNER_SESSION_TTL_SECONDS });
  return { sessionId, cookie: sessionCookie(sessionId) };
}

async function readSession(request: Request, env: AnyamRealmOAuthEnv): Promise<OwnerSession | undefined> {
  const sessionId = parseCookies(request)[COOKIE_NAME];
  if (!sessionId) return undefined;
  const session = await env.OAUTH_KV.get(`${SESSION_PREFIX}${decodeURIComponent(sessionId)}`, "json") as OwnerSession | null;
  if (!session || session.protocol !== ANYAM_PASSKEY_OWNER_PROTOCOL) return undefined;
  return session;
}

/** Returns the durable kernel-session identifier; the opaque host cookie never crosses the OAuth boundary. */
export async function anyamRealmOwnerSessionId(request: Request, env: AnyamRealmOAuthEnv): Promise<string | undefined> {
  const session = await readSession(request, env);
  return session && session.realmId === realmId(env) ? session.kernelSessionId : undefined;
}

async function ownerKernelSession(request: Request, env: AnyamRealmOAuthEnv): Promise<{ session: OwnerSession; kernelSession: Record<string, unknown> } | Response> {
  const session = await readSession(request, env);
  if (!session || session.realmId !== realmId(env) || !session.kernelSessionId) return json({ code: "owner_authentication_required", recoveryAction: "Complete passkey authentication before requesting a qualification agent or credential operation.", receipt: "ownerSession=missing-or-invalid; kernelSession=missing" }, 401);
  try {
    const kernel = await realmCoordinatorRequest(env, "/identity/session/validate", { sessionId: session.kernelSessionId });
    const kernelSession = kernel.session as Record<string, unknown> | undefined;
    if (!kernelSession || kernelSession.id !== session.kernelSessionId || kernelSession.actorId !== session.actorId || kernelSession.principalId !== session.userId) return json({ code: "owner_kernel_session_mismatch", recoveryAction: "Re-authenticate through /owner/login before requesting a protected qualification operation.", receipt: "kernelSession=identity-mismatch; operation=not-created" }, 401);
    return { session, kernelSession };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    return json({ code: "owner_kernel_session_invalid", recoveryAction: "Re-authenticate through /owner/login and retry after checking the Realm coordinator.", receipt: `kernelSession=invalid; operation=not-created; detail=${detail}` }, 401);
  }
}

type QualificationOperation = "delegate" | "credentials" | "revoke" | "recovery/export" | "recovery/restore" | "provider-operation" | "provider-operation/resume" | "provider-operation/callback" | "provider-operation/cleanup" | "provider-recovery/export" | "provider-recovery/restore";

async function qualificationRequest(request: Request, env: AnyamRealmOAuthEnv, operation: QualificationOperation): Promise<Response> {
  const ownerState = await ownerKernelSession(request, env);
  if (ownerState instanceof Response) return ownerState;
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return json({ code: "invalid_request", recoveryAction: "Send a JSON object containing only the bounded qualification parameters.", receipt: `qualification=${operation}; request=json-object-required` }, 422);
  }
  try {
    const coordinator = await realmCoordinatorRequest(env, `/identity/qualification/${operation}`, { ...body, humanSessionId: ownerState.session.kernelSessionId });
    const responseBody = { ...coordinator, receipt: `${typeof coordinator.receipt === "string" ? coordinator.receipt : `qualification=${operation}`}; ownerSession=validated` };
    if (operation === "recovery/restore") {
      const sessionId = parseCookies(request)[COOKIE_NAME];
      if (sessionId) await env.OAUTH_KV.delete(`${SESSION_PREFIX}${decodeURIComponent(sessionId)}`);
      return json(responseBody, 200, { "set-cookie": expiredSessionCookie() });
    }
    return json(responseBody);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    return json({ code: `qualification_${operation}_failed`, recoveryAction: "Retry after checking the durable Realm coordinator; no partial credential or authority transition is accepted.", receipt: `qualification=${operation}; operation=failed; detail=${detail}` }, 503);
  }
}

async function revokeSession(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  const sessionId = parseCookies(request)[COOKIE_NAME];
  if (!sessionId) return json({ code: "owner_session_missing", recoveryAction: "Authenticate the Realm owner before requesting session revocation.", receipt: "ownerSession=missing; revocation=not-needed" }, 401);
  const session = await readSession(request, env);
  if (session?.kernelSessionId) {
    try {
      await realmCoordinatorRequest(env, "/identity/session/revoke", { sessionId: session.kernelSessionId });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
      return json({ code: "owner_session_revocation_failed", recoveryAction: "Retry revocation after the durable Realm coordinator is reachable; the host session remains present so the failure is not hidden.", receipt: `kernelSession=revocation-failed; hostSession=retained; detail=${detail}` }, 503);
    }
  }
  await env.OAUTH_KV.delete(`${SESSION_PREFIX}${decodeURIComponent(sessionId)}`);
  return json({ protocol: ANYAM_PASSKEY_OWNER_PROTOCOL, status: "session-revoked", receipt: `ownerSession=revoked; kernelSession=${session?.kernelSessionId ? "revoked" : "missing"}; futureOAuthAuthorization=blocked` }, 200, { "set-cookie": expiredSessionCookie() });
}

async function registrationOptions(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  if (!await ownerBootstrapTokenMatches(request, env)) return json({ code: "owner_bootstrap_required", recoveryAction: "Set the one-time customer-owned bootstrap secret through the CLI and retry this owner-claim ceremony.", receipt: "bootstrapToken=missing-or-invalid; owner=not-created" }, 401);
  await ensureSchema(env);
  const currentOwner = await owner(env, realmId(env));
  if (currentOwner) return json({ code: "owner_already_enrolled", recoveryAction: "Authenticate the existing Realm owner instead of starting a first-owner ceremony.", receipt: "owner=already-enrolled; bootstrap=not-used" }, 409);
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return json({ code: "invalid_request", recoveryAction: "Send a JSON object containing displayName.", receipt: "registrationOptions=json-object-required" }, 422);
  }
  const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : "Anyam Realm owner";
  const userId = randomId("owner");
  const options = await generateRegistrationOptions({
    rpName: "Anyam Realm",
    rpID: configuredRelyingPartyId(env, request),
    userName: userId,
    userID: new TextEncoder().encode(userId) as unknown as Uint8Array<ArrayBuffer>,
    userDisplayName: displayName,
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    attestationType: "none",
  });
  const challengeId = randomId("registration");
  const challenge: PasskeyChallenge = { ceremony: "registration", challenge: options.challenge, realmId: realmId(env), userId, displayName, createdAt: new Date().toISOString() };
  await issuePasskeyChallenge(env, { challengeId, ceremony: "registration", challenge: options.challenge, userId, displayName });
  return json({ protocol: ANYAM_PASSKEY_OWNER_PROTOCOL, status: "challenge-issued", ceremony: "registration", challengeId, options, receipt: `${ANYAM_PASSKEY_SIZING_RECEIPT}; owner=not-created; proof=browser-passkey-required` });
}

async function registrationVerify(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  if (!await ownerBootstrapTokenMatches(request, env)) return json({ code: "owner_bootstrap_required", recoveryAction: "Use the customer-owned bootstrap secret that opened this owner-claim ceremony.", receipt: "bootstrapToken=missing-or-invalid; owner=not-created" }, 401);
  await ensureSchema(env);
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return json({ code: "invalid_request", recoveryAction: "Send challengeId and the browser RegistrationResponseJSON.", receipt: "registrationVerify=json-object-required" }, 422);
  }
  const challengeId = requiredString(body.challengeId, "challengeId");
  let challenge: PasskeyChallenge;
  try {
    challenge = await consumePasskeyChallenge(env, challengeId, "registration");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_challenge_expired";
    if (detail.includes("challenge_expired") || detail.includes("challenge_malformed")) return json({ code: "passkey_challenge_expired", recoveryAction: "Start a fresh owner registration ceremony; the prior challenge was consumed or expired.", receipt: "registrationChallenge=missing-or-invalid; one-time-consumption=serialized; owner=not-created" }, 410);
    throw error;
  }
  if (challenge.realmId !== realmId(env) || !challenge.userId || !challenge.displayName) return json({ code: "passkey_challenge_expired", recoveryAction: "Start a fresh owner registration ceremony.", receipt: "registrationChallenge=realm-or-payload-invalid; owner=not-created" }, 410);
  if (await owner(env, challenge.realmId)) return json({ code: "owner_already_enrolled", recoveryAction: "Authenticate the existing Realm owner instead of registering another first owner.", receipt: "owner=already-enrolled; registration=not-applied" }, 409);
  try {
    const verification = await verifyRegistrationResponse({
      response: body.response as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: new URL(request.url).origin,
      expectedRPID: configuredRelyingPartyId(env, request),
      requireUserVerification: true,
    });
    if (!verification.verified) return json({ code: "passkey_registration_rejected", recoveryAction: "Retry with a passkey that completes user verification on the customer Realm origin.", receipt: "webauthn=verified-false; owner=not-created" }, 422);
    const credential = verification.registrationInfo.credential;
    let kernel: Record<string, unknown>;
    try {
      kernel = await realmCoordinatorRequest(env, "/identity/owner-enroll", {
        principalId: challenge.userId,
        displayName: challenge.displayName,
        credentialId: credential.id,
        relyingPartyId: configuredRelyingPartyId(env, request),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
      if (detail.startsWith("realm_coordinator_")) return json({ code: "realm_identity_enrollment_failed", recoveryAction: "Retry the owner claim after checking the durable Realm coordinator; the passkey was verified but no host session was issued.", receipt: `webauthn=verified; kernelMembership=not-confirmed; ${detail}` }, 503);
      throw error;
    }
    if (kernel.status === "owner-already-enrolled") return json({ code: "owner_already_enrolled", recoveryAction: "Authenticate the existing Realm owner instead of registering another first owner.", receipt: "owner=already-enrolled; ownerUniqueness=serialized; registration=not-applied" }, 409);
    const principalId = typeof kernel.principalId === "string" ? kernel.principalId : challenge.userId;
    const createdAt = new Date().toISOString();
    await env.ANYAM_METADATA_DB.batch([
      env.ANYAM_METADATA_DB.prepare("INSERT INTO anyam_realm_owners (realm_id, user_id, display_name, credential_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(challenge.realmId, principalId, challenge.displayName, credential.id, createdAt),
      env.ANYAM_METADATA_DB.prepare("INSERT INTO anyam_realm_passkeys (credential_id, realm_id, user_id, display_name, public_key, counter, transports, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(credential.id, challenge.realmId, principalId, challenge.displayName, base64UrlEncode(credential.publicKey), credential.counter, JSON.stringify([]), createdAt),
    ]);
    return json({ protocol: ANYAM_PASSKEY_OWNER_PROTOCOL, status: "owner-enrolled", realmId: challenge.realmId, userId: principalId, displayName: challenge.displayName, credentialId: credential.id, nextAction: "Authenticate at /owner/login before requesting OAuth authorization.", receipt: `${ANYAM_PASSKEY_SIZING_RECEIPT}; webauthn=verified; userVerification=true; ownerRecord=created; kernelMembership=verified; session=not-issued; credentialMaterialStored=false` });
  } catch {
    return json({ code: "passkey_registration_failed", recoveryAction: "Start a fresh owner registration ceremony and retry; no owner session was issued.", receipt: "webauthn=verification-error; owner=not-created" }, 422);
  }
}

async function authenticationOptions(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  await ensureSchema(env);
  const currentOwner = await owner(env, realmId(env));
  if (!currentOwner) return json({ code: "owner_not_enrolled", recoveryAction: "Complete first-owner passkey enrollment before authenticating the Realm.", receipt: "owner=missing; authentication=not-started" }, 404);
  const credentials = await passkeys(env, realmId(env));
  const options = await generateAuthenticationOptions({
    rpID: configuredRelyingPartyId(env, request),
    allowCredentials: credentials.map((credential) => ({ id: credential.credential_id, transports: JSON.parse(credential.transports) })),
    userVerification: "required",
  });
  const challengeId = randomId("authentication");
  const challenge: PasskeyChallenge = { ceremony: "authentication", challenge: options.challenge, realmId: realmId(env), createdAt: new Date().toISOString() };
  await issuePasskeyChallenge(env, { challengeId, ceremony: "authentication", challenge: options.challenge });
  return json({ protocol: ANYAM_PASSKEY_OWNER_PROTOCOL, status: "challenge-issued", ceremony: "authentication", challengeId, options, receipt: `${ANYAM_PASSKEY_SIZING_RECEIPT}; owner=present; proof=browser-passkey-required` });
}

async function authenticationVerify(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  await ensureSchema(env);
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return json({ code: "invalid_request", recoveryAction: "Send challengeId and the browser AuthenticationResponseJSON.", receipt: "authenticationVerify=json-object-required" }, 422);
  }
  const challengeId = requiredString(body.challengeId, "challengeId");
  let challenge: PasskeyChallenge;
  try {
    challenge = await consumePasskeyChallenge(env, challengeId, "authentication");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_challenge_expired";
    if (detail.includes("challenge_expired") || detail.includes("challenge_malformed")) return json({ code: "passkey_challenge_expired", recoveryAction: "Start a fresh owner authentication ceremony; the prior challenge was consumed or expired.", receipt: "authenticationChallenge=missing-or-invalid; one-time-consumption=serialized; session=not-created" }, 410);
    throw error;
  }
  if (challenge.realmId !== realmId(env)) return json({ code: "passkey_challenge_expired", recoveryAction: "Start a fresh owner authentication ceremony.", receipt: "authenticationChallenge=realm-mismatch; session=not-created" }, 410);
  const response = body.response as AuthenticationResponseJSON;
  const credentialRow = await env.ANYAM_METADATA_DB.prepare("SELECT credential_id, realm_id, user_id, display_name, public_key, counter, transports FROM anyam_realm_passkeys WHERE realm_id = ?1 AND credential_id = ?2").bind(challenge.realmId, response?.id).first<PasskeyRow>();
  if (!credentialRow) return json({ code: "passkey_unknown", recoveryAction: "Use a passkey enrolled in this Realm or complete owner enrollment.", receipt: "credential=not-found; session=not-created" }, 403);
  try {
    const credential: WebAuthnCredential = { id: credentialRow.credential_id, publicKey: base64UrlDecode(credentialRow.public_key) as unknown as Uint8Array<ArrayBuffer>, counter: credentialRow.counter, transports: JSON.parse(credentialRow.transports) };
    const verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: new URL(request.url).origin, expectedRPID: configuredRelyingPartyId(env, request), credential, requireUserVerification: true });
    if (!verification.verified) return json({ code: "passkey_authentication_rejected", recoveryAction: "Retry with a passkey that completes user verification on the customer Realm origin.", receipt: "webauthn=verified-false; session=not-created" }, 403);
    if (verification.authenticationInfo.newCounter < credentialRow.counter) return json({ code: "passkey_counter_regression", recoveryAction: "Revoke this credential and enroll a fresh passkey after checking for authenticator cloning.", receipt: `counterRegression=true; stored=${credentialRow.counter}; presented=${verification.authenticationInfo.newCounter}; session=not-created` }, 403);
    if (verification.authenticationInfo.newCounter > credentialRow.counter) {
      const counterUpdate = await env.ANYAM_METADATA_DB.prepare("UPDATE anyam_realm_passkeys SET counter = ?1 WHERE realm_id = ?2 AND credential_id = ?3 AND counter = ?4").bind(verification.authenticationInfo.newCounter, credentialRow.realm_id, credentialRow.credential_id, credentialRow.counter).run();
      const changes = typeof counterUpdate.meta?.changes === "number" ? counterUpdate.meta.changes : 0;
      if (changes !== 1) return json({ code: "passkey_counter_replay", recoveryAction: "Start a fresh authentication ceremony; another request advanced this credential counter first.", receipt: `counterUpdate=conditional; expected=1; changed=${changes}; session=not-created` }, 409);
    }
    let kernel: Record<string, unknown>;
    try {
      kernel = await realmCoordinatorRequest(env, "/identity/passkey-auth", {
        credentialId: credentialRow.credential_id,
        relyingPartyId: configuredRelyingPartyId(env, request),
        challenge: challenge.challenge,
        signCount: verification.authenticationInfo.newCounter,
        clientId: "client:anyam-web",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
      if (detail.startsWith("realm_coordinator_")) return json({ code: "realm_identity_session_failed", recoveryAction: "Retry authentication after checking the durable Realm coordinator; no host session was issued.", receipt: `webauthn=verified; kernelMembership=verified; kernelSession=not-issued; ${detail}` }, 503);
      throw error;
    }
    const kernelSession = kernel.session as Record<string, unknown> | undefined;
    if (!kernelSession || typeof kernelSession.id !== "string" || typeof kernelSession.actorId !== "string" || typeof kernelSession.expiresAt !== "string" || kernelSession.principalId !== credentialRow.user_id) {
      return json({ code: "realm_identity_session_invalid", recoveryAction: "Inspect the durable Realm coordinator response and retry authentication; no host session was issued.", receipt: "kernelMembership=verified; kernelSession=malformed; session=not-created" }, 503);
    }
    const session = await issueSession(env, { realmId: credentialRow.realm_id, userId: credentialRow.user_id, displayName: credentialRow.display_name, credentialId: credentialRow.credential_id, kernelSessionId: kernelSession.id, actorId: kernelSession.actorId, expiresAt: kernelSession.expiresAt });
    return json({ protocol: ANYAM_PASSKEY_OWNER_PROTOCOL, status: "authenticated", realmId: credentialRow.realm_id, userId: credentialRow.user_id, displayName: credentialRow.display_name, credentialId: credentialRow.credential_id, kernelSessionId: kernelSession.id, receipt: `${ANYAM_PASSKEY_SIZING_RECEIPT}; webauthn=verified; userVerification=true; ownerRecord=verified; kernelMembership=verified; session=issued; hostSession=opaque` }, 200, { "set-cookie": session.cookie });
  } catch {
    return json({ code: "passkey_authentication_failed", recoveryAction: "Start a fresh authentication ceremony and retry; no owner session was issued.", receipt: "webauthn=verification-error; session=not-created" }, 403);
  }
}

export const anyamPasskeyOwnerAuthorization: AnyamRealmOAuthAuthorizationAdapter = async ({ rawRequest, env }: AnyamRealmOAuthAuthorization): Promise<AnyamRealmOAuthAuthorizationDecision> => {
  const session = await readSession(rawRequest, env);
  if (!session || session.realmId !== realmId(env) || !session.kernelSessionId) return { status: "blocked", code: "owner_authentication_required", recoveryAction: "Complete the customer-owned passkey ceremony at /owner/login, then retry OAuth authorization.", receipt: "ownerSession=missing-or-invalid; kernelSession=missing" };
  try {
    const kernel = await realmCoordinatorRequest(env, "/identity/session/validate", { sessionId: session.kernelSessionId });
    const kernelSession = kernel.session as Record<string, unknown> | undefined;
    if (!kernelSession || kernelSession.id !== session.kernelSessionId || kernelSession.actorId !== session.actorId || kernelSession.principalId !== session.userId) return { status: "blocked", code: "owner_kernel_session_mismatch", recoveryAction: "Re-authenticate through /owner/login after inspecting the Realm coordinator session chain.", receipt: "kernelSession=identity-mismatch; oauthGrant=not-created" };
    return { status: "authorized", userId: session.userId, displayName: session.displayName, realmId: session.realmId, sessionId: session.kernelSessionId, scopes: ["project.read", "source.read", "change.write", "run.invoke"], authorizationReceipt: `ownerAuth=passkey; ownerRecord=verified; policy=qualification-owner-default; kernelMembership=verified; kernelSession=${session.kernelSessionId}; session=${session.sessionId}; credential=${session.credentialId}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    return { status: "blocked", code: "owner_kernel_session_invalid", recoveryAction: "Re-authenticate through /owner/login and retry after checking the Realm coordinator.", receipt: `kernelSession=invalid; oauthGrant=not-created; detail=${detail}` };
  }
};

async function listOAuthGrants(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  const ownerState = await ownerKernelSession(request, env);
  if (ownerState instanceof Response) return ownerState;
  try {
    const result = await realmCoordinatorRequest(env, "/identity/oauth-grants/list", { sessionId: ownerState.session.kernelSessionId });
    return json({
      protocol: ANYAM_PASSKEY_OWNER_PROTOCOL,
      status: "oauth-grants-listed",
      grants: Array.isArray(result.grants) ? result.grants : [],
      receipt: `${typeof result.receipt === "string" ? result.receipt : "oauthGrant=list"}; ownerSession=validated; providerGrantTokens=not-returned`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    return json({ code: "oauth_grant_list_failed", recoveryAction: "Retry after checking the durable Realm coordinator; no grant authority was changed.", receipt: `oauthGrant=list-failed; detail=${detail}` }, 503);
  }
}

async function revokeOAuthGrant(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  const ownerState = await ownerKernelSession(request, env);
  if (ownerState instanceof Response) return ownerState;
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return json({ code: "invalid_request", recoveryAction: "Send a JSON object containing grantId.", receipt: "oauthGrant=revoke; grantId=required" }, 422);
  }
  let grantId: string;
  try {
    grantId = requiredString(body.grantId, "grantId");
  } catch {
    return json({ code: "invalid_request", recoveryAction: "Send the local Anyam grantId returned by the authenticated grant list.", receipt: "oauthGrant=revoke; grantId=required" }, 422);
  }
  let authorization: Record<string, unknown>;
  try {
    authorization = await realmCoordinatorRequest(env, "/identity/oauth-grant/revoke", { sessionId: ownerState.session.kernelSessionId, grantId });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    return json({ code: "oauth_grant_revoke_not_authorized", recoveryAction: "List grants through the authenticated Realm session and revoke only one owned grant.", receipt: `oauthGrant=owner-check-failed; detail=${detail}` }, 403);
  }
  const grant = authorization.grant as Record<string, unknown> | undefined;
  if (!grant || typeof grant.providerGrantId !== "string" || typeof grant.principalId !== "string") return json({ code: "oauth_grant_record_invalid", recoveryAction: "Inspect the coordinator grant record and retry only after its provider mapping is repaired.", receipt: "oauthGrant=provider-mapping-missing; providerRevocation=not-started" }, 503);
  if (grant.status === "revoked") return json({ protocol: ANYAM_PASSKEY_OWNER_PROTOCOL, status: "oauth-grant-already-revoked", grantId, receipt: "oauthGrant=already-revoked; providerRevocation=previously-confirmed" });
  const provider = env.OAUTH_PROVIDER;
  if (!provider) return json({ code: "oauth_provider_unavailable", recoveryAction: "Configure the provider helper before revoking an OAuth grant.", receipt: "oauthGrant=provider-revocation-not-started" }, 503);
  try {
    await provider.revokeGrant(grant.providerGrantId, toOAuthSubject(ownerState.session.userId));
    const marked = await realmCoordinatorRequest(env, "/identity/oauth-grant/mark-revoked", { sessionId: ownerState.session.kernelSessionId, grantId });
    return json({ protocol: ANYAM_PASSKEY_OWNER_PROTOCOL, status: "oauth-grant-revoked", grant: marked.grant ?? grant, receipt: `${typeof marked.receipt === "string" ? marked.receipt : "oauthGrant=revoked"}; providerRevocation=confirmed; ownerSession=validated` });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "provider_revoke_failed";
    return json({ code: "oauth_grant_revoke_failed", recoveryAction: "Retry the same grantId; the local record remains active until provider revocation is confirmed.", receipt: `oauthGrant=provider-revocation-failed; providerGrant=${grant.providerGrantId}; detail=${detail}` }, 503);
  }
}

export async function handleAnyamRealmOwnerRequest(request: Request, env: AnyamRealmOAuthEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/owner/claim" && request.method === "GET" && url.searchParams.get("format") !== "json") return ownerPage("claim");
    if (url.pathname === "/owner/login" && request.method === "GET" && url.searchParams.get("format") !== "json") return ownerPage("login");
    if (url.pathname === "/owner/qualification" && request.method === "GET") return qualificationPage();
    if ((url.pathname === "/owner/claim" || url.pathname === "/owner/login") && request.method === "GET") {
      return json({
        protocol: ANYAM_PASSKEY_OWNER_PROTOCOL,
        status: "browser-ceremony-required",
        path: url.pathname,
        registrationOptions: "/api/owner/passkey/register/options",
        registrationVerify: "/api/owner/passkey/register/verify",
        authenticationOptions: "/api/owner/passkey/auth/options",
        authenticationVerify: "/api/owner/passkey/auth/verify",
        oauthGrants: "/api/owner/oauth/grants",
        oauthGrantRevoke: "/api/owner/oauth/grants/revoke",
        qualificationDelegate: "/api/owner/qualification/delegate",
        qualificationCredentials: "/api/owner/qualification/credentials",
        qualificationRevoke: "/api/owner/qualification/revoke",
        recoveryExport: "/api/owner/qualification/recovery/export",
        recoveryRestore: "/api/owner/qualification/recovery/restore",
        providerOperation: "/api/owner/qualification/provider-operation",
        providerOperationResume: "/api/owner/qualification/provider-operation/resume",
        providerOperationCallback: "/api/owner/qualification/provider-operation/callback",
        providerOperationCleanup: "/api/owner/qualification/provider-operation/cleanup",
        providerRecoveryExport: "/api/owner/qualification/provider-recovery/export",
        providerRecoveryRestore: "/api/owner/qualification/provider-recovery/restore",
        recoveryAction: url.pathname === "/owner/claim" ? "Send the customer-owned bootstrap secret in the request header for the first-owner registration ceremony." : "Complete passkey authentication and retry the protected operation.",
        receipt: `${ANYAM_PASSKEY_SIZING_RECEIPT}; browserUI=qualification-minimal; ownerKernelMembership=verified-at-coordinator; credentialMaterialStored=false`,
      });
    }
    if (url.pathname === "/api/owner/passkey/register/options" && request.method === "POST") return await registrationOptions(request, env);
    if (url.pathname === "/api/owner/passkey/register/verify" && request.method === "POST") return await registrationVerify(request, env);
    if (url.pathname === "/api/owner/passkey/auth/options" && request.method === "POST") return await authenticationOptions(request, env);
    if (url.pathname === "/api/owner/passkey/auth/verify" && request.method === "POST") return await authenticationVerify(request, env);
    if (url.pathname === "/api/owner/session/revoke" && request.method === "POST") return await revokeSession(request, env);
    if (url.pathname === "/api/owner/oauth/grants" && request.method === "GET") return await listOAuthGrants(request, env);
    if (url.pathname === "/api/owner/oauth/grants/revoke" && request.method === "POST") return await revokeOAuthGrant(request, env);
    if (url.pathname === "/api/owner/qualification/delegate" && request.method === "POST") return await qualificationRequest(request, env, "delegate");
    if (url.pathname === "/api/owner/qualification/credentials" && request.method === "POST") return await qualificationRequest(request, env, "credentials");
    if (url.pathname === "/api/owner/qualification/revoke" && request.method === "POST") return await qualificationRequest(request, env, "revoke");
    if (url.pathname === "/api/owner/qualification/recovery/export" && request.method === "POST") return await qualificationRequest(request, env, "recovery/export");
    if (url.pathname === "/api/owner/qualification/recovery/restore" && request.method === "POST") return await qualificationRequest(request, env, "recovery/restore");
    if (url.pathname === "/api/owner/qualification/provider-operation" && request.method === "POST") return await qualificationRequest(request, env, "provider-operation");
    if (url.pathname === "/api/owner/qualification/provider-operation/resume" && request.method === "POST") return await qualificationRequest(request, env, "provider-operation/resume");
    if (url.pathname === "/api/owner/qualification/provider-operation/callback" && request.method === "POST") return await qualificationRequest(request, env, "provider-operation/callback");
    if (url.pathname === "/api/owner/qualification/provider-operation/cleanup" && request.method === "POST") return await qualificationRequest(request, env, "provider-operation/cleanup");
    if (url.pathname === "/api/owner/qualification/provider-recovery/export" && request.method === "POST") return await qualificationRequest(request, env, "provider-recovery/export");
    if (url.pathname === "/api/owner/qualification/provider-recovery/restore" && request.method === "POST") return await qualificationRequest(request, env, "provider-recovery/restore");
  } catch (error) {
    const code = error instanceof Error ? error.message : "owner_authentication_failed";
    return json({ code, recoveryAction: "Retry the same ceremony with a fresh challenge; no credential or session was returned.", receipt: `ownerAuth=passkey; exception=${code}; credentialMaterialStored=false` }, 422);
  }
  return undefined;
}
