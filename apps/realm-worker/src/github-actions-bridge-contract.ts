import type { GitObjectFormat, GitRef } from "../../../src/kernel/contracts.ts";
import {
  GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL,
  type GitHubActionsBridgeHistoryObservation,
  type GitHubActionsBridgeImportPlan,
  type GitHubActionsBridgeLfsObjectUpload,
  type GitHubActionsBridgeSourcePackage,
} from "../../../src/portability/github-actions-bridge-import.ts";
import {
  GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL,
  type GitHubActionsBridgeOutboundBundle,
  type GitHubActionsBridgeOutboundPlan,
  type GitHubActionsBridgeOutboundProviderResult,
  type GitHubActionsBridgeOutboundRunObservation,
} from "../../../src/portability/github-actions-bridge-outbound.ts";

export type GitHubActionsBridgeWirePackage = Omit<GitHubActionsBridgeSourcePackage, "bundle" | "lfs"> & {
  bundle: { base64: string; digest: string; declaredBytes: number };
  lfs: { state: GitHubActionsBridgeSourcePackage["lfs"]["state"]; objects: readonly (Omit<GitHubActionsBridgeLfsObjectUpload, "bytes"> & { base64: string })[] };
};

export type GitHubActionsBridgeWireHistory = Omit<GitHubActionsBridgeHistoryObservation, "canonicalRefs" | "githubRefs"> & {
  canonicalRefs: readonly GitRef[];
  githubRefs: readonly GitRef[];
};

