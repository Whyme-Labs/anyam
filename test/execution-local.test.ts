import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  LocalExecutionCache,
  LocalExecutionEngine,
  LocalExecutionError,
  normalizeProjectManifest,
  runLocalRelease,
  type LocalExecutionContext,
} from "../src/execution/local.ts";
import { EvidenceLedger, evaluateStageGate } from "../src/kernel/evidence.ts";

const fixtureRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));

function context(directory: string, targetId: string): LocalExecutionContext {
  return {
    directory,
    projectRevisionId: "project-revision:fixture:v1",
    projectViewId: "project-view:fixture:project",
    sourceSpaceSnapshots: { fixture: "snapshot:fixture:v1" },
    actor: {
      principalId: "principal:test",
      actorId: "actor:test",
      sessionId: "session:test",
      clientId: "client:test",
    },
    runnerId: "runner:local",
    policyVersion: "policy:release:v1",
    authorizationEpoch: "epoch:fixture:v1",
    capabilityGrantId: "grant:fixture",
    dependencyDigest: "sha256:dependencies:v1",
    toolchainDigest: "sha256:toolchain:v1",
    environmentDigest: "sha256:environment:v1",
    disclosure: { projectionId: "project-view:fixture:project", classification: "project" },
    owner: "execution maintainer",
    changeRevisionId: "change-revision:fixture:v1",
    workspaceId: "workspace:fixture:v1",
    targetId,
    declaredEffects: ["artifact.create"],
  };
}

async function copyFixture(id: "worker" | "typescript-library"): Promise<{ directory: string; manifest: unknown }> {
  const directory = await mkdtemp(join(tmpdir(), "anyam-execution-" + id + "-"));
  await cp(join(fixtureRoot, id), directory, { recursive: true });
  const manifest = JSON.parse(await readFile(join(directory, "anyam.json"), "utf8")) as unknown;
  return { directory, manifest };
}

