import {
  CONTRACT_VERSIONS,
  type GitObjectFormat,
  type GitRef,
} from "../kernel/contracts.ts";
import type { GitHubActionsBridgeCapability, GitHubActionsBridgeOperation } from "./github-actions-bridge.ts";
import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, scanCredentialMaterial } from "../security/credential-material.ts";

/**
 * The source package is the only source transfer shape accepted by the
 * Actions Bridge. It is deliberately complete: a ref-only request is not a
 * repository import, and an LFS manifest without its bytes is not complete.
 */
export const GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL = CONTRACT_VERSIONS.githubActionsBridgeSource;

export type GitHubActionsBridgeHistoryRelation = "empty" | "same" | "github-ahead" | "canonical-ahead" | "diverged";

export type GitHubActionsBridgeLfsObjectUpload = {
  oid: string;
  size: number;
  digest: string;
  relativePath: string;
  bytes: Uint8Array;
  mediaType?: string;
};

export type GitHubActionsBridgeSourcePackage = {
  protocol: typeof GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL;
  operationId: string;
  capabilityId: string;
  realmId: string;
  projectId: string;
  sourceSpaceId: string;
  repositoryOwnerId: string;
  repositoryId: string;
  runId: string;
  objectFormat: GitObjectFormat;
  defaultBranch: string | null;
  refs: readonly GitRef[];
  bundle: {
    bytes: Uint8Array;
    digest: string;
    declaredBytes: number;
  };
  lfs: {
    state: "empty" | "complete" | "incomplete" | "unavailable";
    objects: readonly GitHubActionsBridgeLfsObjectUpload[];
  };
};

/**
 * History is a RepositoryDriver observation, not a field a GitHub workflow
 * may self-assert. The driver is responsible for ancestry comparison; this
 * seam carries its receipt into the Realm import decision.
 */
export type GitHubActionsBridgeHistoryObservation = {
  source: "repository-driver";
  objectFormat: GitObjectFormat;
  canonicalRefs: readonly GitRef[];
  githubRefs: readonly GitRef[];
  relation: GitHubActionsBridgeHistoryRelation;
  receipt: string;
};

export type GitHubActionsBridgeOwnerConfirmation = {
  status: "confirmed";
  principalId: string;
  sessionId: string;
  receipt: string;
};

export type GitHubActionsBridgeRepositoryImportReceipt = {
  status: "succeeded";
  repositoryId: string;
  sourceSnapshotId: string;
  objectFormat: GitObjectFormat;
  refs: readonly GitRef[];
  bundleDigest: string;
  lfsState: "empty" | "complete";
  checkpointId: string;
  receipt: string;
};

export type GitHubActionsBridgeRepositoryImporter = {
  importQuarantined(input: {
    sourcePackage: GitHubActionsBridgeSourcePackage;
    checkpointId: string;
  }): Promise<GitHubActionsBridgeRepositoryImportReceipt>;
};

export type GitHubActionsBridgeCanonicalCutover = {
  activateImportedRepository(input: {
    sourcePackage: GitHubActionsBridgeSourcePackage;
    imported: GitHubActionsBridgeRepositoryImportReceipt;
    ownerConfirmation: GitHubActionsBridgeOwnerConfirmation;
    checkpointId: string;
  }): Promise<{
    status: "succeeded";
    projectRevisionId: string;
    receipt: string;
  }>;
};

export type GitHubActionsBridgeProposalCreator = {
  createProposal(input: {
    sourcePackage: GitHubActionsBridgeSourcePackage;
    history: GitHubActionsBridgeHistoryObservation;
    capability: GitHubActionsBridgeCapability;
    checkpointId: string;
  }): Promise<{
    status: "succeeded";
    changeId: string;
    checkpointId: string;
    receipt: string;
  }>;
};

type ImportMode = "initial-import" | "proposal";

export type GitHubActionsBridgeImportPlan = {
  protocol: typeof GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL;
  operationId: string;
  capabilityId: string;
  realmId: string;
  projectId: string;
  sourceSpaceId: string;
  repositoryId: string;
  runId: string;
  mode: ImportMode;
  relation: GitHubActionsBridgeHistoryRelation;
  status: "awaiting-owner" | "ready" | "blocked";
  canonicalWrite: false;
  nextAction: string;
  receipt: string;
};

