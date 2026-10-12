import { scanCredentialMaterial } from "../security/credential-material.ts";

export const REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL = "anyam.repository-driver-snapshot/v2" as const;
export const REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL = "anyam.repository-driver-snapshot-index/v1" as const;
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

type ObjectRecord = Record<string, unknown>;

function object(value: unknown): ObjectRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function safeReceipt(value: unknown): string | undefined {
  const receipt = nonEmpty(value);
  if (!receipt || scanCredentialMaterial(receipt)) return undefined;
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

export function sameRepositoryDriverSnapshotContext(left: RepositoryDriverSnapshotContext, right: RepositoryDriverSnapshotContext): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "workspace" && right.kind === "workspace") return left.workspaceId === right.workspaceId && left.projectViewId === right.projectViewId && left.workspaceRef === right.workspaceRef;
  if (left.kind === "mirror" && right.kind === "mirror") return left.mirrorId === right.mirrorId && left.proposalKey === right.proposalKey && left.deliveryId === right.deliveryId;
  return false;
}

export function parseRepositoryDriverSnapshotManifest(value: unknown): RepositoryDriverSnapshotManifest | undefined {
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

export function parseRepositoryDriverSnapshotIndex(value: unknown): RepositoryDriverSnapshotIndex | undefined {
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
