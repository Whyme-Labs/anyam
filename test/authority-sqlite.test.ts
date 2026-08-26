import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { AuthorityPlaneCoordinator, AUTHORITY_COMMAND_PROTOCOL, emptyAuthorityPlaneSnapshot, normalizeAuthorityPlaneSnapshot, type AuthorityPlaneSnapshot, type AuthoritySession } from "../src/cloudflare/authority-plane.ts";
import { AUTHORITY_LEGACY_JSON_VALUE_TRIPWIRE_BYTES, AuthoritySQLiteStore, authorityCommandLatencyReceipt, authoritySnapshotJsonBytes, type AuthoritySqlHost, type AuthoritySqlStorage } from "../src/cloudflare/authority-sqlite.ts";
import { PROMOTION_EXECUTION_PROTOCOL, type PromotionExecutionContext, type PromotionExecutionResult } from "../src/cloudflare/promotion-execution.ts";
import { CONTRACT_VERSIONS } from "../src/kernel/contracts.ts";

class NodeSqlStorage implements AuthoritySqlStorage {
  constructor(private readonly database: DatabaseSync) {}

  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
    const statement = this.database.prepare(query);
    const rows = statement.all(...bindings as SQLInputValue[]) as unknown as readonly T[];
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

function store(database: DatabaseSync): AuthoritySQLiteStore {
  return new AuthoritySQLiteStore(new NodeSqlHost(database), { empty: emptyAuthorityPlaneSnapshot, normalize: normalizeAuthorityPlaneSnapshot });
}

const session: AuthoritySession = { realmId: "realm:authority-sqlite", principalId: "principal:owner", actorId: "actor:owner", sessionId: "session:owner", clientId: "client:test", authorizationEpoch: 1 };

function command(coordinator: AuthorityPlaneCoordinator, idempotencyKey: string, payload: Record<string, unknown>) {
  return coordinator.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "project.create", idempotencyKey, payload }, session);
}

test("AuthoritySQLiteStore round-trips normalized entity, audit, and idempotency rows", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const persistence = store(database);
    const empty = emptyAuthorityPlaneSnapshot(session.realmId);
    assert.equal(persistence.load(session.realmId), undefined);
    persistence.replace(empty);
    const coordinator = new AuthorityPlaneCoordinator(empty);
    const result = command(coordinator, "project:create", { projectId: "project:sqlite", name: "SQLite", referenceType: "git", sourceSpaces: [{ id: "source:sqlite", name: "SQLite source", classification: "internal", snapshotId: "snapshot:base" }], projectRevisionId: "revision:base" });
    assert.equal(result.status, "succeeded");
    const next = coordinator.snapshot();
    persistence.commit(empty, next);
    const restored = persistence.load(session.realmId);
    assert.ok(restored);
    assert.equal(restored.projects["project:sqlite"]?.name, "SQLite");
    assert.equal(restored.version, 1);
    assert.equal(restored.audit.length, 1);
    assert.equal(restored.idempotency["project:create"]?.result.command, "project.create");
    const replay = new AuthorityPlaneCoordinator(restored);
    const replayed = command(replay, "project:create", { projectId: "project:sqlite", name: "SQLite", referenceType: "git", sourceSpaces: [{ id: "source:sqlite", name: "SQLite source", classification: "internal", snapshotId: "snapshot:base" }], projectRevisionId: "revision:base" });
    assert.equal(replayed.version, 1);
    assert.equal(replay.snapshot().audit.length, 1);
    assert.doesNotThrow(() => persistence.commit(restored, replay.snapshot()), "a same-fingerprint replay must be a persisted no-op");
    assert.throws(() => persistence.commit({ ...restored, version: 0 }, restored));
    const receipt = persistence.receipt();
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.entityRows, 4);
    assert.equal(receipt.auditRows, 1);
    assert.equal(receipt.idempotencyRows, 1);
    assert.ok((receipt.databaseBytes ?? 0) > 0);
  } finally {
    database.close();
  }
});

