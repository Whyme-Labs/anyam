export const SMART_HTTP_PROTOCOL = "anyam.smart-http/v1" as const;
export const SMART_HTTP_GIT_AUDIENCE = "aud:anyam:git" as const;

export type SmartHttpOperation = "read" | "write";

export type SmartHttpCredentialRecord = {
  id: string;
  audience: typeof SMART_HTTP_GIT_AUDIENCE;
  repositoryId: string;
  sourceSpaceId: string;
  workspaceId?: string;
  operations: readonly SmartHttpOperation[];
  canonicalWrite: false;
  tokenDigest: string;
  expiresAt: string;
  status: "active" | "revoked" | "expired";
};

export type SmartHttpCredential = SmartHttpCredentialRecord & {
  token: string;
};

export type SmartHttpCredentialValidation =
  | { valid: true; credential: SmartHttpCredentialRecord }
  | {
    valid: false;
    code: SmartHttpCredentialFailureCode;
    recoveryAction: string;
    receipt: string;
  };

export type SmartHttpCredentialFailureCode = "invalid" | "expired" | "revoked" | "audience-mismatch" | "repository-mismatch" | "source-space-mismatch" | "operation-denied" | "workspace-mismatch";

export type SmartHttpCredentialIssuer = {
  issue(input: {
    repositoryId: string;
    sourceSpaceId: string;
    workspaceId?: string;
    operation: SmartHttpOperation;
    expiresAt: string;
  }): Promise<SmartHttpCredential>;
};

export type SmartHttpCredentialValidator = {
  validate(token: string, input: {
    repositoryId: string;
    sourceSpaceId?: string;
    workspaceId?: string;
    operation: SmartHttpOperation;
  }): Promise<SmartHttpCredentialValidation>;
};

export type SmartHttpGatewayConfig = {
  /**
   * Customer-operated Git Smart HTTP base. It must not contain credentials or
   * a fragment. Repository paths are appended below this base.
   */
  upstreamBase: string;
  credentials: SmartHttpCredentialValidator;
  /**
   * Provider-specific repository routing belongs here, not in the Project
   * model. The default path is `<repositoryId>.git/<suffix>`.
   */
  upstreamPath?: (input: { repositoryId: string; suffix: string }) => string;
  upstreamHeaders?: (input: { repositoryId: string; operation: SmartHttpOperation }) => HeadersInit | Promise<HeadersInit>;
  /**
   * Maps a provider repository to its explicit Workspace authority. A missing
   * mapping is a fail-closed canonical-write denial; read-only gateways do not
   * need to implement it.
   */
  workspaceIdForRepository?: (input: { repositoryId: string }) => string | undefined | Promise<string | undefined>;
  /** Qualification-only escape hatch for a local provider fixture. */
  allowInsecureUpstream?: boolean;
  allowAnonymousRead?: boolean;
};

export type SmartHttpGatewayReceipt = {
  protocol: typeof SMART_HTTP_PROTOCOL;
  status: "succeeded" | "blocked" | "unavailable";
  repositoryId: string;
  operation: SmartHttpOperation;
  canonicalWrite: false;
  credentialFree: true;
  receipt: string;
  recoveryAction?: string;
};

export class SmartHttpCredentialError extends Error {
  readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = "SmartHttpCredentialError";
    this.code = "credential.invalid";
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requiredString(value: string, field: string): string {
  if (value.trim().length === 0) throw new SmartHttpCredentialError(`${field} must not be empty`);
  return value.trim();
}

function tokenValue(): string {
  return `${crypto.randomUUID()}.${crypto.randomUUID()}`;
}

async function digestToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validationFailure(
  code: SmartHttpCredentialFailureCode,
  recoveryAction: string,
  receipt: string,
): SmartHttpCredentialValidation {
  return { valid: false, code, recoveryAction, receipt };
}

/**
 * Qualification authority for Git credentials. It stores only token digests;
 * a production Realm may implement the same issuer/validator contract by
 * resolving its durable credential records in the Realm coordinator.
 */
export class SmartHttpCredentialAuthority implements SmartHttpCredentialIssuer, SmartHttpCredentialValidator {
  private readonly records = new Map<string, SmartHttpCredentialRecord>();

