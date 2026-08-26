import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto";
import test from "node:test";

import {
  authorityExportDigest,
  authorityExportSigningMessage,
  externalAttestationSigningMessage,
  type RealTeamAuthorityExport,
  type RealTeamExternalAttestation,
} from "../src/qualification/real-team-proof.ts";
import { validateRealTeamGate, type RealTeamGateVerificationOptions } from "../src/qualification/real-team-gate.ts";

const NOW = Date.parse("2026-02-02T00:00:00.000Z");
const TRIAL_TIME = "2026-01-15T00:00:00.000Z";
const AUTHORITY_KEY_ID = "authority:key:v1";
const ATTESTATION_KEY_ID = "attestation:key:v1";
const EXTERNAL_REVIEWER = "reviewer:external-security-lab";
const REPORT_DIGEST = `sha256:${"a".repeat(64)}`;

function base64Url(value: Buffer): string {
  return value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function publicKeyPem(key: KeyObject): string {
  return String(key.export({ type: "spki", format: "pem" }));
}

function signMessage(key: KeyObject, message: string): string {
  return base64Url(signBytes(null, Buffer.from(message), key));
}

function receipt(owner = "human:1") {
  return { status: "verified" as const, receipt: "fixture=validator-only; credentialMaterialStored=false", observedAt: TRIAL_TIME, owner, nextAction: "retain the immutable receipt" };
}

async function completeFixture(): Promise<{ evidence: Record<string, unknown>; options: RealTeamGateVerificationOptions }> {
  const authorityKeys = generateKeyPairSync("ed25519");
  const attestationKeys = generateKeyPairSync("ed25519");
  const changes: Record<string, Record<string, unknown>> = {};
  const revisions: Record<string, Record<string, unknown>> = {};
  const landings: Record<string, Record<string, unknown>> = {};
  const audit: Array<Record<string, unknown>> = [];
  const terminalChanges: Array<Record<string, string>> = [];
  for (let index = 0; index < 25; index += 1) {
    const changeId = `change:${index}`;
    const revisionId = `revision:${index}`;
    const auditEventId = `audit:${index}`;
    const landingId = `landing:${index}`;
    changes[changeId] = { id: changeId, projectId: "project:unit", status: "landed", latestRevisionId: revisionId };
    revisions[revisionId] = { id: revisionId, changeId };
    landings[landingId] = { id: landingId, changeId, changeRevisionId: revisionId };
    audit.push({ id: auditEventId, command: "landing.apply", occurredAt: TRIAL_TIME, receipt: `landing=${landingId}; change=${changeId}; credentialMaterialStored=false` });
    terminalChanges.push({ changeId, terminalState: "landed", auditEventId, revisionId });
  }
  const provider = { targetId: "target:unit:staging", releaseId: "release:unit:1", operationId: "operation:unit:1", providerVersionId: "version:unit:1", deploymentId: "deployment:unit:1" };
  const snapshot: Record<string, unknown> = { protocol: "anyam.authority-plane/v1", realmId: "realm:unit", version: 25, projects: { "project:unit": { id: "project:unit" } }, changes, changeRevisions: revisions, landings, promotions: { "promotion:unit:1": { id: "promotion:unit:1", targetId: provider.targetId, releaseId: provider.releaseId, providerOperationId: provider.operationId, deploymentId: provider.deploymentId, receipt: `providerVersionId=${provider.providerVersionId}` } }, audit };
  const exportDigest = await authorityExportDigest(snapshot);
  const unsignedExport: Omit<RealTeamAuthorityExport, "signature"> = { protocol: "anyam.real-team-authority-export/v1", cohortId: "cohort:unit", realmId: "realm:unit", exportDigest, signingKeyId: AUTHORITY_KEY_ID, exportedAt: TRIAL_TIME, snapshot };
  const authorityExport: RealTeamAuthorityExport = { ...unsignedExport, signature: signMessage(authorityKeys.privateKey, authorityExportSigningMessage(unsignedExport)) };
  const unsignedAttestation: Omit<RealTeamExternalAttestation, "signature"> = { protocol: "anyam.real-team-external-attestation/v1", attestationId: "attestation:security:unit", cohortId: "cohort:unit", realmId: "realm:unit", kind: "independent-security-review", reviewerId: EXTERNAL_REVIEWER, reviewerOrganization: "External Security Lab", reportDigest: REPORT_DIGEST, signingKeyId: ATTESTATION_KEY_ID, signedAt: TRIAL_TIME };
  const attestation: RealTeamExternalAttestation = { ...unsignedAttestation, signature: signMessage(attestationKeys.privateKey, externalAttestationSigningMessage(unsignedAttestation)) };
  const scenarios = { ordinaryGit: receipt(), concurrentWorkspaces: receipt(), intentLifecycle: receipt(), pullRequestLifecycle: receipt(), reviewAndLanding: receipt(), conflictAndRebase: receipt(), hybridProjection: receipt(), bidirectionalGitHub: receipt(), exportRestore: receipt(), noCanonicalWrite: receipt() };
  const operations = { sustainedLoad: receipt(), queueRecovery: receipt(), durableObjectContention: receipt(), backupRestoreRpoRto: receipt(), authenticationThrottling: receipt(), keyRotation: receipt(), incidentAlerting: receipt(), independentSecurityReview: { ...receipt(), receipt: `fixture=independent-review; attestationId=${unsignedAttestation.attestationId}; reviewerId=${EXTERNAL_REVIEWER}; reportDigest=${REPORT_DIGEST}; credentialMaterialStored=false` } };
  const evidence = { protocol: "anyam.real-team-adoption-gate/v1", cohort: { id: "cohort:unit", realmId: "realm:unit", hostingMode: "customer-operated", canonicalAuthority: "anyam", humanParticipantIds: ["human:1", "human:2", "human:3"], agentProducts: ["codex", "claude-code"], startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-02-01T00:00:00.000Z" }, authorityExport, terminalChanges, changes: { terminalCount: 25, changeIds: terminalChanges.map((entry) => entry.changeId) }, scenarios, provider: { workerReleaseTarget: { ...receipt(), ...provider, provider: "cloudflare-workers", receipt: `provider=cloudflare-workers; targetId=${provider.targetId}; releaseId=${provider.releaseId}; operationId=${provider.operationId}; providerVersionId=${provider.providerVersionId}; deploymentId=${provider.deploymentId}; credentialMaterialStored=false` } }, externalAttestations: [attestation], operations, retentionDecision: { decision: "continue", recordedAt: "2026-02-01T00:00:00.000Z", owner: "human:1", receipt: "fixture=retention; credentialMaterialStored=false", nextAction: "continue" } };
  return { evidence, options: { authoritySigningKeys: { [AUTHORITY_KEY_ID]: publicKeyPem(authorityKeys.publicKey) }, attestationSigningKeys: { [ATTESTATION_KEY_ID]: publicKeyPem(attestationKeys.publicKey) }, now: () => NOW } };
}

test("real-team gate accepts only a cryptographically verified complete evidence bundle", async () => {
  const fixture = await completeFixture();
  const result = await validateRealTeamGate(fixture.evidence, fixture.options);
  assert.equal(result.status, "ready");
  assert.equal(result.blockers.length, 0);
  assert.equal(result.summary.verification, "cryptographically-verified");
  assert.equal(result.summary.verifiedScenarioCount, 10);
  assert.equal(result.summary.verifiedOperationsCount, 8);
});

test("synthetic checklist JSON is manual-review-only and can never be ready", async () => {
  const result = await validateRealTeamGate({ protocol: "anyam.real-team-adoption-gate/v1" }, { now: () => NOW });
  assert.equal(result.status, "blocked");
  assert.equal(result.summary.verification, "manual-review-only");
  assert.match(result.receipt, /verification=manual-review-only/u);
  assert.ok(result.blockers.some((blocker) => blocker.key === "authorityExport"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "externalAttestations"));
});

test("a complete unsigned bundle stays manual-review-only until both trusted keyrings are configured", async () => {
  const fixture = await completeFixture();
  const result = await validateRealTeamGate(fixture.evidence, { now: () => NOW });
  assert.equal(result.status, "blocked");
  assert.equal(result.summary.verification, "manual-review-only");
  assert.ok(result.blockers.some((blocker) => blocker.key === "authorityExport.signature.trust"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "externalAttestations[0].signature.trust"));
});

test("real-team gate remains blocked for missing human, provider, operations, retention, and signed proof", async () => {
  const result = await validateRealTeamGate({ protocol: "anyam.real-team-adoption-gate/v1" }, { now: () => NOW });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((blocker) => blocker.key === "cohort.humanParticipantIds"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "provider.workerReleaseTarget"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "operations.sustainedLoad"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "retentionDecision"));
});

test("real-team gate rejects credential-like receipts and a short trial even with signed proof", async () => {
  const fixture = await completeFixture();
  const cohort = fixture.evidence.cohort as Record<string, unknown>;
  cohort.endedAt = "2026-01-10T00:00:00.000Z";
  const scenarios = fixture.evidence.scenarios as Record<string, Record<string, unknown>>;
  scenarios.ordinaryGit!.receipt = "providerToken=must-not-persist";
  const result = await validateRealTeamGate(fixture.evidence, fixture.options);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((blocker) => blocker.key === "cohort.trialWindow"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "scenarios.ordinaryGit"));
});

test("real-team gate rejects duplicate identities and inconsistent terminal Change counts", async () => {
  const fixture = await completeFixture();
  const cohort = fixture.evidence.cohort as Record<string, unknown>;
  cohort.humanParticipantIds = ["human:1", "human:1", "human:2"];
  const changes = fixture.evidence.changes as Record<string, unknown>;
  changes.terminalCount = 25;
  changes.changeIds = Array.from({ length: 25 }, () => "change:duplicate");
  const result = await validateRealTeamGate(fixture.evidence, fixture.options);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((blocker) => blocker.key === "cohort.humanParticipantIds.unique"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "changes.changeIds.unique"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "terminalChanges.extra"));
});