test("normalizes portable Actions and Verifiers without dropping unknown manifest fields", () => {
  const manifest = {
    schema: "anyam.project/v1",
    id: "project:test",
    name: "Manifest test",
    referenceType: "typescript-library",
    sourceSpaceIds: ["source:test"],
    source: { root: ".", provenance: "test" },
    modules: [{
      id: "module:test",
      root: ".",
      dependencies: [],
      actions: [{
        id: "action:test",
        command: "node -e \"process.exit(0)\"",
        inputs: ["src/**/*.ts"],
        outputs: [],
        network: [],
        resources: { cpu: "declared" },
      }],
      artifactTypes: ["package.archive"],
    }],
    verifiers: [{
      id: "verifier:test",
      actionId: "action:test",
      disclosure: "full",
      requiredFor: ["release"],
    }],
    targets: [{
      id: "target:test",
      adapter: "generic.release-assets",
      accepts: ["package.archive"],
      requiredCapabilities: [],
    }],
    extension: { owner: "test" },
  };

  const normalized = normalizeProjectManifest(manifest);
  assert.equal(normalized.schema, "anyam.project/v1");
  assert.deepEqual(normalized.source, { root: ".", provenance: "test" });
  assert.equal(normalized.actions[0]?.protocol, "anyam.action/v1");
  assert.equal(normalized.actions[0]?.moduleRoot, ".");
  assert.deepEqual(normalized.actions[0]?.dependencyIds, []);
  assert.match(normalized.actions[0]?.contractDigest ?? "", /^sha256:/);
  assert.equal(normalized.verifiers[0]?.protocol, "anyam.verifier/v1");
  assert.match(normalized.verifiers[0]?.contractDigest ?? "", /^sha256:/);
  assert.deepEqual(normalized.targets[0]?.acceptedArtifactTypes, ["package.archive"]);
  assert.deepEqual(normalized.warnings, ["unknown manifest field preserved in digest: extension"]);

  assert.throws(
    () => normalizeProjectManifest({
      ...manifest,
      modules: [{
        ...manifest.modules[0],
        actions: [{ ...manifest.modules[0]!.actions[0], inputs: ["../private.ts"] }],
      }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof LocalExecutionError);
      assert.equal(error.code, "action-input-invalid");
      assert.match(error.message, /relative path or glob/);
      assert.match(error.recoveryAction, /Project directory/);
      return true;
    },
  );
});

for (const fixture of [
  { id: "worker" as const, targetId: "target:worker", artifactType: "worker.bundle" },
  { id: "typescript-library" as const, targetId: "target:library", artifactType: "package.archive" },
]) {
  test(fixture.id + " fixture produces typed Artifacts and an inspectable Evidence-backed Release", async () => {
    const copied = await copyFixture(fixture.id);
    try {
      const result = await runLocalRelease({
        manifest: copied.manifest,
        context: context(copied.directory, fixture.targetId),
        releaseName: fixture.id + "-release-v1",
      });

      assert.equal(result.gate.status, "ready");
      assert.equal(result.release.status, "ready");
      assert.equal(result.artifacts.length, 1);
      assert.equal(result.artifacts[0]?.type, fixture.artifactType);
      assert.equal(result.release.artifactIds[0], result.artifacts[0]?.id);
      assert.equal(result.release.evidenceIds.length, result.evidence.length);
      assert.equal(result.release.receipt?.includes("status=ready"), true);
      assert.equal(result.runs.length, 2);
      assert.equal(result.evidence.length, 2);
      assert.ok(result.runs.every((run) => run.status === "succeeded" && run.runnerId === "runner:local"));
      assert.ok(result.runs.every((run) => run.inputDigests?.length && run.outputDigests));
      assert.ok(result.evidence.every((record) => record.actionContractDigest?.startsWith("sha256:")));
      assert.ok(result.evidence.every((record) => (
        record.outcome === "passed"
        && record.projectRevisionId === "project-revision:fixture:v1"
        && record.changeRevisionId === "change-revision:fixture:v1"
        && record.targetId === fixture.targetId
        && record.sourceSpaceSnapshots?.fixture === "snapshot:fixture:v1"
        && record.actor.actorId === "actor:test"
        && record.receipt.includes("runner=runner:local")
      )));
      assert.ok(result.runs.every((run) => run.outputDigest?.startsWith("sha256:")));
      assert.ok(result.artifacts.every((artifact) => (
        artifact.projectRevisionId === "project-revision:fixture:v1"
        && artifact.changeRevisionId === "change-revision:fixture:v1"
        && artifact.runId
        && artifact.actionId === "action:build"
        && artifact.outputPath
        && artifact.provenanceDigest?.startsWith("sha256:")
      )));
      assert.equal(JSON.stringify(result.release).includes("evidenceIds"), true);
    } finally {
      await rm(copied.directory, { recursive: true, force: true });
    }
  });
}

test("reuses a result only for the complete validity key and reattaches cached Evidence to a new ledger", async () => {
  const copied = await copyFixture("worker");
  try {
    const manifest = normalizeProjectManifest(copied.manifest);
    const cache = new LocalExecutionCache();
    const ledger = new EvidenceLedger();
    const firstEngine = new LocalExecutionEngine({
      manifest,
      context: context(copied.directory, "target:worker"),
      cache,
      ledger,
    });
    const first = await firstEngine.runAction({ actionId: "action:build" });
    const second = await firstEngine.runAction({ actionId: "action:build" });
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(second.validityKey, first.validityKey);
    assert.equal(first.runnerInput.action.id, "action:build");
    assert.equal(first.runnerInput.runnerId, "runner:local");
    assert.equal(first.runnerOutput.status, "succeeded");
    assert.equal(first.runnerOutput.outputDigest, first.run.outputDigest);
    assert.equal(ledger.list().length, 1);

    const changed = await new LocalExecutionEngine({
      manifest,
      context: { ...context(copied.directory, "target:worker"), dependencyDigest: "sha256:dependencies:v2" },
      cache,
      ledger,
    }).runAction({ actionId: "action:build" });
    assert.equal(changed.cacheHit, false);
    assert.notEqual(changed.validityKey, first.validityKey);
    assert.equal(ledger.list().length, 2);

    const freshLedger = new EvidenceLedger();
    const cachedWithFreshLedger = await new LocalExecutionEngine({
      manifest,
      context: context(copied.directory, "target:worker"),
      cache,
      ledger: freshLedger,
    }).runAction({ actionId: "action:build" });
    assert.equal(cachedWithFreshLedger.cacheHit, true);
    assert.equal(freshLedger.list().length, 1);
    assert.equal(freshLedger.list()[0]?.id, first.evidence.id);
  } finally {
    await rm(copied.directory, { recursive: true, force: true });
  }
});

test("failed local Actions and stale or indeterminate Evidence block a Release gate", async () => {
  const copied = await copyFixture("worker");
  try {
    const original = copied.manifest as {
      modules: readonly Record<string, unknown>[];
    } & Record<string, unknown>;
    const failingManifest = {
      ...original,
      modules: original.modules.map((module) => ({
        ...module,
        actions: (module.actions as readonly Record<string, unknown>[]).map((action) => action.id === "action:check"
          ? { ...action, command: "node -e \"process.exit(7)\"" }
          : action),
      })),
    };
    const failed = await runLocalRelease({
      manifest: failingManifest,
      context: context(copied.directory, "target:worker"),
      releaseName: "worker-failed-release",
    });
    assert.equal(failed.release.status, "draft");
    assert.equal(failed.gate.status, "blocked");
    assert.ok(failed.gate.blockers.some((blocker) => blocker.kind === "failed"));
    assert.match(failed.evidence.find((record) => record.key.includes("action:check"))?.receipt ?? "", /exit-code=7/);

    const passed = failed.evidence.find((record) => record.key.includes("action:build"));
    assert.ok(passed);
    const { protocol: _protocol, version: _version, ...staleInput } = passed;
    const staleLedger = new EvidenceLedger();
    staleLedger.append({
      ...staleInput,
      id: "evidence:stale",
      outcome: "passed",
      validityKey: "sha256:old",
    });
    staleLedger.append({
      ...staleInput,
      id: "evidence:indeterminate",
      key: "action:indeterminate",
      outcome: "indeterminate",
      validityKey: "sha256:current",
      receipt: "runner=local; result=unknown",
    });
    const gate = evaluateStageGate({
      gateId: "release:failure-fixture",
      requiredEvidence: [
        {
          key: passed.key,
          currentValidityKey: "sha256:current",
          expectedProjectRevisionId: passed.projectRevisionId,
          ...(passed.changeRevisionId ? { expectedChangeRevisionId: passed.changeRevisionId } : {}),
          ...(passed.targetId ? { expectedTargetId: passed.targetId } : {}),
        },
        { key: "action:indeterminate", currentValidityKey: "sha256:current" },
        { key: "action:missing", currentValidityKey: "sha256:current" },
      ],
      evidence: staleLedger.list(),
    });
    assert.equal(gate.status, "blocked");
    assert.deepEqual(gate.blockers.map((blocker) => blocker.kind), ["stale", "indeterminate", "missing"]);
  } finally {
    await rm(copied.directory, { recursive: true, force: true });
  }
});
