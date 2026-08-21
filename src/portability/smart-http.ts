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

export type SmartHttpCredentialStore = {
  load(): Promise<readonly SmartHttpCredentialRecord[]>;
  save(records: readonly SmartHttpCredentialRecord[]): Promise<void>;
};

export class MemorySmartHttpCredentialStore implements SmartHttpCredentialStore {
  private records: SmartHttpCredentialRecord[] = [];

  async load(): Promise<readonly SmartHttpCredentialRecord[]> {
    return this.records.map((record) => clone(record));
  }

  async save(records: readonly SmartHttpCredentialRecord[]): Promise<void> {
    this.records = records.map((record) => clone(record));
  }
}

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
  /** Every provider repository must resolve to one explicit Source Space. */
  sourceSpaceIdForRepository: (input: { repositoryId: string }) => string | undefined | Promise<string | undefined>;
  /** Public disclosure is a per-repository policy, never a global default. */
  anonymousReadForRepository?: (input: { repositoryId: string; sourceSpaceId: string }) => boolean | Promise<boolean>;
  /**
   * Maps a provider repository to its explicit Workspace authority. A missing
   * mapping is a fail-closed canonical-write denial; read-only gateways do not
   * need to implement it.
   */
  workspaceIdForRepository?: (input: { repositoryId: string }) => string | undefined | Promise<string | undefined>;
  /** Qualification-only escape hatch for a local provider fixture. */
  allowInsecureUpstream?: boolean;
  budgets?: Partial<Record<SmartHttpOperation, SmartHttpBudgetPolicy>>;
  budgetTracker?: SmartHttpBudgetTracker;
  /** Optional durable cross-isolate concurrency authority. */
  budgetCoordinator?: SmartHttpBudgetCoordinator;
};

export type SmartHttpBudgetPolicy = {
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxDurationMs?: number;
  maxConcurrentRequests?: number;
  receipt: string;
};

export class SmartHttpBudgetTracker {
  private active = 0;

  constructor(private readonly receipt: string) {}

  acquire(limit: number | undefined): boolean {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new SmartHttpCredentialError("maxConcurrentRequests must be a positive safe integer");
    if (limit !== undefined && this.active >= limit) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }

  current(): number {
    return this.active;
  }

  sizingReceipt(): string {
    return this.receipt;
  }
}

export type SmartHttpBudgetLease = {
  id: string;
  release(): void;
};

