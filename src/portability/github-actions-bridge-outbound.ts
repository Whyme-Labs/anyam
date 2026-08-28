import {
  CONTRACT_VERSIONS,
  type GitObjectFormat,
  type GitRef,
  type MirrorRefMapping,
} from "../kernel/contracts.ts";
import { verifyRunnerResultSignature } from "../execution/runner-proof.ts";
import type { GitHubActionsBridgeCapability } from "./github-actions-bridge.ts";
import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, scanCredentialMaterial } from "../security/credential-material.ts";

export const GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL = CONTRACT_VERSIONS.githubActionsBridgeOutbound;

export type GitHubActionsBridgeOutboundRunState = "received" | "no-run" | "stale" | "disabled" | "revoked";

export type GitHubActionsBridgeOutboundRunObservation = {
  state: GitHubActionsBridgeOutboundRunState;
  receipt: string;
};

export type GitHubActionsBridgeOutboundBundle = {
  protocol: typeof GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL;
  operationId: string;
  capabilityId: string;
  realmId: string;
  projectId: string;
  sourceSpaceId: string;
  repositoryOwnerId: string;
  repositoryId: string;
  runId: string;
  mirrorId: string;
  remoteRepository: string;
  objectFormat: GitObjectFormat;
  defaultBranch: string | null;
  expectedRemoteGeneration: string;
  expectedRemoteRefs: readonly GitRef[];
  refs: readonly GitRef[];
  refMappings: readonly MirrorRefMapping[];
  protectedRemoteRefs: readonly string[];
  bundle: {
    bytes: Uint8Array;
    digest: string;
    declaredBytes: number;
  };
  signing: {
    algorithm: "Ed25519";
    keyId: string;
    publicKey: string;
    signature: string;
    messageDigest: string;
  };
};

export type GitHubActionsBridgeOutboundProviderFailure = {
  status: "failed";
  code: "protected-branch" | "stale" | "revoked" | "disabled" | "no-run" | "provider-error";
  recoveryAction: string;
  receipt: string;
  remoteMayHaveChanged: boolean;
};

export type GitHubActionsBridgeOutboundProviderSuccess = {
  status: "succeeded";
  generation: string;
  refs: readonly GitRef[];
  receipt: string;
};

export type GitHubActionsBridgeOutboundProviderResult = GitHubActionsBridgeOutboundProviderSuccess | GitHubActionsBridgeOutboundProviderFailure;

export type GitHubActionsBridgeOutboundPlan = {
  protocol: typeof GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL;
  operationId: string;
  capabilityId: string;
  realmId: string;
  projectId: string;
  sourceSpaceId: string;
  repositoryId: string;
  mirrorId: string;
  remoteRepository: string;
  runId: string;
  expectedRemoteGeneration: string;
  expectedRemoteRefs: readonly GitRef[];
  desiredRemoteRefs: readonly GitRef[];
  protectedRemoteRefs: readonly string[];
  status: "ready" | "blocked" | "degraded";
  canonicalWrite: false;
  nextAction: string;
  receipt: string;
};

export type GitHubActionsBridgeOutboundCheckpoint = {
  plan: GitHubActionsBridgeOutboundPlan;
  state: "pushed" | "blocked" | "degraded";
  expectedRemoteGeneration: string;
  actualRemoteGeneration?: string;
  actualRemoteRefs?: readonly GitRef[];
  recoveryAction: string;
  receipt: string;
};

export type GitHubActionsBridgeOutboundFailure = {
  status: "failed";
  code: string;
  message: string;
  recoveryAction: string;
  receipt: string;
  credentialMaterialStored: false;
};

export type GitHubActionsBridgeOutboundSuccess<T> = {
  status: "succeeded";
  value: T;
  receipt: string;
  credentialMaterialStored: false;
};

export type GitHubActionsBridgeOutboundBlocked = {
  status: "blocked" | "degraded";
  checkpoint: GitHubActionsBridgeOutboundCheckpoint;
  recoveryAction: string;
  receipt: string;
  credentialMaterialStored: false;
};

export type GitHubActionsBridgeOutboundResult<T> = GitHubActionsBridgeOutboundSuccess<T> | GitHubActionsBridgeOutboundFailure | GitHubActionsBridgeOutboundBlocked;