function promotionFixture(): { snapshot: AuthorityPlaneSnapshot; promotionId: string; executionIdempotencyKey: string; session: AuthoritySession } {
  const promotionSession: AuthoritySession = { realmId: "realm:authority-sqlite-promotion", principalId: "principal:owner", actorId: "actor:owner", sessionId: "session:owner", clientId: "client:test", authorizationEpoch: 1 };
  const snapshot = emptyAuthorityPlaneSnapshot(promotionSession.realmId);
  const projectId = "project:authority-sqlite-promotion";
  const sourceSpaceId = "source:authority-sqlite-promotion";
  const projectRevisionId = "project-revision:authority-sqlite-promotion";
  const artifactId = "artifact:authority-sqlite-promotion";
  const releaseId = "release:authority-sqlite-promotion";
  const targetId = "target:authority-sqlite-promotion";
  const promotionId = "promotion:authority-sqlite-promotion";
  const executionIdempotencyKey = "execute:authority-sqlite-promotion";
  snapshot.projects[projectId] = { protocol: CONTRACT_VERSIONS.project, id: projectId, name: "SQLite Promotion", referenceType: "git", sourceSpaceIds: [sourceSpaceId] };
  snapshot.sourceSpaces[sourceSpaceId] = { protocol: CONTRACT_VERSIONS.sourceSpace, id: sourceSpaceId, name: "SQLite promotion source", classification: "internal" };
  snapshot.projectRevisions[projectRevisionId] = { protocol: CONTRACT_VERSIONS.kernel, id: projectRevisionId, projectId, sourceSpaceSnapshots: { [sourceSpaceId]: "git:authority-sqlite-promotion" } };
  snapshot.canonicalByProject[projectId] = projectRevisionId;
  snapshot.artifacts[artifactId] = { protocol: CONTRACT_VERSIONS.artifact, id: artifactId, type: "cli.archive", digest: "sha256:authority-sqlite-artifact", projectRevisionId };
  snapshot.releases[releaseId] = { protocol: CONTRACT_VERSIONS.release, id: releaseId, projectRevisionId, artifactIds: [artifactId], evidenceIds: [], configurationDigests: ["sha256:authority-sqlite-configuration"], stateAssumptions: [], policyVersion: "policy:authority-sqlite", status: "ready" };
  snapshot.targets[targetId] = { protocol: CONTRACT_VERSIONS.target, id: targetId, projectId, name: "SQLite promotion target", adapterId: "adapter:authority-sqlite", acceptedArtifactTypes: ["cli.archive"], requiredEvidenceKeys: [], state: "configured", currentReleaseId: null, releaseHistory: [] };
  snapshot.promotions[promotionId] = { protocol: CONTRACT_VERSIONS.promotion, id: promotionId, projectId, targetId, releaseId, releaseDigest: "declared:authority-sqlite", previousReleaseId: null, expectedCurrentReleaseId: null, state: "blocked", attempt: 0, kind: "promotion", idempotencyKey: "request:authority-sqlite", actor: { principalId: promotionSession.principalId, actorId: promotionSession.actorId, sessionId: promotionSession.sessionId, clientId: promotionSession.clientId }, createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z", receipt: "promotion=blocked" };
  return { snapshot, promotionId, executionIdempotencyKey, session: promotionSession };
}

function healthyPromotionExecutor(): { execute(context: Readonly<PromotionExecutionContext>): Promise<PromotionExecutionResult> } {
  return {
    async execute(context) {
      return {
        protocol: PROMOTION_EXECUTION_PROTOCOL,
        status: "succeeded",
        adapterId: context.target.adapterId,
        executionDigest: context.executionDigest,
        promotion: { ...context.promotion, state: "healthy", attempt: context.promotion.attempt + 1, providerOperationId: "provider-operation:authority-sqlite", receipt: "provider=qualification; operation=healthy; release-bound=true" },
        target: { id: context.target.id, projectId: context.project.id, state: "healthy", currentReleaseId: context.release.id, releaseHistory: [...(context.target.releaseHistory ?? []), context.release.id] },
        checkpoint: { idempotencyKey: context.executionIdempotencyKey, attempt: context.promotion.attempt + 1, stage: "complete", providerOperationIds: ["provider-operation:authority-sqlite"], receipt: "checkpoint=provider-complete" },
        receipt: "provider=qualification; release-bound=true",
      };
    },
  };
}

test("SQLite preserves immutable Promotion execution results through reconciliation and replay", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const persistence = store(database);
    const { snapshot, promotionId, executionIdempotencyKey, session } = promotionFixture();
    persistence.replace(snapshot);
    const firstCoordinator = new AuthorityPlaneCoordinator(snapshot);
    const first = await firstCoordinator.executePromotion({ promotionId, executionIdempotencyKey, executor: { execute: async () => { throw new Error("transport timeout after provider apply"); } }, session });
    assert.equal(first.status, "indeterminate");
    const afterFirst = firstCoordinator.snapshot();
    persistence.commit(snapshot, afterFirst);
    const originalKey = `promotion.execute:${executionIdempotencyKey}`;
    const originalExecutionResult = afterFirst.idempotency[originalKey];
    assert.ok(originalExecutionResult);

    const restarted = new AuthorityPlaneCoordinator(persistence.load(session.realmId)!);
    const reconciled = await restarted.reconcilePromotion({ promotionId, reconciliationIdempotencyKey: "reconcile:authority-sqlite", executor: healthyPromotionExecutor(), session });
    assert.equal(reconciled.status, "succeeded");
    const afterReconciliation = restarted.snapshot();
    assert.deepEqual(afterReconciliation.idempotency[originalKey], originalExecutionResult, "reconciliation must not rewrite the original execution result");
    assert.ok(afterReconciliation.idempotency["promotion.reconcile:reconcile:authority-sqlite"]);
    assert.doesNotThrow(() => persistence.commit(afterFirst, afterReconciliation));

    const restored = persistence.load(session.realmId)!;
    const replayCoordinator = new AuthorityPlaneCoordinator(restored);
    const replayed = await replayCoordinator.reconcilePromotion({ promotionId, reconciliationIdempotencyKey: "reconcile:authority-sqlite", executor: { execute: async () => { throw new Error("replay must not invoke provider"); } }, session });
    assert.equal(replayed.status, "succeeded");
    assert.equal(replayed.version, restored.version);
    assert.doesNotThrow(() => persistence.commit(restored, replayCoordinator.snapshot()), "reconciliation replay must be a persisted no-op");
    assert.deepEqual(persistence.load(session.realmId)?.idempotency[originalKey], originalExecutionResult);
  } finally {
    database.close();
  }
});

