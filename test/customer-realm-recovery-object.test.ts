import assert from "node:assert/strict";
import test from "node:test";
import {
  CustomerRealmPersistenceError,
  CustomerRealmRecoveryObjectStore,
  type CustomerRealmR2Bucket,
} from "../src/cloudflare/customer-realm-persistence.ts";
import {
  CustomerRealmInstallation,
  InMemoryCustomerRealmCloudflareAdapter,
  InMemoryCustomerRealmProjectImporter,
} from "../src/installation/customer-realm.ts";

type PutOptions = NonNullable<Parameters<CustomerRealmR2Bucket["put"]>[2]>;

class ConditionalMemoryBucket implements CustomerRealmR2Bucket {
  readonly values = new Map<string, string>();
  readonly writes: { key: string; value: string; options: PutOptions | undefined }[] = [];

  async put(key: string, value: string, options?: PutOptions): Promise<object | null> {
    this.writes.push({ key, value, options });
    const condition: unknown = options && Reflect.get(options, "onlyIf");
    if (condition) {
      assert.deepEqual(condition, { etagDoesNotMatch: "*" });
      if (this.values.has(key)) return null;
    }
    this.values.set(key, value);
    return {};
  }

  async get(key: string): ReturnType<CustomerRealmR2Bucket["get"]> {
    const value = this.values.get(key);
    return value === undefined ? null : { arrayBuffer: async () => new TextEncoder().encode(value).buffer };
  }
}

async function recoveryBundle(installationId: string) {
  const installation = new CustomerRealmInstallation({
    installationId,
    cloudflare: new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]),
    importer: new InMemoryCustomerRealmProjectImporter({ projectRevisionId: "unused", sourceSpaceIds: [], exportDigest: "unused", checkpointId: "unused", state: "verified", partialEffects: [], receipt: "unused" }),
    now: () => new Date("2026-08-03T00:00:00Z"),
  });
  await installation.install({ accountId: "account:customer", requestedResourceTypes: ["r2"], ownerConfirmed: true, operationId: `operation:${installationId}`, idempotencyKey: `idempotency:${installationId}` });
  return installation.exportRecovery({});
}

function racingBucket(bucket: ConditionalMemoryBucket, winner: string): CustomerRealmR2Bucket {
  return {
    get: key => bucket.get(key),
    put: async (key, value, options) => {
      // This models another writer at the storage boundary, before the atomic
      // create precondition is evaluated, rather than a timing-based sleep.
      assert.equal(bucket.values.has(key), false);
      bucket.values.set(key, winner);
      return bucket.put(key, value, options);
    },
  };
}

test("a concurrent valid Recovery winner is preserved byte-for-byte and the receipt measures retained bytes", async () => {
  const bundle = await recoveryBundle("installation:valid-race");
  const winner = JSON.stringify(bundle, null, 2);
  const bucket = new ConditionalMemoryBucket();
  const store = new CustomerRealmRecoveryObjectStore(racingBucket(bucket, winner));
  const receipt = await store.put(bundle);
  assert.equal(bucket.values.get(receipt.key), winner);
  assert.equal(receipt.bytes, Buffer.byteLength(winner));
  assert.match(receipt.receipt, /idempotent=true/);
  assert.deepEqual(await store.get(receipt.digest), bundle);
});

for (const kind of ["wrong-digest", "malformed", "credential-bearing"] as const) {
  test(`a concurrent ${kind} Recovery object fails closed without replacing the winner`, async () => {
    const bundle = await recoveryBundle(`installation:denial-${kind}`);
    const key = `anyam/customer-realm/recovery/v1/${bundle.integrity.digest}`;
    const winner = kind === "wrong-digest"
      ? JSON.stringify(await recoveryBundle("installation:different-winner"))
      : kind === "malformed" ? "not JSON" : JSON.stringify({ ...bundle, token: "fixture-credential-marker" });
    const bucket = new ConditionalMemoryBucket();
    const store = new CustomerRealmRecoveryObjectStore(racingBucket(bucket, winner));
    await assert.rejects(store.put(bundle), (error: unknown) => error instanceof CustomerRealmPersistenceError
      && error.code === (kind === "wrong-digest" ? "recovery_digest_mismatch" : "recovery_invalid"));
    assert.equal(bucket.values.get(key), winner);
    assert.equal(bucket.writes.length, 1);
  });
}

test("an existing Recovery bundle is verified and retains its original serialized bytes on replay", async () => {
  const bundle = await recoveryBundle("installation:existing");
  const key = `anyam/customer-realm/recovery/v1/${bundle.integrity.digest}`;
  const retained = JSON.stringify(bundle, null, 2);
  const bucket = new ConditionalMemoryBucket();
  bucket.values.set(key, retained);
  const receipt = await new CustomerRealmRecoveryObjectStore(bucket).put(bundle);
  assert.equal(bucket.values.get(key), retained);
  assert.equal(receipt.bytes, Buffer.byteLength(retained));
  assert.match(receipt.receipt, /idempotent=true/);
});

