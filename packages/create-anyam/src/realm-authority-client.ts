/**
 * Minimal customer-Realm Authority transport used by the hosted CLI.
 *
 * The package owns this transport so its published build remains self
 * contained. The repository-level portability entry point re-exports it for
 * qualifications and tests; the customer Realm remains the state owner.
 */

export class RealmAuthorityRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { status: number; code: string; recoveryAction: string; receipt: string }) {
    super(`${input.code}; ${input.recoveryAction}; ${input.receipt}`);
    this.name = "RealmAuthorityRequestError";
    this.status = input.status;
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

export type JsonObject = Record<string, unknown>;

function object(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`realm_authority_${field}_not_object`);
  return value as JsonObject;
}

function safeField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function ownerCookie(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("realm_authority_owner_session_missing");
  if (trimmed.startsWith("anyam_owner_session=")) {
    const first = trimmed.split(";", 1)[0]?.trim();
    if (!first || first === "anyam_owner_session=" || /[\r\n]/u.test(first)) throw new Error("realm_authority_owner_session_invalid");
    return first;
  }
  if (/[\s;\r\n]/u.test(trimmed)) throw new Error("realm_authority_owner_session_invalid");
  return `anyam_owner_session=${encodeURIComponent(trimmed)}`;
}

export type RealmAuthorityHttpClientOptions = {
  baseUrl: string;
  ownerSession: string;
  fetchImpl?: typeof fetch;
};

export class RealmAuthorityHttpClient {
  private readonly baseUrl: URL;
  private readonly cookie: string;
  private readonly fetchImpl: typeof fetch;

