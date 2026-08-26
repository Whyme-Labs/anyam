import type { AuthorityPlaneSnapshot } from "./authority-plane.ts";

export const AUTHORITY_SQLITE_SCHEMA_VERSION = 1 as const;
/** Cloudflare's SQLite-backed Durable Object key/value API has a 2 MiB
 * combined key/value tripwire. The SQL path is qualified against snapshots
 * beyond this measured legacy representation size; remeasure before
 * production claims. */
export const AUTHORITY_LEGACY_JSON_VALUE_TRIPWIRE_BYTES = 2 * 1024 * 1024;

type SqlValue = string | number | null;

export type AuthoritySqlCursor<T extends Record<string, unknown> = Record<string, unknown>> = {
  toArray(): readonly T[];
};

export type AuthoritySqlStorage = {
  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): AuthoritySqlCursor<T>;
  readonly databaseSize?: number;
};

export type AuthoritySqlHost = {
  sql: AuthoritySqlStorage;
  transactionSync<T>(closure: () => T): T;
};

export type AuthoritySnapshotAdapter = {
  empty(realmId: string): AuthorityPlaneSnapshot;
  normalize(snapshot: AuthorityPlaneSnapshot): AuthorityPlaneSnapshot;
};

export type AuthoritySqliteStorageReceipt = {
  protocol: "anyam.authority-sqlite-storage/v1";
  schemaVersion: typeof AUTHORITY_SQLITE_SCHEMA_VERSION;
  entityRows: number;
  auditRows: number;
  idempotencyRows: number;
  databaseBytes?: number;
  receipt: string;
};

export function authoritySnapshotJsonBytes(snapshot: AuthorityPlaneSnapshot): number {
  return new TextEncoder().encode(json(snapshot)).byteLength;
}

function percentile(samples: readonly number[], percentileValue: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function authorityCommandLatencyReceipt(samples: readonly number[]): string {
  return `samples=${samples.length}; p50Ms=${percentile(samples, 0.5).toFixed(3)}; p95Ms=${percentile(samples, 0.95).toFixed(3)}; p99Ms=${percentile(samples, 0.99).toFixed(3)}; measurement=sqlite-transaction-commit; remeasure-before-production`;
}

const ENTITY_COLLECTIONS = [
  "projects",
  "sourceSpaces",
  "projectRevisions",
  "intents",
  "intentComments",
  "pullRequests",
  "projectViews",
  "workspaces",
  "changes",
  "changeRevisions",
  "runs",
  "runnerProfiles",
  "runnerAttempts",
  "evidence",
  "artifacts",
  "landings",
  "releases",
  "targets",
  "promotions",
  "mirrors",
  "mirrorOperations",
  "mirrorCheckpoints",
  "externalProposals",
  "mirrorDeliveries",
  "canonicalByProject",
] as const;

type EntityCollection = typeof ENTITY_COLLECTIONS[number];

type EntityRow = {
  collection: string;
  entity_id: string;
  payload: string;
};

type MetaRow = {
  protocol: string;
  realm_id: string;
  version: number;
};

type AuditRow = {
  event_id: string;
  state_version: number;
  payload: string;
};

type IdempotencyRow = {
  idempotency_key: string;
  fingerprint: string;
  result: string;
};

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("authority_sqlite_json_unserializable");
  return encoded;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function assertAuthoritySnapshotEquivalent(previous: AuthorityPlaneSnapshot, next: AuthorityPlaneSnapshot): void {
  if (previous.realmId !== next.realmId || stableJson(previous) !== stableJson(next)) throw new Error("authority_sqlite_noop_snapshot_mismatch");
}

function parsed<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error("authority_sqlite_" + field + "_malformed");
  }
}

function sqlText(value: SqlValue | undefined, field: string): string {
  if (typeof value !== "string") throw new Error("authority_sqlite_" + field + "_text_required");
  return value;
}

function mapFor(snapshot: AuthorityPlaneSnapshot, collection: EntityCollection): Record<string, unknown> {
  const value = snapshot[collection];
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("authority_sqlite_collection_malformed");
  return value as Record<string, unknown>;
}

function rowsByCollection(rows: readonly EntityRow[]): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    const collection = result[row.collection] ?? {};
    collection[row.entity_id] = parsed<unknown>(row.payload, "entity");
    result[row.collection] = collection;
  }
  return result;
}

