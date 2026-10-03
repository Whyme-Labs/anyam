import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  LocalExecutionCache,
  LocalExecutionEngine,
  LocalExecutionError,
  createLocalReleasePlan,
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
      assert.match(result.release.inputSet?.inputClosureDigest ?? "", /^sha256:/);
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

test("exact Runner cache rereads raw output bytes and rebuilds same-size tampered artifacts", async () => {
  const copied = await copyFixture("worker");
  try {
    const engine = new LocalExecutionEngine({
      manifest: normalizeProjectManifest(copied.manifest),
      context: context(copied.directory, "target:worker"),
    });
    const first = await engine.runAction({ actionId: "action:build" });
    const original = structuredClone(first);
    const outputPath = join(copied.directory, "dist/worker.bundle");
    const expectedBytes = await readFile(join(copied.directory, "src/index.ts"));
    const tampered = Buffer.from(expectedBytes);
    tampered[0] = tampered[0]! ^ 1;
    await writeFile(outputPath, tampered);
    assert.equal(tampered.length, expectedBytes.length);
    const second = await engine.runAction({ actionId: "action:build" });
    assert.equal(second.cacheHit, false, "matching inputs and file size cannot authorize changed output bytes");
    assert.notEqual(second.run.id, first.run.id);
    assert.equal(second.evidence.outcome, "passed");
    assert.match(second.evidence.receipt, /cached-output-bytes=changed-or-missing/);
    assert.deepEqual(await readFile(outputPath), expectedBytes);
    assert.equal(second.artifacts[0]!.digest, `sha256:${createHash("sha256").update(expectedBytes).digest("hex")}`);
    assert.deepEqual(first, original, "original producing Evidence and provenance stay immutable");
  } finally {
    await rm(copied.directory, { recursive: true, force: true });
  }
});

