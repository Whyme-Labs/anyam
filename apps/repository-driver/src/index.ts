/// <reference types="@cloudflare/workers-types" />

import {
  parseRepositoryObservationRequest,
  repositoryObservationDigest,
  REPOSITORY_OBSERVATION_PROTOCOL,
  type RepositoryObservationRequest,
} from "../../../src/portability/repository-observation.ts";

export const REPOSITORY_DRIVER_PROTOCOL = "anyam.repository-driver/v1" as const;
export const REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL = "anyam.repository-driver-snapshot/v1" as const;
const OBSERVER_PROTOCOL_HEADER = "x-anyam-repository-observer-protocol";
const OBSERVER_PROTOCOL = "anyam.repository-observer/v1";

export type RepositoryDriverSnapshotManifest = {
  protocol: typeof REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL;
  repositoryId: string;
  sourceSpaceId: string;
  objectFormat: "sha1" | "sha256";
  symbolicRef: string;
  commitOid: string;
  treeOid: string;
  baseCommitOid: string;
  ancestorCommitOids: readonly string[];
  generation: string;
  state: "active" | "revoked" | "stale";
  observedAt: string;
  receipt: string;
};

export type Env = {
  /** Customer-owned R2 bucket containing signed/provider-produced snapshot manifests. */
  REPOSITORY_STATE?: R2Bucket;
  REPOSITORY_DRIVER_MANIFEST_PREFIX?: string;
  REPOSITORY_DRIVER_REQUEST_BYTES_LIMIT?: string;
  REPOSITORY_DRIVER_REQUEST_BYTES_RECEIPT?: string;
};

type ObjectRecord = Record<string, unknown>;

function object(value: unknown): ObjectRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function safeReceipt(value: unknown): string | undefined {
  const receipt = nonEmpty(value);
  if (!receipt || /(?:token|secret|password|authorization|private[_ -]?key)\s*[:=]/iu.test(receipt) || /\bBearer\s+\S+/iu.test(receipt) || /-----BEGIN [^-]+ PRIVATE KEY-----/u.test(receipt)) return undefined;
  return receipt;
}

function validOid(value: string, objectFormat: "sha1" | "sha256"): boolean {
  const expectedLength = objectFormat === "sha256" ? 64 : 40;
  return value.length === expectedLength && /^[0-9a-f]+$/u.test(value);
}

function configuration(env: Env): { bucket: R2Bucket; prefix: string; limit: number; receipt: string } {
  const bucket = env.REPOSITORY_STATE;
  const prefix = env.REPOSITORY_DRIVER_MANIFEST_PREFIX?.trim() || "repositories/";
  const limit = Number(env.REPOSITORY_DRIVER_REQUEST_BYTES_LIMIT);
  const receipt = safeReceipt(env.REPOSITORY_DRIVER_REQUEST_BYTES_RECEIPT);
  if (!bucket || typeof bucket.get !== "function") throw new Error("repository_driver_state_unconfigured");
  if (!Number.isSafeInteger(limit) || limit < 1 || !receipt || !/(?:receipt|measure|qualification)/iu.test(receipt)) throw new Error("repository_driver_configuration_invalid");
  return { bucket, prefix, limit, receipt };
}