export type GitHubActionsBridgeImportActivation = {
  plan: GitHubActionsBridgeImportPlan;
  imported: GitHubActionsBridgeRepositoryImportReceipt;
  projectRevisionId: string;
  canonicalCutover: "owner-confirmed-initialization";
  checkpointId: string;
};

export type GitHubActionsBridgeProposal = {
  plan: GitHubActionsBridgeImportPlan;
  changeId: string;
  checkpointId: string;
  canonicalWrite: false;
};

export type GitHubActionsBridgeImportFailure = {
  status: "failed";
  code: string;
  message: string;
  recoveryAction: string;
  receipt: string;
  credentialMaterialStored: false;
};

export type GitHubActionsBridgeImportSuccess<T> = {
  status: "succeeded";
  value: T;
  receipt: string;
  credentialMaterialStored: false;
};

export type GitHubActionsBridgeImportResult<T> = GitHubActionsBridgeImportSuccess<T> | GitHubActionsBridgeImportFailure;

export type GitHubActionsBridgeImportLedger = {
  claim(operationId: string): Promise<"claimed" | "duplicate">;
  complete?(operationId: string): Promise<void> | void;
  release?(operationId: string): Promise<void> | void;
  snapshot?(): readonly string[];
};

export class MemoryGitHubActionsBridgeImportLedger implements GitHubActionsBridgeImportLedger {
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

export type GitHubActionsBridgeImportSnapshot = {
  completedOperationIds: readonly string[];
  credentialMaterialStored: false;
};

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new BridgeImportError({ code: "input_invalid", message: `${field} must be a non-empty string.`, recoveryAction: `provide a non-empty ${field} and retry; no import state changed`, receipt: `${field}=required; transition=not-applied` });
  return value.trim();
}

function credentialFreeReceipt(value: unknown, field: string): string {
  const receipt = required(value, field);
  const finding = scanCredentialMaterial(receipt, field);
  if (finding) throw new BridgeImportError({ code: "credential_in_receipt", message: `${field} contains credential-shaped material.`, recoveryAction: "return a digest-only credential-free receipt and retry; no import state changed", receipt: `${field}=credential-shaped; fieldPath=${finding.path}; scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; transition=not-applied; credentialMaterialStored=false` });
  return receipt;
}

function finiteSize(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new BridgeImportError({ code: "input_invalid", message: `${field} must be a non-negative safe integer.`, recoveryAction: `provide a measured ${field} and retry; no import state changed`, receipt: `${field}=safe-integer-required; transition=not-applied` });
  return value as number;
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
    if (names.has(name)) throw new BridgeImportError({ code: "refs_duplicate", message: `${field} contains duplicate ref ${name}.`, recoveryAction: "send one entry for each Git ref and retry; no import state changed", receipt: `${field}=duplicate; ref=${name}; transition=not-applied` });
    names.add(name);
  }
}

