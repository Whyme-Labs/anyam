import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { setup, makeRunner } from "./realm-artifact-handoff-fixture.ts";
import { runnerResultMessage } from "../src/execution/runner.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";

// This replaces only Cloudflare constructors. It is a Node boundary test,
// not a workerd, live Durable Object, R2, Runner or deployment qualification.
const fakeBase = "data:text/javascript," + encodeURIComponent("export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } } export class WorkflowEntrypoint {} export class WorkerEntrypoint {}");
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === "cloudflare:workers" ? { url: fakeBase, shortCircuit: true } : nextResolve(specifier, context);
} });
let AnyamRealmCoordinator;
try { ({ AnyamRealmCoordinator } = await import("../apps/realm-worker/src/index.ts")); }
finally { hook.deregister(); }

const sha256 = bytes => `sha256:${createHash("sha256").update(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).digest("hex")}`;
const bytes = Buffer.from("export default { fetch() { return new Response('retained artifact'); } };\n");
const sensitiveFailure = "SYNTHETIC-PROVIDER-PRIVATE-ERROR";

function store() {
  const objects = new Map(); const calls = [];
  return {
    objects, calls,
    async get(key) { calls.push(["get", key]); const body = objects.get(key); return body === undefined ? null : { async arrayBuffer() { return Uint8Array.from(body).buffer; } }; },
    async put(key, body, options) {
      calls.push(["put", key, options]);
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      objects.set(key, Buffer.from(body)); return { key };
    },
  };
}