async function readBoundedText(stream: ReadableStream<Uint8Array> | null | undefined, limit: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error(`repository_driver_body_budget_exceeded:limit=${limit}:asked=${bytes}`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function manifestKey(prefix: string, repositoryId: string): string {
  return `${prefix.replace(/\/?$/u, "/")}${encodeURIComponent(repositoryId)}.json`;
}

function parseManifest(value: unknown): RepositoryDriverSnapshotManifest | undefined {
  const record = object(value);
  const protocol = record?.protocol;
  const repositoryId = nonEmpty(record?.repositoryId);
  const sourceSpaceId = nonEmpty(record?.sourceSpaceId);
  const objectFormat = record?.objectFormat === "sha1" || record?.objectFormat === "sha256" ? record.objectFormat : undefined;
  const symbolicRef = nonEmpty(record?.symbolicRef);
  const commitOid = nonEmpty(record?.commitOid);
  const treeOid = nonEmpty(record?.treeOid);
  const baseCommitOid = nonEmpty(record?.baseCommitOid);
  const generation = nonEmpty(record?.generation);
  const state = record?.state === "active" || record?.state === "revoked" || record?.state === "stale" ? record.state : undefined;
  const observedAt = nonEmpty(record?.observedAt);
  const receipt = safeReceipt(record?.receipt);
  const ancestorsValue = record?.ancestorCommitOids;
  const ancestorCommitOids = Array.isArray(ancestorsValue) && ancestorsValue.every((entry) => nonEmpty(entry) !== undefined) ? ancestorsValue.map(nonEmpty).filter((entry): entry is string => entry !== undefined) : undefined;
  if (protocol !== REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL || !repositoryId || !sourceSpaceId || !objectFormat || !symbolicRef || !commitOid || !treeOid || !baseCommitOid || !generation || !state || !observedAt || !receipt || !ancestorCommitOids || !validOid(commitOid, objectFormat) || !validOid(treeOid, objectFormat) || !validOid(baseCommitOid, objectFormat) || ancestorCommitOids.some((entry) => !validOid(entry, objectFormat))) return undefined;
  return { protocol, repositoryId, sourceSpaceId, objectFormat, symbolicRef, commitOid, treeOid, baseCommitOid, ancestorCommitOids, generation, state, observedAt, receipt };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function failure(status: "blocked" | "unavailable", code: string, recoveryAction: string, receipt: string, httpStatus: number): Response {
  return json({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status, code, recoveryAction, receipt: `${receipt}; credentialMaterialStored=false`, credentialValues: "not-printed", canonicalWrite: false }, httpStatus);
}

function requestFailure(code: string, message: string, recoveryAction: string, receipt: string): Response {
  return failure("blocked", code, recoveryAction, `${message}; ${receipt}`, 422);
}

async function readRequest(request: Request, limit: number): Promise<RepositoryObservationRequest> {
  const bodyText = await readBoundedText(request.body, limit);
  let value: unknown;
  try {
    value = JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error(`repository_driver_request_malformed:limit=${limit}:asked=${new TextEncoder().encode(bodyText).byteLength}`);
  }
  const parsed = parseRepositoryObservationRequest(value);
  if (!parsed.valid) throw new Error(`${parsed.code}:${parsed.recoveryAction}`);
  return parsed.request;
}

async function observe(request: Request, env: Env, config: { bucket: R2Bucket; prefix: string; limit: number; receipt: string }): Promise<Response> {
  let observationRequest: RepositoryObservationRequest;
  try {
    observationRequest = await readRequest(request, config.limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : "repository_driver_request_invalid";
    const budget = message.startsWith("repository_driver_body_budget_exceeded:");
    return requestFailure(budget ? "request_budget_exceeded" : "request_malformed", budget ? "The RepositoryDriver request exceeded its configured body budget." : "The RepositoryDriver request is not a valid observation request.", budget ? "reduce the request to the measured driver budget or remeasure the tripwire before changing it" : "send one anyam.repository-observation/v1 request object", `${message}; requestBudget=${config.limit}; sizingReceipt=${config.receipt}`);
  }
  const key = manifestKey(config.prefix, observationRequest.repositoryId);
  let manifestObject: R2ObjectBody | null;
  try {
    manifestObject = await config.bucket.get(key);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "r2-read-failed";
    return failure("unavailable", "repository_driver_state_unavailable", "retry the same immutable observation after the customer R2 state is available", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; key=${key}; state=unavailable; error=${detail}; providerMutation=false`, 503);
  }
  if (!manifestObject) return failure("unavailable", "repository_not_found", "restore or publish the exact customer Repository snapshot manifest before observing it", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${observationRequest.repositoryId}; state=deleted-or-not-published; providerMutation=false`, 503);
  let manifest: RepositoryDriverSnapshotManifest | undefined;
  try {
    manifest = parseManifest(JSON.parse(await readBoundedText(manifestObject.body, config.limit)) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : "manifest-invalid";
    const budget = message.startsWith("repository_driver_body_budget_exceeded:");
    return failure("unavailable", budget ? "repository_driver_state_budget_exceeded" : "repository_driver_state_invalid", budget ? "reduce the stored snapshot manifest or remeasure the driver response tripwire" : "repair or republish the customer snapshot manifest and retry the same observation", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${observationRequest.repositoryId}; state=invalid; error=${message}; requestBudget=${config.limit}; sizingReceipt=${config.receipt}`, 502);
  }
  if (!manifest) return failure("unavailable", "repository_driver_state_invalid", "repair or republish the customer snapshot manifest with the supported protocol and complete Git identities", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${observationRequest.repositoryId}; state=invalid; providerMutation=false`, 502);
  if (manifest.repositoryId !== observationRequest.repositoryId || manifest.sourceSpaceId !== observationRequest.sourceSpaceId) return failure("blocked", "repository_driver_identity_mismatch", "publish a snapshot manifest bound to the exact Repository and Source Space requested by the Realm", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${observationRequest.repositoryId}; state=identity-mismatch; providerMutation=false`, 409);
  if (manifest.state === "revoked") return failure("blocked", "repository_driver_installation_revoked", "restore the customer provider installation and publish a fresh active snapshot before retrying", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${manifest.repositoryId}; installation=revoked; generation=${manifest.generation}; providerMutation=false`, 409);
  if (manifest.state === "stale") return failure("blocked", "repository_driver_snapshot_stale", "reinspect the provider and publish a fresh active snapshot before retrying", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${manifest.repositoryId}; snapshot=stale; generation=${manifest.generation}; providerMutation=false`, 409);
  const mismatches: string[] = [];
  if (manifest.objectFormat !== (observationRequest.expectedObjectFormat ?? manifest.objectFormat)) mismatches.push("objectFormat");
  if (manifest.commitOid !== observationRequest.expectedCommitOid) mismatches.push("commitOid");
  if (observationRequest.expectedTreeOid !== undefined && manifest.treeOid !== observationRequest.expectedTreeOid) mismatches.push("treeOid");
  if (manifest.baseCommitOid !== observationRequest.expectedBaseCommitOid) mismatches.push("baseCommitOid");
  if (!manifest.ancestorCommitOids.includes(observationRequest.expectedBaseCommitOid) && manifest.commitOid !== observationRequest.expectedBaseCommitOid) mismatches.push("ancestry");
  if (mismatches.length > 0) return failure("blocked", "repository_driver_snapshot_mismatch", "inspect the exact provider head, tree, base, object format, and ancestry; publish a new immutable snapshot before retrying", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${manifest.repositoryId}; generation=${manifest.generation}; mismatch=${mismatches.join(",")}; providerMutation=false`, 409);
  const claims = { protocol: REPOSITORY_OBSERVATION_PROTOCOL, repositoryId: manifest.repositoryId, sourceSpaceId: manifest.sourceSpaceId, workspaceId: observationRequest.workspaceId, projectViewId: observationRequest.projectViewId, objectFormat: manifest.objectFormat, symbolicRef: manifest.symbolicRef, commitOid: manifest.commitOid, treeOid: manifest.treeOid, baseCommitOid: observationRequest.expectedBaseCommitOid, ancestryVerified: true as const, observedAt: manifest.observedAt, receipt: `provider=anyam-r2-snapshot; repository=${manifest.repositoryId}; generation=${manifest.generation}; sourceReceipt=${manifest.receipt}; credentialMaterialStored=false` };
  const manifestDigest = await repositoryObservationDigest(claims);
  return json({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "succeeded", observation: { ...claims, manifestDigest }, receipt: `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${manifest.repositoryId}; generation=${manifest.generation}; ancestry=verified; providerMutation=false; requestBudget=${config.limit}; sizingReceipt=${config.receipt}; credentialMaterialStored=false`, credentialValues: "not-printed", canonicalWrite: false });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      const config = configuration(env);
      if (url.pathname === "/health" && request.method === "GET") return json({ protocol: REPOSITORY_DRIVER_PROTOCOL, status: "ready", state: "r2-snapshot-driver", credentialValues: "not-printed", canonicalWrite: false, receipt: `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; state=ready; storage=r2; providerCredentials=not-held; requestBudget=${config.limit}; sizingReceipt=${config.receipt}; credentialMaterialStored=false` });
      if (url.pathname !== "/observe") return json({ protocol: REPOSITORY_DRIVER_PROTOCOL, status: "blocked", code: "not_found", recoveryAction: "use POST /observe through the private RepositoryObserver service binding", receipt: "repositoryDriver=route-not-found; credentialMaterialStored=false", credentialValues: "not-printed", canonicalWrite: false }, 404);
      if (request.method !== "POST") return json({ protocol: REPOSITORY_DRIVER_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: "use POST /observe", receipt: "repositoryDriver=post-required; credentialMaterialStored=false", credentialValues: "not-printed", canonicalWrite: false }, 405);
      if (request.headers.get(OBSERVER_PROTOCOL_HEADER) !== OBSERVER_PROTOCOL) return requestFailure("observer_protocol_required", "The RepositoryDriver only accepts requests from the qualified RepositoryObserver service binding.", "route the request through the private RepositoryObserver binding; no provider observation was attempted", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; serviceBinding=observer-required; providerInvocation=false`);
      return await observe(request, env, config);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "repository-driver-failed";
      return failure("blocked", "configuration_invalid", "repair the customer RepositoryDriver configuration and retry the same immutable observation", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; error=${detail}; providerInvocation=false`, 503);
    }
  },
};
