import assert from "node:assert/strict";
import test from "node:test";
import { parseActionArtifactOutputContract, validateActionArtifactOutputs } from "../src/portability/action-artifact-output.ts";
import { parseDisclosedSourcePayload, disclosedSourceInputSchema } from "../src/portability/disclosed-source-command.ts";
import { normalizeProjectManifest } from "../src/execution/local.ts";
import { makeRunner, setup } from "./realm-artifact-handoff-fixture.ts";
import { runnerResultMessage } from "../src/execution/runner.ts";
import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";

const contract = { protocol: "anyam.action-artifact-outputs/v1" as const, outputs: [{ path: "dist/result.txt", type: "worker.bundle" }] };
const digest = `sha256:${"a".repeat(64)}`;

test("portable typed contract and public Run selectors detach declared metadata", () => {
 const parsed = parseActionArtifactOutputContract(contract, ["dist/result.txt"]);
 parsed.outputs[0]!.type = "worker.module"; assert.equal(contract.outputs[0]!.type, "worker.bundle");
 const payload = { projectId: "p", workspaceId: "w", changeRevisionId: "c", projectViewRevisionId: "v", actionId: "a", actionContractDigest: "sha256:a", inputDigests: [], artifactOutputContract: contract };
 const request = parseDisclosedSourcePayload("run.request", payload); assert.deepEqual(request.artifactOutputContract, contract);
 assert.equal((disclosedSourceInputSchema("run.request").properties as Record<string, { type: string }>).artifactOutputContract!.type, "object");
});

for (const path of ["", "/dist/main.js", "./dist/main.js", "dist/../main.js", "dist//main.js", "dist/main.js/", "dist\\main.js", ".GIT/config", "C:/main.js", "dist/main.js\n"]) {
 test(`typed declaration rejects path alias ${JSON.stringify(path)}`, () => { assert.throws(() => parseActionArtifactOutputContract({ ...contract, outputs: [{ path, type: "worker.bundle" }] })); });
}
for (const value of [null, { ...contract, protocol: "anyam.action-artifact-outputs/v0" }, { ...contract, outputs: [] }, { ...contract, extra: "undeclared" }, { ...contract, outputs: [{ ...contract.outputs[0], digest }] }, { ...contract, outputs: [...contract.outputs, ...contract.outputs] }, { ...contract, outputs: [{ path: "dist/result.txt", type: "Worker.Bundle" }] }]) {
 test(`typed declaration rejects unknown shape ${JSON.stringify(value)}`, () => { assert.throws(() => parseActionArtifactOutputContract(value)); });
}

test("typed path must exist in Action and partial failure can omit Artifact outputs", () => {
 assert.throws(() => parseActionArtifactOutputContract(contract, ["other"]));
 validateActionArtifactOutputs({ contract, declaredPaths: ["dist/result.txt"], status: "failed", outputDigests: [], outputs: [] });
 assert.throws(() => validateActionArtifactOutputs({ contract, declaredPaths: ["dist/result.txt"], status: "succeeded", outputDigests: [`dist/result.txt=${digest}`], outputs: [] }));
 assert.throws(() => validateActionArtifactOutputs({ contract: undefined, declaredPaths: ["dist/result.txt"], status: "succeeded", outputDigests: [], outputs: [{ kind: "artifact", outputPath: "dist/result.txt", digest }] }));
});

test("typed contract enters the normalized manifest Action digest and rejects mismatched declarations", async () => {
 const value = JSON.parse(await readFile(new URL("../fixtures/worker/anyam.json", import.meta.url), "utf8"));
 const before = normalizeProjectManifest(value).actions.find(action => action.id === "action:build")!;
 value.modules[0].actions[1].artifactOutputContract = { ...contract, outputs: [{ path: "dist/worker.bundle", type: "worker.bundle" }] };
 const after = normalizeProjectManifest(value).actions.find(action => action.id === "action:build")!;
 assert.notEqual(before.contractDigest, after.contractDigest); assert.equal(after.artifactOutputContract?.outputs[0]?.type, "worker.bundle");
 value.modules[0].actions[1].artifactOutputContract.outputs[0].path = "dist/undeclared.js";
 assert.throws(() => normalizeProjectManifest(value), /outside Action outputs/u);
});

test("Runner detaches immutable typed declarations and denies a signed path/digest mismatch", () => {
 const f = setup({ artifactOutputContract: contract, canonical: true }); const runner = makeRunner(f.input, f.runId);
 f.input.action.artifactOutputContract!.outputs[0]!.type = "worker.module";
 runner.lease.job.artifactOutputContract!.outputs[0]!.type = "worker.module";
 assert.equal(runner.runner.getJob(runner.lease.job.id)?.artifactOutputContract?.outputs[0]?.type, "worker.bundle");
 const result = structuredClone(runner.result); result.outputs[0]!.outputPath = "dist/result.txt"; result.outputs[0]!.digest = digest;
 result.signature = sign(null, Buffer.from(runnerResultMessage(result)), runner.keys.privateKey).toString("base64url");
 assert.throws(() => runner.runner.submit({ credential: runner.lease.credential, result }), /digest|malformed/u);
 assert.equal(runner.runner.getJob(runner.lease.job.id)?.state, "running");
});