export type SmartHttpBudgetCoordinator = {
  acquire(input: { operation: SmartHttpOperation; limit: number; leaseTtlMs: number; receipt: string }): Promise<SmartHttpBudgetLease | undefined>;
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
  private readonly store: SmartHttpCredentialStore | undefined;
  private readonly readyPromise: Promise<void>;
  private readonly now: () => number;

  constructor(options: { store?: SmartHttpCredentialStore; now?: () => number } = {}) {
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.readyPromise = this.hydrate();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  private async hydrate(): Promise<void> {
    if (!this.store) return;
    const records = await this.store.load();
    for (const record of records) {
      if (record.audience !== SMART_HTTP_GIT_AUDIENCE || record.canonicalWrite !== false || !record.tokenDigest) throw new SmartHttpCredentialError("durable Smart HTTP credential store contains an invalid credential-free record");
      this.records.set(record.tokenDigest, clone(record));
    }
  }

  private async persist(): Promise<void> {
    if (this.store) await this.store.save([...this.records.values()].map((record) => clone(record)));
  }

  async issue(input: {
    repositoryId: string;
    sourceSpaceId: string;
    workspaceId?: string;
    operation: SmartHttpOperation;
    expiresAt: string;
  }): Promise<SmartHttpCredential> {
    await this.ready();
    const repositoryId = requiredString(input.repositoryId, "repositoryId");
    const sourceSpaceId = requiredString(input.sourceSpaceId, "sourceSpaceId");
    const expiresAt = requiredString(input.expiresAt, "expiresAt");
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.now()) throw new SmartHttpCredentialError("expiresAt must be a future ISO timestamp");
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
    await this.persist();
    return { ...clone(record), token };
  }

  async validate(token: string, input: {
    repositoryId: string;
    sourceSpaceId?: string;
    workspaceId?: string;
    operation: SmartHttpOperation;
  }): Promise<SmartHttpCredentialValidation> {
    await this.ready();
    if (typeof token !== "string" || token.trim().length === 0) return validationFailure("invalid", "request a fresh audience-bound Git credential", "token=missing; credentialMaterialStored=false");
    const record = this.records.get(await digestToken(token));
    if (!record) return validationFailure("invalid", "request a fresh audience-bound Git credential", "token=unrecognised; credentialMaterialStored=false");
    if (record.status === "revoked") return validationFailure("revoked", "reauthenticate and request a new Workspace credential", `credential=${record.id}; status=revoked`);
    if (Date.parse(record.expiresAt) <= this.now()) {
      record.status = "expired";
      await this.persist();
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
    await this.ready();
    const record = this.records.get(await digestToken(token));
    if (!record) return false;
    record.status = "revoked";
    await this.persist();
    return true;
  }

  snapshot(): { credentialCount: number; credentialMaterialStored: false; active: number; revoked: number; expired: number; storage: "memory-qualification" | "durable-adapter"; receipt: string } {
    const records = [...this.records.values()];
    return {
      credentialCount: records.length,
      credentialMaterialStored: false,
      active: records.filter((record) => record.status === "active").length,
      revoked: records.filter((record) => record.status === "revoked").length,
      expired: records.filter((record) => record.status === "expired").length,
      storage: this.store ? "durable-adapter" : "memory-qualification",
      receipt: `credentialStore=${this.store ? "durable-adapter" : "memory-qualification"}; credentialMaterialStored=false; restartRevocation=${this.store ? "available" : "not-qualified"}`,
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
  if (request.method === "GET" && suffix === "info/refs") {
    const service = url.searchParams.get("service");
    return service === "git-receive-pack" ? "write" : "read";
  }
  if (request.method === "POST" && suffix === "git-upload-pack") return "read";
  if (request.method === "POST" && suffix === "git-receive-pack") return "write";
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

function budgetValue(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new SmartHttpCredentialError(`${field} must be a positive safe integer`);
  return value;
}

function budgetFailureReceipt(input: { operation: SmartHttpOperation; policy: SmartHttpBudgetPolicy; budget: string; limit: number; asked: string | number }): string {
  return `provider=smart-http; operation=${input.operation}; budget=${input.budget}; limit=${input.limit}; asked=${input.asked}; ${input.policy.receipt}; canonicalWrite=false; credentialMaterialStored=false`;
}

type CountedStreamState = {
  bytes: number;
  ended: boolean;
  exceeded?: number;
};

/**
 * Count bytes at the stream boundary. Headers are only a hint: chunked and
 * provider-generated bodies are charged as they actually flow. The lifecycle
 * hooks are called exactly once for close, cancellation, or error.
 */
function countedStream(input: {
  body: ReadableStream<Uint8Array> | null;
  maxBytes?: number;
  onExceeded: (asked: number) => string | void;
  onFinished: (state: CountedStreamState) => void;
}): { body: ReadableStream<Uint8Array> | null; state: CountedStreamState; cancel: (reason?: unknown) => Promise<void> } {
  const state: CountedStreamState = { bytes: 0, ended: false };
  if (!input.body) {
    state.ended = true;
    input.onFinished(state);
    return { body: null, state, cancel: async () => undefined };
  }
  const reader = input.body.getReader();
  let finished = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    state.ended = true;
    input.onFinished(state);
  };
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            finish();
            controller.close();
            return;
          }
          const chunk = next.value;
          const asked = state.bytes + chunk.byteLength;
          if (input.maxBytes !== undefined && asked > input.maxBytes) {
            state.exceeded = asked;
            const failureReceipt = input.onExceeded(asked);
            await reader.cancel("smart-http-byte-budget-exceeded").catch(() => undefined);
            finish();
            controller.error(new Error(failureReceipt ?? "smart-http-byte-budget-exceeded"));
            return;
          }
          state.bytes = asked;
          controller.enqueue(chunk);
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish();
        await reader.cancel(reason).catch(() => undefined);
      },
    }),
    state,
    cancel: async (reason?: unknown) => { streamController?.error(new Error(String(reason ?? "smart-http-stream-cancelled"))); finish(); await reader.cancel(reason).catch(() => undefined); },
  };
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

  const sourceSpaceId = await config.sourceSpaceIdForRepository({ repositoryId: route.repositoryId });
  if (!sourceSpaceId) return blockedReceipt(403, "git_source_space_unbound", "bind the provider repository to an explicit Source Space before serving Git traffic", `repository=${route.repositoryId}; sourceSpace=unbound; canonicalWrite=false`);
  const anonymousRead = operation === "read" && config.anonymousReadForRepository
    ? await config.anonymousReadForRepository({ repositoryId: route.repositoryId, sourceSpaceId })
    : false;
  let authorization: SmartHttpCredentialValidation | undefined;
  const token = bearer(request);
  if (!anonymousRead) {
    if (!token) return blockedReceipt(401, "git_credential_required", "request a short-lived credential for the Anyam Git audience", `repository=${route.repositoryId}; operation=${operation}; credential=missing; canonicalWrite=false`);
    authorization = await config.credentials.validate(token, { repositoryId: route.repositoryId, sourceSpaceId, operation });
    if (!authorization.valid) return blockedReceipt(authorization.code === "invalid" || authorization.code === "expired" || authorization.code === "revoked" ? 401 : 403, "git_credential_denied", authorization.recoveryAction, `repository=${route.repositoryId}; operation=${operation}; ${authorization.receipt}; canonicalWrite=false`);
  }
  const expectedWorkspaceId = operation === "write" ? await config.workspaceIdForRepository?.({ repositoryId: route.repositoryId }) : undefined;
  if (operation === "write" && (!authorization || !authorization.valid || expectedWorkspaceId === undefined || authorization.credential.workspaceId !== expectedWorkspaceId || authorization.credential.canonicalWrite)) {
    return blockedReceipt(403, "canonical_write_denied", "push only to the explicitly provisioned Workspace repository; request Landing for canonical mutation", `repository=${route.repositoryId}; operation=receive-pack; workspace=required; canonicalWrite=false`);
  }

  const budget = config.budgets?.[operation];
  if (budget && (!budget.receipt.trim() || !/(?:receipt|measure|qualification)/iu.test(budget.receipt))) return gatewayJson({ protocol: SMART_HTTP_PROTOCOL, status: "unavailable", repositoryId: route.repositoryId, operation, canonicalWrite: false, credentialFree: true, recoveryAction: "supply the measured qualification receipt for this workload-specific budget before enabling it", receipt: `repository=${route.repositoryId}; operation=${operation}; budget=receipt-required; canonicalWrite=false` }, 503);
  if (budget) {
    budgetValue(budget.maxRequestBytes, "maxRequestBytes");
    budgetValue(budget.maxResponseBytes, "maxResponseBytes");
    budgetValue(budget.maxDurationMs, "maxDurationMs");
    budgetValue(budget.maxConcurrentRequests, "maxConcurrentRequests");
  }
  const budgetTracker = config.budgetTracker;
  let budgetLease: SmartHttpBudgetLease | undefined;
  let acquired = true;
  if (budget?.maxConcurrentRequests !== undefined) {
    if (config.budgetCoordinator) {
      if (budget.maxDurationMs === undefined) throw new SmartHttpCredentialError("durable concurrency coordination requires maxDurationMs so an abandoned lease can expire");
      budgetLease = await config.budgetCoordinator.acquire({ operation, limit: budget.maxConcurrentRequests, leaseTtlMs: budget.maxDurationMs, receipt: budget.receipt });
      acquired = budgetLease !== undefined;
    } else {
      acquired = budgetTracker?.acquire(budget.maxConcurrentRequests) ?? true;
    }
  }
  if (!acquired) return blockedReceipt(429, "git_budget_exceeded", "retry after an active Smart HTTP operation completes; the named concurrency budget is a tripwire", `repository=${route.repositoryId}; operation=${operation}; coordinator=${config.budgetCoordinator ? "durable" : "isolate-local"}; ${budgetFailureReceipt({ operation, policy: budget!, budget: "concurrentRequests", limit: budget!.maxConcurrentRequests!, asked: config.budgetCoordinator ? "lease-unavailable" : budgetTracker?.current() ?? "unknown" })}`);
  let budgetReleased = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const releaseBudget = (): void => {
    if (!budgetReleased) {
      budgetReleased = true;
      budgetTracker?.release();
      budgetLease?.release();
    }
  };
  const finishLifecycle = (): void => {
    if (timeout) clearTimeout(timeout);
    releaseBudget();
  };
  const requestBytes = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (budget?.maxRequestBytes !== undefined && Number.isSafeInteger(requestBytes) && requestBytes > budget.maxRequestBytes) {
    releaseBudget();
    return blockedReceipt(413, "git_budget_exceeded", "reduce the Git request or use a qualified workload budget; the request was rejected before provider mutation", `repository=${route.repositoryId}; operation=${operation}; ${budgetFailureReceipt({ operation, policy: budget, budget: operation === "write" ? "packBytes" : "requestBytes", limit: budget.maxRequestBytes, asked: requestBytes })}`);
  }

  const base = safeUpstreamBase(config.upstreamBase);
  if (!base || (base.protocol === "http:" && config.allowInsecureUpstream !== true)) {
    releaseBudget();
    return gatewayJson({ protocol: SMART_HTTP_PROTOCOL, status: "unavailable", repositoryId: route.repositoryId, operation, canonicalWrite: false, credentialFree: true, recoveryAction: "configure a customer-owned HTTPS Git upstream without embedded credentials or enable the explicit qualification-only fixture path", receipt: `repository=${route.repositoryId}; provider=smart-http; upstream=invalid-or-insecure; operation=${operation}; canonicalWrite=false` }, 503);
  }
  let upstreamPath = config.upstreamPath?.({ repositoryId: route.repositoryId, suffix: route.suffix }) ?? `${encodeURIComponent(route.repositoryId)}.git/${route.suffix}`;
  if (upstreamPath.startsWith("/")) upstreamPath = upstreamPath.slice(1);
  const upstream = new URL(upstreamPath, base);
  upstream.search = url.search;
  let response: Response;
  const controller = new AbortController();
  let cancelResponseBody: (() => Promise<void>) | undefined;
  let requestBudgetAsked: number | undefined;
  const requestBody = countedStream({
    body: request.body,
    ...(budget?.maxRequestBytes === undefined ? {} : { maxBytes: budget.maxRequestBytes }),
    onExceeded: (asked) => { requestBudgetAsked = asked; controller.abort(); return budget && budget.maxRequestBytes !== undefined ? budgetFailureReceipt({ operation, policy: budget, budget: operation === "write" ? "packBytes" : "requestBytes", limit: budget.maxRequestBytes, asked }) : undefined; },
    onFinished: () => undefined,
  });
  timeout = budget?.maxDurationMs === undefined ? undefined : setTimeout(() => { controller.abort(); void cancelResponseBody?.(); }, budget.maxDurationMs);
  const startedAt = Date.now();
  try {
    response = await fetch(upstream, {
      method: request.method,
      headers: forwardHeaders(request, await config.upstreamHeaders?.({ repositoryId: route.repositoryId, operation })),
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: requestBody.body }),
      signal: controller.signal,
      // Node's fetch requires this opt-in when the qualification harness
      // forwards a Request body stream. Workers ignores the extra hint.
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { duplex: "half" as const }),
    } as RequestInit & { duplex?: "half" });
  } catch (error) {
    finishLifecycle();
    if (requestBudgetAsked !== undefined && budget?.maxRequestBytes !== undefined) return blockedReceipt(413, "git_budget_exceeded", "reduce the Git request or use a qualified workload budget; the stream exceeded its measured request budget", `repository=${route.repositoryId}; operation=${operation}; ${budgetFailureReceipt({ operation, policy: budget, budget: operation === "write" ? "packBytes" : "requestBytes", limit: budget.maxRequestBytes, asked: requestBudgetAsked })}`);
    return gatewayJson({ protocol: SMART_HTTP_PROTOCOL, status: "unavailable", repositoryId: route.repositoryId, operation, canonicalWrite: false, credentialFree: true, recoveryAction: "retain the Workspace and retry the same Git operation after checking the customer-owned upstream", receipt: `repository=${route.repositoryId}; provider=smart-http; operation=${operation}; upstream=unavailable; error=${error instanceof Error ? error.name : "unknown"}; canonicalWrite=false` }, 503);
  }
  const durationMs = Date.now() - startedAt;
  if (budget?.maxDurationMs !== undefined && durationMs > budget.maxDurationMs) {
    await response.body?.cancel().catch(() => undefined);
    finishLifecycle();
    return gatewayJson({ protocol: SMART_HTTP_PROTOCOL, status: "unavailable", repositoryId: route.repositoryId, operation, canonicalWrite: false, credentialFree: true, recoveryAction: "retry the same idempotent Git operation after measuring a workload-appropriate duration budget", receipt: `repository=${route.repositoryId}; operation=${operation}; ${budgetFailureReceipt({ operation, policy: budget, budget: "durationMs", limit: budget.maxDurationMs, asked: durationMs })}` }, 504);
  }
  const responseBytes = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (budget?.maxResponseBytes !== undefined && Number.isSafeInteger(responseBytes) && responseBytes > budget.maxResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    finishLifecycle();
    return gatewayJson({ protocol: SMART_HTTP_PROTOCOL, status: "unavailable", repositoryId: route.repositoryId, operation, canonicalWrite: false, credentialFree: true, recoveryAction: "request a bounded provider response or qualify a larger workload-specific response budget", receipt: `repository=${route.repositoryId}; operation=${operation}; ${budgetFailureReceipt({ operation, policy: budget, budget: "responseBytes", limit: budget.maxResponseBytes, asked: responseBytes })}` }, 502);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    finishLifecycle();
    return gatewayJson({ protocol: SMART_HTTP_PROTOCOL, status: "unavailable", repositoryId: route.repositoryId, operation, canonicalWrite: false, credentialFree: true, recoveryAction: "inspect the customer-owned upstream status and retry the same idempotent Git operation; no Anyam canonical state changed", receipt: `repository=${route.repositoryId}; provider=smart-http; operation=${operation}; upstreamStatus=${response.status}; durationMs=${durationMs}; responseBytes=${Number.isSafeInteger(responseBytes) ? responseBytes : "unobserved"}; canonicalWrite=false` }, response.status >= 500 ? 503 : response.status);
  }
  const responseBody = countedStream({
    body: response.body,
    ...(budget?.maxResponseBytes === undefined ? {} : { maxBytes: budget.maxResponseBytes }),
    onExceeded: (asked) => { controller.abort(); return budget && budget.maxResponseBytes !== undefined ? budgetFailureReceipt({ operation, policy: budget, budget: "responseBytes", limit: budget.maxResponseBytes, asked }) : undefined; },
    onFinished: () => { finishLifecycle(); },
  });
  cancelResponseBody = () => responseBody.cancel("smart-http-duration-budget-exceeded");
  const headers = new Headers();
  for (const name of ["content-type", "content-encoding", "etag", "last-modified", "cache-control", "vary"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-anyam-git-operation", operation);
  headers.set("x-anyam-canonical-write", "false");
  headers.set("x-anyam-budget-receipt", budget ? `${budget.receipt}; stream=request-and-response-counted; duration=body-lifecycle` : "not-configured");
  headers.set("x-anyam-response-bytes", Number.isSafeInteger(responseBytes) ? String(responseBytes) : "stream-counted");
  // The response body owns timeout and concurrency release. A consumer that
  // cancels after headers still closes the slot through countedStream.cancel.
  return new Response(responseBody.body, { status: response.status, headers });
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
