import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const AUTH_CALLBACK_TIMEOUT_MS = 300_000;
const AUTH_CALLBACK_RECEIPT = "oauth=authorization-code; pkce=S256; callback=loopback; timeout=300000ms; sizing=qualification-tripwire; remeasure-before-production";
const AUTH_KEYCHAIN_SERVICE = "anyam.oauth.refresh";

export type AnyamAuthLoginInput = {
  realm: string;
  clientId: string;
  scope?: string;
  resource?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  openBrowser?: (url: string) => Promise<void>;
  storeSecret?: (service: string, account: string, value: string) => Promise<void>;
};

export type AnyamAuthLoginResult = {
  protocol: "anyam.cli-auth/v1";
  status: "authenticated";
  realm: string;
  clientId: string;
  scope: string;
  expiresAt?: string;
  credentialStorage: "os-keychain";
  receipt: string;
};

export type AnyamAuthAccessCredential = {
  accessToken: string;
  clientId: string;
  scope: string;
  resource: string;
  expiresAt?: string;
  credentialStorage: "os-keychain" | "process-memory";
  receipt: string;
};

export class AnyamAuthError extends Error {
  readonly code: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: string; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "AnyamAuthError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new AnyamAuthError({ code: "auth.input_required", message: `${field} is required.`, recoveryAction: `provide --${field.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} and retry`, receipt: `field=${field}; transition=not-started` });
  return normalized;
}

function baseUrl(value: string, field: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AnyamAuthError({ code: "auth.url_invalid", message: `${field} must be an absolute HTTPS URL.`, recoveryAction: `provide a valid ${field} URL and retry`, receipt: `field=${field}; url=invalid; transition=not-started` });
  }
  if (parsed.protocol !== "https:") throw new AnyamAuthError({ code: "auth.url_insecure", message: `${field} must use HTTPS.`, recoveryAction: `use an HTTPS ${field} URL; no credential was issued`, receipt: `field=${field}; protocol=${parsed.protocol}; transition=not-started` });
  return parsed;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function pkceVerifier(): string {
  return base64Url(randomBytes(32));
}

function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    await execFileAsync(command, args);
  } catch {
    process.stdout.write(`Open this URL in a browser to continue Anyam authentication:\n${url}\n`);
  }
}

async function defaultStoreSecret(service: string, account: string, value: string): Promise<void> {
  if (platform() === "darwin") {
    await execFileAsync("security", ["add-generic-password", "-a", account, "-s", service, "-w", value, "-U"]);
    return;
  }
  if (platform() === "linux") {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("secret-tool", ["store", "--label", "Anyam CLI OAuth", "service", service, "account", account]);
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`secret-tool exited ${code ?? "unknown"}`)));
        child.stdin.end(value);
      });
      return;
    } catch {
      throw new AnyamAuthError({ code: "auth.keychain_unavailable", message: "The Linux Secret Service helper is unavailable.", recoveryAction: "install secret-tool and unlock the desktop keyring, then retry; Anyam will not write a plaintext refresh token", receipt: "credentialStorage=os-keychain; helper=secret-tool; stored=false" });
    }
  }
  throw new AnyamAuthError({ code: "auth.keychain_unsupported", message: `No supported OS keychain adapter is available for ${platform()}.`, recoveryAction: "use a supported OS keychain adapter or a managed CI workload identity; no plaintext credential was written", receipt: `credentialStorage=os-keychain; platform=${platform()}; stored=false` });
}

