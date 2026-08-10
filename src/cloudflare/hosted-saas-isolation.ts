/**
 * Shared Hosted SaaS routing and storage boundary.
 *
 * This is deliberately small: it proves the invariant that a request is
 * routed by the host-bound Realm, and every authority-bearing lookup is
 * partitioned by that Realm. Provider adapters can sit behind this boundary;
 * they must never receive a caller-selected Realm as authority.
 */

export const HOSTED_SAAS_ISOLATION_PROTOCOL = "anyam.hosted-saas-isolation/v1" as const;
export const HOSTED_SAAS_TOKEN_AUDIENCE = "aud:anyam:hosted-api" as const;

type Project = {
  readonly projectId: string;
  readonly name: string;
  readonly contentDigest: string;
  readonly revision: number;
};

type RealmRecord = {
  readonly realmId: string;
  readonly host: string;
  readonly policyVersion: string;
  authorizationEpoch: number;
};

type Credential = {
  readonly token: string;
  readonly realmId: string;
  readonly principalId: string;
  readonly audience: typeof HOSTED_SAAS_TOKEN_AUDIENCE;
  readonly authorizationEpoch: number;
};

type QueueMessage = {
  readonly messageId: string;
  readonly realmId: string;
  readonly projectId: string;
  readonly correlationId: string;
};

type EventRecord = {
  readonly eventId: string;
  readonly realmId: string;
  readonly projectId: string;
  readonly correlationId: string;
};

type LogRecord = {
  readonly requestId: string;
  readonly realmId: string;
  readonly path: string;
  readonly outcome: "accepted" | "rejected";
};

type ExportRecord = {
  readonly key: string;
  readonly realmId: string;
  readonly projectId: string;
  readonly contentDigest: string;
};

export type HostedSaaSRequestOperation =
  | "create-project"
  | "read-project"
  | "mutate-project"
  | "enumerate-projects"
  | "export-project";

export type HostedSaaSRequest = {
  readonly operation: HostedSaaSRequestOperation;
  readonly projectId?: string;
  readonly name?: string;
  readonly contentDigest?: string;
  readonly correlationId: string;
};

export type HostedSaaSResponseBody = {
  readonly protocol: typeof HOSTED_SAAS_ISOLATION_PROTOCOL;
  readonly status: "accepted" | "not-found" | "conflict" | "invalid-request";
  readonly project?: Project;
  readonly projects?: readonly Project[];
  readonly export?: { readonly digest: string; readonly key: string };
  readonly receipt: string;
};

export type HostedSaaSHTTPResponse = {
  readonly status: 200 | 201 | 400 | 404 | 409;
  readonly body: HostedSaaSResponseBody;
};

export type HostedSaaSIsolationSnapshot = {
  readonly credentialFree: true;
  readonly realms: readonly RealmRecord[];
  readonly projects: readonly { key: string; value: Project }[];
  readonly credentialMetadata: readonly { realmId: string; principalId: string; audience: typeof HOSTED_SAAS_TOKEN_AUDIENCE; authorizationEpoch: number }[];
  readonly queue: readonly QueueMessage[];
  readonly events: readonly EventRecord[];
  readonly logs: readonly LogRecord[];
  readonly cache: readonly { key: string; value: Project }[];
  readonly exports: readonly ExportRecord[];
};

export type HostedSaaSInspection = {
  readonly realmId: string;
  readonly storageKeys: readonly string[];
  readonly cacheKeys: readonly string[];
  readonly queueMessageIds: readonly string[];
  readonly eventIds: readonly string[];
  readonly exportKeys: readonly string[];
  readonly logRequestIds: readonly string[];
};

export type HostedSaaSCleanupReceipt = {
  readonly realms: number;
  readonly projects: number;
  readonly credentials: number;
  readonly queueMessages: number;
  readonly events: number;
  readonly logs: number;
  readonly cacheEntries: number;
  readonly exports: number;
  readonly receipt: string;
};

export class HostedSaaSIsolationError extends Error {
  readonly code = "hosted_saas_isolation_error" as const;
  readonly status: 400 | 404 | 409;
  readonly receipt: string;

  constructor(input: { status: 400 | 404 | 409; message: string; receipt: string }) {
    super(input.message);
    this.name = "HostedSaaSIsolationError";
    this.status = input.status;
    this.receipt = input.receipt;
  }
}

function required(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HostedSaaSIsolationError({
      status: 400,
      message: `${field} is required.`,
      receipt: `field=${field}; present=false; mutation=not-performed`,
    });
  }
  return value.trim();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function realmKey(realmId: string, namespace: string, key: string): string {
  return `anyam/hosted/${realmId}/${namespace}/${key}`;
}