  async issue(input: {
    repositoryId: string;
    sourceSpaceId: string;
    workspaceId?: string;
    operation: SmartHttpOperation;
    expiresAt: string;
  }): Promise<SmartHttpCredential> {
    const repositoryId = requiredString(input.repositoryId, "repositoryId");
    const sourceSpaceId = requiredString(input.sourceSpaceId, "sourceSpaceId");
    const expiresAt = requiredString(input.expiresAt, "expiresAt");
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw new SmartHttpCredentialError("expiresAt must be a future ISO timestamp");
    if (input.operation === "write" && (!input.workspaceId || input.workspaceId.trim().length === 0)) throw new SmartHttpCredentialError("write credentials require an explicit Workspace");
    const token = tokenValue();
    const record: SmartHttpCredentialRecord = {
      id: `git-credential:${crypto.randomUUID()}`,
      audience: SMART_HTTP_GIT_AUDIENCE,
      repositoryId,
      sourceSpaceId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      operations: input.operation === "write" ? ["read", "write"] : ["read"],
      canonicalWrite: false,
      tokenDigest: await digestToken(token),
      expiresAt,
      status: "active",
    };
    this.records.set(record.tokenDigest, record);
    return { ...clone(record), token };
  }

  async validate(token: string, input: {
    repositoryId: string;
    sourceSpaceId?: string;
    workspaceId?: string;
    operation: SmartHttpOperation;
  }): Promise<SmartHttpCredentialValidation> {
    if (typeof token !== "string" || token.trim().length === 0) return validationFailure("invalid", "request a fresh audience-bound Git credential", "token=missing; credentialMaterialStored=false");
    const record = this.records.get(await digestToken(token));
    if (!record) return validationFailure("invalid", "request a fresh audience-bound Git credential", "token=unrecognised; credentialMaterialStored=false");
    if (record.status === "revoked") return validationFailure("revoked", "reauthenticate and request a new Workspace credential", `credential=${record.id}; status=revoked`);
    if (Date.parse(record.expiresAt) <= Date.now()) {
      record.status = "expired";
      return validationFailure("expired", "reauthenticate and request a fresh short-lived Workspace credential", `credential=${record.id}; status=expired; expiresAt=${record.expiresAt}`);
    }
    if (record.audience !== SMART_HTTP_GIT_AUDIENCE) return validationFailure("audience-mismatch", "use a credential issued for the Anyam Git audience", `credential=${record.id}; expectedAudience=${SMART_HTTP_GIT_AUDIENCE}; actualAudience=${record.audience}`);
    if (record.repositoryId !== input.repositoryId) return validationFailure("repository-mismatch", "request a credential for the exact Git repository URL", `credential=${record.id}; expectedRepository=${input.repositoryId}; actualRepository=${record.repositoryId}`);
    if (input.sourceSpaceId !== undefined && record.sourceSpaceId !== input.sourceSpaceId) return validationFailure("source-space-mismatch", "request a credential for the exact Source Space", `credential=${record.id}; sourceSpace=not-matched`);
    if (!record.operations.includes(input.operation)) return validationFailure("operation-denied", input.operation === "write" ? "publish a Change Revision through a Workspace; canonical Git refs are not directly writable" : "request a Git read credential for this repository", `credential=${record.id}; operation=${input.operation}; allowed=${record.operations.join(",")}; canonicalWrite=false`);
    if (input.operation === "write" && !record.workspaceId) return validationFailure("workspace-mismatch", "write only through an explicitly provisioned Workspace repository", `credential=${record.id}; workspace=missing; canonicalWrite=false`);
    if (input.workspaceId !== undefined && record.workspaceId !== input.workspaceId) return validationFailure("workspace-mismatch", "request a credential for the exact Workspace repository", `credential=${record.id}; expectedWorkspace=${input.workspaceId}; actualWorkspace=${record.workspaceId ?? "none"}`);
    return { valid: true, credential: clone(record) };
  }

  async revoke(token: string): Promise<boolean> {
    const record = this.records.get(await digestToken(token));
    if (!record) return false;
    record.status = "revoked";
    return true;
  }

