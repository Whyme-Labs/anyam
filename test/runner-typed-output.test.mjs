import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
const fakeBase = "data:text/javascript," + encodeURIComponent("export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } } export class WorkflowEntrypoint {} export class WorkerEntrypoint {}");
const hook = registerHooks({ resolve(specifier, context, nextResolve) { return specifier === "cloudflare:workers" ? { url: fakeBase, shortCircuit: true } : nextResolve(specifier, context); } });
let fixture;
try { fixture = (await import("./fixtures/realm-artifact-handoff-runtime.ts")).createRealmArtifactHandoffFixture; }
finally { hook.deregister(); }
const contract = { protocol: "anyam.action-artifact-outputs/v1", outputs: [{ path: "dist/result.txt", type: "worker.bundle" }] };
test("typed declared output survives queued Run, signed Result and verified Realm byte custody", async () => {
 const f = await fixture({ artifactOutputContract: contract, canonical: true });
 const accepted = await f.invoke(); assert.equal(accepted.status, 200, JSON.stringify(accepted));
 const artifact = accepted.value.value.artifacts[0];
 assert.equal(artifact.type, "worker.bundle"); assert.equal(artifact.outputPath, "dist/result.txt");
 assert.deepEqual(accepted.value.value.run.artifactOutputContract, contract);
 assert.deepEqual(f.completion.result.context.artifactOutputContract, contract);
 assert.ok(await f.destination.get(`artifacts/${artifact.digest}`));
});

const { sign } = await import("node:crypto");
const { runnerResultMessage, runnerResultContext } = await import("../src/execution/runner.ts");
const { runnerResultDigest } = await import("../src/execution/runner-proof.ts");
const { AuthorityPlaneCoordinator, AUTHORITY_COMMAND_PROTOCOL } = await import("../src/cloudflare/authority-plane.ts");
const { sealVerifiedRelease } = await import("../src/delivery/promotion.ts");
const { createCloudflareWorkerReleaseManifest } = await import("../src/cloudflare/worker-release-manifest.ts");

async function resign(f) {
 const c = f.body.completion;
 c.result.signature = sign(null, Buffer.from(runnerResultMessage(c.result)), f.runner.keys.privateKey).toString("base64url");
 c.outputs = c.result.outputs.map((output, index) => ({ ...c.outputs[index], ...output }));
 c.resultDigest = await runnerResultDigest({ jobId: c.job.id, attemptId: c.attempt.id, result: c.result });
 c.attempt.resultDigest = c.resultDigest;
}

for (const mode of ["queued-contract-drift", "signed-context-drift", "unsigned-logical-path", "missing-path", "path-alias", "undeclared-path", "duplicate-path", "digest-mismatch", "missing-artifact"]) {
 test(`typed Realm completion rejects ${mode} before byte access or Authority commit`, async () => {
  const f = await fixture({ artifactOutputContract: contract, canonical: true }); const before = f.snapshot(); const c = f.body.completion;
  if (mode === "queued-contract-drift") { c.job.artifactOutputContract.outputs[0].type = "worker.module"; c.result.context = runnerResultContext({ job: c.job, attempt: c.attempt }); }
  if (mode === "signed-context-drift") c.result.context.artifactOutputContract.outputs[0].type = "worker.module";
  if (mode === "unsigned-logical-path") c.outputs[0].outputPath = "dist/other.js";
  if (mode === "missing-path") delete c.result.outputs[0].outputPath;
  if (mode === "path-alias") c.result.outputs[0].outputPath = "./dist/result.txt";
  if (mode === "undeclared-path") c.result.outputs[0].outputPath = "dist/other.js";
  if (mode === "duplicate-path") c.result.outputs.push({ ...c.result.outputs[0] });
  if (mode === "digest-mismatch") c.result.outputs[0].digest = `sha256:${"a".repeat(64)}`;
  if (mode === "missing-artifact") c.result.outputs = [];
  if (mode !== "unsigned-logical-path") await resign(f);
  const denied = await f.invoke(); assert.equal(denied.status, 409, JSON.stringify(denied));
  assert.deepEqual(f.snapshot(), before); assert.equal(f.commits(), 0); assert.deepEqual(f.source.calls, []); assert.deepEqual(f.destination.calls, []);
 });
}

test("typed accepted canonical Artifact seals into a Worker manifest using retained bytes", async () => {
 const f = await fixture({ artifactOutputContract: contract, canonical: true }); const accepted = await f.invoke(); assert.equal(accepted.status, 200);
 const { artifacts, evidence, run } = accepted.value.value;
 const authority = new AuthorityPlaneCoordinator(f.snapshot());
 const command = (command, payload) => authority.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command, idempotencyKey: `typed:${command}`, payload }, f.authority.ownerSession);
 const configured = command("target.configure", { projectId: f.authority.projectId, targetId: f.authority.input.targetId, name: "Owned offline Worker", adapterId: "cloudflare.worker", acceptedArtifactTypes: ["worker.bundle"], requiredEvidenceKeys: [evidence.key] });
 const releaseResult = command("release.create", { projectId: f.authority.projectId, projectRevisionId: run.projectRevisionId, releaseId: "release:typed-worker", artifactIds: artifacts.map(artifact => artifact.id), evidenceIds: [evidence.id], configurationDigests: ["sha256:offline-worker-config"], policyVersion: run.policyVersion });
 assert.equal(releaseResult.status, "succeeded");
 const release = sealVerifiedRelease({ projectId: f.authority.projectId, release: releaseResult.value.release, artifacts, evidence: [evidence], target: configured.value.target });
 const manifest = createCloudflareWorkerReleaseManifest({ release, compatibilityDate: "2026-10-03" });
 assert.equal(manifest.mainModule, "dist/result.txt"); assert.equal(manifest.modules[0].type, "es-module"); assert.equal(manifest.modules[0].digest, artifacts[0].digest);
 const object = await f.destination.get(`artifacts/${manifest.modules[0].digest}`); assert.ok(object);
 const hash = (await import("node:crypto")).createHash("sha256").update(new Uint8Array(await object.arrayBuffer())).digest("hex");
 assert.equal(`sha256:${hash}`, artifacts[0].digest);
 // Accepted replay uses historical proof without re-reading expired Attempt objects.
 f.source.objects.clear(); const reads = f.source.calls.length;
 assert.deepEqual(await f.invoke(), accepted); assert.equal(f.source.calls.length, reads);
});

for (const status of ["failed", "indeterminate"]) {
 test(`typed ${status} output never supplies passed Evidence or a ready Release`, async () => {
  const f = await fixture({ artifactOutputContract: contract, canonical: true, runStatus: status });
  const accepted = await f.invoke(); const { artifacts, evidence, run } = accepted.value.value;
  assert.equal(artifacts[0].type, "worker.bundle"); assert.equal(evidence.outcome, status);
  const authority = new AuthorityPlaneCoordinator(f.snapshot()); const before = authority.snapshot();
  assert.throws(() => authority.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "release.create", idempotencyKey: `typed:${status}:release`, payload: { projectId: f.authority.projectId, projectRevisionId: run.projectRevisionId, artifactIds: artifacts.map(artifact => artifact.id), evidenceIds: [evidence.id], policyVersion: run.policyVersion } }, f.authority.ownerSession), /passed/u);
  assert.deepEqual(authority.snapshot(), before);
 });
}

test("declared output type grants no public completion authority", async () => {
 const f = await fixture({ artifactOutputContract: contract, canonical: true }); const before = f.snapshot();
 assert.notEqual((await f.invoke(f.body, false)).status, 200); assert.deepEqual(f.snapshot(), before); assert.equal(f.commits(), 0);
});