async function validatePackage(sourcePackage: GitHubActionsBridgeSourcePackage): Promise<void> {
  if (sourcePackage.protocol !== GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL) throw new BridgeImportError({ code: "protocol_invalid", message: "The GitHub Actions source package protocol is unsupported.", recoveryAction: `send ${GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL}; no import state changed`, receipt: `protocol=${String(sourcePackage.protocol)}; transition=not-applied` });
  required(sourcePackage.operationId, "operationId");
  required(sourcePackage.capabilityId, "capabilityId");
  required(sourcePackage.realmId, "realmId");
  required(sourcePackage.projectId, "projectId");
  required(sourcePackage.sourceSpaceId, "sourceSpaceId");
  required(sourcePackage.repositoryOwnerId, "repositoryOwnerId");
  required(sourcePackage.repositoryId, "repositoryId");
  required(sourcePackage.runId, "runId");
  if (sourcePackage.objectFormat !== "sha1" && sourcePackage.objectFormat !== "sha256") throw new BridgeImportError({ code: "object_format_invalid", message: "The source package object format is unsupported.", recoveryAction: "send sha1 or sha256 and retry; no import state changed", receipt: `objectFormat=${String(sourcePackage.objectFormat)}; transition=not-applied` });
  validateRefs(sourcePackage.refs, "refs");
  if (sourcePackage.refs.length === 0) throw new BridgeImportError({ code: "refs_empty", message: "A source package must declare at least one Git ref.", recoveryAction: "send the complete Git ref set and retry; no import state changed", receipt: "refs=non-empty-required; transition=not-applied" });
  if (sourcePackage.defaultBranch !== null) {
    const branch = required(sourcePackage.defaultBranch, "defaultBranch");
    if (!sourcePackage.refs.some((ref) => ref.name === `refs/heads/${branch}`)) throw new BridgeImportError({ code: "default_branch_missing", message: `The default branch ${branch} is not present in the declared refs.`, recoveryAction: "send the complete ref set or correct defaultBranch and retry; no import state changed", receipt: `defaultBranch=${branch}; ref=missing; transition=not-applied` });
  }
  if (!(sourcePackage.bundle.bytes instanceof Uint8Array)) throw new BridgeImportError({ code: "bundle_bytes_invalid", message: "The source package bundle must be binary bytes.", recoveryAction: "decode the complete Git bundle before invoking the import boundary; no import state changed", receipt: "bundle=uint8array-required; transition=not-applied" });
  const declaredBytes = finiteSize(sourcePackage.bundle.declaredBytes, "bundle.declaredBytes");
  if (declaredBytes !== sourcePackage.bundle.bytes.byteLength) throw new BridgeImportError({ code: "bundle_byte_count_mismatch", message: "The declared Git bundle byte count does not match the uploaded bytes.", recoveryAction: "send the exact complete Git bundle and measured byte count; no import state changed", receipt: `bundleBytes=${sourcePackage.bundle.bytes.byteLength}; declaredBytes=${declaredBytes}; transition=not-applied` });
  const actualBundleDigest = await digestBytes(sourcePackage.bundle.bytes);
  if (actualBundleDigest !== required(sourcePackage.bundle.digest, "bundle.digest")) throw new BridgeImportError({ code: "bundle_digest_mismatch", message: "The Git bundle digest does not match the uploaded bytes.", recoveryAction: "recreate the bundle digest over the exact uploaded bytes; no import state changed", receipt: `bundleDigest=${actualBundleDigest}; declared=${sourcePackage.bundle.digest}; transition=not-applied` });
  if (sourcePackage.lfs.state === "empty" && sourcePackage.lfs.objects.length > 0) throw new BridgeImportError({ code: "lfs_manifest_mismatch", message: "An empty LFS manifest cannot contain object uploads.", recoveryAction: "declare complete with every object or send empty with no objects; no import state changed", receipt: "lfs=empty-with-objects; transition=not-applied" });
  if (sourcePackage.lfs.state !== "empty" && sourcePackage.lfs.state !== "complete") throw new BridgeImportError({ code: "lfs_incomplete", message: `The source package LFS state is ${sourcePackage.lfs.state}; incomplete objects cannot be activated.`, recoveryAction: "upload every declared LFS object and retry the same immutable operation", receipt: `lfsState=${sourcePackage.lfs.state}; activation=not-applied` });
  const objectIds = new Set<string>();
  for (const object of sourcePackage.lfs.objects) {
    const oid = required(object.oid, "lfs.object.oid");
    if (objectIds.has(oid)) throw new BridgeImportError({ code: "lfs_duplicate", message: `The LFS manifest contains duplicate object ${oid}.`, recoveryAction: "send one upload for each LFS object and retry; no import state changed", receipt: `lfsObject=${oid}; duplicate=true; transition=not-applied` });
    objectIds.add(oid);
    const size = finiteSize(object.size, `lfs.object.${oid}.size`);
    required(object.digest, `lfs.object.${oid}.digest`);
    const path = required(object.relativePath, `lfs.object.${oid}.relativePath`);
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".")) throw new BridgeImportError({ code: "lfs_path_invalid", message: `The LFS object path ${path} is not package-relative.`, recoveryAction: "send a safe package-relative LFS path and retry; no import state changed", receipt: `lfsObject=${oid}; relativePath=invalid; transition=not-applied` });
    if (!(object.bytes instanceof Uint8Array) || object.bytes.byteLength !== size) throw new BridgeImportError({ code: "lfs_byte_count_mismatch", message: `LFS object ${oid} bytes do not match its declared size.`, recoveryAction: "send the complete LFS object and measured size; no import state changed", receipt: `lfsObject=${oid}; bytes=${object.bytes instanceof Uint8Array ? object.bytes.byteLength : "invalid"}; declared=${size}; transition=not-applied` });
    const actualDigest = await digestBytes(object.bytes);
    if (actualDigest !== object.digest) throw new BridgeImportError({ code: "lfs_digest_mismatch", message: `LFS object ${oid} digest does not match its bytes.`, recoveryAction: "recreate the LFS object digest over the exact uploaded bytes; no import state changed", receipt: `lfsObject=${oid}; digest=${actualDigest}; declared=${object.digest}; transition=not-applied` });
  }
}