export type GitHubActionsBridgeOutboundReplayLedger = {
  claim(operationId: string): Promise<"claimed" | "duplicate">;
  complete?(operationId: string): Promise<void> | void;
  release?(operationId: string): Promise<void> | void;
  snapshot?(): readonly string[];
};

export class MemoryGitHubActionsBridgeOutboundReplayLedger implements GitHubActionsBridgeOutboundReplayLedger {
  private readonly completed = new Set<string>();
  private readonly inFlight = new Set<string>();

  constructor(operationIds: readonly string[] = []) {
    for (const operationId of operationIds) this.completed.add(operationId);
  }

  async claim(operationId: string): Promise<"claimed" | "duplicate"> {
    if (this.completed.has(operationId) || this.inFlight.has(operationId)) return "duplicate";
    this.inFlight.add(operationId);
    return "claimed";
  }

  complete(operationId: string): void {
    this.inFlight.delete(operationId);
    this.completed.add(operationId);
  }

  release(operationId: string): void {
    this.inFlight.delete(operationId);
  }

  snapshot(): readonly string[] {
    return [...this.completed];
  }
}

export type GitHubActionsBridgeOutboundSnapshot = {
  completedOperationIds: readonly string[];
  credentialMaterialStored: false;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new OutboundBridgeError({ code: "input_invalid", message: `${field} must be a non-empty string.`, recoveryAction: `provide a measured ${field} and retry; no outbound checkpoint changed`, receipt: `${field}=required; transition=not-applied` });
  return value.trim();
}

function safeReceipt(value: unknown, field: string): string {
  const receipt = required(value, field);
  const finding = scanCredentialMaterial(receipt, field);
  if (finding) throw new OutboundBridgeError({ code: "credential_in_receipt", message: `${field} contains credential-shaped material.`, recoveryAction: "return a digest-only credential-free provider receipt", receipt: `${field}=credential-shaped; fieldPath=${finding.path}; scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; transition=not-applied; credentialMaterialStored=false` });
  return receipt;
}

function refsEqual(left: readonly GitRef[], right: readonly GitRef[]): boolean {
  if (left.length !== right.length) return false;
  const rightMap = new Map(right.map((ref) => [ref.name, ref.oid]));
  return left.every((ref) => rightMap.get(ref.name) === ref.oid);
}

function validateRefs(refs: readonly GitRef[], field: string): void {
  const names = new Set<string>();
  for (const ref of refs) {
    const name = required(ref.name, `${field}.name`);
    required(ref.oid, `${field}[${name}].oid`);
    if (names.has(name)) throw new OutboundBridgeError({ code: "refs_duplicate", message: `${field} contains duplicate ref ${name}.`, recoveryAction: "send one exact entry for each mapped ref and retry", receipt: `${field}=duplicate; ref=${name}; transition=not-applied` });
    names.add(name);
  }
}