function body(status: HostedSaaSResponseBody["status"], receipt: string, extra: Omit<HostedSaaSResponseBody, "protocol" | "status" | "receipt"> = {}): HostedSaaSResponseBody {
  return { protocol: HOSTED_SAAS_ISOLATION_PROTOCOL, status, ...extra, receipt };
}

/**
 * A provider-neutral shared store. The production adapter can map these
 * namespaces to D1/R2/Queues/DO storage, but the partition key remains part
 * of the contract rather than an implementation convention.
 */
export class HostedSaaSIsolationStore {
  private readonly realms = new Map<string, RealmRecord>();
  private readonly projects = new Map<string, Project>();
  private readonly credentials = new Map<string, Credential>();
  private readonly queue: QueueMessage[] = [];
  private readonly events: EventRecord[] = [];
  private readonly logs: LogRecord[] = [];
  private readonly cache = new Map<string, Project>();
  private readonly exports = new Map<string, ExportRecord>();
  private sequence = 0;

  registerRealm(input: { realmId: string; host: string; policyVersion?: string }): RealmRecord {
    const realmId = required(input.realmId, "realmId");
    const host = required(input.host, "host").toLowerCase();
    if (this.realms.has(realmId)) throw new HostedSaaSIsolationError({ status: 409, message: "Realm already exists.", receipt: `realm=${realmId}; registration=duplicate` });
    const record: RealmRecord = { realmId, host, policyVersion: input.policyVersion?.trim() || `${realmId}:policy:v1`, authorizationEpoch: 1 };
    this.realms.set(realmId, record);
    return clone(record);
  }

  getRealm(realmId: string): RealmRecord | undefined {
    const record = this.realms.get(realmId);
    return record ? clone(record) : undefined;
  }

  findRealmByHost(host: string): RealmRecord | undefined {
    const normalizedHost = required(host, "host").toLowerCase();
    const record = [...this.realms.values()].find((candidate) => candidate.host === normalizedHost);
    return record ? clone(record) : undefined;
  }

  issueCredential(input: { realmId: string; principalId: string }): string {
    const realm = this.realms.get(required(input.realmId, "realmId"));
    if (!realm) throw new HostedSaaSIsolationError({ status: 404, message: "Realm not found.", receipt: "credential=not-issued; realm=not-found" });
    const token = `hosted-token-${++this.sequence}`;
    this.credentials.set(token, { token, realmId: realm.realmId, principalId: required(input.principalId, "principalId"), audience: HOSTED_SAAS_TOKEN_AUDIENCE, authorizationEpoch: realm.authorizationEpoch });
    return token;
  }

  revokeRealm(realmId: string): void {
    const realm = this.realms.get(required(realmId, "realmId"));
    if (!realm) throw new HostedSaaSIsolationError({ status: 404, message: "Realm not found.", receipt: "realm=revoke=not-found" });
    realm.authorizationEpoch += 1;
  }

  authenticate(token: string, realmId: string): Credential {
    const credential = this.credentials.get(required(token, "token"));
    const realm = this.realms.get(required(realmId, "realmId"));
    if (!credential || !realm || credential.audience !== HOSTED_SAAS_TOKEN_AUDIENCE || credential.realmId !== realm.realmId || credential.authorizationEpoch !== realm.authorizationEpoch) {
      throw new HostedSaaSIsolationError({ status: 404, message: "Resource not found.", receipt: "authorization=not-disclosed; cross-realm=not-disclosed" });
    }
    return clone(credential);
  }

  private nextId(prefix: string): string {
    return `${prefix}:${++this.sequence}`;
  }

  private appendObservations(input: { realmId: string; projectId: string; correlationId: string; path: string; outcome: LogRecord["outcome"] }): void {
    this.queue.push({ messageId: this.nextId("message"), realmId: input.realmId, projectId: input.projectId, correlationId: input.correlationId });
    this.events.push({ eventId: this.nextId("event"), realmId: input.realmId, projectId: input.projectId, correlationId: input.correlationId });
    this.logs.push({ requestId: input.correlationId, realmId: input.realmId, path: input.path, outcome: input.outcome });
  }

  createProject(realmId: string, input: { projectId: string; name: string; contentDigest: string; correlationId: string }): Project {
    const realm = this.realms.get(realmId);
    if (!realm) throw new HostedSaaSIsolationError({ status: 404, message: "Resource not found.", receipt: "realm=not-disclosed; project=not-created" });
    const projectId = required(input.projectId, "projectId");
    const key = realmKey(realmId, "projects", projectId);
    if (this.projects.has(key)) throw new HostedSaaSIsolationError({ status: 409, message: "Project already exists.", receipt: `realm=${realmId}; project=${projectId}; mutation=duplicate` });
    const project: Project = { projectId, name: required(input.name, "name"), contentDigest: required(input.contentDigest, "contentDigest"), revision: 1 };
    this.projects.set(key, project);
    this.cache.set(realmKey(realmId, "cache", projectId), project);
    this.appendObservations({ realmId, projectId, correlationId: required(input.correlationId, "correlationId"), path: `/api/projects/${projectId}`, outcome: "accepted" });
    return clone(project);
  }