function validateHistory(sourcePackage: GitHubActionsBridgeSourcePackage, history: GitHubActionsBridgeHistoryObservation): void {
  if (history.source !== "repository-driver") throw new BridgeImportError({ code: "history_untrusted", message: "The reconciliation history was not produced by the RepositoryDriver boundary.", recoveryAction: "inspect the repository through the configured RepositoryDriver and retry; no import state changed", receipt: "historySource=repository-driver-required; transition=not-applied" });
  if (history.objectFormat !== sourcePackage.objectFormat) throw new BridgeImportError({ code: "history_object_format_mismatch", message: "The RepositoryDriver history object format differs from the uploaded package.", recoveryAction: "reinspect the same repository and send one object format through the import boundary", receipt: `package=${sourcePackage.objectFormat}; history=${history.objectFormat}; transition=not-applied` });
  validateRefs(history.canonicalRefs, "history.canonicalRefs");
  validateRefs(history.githubRefs, "history.githubRefs");
  credentialFreeReceipt(history.receipt, "history.receipt");
  if (!refsEqual(history.githubRefs, sourcePackage.refs)) throw new BridgeImportError({ code: "history_ref_mismatch", message: "The RepositoryDriver history does not describe the uploaded Git refs.", recoveryAction: "reinspect and upload the exact same ref set; no import state changed", receipt: "historyRefs=package-mismatch; transition=not-applied" });
}

function capabilityMatches(input: { capability: GitHubActionsBridgeCapability; sourcePackage: GitHubActionsBridgeSourcePackage; mode: ImportMode; now: string }): void {
  const expectedOperation: GitHubActionsBridgeOperation = input.mode === "proposal" ? "proposal" : "inbound";
  if (input.capability.status !== "active") throw new BridgeImportError({ code: "capability_inactive", message: "The GitHub Actions Bridge capability is not active.", recoveryAction: "exchange a fresh verified OIDC assertion for the exact Bridge operation", receipt: `capability=${input.capability.id}; status=${input.capability.status}; transition=not-applied` });
  if (input.capability.operation !== expectedOperation) throw new BridgeImportError({ code: "capability_operation_mismatch", message: `The Bridge capability is scoped to ${input.capability.operation}, not ${expectedOperation}.`, recoveryAction: `exchange a ${expectedOperation} capability for this source operation`, receipt: `capability=${input.capability.id}; expected=${expectedOperation}; actual=${input.capability.operation}; transition=not-applied` });
  if (input.capability.canonicalWrite !== false) throw new BridgeImportError({ code: "canonical_write_capability", message: "A GitHub Actions Bridge capability cannot carry canonical write authority.", recoveryAction: "issue only credential-free inbound or proposal capabilities and use the owner-controlled Authority cutover", receipt: `capability=${input.capability.id}; canonicalWrite=true; transition=not-applied` });
  if (Date.parse(input.capability.expiresAt) <= Date.parse(input.now)) throw new BridgeImportError({ code: "capability_expired", message: "The GitHub Actions Bridge capability has expired.", recoveryAction: "request a fresh OIDC capability from a new workflow run", receipt: `capability=${input.capability.id}; expired=true; transition=not-applied` });
  const pairs: readonly [string, string][] = [["realmId", input.sourcePackage.realmId], ["projectId", input.sourcePackage.projectId], ["sourceSpaceId", input.sourcePackage.sourceSpaceId], ["repositoryOwnerId", input.sourcePackage.repositoryOwnerId], ["repositoryId", input.sourcePackage.repositoryId], ["runId", input.sourcePackage.runId], ["capabilityId", input.sourcePackage.capabilityId]];
  for (const [field, expected] of pairs) {
    const actual = field === "realmId" ? input.capability.realmId : field === "projectId" ? input.capability.projectId : field === "sourceSpaceId" ? input.capability.sourceSpaceId : field === "repositoryOwnerId" ? input.capability.repositoryOwnerId : field === "repositoryId" ? input.capability.repositoryId : field === "runId" ? input.capability.runId : input.capability.id;
    if (actual !== expected) throw new BridgeImportError({ code: "capability_binding_mismatch", message: `The Bridge capability does not bind the source package ${field}.`, recoveryAction: "send the exact Project, Source Space, repository, run, and capability identity issued by the Realm", receipt: `field=${field}; expected=${expected}; transition=not-applied` });
  }
}