export type GitHubActionsBridgeWireOutboundBundle = Omit<GitHubActionsBridgeOutboundBundle, "bundle"> & {
  bundle: { base64: string; digest: string; declaredBytes: number };
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

function outboundMappings(value: unknown): GitHubActionsBridgeOutboundBundle["refMappings"] {
  if (!Array.isArray(value)) throw new Error("refMappings=array-required");
  return value.map((entry, index) => {
    const mapping = record(entry, `refMappings[${index}]`);
    return { localRef: text(mapping.localRef, `refMappings[${index}].localRef`), remoteRef: text(mapping.remoteRef, `refMappings[${index}].remoteRef`) };
  });
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field}=array-required`);
  return value.map((entry, index) => text(entry, `${field}[${index}]`));
}

export function parseGitHubActionsBridgeOutboundBundle(value: unknown): GitHubActionsBridgeOutboundBundle {
  const source = record(value, "outboundBundle");
  const bundle = record(source.bundle, "outboundBundle.bundle");
  const signing = record(source.signing, "outboundBundle.signing");
  const protocol = text(source.protocol, "outboundBundle.protocol");
  if (protocol !== GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL) throw new Error("outboundBundle.protocol=unsupported");
  const algorithm = text(signing.algorithm, "outboundBundle.signing.algorithm");
  if (algorithm !== "Ed25519") throw new Error("outboundBundle.signing.algorithm=unsupported");
  return {
    protocol,
    operationId: text(source.operationId, "outboundBundle.operationId"),
    capabilityId: text(source.capabilityId, "outboundBundle.capabilityId"),
    realmId: text(source.realmId, "outboundBundle.realmId"),
    projectId: text(source.projectId, "outboundBundle.projectId"),
    sourceSpaceId: text(source.sourceSpaceId, "outboundBundle.sourceSpaceId"),
    repositoryOwnerId: text(source.repositoryOwnerId, "outboundBundle.repositoryOwnerId"),
    repositoryId: text(source.repositoryId, "outboundBundle.repositoryId"),
    runId: text(source.runId, "outboundBundle.runId"),
    mirrorId: text(source.mirrorId, "outboundBundle.mirrorId"),
    remoteRepository: text(source.remoteRepository, "outboundBundle.remoteRepository"),
    objectFormat: objectFormat(source.objectFormat),
    defaultBranch: optionalText(source.defaultBranch, "outboundBundle.defaultBranch"),
    expectedRemoteGeneration: text(source.expectedRemoteGeneration, "outboundBundle.expectedRemoteGeneration"),
    expectedRemoteRefs: refs(source.expectedRemoteRefs, "outboundBundle.expectedRemoteRefs"),
    refs: refs(source.refs, "outboundBundle.refs"),
    refMappings: outboundMappings(source.refMappings),
    protectedRemoteRefs: stringList(source.protectedRemoteRefs, "outboundBundle.protectedRemoteRefs"),
    bundle: { bytes: base64(bundle.base64, "outboundBundle.bundle.base64"), digest: text(bundle.digest, "outboundBundle.bundle.digest"), declaredBytes: numberValue(bundle.declaredBytes, "outboundBundle.bundle.declaredBytes") },
    signing: { algorithm, keyId: text(signing.keyId, "outboundBundle.signing.keyId"), publicKey: text(signing.publicKey, "outboundBundle.signing.publicKey"), signature: text(signing.signature, "outboundBundle.signing.signature"), messageDigest: text(signing.messageDigest, "outboundBundle.signing.messageDigest") },
  };
}

export function encodeGitHubActionsBridgeOutboundBundle(bundle: GitHubActionsBridgeOutboundBundle): GitHubActionsBridgeWireOutboundBundle {
  let binary = "";
  for (const byte of bundle.bundle.bytes) binary += String.fromCharCode(byte);
  return { ...bundle, bundle: { base64: btoa(binary), digest: bundle.bundle.digest, declaredBytes: bundle.bundle.declaredBytes } };
}

export function parseGitHubActionsBridgeOutboundRun(value: unknown): GitHubActionsBridgeOutboundRunObservation {
  const run = record(value, "run");
  const state = text(run.state, "run.state");
  if (state !== "received" && state !== "no-run" && state !== "stale" && state !== "disabled" && state !== "revoked") throw new Error("run.state=unsupported");
  return { state, receipt: text(run.receipt, "run.receipt") };
}

export function parseGitHubActionsBridgeOutboundProvider(value: unknown): GitHubActionsBridgeOutboundProviderResult {
  const provider = record(value, "provider");
  const status = text(provider.status, "provider.status");
  if (status === "succeeded") return { status, generation: text(provider.generation, "provider.generation"), refs: refs(provider.refs, "provider.refs"), receipt: text(provider.receipt, "provider.receipt") };
  if (status !== "failed") throw new Error("provider.status=unsupported");
  const code = text(provider.code, "provider.code");
  if (code !== "protected-branch" && code !== "stale" && code !== "revoked" && code !== "disabled" && code !== "no-run" && code !== "provider-error") throw new Error("provider.code=unsupported");
  return { status, code, recoveryAction: text(provider.recoveryAction, "provider.recoveryAction"), receipt: text(provider.receipt, "provider.receipt"), remoteMayHaveChanged: provider.remoteMayHaveChanged === true };
}

export function parseGitHubActionsBridgeOutboundPlan(value: unknown): GitHubActionsBridgeOutboundPlan {
  const plan = record(value, "outboundPlan");
  const protocol = text(plan.protocol, "outboundPlan.protocol");
  if (protocol !== GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL) throw new Error("outboundPlan.protocol=unsupported");
  const status = text(plan.status, "outboundPlan.status");
  if (status !== "ready" && status !== "blocked" && status !== "degraded") throw new Error("outboundPlan.status=unsupported");
  return { protocol, operationId: text(plan.operationId, "outboundPlan.operationId"), capabilityId: text(plan.capabilityId, "outboundPlan.capabilityId"), realmId: text(plan.realmId, "outboundPlan.realmId"), projectId: text(plan.projectId, "outboundPlan.projectId"), sourceSpaceId: text(plan.sourceSpaceId, "outboundPlan.sourceSpaceId"), repositoryId: text(plan.repositoryId, "outboundPlan.repositoryId"), mirrorId: text(plan.mirrorId, "outboundPlan.mirrorId"), remoteRepository: text(plan.remoteRepository, "outboundPlan.remoteRepository"), runId: text(plan.runId, "outboundPlan.runId"), expectedRemoteGeneration: text(plan.expectedRemoteGeneration, "outboundPlan.expectedRemoteGeneration"), expectedRemoteRefs: refs(plan.expectedRemoteRefs, "outboundPlan.expectedRemoteRefs"), desiredRemoteRefs: refs(plan.desiredRemoteRefs, "outboundPlan.desiredRemoteRefs"), protectedRemoteRefs: stringList(plan.protectedRemoteRefs, "outboundPlan.protectedRemoteRefs"), status, canonicalWrite: false, nextAction: text(plan.nextAction, "outboundPlan.nextAction"), receipt: text(plan.receipt, "outboundPlan.receipt") };
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