  snapshot(): { credentialCount: number; credentialMaterialStored: false; active: number; revoked: number; expired: number } {
    const records = [...this.records.values()];
    return {
      credentialCount: records.length,
      credentialMaterialStored: false,
      active: records.filter((record) => record.status === "active").length,
      revoked: records.filter((record) => record.status === "revoked").length,
      expired: records.filter((record) => record.status === "expired").length,
    };
  }
}

function gatewayJson(body: SmartHttpGatewayReceipt | Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseGitRoute(url: URL): { repositoryId: string; suffix: string } | undefined {
  const prefix = "/git/";
  if (!url.pathname.startsWith(prefix)) return undefined;
  const rest = url.pathname.slice(prefix.length);
  const separator = rest.indexOf("/");
  if (separator <= 0) return undefined;
  const repositoryPart = rest.slice(0, separator);
  const suffix = rest.slice(separator + 1);
  if (!repositoryPart.endsWith(".git") || suffix.length === 0 || suffix.includes("..") || suffix.includes("\\") || suffix.includes("\0")) return undefined;
  try {
    const repositoryId = decodeURIComponent(repositoryPart.slice(0, -4));
    if (repositoryId.length === 0 || repositoryId.includes("/") || repositoryId.includes("..")) return undefined;
    return { repositoryId, suffix };
  } catch {
    return undefined;
  }
}

function operationFor(request: Request, suffix: string, url: URL): SmartHttpOperation | undefined {
  if (request.method === "HEAD" && suffix === "HEAD") return "read";
  if (request.method === "GET" && suffix === "info/refs") return "read";
  if (request.method === "POST" && suffix === "git-upload-pack") return "read";
  if (request.method === "POST" && suffix === "git-receive-pack") return "write";
  if (request.method === "GET" && suffix === "info/refs" && url.searchParams.get("service") === "git-upload-pack") return "read";
  return undefined;
}

function bearer(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}

function safeUpstreamBase(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password || url.hash) return undefined;
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  } catch {
    return undefined;
  }
}