async function defaultReadSecret(service: string, account: string): Promise<string | undefined> {
  if (platform() === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", ["find-generic-password", "-a", account, "-s", service, "-w"]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  if (platform() === "linux") {
    try {
      const { stdout } = await execFileAsync("secret-tool", ["lookup", "service", service, "account", account]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  throw new AnyamAuthError({ code: "auth.keychain_unsupported", message: `No supported OS keychain adapter is available for ${platform()}.`, recoveryAction: "use a supported OS keychain adapter or a managed CI workload identity; no plaintext credential was read", receipt: `credentialStorage=os-keychain; platform=${platform()}; read=false` });
}

async function defaultDeleteSecret(service: string, account: string): Promise<boolean> {
  if (platform() === "darwin") {
    try {
      await execFileAsync("security", ["delete-generic-password", "-a", account, "-s", service]);
      return true;
    } catch {
      return false;
    }
  }
  if (platform() === "linux") {
    try {
      await execFileAsync("secret-tool", ["clear", "service", service, "account", account]);
      return true;
    } catch {
      return false;
    }
  }
  throw new AnyamAuthError({ code: "auth.keychain_unsupported", message: `No supported OS keychain adapter is available for ${platform()}.`, recoveryAction: "use a supported OS keychain adapter or a managed CI workload identity; no plaintext credential was removed", receipt: `credentialStorage=os-keychain; platform=${platform()}; delete=false` });
}

function authRealm(value: string): URL {
  return baseUrl(required(value, "realm"), "realm");
}

function storedAuthRecord(value: string): { refreshToken: string; accessToken?: string; expiresAt?: string; clientId: string; scope: string; resource: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AnyamAuthError({ code: "auth.keychain_record_invalid", message: "The Anyam OAuth keychain record is not valid JSON.", recoveryAction: "run anyam auth logout, then authenticate again through OAuth PKCE", receipt: "credentialStorage=os-keychain; record=invalid; credentialStored=false" });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new AnyamAuthError({ code: "auth.keychain_record_invalid", message: "The Anyam OAuth keychain record has an invalid shape.", recoveryAction: "run anyam auth logout, then authenticate again through OAuth PKCE", receipt: "credentialStorage=os-keychain; record=invalid; credentialStored=false" });
  const record = parsed as Record<string, unknown>;
  if (typeof record.refreshToken !== "string" || record.refreshToken.trim().length === 0 || typeof record.clientId !== "string" || record.clientId.trim().length === 0 || typeof record.scope !== "string" || record.scope.trim().length === 0 || typeof record.resource !== "string" || record.resource.trim().length === 0) throw new AnyamAuthError({ code: "auth.keychain_record_invalid", message: "The Anyam OAuth keychain record is incomplete.", recoveryAction: "run anyam auth login again with the Realm, client ID, and requested scope", receipt: "credentialStorage=os-keychain; record=incomplete; credentialStored=false" });
  return { refreshToken: record.refreshToken, ...(typeof record.accessToken === "string" && record.accessToken.trim() ? { accessToken: record.accessToken } : {}), ...(typeof record.expiresAt === "string" && record.expiresAt.trim() ? { expiresAt: record.expiresAt } : {}), clientId: record.clientId.trim(), scope: record.scope.trim(), resource: record.resource.trim() };
}

export async function loadAnyamAuthCredential(input: {
  realm: string;
  clientId?: string;
  accessToken?: string;
  scope?: string;
  resource?: string;
  readSecret?: (service: string, account: string) => Promise<string | undefined>;
  storeSecret?: (service: string, account: string, value: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<AnyamAuthAccessCredential> {
  const realm = authRealm(input.realm);
  const now = input.now ?? (() => Date.now());
  if (input.accessToken?.trim()) return { accessToken: input.accessToken.trim(), clientId: input.clientId?.trim() ?? "process-memory", scope: input.scope?.trim() ?? "qualification.github-app", resource: input.resource?.trim() ?? new URL("/mcp", realm).toString(), credentialStorage: "process-memory", receipt: "oauth=access-token; source=process-memory; refresh=not-read; credentialMaterialStored=false" };
  const account = realm.origin;
  const stored = await (input.readSecret ?? defaultReadSecret)(AUTH_KEYCHAIN_SERVICE, account);
  if (!stored) throw new AnyamAuthError({ code: "auth.keychain_record_missing", message: "No Anyam OAuth credential is stored for this Realm.", recoveryAction: `run anyam auth login --realm ${realm.origin} with the qualification scope, then retry the qualification`, receipt: "credentialStorage=os-keychain; record=missing; credentialStored=false" });
  let record = storedAuthRecord(stored);
  if (input.clientId?.trim() && input.clientId.trim() !== record.clientId) throw new AnyamAuthError({ code: "auth.keychain_client_mismatch", message: "The stored Anyam OAuth credential belongs to a different client.", recoveryAction: "run anyam auth login again with the client ID that owns this Realm qualification grant", receipt: "credentialStorage=os-keychain; client=unexpected; credentialStored=false" });
  const expiry = record.expiresAt ? Date.parse(record.expiresAt) : Number.POSITIVE_INFINITY;
  const refreshRequired = !record.accessToken || (record.expiresAt !== undefined && (!Number.isFinite(expiry) || expiry <= now() + 30_000));
  if (refreshRequired) {
    const tokenUrl = new URL("/oauth/token", realm);
    const response = await (input.fetchImpl ?? fetch)(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: record.refreshToken, client_id: record.clientId }).toString() });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok || body === null || typeof body !== "object" || Array.isArray(body) || typeof (body as Record<string, unknown>).access_token !== "string") throw new AnyamAuthError({ code: "auth.refresh_failed", message: "The Anyam OAuth refresh credential was rejected by the Realm.", recoveryAction: "run anyam auth login again through passkey-approved OAuth PKCE, then retry the qualification", receipt: "oauth=refresh; tokenExchange=failed; credentialStored=false" });
    const refreshed = body as Record<string, unknown>;
    const expiresIn = typeof refreshed.expires_in === "number" && Number.isSafeInteger(refreshed.expires_in) && refreshed.expires_in > 0 ? refreshed.expires_in : undefined;
    record = { ...record, accessToken: refreshed.access_token as string, ...(typeof refreshed.refresh_token === "string" && refreshed.refresh_token.trim() ? { refreshToken: refreshed.refresh_token } : {}), ...(expiresIn ? { expiresAt: new Date(now() + expiresIn * 1000).toISOString() } : {}) };
    await (input.storeSecret ?? defaultStoreSecret)(AUTH_KEYCHAIN_SERVICE, account, JSON.stringify(record));
  }
  return { accessToken: record.accessToken!, clientId: record.clientId, scope: record.scope, resource: record.resource, ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}), credentialStorage: "os-keychain", receipt: `oauth=access-token; source=os-keychain; refresh=${record.accessToken ? "observed-or-refreshed" : "not-observed"}; scope=${record.scope}; credentialMaterialStored=false` };
}

