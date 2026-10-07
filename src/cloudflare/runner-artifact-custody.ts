import { createHash } from "node:crypto";
import type { RunnerJob, RunnerOutputReference } from "../kernel/contracts.ts";

export type RunnerArtifactObject = { arrayBuffer(): Promise<ArrayBuffer> };
export type RunnerArtifactSource = { get(key: string): Promise<RunnerArtifactObject | null> };
export type RunnerArtifactStore = RunnerArtifactSource & {
  put(key: string, bytes: ArrayBuffer, options: { onlyIf: { etagDoesNotMatch: "*" }; sha256: string }): Promise<unknown>;
};

/** Customer bindings are supplied by the Realm, never by the signed Result. */
export type RunnerArtifactCustody = { source: RunnerArtifactSource | undefined; destination: RunnerArtifactStore | undefined };

export class RunnerArtifactCustodyError extends Error {
  constructor(readonly code: "blocked" | "conflict" | "indeterminate", readonly reason: string) {
    super(`Runner Artifact byte custody is ${reason}.`);
    this.name = "RunnerArtifactCustodyError";
  }
}

function conflict(reason: string): never { throw new RunnerArtifactCustodyError("conflict", reason); }
function unavailable(reason: string): never { throw new RunnerArtifactCustodyError("indeterminate", reason); }
function canonicalKey(key: string): boolean {
  return key.length > 0 && !key.startsWith("/") && !key.includes("\\") && !/^[A-Za-z]:\//u.test(key)
    && key.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}
function digest(bytes: ArrayBuffer): string {
  return `sha256:${createHash("sha256").update(new Uint8Array(bytes)).digest("hex")}`;
}
async function read(store: RunnerArtifactSource, key: string, boundary: "source" | "destination"): Promise<ArrayBuffer | null> {
  try {
    const object = await store.get(key);
    return object ? await object.arrayBuffer() : null;
  } catch {
    unavailable(`${boundary}-read-unconfirmed`);
  }
}

/** Called only after Authority verifies the enrolled signature and exact Run,
 * Attempt, input, output and disclosure closure. R2 writes precede Authority
 * commit: an interrupted transition may leave reusable bytes, never new
 * authoritative metadata. Digest keys are conditionally created, not replaced.
 */
export async function retainRunnerArtifacts(job: RunnerJob, outputs: readonly RunnerOutputReference[], custody: RunnerArtifactCustody): Promise<string> {
  const artifacts = outputs.filter(output => output.kind === "artifact");
  if (artifacts.length === 0) return "artifactByteCustody=not-required; artifactBytes=0";
  if (!custody.source || !custody.destination) throw new RunnerArtifactCustodyError("blocked", "bindings-unconfigured");
  for (const output of artifacts) {
    const root = job.outputLocations.artifacts;
    if (!canonicalKey(root) || !canonicalKey(output.location) || !output.location.startsWith(`${root}/`)
      || !output.location.slice(root.length + 1).split("/").includes(output.attemptId)
      || output.attemptId !== job.currentAttemptId || output.runId !== job.runId) conflict("output-scope-mismatch");
    if (!/^sha256:[a-f0-9]{64}$/u.test(output.digest)) conflict("digest-format-invalid");
  }
  let byteCount = 0;
  for (const output of artifacts) {
    const source = await read(custody.source, output.location, "source");
    if (source === null) conflict("source-object-missing");
    if (digest(source) !== output.digest) conflict("source-digest-mismatch");
    const key = `artifacts/${output.digest}`;
    const existing = await read(custody.destination, key, "destination");
    if (existing !== null && digest(existing) !== output.digest) conflict("destination-digest-mismatch");
    if (existing === null) {
      try {
        await custody.destination.put(key, source, { onlyIf: { etagDoesNotMatch: "*" }, sha256: output.digest.slice("sha256:".length) });
      } catch {
        unavailable("destination-write-unconfirmed");
      }
      const retained = await read(custody.destination, key, "destination");
      if (retained === null) unavailable("destination-object-unconfirmed");
      if (digest(retained) !== output.digest) conflict("destination-digest-mismatch");
    }
    byteCount += source.byteLength;
  }
  return `artifactByteCustody=realm-verified; artifactReferences=${artifacts.length}; artifactBytes=${byteCount}; artifactStorage=digest-addressed; artifactOverwrite=false`;
}