function planReceipt(plan: GitHubActionsBridgeImportPlan): string {
  return `bridgeImport=${plan.operationId}; mode=${plan.mode}; case=${plan.relation}; status=${plan.status}; project=${plan.projectId}; sourceSpace=${plan.sourceSpaceId}; canonicalWrite=false; credentialMaterialStored=false`;
}

function failure(input: Omit<GitHubActionsBridgeImportFailure, "status" | "credentialMaterialStored">): GitHubActionsBridgeImportFailure {
  return { status: "failed", ...input, credentialMaterialStored: false };
}

function success<T>(value: T, receipt: string): GitHubActionsBridgeImportSuccess<T> {
  return { status: "succeeded", value, receipt, credentialMaterialStored: false };
}

export class BridgeImportError extends Error {
  readonly code: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: string; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "BridgeImportError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

export class GitHubActionsBridgeImportCoordinator {
  private readonly ledger: GitHubActionsBridgeImportLedger;
  private readonly now: () => string;

  constructor(input: { now?: () => string; ledger?: GitHubActionsBridgeImportLedger } = {}) {
    this.now = input.now ?? (() => new Date().toISOString());
    this.ledger = input.ledger ?? new MemoryGitHubActionsBridgeImportLedger();
  }

  snapshot(): GitHubActionsBridgeImportSnapshot {
    return { completedOperationIds: [...(this.ledger.snapshot?.() ?? [])], credentialMaterialStored: false };
  }

  async prepare(input: { capability: GitHubActionsBridgeCapability; sourcePackage: GitHubActionsBridgeSourcePackage; history: GitHubActionsBridgeHistoryObservation; mode: ImportMode }): Promise<GitHubActionsBridgeImportResult<GitHubActionsBridgeImportPlan>> {
    try {
      await validatePackage(input.sourcePackage);
      validateHistory(input.sourcePackage, input.history);
      capabilityMatches({ capability: input.capability, sourcePackage: input.sourcePackage, mode: input.mode, now: this.now() });
      const relation = input.history.relation;
      let status: GitHubActionsBridgeImportPlan["status"];
      let nextAction: string;
      if (input.mode === "initial-import") {
        status = relation === "empty" ? "awaiting-owner" : relation === "same" ? "ready" : "blocked";
        nextAction = relation === "empty" ? "request explicit owner confirmation before importing the verified package into the empty Project" : relation === "same" ? "record the matching GitHub ref observation; no source transfer is required" : "create an owner-visible reconciliation Change; the Bridge cannot overwrite canonical or GitHub history";
      } else {
        status = relation === "github-ahead" || relation === "same" ? "ready" : "blocked";
        nextAction = relation === "github-ahead" ? "create a quarantined Change proposal for reviewer routing; Landing remains Anyam-authoritative" : relation === "same" ? "record the matching GitHub ref observation; no proposal is required" : "reinspect the RepositoryDriver history and resolve the canonical/GitHub relationship before proposing a Change";
      }
      const plan: GitHubActionsBridgeImportPlan = { protocol: GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL, operationId: input.sourcePackage.operationId, capabilityId: input.capability.id, realmId: input.sourcePackage.realmId, projectId: input.sourcePackage.projectId, sourceSpaceId: input.sourcePackage.sourceSpaceId, repositoryId: input.sourcePackage.repositoryId, runId: input.sourcePackage.runId, mode: input.mode, relation, status, canonicalWrite: false, nextAction, receipt: "pending" };
      const finalized = { ...plan, receipt: planReceipt(plan) };
      return success(finalized, finalized.receipt);
    } catch (error) {
      if (error instanceof BridgeImportError) return failure({ code: error.code, message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt });
      return failure({ code: "import_preflight_failed", message: "GitHub Actions Bridge import preflight failed before any Authority transition.", recoveryAction: "inspect the typed source package and RepositoryDriver receipt, then retry the same immutable operation", receipt: "bridgeImport=preflight-failed; transition=not-applied; credentialMaterialStored=false" });
    }
  }

