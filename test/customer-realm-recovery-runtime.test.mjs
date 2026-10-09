import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { CustomerRealmPersistenceError, CustomerRealmRecoveryObjectStore } from "../src/cloudflare/customer-realm-persistence.ts";
import { CustomerRealmInstallation, InMemoryCustomerRealmCloudflareAdapter, InMemoryCustomerRealmProjectImporter } from "../src/installation/customer-realm.ts";

async function recoveryBundle(installationId) {
  const installation = new CustomerRealmInstallation({
    installationId,
    cloudflare: new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]),
    importer: new InMemoryCustomerRealmProjectImporter({ projectRevisionId: "unused", sourceSpaceIds: [], exportDigest: "unused", checkpointId: "unused", state: "verified", partialEffects: [], receipt: "unused" }),
    now: () => new Date("2026-08-03T00:00:00Z"),
  });
  await installation.install({ accountId: "account:customer", requestedResourceTypes: ["r2"], ownerConfirmed: true, operationId: `operation:${installationId}`, idempotencyKey: `idempotency:${installationId}` });
  return installation.exportRecovery({});
}

// As with the other Miniflare runtime tests, .mjs keeps the pinned alpha's
// internal declaration surface out of the framework-neutral TypeScript gate.
// Production adapter code runs against an actual owned local R2 binding;
// provisioning/identity fixtures do not qualify live customer account access.
test("Recovery immutable creation and denial use actual local R2 with isolated storage", async t => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-recovery-r2-"));
  let runtime;
  try {
    const options = convertV4MiniflareOptions({
      name: "recovery-objects-owned-local",
      modules: true,
      script: "export default { fetch() { return new Response('owned local fixture'); } };",
      compatibilityDate: "2026-10-03",
      r2Buckets: { RECOVERY: "owned-recovery-objects" },
      outboundService: () => new Response("outbound disabled", { status: 403 }),
    });
    options.telemetry = { enabled: false };
    options.resourcePersistencePath = join(directory, "storage");
    runtime = new Miniflare(options);
    await runtime.ready;
    const bucket = await runtime.getR2Bucket("RECOVERY");

    await t.test("create, read-back and same-digest replay preserve actual bytes and metadata", async () => {
      const bundle = await recoveryBundle("installation:r2-create");
      const store = new CustomerRealmRecoveryObjectStore(bucket);
      const created = await store.put(bundle);
      const original = await bucket.get(created.key);
      assert.ok(original);
      const retained = await original.text();
      assert.equal(retained, JSON.stringify(bundle));
      assert.equal(created.bytes, Buffer.byteLength(retained));
      assert.deepEqual(original.customMetadata, { protocol: bundle.protocol, digest: created.digest, credentialFree: "true", credentialScanner: "anyam.credential-material-scanner/v1", credentialScanScope: "known-patterns", credentialScanExhaustive: "false" });
      assert.deepEqual(await store.get(created.digest), bundle);
      assert.match((await store.put(bundle)).receipt, /idempotent=true/);
      assert.equal(await (await bucket.get(created.key)).text(), retained);
    });

    await t.test("two concurrent writers produce one conditional-null result and two verified receipts", async () => {
      const bundle = await recoveryBundle("installation:r2-concurrent");
      const outcomes = [];
      const port = {
        get: key => bucket.get(key),
        put: async (key, value, options) => {
          assert.deepEqual(options.onlyIf, { etagDoesNotMatch: "*" });
          const result = await bucket.put(key, value, options);
          outcomes.push(result === null ? "existing" : "created");
          return result;
        },
      };
      const receipts = await Promise.all([new CustomerRealmRecoveryObjectStore(port).put(bundle), new CustomerRealmRecoveryObjectStore(port).put(bundle)]);
      assert.deepEqual(outcomes.sort(), ["created", "existing"]);
      assert.equal(receipts[0].key, receipts[1].key);
      assert.equal(receipts.filter(receipt => receipt.receipt.includes("idempotent=true")).length, 1);
      assert.equal(await (await bucket.get(receipts[0].key)).text(), JSON.stringify(bundle));
    });

    for (const kind of ["valid", "wrong-digest", "malformed", "credential-bearing"]) {
      await t.test(`a ${kind} racing object is preserved by actual R2 conditional creation`, async () => {
        const bundle = await recoveryBundle(`installation:r2-race-${kind}`);
        const key = `anyam/customer-realm/recovery/v1/${bundle.integrity.digest}`;
        const winner = kind === "valid" ? JSON.stringify(bundle, null, 2)
          : kind === "wrong-digest" ? JSON.stringify(await recoveryBundle("installation:r2-other-winner"))
          : kind === "malformed" ? "not JSON" : JSON.stringify({ ...bundle, token: "fixture-credential-marker" });
        let writes = 0;
        const port = {
          get: requested => bucket.get(requested),
          put: async (requested, payload, options) => {
            writes++;
            assert.equal(await bucket.get(requested), null);
            await bucket.put(requested, winner); // Owned race injection only.
            const result = await bucket.put(requested, payload, options);
            assert.equal(result, null, "the real provider precondition preserves the winner");
            return result;
          },
        };
        const store = new CustomerRealmRecoveryObjectStore(port);
        if (kind === "valid") {
          const receipt = await store.put(bundle);
          assert.equal(receipt.bytes, Buffer.byteLength(winner));
          assert.match(receipt.receipt, /idempotent=true/);
          assert.deepEqual(await store.get(receipt.digest), bundle);
        } else {
          await assert.rejects(store.put(bundle), error => error instanceof CustomerRealmPersistenceError
            && error.code === (kind === "wrong-digest" ? "recovery_digest_mismatch" : "recovery_invalid"));
        }
        assert.equal(await (await bucket.get(key)).text(), winner);
        assert.equal(writes, 1);
      });
    }
  } finally {
    try {
      await runtime?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