export async function logoutAnyam(input: { realm: string; readSecret?: (service: string, account: string) => Promise<string | undefined>; deleteSecret?: (service: string, account: string) => Promise<boolean>; fetchImpl?: typeof fetch }): Promise<{ protocol: "anyam.cli-auth/v1"; status: "logged-out"; realm: string; credentialStorage: "os-keychain"; receipt: string }> {
  const realm = authRealm(input.realm);
  const stored = await (input.readSecret ?? defaultReadSecret)(AUTH_KEYCHAIN_SERVICE, realm.origin);
  let revocation: "confirmed" | "not-needed" = "not-needed";
  if (stored) {
    const record = storedAuthRecord(stored);
    const response = await (input.fetchImpl ?? fetch)(new URL("/oauth/token", realm), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ token: record.refreshToken, token_type_hint: "refresh_token", client_id: record.clientId }).toString() });
    if (!response.ok) throw new AnyamAuthError({ code: "auth.revocation_failed", message: "The Realm did not confirm OAuth credential revocation.", recoveryAction: "retry anyam auth logout while the Realm is reachable; the local keychain record was retained", receipt: "oauth=logout; revocation=unconfirmed; credentialMaterialStored=false" });
    revocation = "confirmed";
  }
  const deleted = await (input.deleteSecret ?? defaultDeleteSecret)(AUTH_KEYCHAIN_SERVICE, realm.origin);
  return { protocol: "anyam.cli-auth/v1", status: "logged-out", realm: realm.origin, credentialStorage: "os-keychain", receipt: `oauth=logout; credentialStorage=os-keychain; revocation=${revocation}; deleted=${deleted ? "true" : "false"}; credentialMaterialStored=false` };
}

function callbackResult(requestUrl: URL, expectedState: string): { code: string } | { error: string; description?: string } {
  const state = requestUrl.searchParams.get("state");
  if (state !== expectedState) throw new AnyamAuthError({ code: "auth.state_mismatch", message: "The OAuth callback state did not match this CLI session.", recoveryAction: "discard the callback and restart anyam auth login; no credential was stored", receipt: "oauth=callback; state=not-matched; credentialStored=false" });
  const error = requestUrl.searchParams.get("error");
  if (error) return { error, ...(requestUrl.searchParams.get("error_description") ? { description: requestUrl.searchParams.get("error_description")! } : {}) };
  const code = requestUrl.searchParams.get("code");
  if (!code) throw new AnyamAuthError({ code: "auth.code_missing", message: "The OAuth callback did not contain an authorization code.", recoveryAction: "restart anyam auth login and approve the exact Anyam client request", receipt: "oauth=callback; code=missing; credentialStored=false" });
  return { code };
}

