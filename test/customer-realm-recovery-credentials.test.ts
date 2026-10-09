import assert from "node:assert/strict";
import test from "node:test";
import {
  CustomerRealmInstallation,
  CustomerRealmInstallationError,
  InMemoryCustomerRealmCloudflareAdapter,
  InMemoryCustomerRealmProjectImporter,
  customerRealmRecoveryBundleDigest,
  verifyCustomerRealmRecoveryBundle,
  type CustomerRealmInstallationStore,
  type CustomerRealmRecoveryBundle,
} from "../src/installation/customer-realm.ts";
import {
  CustomerRealmPersistenceError,
  CustomerRealmRecoveryObjectStore,
  type CustomerRealmR2Bucket,
} from "../src/cloudflare/customer-realm-persistence.ts";
import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL } from "../src/security/credential-material.ts";

const SYNTHETIC_MATERIAL = "fixture-only-recovery-material-388";
const importer = () => new InMemoryCustomerRealmProjectImporter({ projectRevisionId: "unused", sourceSpaceIds: [], exportDigest: "unused", checkpointId: "unused", state: "verified", partialEffects: [], receipt: "unused" });
const installationId = "installation:recovery-credential-check";
function installation(store?: CustomerRealmInstallationStore) {
  return new CustomerRealmInstallation({ installationId, cloudflare: new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]), importer: importer(), now: () => new Date("2026-08-03T00:00:00Z"), ...(store ? { store } : {}) });
}
const installed = installation();
await installed.install({ accountId: "account:customer", requestedResourceTypes: ["r2"], ownerConfirmed: true, operationId: "operation:credential-check", idempotencyKey: "idempotency:credential-check" });
const original = await installed.exportRecovery({});

function withPayload(payload: Record<string, unknown>): CustomerRealmRecoveryBundle {
  const bundle = { ...structuredClone(original), ...payload };
  bundle.integrity.digest = customerRealmRecoveryBundleDigest(bundle);
  return bundle;
}

class ObservedBucket implements CustomerRealmR2Bucket {
  readonly values = new Map<string, string>();
  writes = 0;
  reads = 0;
  async put(key: string, value: string, options: Parameters<CustomerRealmR2Bucket["put"]>[2]): Promise<object | null> {
    assert.deepEqual(options.onlyIf, { etagDoesNotMatch: "*" });
    this.writes++;
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return {};
  }
  async get(key: string): ReturnType<CustomerRealmR2Bucket["get"]> {
    this.reads++;
    const value = this.values.get(key);
    return value === undefined ? null : { arrayBuffer: async () => new TextEncoder().encode(value).buffer };
  }
}

const cases: { name: string; payload: Record<string, unknown> }[] = [
  { name: "apiKey", payload: { apiKey: SYNTHETIC_MATERIAL } },
  { name: "accessToken", payload: { accessToken: SYNTHETIC_MATERIAL } },
  { name: "upper case and underscore", payload: { API_KEY: SYNTHETIC_MATERIAL } },
  { name: "hyphenated access token", payload: { "Access-Token": SYNTHETIC_MATERIAL } },
  { name: "mixed case and punctuation", payload: { "aPi.KeY": SYNTHETIC_MATERIAL } },
  { name: "NFKC fullwidth alias", payload: { "ＡＰＩ＿ＫＥＹ": SYNTHETIC_MATERIAL } },
  { name: "nested object", payload: { extensions: { connection: { client_secret: SYNTHETIC_MATERIAL } } } },
  { name: "nested array", payload: { extensions: [{ connection: { refreshToken: SYNTHETIC_MATERIAL } }] } },
  { name: "untrusted diagnostic path", payload: { bundleId: SYNTHETIC_MATERIAL, extensions: { [SYNTHETIC_MATERIAL]: { apiKey: SYNTHETIC_MATERIAL } } } },
  { name: "authorization text", payload: { notes: `Authorization: Bearer ${SYNTHETIC_MATERIAL}` } },
  { name: "assignment text", payload: { notes: `api_key=${SYNTHETIC_MATERIAL}` } },
  { name: "URI encoded text", payload: { notes: encodeURIComponent(`access_token=${SYNTHETIC_MATERIAL}`) } },
  { name: "Base64 encoded text", payload: { notes: Buffer.from(`api_key=${SYNTHETIC_MATERIAL}`).toString("base64") } },
  { name: "userinfo URL", payload: { notes: `https://fixture-user:${SYNTHETIC_MATERIAL}@fixture.invalid/` } },
  { name: "private key text", payload: { notes: `-----BEGIN PRIVATE KEY-----\n${SYNTHETIC_MATERIAL}\n-----END PRIVATE KEY-----` } },
  { name: "sensitive key with object value", payload: { PRIVATE_KEY: { material: SYNTHETIC_MATERIAL } } },
  { name: "sensitive key with null value", payload: { apiKey: null } },
];