function createSchema(sql: AuthoritySqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS anyam_authority_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS anyam_authority_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), protocol TEXT NOT NULL, realm_id TEXT NOT NULL, version INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS anyam_authority_entities (collection TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (collection, entity_id))");
  sql.exec("CREATE INDEX IF NOT EXISTS anyam_authority_entities_collection_idx ON anyam_authority_entities (collection)");
  sql.exec("CREATE TABLE IF NOT EXISTS anyam_authority_audit_events (event_id TEXT PRIMARY KEY, state_version INTEGER NOT NULL, command TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload TEXT NOT NULL)");
  sql.exec("CREATE INDEX IF NOT EXISTS anyam_authority_audit_state_idx ON anyam_authority_audit_events (state_version, event_id)");
  sql.exec("CREATE TABLE IF NOT EXISTS anyam_authority_idempotency (idempotency_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)");
  const latestVersion = Number(sql.exec<{ version: number }>("SELECT MAX(version) AS version FROM anyam_authority_migrations").toArray()[0]?.version ?? 0);
  if (latestVersion > AUTHORITY_SQLITE_SCHEMA_VERSION) throw new Error("authority_sqlite_schema_version_unsupported");
  sql.exec("INSERT OR IGNORE INTO anyam_authority_migrations (version, applied_at) VALUES (?, ?)", AUTHORITY_SQLITE_SCHEMA_VERSION, new Date().toISOString());
}

function requireMeta(sql: AuthoritySqlStorage, realmId: string, expectedVersion?: number): MetaRow | undefined {
  const rows = sql.exec<MetaRow>("SELECT protocol, realm_id, version FROM anyam_authority_meta WHERE singleton = 1").toArray();
  const row = rows[0];
  if (!row) return undefined;
  if (row.protocol !== "anyam.authority-plane/v1") throw new Error("authority_sqlite_protocol_mismatch");
  if (row.realm_id !== realmId) throw new Error("authority_sqlite_realm_mismatch");
  if (expectedVersion !== undefined && row.version !== expectedVersion) throw new Error("authority_sqlite_stale_version");
  return row;
}

function entityIds(value: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(value));
}

function assertImmutableRecords<T extends Record<string, unknown>>(previous: T, next: T, field: string): void {
  for (const id of Object.keys(previous)) {
    if (!(id in next)) throw new Error("authority_sqlite_" + field + "_deletion_forbidden:" + id);
    if (json(previous[id]) !== json(next[id])) throw new Error("authority_sqlite_" + field + "_mutation_forbidden:" + id);
  }
}

export class AuthoritySQLiteStore {
  constructor(private readonly host: AuthoritySqlHost, private readonly adapter: AuthoritySnapshotAdapter) {}

  load(realmId: string): AuthorityPlaneSnapshot | undefined {
    return this.host.transactionSync(() => {
      createSchema(this.host.sql);
      const meta = requireMeta(this.host.sql, realmId);
      if (!meta) return undefined;
      const rows = this.host.sql.exec<EntityRow>("SELECT collection, entity_id, payload FROM anyam_authority_entities ORDER BY collection, entity_id").toArray();
      const collections = rowsByCollection(rows);
      const auditRows = this.host.sql.exec<AuditRow>("SELECT event_id, state_version, payload FROM anyam_authority_audit_events ORDER BY state_version, event_id").toArray();
      const idempotencyRows = this.host.sql.exec<IdempotencyRow>("SELECT idempotency_key, fingerprint, result FROM anyam_authority_idempotency ORDER BY idempotency_key").toArray();
      const empty = this.adapter.empty(realmId);
      const snapshot: AuthorityPlaneSnapshot = {
        ...empty,
        protocol: meta.protocol as AuthorityPlaneSnapshot["protocol"],
        realmId: meta.realm_id,
        version: meta.version,
        ...Object.fromEntries(ENTITY_COLLECTIONS.map((collection) => [collection, collections[collection] ?? {}])),
        idempotency: Object.fromEntries(idempotencyRows.map((row) => [sqlText(row.idempotency_key, "idempotency_key"), { fingerprint: sqlText(row.fingerprint, "fingerprint"), result: parsed(sqlText(row.result, "idempotency"), "idempotency") }])),
        audit: auditRows.map((row) => parsed(sqlText(row.payload, "audit"), "audit")),
      };
      return this.adapter.normalize(snapshot);
    });
  }

  replace(snapshot: AuthorityPlaneSnapshot): void {
    this.host.transactionSync(() => {
      createSchema(this.host.sql);
      const normalized = this.adapter.normalize(snapshot);
      this.host.sql.exec("DELETE FROM anyam_authority_entities");
      this.host.sql.exec("DELETE FROM anyam_authority_audit_events");
      this.host.sql.exec("DELETE FROM anyam_authority_idempotency");
      this.host.sql.exec("INSERT INTO anyam_authority_meta (singleton, protocol, realm_id, version) VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET protocol=excluded.protocol, realm_id=excluded.realm_id, version=excluded.version", normalized.protocol, normalized.realmId, normalized.version);
      for (const collection of ENTITY_COLLECTIONS) this.writeCollection(normalized, collection);
      for (const event of normalized.audit) this.writeAudit(event);
      for (const [idempotencyKey, record] of Object.entries(normalized.idempotency)) this.writeIdempotency(idempotencyKey, record);
    });
  }