async function fixture({ configured = true, outputs = true, runStatus = "succeeded" } = {}) {
  const authority = setup(); const runner = makeRunner(authority.input, authority.runId);
  const result = structuredClone(runner.result);
  result.status = runStatus; result.output.status = runStatus; result.output.exitCode = runStatus === "succeeded" ? 0 : 1;
  result.output.outputDigest = sha256(bytes); result.output.outputDigests = [`dist/result.txt=${sha256(bytes)}`];
  result.outputs = outputs ? result.outputs.map(output => ({ ...output, digest: sha256(bytes) })) : [];
  result.signature = sign(null, Buffer.from(runnerResultMessage(result)), runner.keys.privateKey).toString("base64url");
  const completion = runner.runner.submit({ credential: runner.lease.credential, result });
  authority.authority.registerRunnerProfile(runner.profile, { ...completion.job.actor, realmId: authority.authority.snapshot().realmId, clientId: "anyam-runner-coordinator", authorizationEpoch: 4, kind: "runner" });
  let state = authority.authority.snapshot();
  const source = store(); const destination = store(); const records = new Map(); let commits = 0;
  for (const output of completion.outputs) source.objects.set(output.location, bytes);
  let chain = Promise.resolve();
  const ctx = { storage: { async get(key) { return records.get(key); } }, blockConcurrencyWhile(callback) {
    const operation = chain.then(callback); chain = operation.then(() => undefined, () => undefined); return operation;
  } };
  const env = configured ? { ANYAM_RUNNER_OUTPUTS: source, ANYAM_PROMOTION_ARTIFACTS: destination } : {};
  const worker = new AnyamRealmCoordinator(ctx, env);
  // Authentication and SQL persistence are fixtures; all actual Runner proof,
  // scope, custody, Authority transitions, route handling and gate ordering run.
  worker.requireIdentity = () => ({ realm: { id: authority.authority.snapshot().realmId }, getRecoverySnapshot: () => ({ realm: { id: authority.authority.snapshot().realmId, authorizationEpoch: 4 } }), containsKnownCredentialMaterial: () => false });
  worker.authoritySnapshot = async () => structuredClone(state);
  worker.persistAuthoritySnapshot = async (_previous, next) => { if (next.version !== state.version) commits += 1; state = structuredClone(next); };
  const body = { idempotencyKey: "realm:artifact-handoff", completion };
  const invoke = async (value = body, internal = true) => {
    const response = await worker.fetch(new Request("https://realm/authority/runner-complete/internal", { method: "POST", headers: { "content-type": "application/json", ...(internal ? { [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE } : {}) }, body: JSON.stringify(value) }));
    const valueResult = await response.json(); assert.doesNotMatch(JSON.stringify(valueResult), new RegExp(sensitiveFailure));
    return { status: response.status, value: valueResult };
  };
  return { authority, runner, worker, source, destination, body, completion, invoke, snapshot: () => structuredClone(state), commits: () => commits };
}

function unchanged(f, before) { assert.deepEqual(f.snapshot(), before); assert.equal(f.commits(), 0); }

test("actual Realm completion retains verified bytes at the executor digest key before committing", async () => {
  const f = await fixture(); const accepted = await f.invoke();
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  const artifact = accepted.value.value.artifacts[0];
  const object = await f.destination.get(`artifacts/${artifact.digest}`);
  assert.ok(object); assert.deepEqual(Buffer.from(await object.arrayBuffer()), bytes);
  assert.equal(sha256(await object.arrayBuffer()), artifact.digest);
  assert.match(accepted.value.receipt, /artifactByteCustody=realm-verified/u);
  assert.match(accepted.value.value.evidence.receipt, /artifactByteCustody=realm-verified/u);
  assert.equal(f.snapshot().runs[f.completion.run.id].status, "succeeded");
  assert.equal(f.commits(), 1);
  const write = f.destination.calls.find(call => call[0] === "put");
  assert.deepEqual(write[2].onlyIf, { etagDoesNotMatch: "*" });
});

test("accepted replay needs no surviving Attempt object and performs no second copy or state transition", async () => {
  const f = await fixture(); const accepted = await f.invoke(); assert.equal(accepted.status, 200);
  const checkpoint = f.snapshot(); const calls = structuredClone([f.source.calls, f.destination.calls]);
  f.source.objects.clear();
  assert.deepEqual(await f.invoke(), accepted); assert.deepEqual(f.snapshot(), checkpoint);
  assert.deepEqual([f.source.calls, f.destination.calls], calls); assert.equal(f.commits(), 1);
});

test("artifact-free completion requires no R2 bindings and makes no byte custody claim", async () => {
  const f = await fixture({ configured: false, outputs: false }); const accepted = await f.invoke();
  assert.equal(accepted.status, 200); assert.match(accepted.value.receipt, /artifactByteCustody=not-required/u);
});

for (const mode of ["unconfigured", "missing", "tampered", "source-get-error", "source-body-error", "destination-get-error", "destination-body-error", "destination-put-error", "destination-readback-tampered", "destination-readback-missing", "destination-conflict", "digest-format", "path-alias", "attempt-substring"]) {
  test(`Realm custody denies ${mode} without committing terminal state or leaking storage errors`, async () => {
    const f = await fixture({ configured: mode !== "unconfigured" }); const before = f.snapshot();
    const output = f.completion.outputs[0]; const key = `artifacts/${output.digest}`;
    if (mode === "missing") f.source.objects.clear();
    if (mode === "tampered") f.source.objects.set(output.location, Buffer.from("changed after signature"));
    if (mode === "source-get-error") f.source.get = async () => { throw new Error(sensitiveFailure); };
    if (mode === "source-body-error") f.source.get = async () => ({ async arrayBuffer() { throw new Error(sensitiveFailure); } });
    if (mode === "destination-get-error") f.destination.get = async () => { throw new Error(sensitiveFailure); };
    if (mode === "destination-body-error") f.destination.get = async () => ({ async arrayBuffer() { throw new Error(sensitiveFailure); } });
    if (mode === "destination-put-error") f.destination.put = async () => { throw new Error(sensitiveFailure); };
    if (mode === "destination-readback-tampered") f.destination.put = async key => { f.destination.objects.set(key, Buffer.from("wrong destination bytes")); return { key }; };
    if (mode === "destination-readback-missing") f.destination.put = async key => ({ key });
    if (mode === "destination-conflict") f.destination.objects.set(key, Buffer.from("preexisting wrong object"));
    if (["digest-format", "path-alias", "attempt-substring"].includes(mode)) {
      const result = f.body.completion.result;
      if (mode === "digest-format") result.outputs[0].digest = "sha256:not-a-byte-digest";
      if (mode === "path-alias") result.outputs[0].location = result.outputs[0].location.replaceAll("/", "\\");
      if (mode === "attempt-substring") result.outputs[0].location = result.outputs[0].location.replace(f.completion.attempt.id, `other-${f.completion.attempt.id}-other`);
      result.signature = sign(null, Buffer.from(runnerResultMessage(result)), f.runner.keys.privateKey).toString("base64url");
      // Preserve a genuinely signed context and recompute its completion digest.
      const { runnerResultDigest } = await import("../src/execution/runner-proof.ts");
      f.body.completion.outputs[0] = { ...f.body.completion.outputs[0], ...result.outputs[0] };
      const resultDigest = await runnerResultDigest({ jobId: f.completion.job.id, attemptId: f.completion.attempt.id, result });
      f.body.completion.resultDigest = resultDigest; f.body.completion.attempt.resultDigest = resultDigest;
    }
    const rejected = await f.invoke(); assert.equal(rejected.status, mode === "unconfigured" ? 409 : ["source-get-error", "source-body-error", "destination-get-error", "destination-body-error", "destination-put-error", "destination-readback-missing"].includes(mode) ? 503 : 409, JSON.stringify(rejected)); unchanged(f, before);
    assert.match(rejected.value.receipt, /artifactByteCustody=/u);
    if (mode === "destination-conflict") assert.equal(f.destination.calls.filter(call => call[0] === "put").length, 0);
  });
}

test("invalid signed proof and stale version are denied before reading or writing any bytes", async () => {
  for (const mode of ["signature", "stale-version", "public-call"]) {
    const f = await fixture(); const before = f.snapshot();
    if (mode === "signature") f.body.completion.result.signature = "invalid-signature";
    if (mode === "stale-version") f.body.expectedVersion = before.version - 1;
    assert.notEqual((await f.invoke(f.body, mode !== "public-call")).status, 200);
    unchanged(f, before); assert.deepEqual(f.source.calls, []); assert.deepEqual(f.destination.calls, []);
  }
});

test("unconfirmed destination write can retry the same completion without overwriting confirmed bytes", async () => {
  const f = await fixture(); const before = f.snapshot(); const put = f.destination.put;
  f.destination.put = async (...args) => { await put(...args); throw new Error(sensitiveFailure); };
  assert.equal((await f.invoke()).status, 503); unchanged(f, before);
  f.destination.put = put;
  assert.equal((await f.invoke()).status, 200); assert.equal(f.commits(), 1);
  assert.equal(f.destination.calls.filter(call => call[0] === "put").length, 1);
});

test("Authority persistence fault leaves reusable digest bytes, not an accepted Run", async () => {
  const f = await fixture(); const before = f.snapshot(); const persist = f.worker.persistAuthoritySnapshot;
  f.worker.persistAuthoritySnapshot = async () => { throw new Error(sensitiveFailure); };
  assert.equal((await f.invoke()).status, 503); unchanged(f, before);
  assert.ok(f.destination.objects.has(`artifacts/${f.completion.outputs[0].digest}`));
  f.worker.persistAuthoritySnapshot = persist;
  assert.equal((await f.invoke()).status, 200); assert.equal(f.commits(), 1);
  assert.equal(f.destination.calls.filter(call => call[0] === "put").length, 1);
});

test("conditional put handles a concurrent identical destination object without overwriting it", async () => {
  const f = await fixture(); const put = f.destination.put;
  f.destination.put = async (...args) => { f.destination.objects.set(args[0], bytes); return await put(...args); };
  assert.equal((await f.invoke()).status, 200); assert.equal(f.commits(), 1);
  assert.deepEqual(f.destination.objects.get(`artifacts/${sha256(bytes)}`), bytes);
});

test("conditional put cannot overwrite a corrupt destination object arriving after the first read", async () => {
  const f = await fixture(); const before = f.snapshot(); const put = f.destination.put; const corrupt = Buffer.from("concurrent wrong bytes");
  f.destination.put = async (...args) => { f.destination.objects.set(args[0], corrupt); return await put(...args); };
  assert.equal((await f.invoke()).status, 409); unchanged(f, before);
  assert.deepEqual(f.destination.objects.get(`artifacts/${sha256(bytes)}`), corrupt);
});

test("missing source can be restored and the original completion retried", async () => {
  const f = await fixture(); const before = f.snapshot(); f.source.objects.clear();
  assert.equal((await f.invoke()).status, 409); unchanged(f, before);
  f.source.objects.set(f.completion.outputs[0].location, bytes);
  assert.equal((await f.invoke()).status, 200); assert.equal(f.commits(), 1);
});

test("actual Realm gate serializes two identical completions across a paused source read", async () => {
  const f = await fixture(); const get = f.source.get; let release; let entered;
  const paused = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  f.source.get = async key => { entered(); await paused; return await get(key); };
  const first = f.invoke(); await started; const second = f.invoke();
  assert.equal(f.commits(), 0); release();
  const accepted = await first; assert.equal(accepted.status, 200); assert.deepEqual(await second, accepted);
  assert.equal(f.commits(), 1); assert.equal(f.source.calls.length, 1);
  assert.equal(f.destination.calls.filter(call => call[0] === "put").length, 1);
});

test("a reused completion key with changed signed result is denied before byte access", async () => {
  const f = await fixture(); assert.equal((await f.invoke()).status, 200);
  const before = f.snapshot(); const calls = structuredClone([f.source.calls, f.destination.calls]);
  f.body.completion.result.recoveryAction = "changed signed result";
  assert.equal((await f.invoke()).status, 409); assert.deepEqual(f.snapshot(), before);
  assert.deepEqual([f.source.calls, f.destination.calls], calls); assert.equal(f.commits(), 1);
});

for (const runStatus of ["failed", "indeterminate"]) {
  test(`${runStatus} Run retains declared Artifact bytes without passing Evidence`, async () => {
    const f = await fixture({ runStatus }); const accepted = await f.invoke();
    assert.equal(accepted.status, runStatus === "indeterminate" ? 503 : 200);
    assert.equal(accepted.value.value.run.status, runStatus);
    assert.equal(accepted.value.value.evidence.outcome, runStatus);
    assert.match(accepted.value.value.evidence.receipt, /artifactByteCustody=realm-verified/u);
    assert.deepEqual(f.destination.objects.get(`artifacts/${sha256(bytes)}`), bytes); assert.equal(f.commits(), 1);
  });
}

test("an uncertain response after Authority commit is confirmed by replay even after Attempt cleanup", async () => {
  const f = await fixture(); const persist = f.worker.persistAuthoritySnapshot;
  f.worker.persistAuthoritySnapshot = async (...args) => { await persist(...args); throw new Error(sensitiveFailure); };
  const uncertain = await f.invoke(); assert.equal(uncertain.status, 503);
  assert.match(uncertain.value.receipt, /authorityCommit=unconfirmed/u);
  assert.equal(f.snapshot().runs[f.completion.run.id].status, "succeeded"); assert.equal(f.commits(), 1);
  const checkpoint = f.snapshot(); const calls = structuredClone([f.source.calls, f.destination.calls]);
  f.worker.persistAuthoritySnapshot = persist; f.source.objects.clear();
  assert.equal((await f.invoke()).status, 200); assert.deepEqual(f.snapshot(), checkpoint);
  assert.deepEqual([f.source.calls, f.destination.calls], calls); assert.equal(f.commits(), 1);
});

test("metadata conflict is rejected before reading any Artifact bytes", async () => {
  const f = await fixture(); const checkpoint = f.snapshot(); const output = f.completion.outputs[0];
  checkpoint.artifacts[output.id] = { protocol: "anyam.artifact/v1", id: output.id, type: "runner.output", digest: output.digest, projectRevisionId: f.completion.job.projectRevisionId };
  f.worker.authoritySnapshot = async () => structuredClone(checkpoint);
  const rejected = await f.invoke(); assert.equal(rejected.status, 409);
  assert.deepEqual(f.source.calls, []); assert.deepEqual(f.destination.calls, []); assert.equal(f.commits(), 0);
});