for (const { name, payload } of cases) {
  test(`Recovery rejects supported ${name} material before persistence or restore`, async () => {
    const bundle = withPayload(payload);
    const verification = verifyCustomerRealmRecoveryBundle(bundle);
    assert.equal(verification.status, "failed");
    assert.match(verification.errors.join("; "), /known credential material/);
    assert.equal(verification.credentialMaterialCheck.status, "detected");
    assert.equal(verification.credentialMaterialCheck.scope, "known-patterns");
    assert.equal(verification.credentialMaterialCheck.exhaustive, false);
    assert.equal(JSON.stringify(verification).includes(SYNTHETIC_MATERIAL), false);

    const bucket = new ObservedBucket();
    const objects = new CustomerRealmRecoveryObjectStore(bucket);
    await assert.rejects(objects.put(bundle), (error: unknown) => error instanceof CustomerRealmPersistenceError
      && error.code === "recovery_invalid" && !JSON.stringify(error.toJSON()).includes(SYNTHETIC_MATERIAL));
    assert.equal(bucket.writes, 0);
    assert.equal(bucket.reads, 0, "rejected input never reaches the storage boundary");

    const key = `anyam/customer-realm/recovery/v1/${bundle.integrity.digest}`;
    const retained = JSON.stringify(bundle);
    bucket.values.set(key, retained); // Owned read-denial fixture only.
    await assert.rejects(objects.get(bundle.integrity.digest), (error: unknown) => error instanceof CustomerRealmPersistenceError
      && error.code === "recovery_invalid" && !JSON.stringify(error.toJSON()).includes(SYNTHETIC_MATERIAL));
    assert.equal(bucket.values.get(key), retained);
    assert.equal(bucket.writes, 0, "a rejected read does not repair or delete retained bytes");

    let stateWrites = 0;
    const restored = installation({ load: async () => undefined, save: async () => { stateWrites++; } });
    const before = restored.snapshot;
    await assert.rejects(restored.restoreRecovery(bundle), (error: unknown) => error instanceof CustomerRealmInstallationError
      && error.code === "recovery_invalid" && !JSON.stringify(error.toJSON()).includes(SYNTHETIC_MATERIAL));
    assert.deepEqual(restored.snapshot, before);
    assert.equal(stateWrites, 0);
  });
}

test("ordinary Recovery exports report the scanner's bounded scope and still restore into quarantine", async () => {
  const verification = verifyCustomerRealmRecoveryBundle(original);
  assert.equal(verification.status, "verified");
  assert.deepEqual(verification.credentialMaterialCheck, { scannerProtocol: CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, scope: "known-patterns", status: "not-detected", exhaustive: false });
  assert.match(verification.receipt, /credentialFreeDeclared=true/);
  assert.match(verification.receipt, /credentialScanScope=known-patterns; exhaustive=false/);
  assert.match(original.integrity.receipt, /credentialScanScope=known-patterns; exhaustive=false/);

  const bucket = new ObservedBucket();
  const receipt = await new CustomerRealmRecoveryObjectStore(bucket).put(original);
  assert.equal(receipt.credentialFree, true, "the existing declaration is retained for compatibility");
  assert.deepEqual(receipt.credentialMaterialCheck, verification.credentialMaterialCheck);
  assert.match(receipt.receipt, /credentialScanScope=known-patterns; exhaustive=false/);
  assert.equal((await installation().restoreRecovery(original)).phase, "recovery-pending");
});

test("known redaction markers and ordinary credential metadata remain valid controls", () => {
  const bundle = withPayload({ metadata: { token: "redacted", API_KEY: "not-issued", accessToken: "NONE", credentialFree: true, credentialsStored: false, apiKeyId: "key-id:reference-only" } });
  assert.equal(verifyCustomerRealmRecoveryBundle(bundle).status, "verified");
});

test("unknown opaque data is explicitly not assessed as universal secret absence", async () => {
  const bundle = withPayload({ opaqueMetadata: SYNTHETIC_MATERIAL });
  const verification = verifyCustomerRealmRecoveryBundle(bundle);
  assert.equal(verification.status, "verified");
  assert.equal(verification.credentialMaterialCheck.status, "not-detected");
  assert.equal(verification.credentialMaterialCheck.exhaustive, false);
  const bucket = new ObservedBucket();
  const receipt = await new CustomerRealmRecoveryObjectStore(bucket).put(bundle);
  assert.equal(receipt.credentialMaterialCheck.exhaustive, false);
  assert.equal(JSON.parse(bucket.values.get(receipt.key)!).opaqueMetadata, SYNTHETIC_MATERIAL);
});
