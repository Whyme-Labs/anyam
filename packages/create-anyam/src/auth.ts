import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const AUTH_CALLBACK_TIMEOUT_MS = 300_000;
const AUTH_CALLBACK_RECEIPT = "oauth=authorization-code; pkce=S256; callback=loopback; timeout=300000ms; sizing=qualification-tripwire; remeasure-before-production";

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
    await (input.storeSecret ?? defaultStoreSecret)("anyam.oauth.refresh", realm.origin, JSON.stringify({ refreshToken: token.refresh_token, ...(typeof token.access_token === "string" ? { accessToken: token.access_token } : {}), ...(expiresAt ? { expiresAt } : {}), clientId, scope, resource }));
    return { protocol: "anyam.cli-auth/v1", status: "authenticated", realm: realm.origin, clientId, scope, ...(expiresAt ? { expiresAt } : {}), credentialStorage: "os-keychain", receipt: `${AUTH_CALLBACK_RECEIPT}; tokenExchange=succeeded; refreshToken=keychain-only; credentialMaterialStored=false` };
  } finally {
    clearTimeout(timer);
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
  }
}