function projectedRemoteRefs(bundle: GitHubActionsBridgeOutboundBundle): GitRef[] {
  const local = new Map(bundle.refs.map((ref) => [ref.name, ref.oid]));
  const seen = new Set<string>();
  const result: GitRef[] = [];
  for (const mapping of bundle.refMappings) {
    const remoteRef = required(mapping.remoteRef, "refMappings.remoteRef");
    const localRef = required(mapping.localRef, "refMappings.localRef");
    if (seen.has(remoteRef)) throw new OutboundBridgeError({ code: "mapping_duplicate", message: `The outbound bundle maps remote ref ${remoteRef} more than once.`, recoveryAction: "declare one explicit local-to-remote mapping per remote ref", receipt: `remoteRef=${remoteRef}; mapping=duplicate; transition=not-applied` });
    seen.add(remoteRef);
    const oid = local.get(localRef);
    if (oid === undefined) throw new OutboundBridgeError({ code: "mapped_local_ref_missing", message: `The outbound bundle does not contain mapped local ref ${localRef}.`, recoveryAction: "request a complete canonical ref set or an explicit deletion-capable bundle", receipt: `localRef=${localRef}; remoteRef=${remoteRef}; push=not-attempted` });
    result.push({ name: remoteRef, oid });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function signedMessage(bundle: GitHubActionsBridgeOutboundBundle): string {
  return `${GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL}|${stableJson({ operationId: bundle.operationId, capabilityId: bundle.capabilityId, realmId: bundle.realmId, projectId: bundle.projectId, sourceSpaceId: bundle.sourceSpaceId, repositoryOwnerId: bundle.repositoryOwnerId, repositoryId: bundle.repositoryId, runId: bundle.runId, mirrorId: bundle.mirrorId, remoteRepository: bundle.remoteRepository, objectFormat: bundle.objectFormat, defaultBranch: bundle.defaultBranch, expectedRemoteGeneration: bundle.expectedRemoteGeneration, expectedRemoteRefs: bundle.expectedRemoteRefs, refs: bundle.refs, refMappings: bundle.refMappings, protectedRemoteRefs: bundle.protectedRemoteRefs, bundleDigest: bundle.bundle.digest, bundleBytes: bundle.bundle.declaredBytes, signingKeyId: bundle.signing.keyId })}`;
}

export function githubActionsBridgeOutboundMessage(bundle: GitHubActionsBridgeOutboundBundle): string {
  return signedMessage(bundle);
}

function planReceipt(plan: GitHubActionsBridgeOutboundPlan): string {
  return `bridgeOutbound=${plan.operationId}; mirror=${plan.mirrorId}; project=${plan.projectId}; sourceSpace=${plan.sourceSpaceId}; refs=${plan.expectedRemoteRefs.length}; status=${plan.status}; canonicalWrite=false; credentialMaterialStored=false`;
}

function success<T>(value: T, receipt: string): GitHubActionsBridgeOutboundSuccess<T> {
  return { status: "succeeded", value, receipt, credentialMaterialStored: false };
}

function failure(input: Omit<GitHubActionsBridgeOutboundFailure, "status" | "credentialMaterialStored">): GitHubActionsBridgeOutboundFailure {
  return { status: "failed", ...input, credentialMaterialStored: false };
}

export class OutboundBridgeError extends Error {
  readonly code: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: string; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "OutboundBridgeError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

export class GitHubActionsBridgeOutboundCoordinator {
  private readonly now: () => string;
  private readonly ledger: GitHubActionsBridgeOutboundReplayLedger;

  constructor(input: { now?: () => string; ledger?: GitHubActionsBridgeOutboundReplayLedger } = {}) {
    this.now = input.now ?? (() => new Date().toISOString());
    this.ledger = input.ledger ?? new MemoryGitHubActionsBridgeOutboundReplayLedger();
  }

  snapshot(): GitHubActionsBridgeOutboundSnapshot {
    return { completedOperationIds: [...(this.ledger.snapshot?.() ?? [])], credentialMaterialStored: false };
  }

  async prepare(input: { capability: GitHubActionsBridgeCapability; bundle: GitHubActionsBridgeOutboundBundle; run: GitHubActionsBridgeOutboundRunObservation }): Promise<GitHubActionsBridgeOutboundResult<GitHubActionsBridgeOutboundPlan>> {
    try {
      const bundle = input.bundle;
      if (bundle.protocol !== GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL) throw new OutboundBridgeError({ code: "protocol_invalid", message: "The outbound bundle protocol is unsupported.", recoveryAction: `request ${GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL} from the Realm`, receipt: `protocol=${String(bundle.protocol)}; transition=not-applied` });
      for (const [field, value] of [["operationId", bundle.operationId], ["capabilityId", bundle.capabilityId], ["realmId", bundle.realmId], ["projectId", bundle.projectId], ["sourceSpaceId", bundle.sourceSpaceId], ["repositoryOwnerId", bundle.repositoryOwnerId], ["repositoryId", bundle.repositoryId], ["runId", bundle.runId], ["mirrorId", bundle.mirrorId], ["remoteRepository", bundle.remoteRepository], ["expectedRemoteGeneration", bundle.expectedRemoteGeneration]] as const) required(value, field);
      if (input.capability.operation !== "outbound" || input.capability.status !== "active" || input.capability.canonicalWrite !== false) throw new OutboundBridgeError({ code: "capability_invalid", message: "The outbound operation requires an active outbound capability without canonical write authority.", recoveryAction: "exchange a fresh outbound capability for the exact Mirror", receipt: `capability=${input.capability.id}; operation=${input.capability.operation}; canonicalWrite=${String(input.capability.canonicalWrite)}; transition=not-applied` });
      if (Date.parse(input.capability.expiresAt) <= Date.parse(this.now())) throw new OutboundBridgeError({ code: "capability_expired", message: "The outbound Bridge capability has expired.", recoveryAction: "request a fresh outbound OIDC capability from a new workflow run", receipt: `capability=${input.capability.id}; expired=true; transition=not-applied` });
      const bindings: readonly [string, string][] = [["capabilityId", input.capability.id], ["realmId", input.capability.realmId], ["projectId", input.capability.projectId], ["sourceSpaceId", input.capability.sourceSpaceId], ["repositoryOwnerId", input.capability.repositoryOwnerId], ["repositoryId", input.capability.repositoryId], ["runId", input.capability.runId]];
      for (const [field, expected] of bindings) {
        const actual = field === "capabilityId" ? bundle.capabilityId : field === "realmId" ? bundle.realmId : field === "projectId" ? bundle.projectId : field === "sourceSpaceId" ? bundle.sourceSpaceId : field === "repositoryOwnerId" ? bundle.repositoryOwnerId : field === "repositoryId" ? bundle.repositoryId : bundle.runId;
        const capabilityActual = field === "capabilityId" ? input.capability.id : field === "realmId" ? input.capability.realmId : field === "projectId" ? input.capability.projectId : field === "sourceSpaceId" ? input.capability.sourceSpaceId : field === "repositoryOwnerId" ? input.capability.repositoryOwnerId : field === "repositoryId" ? input.capability.repositoryId : input.capability.runId;
        if (actual !== expected || capabilityActual !== expected) throw new OutboundBridgeError({ code: "capability_binding_mismatch", message: `The outbound bundle does not bind ${field} to the capability.`, recoveryAction: "request the exact signed bundle for the active outbound capability", receipt: `field=${field}; transition=not-applied` });
      }
      if (input.capability.mirrorId !== bundle.mirrorId || input.capability.mirrorId === null) throw new OutboundBridgeError({ code: "mirror_binding_mismatch", message: "The outbound capability is not bound to the exact Repository Mirror named by the signed bundle.", recoveryAction: "request a fresh outbound capability and bundle for the exact Mirror", receipt: `capabilityMirror=${input.capability.mirrorId ?? "missing"}; bundleMirror=${bundle.mirrorId}; push=not-attempted` });
      if (input.capability.outboundSigningKeyId === null || input.capability.outboundSigningPublicKey === null || input.capability.outboundSigningKeyId !== bundle.signing.keyId || input.capability.outboundSigningPublicKey !== bundle.signing.publicKey) throw new OutboundBridgeError({ code: "signing_key_binding_mismatch", message: "The outbound bundle is not signed by the Realm-authorized outbound signing key.", recoveryAction: "request a fresh bundle signed by the key bound to the outbound Bridge connection", receipt: `capabilitySigningKey=${input.capability.outboundSigningKeyId ?? "missing"}; bundleSigningKey=${bundle.signing.keyId}; push=not-attempted` });
      const runReceipt = safeReceipt(input.run.receipt, "run.receipt");
      if (input.run.state !== "received") throw new OutboundBridgeError({ code: `run_${input.run.state}`, message: `The outbound Bridge run is ${input.run.state}; no push was attempted.`, recoveryAction: input.run.state === "no-run" ? "trigger the configured workflow_dispatch or schedule and wait for a fresh run" : input.run.state === "stale" ? "inspect the stale Mirror checkpoint and request a fresh outbound run" : "reconnect the Bridge and request a fresh outbound run", receipt: `${runReceipt}; operation=${bundle.operationId}; push=not-attempted; canonicalWrite=false` });
      if (bundle.objectFormat !== "sha1" && bundle.objectFormat !== "sha256") throw new OutboundBridgeError({ code: "object_format_invalid", message: "The outbound bundle object format is unsupported.", recoveryAction: "request a sha1 or sha256 bundle from the RepositoryDriver", receipt: `objectFormat=${String(bundle.objectFormat)}; transition=not-applied` });
      validateRefs(bundle.refs, "refs");
      validateRefs(bundle.expectedRemoteRefs, "expectedRemoteRefs");
      const expectedRemoteRefs = projectedRemoteRefs(bundle);
      const mappedRemoteNames = new Set(bundle.refMappings.map((mapping) => mapping.remoteRef));
      if (bundle.expectedRemoteRefs.some((ref) => !mappedRemoteNames.has(ref.name))) throw new OutboundBridgeError({ code: "expected_ref_unmapped", message: "The signed outbound bundle expected remote state outside its explicit ref mapping.", recoveryAction: "request a complete mapped remote ref set and retry without pushing", receipt: `mirror=${bundle.mirrorId}; expectedRemoteRefs=unmapped; push=not-attempted` });
      if (expectedRemoteRefs.length === 0) throw new OutboundBridgeError({ code: "mapped_refs_empty", message: "The outbound bundle has no mapped refs to push.", recoveryAction: "configure an explicit local-to-remote ref mapping and request a new bundle", receipt: `mirror=${bundle.mirrorId}; refs=empty; push=not-attempted` });
      const protectedRefs = bundle.protectedRemoteRefs.map((ref) => required(ref, "protectedRemoteRefs"));
      if (!(bundle.bundle.bytes instanceof Uint8Array)) throw new OutboundBridgeError({ code: "bundle_bytes_invalid", message: "The outbound bundle bytes are missing.", recoveryAction: "request the complete signed bundle from the Realm", receipt: "bundle=uint8array-required; push=not-attempted" });
      if (bundle.bundle.declaredBytes !== bundle.bundle.bytes.byteLength) throw new OutboundBridgeError({ code: "bundle_byte_count_mismatch", message: "The outbound bundle byte count does not match its bytes.", recoveryAction: "request the exact bundle and measured byte count again", receipt: `bundleBytes=${bundle.bundle.bytes.byteLength}; declaredBytes=${bundle.bundle.declaredBytes}; push=not-attempted` });
      const actualDigest = await digestBytes(bundle.bundle.bytes);
      if (actualDigest !== required(bundle.bundle.digest, "bundle.digest")) throw new OutboundBridgeError({ code: "bundle_digest_mismatch", message: "The outbound bundle digest does not match its bytes.", recoveryAction: "request a fresh signed bundle and verify the digest before pushing", receipt: `actual=${actualDigest}; declared=${bundle.bundle.digest}; push=not-attempted` });
      if (bundle.signing.algorithm !== "Ed25519") throw new OutboundBridgeError({ code: "signature_algorithm_invalid", message: "The outbound bundle signature algorithm is unsupported.", recoveryAction: "request an Ed25519-signed outbound bundle", receipt: `algorithm=${String(bundle.signing.algorithm)}; push=not-attempted` });
      const signatureMessage = signedMessage(bundle);
      const signatureDigest = await digestBytes(new TextEncoder().encode(signatureMessage));
      if (signatureDigest !== required(bundle.signing.messageDigest, "signing.messageDigest")) throw new OutboundBridgeError({ code: "signature_message_digest_mismatch", message: "The outbound signed message digest is inconsistent.", recoveryAction: "request a fresh signed bundle from the Realm", receipt: `messageDigest=${signatureDigest}; declared=${bundle.signing.messageDigest}; push=not-attempted` });
      const signatureValid = await verifyRunnerResultSignature({ publicKey: required(bundle.signing.publicKey, "signing.publicKey"), message: signatureMessage, signature: required(bundle.signing.signature, "signing.signature") });
      if (!signatureValid) throw new OutboundBridgeError({ code: "signature_invalid", message: "The outbound bundle signature is invalid.", recoveryAction: "request a fresh signed bundle and do not push the provider repository", receipt: `mirror=${bundle.mirrorId}; signature=invalid; push=not-attempted` });
      const plan: GitHubActionsBridgeOutboundPlan = { protocol: GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL, operationId: bundle.operationId, capabilityId: bundle.capabilityId, realmId: bundle.realmId, projectId: bundle.projectId, sourceSpaceId: bundle.sourceSpaceId, repositoryId: bundle.repositoryId, mirrorId: bundle.mirrorId, remoteRepository: bundle.remoteRepository, runId: bundle.runId, expectedRemoteGeneration: bundle.expectedRemoteGeneration, expectedRemoteRefs: bundle.expectedRemoteRefs, desiredRemoteRefs: expectedRemoteRefs, protectedRemoteRefs: protectedRefs, status: "ready", canonicalWrite: false, nextAction: "push the exact signed mapped refs with the job-scoped GitHub token, then report the read-back refs", receipt: "pending" };
      const finalized = { ...plan, receipt: planReceipt(plan) };
      return success(finalized, finalized.receipt);
    } catch (error) {
      if (error instanceof OutboundBridgeError) return failure({ code: error.code, message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt });
      return failure({ code: "outbound_preflight_failed", message: "Outbound Bridge preflight failed before a provider push.", recoveryAction: "inspect the signed bundle and customer-owned RepositoryDriver receipt, then request a fresh outbound run", receipt: "outbound=preflight-failed; push=not-attempted; canonicalWrite=false" });
    }
  }

  async complete(input: { plan: GitHubActionsBridgeOutboundPlan; capability: GitHubActionsBridgeCapability; bundle: GitHubActionsBridgeOutboundBundle; run: GitHubActionsBridgeOutboundRunObservation; provider: GitHubActionsBridgeOutboundProviderResult }): Promise<GitHubActionsBridgeOutboundResult<GitHubActionsBridgeOutboundCheckpoint>> {
    const prepared = await this.prepare({ capability: input.capability, bundle: input.bundle, run: input.run });
    if (prepared.status === "failed") return prepared;
    if (prepared.status !== "succeeded" || prepared.value.operationId !== input.plan.operationId || input.plan.status !== "ready") return failure({ code: "plan_invalid", message: "The outbound completion plan is not the current verified plan.", recoveryAction: "prepare a fresh outbound plan from the exact signed bundle and capability", receipt: `operation=${input.plan.operationId}; completion=not-accepted; canonicalWrite=false` });
    const claim = await this.ledger.claim(input.plan.operationId);
    if (claim === "duplicate") return failure({ code: "outbound_replay", message: "The outbound Bridge operation has already been consumed or is in flight.", recoveryAction: "inspect the existing Mirror checkpoint instead of replaying the provider push", receipt: `operation=${input.plan.operationId}; replay=true; canonicalWrite=false` });
    const receipt = safeReceipt(input.provider.receipt, "provider.receipt");
    if (input.provider.status === "failed") {
      await this.ledger.release?.(input.plan.operationId);
      const state: "blocked" | "degraded" = input.provider.remoteMayHaveChanged ? "degraded" : "blocked";
      const recoveryAction = input.provider.code === "protected-branch" ? "push the mapped refs to the configured mirror branch or open a Pull Request; do not report canonical synchronization until read-back matches" : input.provider.recoveryAction;
      const checkpoint: GitHubActionsBridgeOutboundCheckpoint = { plan: { ...input.plan, status: state, nextAction: recoveryAction, receipt: `operation=${input.plan.operationId}; state=${state}; provider=${input.provider.code}; canonicalWrite=false` }, state, expectedRemoteGeneration: input.plan.expectedRemoteGeneration, recoveryAction, receipt: `${receipt}; operation=${input.plan.operationId}; provider=${input.provider.code}; state=${state}; canonicalWrite=false` };
      return { status: state, checkpoint, recoveryAction, receipt: checkpoint.receipt, credentialMaterialStored: false };
    }
    const actualRefs = input.provider.refs;
    try { validateRefs(actualRefs, "provider.refs"); } catch (error) { await this.ledger.release?.(input.plan.operationId); if (error instanceof OutboundBridgeError) return failure({ code: error.code, message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt }); throw error; }
    if (!required(input.provider.generation, "provider.generation") || !refsEqual(actualRefs, input.plan.desiredRemoteRefs)) {
      await this.ledger.release?.(input.plan.operationId);
      return failure({ code: "push_result_mismatch", message: "The provider read-back refs do not equal the signed mapped refs.", recoveryAction: "quarantine the provider result, inspect the exact remote refs, and reconcile the Mirror checkpoint before retrying", receipt: `operation=${input.plan.operationId}; expectedRefs=${input.plan.desiredRemoteRefs.length}; actualRefs=${actualRefs.length}; providerReceipt=${receipt}; canonicalWrite=false` });
    }
    await this.ledger.complete?.(input.plan.operationId);
    const checkpoint: GitHubActionsBridgeOutboundCheckpoint = { plan: { ...input.plan, status: "ready", nextAction: "record the verified outbound Mirror checkpoint; no further provider write is required", receipt: `operation=${input.plan.operationId}; state=pushed; canonicalWrite=false` }, state: "pushed", expectedRemoteGeneration: input.plan.expectedRemoteGeneration, actualRemoteGeneration: input.provider.generation, actualRemoteRefs: actualRefs.map((ref) => ({ ...ref })), recoveryAction: "resume from this verified outbound checkpoint if the next workflow run is delayed", receipt: `${receipt}; operation=${input.plan.operationId}; state=pushed; refs=${actualRefs.length}; canonicalWrite=false` };
    return success(checkpoint, checkpoint.receipt);
  }
}