test("real-team gate rejects future, malformed, and out-of-window evidence timestamps", async () => {
  const future = await completeFixture();
  const futureCohort = future.evidence.cohort as Record<string, unknown>;
  futureCohort.endedAt = new Date(NOW + 86_400_000).toISOString();
  const futureResult = await validateRealTeamGate(future.evidence, future.options);
  assert.ok(futureResult.blockers.some((blocker) => blocker.key === "cohort.endedAt.future"));

  const malformed = await completeFixture();
  const malformedScenarios = malformed.evidence.scenarios as Record<string, Record<string, unknown>>;
  malformedScenarios.ordinaryGit!.observedAt = "not-a-timestamp";
  const malformedResult = await validateRealTeamGate(malformed.evidence, malformed.options);
  assert.ok(malformedResult.blockers.some((blocker) => blocker.key === "scenarios.ordinaryGit.observedAt"));

  const outside = await completeFixture();
  const outsideScenarios = outside.evidence.scenarios as Record<string, Record<string, unknown>>;
  outsideScenarios.ordinaryGit!.observedAt = "2026-03-01T00:00:00.000Z";
  const outsideResult = await validateRealTeamGate(outside.evidence, outside.options);
  assert.ok(outsideResult.blockers.some((blocker) => blocker.key === "scenarios.ordinaryGit.observedAt.window"));
});