test("exact Runner cache regenerates missing outputs and then reuses the new unchanged bytes", async () => {
  const copied = await copyFixture("worker");
  try {
    const engine = new LocalExecutionEngine({
      manifest: normalizeProjectManifest(copied.manifest),
      context: context(copied.directory, "target:worker"),
    });
    const first = await engine.runAction({ actionId: "action:build" });
    const outputPath = join(copied.directory, "dist/worker.bundle");
    await rm(outputPath);
    const second = await engine.runAction({ actionId: "action:build" });
    assert.equal(second.cacheHit, false);
    assert.notEqual(second.run.id, first.run.id);
    assert.match(second.evidence.receipt, /cached-output-bytes=changed-or-missing/);
    const bytes = await readFile(outputPath);
    assert.deepEqual(bytes, await readFile(join(copied.directory, "src/index.ts")));
    assert.equal(second.artifacts[0]!.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    const third = await engine.runAction({ actionId: "action:build" });
    assert.equal(third.cacheHit, true);
    assert.deepEqual(third, { ...second, cacheHit: true });
  } finally {
    await rm(copied.directory, { recursive: true, force: true });
  }
});

for (const damage of ["changed", "missing"] as const) {
  test(`reusable Runner cache falls back to actual execution for ${damage} output bytes across Revisions`, async () => {
    const copied = await copyFixture("worker");
    try {
      const cache = new LocalExecutionCache();
      const first = await runLocalRelease({
        manifest: copied.manifest,
        cache,
        context: context(copied.directory, "target:worker"),
        releaseName: "byte-cache-v1",
      });
      assert.equal(first.release.status, "ready");
      const original = structuredClone(first);
      const outputPath = join(copied.directory, "dist/worker.bundle");
      if (damage === "changed") {
        const bytes = await readFile(outputPath);
        bytes[0] = bytes[0]! ^ 1;
        await writeFile(outputPath, bytes);
      } else {
        await rm(outputPath);
      }
      const second = await runLocalRelease({
        manifest: copied.manifest,
        cache,
        changedPaths: [],
        context: { ...context(copied.directory, "target:worker"), projectRevisionId: "project-revision:fixture:v2" },
        releaseName: "byte-cache-v2",
      });
      assert.equal(second.release.status, "ready");
      assert.equal(second.gate.status, "ready");
      assert.deepEqual(second.plan.selectedActionIds, []);
      assert.deepEqual(second.plan.reusedActionIds, ["action:check"]);
      assert.deepEqual(second.plan.fallbackActionIds, ["action:build"]);
      assert.equal(second.cacheHits, 1);
      const check = second.evidence.find((record) => record.actionId === "action:check")!;
      const build = second.evidence.find((record) => record.actionId === "action:build")!;
      assert.equal(check.producer.kind, "attestation", "unaffected no-output Action remains reusable");
      assert.equal(build.producer.kind, "run", "damaged output requires actual execution, not a reuse attestation");
      assert.notEqual(build.runId, first.runs.find((run) => run.actionId === "action:build")!.id);
      assert.match(build.receipt, /cached-output-bytes=changed-or-missing/);
      const bytes = await readFile(outputPath);
      assert.deepEqual(bytes, await readFile(join(copied.directory, "src/index.ts")));
      assert.equal(second.artifacts[0]!.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      assert.equal(second.artifacts[0]!.projectRevisionId, "project-revision:fixture:v2");
      assert.deepEqual(first, original, "reuse invalidation preserves original Evidence and Artifact provenance");
    } finally {
      await rm(copied.directory, { recursive: true, force: true });
    }
  });
}

for (const buildVerifier of ["release-required", "optional", "absent"] as const) {
  test(`failed Runner cache regeneration with ${buildVerifier} Verifier blocks release readiness despite prior passed Evidence`, async () => {
    const copied = await copyFixture("worker");
    try {
      const raw = copied.manifest as { modules: readonly Record<string, unknown>[] } & Record<string, unknown>;
      const manifest = {
        ...raw,
        verifiers: (raw.verifiers as readonly Record<string, unknown>[]).flatMap((verifier) => {
          if (verifier.actionId !== "action:build" || buildVerifier === "release-required") return [verifier];
          return buildVerifier === "absent" ? [] : [{ ...verifier, requiredFor: [] }];
        }),
        modules: raw.modules.map((module) => ({
          ...module,
          actions: (module.actions as readonly Record<string, unknown>[]).map((action) => action.id === "action:build"
            ? { ...action, command: "node -e \"const fs=require('fs');if(fs.existsSync('.fail-build'))process.exit(9);fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('src/index.ts','dist/worker.bundle')\"" }
            : action),
        })),
      };
      const cache = new LocalExecutionCache();
      const ledger = new EvidenceLedger();
      const first = await runLocalRelease({
        manifest, cache, ledger, context: context(copied.directory, "target:worker"), releaseName: "byte-cache-passed",
      });
      assert.equal(first.release.status, "ready");
      const original = structuredClone(first);
      await rm(join(copied.directory, "dist/worker.bundle"));
      await writeFile(join(copied.directory, ".fail-build"), "fail the existing declared command\n");
      const second = await runLocalRelease({
        manifest, cache, ledger, context: context(copied.directory, "target:worker"), releaseName: "byte-cache-failed",
      });
      assert.equal(second.release.status, "draft");
      assert.equal(second.gate.status, "blocked");
      assert.ok(second.gate.blockers.some((blocker) => blocker.kind === "failed"));
      assert.equal(second.artifacts.length, 0);
      assert.equal(second.cacheHits, 1, "healthy no-output check retains exact cache reuse");
      const failedRun = second.runs.find((run) => run.actionId === "action:build")!;
      assert.equal(failedRun.status, "failed");
      assert.equal(failedRun.exitCode, 9);
      const records = ledger.list().filter((record) => record.actionId === "action:build");
      assert.deepEqual(records.map((record) => record.outcome), ["passed", "failed"]);
      assert.equal(records[0]!.validityKey, records[1]!.validityKey, "failure blocks the formerly passing exact validity key");
      assert.match(records[1]!.receipt, /cached-output-bytes=changed-or-missing/);
      assert.ok(second.release.evidenceIds.includes(records[1]!.id));
      assert.ok(!second.release.evidenceIds.includes(records[0]!.id));
      assert.deepEqual(first, original);
    } finally {
      await rm(copied.directory, { recursive: true, force: true });
    }
  });
}

test("Runner cache propagates unreadable output failures before returning old passed Evidence", async () => {
  const copied = await copyFixture("worker");
  try {
    const ledger = new EvidenceLedger();
    const engine = new LocalExecutionEngine({
      manifest: normalizeProjectManifest(copied.manifest),
      context: context(copied.directory, "target:worker"),
      ledger,
    });
    await engine.runAction({ actionId: "action:build" });
    const original = structuredClone(ledger.list());
    const outputPath = join(copied.directory, "dist/worker.bundle");
    await rm(outputPath);
    await mkdir(outputPath);
    await assert.rejects(engine.runAction({ actionId: "action:build" }), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "EISDIR");
      return true;
    });
    assert.deepEqual(ledger.list(), original, "storage failure cannot append a new passing cache receipt");
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

function graphManifest(): Record<string, unknown> {
  const action = (id: string, moduleId: string, input: string, output: string) => ({
    id,
    command: "node -e \"process.exit(0)\"",
    inputs: [input],
    outputs: output ? [output] : [],
    network: [],
    resources: {},
    moduleId,
  });
  return {
    schema: "anyam.project/v1",
    id: "project:graph",
    name: "Graph test",
    referenceType: "typescript-library",
    sourceSpaceIds: ["source:graph"],
    source: { root: ".", provenance: "test" },
    modules: [
      { id: "module:core", root: "core", dependencies: [], actions: [action("action:core", "module:core", "core/src/**/*.ts", "dist/core.out")], artifactTypes: ["core.output"] },
      { id: "module:app", root: "app", dependencies: ["module:core"], actions: [action("action:app", "module:app", "app/src/**/*.ts", "dist/app.out")], artifactTypes: ["app.output"] },
      { id: "module:docs", root: "docs", dependencies: [], actions: [action("action:docs", "module:docs", "docs/**/*.md", "dist/docs.out")], artifactTypes: ["docs.output"] },
    ],
    verifiers: [],
    targets: [{ id: "target:graph", adapter: "generic", accepts: ["core.output", "app.output", "docs.output"], requiredCapabilities: [] }],
  };
}

test("normalizes and plans a dependency closure, rejecting unknown and cyclic modules", () => {
  const manifest = normalizeProjectManifest(graphManifest());
  const plan = createLocalReleasePlan({ manifest, changedPaths: ["core/src/index.ts"] });
  assert.deepEqual(plan.directModuleIds, ["module:core"]);
  assert.deepEqual(plan.affectedModuleIds, ["module:core", "module:app"]);
  assert.deepEqual(plan.selectedActionIds, ["action:core", "action:app"]);
  assert.deepEqual(plan.skippedActionIds, ["action:docs"]);
  assert.match(plan.receipt, /affectedModules=module:core,module:app/);

  assert.throws(
    () => normalizeProjectManifest({ ...graphManifest(), modules: [{ ...(graphManifest().modules as readonly Record<string, unknown>[])[0], dependencies: ["module:missing"] }] }),
    (error: unknown) => {
      assert.ok(error instanceof LocalExecutionError);
      assert.equal(error.code, "manifest-reference-invalid");
      assert.match(error.receipt, /dependency-reference=missing/);
      return true;
    },
  );

  const cycle = graphManifest();
  const cycleModules = cycle.modules as readonly Record<string, unknown>[];
  cycle.modules = [
    { ...cycleModules[0], dependencies: ["module:app"] },
    cycleModules[1],
    cycleModules[2],
  ];
  assert.throws(
    () => normalizeProjectManifest(cycle),
    (error: unknown) => {
      assert.ok(error instanceof LocalExecutionError);
      assert.equal(error.code, "manifest-reference-invalid");
      assert.match(error.receipt, /dependency-graph=cycle/);
      return true;
    },
  );
});

test("reuses unaffected Action results across Project Revisions only through an exact input closure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-release-plan-"));
  try {
    await mkdir(join(directory, "core", "src"), { recursive: true });
    await mkdir(join(directory, "app", "src"), { recursive: true });
    await mkdir(join(directory, "docs"), { recursive: true });
    await writeFile(join(directory, "core", "src", "index.ts"), "export const core = true;\n");
    await writeFile(join(directory, "app", "src", "index.ts"), "export const app = true;\n");
    await writeFile(join(directory, "docs", "README.md"), "initial\n");
    const raw = graphManifest();
    const modules = raw.modules as readonly Record<string, unknown>[];
    raw.modules = modules.map((module) => ({
      ...module,
      actions: (module.actions as readonly Record<string, unknown>[]).map((action) => ({
        ...action,
        command: action.id === "action:core"
          ? "node -e \"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('core/src/index.ts','dist/core.out')\""
          : action.id === "action:app"
            ? "node -e \"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('app/src/index.ts','dist/app.out')\""
            : "node -e \"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('docs/README.md','dist/docs.out')\"",
      })),
    }));
    const manifest = normalizeProjectManifest(raw);
    const cache = new LocalExecutionCache();
    const first = await runLocalRelease({ manifest: raw, cache, releaseName: "graph-v1", context: { ...context(directory, "target:graph"), projectRevisionId: "project-revision:graph:v1" } });
    assert.equal(first.release.status, "ready");

    await writeFile(join(directory, "docs", "README.md"), "changed\n");
    const second = await runLocalRelease({
      manifest: raw,
      cache,
      changedPaths: ["docs/README.md"],
      releaseName: "graph-v2",
      context: { ...context(directory, "target:graph"), projectRevisionId: "project-revision:graph:v2" },
    });
    assert.equal(second.release.status, "ready");
    assert.deepEqual(second.plan.affectedModuleIds, ["module:docs"]);
    assert.deepEqual(second.plan.reusedActionIds, ["action:core", "action:app"]);
    assert.deepEqual(second.plan.fallbackActionIds, []);
    assert.equal(second.cacheHits, 2);
    assert.equal(second.artifacts.find((artifact) => artifact.actionId === "action:core")?.projectRevisionId, "project-revision:graph:v2");
    assert.equal(second.evidence.find((record) => record.actionId === "action:core")?.producer.kind, "attestation");
    assert.match(second.release.receipt ?? "", /reusedActions=action:core,action:app/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("affected planning falls back to execution when no exact reusable result exists", async () => {
  const copied = await copyFixture("worker");
  try {
    const result = await runLocalRelease({
      manifest: copied.manifest,
      changedPaths: [],
      context: context(copied.directory, "target:worker"),
      releaseName: "worker-fallback-plan",
    });
    assert.equal(result.release.status, "ready");
    assert.deepEqual(result.plan.selectedActionIds, []);
    assert.deepEqual(result.plan.fallbackActionIds, ["action:check", "action:build"]);
    assert.deepEqual(result.plan.reusedActionIds, []);
    assert.match(result.plan.receipt, /fallbackActions=action:check,action:build/);
  } finally {
    await rm(copied.directory, { recursive: true, force: true });
  }
});

test("local Worker Artifact digests are raw-byte digests compatible with provider Artifact readers", async () => {
  const copied = await copyFixture("worker");
  try {
    const result = await runLocalRelease({
      manifest: copied.manifest,
      context: context(copied.directory, "target:worker"),
      releaseName: "raw-byte-digest",
    });
    const artifact = result.artifacts.find((candidate) => candidate.outputPath === "dist/worker.bundle");
    assert.ok(artifact);
    const bytes = await readFile(join(copied.directory, artifact.outputPath!));
    assert.equal(artifact.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  } finally {
    await rm(copied.directory, { recursive: true, force: true });
  }
});

test("explicit typed paths govern local Artifacts independently of module type ordering and cache reuse", async () => {
  const copied = await copyFixture("worker");
  try {
    const value = copied.manifest as { modules: Array<{ artifactTypes: string[]; actions: Array<Record<string, unknown>> }> };
    value.modules[0]!.artifactTypes = ["worker.text"];
    value.modules[0]!.actions[1]!.artifactOutputContract = { protocol: "anyam.action-artifact-outputs/v1", outputs: [{ path: "dist/worker.bundle", type: "worker.bundle" }] };
    const manifest = normalizeProjectManifest(value);
    const engine = new LocalExecutionEngine({ manifest, context: context(copied.directory, "target:worker") });
    const first = await engine.runAction({ actionId: "action:build" });
    assert.equal(first.artifacts[0]!.type, "worker.bundle");
    assert.equal(first.artifacts[0]!.outputPath, "dist/worker.bundle");
    assert.deepEqual(first.run.artifactOutputContract, manifest.actions[1]!.artifactOutputContract);
    first.runnerInput.action.artifactOutputContract!.outputs[0]!.type = "worker.module";
    first.run.artifactOutputContract!.outputs[0]!.type = "worker.module";
    const cached = await engine.runAction({ actionId: "action:build" });
    assert.equal(cached.cacheHit, true);
    assert.equal(cached.runnerInput.action.artifactOutputContract!.outputs[0]!.type, "worker.bundle");
    assert.equal(cached.run.artifactOutputContract!.outputs[0]!.type, "worker.bundle");
    assert.equal(cached.artifacts[0]!.type, "worker.bundle");
  } finally { await rm(copied.directory, { recursive: true, force: true }); }
});
