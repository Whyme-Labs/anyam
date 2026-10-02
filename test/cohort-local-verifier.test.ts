import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SQLiteCohortLandingAuthority } from "../src/cloudflare/cohort-landing.ts";
import { executeLocalVerification, runLocalVerifierCohortQualification, verifierGitSources, type LocalVerificationObservation } from "./fixtures/cohort-local-verifier.ts";
import { cohortStore } from "./fixtures/cohort-sqlite.ts";
import { prepareCohort, projectId, session } from "./fixtures/reconciliation-project.ts";

const supported = process.platform === "darwin" || process.platform === "linux";

test("real isolated local verifiers feed signed Evidence into two durable Cohort Landings and partial projection recovery", { skip: supported ? false : "enforceable local Workspace backend unavailable" }, async () => {
  const report = await runLocalVerifierCohortQualification({ revision: "test-source", tree: "test-tree" });
  assert.equal(report.syntheticRecordedEvidence, false);
  assert.equal(report.executions.length, 4);
  for (const execution of report.executions) {
    assert.equal(execution.command.status, "passed");
    assert.equal(execution.command.exitCode, 0);
    assert.equal(execution.boundary.networkEnforcement, "deny-all");
    assert.equal(execution.materializedCommit, execution.candidateOid);
    assert.equal(execution.evidence.outcome, "passed");
    assert.equal(execution.evidence.producer.kind, "run");
    assert.equal(execution.evidence.runId, execution.completion.run.id);
    assert.deepEqual(execution.evidence.sourceSpaceSnapshots, execution.input.sourceSpaceSnapshots);
    assert.equal(Object.keys(execution.input.sourceSpaceSnapshots).length, 1, "each verifier sees only its member Source Space");
    assert.match(execution.evidence.receipt, /runnerSignature=verified/);
    assert.equal(execution.outputReadBack.length, 1);
    assert.equal(execution.outputReadBack[0]!.digest, execution.completion.outputs[0]!.digest);
    assert.equal(execution.completion.credentialState, "closed");
    assert.ok(!("credential" in execution.completion));
    assert.equal(JSON.parse(execution.command.stdout).sourceDigest, execution.input.inputDigests[0]!.split("=")[1]);
  }
  assert.equal(report.partial!.state, "pending");
  assert.equal(report.firstCompletion.state, "complete");
  assert.equal(report.secondCompletion.state, "complete");
  assert.ok(report.secondCompletion.epoch > report.firstCompletion.epoch);
  assert.equal(report.secondLanding.previousProjectRevisionId, report.firstLanding.projectRevisionId);
  assert.equal(report.originalLandingResultUnchanged, true);
  assert.equal(report.cleanup, "destroyed");
});

test("failed real verifier completion remains inspectable and cannot satisfy the Cohort gate", { skip: !supported }, async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-cohort-verifier-failed-"));
  const database = new DatabaseSync(join(root, "authority.sqlite"));
  try {
    const store = cohortStore(database);
    const source = verifierGitSources(root);
    const executions: LocalVerificationObservation[] = [];
    const cohort = await prepareCohort(store, "failed", source, source.revisions[0]!, async (selection) => {
      const execution = await executeLocalVerification({ store, source, root, selection });
      executions.push(execution);
      return execution.evidence;
    });
    assert.ok(executions.every((execution) => execution.evidence.outcome === "failed" && execution.command.exitCode !== 0 && execution.outputReadBack.length === 0));
    const before = store.load(session.realmId)!;
    assert.equal(Object.keys(before.evidence).length, 2);
    assert.throws(() => new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: cohort.evaluate }).landCohort(cohort.request), /fresh exact policy decision required/);
    assert.deepEqual(store.load(session.realmId), before);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("input drift after the immutable Runner assignment cannot be submitted as passing Evidence", { skip: !supported }, async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-cohort-verifier-drift-"));
  const database = new DatabaseSync(join(root, "authority.sqlite"));
  try {
    const store = cohortStore(database);
    const source = verifierGitSources(root);
    await assert.rejects(prepareCohort(store, "drift", source, source.revisions[1]!, async (selection) => {
      return (await executeLocalVerification({ store, source, root, selection, beforeExecution: (boundary) => writeFileSync(join(boundary.workspaceDirectory, "src/value.mjs"), "export function value() { return 0; }\n") })).evidence;
    }), /materialized input drift before execution/);
    const snapshot = store.load(session.realmId)!;
    assert.equal(Object.values(snapshot.runs)[0]!.status, "queued");
    assert.equal(Object.keys(snapshot.evidence).length, 0);
    assert.equal(Object.keys(snapshot.landings).length, 0);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("historical real signed Evidence cannot satisfy a different exact Cohort member", { skip: !supported }, async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-cohort-verifier-stale-"));
  const database = new DatabaseSync(join(root, "authority.sqlite"));
  try {
    const store = cohortStore(database);
    const source = verifierGitSources(root);
    const evidenceBySpace = new Map<string, LocalVerificationObservation["evidence"]>();
    await prepareCohort(store, "verified", source, source.revisions[1]!, async (selection) => {
      const execution = await executeLocalVerification({ store, source, root, selection });
      evidenceBySpace.set(selection.space, execution.evidence);
      return execution.evidence;
    });
    const later = await prepareCohort(store, "later", source, source.revisions[2]!, async (selection) => evidenceBySpace.get(selection.space)!);
    const before = store.load(session.realmId)!;
    assert.throws(() => new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: later.evaluate }).landCohort(later.request), /fresh exact policy decision required/);
    assert.deepEqual(store.load(session.realmId), before);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("real execution does not make a changed signed candidate context or output reference acceptable", { skip: !supported }, async () => {
  for (const mode of ["candidate", "output"] as const) {
    const root = mkdtempSync(join(tmpdir(), "anyam-cohort-verifier-tamper-"));
    const database = new DatabaseSync(join(root, "authority.sqlite"));
    try {
      const store = cohortStore(database);
      const source = verifierGitSources(root);
      await assert.rejects(prepareCohort(store, mode, source, source.revisions[1]!, async (selection) => {
        return (await executeLocalVerification({ store, source, root, selection, beforeConsumption: (completion) => {
          if (mode === "candidate") completion.result.context.sourceSpaceSnapshots = source.revisions[2]!;
          else completion.outputs[0]!.digest = "sha256:forged-output";
        } })).evidence;
      }), mode === "candidate" ? /context does not match/ : /outputs differ from the signed/);
      const snapshot = store.load(session.realmId)!;
      assert.equal(Object.values(snapshot.runs)[0]!.status, "queued");
      assert.equal(Object.keys(snapshot.evidence).length, 0);
      assert.equal(Object.keys(snapshot.artifacts).length, 0);
      assert.equal(Object.keys(snapshot.landings).length, 0);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