for (const outcome of ["conditional-null", "acknowledged"] as const) {
  test(`a ${outcome} write without a readable Recovery object cannot report success`, async () => {
    const bundle = await recoveryBundle(`installation:missing-${outcome}`);
    let writes = 0;
    const bucket: CustomerRealmR2Bucket = {
      get: async () => null,
      put: async () => { writes++; return outcome === "conditional-null" ? null : {}; },
    };
    await assert.rejects(new CustomerRealmRecoveryObjectStore(bucket).put(bundle), (error: unknown) => error instanceof CustomerRealmPersistenceError && error.code === "recovery_not_found");
    assert.equal(writes, 1, "an unconfirmed write is not automatically retried");
  });
}

for (const boundary of ["put", "get", "body"] as const) {
  test(`a provider ${boundary} exception is a sanitized unconfirmed storage result with no retry`, async () => {
    const bundle = await recoveryBundle(`installation:provider-${boundary}`);
    let writes = 0;
    let reads = 0;
    const providerError = () => {
      const error = new Error("fixture-provider-secret");
      error.name = "fixture-provider-secret";
      return error;
    };
    const bucket: CustomerRealmR2Bucket = {
      put: async () => { writes++; if (boundary === "put") throw providerError(); return {}; },
      get: async () => {
        reads++;
        if (boundary === "get") throw providerError();
        return { arrayBuffer: async () => { throw providerError(); } };
      },
    };
    await assert.rejects(new CustomerRealmRecoveryObjectStore(bucket).put(bundle), (error: unknown) => {
      assert.ok(error instanceof CustomerRealmPersistenceError);
      assert.equal(error.code, "recovery_storage_unconfirmed");
      assert.equal(JSON.stringify(error.toJSON()).includes("fixture-provider-secret"), false);
      return true;
    });
    assert.equal(writes, 1);
    assert.equal(reads, boundary === "put" ? 0 : 1);
  });
}

test("caller mutation during storage does not alter verified Recovery payload or metadata", async () => {
  const bundle = await recoveryBundle("installation:mutable-input");
  const original = structuredClone(bundle);
  const bucket = new ConditionalMemoryBucket();
  const mutableBoundary: CustomerRealmR2Bucket = {
    put: (key, value, options) => bucket.put(key, value, options),
    get: async key => {
      Object.assign(bundle, { protocol: "fixture-caller-mutated-protocol", token: "fixture-caller-secret" });
      return bucket.get(key);
    },
  };
  const receipt = await new CustomerRealmRecoveryObjectStore(mutableBoundary).put(bundle);
  assert.equal(bucket.values.get(receipt.key), JSON.stringify(original));
  assert.deepEqual(bucket.writes[0]?.options?.customMetadata, { protocol: original.protocol, digest: original.integrity.digest, credentialFree: "true" });
  assert.equal(JSON.stringify(bucket.writes).includes("fixture-caller-secret"), false);
});

test("a serialization hook cannot introduce credential-bearing Recovery bytes before storage", async () => {
  const bundle = await recoveryBundle("installation:serialization-hook");
  const serialized = { ...structuredClone(bundle), token: "fixture-serialization-secret" };
  Object.defineProperty(bundle, "toJSON", { value: () => serialized });
  const bucket = new ConditionalMemoryBucket();
  await assert.rejects(new CustomerRealmRecoveryObjectStore(bucket).put(bundle), (error: unknown) => error instanceof CustomerRealmPersistenceError
    && error.code === "recovery_invalid"
    && !JSON.stringify(error.toJSON()).includes("fixture-serialization-secret"));
  assert.equal(bucket.writes.length, 0, "verify the exact serialized snapshot before calling storage");
  assert.equal(bucket.values.size, 0);
});

test("a stateful serialization hook is captured once and the exact stored snapshot is verified", async () => {
  const bundle = await recoveryBundle("installation:stateful-serialization-hook");
  const original = structuredClone(bundle);
  let serializations = 0;
  Object.defineProperty(bundle, "toJSON", { value: () => ++serializations === 1
    ? original : { ...original, token: "fixture-stateful-serialization-secret" } });
  const bucket = new ConditionalMemoryBucket();
  const receipt = await new CustomerRealmRecoveryObjectStore(bucket).put(bundle);
  assert.equal(serializations, 1);
  assert.equal(bucket.values.get(receipt.key), JSON.stringify(original));
  assert.equal(bucket.writes.length, 1);
  assert.equal(JSON.stringify(bucket.writes).includes("fixture-stateful-serialization-secret"), false);
});
