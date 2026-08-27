/// <reference types="@cloudflare/workers-types" />

import {
  parseRepositoryObservationRequest,
  repositoryObservationDigest,
  REPOSITORY_OBSERVATION_PROTOCOL,
  type RepositoryObservationRequest,
} from "../../../src/portability/repository-observation.ts";

export const REPOSITORY_DRIVER_PROTOCOL = "anyam.repository-driver/v1" as const;
export const REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL = "anyam.repository-driver-snapshot/v2" as const;
export const REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL = "anyam.repository-driver-snapshot-index/v1" as const;
const OBSERVER_PROTOCOL_HEADER = "x-anyam-repository-observer-protocol";
const OBSERVER_PROTOCOL = "anyam.repository-observer/v1";

export type RepositoryDriverSnapshotWorkspaceContext = {
  kind: "workspace";
  workspaceId: string;
  projectViewId: string;
  workspaceRef: string;
};

export type RepositoryDriverSnapshotMirrorContext = {
  kind: "mirror";
  mirrorId: string;
  proposalKey: string;
  deliveryId: string;
};

export type RepositoryDriverSnapshotContext = RepositoryDriverSnapshotWorkspaceContext | RepositoryDriverSnapshotMirrorContext;

export type RepositoryDriverSnapshotManifest = {
  protocol: typeof REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL;
  repositoryId: string;
  sourceSpaceId: string;
  context: RepositoryDriverSnapshotContext;
  objectFormat: "sha1" | "sha256";
  symbolicRef: string;
  commitOid: string;
  treeOid: string;
  baseCommitOid: string;
  ancestorCommitOids: readonly string[];
  generation: number;
  state: "active" | "revoked" | "stale";
  observedAt: string;
  expiresAt: string;
  receipt: string;
};

export type RepositoryDriverSnapshotIndex = {
  protocol: typeof REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL;
  repositoryId: string;
  sourceSpaceId: string;
  context: RepositoryDriverSnapshotContext;
  latestGeneration: number;
  previousGeneration: number | null;
  latestManifestKey: string;
  latestManifestDigest: string;
  updatedAt: string;
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
type DriverConfiguration = { bucket: R2Bucket; prefix: string; limit: number; receipt: string };

function object(value: unknown): ObjectRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const SENSITIVE_KEY_PATTERN = /^(?:token|secret|password|authorization|private[_ -]?key)$/iu;
const CREDENTIAL_TEXT_PATTERN = /(?:\b(?:token|secret|password|authorization|private[_ -]?key)\b["']?\s*[:=]\s*|\bBearer\s+\S+|-----BEGIN [^-]+ PRIVATE KEY-----)/iu;

function containsCredentialMaterial(value: unknown): boolean {
  if (typeof value === "string") return CREDENTIAL_TEXT_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => {
    if (SENSITIVE_KEY_PATTERN.test(key) && typeof entry === "string" && entry !== "not-printed" && entry !== "not-issued") return true;
    return containsCredentialMaterial(entry);
  });
}

function safeReceipt(value: unknown): string | undefined {
  const receipt = nonEmpty(value);
  if (!receipt || containsCredentialMaterial(receipt)) return undefined;
  return receipt;
}

function validOid(value: string, objectFormat: "sha1" | "sha256"): boolean {
  const expectedLength = objectFormat === "sha256" ? 64 : 40;
  return value.length === expectedLength && /^[0-9a-f]+$/u.test(value);
}

function timestamp(value: unknown): { value: string; milliseconds: number } | undefined {
  const normalized = nonEmpty(value);
  if (!normalized) return undefined;
  if (!normalized.endsWith("Z")) return undefined;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? { value: normalized, milliseconds } : undefined;
}

function parseContext(value: unknown): RepositoryDriverSnapshotContext | undefined {
  const record = object(value);
  if (!record) return undefined;
  const kind = record.kind;
  if (kind === "workspace") {
    const workspaceId = nonEmpty(record.workspaceId);
    const projectViewId = nonEmpty(record.projectViewId);
    const workspaceRef = nonEmpty(record.workspaceRef);
    if (!workspaceId || !projectViewId || !workspaceRef) return undefined;
    return { kind, workspaceId, projectViewId, workspaceRef };
  }
  if (kind === "mirror") {
    const mirrorId = nonEmpty(record.mirrorId);
    const proposalKey = nonEmpty(record.proposalKey);
    const deliveryId = nonEmpty(record.deliveryId);
    if (!mirrorId || !proposalKey || !deliveryId) return undefined;
    return { kind, mirrorId, proposalKey, deliveryId };
  }
  return undefined;
}

function sameContext(left: RepositoryDriverSnapshotContext, right: RepositoryDriverSnapshotContext): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "workspace" && right.kind === "workspace") return left.workspaceId === right.workspaceId && left.projectViewId === right.projectViewId && left.workspaceRef === right.workspaceRef;
  if (left.kind === "mirror" && right.kind === "mirror") return left.mirrorId === right.mirrorId && left.proposalKey === right.proposalKey && left.deliveryId === right.deliveryId;
  return false;
}