  async activateInitialImport(input: { plan: GitHubActionsBridgeImportPlan; capability: GitHubActionsBridgeCapability; sourcePackage: GitHubActionsBridgeSourcePackage; history: GitHubActionsBridgeHistoryObservation; ownerConfirmation?: GitHubActionsBridgeOwnerConfirmation; importer: GitHubActionsBridgeRepositoryImporter; cutover: GitHubActionsBridgeCanonicalCutover }): Promise<GitHubActionsBridgeImportResult<GitHubActionsBridgeImportActivation>> {
    const prepared = await this.prepare({ capability: input.capability, sourcePackage: input.sourcePackage, history: input.history, mode: "initial-import" });
    if (prepared.status === "failed") return prepared;
    if (prepared.value.operationId !== input.plan.operationId || input.plan.status !== "awaiting-owner" || prepared.value.relation !== "empty") return failure({ code: "plan_invalid", message: "The initial import plan is no longer an owner-confirmed empty-Project plan.", recoveryAction: "prepare a fresh empty-Project import plan and request owner confirmation again", receipt: `bridgeImport=${input.plan.operationId}; plan=invalid; transition=not-applied; canonicalWrite=false` });
    const confirmation = input.ownerConfirmation;
    if (!confirmation || confirmation.status !== "confirmed" || !confirmation.principalId.trim() || !confirmation.sessionId.trim() || !confirmation.receipt.trim()) return failure({ code: "owner_confirmation_required", message: "An empty Project import requires explicit owner confirmation.", recoveryAction: "authenticate the Project owner and confirm the exact package digest and RepositoryDriver checkpoint before retrying", receipt: `bridgeImport=${input.plan.operationId}; ownerConfirmation=required; transition=not-applied; canonicalWrite=false` });
    try { credentialFreeReceipt(confirmation.receipt, "ownerConfirmation.receipt"); } catch (error) { if (error instanceof BridgeImportError) return failure({ code: error.code, message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt }); throw error; }
    const claim = await this.ledger.claim(input.plan.operationId);
    if (claim === "duplicate") return failure({ code: "bridge_replay", message: "This Bridge import operation was already consumed.", recoveryAction: "inspect the existing owner-visible checkpoint and resume it instead of replaying the workflow run", receipt: `bridgeImport=${input.plan.operationId}; replay=true; transition=not-applied; canonicalWrite=false` });
    const checkpointId = `checkpoint:github-bridge-import:${input.plan.operationId}`;
    let imported: GitHubActionsBridgeRepositoryImportReceipt;
    try {
      imported = await input.importer.importQuarantined({ sourcePackage: input.sourcePackage, checkpointId });
    } catch {
      await this.ledger.release?.(input.plan.operationId);
      return failure({ code: "repository_import_failed", message: "The RepositoryDriver import boundary did not produce a verified quarantine receipt.", recoveryAction: "inspect the owner-visible import checkpoint and resume the same immutable operation after the RepositoryDriver is healthy", receipt: `bridgeImport=${input.plan.operationId}; checkpoint=${checkpointId}; quarantine=blocked; canonicalWrite=false` });
    }
    if (imported.status !== "succeeded" || imported.repositoryId !== input.sourcePackage.repositoryId || imported.objectFormat !== input.sourcePackage.objectFormat || imported.bundleDigest !== input.sourcePackage.bundle.digest || !refsEqual(imported.refs, input.sourcePackage.refs) || (input.sourcePackage.lfs.state === "empty" ? imported.lfsState !== "empty" : imported.lfsState !== "complete")) {
      await this.ledger.release?.(input.plan.operationId);
      return failure({ code: "repository_import_receipt_mismatch", message: "The RepositoryDriver import receipt does not match the verified source package.", recoveryAction: "reconcile the quarantined repository against the package digest, refs, object format, and LFS manifest before activation", receipt: `bridgeImport=${input.plan.operationId}; checkpoint=${checkpointId}; importReceipt=contradictory; canonicalWrite=false` });
    }
    try { credentialFreeReceipt(imported.receipt, "repositoryImport.receipt"); } catch (error) { await this.ledger.release?.(input.plan.operationId); if (error instanceof BridgeImportError) return failure({ code: error.code, message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt }); throw error; }
    let cutover: Awaited<ReturnType<GitHubActionsBridgeCanonicalCutover["activateImportedRepository"]>>;
    try {
      cutover = await input.cutover.activateImportedRepository({ sourcePackage: input.sourcePackage, imported, ownerConfirmation: confirmation, checkpointId });
    } catch {
      await this.ledger.release?.(input.plan.operationId);
      return failure({ code: "canonical_cutover_failed", message: "The owner-confirmed import remains quarantined because the Authority cutover did not complete.", recoveryAction: "resume the named checkpoint through the customer Realm; do not replay the GitHub workflow or overwrite the Project", receipt: `bridgeImport=${input.plan.operationId}; checkpoint=${checkpointId}; quarantine=verified; canonicalCutover=blocked; canonicalWrite=false` });
    }
    try { credentialFreeReceipt(cutover.receipt, "canonicalCutover.receipt"); } catch (error) { await this.ledger.release?.(input.plan.operationId); if (error instanceof BridgeImportError) return failure({ code: error.code, message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt }); throw error; }
    await this.ledger.complete?.(input.plan.operationId);
    return success({ plan: input.plan, imported, projectRevisionId: cutover.projectRevisionId, canonicalCutover: "owner-confirmed-initialization", checkpointId }, `bridgeImport=${input.plan.operationId}; checkpoint=${checkpointId}; repository=${imported.repositoryId}; sourceSnapshot=${imported.sourceSnapshotId}; projectRevision=${cutover.projectRevisionId}; canonicalCutover=owner-confirmed-initialization; canonicalWrite=false; credentialMaterialStored=false`);
  }

