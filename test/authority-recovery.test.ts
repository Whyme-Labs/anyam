import assert from "node:assert/strict";
import test from "node:test";

import { emptyAuthorityPlaneSnapshot, type AuthorityAuditEvent } from "../src/cloudflare/authority-plane.ts";
import { AUTHORITY_RECOVERY_SNAPSHOT_FIELDS, createAuthorityRecoveryBundle, verifyAuthorityRecoveryBundle } from "../src/cloudflare/authority-recovery.ts";

test("Authority recovery field contract covers every exported snapshot field", () => {
  const snapshotFields = Object.keys(emptyAuthorityPlaneSnapshot("realm:recovery-fields"));
  assert.deepEqual([...AUTHORITY_RECOVERY_SNAPSHOT_FIELDS].sort(), snapshotFields.sort());
});

test("Authority recovery bundles bind the snapshot, audit chain, Realm, and recovery key", async () => {
  const snapshot = emptyAuthorityPlaneSnapshot("realm:recovery-test");
  snapshot.version = 4;
  snapshot.audit.push({ id: "audit:recovery-test", command: "project.create", idempotencyKey: "idempotency:recovery-test", actor: { principalId: "principal:owner", actorId: "actor:owner", sessionId: "session:owner", clientId: "client:owner" }, outcome: "succeeded", stateVersion: 4, occurredAt: "2026-08-21T00:00:00.000Z", receipt: "fixture=authority-recovery" } satisfies AuthorityAuditEvent);
  const bundle = await createAuthorityRecoveryBundle({ snapshot, bundleId: "bundle:recovery-test", recoveryKeyId: "key:recovery-v1", secret: "recovery-secret" });
  const verified = await verifyAuthorityRecoveryBundle({ value: bundle, realmId: snapshot.realmId, recoveryKeyId: "key:recovery-v1", secret: "recovery-secret" });
  assert.equal(verified.valid, true);
  if (verified.valid) assert.equal(verified.bundle.bundleDigest, bundle.bundleDigest);
});

test("Authority recovery rejects tampered snapshots, stale keys, and invalid signatures", async () => {
  const snapshot = emptyAuthorityPlaneSnapshot("realm:recovery-test");
  snapshot.audit.push({ id: "audit:recovery-test", command: "project.create", idempotencyKey: "idempotency:recovery-test", actor: { principalId: "principal:owner", actorId: "actor:owner", sessionId: "session:owner", clientId: "client:owner" }, outcome: "succeeded", stateVersion: 0, occurredAt: "2026-08-21T00:00:00.000Z", receipt: "fixture=authority-recovery" } satisfies AuthorityAuditEvent);
  const bundle = await createAuthorityRecoveryBundle({ snapshot, bundleId: "bundle:recovery-test", recoveryKeyId: "key:recovery-v1", secret: "recovery-secret" });
  const tampered = { ...bundle, snapshot: { ...bundle.snapshot, version: 99 } };
  const tamperResult = await verifyAuthorityRecoveryBundle({ value: tampered, realmId: snapshot.realmId, recoveryKeyId: "key:recovery-v1", secret: "recovery-secret" });
  assert.equal(tamperResult.valid, false);
  const wrongKey = await verifyAuthorityRecoveryBundle({ value: bundle, realmId: snapshot.realmId, recoveryKeyId: "key:recovery-v2", secret: "recovery-secret" });
  assert.equal(wrongKey.valid, false);
  const wrongSecret = await verifyAuthorityRecoveryBundle({ value: bundle, realmId: snapshot.realmId, recoveryKeyId: "key:recovery-v1", secret: "wrong-secret" });
  assert.equal(wrongSecret.valid, false);
  const truncatedAudit = { ...bundle, snapshot: { ...bundle.snapshot, audit: [] } };
  const auditResult = await verifyAuthorityRecoveryBundle({ value: truncatedAudit, realmId: snapshot.realmId, recoveryKeyId: "key:recovery-v1", secret: "recovery-secret" });
  assert.equal(auditResult.valid, false);
});