function parseManifest(value: unknown): RepositoryDriverSnapshotManifest | undefined {
  const record = object(value);
  const protocol = record?.protocol;
  const repositoryId = nonEmpty(record?.repositoryId);
  const sourceSpaceId = nonEmpty(record?.sourceSpaceId);
  const context = parseContext(record?.context);
  const objectFormat = record?.objectFormat === "sha1" || record?.objectFormat === "sha256" ? record.objectFormat : undefined;
  const symbolicRef = nonEmpty(record?.symbolicRef);
  const commitOid = nonEmpty(record?.commitOid);
  const treeOid = nonEmpty(record?.treeOid);
  const baseCommitOid = nonEmpty(record?.baseCommitOid);
  const generation = typeof record?.generation === "number" ? record.generation : undefined;
  const state = record?.state === "active" || record?.state === "revoked" || record?.state === "stale" ? record.state : undefined;
  const observedAt = timestamp(record?.observedAt);
  const expiresAt = timestamp(record?.expiresAt);
  const receipt = safeReceipt(record?.receipt);
  const ancestorsValue = record?.ancestorCommitOids;
  const ancestorCommitOids = Array.isArray(ancestorsValue) && ancestorsValue.every((entry) => nonEmpty(entry) !== undefined) ? ancestorsValue.map(nonEmpty).filter((entry): entry is string => entry !== undefined) : undefined;
  const workspaceRefMatches = context?.kind !== "workspace" || context.workspaceRef === symbolicRef;
  if (protocol !== REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL || !repositoryId || !sourceSpaceId || !context || !objectFormat || !symbolicRef || !commitOid || !treeOid || !baseCommitOid || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 || !state || !observedAt || !expiresAt || expiresAt.milliseconds <= observedAt.milliseconds || !receipt || !ancestorCommitOids || !workspaceRefMatches || !validOid(commitOid, objectFormat) || !validOid(treeOid, objectFormat) || !validOid(baseCommitOid, objectFormat) || ancestorCommitOids.some((entry) => !validOid(entry, objectFormat))) return undefined;
  return { protocol, repositoryId, sourceSpaceId, context, objectFormat, symbolicRef, commitOid, treeOid, baseCommitOid, ancestorCommitOids, generation, state, observedAt: observedAt.value, expiresAt: expiresAt.value, receipt };
}

function parseIndex(value: unknown): RepositoryDriverSnapshotIndex | undefined {
  const record = object(value);
  const protocol = record?.protocol;
  const repositoryId = nonEmpty(record?.repositoryId);
  const sourceSpaceId = nonEmpty(record?.sourceSpaceId);
  const context = parseContext(record?.context);
  const latestGeneration = typeof record?.latestGeneration === "number" ? record.latestGeneration : undefined;
  const previousGeneration = record?.previousGeneration === null ? null : typeof record?.previousGeneration === "number" ? record.previousGeneration : undefined;
  const latestManifestKey = nonEmpty(record?.latestManifestKey);
  const latestManifestDigest = nonEmpty(record?.latestManifestDigest);
  const updatedAt = timestamp(record?.updatedAt);
  const receipt = safeReceipt(record?.receipt);
  if (protocol !== REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL || !repositoryId || !sourceSpaceId || !context || typeof latestGeneration !== "number" || !Number.isSafeInteger(latestGeneration) || latestGeneration < 1 || previousGeneration === undefined || (previousGeneration !== null && (!Number.isSafeInteger(previousGeneration) || previousGeneration < 1 || previousGeneration >= latestGeneration)) || !latestManifestKey || !latestManifestDigest || !/^sha256:[0-9a-f]{64}$/u.test(latestManifestDigest) || !updatedAt || !receipt) return undefined;
  return { protocol, repositoryId, sourceSpaceId, context, latestGeneration, previousGeneration, latestManifestKey, latestManifestDigest, updatedAt: updatedAt.value, receipt };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as ObjectRecord)[key])}`).join(",")}}`;
}