  async createProposal(input: { plan: GitHubActionsBridgeImportPlan; capability: GitHubActionsBridgeCapability; sourcePackage: GitHubActionsBridgeSourcePackage; history: GitHubActionsBridgeHistoryObservation; creator: GitHubActionsBridgeProposalCreator }): Promise<GitHubActionsBridgeImportResult<GitHubActionsBridgeProposal>> {
    const prepared = await this.prepare({ capability: input.capability, sourcePackage: input.sourcePackage, history: input.history, mode: "proposal" });
    if (prepared.status === "failed") return prepared;
    if (prepared.value.operationId !== input.plan.operationId || prepared.value.status !== "ready" || prepared.value.relation !== "github-ahead") return failure({ code: "proposal_plan_invalid", message: "The GitHub Actions proposal plan is not a ready GitHub-ahead observation.", recoveryAction: "reinspect the exact RepositoryDriver history and prepare a fresh proposal plan", receipt: `bridgeImport=${input.plan.operationId}; proposal=not-created; canonicalWrite=false` });
    const claim = await this.ledger.claim(input.plan.operationId);
    if (claim === "duplicate") return failure({ code: "bridge_replay", message: "This Bridge proposal operation was already consumed.", recoveryAction: "inspect the existing Change checkpoint instead of replaying the workflow run", receipt: `bridgeImport=${input.plan.operationId}; replay=true; proposal=not-created; canonicalWrite=false` });
    const checkpointId = `checkpoint:github-bridge-proposal:${input.plan.operationId}`;
    try {
      const proposal = await input.creator.createProposal({ sourcePackage: input.sourcePackage, history: input.history, capability: input.capability, checkpointId });
      if (proposal.status !== "succeeded" || !proposal.changeId || proposal.checkpointId !== checkpointId) { await this.ledger.release?.(input.plan.operationId); return failure({ code: "proposal_receipt_mismatch", message: "The proposal boundary did not return a complete Change checkpoint.", recoveryAction: "inspect the quarantined proposal checkpoint before retrying the same immutable operation", receipt: `bridgeImport=${input.plan.operationId}; checkpoint=${checkpointId}; proposal=contradictory; canonicalWrite=false` }); }
      try { credentialFreeReceipt(proposal.receipt, "proposal.receipt"); } catch (error) { await this.ledger.release?.(input.plan.operationId); if (error instanceof BridgeImportError) return failure({ code: error.code, message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt }); throw error; }
      await this.ledger.complete?.(input.plan.operationId);
      return success({ plan: input.plan, changeId: proposal.changeId, checkpointId, canonicalWrite: false }, `bridgeImport=${input.plan.operationId}; checkpoint=${checkpointId}; change=${proposal.changeId}; proposal=created; landing=not-performed; canonicalWrite=false; credentialMaterialStored=false`);
    } catch {
      await this.ledger.release?.(input.plan.operationId);
      return failure({ code: "proposal_creation_failed", message: "The Bridge proposal remains uncreated because the Change boundary did not complete.", recoveryAction: "inspect the owner-visible proposal checkpoint and retry only the same immutable operation", receipt: `bridgeImport=${input.plan.operationId}; checkpoint=${checkpointId}; proposal=blocked; canonicalWrite=false` });
    }
  }
}
