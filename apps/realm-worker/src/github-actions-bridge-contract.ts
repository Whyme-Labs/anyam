import type { GitObjectFormat, GitRef } from "../../../src/kernel/contracts.ts";
import {
  GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL,
  type GitHubActionsBridgeHistoryObservation,
  type GitHubActionsBridgeImportPlan,
  type GitHubActionsBridgeLfsObjectUpload,
  type GitHubActionsBridgeSourcePackage,
} from "../../../src/portability/github-actions-bridge-import.ts";

export type GitHubActionsBridgeWirePackage = Omit<GitHubActionsBridgeSourcePackage, "bundle" | "lfs"> & {
  bundle: { base64: string; digest: string; declaredBytes: number };
  lfs: { state: GitHubActionsBridgeSourcePackage["lfs"]["state"]; objects: readonly (Omit<GitHubActionsBridgeLfsObjectUpload, "bytes"> & { base64: string })[] };
};

export type GitHubActionsBridgeWireHistory = Omit<GitHubActionsBridgeHistoryObservation, "canonicalRefs" | "githubRefs"> & {
  canonicalRefs: readonly GitRef[];
  githubRefs: readonly GitRef[];
};

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}=object-required`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field}=string-required`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return text(value, field);
}

function numberValue(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field}=safe-integer-required`);
  return value as number;
}

function objectFormat(value: unknown): GitObjectFormat {
  const format = text(value, "objectFormat");
  if (format !== "sha1" && format !== "sha256") throw new Error("objectFormat=unsupported");
  return format;
}

function base64(value: unknown, field: string): Uint8Array {
  const encoded = text(value, field);
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new Error(`${field}=base64-invalid`);
  }
}

function refs(value: unknown, field: string): GitRef[] {
  if (!Array.isArray(value)) throw new Error(`${field}=array-required`);
  return value.map((entry, index) => {
    const item = record(entry, `${field}[${index}]`);
    return { name: text(item.name, `${field}[${index}].name`), oid: text(item.oid, `${field}[${index}].oid`) };
  });
}

export function parseGitHubActionsBridgeSourcePackage(value: unknown): GitHubActionsBridgeSourcePackage {
  const source = record(value, "sourcePackage");
  const bundle = record(source.bundle, "sourcePackage.bundle");
  const lfs = record(source.lfs, "sourcePackage.lfs");
  const rawObjects = lfs.objects;
  if (!Array.isArray(rawObjects)) throw new Error("sourcePackage.lfs.objects=array-required");
  const objects: GitHubActionsBridgeLfsObjectUpload[] = rawObjects.map((entry, index) => {
    const item = record(entry, `sourcePackage.lfs.objects[${index}]`);
    const bytes = base64(item.base64, `sourcePackage.lfs.objects[${index}].base64`);
    return {
      oid: text(item.oid, `sourcePackage.lfs.objects[${index}].oid`),
      size: numberValue(item.size, `sourcePackage.lfs.objects[${index}].size`),
      digest: text(item.digest, `sourcePackage.lfs.objects[${index}].digest`),
      relativePath: text(item.relativePath, `sourcePackage.lfs.objects[${index}].relativePath`),
      bytes,
      ...(item.mediaType === undefined ? {} : { mediaType: text(item.mediaType, `sourcePackage.lfs.objects[${index}].mediaType`) }),
    };
  });
  const lfsState = text(lfs.state, "sourcePackage.lfs.state");
  if (lfsState !== "empty" && lfsState !== "complete" && lfsState !== "incomplete" && lfsState !== "unavailable") throw new Error("sourcePackage.lfs.state=unsupported");
  const protocol = text(source.protocol, "sourcePackage.protocol");
  if (protocol !== GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL) throw new Error("sourcePackage.protocol=unsupported");
  return {
    protocol,
    operationId: text(source.operationId, "sourcePackage.operationId"),
    capabilityId: text(source.capabilityId, "sourcePackage.capabilityId"),
    realmId: text(source.realmId, "sourcePackage.realmId"),
    projectId: text(source.projectId, "sourcePackage.projectId"),
    sourceSpaceId: text(source.sourceSpaceId, "sourcePackage.sourceSpaceId"),
    repositoryOwnerId: text(source.repositoryOwnerId, "sourcePackage.repositoryOwnerId"),
    repositoryId: text(source.repositoryId, "sourcePackage.repositoryId"),
    runId: text(source.runId, "sourcePackage.runId"),
    objectFormat: objectFormat(source.objectFormat),
    defaultBranch: optionalText(source.defaultBranch, "sourcePackage.defaultBranch"),
    refs: refs(source.refs, "sourcePackage.refs"),
    bundle: { bytes: base64(bundle.base64, "sourcePackage.bundle.base64"), digest: text(bundle.digest, "sourcePackage.bundle.digest"), declaredBytes: numberValue(bundle.declaredBytes, "sourcePackage.bundle.declaredBytes") },
    lfs: { state: lfsState, objects },
  };
}

export function parseGitHubActionsBridgeHistory(value: unknown): GitHubActionsBridgeHistoryObservation {
  const history = record(value, "history");
  const source = text(history.source, "history.source");
  const relation = text(history.relation, "history.relation");
  if (source !== "repository-driver") throw new Error("history.source=repository-driver-required");
  if (relation !== "empty" && relation !== "same" && relation !== "github-ahead" && relation !== "canonical-ahead" && relation !== "diverged") throw new Error("history.relation=unsupported");
  return { source, objectFormat: objectFormat(history.objectFormat), canonicalRefs: refs(history.canonicalRefs, "history.canonicalRefs"), githubRefs: refs(history.githubRefs, "history.githubRefs"), relation, receipt: text(history.receipt, "history.receipt") };
}

export function encodeGitHubActionsBridgeSourcePackage(sourcePackage: GitHubActionsBridgeSourcePackage): GitHubActionsBridgeWirePackage {
  const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  return {
    protocol: sourcePackage.protocol,
    operationId: sourcePackage.operationId,
    capabilityId: sourcePackage.capabilityId,
    realmId: sourcePackage.realmId,
    projectId: sourcePackage.projectId,
    sourceSpaceId: sourcePackage.sourceSpaceId,
    repositoryOwnerId: sourcePackage.repositoryOwnerId,
    repositoryId: sourcePackage.repositoryId,
    runId: sourcePackage.runId,
    objectFormat: sourcePackage.objectFormat,
    defaultBranch: sourcePackage.defaultBranch,
    refs: sourcePackage.refs,
    bundle: { base64: bytesToBase64(sourcePackage.bundle.bytes), digest: sourcePackage.bundle.digest, declaredBytes: sourcePackage.bundle.declaredBytes },
    lfs: { state: sourcePackage.lfs.state, objects: sourcePackage.lfs.objects.map((object) => ({ oid: object.oid, size: object.size, digest: object.digest, relativePath: object.relativePath, base64: bytesToBase64(object.bytes), ...(object.mediaType ? { mediaType: object.mediaType } : {}) })) },
  };
}

export function encodeGitHubActionsBridgeHistory(history: GitHubActionsBridgeHistoryObservation): GitHubActionsBridgeWireHistory {
  return { source: history.source, objectFormat: history.objectFormat, canonicalRefs: history.canonicalRefs, githubRefs: history.githubRefs, relation: history.relation, receipt: history.receipt };
}

export function parseGitHubActionsBridgeMode(value: unknown): "initial-import" | "proposal" {
  const mode = text(value, "mode");
  if (mode !== "initial-import" && mode !== "proposal") throw new Error("mode=unsupported");
  return mode;
}

export function parseGitHubActionsBridgePlan(value: unknown): GitHubActionsBridgeImportPlan {
  const plan = record(value, "plan");
  const status = text(plan.status, "plan.status");
  if (status !== "awaiting-owner" && status !== "ready" && status !== "blocked") throw new Error("plan.status=unsupported");
  const relation = text(plan.relation, "plan.relation");
  if (relation !== "empty" && relation !== "same" && relation !== "github-ahead" && relation !== "canonical-ahead" && relation !== "diverged") throw new Error("plan.relation=unsupported");
  const protocol = text(plan.protocol, "plan.protocol");
  if (protocol !== GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL) throw new Error("plan.protocol=unsupported");
  return { protocol, operationId: text(plan.operationId, "plan.operationId"), capabilityId: text(plan.capabilityId, "plan.capabilityId"), realmId: text(plan.realmId, "plan.realmId"), projectId: text(plan.projectId, "plan.projectId"), sourceSpaceId: text(plan.sourceSpaceId, "plan.sourceSpaceId"), repositoryId: text(plan.repositoryId, "plan.repositoryId"), runId: text(plan.runId, "plan.runId"), mode: parseGitHubActionsBridgeMode(plan.mode), relation, status, canonicalWrite: false, nextAction: text(plan.nextAction, "plan.nextAction"), receipt: text(plan.receipt, "plan.receipt") };
}