export async function loginAnyam(input: AnyamAuthLoginInput): Promise<AnyamAuthLoginResult> {
  const realm = baseUrl(required(input.realm, "realm"), "realm");
  const clientId = required(input.clientId, "clientId");
  const scope = required(input.scope ?? "project.read", "scope");
  const resource = input.resource ? baseUrl(input.resource, "resource").toString() : new URL("/mcp", realm).toString();
  const authorizeUrl = input.authorizeUrl ? baseUrl(input.authorizeUrl, "authorizeUrl") : new URL("/authorize", realm);
  const tokenUrl = input.tokenUrl ? baseUrl(input.tokenUrl, "tokenUrl") : new URL("/oauth/token", realm);
  const verifier = pkceVerifier();
  const state = base64Url(randomBytes(24));
  const callbackServer = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/oauth/callback") {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const result = callbackResult(requestUrl, state);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Anyam authentication received. You may close this tab.\n");
      callbackResolve(result);
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Anyam authentication was not accepted. Restart the CLI.\n");
      callbackReject(error);
    }
  });
  let callbackResolve!: (value: { code: string } | { error: string; description?: string }) => void;
  let callbackReject!: (error: unknown) => void;
  const callback = new Promise<{ code: string } | { error: string; description?: string }>((resolve, reject) => { callbackResolve = resolve; callbackReject = reject; });
  await new Promise<void>((resolve, reject) => callbackServer.listen(0, "127.0.0.1", () => resolve()).once("error", reject));
  const address = callbackServer.address();
  if (!address || typeof address === "string") throw new AnyamAuthError({ code: "auth.callback_unavailable", message: "The CLI could not allocate a loopback OAuth callback.", recoveryAction: "close another local listener and retry; no credential was stored", receipt: `${AUTH_CALLBACK_RECEIPT}; callback=unavailable; credentialStored=false` });
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", scope);
  authorizeUrl.searchParams.set("resource", resource);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  await (input.openBrowser ?? defaultOpenBrowser)(authorizeUrl.toString());
  const timer = setTimeout(() => callbackReject(new AnyamAuthError({ code: "auth.callback_timeout", message: "The OAuth callback did not arrive before the CLI login window expired.", recoveryAction: "restart anyam auth login; no credential was stored", receipt: `${AUTH_CALLBACK_RECEIPT}; callback=timeout; credentialStored=false` })), AUTH_CALLBACK_TIMEOUT_MS);
  try {
    const received = await callback;
    if ("error" in received) throw new AnyamAuthError({ code: "auth.authorization_denied", message: received.description ? `The Realm denied OAuth authorization: ${received.description}` : `The Realm denied OAuth authorization (${received.error}).`, recoveryAction: "approve the requested scopes or restart with a narrower scope", receipt: `${AUTH_CALLBACK_RECEIPT}; authorization=denied; credentialStored=false` });
    const tokenResponse = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code: received.code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }).toString() });
    const tokenBody: unknown = await tokenResponse.json().catch(() => undefined);
    if (!tokenResponse.ok || tokenBody === null || typeof tokenBody !== "object" || Array.isArray(tokenBody) || typeof (tokenBody as Record<string, unknown>).refresh_token !== "string") throw new AnyamAuthError({ code: "auth.token_exchange_failed", message: "The Realm did not return a refresh credential for the CLI.", recoveryAction: "inspect the OAuth token endpoint and retry; no plaintext token was stored", receipt: `${AUTH_CALLBACK_RECEIPT}; tokenExchange=failed; credentialStored=false` });
    const token = tokenBody as Record<string, unknown>;
    const expiresIn = typeof token.expires_in === "number" && Number.isSafeInteger(token.expires_in) && token.expires_in > 0 ? token.expires_in : undefined;
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
    await (input.storeSecret ?? defaultStoreSecret)(AUTH_KEYCHAIN_SERVICE, realm.origin, JSON.stringify({ refreshToken: token.refresh_token, ...(typeof token.access_token === "string" ? { accessToken: token.access_token } : {}), ...(expiresAt ? { expiresAt } : {}), clientId, scope, resource }));
    return { protocol: "anyam.cli-auth/v1", status: "authenticated", realm: realm.origin, clientId, scope, ...(expiresAt ? { expiresAt } : {}), credentialStorage: "os-keychain", receipt: `${AUTH_CALLBACK_RECEIPT}; tokenExchange=succeeded; refreshToken=keychain-only; credentialMaterialStored=false` };
  } finally {
    clearTimeout(timer);
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
  }
}
