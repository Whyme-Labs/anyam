import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { AnyamRealmCoordinator, type Env } from "../../apps/realm-worker/src/index.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../../apps/realm-worker/src/coordinator-protocol.ts";
import { runnerResultMessage } from "../../src/execution/runner.ts";
import type { RunnerArtifactStore } from "../../src/cloudflare/runner-artifact-custody.ts";
import type { AuthorityPlaneSnapshot } from "../../src/cloudflare/authority-plane.ts";
import { setup, makeRunner, runnerSession } from "../realm-artifact-handoff-fixture.ts";

export const artifactBytes = Buffer.from("export default { fetch() { return new Response('retained artifact'); } };\n");
export const sensitiveFailure = "SYNTHETIC-PROVIDER-PRIVATE-ERROR";
export const sha256 = (bytes: Uint8Array | ArrayBuffer) => `sha256:${createHash("sha256").update(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).digest("hex")}`;

function store() {
  const objects = new Map<string, Buffer>();
  const calls: Array<["get", string] | ["put", string, Parameters<RunnerArtifactStore["put"]>[2]]> = [];
  return {
    objects, calls,
    async get(key: string) { calls.push(["get", key]); const body = objects.get(key); return body === undefined ? null : { async arrayBuffer() { return Uint8Array.from(body).buffer; } }; },
    async put(key: string, body: ArrayBuffer, options: Parameters<RunnerArtifactStore["put"]>[2]) {
      calls.push(["put", key, options]);
      if (options.onlyIf.etagDoesNotMatch === "*" && objects.has(key)) return null;
      objects.set(key, Buffer.from(body)); return { key };
    },
  } satisfies RunnerArtifactStore;
}

type Persist = (previous: AuthorityPlaneSnapshot, next: AuthorityPlaneSnapshot) => Promise<void>;

/** Node-only bindings and authentication/persistence fixtures. The caller
 * installs constructor shims before importing this module. Actual Realm fetch,
 * Authority proof/closure, custody and gate ordering execute unchanged. */
export async function createRealmArtifactHandoffFixture({ configured = true, outputs = true, runStatus = "succeeded" }: { configured?: boolean; outputs?: boolean; runStatus?: "succeeded" | "failed" | "indeterminate" } = {}) {
  const authority = setup(); const runner = makeRunner(authority.input, authority.runId);
  const result = structuredClone(runner.result);
  result.status = runStatus; result.output.status = runStatus; result.output.exitCode = runStatus === "succeeded" ? 0 : 1;
  result.output.outputDigest = sha256(artifactBytes); result.output.outputDigests = [`dist/result.txt=${sha256(artifactBytes)}`];
  result.outputs = outputs ? result.outputs.map(output => ({ ...output, digest: sha256(artifactBytes) })) : [];
  result.signature = sign(null, Buffer.from(runnerResultMessage(result)), runner.keys.privateKey).toString("base64url");
  const completion = runner.runner.submit({ credential: runner.lease.credential, result });
  authority.authority.registerRunnerProfile(runner.profile, runnerSession);
  let state = authority.authority.snapshot();
  const source = store(); const destination = store(); const records = new Map<string, unknown>(); let commits = 0;
  for (const output of completion.outputs) source.objects.set(output.location, artifactBytes);
  let chain = Promise.resolve();
  const ctx = { storage: { async get<T>(key: string): Promise<T | undefined> { return records.get(key) as T | undefined; } }, blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const operation = chain.then(callback); chain = operation.then(() => undefined, () => undefined); return operation;
  } };
  const bindings: Pick<Env, "ANYAM_RUNNER_OUTPUTS" | "ANYAM_PROMOTION_ARTIFACTS"> = configured ? {
    // These casts substitute minimal owned R2/DO bindings only. No live R2 or
    // SQLite behavior is emulated or claimed by the Node test boundary.
    ANYAM_RUNNER_OUTPUTS: source as unknown as R2Bucket,
    ANYAM_PROMOTION_ARTIFACTS: destination as unknown as R2Bucket,
  } : {};
  const worker = new AnyamRealmCoordinator(ctx as unknown as DurableObjectState, bindings as Env);
  let authorityReader = async () => structuredClone(state);
  let persist: Persist = async (_previous, next) => { if (next.version !== state.version) commits += 1; state = structuredClone(next); };
  // Reflect touches only documented fixture substitutions for private methods;
  // typed callback controls prevent tests from replacing the real fetch route.
  Reflect.set(worker, "requireIdentity", () => ({ realm: { id: state.realmId }, getRecoverySnapshot: () => ({ realm: { id: state.realmId, authorizationEpoch: 4 } }), containsKnownCredentialMaterial: () => false }));
  Reflect.set(worker, "authoritySnapshot", () => authorityReader());
  Reflect.set(worker, "persistAuthoritySnapshot", (previous: AuthorityPlaneSnapshot, next: AuthorityPlaneSnapshot) => persist(previous, next));
  const body: { idempotencyKey: string; completion: typeof completion; expectedVersion?: number } = { idempotencyKey: "realm:artifact-handoff", completion };
  const invoke = async (value = body, internal = true) => {
    const response = await worker.fetch(new Request("https://realm/authority/runner-complete/internal", { method: "POST", headers: { "content-type": "application/json", ...(internal ? { [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE } : {}) }, body: JSON.stringify(value) }));
    const valueResult: unknown = await response.json(); assert.doesNotMatch(JSON.stringify(valueResult), new RegExp(sensitiveFailure));
    return { status: response.status, value: valueResult };
  };
  return { authority, runner, source, destination, body, completion, invoke, snapshot: () => structuredClone(state), commits: () => commits,
    getPersistence: () => persist, setPersistence: (replacement: Persist) => { persist = replacement; },
    setAuthorityReader: (replacement: () => Promise<AuthorityPlaneSnapshot>) => { authorityReader = replacement; } };
}