test("AuthoritySQLiteStore aborts a row transaction and preserves the prior version", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const persistence = store(database);
    const empty = emptyAuthorityPlaneSnapshot(session.realmId);
    persistence.replace(empty);
    const coordinator = new AuthorityPlaneCoordinator(empty);
    command(coordinator, "project:create", { projectId: "project:sqlite", name: "SQLite", referenceType: "git", sourceSpaces: [{ id: "source:sqlite", name: "SQLite source", classification: "internal", snapshotId: "snapshot:base" }], projectRevisionId: "revision:base" });
    const next = coordinator.snapshot();
    persistence.commit(empty, next);
    assert.throws(() => persistence.commit(next, { ...next, version: 2, audit: [{ ...next.audit[0]!, receipt: "tampered" }] }));
    const restored = persistence.load(session.realmId);
    assert.ok(restored);
    assert.equal(restored.version, 1);
    assert.equal(restored.audit.length, 1);
  } finally {
    database.close();
  }
});

test("SQLite Authority growth continues beyond the legacy JSON value tripwire and records latency receipts", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const persistence = store(database);
    let snapshot: AuthorityPlaneSnapshot = emptyAuthorityPlaneSnapshot(session.realmId);
    const oversizedName = "x".repeat(900);
    let index = 0;
    while (authoritySnapshotJsonBytes(snapshot) <= AUTHORITY_LEGACY_JSON_VALUE_TRIPWIRE_BYTES + 32_768) {
      const projectId = "project:growth:" + index;
      snapshot = { ...snapshot, version: snapshot.version + 1, projects: { ...snapshot.projects, [projectId]: { protocol: "anyam.project/v1", id: projectId, name: oversizedName, referenceType: "git", sourceSpaceIds: [] } } };
      index += 1;
    }
    persistence.replace(emptyAuthorityPlaneSnapshot(session.realmId));
    persistence.replace(snapshot);
    assert.ok(authoritySnapshotJsonBytes(snapshot) > AUTHORITY_LEGACY_JSON_VALUE_TRIPWIRE_BYTES);
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
    const receipt = authorityCommandLatencyReceipt(samples);
    assert.match(receipt, /samples=32; p50Ms=[0-9.]+; p95Ms=[0-9.]+; p99Ms=[0-9.]+/u);
    assert.equal(persistence.load(session.realmId)?.projects["project:post-tripwire:31"]?.name, "post-tripwire");
  } finally {
    database.close();
  }
});
