import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The real handlers execute against binding-shaped offline storage. This base
// substitutes only Cloudflare's constructor; it does not emulate live workerd.
const fakeBase = "data:text/javascript," + encodeURIComponent("export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }");
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "cloudflare:workers"
      ? { url: fakeBase, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
let QualificationCoordinator;
try {
  ({ QualificationCoordinator } = await import("../apps/runner-qualification/src/index.ts"));
} finally {
  hook.deregister();
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  return value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]))
    : value;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(outputPaths = ["dist/result.txt"], attemptId = "attempt:one") {
  const records = new Map();
  const objects = new Map();
  const queuedRequest = deferred();
  let active = false;
  let tail = Promise.resolve();
  const ctx = {
    storage: {
      async get(key) { return structuredClone(records.get(key)); },
      async put(key, value) { records.set(key, structuredClone(value)); },
    },
    blockConcurrencyWhile(callback) {
      if (active) queuedRequest.resolve();
      const result = tail.then(async () => {
        active = true;
        try { return await callback(); } finally { active = false; }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
  const store = {
    async put(key, bytes) { objects.set(key, Uint8Array.from(bytes)); },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      const bytes = Uint8Array.from(value);
      return { body: bytes, async arrayBuffer() { return bytes.buffer; } };
    },
  };
  const controlToken = "SYNTHETIC-OWNER-CONTROL-ONLY";
  const coordinator = new QualificationCoordinator(ctx, { OUTPUTS: store, QUALIFICATION_CONTROL_TOKEN: controlToken, REQUIRE_MANIFEST_BINDING: "true", MAX_OUTPUT_DISCLOSURE: "project" });
  const jobId = "job:custody";
  const keys = generateKeyPairSync("ed25519");
  const signature = (message) => sign(null, Buffer.from(message), keys.privateKey).toString("base64url");
  const manifest = {
    inputManifestDigest: digest("synthetic immutable input manifest"),
    sourceSnapshotDigest: digest("synthetic Source snapshot"),
    projectViewId: "project-view:custody",
    outputRoot: `runs/custody/${attemptId}`,
    outputPaths,
    disclosure: "project",
  };
  async function request(route, { body, token } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    return coordinator.fetch(new Request(`https://qualification.invalid/jobs/${encodeURIComponent(jobId)}/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  }
  const bound = await request("bind", { body: manifest, token: controlToken });
  assert.equal(bound.status, 200);
  const challenge = "synthetic-claim-challenge";
  const claim = await request("claim", { body: {
    ...manifest, attemptId, runnerId: "runner:custody", actionId: "action:produce",
    leaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    challenge, signature: signature(`anyam.runner-claim/v1|${challenge}`),
  } });
  assert.equal(claim.status, 200);
  const claimed = await claim.json();
  const token = claimed.credential.token;
  async function upload(path, text = "verified output\n") {
    const bytes = Buffer.from(text);
    const response = await request("outputs", { token, body: {
      attemptId, path, kind: "artifact", disclosure: "project", digest: digest(bytes), contentBase64: bytes.toString("base64url"),
    } });
    assert.equal(response.status, 200);
    return (await response.json()).output;
  }
  function result(outputs, status = "succeeded", context = claimed.status.resultContext) {
    const references = outputs.map(({ path, kind, disclosure, digest, bytes }) => ({ path, kind, disclosure, digest, bytes }));
    const envelope = { jobId, attemptId, context, status, outputs: references };
    return { ...envelope, signature: signature(`anyam.runner-result/v1|${JSON.stringify(stable(envelope))}`) };
  }
  return {
    request, upload, result, token, records, objects, store, storage: ctx.storage, manifest, queuedRequest,
    snapshot: () => structuredClone([...records]),
    async submit(outputs, status) { return request("result", { token, body: result(outputs, status) }); },
    async read(path = outputPaths[0]) { return request(`output?path=${encodeURIComponent(path)}`, { token }); },
  };
}

for (const outputSet of ["empty", "partial"]) {
  test(`qualification custody requires every declared output before accepting ${outputSet} success`, async () => {
    const f = await fixture(["dist/a.txt", "dist/b.txt"]);
    const outputs = outputSet === "empty" ? [] : [await f.upload("dist/a.txt")];
    const before = f.snapshot();
    const response = await f.submit(outputs);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "result_output_manifest_mismatch");
    assert.deepEqual(f.snapshot(), before);
  });
}

test("qualification custody rejects duplicate signed output references instead of omitting another accepted object", async () => {
  const f = await fixture(["dist/a.txt", "dist/b.txt"]);
  const a = await f.upload("dist/a.txt");
  const b = await f.upload("dist/b.txt");
  const before = f.snapshot();
  const response = await f.submit([a, a]);
  assert.equal(response.status, 422);
  assert.deepEqual(f.snapshot(), before);
  assert.equal((await f.submit([a, b])).status, 200, "rejected duplicates do not close the unchanged Attempt");
});

test("qualification custody rejects a signed disclosure different from the accepted output", async () => {
  const f = await fixture();
  const output = await f.upload("dist/result.txt");
  const before = f.snapshot();
  const response = await f.submit([{ ...output, disclosure: "public" }]);
  assert.equal(response.status, 422);
  assert.deepEqual(f.snapshot(), before);
});

for (const [label, change] of [
  ["omitted disclosure", { disclosure: undefined }],
  ["null disclosure", { disclosure: null }],
  ["numeric disclosure", { disclosure: 1 }],
  ["absolute path alias", { path: "/dist/result.txt" }],
  ["backslash path alias", { path: "dist\\result.txt" }],
]) {
  test(`qualification custody rejects signed ${label} instead of normalizing the accepted reference`, async () => {
    const f = await fixture();
    const output = await f.upload("dist/result.txt");
    const before = f.snapshot();
    let storageReads = 0;
    const originalGet = f.store.get;
    f.store.get = async (key) => { storageReads += 1; return originalGet(key); };
    const response = await f.submit([{ ...output, ...change }]);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "result_output_manifest_mismatch");
    assert.equal(storageReads, 0, "a signed reference mismatch must precede object reads");
    assert.deepEqual(f.snapshot(), before);
    assert.equal((await f.submit([output])).status, 200, "an exact signed retry can finalize the unchanged Attempt");
  });
}

test("qualification custody serves actual verified bytes and then accepts their exact signed result", async () => {
  const f = await fixture();
  const output = await f.upload("dist/result.txt");
  const read = await f.read();
  assert.equal(read.status, 200);
  const bytes = new Uint8Array(await read.arrayBuffer());
  assert.equal(digest(bytes), output.digest);
  assert.equal(read.headers.get("x-anyam-output-digest"), output.digest);
  assert.equal(read.headers.get("cache-control"), "no-store");
  const accepted = await f.submit([output]);
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.equal(body.status.status, "succeeded");
  assert.match(body.receipt, /outputReadBack=verified/);
  assert.equal(body.ackRequired, true);
  assert.ok(!JSON.stringify([...f.records]).includes(f.token));
  const before = f.snapshot();
  const replay = await f.submit([output]);
  assert.equal(replay.status, 401);
  assert.deepEqual(f.snapshot(), before);
});

for (const mode of ["missing", "same-size-tamper", "stale-attempt"]) {
  for (const operation of ["serve", "accept"]) {
    test(`qualification custody fails closed on ${mode} stored bytes during ${operation}`, async () => {
      const f = await fixture();
      const output = await f.upload("dist/result.txt");
      if (mode === "missing") f.objects.delete(output.key);
      else if (mode === "same-size-tamper") {
        const bytes = Uint8Array.from(f.objects.get(output.key));
        bytes[0] ^= 1;
        f.objects.set(output.key, bytes);
      } else {
        const previous = await fixture(["dist/result.txt"], "attempt:previous");
        const previousOutput = await previous.upload("dist/result.txt", "previous output\n");
        const previousBytes = previous.objects.get(previousOutput.key);
        assert.equal(previousBytes.byteLength, output.bytes);
        assert.notEqual(previousOutput.key, output.key);
        f.objects.set(output.key, Uint8Array.from(previousBytes));
      }
      const before = f.snapshot();
      const response = operation === "serve" ? await f.read() : await f.submit([output]);
      assert.equal(response.status, mode === "missing" ? 503 : 422);
      const body = await response.json();
      assert.equal(body.code, mode === "missing" ? "output_missing" : "output_digest_mismatch");
      assert.equal(body.ackRequired, undefined);
      assert.equal(response.headers.get("x-anyam-output-digest"), null);
      assert.deepEqual(f.snapshot(), before);
    });
  }
}

for (const failure of ["get", "body"]) {
  for (const operation of ["serve", "accept"]) {
    test(`qualification custody hides storage ${failure} failure details and preserves the active Attempt during ${operation}`, async () => {
      const f = await fixture();
      const output = await f.upload("dist/result.txt");
      const before = f.snapshot();
      const originalGet = f.store.get;
      f.store.get = async (key) => {
        if (failure === "get") throw new Error("Bearer SYNTHETIC-STORAGE-SECRET-ONLY");
        const object = await originalGet(key);
        object.arrayBuffer = async () => { throw new Error("Bearer SYNTHETIC-STORAGE-SECRET-ONLY"); };
        return object;
      };
      const response = operation === "serve" ? await f.read() : await f.submit([output]);
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.equal(JSON.parse(text).code, "output_unavailable");
      assert.doesNotMatch(text, /SYNTHETIC-STORAGE-SECRET|Bearer/);
      assert.deepEqual(f.snapshot(), before);
    });
  }
}

test("qualification custody permits a declared no-output Action's signed success", async () => {
  const f = await fixture([]);
  const response = await f.submit([]);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status.status, "succeeded");
});

test("qualification custody accepts a signed failed result with an exact partial output set", async () => {
  const f = await fixture(["dist/a.txt", "dist/b.txt"]);
  const a = await f.upload("dist/a.txt");
  const response = await f.submit([a], "failed");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status.status, "failed");
});

test("qualification custody rejects a previous Attempt's signed reference and context", async () => {
  const previous = await fixture(["dist/result.txt"], "attempt:previous");
  const stale = await previous.upload("dist/result.txt", "previous output\n");
  const f = await fixture();
  const current = await f.upload("dist/result.txt");
  const before = f.snapshot();
  const staleReference = await f.submit([stale]);
  assert.equal(staleReference.status, 422);
  assert.equal((await staleReference.json()).code, "result_output_manifest_mismatch");
  const staleContext = await f.request("result", { token: f.token, body: f.result([current], "succeeded", previous.result([stale]).context) });
  assert.equal(staleContext.status, 422);
  assert.equal((await staleContext.json()).code, "result_context_mismatch");
  assert.deepEqual(f.snapshot(), before);
});

test("qualification custody checks current credentials, Attempt and declared path before storage", async () => {
  const f = await fixture();
  const output = await f.upload("dist/result.txt");
  const before = f.snapshot();
  let storageReads = 0;
  const originalGet = f.store.get;
  f.store.get = async (key) => { storageReads += 1; return originalGet(key); };
  const deniedRead = await f.request("output?path=dist/result.txt", { token: "SYNTHETIC-WRONG-CREDENTIAL" });
  assert.equal(deniedRead.status, 401);
  assert.equal(storageReads, 0);
  assert.doesNotMatch(await deniedRead.text(), /SYNTHETIC-WRONG-CREDENTIAL/);
  for (const change of [{ attemptId: "attempt:previous" }, { path: "private/undeclared.txt" }, { disclosure: "restricted" }]) {
    const upload = await f.request("outputs", { token: f.token, body: {
      attemptId: "attempt:one", path: output.path, kind: "artifact", disclosure: "project", digest: output.digest,
      contentBase64: Buffer.from(f.objects.get(output.key)).toString("base64url"), ...change,
    } });
    assert.equal(upload.status, 422);
  }
  const body = f.result([output]);
  const invalidSignature = await f.request("result", { token: f.token, body: { ...body, signature: body.signature + "tampered" } });
  assert.equal(invalidSignature.status, 422);
  assert.equal(storageReads, 0, "proof/permission denial must precede output reads");
  assert.deepEqual(f.snapshot(), before);
});

test("qualification custody can retry an unchanged Attempt after restoring the exact rejected bytes", async () => {
  const f = await fixture();
  const output = await f.upload("dist/result.txt");
  const original = Uint8Array.from(f.objects.get(output.key));
  const changed = Uint8Array.from(original);
  changed[0] ^= 1;
  f.objects.set(output.key, changed);
  const before = f.snapshot();
  assert.equal((await f.submit([output])).status, 422);
  assert.deepEqual(f.snapshot(), before);
  f.objects.set(output.key, original);
  assert.equal((await f.read()).status, 200);
  const accepted = await f.submit([output]);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).status.attemptId, "attempt:one");
});

test("qualification custody hides unconfirmed storage-write failure and preserves the active output manifest", async () => {
  const f = await fixture();
  const before = f.snapshot();
  f.store.put = async () => { throw new Error("Bearer SYNTHETIC-WRITE-SECRET-ONLY"); };
  const bytes = Buffer.from("verified output\n");
  const response = await f.request("outputs", { token: f.token, body: {
    attemptId: "attempt:one", path: "dist/result.txt", kind: "artifact", disclosure: "project", digest: digest(bytes), contentBase64: bytes.toString("base64url"),
  } });
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(JSON.parse(text).code, "output_unavailable");
  assert.doesNotMatch(text, /SYNTHETIC-WRITE-SECRET|Bearer/);
  assert.deepEqual(f.snapshot(), before);
});

for (const operation of ["read-record", "write-output-record", "write-terminal-record"]) {
  test(`qualification custody hides coordinator storage failure during ${operation}`, async () => {
    const f = await fixture();
    const output = await f.upload("dist/result.txt");
    const before = f.snapshot();
    if (operation === "read-record") f.storage.get = async () => { throw new Error("Bearer SYNTHETIC-COORDINATOR-SECRET-ONLY"); };
    else f.storage.put = async () => { throw new Error("Bearer SYNTHETIC-COORDINATOR-SECRET-ONLY"); };
    const response = operation === "read-record"
      ? await f.read()
      : operation === "write-terminal-record"
        ? await f.submit([output])
        : await f.request("outputs", { token: f.token, body: {
          attemptId: "attempt:one", path: output.path, kind: "artifact", disclosure: "project", digest: output.digest,
          contentBase64: Buffer.from(f.objects.get(output.key)).toString("base64url"),
        } });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(JSON.parse(text).code, "coordinator_storage_unavailable");
    assert.doesNotMatch(text, /SYNTHETIC-COORDINATOR-SECRET|Bearer/);
    assert.equal(JSON.parse(text).ackRequired, undefined);
    assert.deepEqual(f.snapshot(), before);
  });
}

test("qualification custody prevents an in-flight upload from replacing bytes after result acceptance", async () => {
  const f = await fixture();
  const output = await f.upload("dist/result.txt");
  const readStarted = deferred();
  const releaseRead = deferred();
  const originalGet = f.store.get;
  f.store.get = async (key) => {
    const object = await originalGet(key);
    const originalRead = object.arrayBuffer;
    object.arrayBuffer = async () => { readStarted.resolve(); await releaseRead.promise; return originalRead(); };
    return object;
  };
  const completion = f.submit([output]);
  await readStarted.promise;
  const replacement = Buffer.from("substituted out\n");
  const upload = f.request("outputs", { token: f.token, body: {
    attemptId: "attempt:one", path: output.path, kind: "artifact", disclosure: "project", digest: digest(replacement), contentBase64: replacement.toString("base64url"),
  } });
  // Observe either the old handler's completed write or the runtime's queued
  // request. Release the read without sleeps or an implementation-time limit.
  await Promise.race([upload, f.queuedRequest.promise]);
  releaseRead.resolve();
  assert.equal((await completion).status, 200);
  assert.equal((await upload).status, 401, "accepted completion closes credentials before queued upload can mutate storage");
  assert.equal(digest(f.objects.get(output.key)), output.digest);
});