  readProject(realmId: string, projectId: string, correlationId: string): Project {
    const normalizedProjectId = required(projectId, "projectId");
    const project = this.projects.get(realmKey(realmId, "projects", normalizedProjectId));
    this.appendObservations({ realmId, projectId: normalizedProjectId, correlationId: required(correlationId, "correlationId"), path: `/api/projects/${normalizedProjectId}`, outcome: project ? "accepted" : "rejected" });
    if (!project) throw new HostedSaaSIsolationError({ status: 404, message: "Resource not found.", receipt: "project=not-found; disclosure=none" });
    return clone(project);
  }

  mutateProject(realmId: string, input: { projectId: string; contentDigest: string; correlationId: string }): Project {
    const projectId = required(input.projectId, "projectId");
    const key = realmKey(realmId, "projects", projectId);
    const current = this.projects.get(key);
    this.appendObservations({ realmId, projectId, correlationId: required(input.correlationId, "correlationId"), path: `/api/projects/${projectId}`, outcome: current ? "accepted" : "rejected" });
    if (!current) throw new HostedSaaSIsolationError({ status: 404, message: "Resource not found.", receipt: "project=not-found; mutation=not-performed" });
    const next: Project = { ...current, contentDigest: required(input.contentDigest, "contentDigest"), revision: current.revision + 1 };
    this.projects.set(key, next);
    this.cache.set(realmKey(realmId, "cache", projectId), next);
    return clone(next);
  }

  enumerateProjects(realmId: string, correlationId: string): readonly Project[] {
    const prefix = realmKey(realmId, "projects", "");
    const projects = [...this.projects.entries()].filter(([key]) => key.startsWith(prefix)).map(([, project]) => clone(project));
    this.logs.push({ requestId: required(correlationId, "correlationId"), realmId, path: "/api/projects", outcome: "accepted" });
    return projects;
  }

  exportProject(realmId: string, projectId: string, correlationId: string): { digest: string; key: string } {
    const project = this.readProject(realmId, projectId, correlationId);
    const key = realmKey(realmId, "exports", project.projectId);
    const record: ExportRecord = { key, realmId, projectId: project.projectId, contentDigest: project.contentDigest };
    this.exports.set(key, record);
    return { digest: project.contentDigest, key };
  }

  inspect(realmId: string): HostedSaaSInspection {
    const prefix = `anyam/hosted/${realmId}/`;
    return {
      realmId,
      storageKeys: [...this.projects.keys()].filter((key) => key.startsWith(prefix)),
      cacheKeys: [...this.cache.keys()].filter((key) => key.startsWith(prefix)),
      queueMessageIds: this.queue.filter((message) => message.realmId === realmId).map((message) => message.messageId),
      eventIds: this.events.filter((event) => event.realmId === realmId).map((event) => event.eventId),
      exportKeys: [...this.exports.values()].filter((record) => record.realmId === realmId).map((record) => record.key),
      logRequestIds: this.logs.filter((log) => log.realmId === realmId).map((log) => log.requestId),
    };
  }

  cleanup(): HostedSaaSCleanupReceipt {
    const receipt: HostedSaaSCleanupReceipt = {
      realms: this.realms.size,
      projects: this.projects.size,
      credentials: this.credentials.size,
      queueMessages: this.queue.length,
      events: this.events.length,
      logs: this.logs.length,
      cacheEntries: this.cache.size,
      exports: this.exports.size,
      receipt: "cleanup=exact-store; credentialMaterialStored=false; canonicalWrite=false",
    };
    this.realms.clear();
    this.projects.clear();
    this.credentials.clear();
    this.queue.length = 0;
    this.events.length = 0;
    this.logs.length = 0;
    this.cache.clear();
    this.exports.clear();
    return receipt;
  }

  snapshot(): HostedSaaSIsolationSnapshot {
    return {
      credentialFree: true,
      realms: [...this.realms.values()].map(clone),
      projects: [...this.projects.entries()].map(([key, value]) => ({ key, value: clone(value) })),
      credentialMetadata: [...this.credentials.values()].map(({ realmId, principalId, audience, authorizationEpoch }) => ({ realmId, principalId, audience, authorizationEpoch })),
      queue: this.queue.map(clone),
      events: this.events.map(clone),
      logs: this.logs.map(clone),
      cache: [...this.cache.entries()].map(([key, value]) => ({ key, value: clone(value) })),
      exports: [...this.exports.values()].map(clone),
    };
  }

