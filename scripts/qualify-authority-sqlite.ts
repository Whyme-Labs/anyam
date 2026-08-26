import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { emptyAuthorityPlaneSnapshot, normalizeAuthorityPlaneSnapshot, type AuthorityPlaneSnapshot } from "../src/cloudflare/authority-plane.ts";
import { AUTHORITY_LEGACY_JSON_VALUE_TRIPWIRE_BYTES, AuthoritySQLiteStore, authorityCommandLatencyReceipt, authoritySnapshotJsonBytes, type AuthoritySqlHost, type AuthoritySqlStorage } from "../src/cloudflare/authority-sqlite.ts";

class NodeSqlStorage implements AuthoritySqlStorage {
  constructor(private readonly database: DatabaseSync) {}

  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
    const rows = this.database.prepare(query).all(...bindings as SQLInputValue[]) as unknown as readonly T[];
    return { toArray: () => rows };
  }

  get databaseSize(): number {
    const pageCount = this.database.prepare("PRAGMA page_count").get() as unknown as { page_count?: number };
    const pageSize = this.database.prepare("PRAGMA page_size").get() as unknown as { page_size?: number };
    return Number(pageCount.page_count ?? 0) * Number(pageSize.page_size ?? 0);
  }
}

class NodeSqlHost implements AuthoritySqlHost {
  readonly sql: NodeSqlStorage;

  constructor(readonly database: DatabaseSync) {
    this.sql = new NodeSqlStorage(database);
  }

  transactionSync<T>(closure: () => T): T {
    this.database.exec("BEGIN");
    try {
      const result = closure();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const realmId = "realm:authority-sqlite-qualification";
const database = new DatabaseSync(":memory:");
try {
  const host = new NodeSqlHost(database);
  const persistence = new AuthoritySQLiteStore(host, { empty: emptyAuthorityPlaneSnapshot, normalize: normalizeAuthorityPlaneSnapshot });
  let snapshot: AuthorityPlaneSnapshot = emptyAuthorityPlaneSnapshot(realmId);
  let index = 0;
  const projectName = "x".repeat(900);
  while (authoritySnapshotJsonBytes(snapshot) <= AUTHORITY_LEGACY_JSON_VALUE_TRIPWIRE_BYTES + 32_768) {
    const projectId = "project:growth:" + index;
    snapshot = { ...snapshot, version: snapshot.version + 1, projects: { ...snapshot.projects, [projectId]: { protocol: "anyam.project/v1", id: projectId, name: projectName, referenceType: "git", sourceSpaceIds: [] } } };
    index += 1;
  }
  persistence.replace(emptyAuthorityPlaneSnapshot(realmId));
  persistence.replace(snapshot);
  const samples: number[] = [];
  let previous = snapshot;
  for (let step = 0; step < 32; step += 1) {
    const started = performance.now();
    const projectId = "project:post-tripwire:" + step;
    const next: AuthorityPlaneSnapshot = { ...previous, version: previous.version + 1, projects: { ...previous.projects, [projectId]: { protocol: "anyam.project/v1", id: projectId, name: "post-tripwire", referenceType: "git", sourceSpaceIds: [] } } };
    persistence.commit(previous, next);
    samples.push(performance.now() - started);
    previous = next;
  }
  const storage = persistence.receipt();
  const legacySnapshotBytes = authoritySnapshotJsonBytes(snapshot);
  console.log(JSON.stringify({ protocol: "anyam.authority-sqlite-growth-qualification/v1", status: "succeeded", legacySnapshotBytes, legacyTripwireBytes: AUTHORITY_LEGACY_JSON_VALUE_TRIPWIRE_BYTES, mutationsAfterTripwire: 32, latencyReceipt: authorityCommandLatencyReceipt(samples), storage, receipt: `legacySnapshotBytes=${legacySnapshotBytes}; legacyTripwireBytes=${AUTHORITY_LEGACY_JSON_VALUE_TRIPWIRE_BYTES}; mutationsAfterTripwire=32; ${authorityCommandLatencyReceipt(samples)}; ${storage.receipt}; providerFactsAreNotAnyamLimits=true` }, null, 2));
} finally {
  database.close();
}