test("real-team gate rejects forged, stale, mismatched, and replayed external attestations", async () => {
  const forged = await completeFixture();
  const forgedAttestation = forged.evidence.externalAttestations as Array<Record<string, unknown>>;
  forgedAttestation[0]!.signature = "invalid";
  const forgedResult = await validateRealTeamGate(forged.evidence, forged.options);
  assert.ok(forgedResult.blockers.some((blocker) => blocker.key === "externalAttestations[0].signature"));

  const replayed = await completeFixture();
  const replayAttestations = replayed.evidence.externalAttestations as Array<Record<string, unknown>>;
  replayAttestations.push({ ...replayAttestations[0] });
  const replayedResult = await validateRealTeamGate(replayed.evidence, replayed.options);
  assert.ok(replayedResult.blockers.some((blocker) => blocker.key === "externalAttestations[1].replay"));

  const mismatched = await completeFixture();
  const mismatchAttestation = mismatched.evidence.externalAttestations as Array<Record<string, unknown>>;
  mismatchAttestation[0]!.cohortId = "cohort:other";
  const mismatchedResult = await validateRealTeamGate(mismatched.evidence, mismatched.options);
  assert.ok(mismatchedResult.blockers.some((blocker) => blocker.key === "externalAttestations[0].cohortId"));
  assert.ok(mismatchedResult.blockers.some((blocker) => blocker.key === "externalAttestations[0].signature"));

  const stale = await completeFixture();
  const staleAttestation = stale.evidence.externalAttestations as Array<Record<string, unknown>>;
  staleAttestation[0]!.signedAt = "2025-12-01T00:00:00.000Z";
  const staleResult = await validateRealTeamGate(stale.evidence, stale.options);
  assert.ok(staleResult.blockers.some((blocker) => blocker.key === "externalAttestations[0].signedAt.window"));
});

test("real-team gate rejects invented terminal IDs and provider identities", async () => {
  const fixture = await completeFixture();
  const changes = fixture.evidence.changes as Record<string, unknown>;
  const ids = changes.changeIds as string[];
  ids[0] = "change:invented";
  const provider = fixture.evidence.provider as Record<string, Record<string, unknown>>;
  provider.workerReleaseTarget!.operationId = "operation:invented";
  const result = await validateRealTeamGate(fixture.evidence, fixture.options);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((blocker) => blocker.key === "terminalChanges.missing"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "terminalChanges.extra"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "provider.workerReleaseTarget.receipt.operationId"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "provider.workerReleaseTarget.authorityBinding"));
});

test("real-team gate binds provider and receipt owners to the named cohort", async () => {
  const fixture = await completeFixture();
  const provider = fixture.evidence.provider as Record<string, Record<string, unknown>>;
  provider.workerReleaseTarget!.provider = "github-actions";
  provider.workerReleaseTarget!.owner = "unlisted:provider";
  const operations = fixture.evidence.operations as Record<string, Record<string, unknown>>;
  operations.sustainedLoad!.owner = "unlisted:operator";
  const result = await validateRealTeamGate(fixture.evidence, fixture.options);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((blocker) => blocker.key === "provider.workerReleaseTarget.provider"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "provider.workerReleaseTarget.owner"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "operations.sustainedLoad.owner"));
});