  restore(snapshot: HostedSaaSIsolationSnapshot): void {
    this.realms.clear();
    this.projects.clear();
    this.credentials.clear();
    this.queue.length = 0;
    this.events.length = 0;
    this.logs.length = 0;
    this.cache.clear();
    this.exports.clear();
    if (snapshot.credentialFree !== true) throw new HostedSaaSIsolationError({ status: 400, message: "Hosted SaaS restore requires a credential-free snapshot.", receipt: "snapshot=credential-free-required; authority=not-restored" });
    for (const realm of snapshot.realms) this.realms.set(realm.realmId, clone(realm));
    for (const project of snapshot.projects) this.projects.set(project.key, clone(project.value));
    this.queue.push(...snapshot.queue.map(clone));
    this.events.push(...snapshot.events.map(clone));
    this.logs.push(...snapshot.logs.map(clone));
    for (const entry of snapshot.cache) this.cache.set(entry.key, clone(entry.value));
    for (const record of snapshot.exports) this.exports.set(record.key, clone(record));
    const sequenceValues = [
      ...snapshot.queue.map((message) => Number(message.messageId.split(":").at(-1))),
      ...snapshot.events.map((event) => Number(event.eventId.split(":").at(-1))),
    ].filter(Number.isSafeInteger);
    this.sequence = sequenceValues.length > 0 ? Math.max(...sequenceValues) : 0;
  }
}

export class HostedSaaSRouter {
  constructor(private readonly store: HostedSaaSIsolationStore) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const realm = this.store.findRealmByHost(url.hostname);
    if (!realm) return this.response(404, body("not-found", "route=not-found; realm=not-disclosed"));
    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    try {
      this.store.authenticate(required(token, "authorization"), realm.realmId);
      const payload = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
      const projectId = url.pathname.startsWith("/api/projects/") ? decodeURIComponent(url.pathname.slice("/api/projects/".length)) : undefined;
      const correlationId = request.headers.get("x-anyam-correlation-id") ?? `request:${crypto.randomUUID()}`;
      if (url.pathname === "/api/projects" && request.method === "GET") return this.response(200, body("accepted", `realm=${realm.realmId}; operation=enumerate; disclosure=realm-scoped`, { projects: this.store.enumerateProjects(realm.realmId, correlationId) }));
      if (url.pathname === "/api/projects" && request.method === "POST") {
        const input = payload as Record<string, unknown> | undefined;
        const project = this.store.createProject(realm.realmId, { projectId: required(typeof input?.projectId === "string" ? input.projectId : undefined, "projectId"), name: required(typeof input?.name === "string" ? input.name : undefined, "name"), contentDigest: required(typeof input?.contentDigest === "string" ? input.contentDigest : undefined, "contentDigest"), correlationId });
        return this.response(201, body("accepted", `realm=${realm.realmId}; operation=create; project=${project.projectId}`, { project }));
      }
      if (!projectId || !url.pathname.startsWith("/api/projects/")) return this.response(404, body("not-found", "route=not-found; disclosure=none"));
      if (url.pathname.endsWith("/export") && request.method === "POST") {
        const cleanProjectId = projectId.slice(0, -"/export".length);
        const exported = this.store.exportProject(realm.realmId, cleanProjectId, correlationId);
        return this.response(200, body("accepted", `realm=${realm.realmId}; operation=export; disclosure=realm-scoped`, { export: exported }));
      }
      if (request.method === "GET") return this.response(200, body("accepted", `realm=${realm.realmId}; operation=read; disclosure=realm-scoped`, { project: this.store.readProject(realm.realmId, projectId, correlationId) }));
      if (request.method === "PATCH") {
        const input = payload as Record<string, unknown> | undefined;
        const project = this.store.mutateProject(realm.realmId, { projectId, contentDigest: required(typeof input?.contentDigest === "string" ? input.contentDigest : undefined, "contentDigest"), correlationId });
        return this.response(200, body("accepted", `realm=${realm.realmId}; operation=mutate; project=${project.projectId}`, { project }));
      }
      return this.response(400, body("invalid-request", `method=${request.method}; operation=not-performed`));
    } catch (error) {
      if (error instanceof HostedSaaSIsolationError) return this.response(error.status, body(error.status === 409 ? "conflict" : error.status === 400 ? "invalid-request" : "not-found", error.status === 404 ? "resource=not-found; disclosure=none" : error.receipt));
      return this.response(400, body("invalid-request", "request=invalid; mutation=not-performed"));
    }
  }

  private response(status: number, payload: HostedSaaSResponseBody): Response {
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
}