  constructor(input: RealmAuthorityHttpClientOptions) {
    const base = new URL(input.baseUrl);
    if (base.username || base.password || base.search || base.hash) throw new Error("realm_authority_base_url_must_not_contain_credentials_or_query");
    if (base.protocol !== "https:" && !(base.protocol === "http:" && (base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]"))) throw new Error("realm_authority_base_url_must_use_https");
    base.pathname = base.pathname.replace(/\/+$/u, "");
    this.baseUrl = base;
    this.cookie = ownerCookie(input.ownerSession);
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  private url(pathname: string): string {
    if (!pathname.startsWith("/")) throw new Error("realm_authority_path_must_be_absolute");
    return new URL(pathname, this.baseUrl).toString();
  }

  private async request(pathname: string, input: { method: "GET" | "POST"; body?: JsonObject; idempotencyKey?: string; allowStatuses?: readonly number[]; allowBlocked?: boolean }): Promise<JsonObject> {
    const headers = new Headers({ accept: "application/json", cookie: this.cookie });
    if (input.body !== undefined) {
      headers.set("content-type", "application/json");
      headers.set("idempotency-key", input.idempotencyKey ?? "");
    }
    const response = await this.fetchImpl(this.url(pathname), {
      method: input.method,
      headers,
      cache: "no-store",
      redirect: "error",
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const parsed: unknown = await response.json().catch(() => ({}));
    const payload = object(parsed, "response");
    const allowedStatus = (input.allowStatuses ?? []).includes(response.status) && (!input.allowBlocked || payload.status === "blocked");
    if (!response.ok && !allowedStatus) {
      throw new RealmAuthorityRequestError({
        status: response.status,
        code: safeField(payload.code, `http_${response.status}`),
        recoveryAction: safeField(payload.recoveryAction, "inspect the customer Realm receipt and retry only the same idempotent request when safe"),
        receipt: safeField(payload.receipt, "receipt=not-returned; credentialMaterialStored=false"),
      });
    }
    return payload;
  }

  inspectProject(projectId: string): Promise<JsonObject> { return this.request(`/api/projects/${encodeURIComponent(projectId)}`, { method: "GET" }); }
  inspectState(): Promise<JsonObject> { return this.request("/api/authority/state", { method: "GET" }); }
  inspectMirror(mirrorId: string): Promise<JsonObject> { return this.request(`/api/mirrors/${encodeURIComponent(mirrorId)}`, { method: "GET" }); }
  listIntents(projectId?: string): Promise<JsonObject> { return this.request(`/api/intents${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, { method: "GET" }); }
  inspectIntent(intentId: string): Promise<JsonObject> { return this.request(`/api/intents/${encodeURIComponent(intentId)}`, { method: "GET" }); }
  createIntent(body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request("/api/intents", { method: "POST", body, idempotencyKey }); }
  assignIntent(intentId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/intents/${encodeURIComponent(intentId)}/assign`, { method: "POST", body, idempotencyKey }); }
  commentIntent(intentId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/intents/${encodeURIComponent(intentId)}/comment`, { method: "POST", body, idempotencyKey }); }
  closeIntent(intentId: string, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/intents/${encodeURIComponent(intentId)}/close`, { method: "POST", body: {}, idempotencyKey }); }
  reopenIntent(intentId: string, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/intents/${encodeURIComponent(intentId)}/reopen`, { method: "POST", body: {}, idempotencyKey }); }
  listPullRequests(projectId?: string): Promise<JsonObject> { return this.request(`/api/pull-requests${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, { method: "GET" }); }
  inspectPullRequest(pullRequestId: string): Promise<JsonObject> { return this.request(`/api/pull-requests/${encodeURIComponent(pullRequestId)}`, { method: "GET" }); }
  openPullRequest(body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request("/api/pull-requests", { method: "POST", body, idempotencyKey }); }
  updatePullRequest(pullRequestId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/pull-requests/${encodeURIComponent(pullRequestId)}/update`, { method: "POST", body, idempotencyKey }); }
  reviewPullRequest(pullRequestId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/pull-requests/${encodeURIComponent(pullRequestId)}/review`, { method: "POST", body, idempotencyKey }); }
  closePullRequest(pullRequestId: string, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/pull-requests/${encodeURIComponent(pullRequestId)}/close`, { method: "POST", body: {}, idempotencyKey }); }
  reopenPullRequest(pullRequestId: string, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/pull-requests/${encodeURIComponent(pullRequestId)}/reopen`, { method: "POST", body: {}, idempotencyKey }); }
  blockPullRequest(pullRequestId: string, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/pull-requests/${encodeURIComponent(pullRequestId)}/block`, { method: "POST", body: {}, idempotencyKey }); }
  mergePullRequest(pullRequestId: string, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/pull-requests/${encodeURIComponent(pullRequestId)}/merge`, { method: "POST", body: {}, idempotencyKey }); }
  createProject(body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request("/api/projects", { method: "POST", body, idempotencyKey }); }
  createWorkspace(projectId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/projects/${encodeURIComponent(projectId)}/workspaces`, { method: "POST", body, idempotencyKey }); }
  configureMirror(body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request("/api/mirrors", { method: "POST", body, idempotencyKey }); }
  syncMirror(mirrorId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/mirrors/${encodeURIComponent(mirrorId)}/sync`, { method: "POST", body, idempotencyKey, allowStatuses: [409], allowBlocked: true }); }
  reconcileMirror(mirrorId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request(`/api/mirrors/${encodeURIComponent(mirrorId)}/reconcile`, { method: "POST", body, idempotencyKey, allowStatuses: [409], allowBlocked: true }); }
  exportAuthorityRecovery(): Promise<JsonObject> { return this.request("/api/authority/recovery/export", { method: "POST", body: {}, idempotencyKey: "qualification:authority-recovery-export" }); }
  restoreAuthorityRecovery(bundle: JsonObject): Promise<JsonObject> { return this.request("/api/authority/recovery/restore", { method: "POST", body: { bundle }, idempotencyKey: "qualification:authority-recovery-restore" }); }
  activateAuthorityRecovery(bundleId: string, bundleDigest: string): Promise<JsonObject> { return this.request("/api/authority/recovery/activate", { method: "POST", body: { bundleId, bundleDigest }, idempotencyKey: `qualification:authority-recovery-activate:${bundleId}` }); }
  command(input: { command: string; payload: JsonObject; idempotencyKey: string; expectedVersion?: number; allowStatuses?: readonly number[] }): Promise<JsonObject> {
    return this.request("/api/authority/command", {
      method: "POST",
      body: { protocol: "anyam.authority-command/v1", command: input.command, idempotencyKey: input.idempotencyKey, ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }), payload: input.payload },
      idempotencyKey: input.idempotencyKey,
      ...(input.allowStatuses === undefined ? {} : { allowStatuses: input.allowStatuses }),
    });
  }
}
