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

export const ANYAM_PASSKEY_OWNER_PROTOCOL = "anyam.passkey-owner/v1" as const;
export const ANYAM_PASSKEY_CHALLENGE_TTL_SECONDS = 300;
export const ANYAM_OWNER_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const ANYAM_PASSKEY_SIZING_RECEIPT = "challengeTtl=300s; sessionTtl=28800s; sizing=qualification-tripwire; remeasure-before-production" as const;

const CHALLENGE_PREFIX = "anyam:passkey:challenge:";
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

async function revokeSession(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  const sessionId = parseCookies(request)[COOKIE_NAME];
  if (!sessionId) return json({ code: "owner_session_missing", recoveryAction: "Authenticate the Realm owner before requesting session revocation.", receipt: "ownerSession=missing; revocation=not-needed" }, 401);
  await env.OAUTH_KV.delete(`${SESSION_PREFIX}${decodeURIComponent(sessionId)}`);
  return json({ protocol: ANYAM_PASSKEY_OWNER_PROTOCOL, status: "session-revoked", receipt: "ownerSession=revoked; futureOAuthAuthorization=blocked" }, 200, { "set-cookie": expiredSessionCookie() });
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
    rpID: new URL(request.url).hostname,
    userName: userId,
    userID: new TextEncoder().encode(userId) as unknown as Uint8Array<ArrayBuffer>,
    userDisplayName: displayName,
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    attestationType: "none",
  });
  const challengeId = randomId("registration");
  const challenge: PasskeyChallenge = { ceremony: "registration", challenge: options.challenge, realmId: realmId(env), userId, displayName, createdAt: new Date().toISOString() };
  await env.OAUTH_KV.put(`${CHALLENGE_PREFIX}${challengeId}`, JSON.stringify(challenge), { expirationTtl: ANYAM_PASSKEY_CHALLENGE_TTL_SECONDS });
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
  const challenge = await env.OAUTH_KV.get(`${CHALLENGE_PREFIX}${challengeId}`, "json") as PasskeyChallenge | null;
  if (!challenge || challenge.ceremony !== "registration" || challenge.realmId !== realmId(env) || !challenge.userId || !challenge.displayName) return json({ code: "passkey_challenge_expired", recoveryAction: "Start a fresh owner registration ceremony.", receipt: "registrationChallenge=missing-or-invalid; owner=not-created" }, 410);
  if (await owner(env, challenge.realmId)) return json({ code: "owner_already_enrolled", recoveryAction: "Authenticate the existing Realm owner instead of registering another first owner.", receipt: "owner=already-enrolled; registration=not-applied" }, 409);
  try {
    const verification = await verifyRegistrationResponse({
      response: body.response as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: new URL(request.url).origin,
      expectedRPID: new URL(request.url).hostname,
      requireUserVerification: true,
    });
    if (!verification.verified) return json({ code: "passkey_registration_rejected", recoveryAction: "Retry with a passkey that completes user verification on the customer Realm origin.", receipt: "webauthn=verified-false; owner=not-created" }, 422);
    const credential = verification.registrationInfo.credential;
    const createdAt = new Date().toISOString();
    await env.ANYAM_METADATA_DB.batch([
      env.ANYAM_METADATA_DB.prepare("INSERT INTO anyam_realm_owners (realm_id, user_id, display_name, credential_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(challenge.realmId, challenge.userId, challenge.displayName, credential.id, createdAt),
      env.ANYAM_METADATA_DB.prepare("INSERT INTO anyam_realm_passkeys (credential_id, realm_id, user_id, display_name, public_key, counter, transports, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(credential.id, challenge.realmId, challenge.userId, challenge.displayName, base64UrlEncode(credential.publicKey), credential.counter, JSON.stringify([]), createdAt),
    ]);
    await env.OAUTH_KV.delete(`${CHALLENGE_PREFIX}${challengeId}`);
    const session = await issueSession(env, { realmId: challenge.realmId, userId: challenge.userId, displayName: challenge.displayName, credentialId: credential.id });
    return json({ protocol: ANYAM_PASSKEY_OWNER_PROTOCOL, status: "owner-enrolled", realmId: challenge.realmId, userId: challenge.userId, displayName: challenge.displayName, credentialId: credential.id, receipt: `${ANYAM_PASSKEY_SIZING_RECEIPT}; webauthn=verified; userVerification=true; ownerRecord=created; kernelMembership=adapter-bound-next; credentialMaterialStored=false` }, 200, { "set-cookie": session.cookie });
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
    rpID: new URL(request.url).hostname,
    allowCredentials: credentials.map((credential) => ({ id: credential.credential_id, transports: JSON.parse(credential.transports) })),
    userVerification: "required",
  });
  const challengeId = randomId("authentication");
  const challenge: PasskeyChallenge = { ceremony: "authentication", challenge: options.challenge, realmId: realmId(env), createdAt: new Date().toISOString() };
  await env.OAUTH_KV.put(`${CHALLENGE_PREFIX}${challengeId}`, JSON.stringify(challenge), { expirationTtl: ANYAM_PASSKEY_CHALLENGE_TTL_SECONDS });
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
  const challenge = await env.OAUTH_KV.get(`${CHALLENGE_PREFIX}${challengeId}`, "json") as PasskeyChallenge | null;
  if (!challenge || challenge.ceremony !== "authentication" || challenge.realmId !== realmId(env)) return json({ code: "passkey_challenge_expired", recoveryAction: "Start a fresh owner authentication ceremony.", receipt: "authenticationChallenge=missing-or-invalid; session=not-created" }, 410);
  const response = body.response as AuthenticationResponseJSON;
  const credentialRow = await env.ANYAM_METADATA_DB.prepare("SELECT credential_id, realm_id, user_id, display_name, public_key, counter, transports FROM anyam_realm_passkeys WHERE realm_id = ?1 AND credential_id = ?2").bind(challenge.realmId, response?.id).first<PasskeyRow>();
  if (!credentialRow) return json({ code: "passkey_unknown", recoveryAction: "Use a passkey enrolled in this Realm or complete owner enrollment.", receipt: "credential=not-found; session=not-created" }, 403);
  try {
    const credential: WebAuthnCredential = { id: credentialRow.credential_id, publicKey: base64UrlDecode(credentialRow.public_key) as unknown as Uint8Array<ArrayBuffer>, counter: credentialRow.counter, transports: JSON.parse(credentialRow.transports) };
    const verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: new URL(request.url).origin, expectedRPID: new URL(request.url).hostname, credential, requireUserVerification: true });
    if (!verification.verified) return json({ code: "passkey_authentication_rejected", recoveryAction: "Retry with a passkey that completes user verification on the customer Realm origin.", receipt: "webauthn=verified-false; session=not-created" }, 403);
    if (verification.authenticationInfo.newCounter < credentialRow.counter) return json({ code: "passkey_counter_regression", recoveryAction: "Revoke this credential and enroll a fresh passkey after checking for authenticator cloning.", receipt: `counterRegression=true; stored=${credentialRow.counter}; presented=${verification.authenticationInfo.newCounter}; session=not-created` }, 403);
    await env.ANYAM_METADATA_DB.prepare("UPDATE anyam_realm_passkeys SET counter = ?1 WHERE credential_id = ?2").bind(verification.authenticationInfo.newCounter, credentialRow.credential_id).run();
    await env.OAUTH_KV.delete(`${CHALLENGE_PREFIX}${challengeId}`);
    const session = await issueSession(env, { realmId: credentialRow.realm_id, userId: credentialRow.user_id, displayName: credentialRow.display_name, credentialId: credentialRow.credential_id });
    return json({ protocol: ANYAM_PASSKEY_OWNER_PROTOCOL, status: "authenticated", realmId: credentialRow.realm_id, userId: credentialRow.user_id, displayName: credentialRow.display_name, credentialId: credentialRow.credential_id, receipt: `${ANYAM_PASSKEY_SIZING_RECEIPT}; webauthn=verified; userVerification=true; ownerRecord=verified; kernelMembership=adapter-bound-next; session=issued` }, 200, { "set-cookie": session.cookie });
  } catch {
    return json({ code: "passkey_authentication_failed", recoveryAction: "Start a fresh authentication ceremony and retry; no owner session was issued.", receipt: "webauthn=verification-error; session=not-created" }, 403);
  }
}