export async function repositoryDriverSnapshotDigest(manifest: RepositoryDriverSnapshotManifest): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(manifest)));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function contextPrefix(prefix: string, repositoryId: string, context: RepositoryDriverSnapshotContext): string {
  const root = `${prefix.replace(/\/?$/u, "/")}${encodeURIComponent(repositoryId)}`;
  if (context.kind === "workspace") return `${root}/workspace/${encodeURIComponent(context.workspaceId)}/${encodeURIComponent(context.projectViewId)}`;
  return `${root}/mirror/${encodeURIComponent(context.mirrorId)}/${encodeURIComponent(context.proposalKey)}/${encodeURIComponent(context.deliveryId)}`;
}

export function repositoryDriverSnapshotIndexKey(prefix: string, repositoryId: string, context: RepositoryDriverSnapshotContext): string {
  return `${contextPrefix(prefix, repositoryId, context)}/index.json`;
}

export function repositoryDriverSnapshotManifestKey(prefix: string, repositoryId: string, context: RepositoryDriverSnapshotContext, generation: number): string {
  return `${contextPrefix(prefix, repositoryId, context)}/generations/${generation}.json`;
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

function configuration(env: Env): DriverConfiguration {
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

async function readJson(bucket: R2Bucket, key: string, limit: number): Promise<{ state: "found"; value: unknown } | { state: "missing" } | { state: "invalid"; error: string }> {
  let objectBody: R2ObjectBody | null;
  try {
    objectBody = await bucket.get(key);
  } catch (error) {
    return { state: "invalid", error: error instanceof Error ? error.name : "r2-read-failed" };
  }
  if (!objectBody) return { state: "missing" };
  try {
    return { state: "found", value: JSON.parse(await readBoundedText(objectBody.body, limit)) as unknown };
  } catch (error) {
    return { state: "invalid", error: error instanceof Error ? error.message : "json-invalid" };
  }
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

function contextForRequest(request: RepositoryObservationRequest): RepositoryDriverSnapshotWorkspaceContext {
  return { kind: "workspace", workspaceId: request.workspaceId, projectViewId: request.projectViewId, workspaceRef: request.expectedSymbolicRef ?? "" };
}

async function observe(request: Request, env: Env, config: DriverConfiguration): Promise<Response> {
  let observationRequest: RepositoryObservationRequest;
  try {
    observationRequest = await readRequest(request, config.limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : "repository_driver_request_invalid";
    const budget = message.startsWith("repository_driver_body_budget_exceeded:");
    return requestFailure(budget ? "request_budget_exceeded" : "request_malformed", budget ? "The RepositoryDriver request exceeded its configured body budget." : "The RepositoryDriver request is not a valid observation request.", budget ? "reduce the request to the measured driver budget or remeasure the tripwire before changing it" : "send one anyam.repository-observation/v1 request object", `${message}; requestBudget=${config.limit}; sizingReceipt=${config.receipt}`);
  }
  const requestContext = contextForRequest(observationRequest);
  const indexKey = repositoryDriverSnapshotIndexKey(config.prefix, observationRequest.repositoryId, requestContext);
  const indexResult = await readJson(config.bucket, indexKey, config.limit);
  if (indexResult.state === "missing") return failure("unavailable", "repository_driver_snapshot_index_missing", "publish the context-specific RepositoryDriver snapshot index before observing the Workspace", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${observationRequest.repositoryId}; context=workspace:${observationRequest.workspaceId}; state=index-missing; providerMutation=false`, 503);
  if (indexResult.state === "invalid") return failure("unavailable", "repository_driver_snapshot_index_unavailable", "restore the context-specific RepositoryDriver snapshot index and retry the same immutable observation", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${observationRequest.repositoryId}; context=workspace:${observationRequest.workspaceId}; state=index-unavailable; error=${indexResult.error}; providerMutation=false`, 503);
  const index = parseIndex(indexResult.value);
  if (!index) return failure("unavailable", "repository_driver_snapshot_index_invalid", "repair or republish the context-specific snapshot index with a monotonic generation and credential-free receipt", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${observationRequest.repositoryId}; context=workspace:${observationRequest.workspaceId}; state=index-invalid; providerMutation=false`, 502);
  if (index.repositoryId !== observationRequest.repositoryId || index.sourceSpaceId !== observationRequest.sourceSpaceId || index.context.kind !== "workspace" || index.context.workspaceId !== observationRequest.workspaceId || index.context.projectViewId !== observationRequest.projectViewId) return failure("blocked", "repository_driver_context_mismatch", "publish a snapshot index bound to the exact Repository, Source Space, Workspace, and Project View requested by the Realm", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${observationRequest.repositoryId}; context=workspace:${observationRequest.workspaceId}; state=identity-mismatch; providerMutation=false`, 409);
  const expectedManifestKey = repositoryDriverSnapshotManifestKey(config.prefix, index.repositoryId, index.context, index.latestGeneration);
  if (index.latestManifestKey !== expectedManifestKey) return failure("blocked", "repository_driver_snapshot_index_mismatch", "repair the snapshot index so its latest manifest key is the immutable generation object for the exact context", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${index.repositoryId}; context=workspace:${observationRequest.workspaceId}; generation=${index.latestGeneration}; state=index-manifest-mismatch; providerMutation=false`, 409);
  const manifestResult = await readJson(config.bucket, index.latestManifestKey, config.limit);
  if (manifestResult.state === "missing") return failure("unavailable", "repository_driver_snapshot_missing", "restore the indexed immutable snapshot manifest and retry the same observation", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${index.repositoryId}; context=workspace:${observationRequest.workspaceId}; generation=${index.latestGeneration}; state=manifest-missing; providerMutation=false`, 503);
  if (manifestResult.state === "invalid") {
    const budget = manifestResult.error.startsWith("repository_driver_body_budget_exceeded:");
    return failure("unavailable", budget ? "repository_driver_state_budget_exceeded" : "repository_driver_snapshot_unavailable", budget ? "reduce the indexed snapshot manifest to the configured driver budget or remeasure the tripwire" : "restore the indexed snapshot manifest and retry the same immutable observation", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${index.repositoryId}; context=workspace:${observationRequest.workspaceId}; generation=${index.latestGeneration}; state=${budget ? "manifest-budget-exceeded" : "manifest-unavailable"}; error=${manifestResult.error}; providerMutation=false`, 502);
  }
  const manifest = parseManifest(manifestResult.value);
  if (!manifest) return failure("unavailable", "repository_driver_state_invalid", "repair or republish the indexed snapshot manifest with the supported context, Git identities, expiry, and receipt fields", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${observationRequest.repositoryId}; context=workspace:${observationRequest.workspaceId}; state=manifest-invalid; providerMutation=false`, 502);
  if (manifest.repositoryId !== observationRequest.repositoryId || manifest.sourceSpaceId !== observationRequest.sourceSpaceId || !sameContext(manifest.context, index.context) || manifest.generation !== index.latestGeneration) return failure("blocked", "repository_driver_context_mismatch", "publish a snapshot manifest bound to the exact Repository, Source Space, Workspace, Project View, and generation requested by the Realm", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${observationRequest.repositoryId}; context=workspace:${observationRequest.workspaceId}; generation=${index.latestGeneration}; state=identity-mismatch; providerMutation=false`, 409);
  const observedManifestDigest = await repositoryDriverSnapshotDigest(manifest);
  if (observedManifestDigest !== index.latestManifestDigest) return failure("blocked", "repository_driver_snapshot_digest_mismatch", "republish the immutable snapshot index with the exact digest of its generation manifest", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${manifest.repositoryId}; context=workspace:${observationRequest.workspaceId}; generation=${manifest.generation}; state=digest-mismatch; providerMutation=false`, 409);
  const now = Date.now();
  const observedAt = Date.parse(manifest.observedAt);
  const expiresAt = Date.parse(manifest.expiresAt);
  if (observedAt > now) return failure("blocked", "repository_driver_snapshot_future", "republish the snapshot with the provider observation time no later than the current clock", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${manifest.repositoryId}; context=workspace:${observationRequest.workspaceId}; generation=${manifest.generation}; observedAt=${manifest.observedAt}; state=future; providerMutation=false`, 409);
  if (expiresAt <= now) return failure("blocked", "repository_driver_snapshot_expired", "reinspect the provider and publish a fresh active snapshot with a future expiry", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${manifest.repositoryId}; context=workspace:${observationRequest.workspaceId}; generation=${manifest.generation}; expiresAt=${manifest.expiresAt}; state=expired; providerMutation=false`, 409);
  if (manifest.state === "revoked") return failure("blocked", "repository_driver_installation_revoked", "restore the customer provider installation and publish a fresh active snapshot before retrying", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${manifest.repositoryId}; context=workspace:${observationRequest.workspaceId}; generation=${manifest.generation}; installation=revoked; providerMutation=false`, 409);
  if (manifest.state === "stale") return failure("blocked", "repository_driver_snapshot_stale", "reinspect the provider and publish a fresh active snapshot before retrying", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${manifest.repositoryId}; context=workspace:${observationRequest.workspaceId}; generation=${manifest.generation}; snapshot=stale; providerMutation=false`, 409);
  const mismatches: string[] = [];
  if (observationRequest.expectedSymbolicRef !== undefined && manifest.symbolicRef !== observationRequest.expectedSymbolicRef) mismatches.push("symbolicRef");
  if (manifest.objectFormat !== (observationRequest.expectedObjectFormat ?? manifest.objectFormat)) mismatches.push("objectFormat");
  if (manifest.commitOid !== observationRequest.expectedCommitOid) mismatches.push("commitOid");
  if (observationRequest.expectedTreeOid !== undefined && manifest.treeOid !== observationRequest.expectedTreeOid) mismatches.push("treeOid");
  if (manifest.baseCommitOid !== observationRequest.expectedBaseCommitOid) mismatches.push("baseCommitOid");
  if (!manifest.ancestorCommitOids.includes(observationRequest.expectedBaseCommitOid) && manifest.commitOid !== observationRequest.expectedBaseCommitOid) mismatches.push("ancestry");
  if (mismatches.length > 0) return failure("blocked", "repository_driver_snapshot_mismatch", "inspect the exact provider head, tree, ref, base, object format, and ancestry; publish a new immutable snapshot before retrying", `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${manifest.repositoryId}; context=workspace:${observationRequest.workspaceId}; generation=${manifest.generation}; mismatch=${mismatches.join(",")}; providerMutation=false`, 409);
  const claims = { protocol: REPOSITORY_OBSERVATION_PROTOCOL, repositoryId: manifest.repositoryId, sourceSpaceId: manifest.sourceSpaceId, workspaceId: manifest.context.kind === "workspace" ? manifest.context.workspaceId : observationRequest.workspaceId, projectViewId: manifest.context.kind === "workspace" ? manifest.context.projectViewId : observationRequest.projectViewId, objectFormat: manifest.objectFormat, symbolicRef: manifest.symbolicRef, commitOid: manifest.commitOid, treeOid: manifest.treeOid, baseCommitOid: manifest.baseCommitOid, ancestryVerified: true as const, observedAt: manifest.observedAt, receipt: `provider=anyam-r2-snapshot; repository=${manifest.repositoryId}; sourceSpace=${manifest.sourceSpaceId}; context=workspace:${observationRequest.workspaceId}; projectView=${observationRequest.projectViewId}; generation=${manifest.generation}; expiresAt=${manifest.expiresAt}; previousGeneration=${index.previousGeneration ?? "none"}; sourceReceipt=${manifest.receipt}; credentialMaterialStored=false` };
  const manifestDigest = await repositoryObservationDigest(claims);
  return json({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "succeeded", observation: { ...claims, manifestDigest }, receipt: `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; repository=${manifest.repositoryId}; sourceSpace=${manifest.sourceSpaceId}; context=workspace:${observationRequest.workspaceId}; projectView=${observationRequest.projectViewId}; generation=${manifest.generation}; expiresAt=${manifest.expiresAt}; previousGeneration=${index.previousGeneration ?? "none"}; ancestry=verified; providerMutation=false; requestBudget=${config.limit}; sizingReceipt=${config.receipt}; credentialMaterialStored=false`, credentialValues: "not-printed", canonicalWrite: false });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      const config = configuration(env);
      if (url.pathname === "/health" && request.method === "GET") return json({ protocol: REPOSITORY_DRIVER_PROTOCOL, snapshotProtocol: REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL, indexProtocol: REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL, status: "ready", state: "r2-context-snapshot-driver", credentialValues: "not-printed", canonicalWrite: false, receipt: `repositoryDriver=${REPOSITORY_DRIVER_PROTOCOL}; snapshot=${REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL}; index=${REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL}; context=workspace-or-mirror; storage=r2; providerCredentials=not-held; requestBudget=${config.limit}; sizingReceipt=${config.receipt}; credentialMaterialStored=false` });
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