  commit(previous: AuthorityPlaneSnapshot, next: AuthorityPlaneSnapshot): void {
    if (previous.realmId !== next.realmId) throw new Error("authority_sqlite_realm_mismatch");
    if (next.version === previous.version) {
      assertAuthoritySnapshotEquivalent(previous, next);
      return;
    }
    if (next.version !== previous.version + 1) throw new Error("authority_sqlite_version_transition_invalid");
    this.host.transactionSync(() => {
      createSchema(this.host.sql);
      if (!requireMeta(this.host.sql, previous.realmId, previous.version)) throw new Error("authority_sqlite_meta_missing");
      this.host.sql.exec("UPDATE anyam_authority_meta SET protocol = ?, realm_id = ?, version = ? WHERE singleton = 1", next.protocol, next.realmId, next.version);
      for (const collection of ENTITY_COLLECTIONS) this.diffCollection(previous, next, collection);
      assertImmutableRecords(previous.idempotency, next.idempotency, "idempotency");
      for (const [idempotencyKey, record] of Object.entries(next.idempotency)) {
        if (!(idempotencyKey in previous.idempotency)) this.writeIdempotency(idempotencyKey, record);
      }
      if (new Set(next.audit.map((event) => event.id)).size !== next.audit.length) throw new Error("authority_sqlite_audit_duplicate");
      assertImmutableRecords(Object.fromEntries(previous.audit.map((event) => [event.id, event])), Object.fromEntries(next.audit.map((event) => [event.id, event])), "audit");
      const previousAuditIds = new Set(previous.audit.map((event) => event.id));
      for (const event of next.audit) if (!previousAuditIds.has(event.id)) this.writeAudit(event);
    });
  }

  receipt(): AuthoritySqliteStorageReceipt {
    return this.host.transactionSync(() => {
      createSchema(this.host.sql);
      const entityRows = Number(this.host.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM anyam_authority_entities").toArray()[0]?.count ?? 0);
      const auditRows = Number(this.host.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM anyam_authority_audit_events").toArray()[0]?.count ?? 0);
      const idempotencyRows = Number(this.host.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM anyam_authority_idempotency").toArray()[0]?.count ?? 0);
      const databaseBytes = this.host.sql.databaseSize;
      return {
        protocol: "anyam.authority-sqlite-storage/v1",
        schemaVersion: AUTHORITY_SQLITE_SCHEMA_VERSION,
        entityRows,
        auditRows,
        idempotencyRows,
        ...(databaseBytes === undefined ? {} : { databaseBytes }),
        receipt: `schema=${AUTHORITY_SQLITE_SCHEMA_VERSION}; entityRows=${entityRows}; auditRows=${auditRows}; idempotencyRows=${idempotencyRows}; databaseBytes=${databaseBytes === undefined ? "not-observed" : databaseBytes}; provider=durable-object-sqlite; remeasure-before-production`,
      };
    });
  }

  private writeCollection(snapshot: AuthorityPlaneSnapshot, collection: EntityCollection): void {
    for (const [entityId, value] of Object.entries(mapFor(snapshot, collection))) {
      this.host.sql.exec("INSERT INTO anyam_authority_entities (collection, entity_id, payload) VALUES (?, ?, ?)", collection, entityId, json(value));
    }
  }

  private diffCollection(previous: AuthorityPlaneSnapshot, next: AuthorityPlaneSnapshot, collection: EntityCollection): void {
    const before = mapFor(previous, collection);
    const after = mapFor(next, collection);
    const ids = new Set([...entityIds(before), ...entityIds(after)]);
    for (const entityId of ids) {
      if (!(entityId in after)) {
        this.host.sql.exec("DELETE FROM anyam_authority_entities WHERE collection = ? AND entity_id = ?", collection, entityId);
      } else if (!(entityId in before) || json(before[entityId]) !== json(after[entityId])) {
        this.host.sql.exec("INSERT INTO anyam_authority_entities (collection, entity_id, payload) VALUES (?, ?, ?) ON CONFLICT(collection, entity_id) DO UPDATE SET payload=excluded.payload", collection, entityId, json(after[entityId]));
      }
    }
  }

  private writeAudit(event: AuthorityPlaneSnapshot["audit"][number]): void {
    this.host.sql.exec("INSERT INTO anyam_authority_audit_events (event_id, state_version, command, idempotency_key, payload) VALUES (?, ?, ?, ?, ?)", event.id, event.stateVersion, event.command, event.idempotencyKey, json(event));
  }

  private writeIdempotency(idempotencyKey: string, record: AuthorityPlaneSnapshot["idempotency"][string]): void {
    this.host.sql.exec("INSERT INTO anyam_authority_idempotency (idempotency_key, fingerprint, result) VALUES (?, ?, ?)", idempotencyKey, record.fingerprint, json(record.result));
  }
}