export const anyamPasskeyOwnerAuthorization: AnyamRealmOAuthAuthorizationAdapter = async ({ rawRequest, env }: AnyamRealmOAuthAuthorization): Promise<AnyamRealmOAuthAuthorizationDecision> => {
  const session = await readSession(rawRequest, env);
  if (!session || session.realmId !== realmId(env)) return { status: "blocked", code: "owner_authentication_required", recoveryAction: "Complete the customer-owned passkey ceremony at /owner/login, then retry OAuth authorization.", receipt: "ownerSession=missing-or-invalid" };
  return { status: "authorized", userId: session.userId, displayName: session.displayName, realmId: session.realmId, scopes: ["project.read", "source.read", "change.write", "run.invoke"], authorizationReceipt: `ownerAuth=passkey; ownerRecord=verified; policy=qualification-owner-default; kernelMembership=adapter-bound-next; session=${session.sessionId}; credential=${session.credentialId}` };
};

export async function handleAnyamRealmOwnerRequest(request: Request, env: AnyamRealmOAuthEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  try {
    if ((url.pathname === "/owner/claim" || url.pathname === "/owner/login") && request.method === "GET") {
      return json({
        protocol: ANYAM_PASSKEY_OWNER_PROTOCOL,
        status: "browser-ceremony-required",
        path: url.pathname,
        registrationOptions: "/api/owner/passkey/register/options",
        registrationVerify: "/api/owner/passkey/register/verify",
        authenticationOptions: "/api/owner/passkey/auth/options",
        authenticationVerify: "/api/owner/passkey/auth/verify",
        recoveryAction: url.pathname === "/owner/claim" ? "Send the customer-owned bootstrap secret in the request header for the first-owner registration ceremony." : "Complete passkey authentication and retry the protected operation.",
        receipt: `${ANYAM_PASSKEY_SIZING_RECEIPT}; browserUI=not-yet-rendered; ownerKernelMembership=adapter-bound-next; credentialMaterialStored=false`,
      });
    }
    if (url.pathname === "/api/owner/passkey/register/options" && request.method === "POST") return await registrationOptions(request, env);
    if (url.pathname === "/api/owner/passkey/register/verify" && request.method === "POST") return await registrationVerify(request, env);
    if (url.pathname === "/api/owner/passkey/auth/options" && request.method === "POST") return await authenticationOptions(request, env);
    if (url.pathname === "/api/owner/passkey/auth/verify" && request.method === "POST") return await authenticationVerify(request, env);
    if (url.pathname === "/api/owner/session/revoke" && request.method === "POST") return await revokeSession(request, env);
  } catch (error) {
    const code = error instanceof Error ? error.message : "owner_authentication_failed";
    return json({ code, recoveryAction: "Retry the same ceremony with a fresh challenge; no credential or session was returned.", receipt: `ownerAuth=passkey; exception=${code}; credentialMaterialStored=false` }, 422);
  }
  return undefined;
}