function forwardHeaders(request: Request, extra: HeadersInit | undefined): Headers {
  const headers = new Headers(extra);
  for (const name of ["accept", "content-type", "content-encoding", "git-protocol", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/**
 * Worker-compatible Git Smart HTTP gateway. The gateway owns the transport
 * policy and credential audience; the upstream RepositoryDriver owns Git
 * storage and provider mechanics. It never forwards the Anyam bearer token.
 */
export async function handleSmartHttpRequest(request: Request, config: SmartHttpGatewayConfig): Promise<Response | undefined> {
  const url = new URL(request.url);
  const route = parseGitRoute(url);
  if (!route) return undefined;
  const operation = operationFor(request, route.suffix, url);
  const blockedReceipt = (status: number, code: string, recoveryAction: string, receipt: string): Response => gatewayJson({ protocol: SMART_HTTP_PROTOCOL, status: "blocked", code, repositoryId: route.repositoryId, operation: operation ?? "unknown", canonicalWrite: false, credentialFree: true, recoveryAction, receipt }, status);
  if (!operation) return blockedReceipt(405, "git_operation_unsupported", "use Git Smart HTTP info/refs, upload-pack, or receive-pack for the exact repository path", `repository=${route.repositoryId}; suffix=${route.suffix}; operation=unsupported; canonicalWrite=false`);

  let authorization: SmartHttpCredentialValidation | undefined;
  const token = bearer(request);
  if (!(operation === "read" && config.allowAnonymousRead === true)) {
    if (!token) return blockedReceipt(401, "git_credential_required", "request a short-lived credential for the Anyam Git audience", `repository=${route.repositoryId}; operation=${operation}; credential=missing; canonicalWrite=false`);
    authorization = await config.credentials.validate(token, { repositoryId: route.repositoryId, operation });
    if (!authorization.valid) return blockedReceipt(authorization.code === "invalid" || authorization.code === "expired" || authorization.code === "revoked" ? 401 : 403, "git_credential_denied", authorization.recoveryAction, `repository=${route.repositoryId}; operation=${operation}; ${authorization.receipt}; canonicalWrite=false`);
  }
  const expectedWorkspaceId = operation === "write" ? await config.workspaceIdForRepository?.({ repositoryId: route.repositoryId }) : undefined;
  if (operation === "write" && (!authorization || !authorization.valid || expectedWorkspaceId === undefined || authorization.credential.workspaceId !== expectedWorkspaceId || authorization.credential.canonicalWrite)) {
    return blockedReceipt(403, "canonical_write_denied", "push only to the explicitly provisioned Workspace repository; request Landing for canonical mutation", `repository=${route.repositoryId}; operation=receive-pack; workspace=required; canonicalWrite=false`);
  }

  const base = safeUpstreamBase(config.upstreamBase);
  if (!base || (base.protocol === "http:" && config.allowInsecureUpstream !== true)) return gatewayJson({ protocol: SMART_HTTP_PROTOCOL, status: "unavailable", repositoryId: route.repositoryId, operation, canonicalWrite: false, credentialFree: true, recoveryAction: "configure a customer-owned HTTPS Git upstream without embedded credentials or enable the explicit qualification-only fixture path", receipt: `repository=${route.repositoryId}; provider=smart-http; upstream=invalid-or-insecure; operation=${operation}; canonicalWrite=false` }, 503);
  let upstreamPath = config.upstreamPath?.({ repositoryId: route.repositoryId, suffix: route.suffix }) ?? `${encodeURIComponent(route.repositoryId)}.git/${route.suffix}`;
  if (upstreamPath.startsWith("/")) upstreamPath = upstreamPath.slice(1);
  const upstream = new URL(upstreamPath, base);
  upstream.search = url.search;
  let response: Response;
  try {
    response = await fetch(upstream, {
      method: request.method,
      headers: forwardHeaders(request, await config.upstreamHeaders?.({ repositoryId: route.repositoryId, operation })),
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }),
      // Node's fetch requires this opt-in when the qualification harness
      // forwards a Request body stream. Workers ignores the extra hint.
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { duplex: "half" as const }),
    } as RequestInit & { duplex?: "half" });
  } catch (error) {
    return gatewayJson({ protocol: SMART_HTTP_PROTOCOL, status: "unavailable", repositoryId: route.repositoryId, operation, canonicalWrite: false, credentialFree: true, recoveryAction: "retain the Workspace and retry the same Git operation after checking the customer-owned upstream", receipt: `repository=${route.repositoryId}; provider=smart-http; operation=${operation}; upstream=unavailable; error=${error instanceof Error ? error.name : "unknown"}; canonicalWrite=false` }, 503);
  }
  if (!response.ok) return gatewayJson({ protocol: SMART_HTTP_PROTOCOL, status: "unavailable", repositoryId: route.repositoryId, operation, canonicalWrite: false, credentialFree: true, recoveryAction: "inspect the customer-owned upstream status and retry the same idempotent Git operation; no Anyam canonical state changed", receipt: `repository=${route.repositoryId}; provider=smart-http; operation=${operation}; upstreamStatus=${response.status}; canonicalWrite=false` }, response.status >= 500 ? 503 : response.status);
  const headers = new Headers();
  for (const name of ["content-type", "content-encoding", "etag", "last-modified", "cache-control", "vary"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-anyam-git-operation", operation);
  headers.set("x-anyam-canonical-write", "false");
  return new Response(response.body, { status: response.status, headers });
}

export function smartHttpRouteUrl(origin: string, repositoryId: string): string {
  const base = new URL(origin);
  if (base.pathname !== "/" && base.pathname !== "") throw new SmartHttpCredentialError("Git gateway origin must not include a path");
  return `${base.origin}/git/${encodeURIComponent(requiredString(repositoryId, "repositoryId"))}.git`;
}

export function smartHttpQualificationReceipt(input: {
  endpoint: string;
  clone: "passed" | "blocked";
  fetch: "passed" | "blocked";
  workspacePush: "passed" | "blocked";
  canonicalPush: "passed" | "blocked";
  cas: "passed" | "blocked";
  exportRestore: "passed" | "blocked";
  providerFailureRecovery: "passed" | "blocked";
  providerFacts: Readonly<Record<string, string>>;
}): Record<string, unknown> {
  const values = [input.clone, input.fetch, input.workspacePush, input.canonicalPush, input.cas, input.exportRestore, input.providerFailureRecovery];
  const status = values.every((value) => value === "passed") ? "succeeded" : "blocked";
  return {
    protocol: "anyam.smart-http-qualification/v1",
    status,
    endpoint: input.endpoint,
    operations: {
      clone: input.clone,
      fetch: input.fetch,
      workspacePush: input.workspacePush,
      canonicalPush: input.canonicalPush,
      projectRevisionCas: input.cas,
      exportRestore: input.exportRestore,
      providerFailureRecovery: input.providerFailureRecovery,
    },
    providerFacts: { ...input.providerFacts },
    anyamPolicy: {
      canonicalWrite: "landing-only",
      workspacePush: "allowed-with-exact-workspace-credential",
      credentialMaterialStored: false,
      providerFactsAreNotAnyamLimits: true,
    },
    recoveryAction: status === "succeeded" ? "retain the receipt with the customer Project qualification record" : "inspect the named blocked operation and retry only after reconciling the provider checkpoint",
    receipt: `provider=smart-http; endpoint=${input.endpoint}; status=${status}; canonicalWrite=landing-only; credentialMaterialStored=false`,
  };
}
