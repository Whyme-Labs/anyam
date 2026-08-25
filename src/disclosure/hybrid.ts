import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

import { EvidenceLedger, type EvidenceRecord } from "../kernel/evidence.ts";
import {
  CONTRACT_VERSIONS,
  opaqueId,
  type ActorRef,
  type ChangeRevision,
  type DisclosureClassification,
  type EvidenceOutcome,
  type Intent,
  type IntentComment,
  type PullRequest,
  type Project,
  type ProjectRevision,
  type SourceSpace,
} from "../kernel/contracts.ts";
import type { RepositoryDriver, RepositoryHandle } from "../portability/repository-driver.ts";

/**
 * Errors from the hybrid disclosure boundary are deliberately structured. A
 * caller can render the recovery action directly to a developer or agent,
 * without converting a failed publication into a silent empty result.
 */
export type HybridDisclosureErrorCode =
  | "project-mismatch"
  | "duplicate-source-space"
  | "unknown-source-space"
  | "source-space-not-in-project"
  | "public-source-space-required"
  | "missing-public-snapshot"
  | "source-snapshot-mismatch"
  | "source-content-missing"
  | "public-file-invalid"
  | "public-file-collision"
  | "public-destination-not-empty"
  | "repository-operation-failed"
  | "audience-not-authorized"
  | "public-projection-required"
  | "private-input-mismatch"
  | "sealed-output-invalid"
  | "sealed-side-channel"
  | "publication-state"
  | "publication-not-previewed"
  | "publication-not-landed";

export class HybridDisclosureError extends Error {
  readonly code: HybridDisclosureErrorCode;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    code: HybridDisclosureErrorCode;
    message: string;
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "HybridDisclosureError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function fail(input: ConstructorParameters<typeof HybridDisclosureError>[0]): never {
  throw new HybridDisclosureError(input);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value)) ?? "null";
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function disclosureRank(value: DisclosureClassification): number {
  return value === "public" ? 0 : value === "project" ? 1 : 2;
}

function sortedUnique(values: readonly string[], error: HybridDisclosureErrorCode, message: string): string[] {
  const sorted = [...values].sort((left, right) => left.localeCompare(right));
  if (new Set(sorted).size !== sorted.length) {
    fail({
      code: error,
      message,
      recoveryAction: "remove duplicate Source Space entries and retry the disclosure operation",
      receipt: `rule=unique-source-space-identities; count=${sorted.length}`,
    });
  }
  return sorted;
}

function normalizePublicPath(value: string): string {
  const replaced = value.replaceAll("\\", "/");
  const normalized = posix.normalize(replaced).replace(/^\.\//, "");
  const segments = replaced.split("/");
  if (
    replaced.length === 0
    || normalized.length === 0
    || normalized === "."
    || normalized.startsWith("/")
    || segments.some((segment) => segment === "..")
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || normalized.includes("\0")
    || segments.includes(".git")
  ) {
    fail({
      code: "public-file-invalid",
      message: "Public projection contains an invalid file path; projection paths must be relative and outside Git metadata.",
      recoveryAction: "remove absolute, traversal, NUL, or .git paths and preview the Publication Change again",
      receipt: "rule=relative-no-traversal-no-git-metadata",
    });
  }
  return normalized;
}

function catalogById(sourceSpaces: readonly SourceSpace[]): Map<string, SourceSpace> {
  if (new Set(sourceSpaces.map((space) => space.id)).size !== sourceSpaces.length) {
    fail({
      code: "duplicate-source-space",
      message: "The Source Space catalog contains duplicate identities.",
      recoveryAction: "provide one catalog entry per Source Space and retry",
      receipt: "rule=unique-source-space-catalog",
    });
  }
  return new Map(sourceSpaces.map((space) => [space.id, space]));
}

function publicSourceSpaceIds(input: {
  project: Project;
  revision: ProjectRevision;
  sourceSpaces: readonly SourceSpace[];
  requestedIds: readonly string[];
}): string[] {
  if (input.revision.projectId !== input.project.id) {
    fail({
      code: "project-mismatch",
      message: "The Project Revision does not belong to the requested Project.",
      recoveryAction: "derive the public projection from the same Project and Project Revision",
      receipt: "rule=revision-project-equality",
    });
  }
  const catalog = catalogById(input.sourceSpaces);
  const projectIds = new Set(input.project.sourceSpaceIds);
  const ids = sortedUnique(
    input.requestedIds,
    "duplicate-source-space",
    "A public projection cannot disclose one Source Space more than once.",
  );
  for (const id of ids) {
    const sourceSpace = catalog.get(id);
    if (!sourceSpace) {
      fail({
        code: "unknown-source-space",
        message: "The requested Source Space is not in the authorized projection catalog.",
        recoveryAction: "refresh the Source Space catalog and retry with an authorized public Source Space",
        receipt: "rule=catalog-membership",
      });
    }
    if (!projectIds.has(id)) {
      fail({
        code: "source-space-not-in-project",
        message: "The requested Source Space is not owned by the Project.",
        recoveryAction: "select a Source Space declared by the Project",
        receipt: "rule=project-source-space-membership",
      });
    }
    if (sourceSpace.classification !== "public") {
      fail({
        code: "public-source-space-required",
        message: "A public projection can contain only public Source Spaces.",
        recoveryAction: "publish an explicit safe projection of a public Source Space; do not change visibility in place",
        receipt: "rule=public-classification-only",
      });
    }
    if (!Object.prototype.hasOwnProperty.call(input.revision.sourceSpaceSnapshots, id)) {
      fail({
        code: "missing-public-snapshot",
        message: "The Project Revision has no exact snapshot for one selected public Source Space.",
        recoveryAction: "refresh the canonical Project Revision before previewing publication",
        receipt: "rule=revision-snapshot-required",
      });
    }
  }
  return ids;
}

export type PublicProjectionSource = {
  sourceSpaceId: string;
  snapshotId: string;
  files: Readonly<Record<string, string>>;
  /** Required when several public Source Spaces could otherwise collide. */
  mountPath?: string;
};

export type PublicProjectionInput = {
  project: Project;
  canonicalRevision: ProjectRevision;
  sourceSpaces: readonly SourceSpace[];
  publicSourceSpaceIds: readonly string[];
  sources: readonly PublicProjectionSource[];
  /** A Project Profile identity, never a canonical Project Revision identity. */
  profileId?: string;
};

export type PublicProjectionSourceDescriptor = {
  id: string;
  name: string;
  snapshotId: string;
};

/**
 * A public Project View Revision. Every field is derived from the authorized
 * public Source Spaces only. In particular, it intentionally contains no
 * canonical Project Revision ID and no private Source Space metadata.
 */
export type PublicProjectionRevision = {
  protocol: typeof CONTRACT_VERSIONS.publicProjection;
  version: "v1";
  projectId: string;
  projectName: string;
  profileId: string;
  classification: "public";
  lineageId: string;
  projectionRevisionId: string;
  publicSnapshotId: string;
  contentDigest: string;
  sourceSpaces: readonly PublicProjectionSourceDescriptor[];
  sourceSpaceIds: readonly string[];
  sourceSpaceSnapshots: Readonly<Record<string, string>>;
  filePaths: readonly string[];
  files: Readonly<Record<string, string>>;
  receipt: string;
};

function projectionFiles(input: {
  sources: readonly PublicProjectionSource[];
  selectedIds: readonly string[];
  revision: ProjectRevision;
}): { files: Readonly<Record<string, string>>; descriptors: readonly { sourceSpaceId: string; snapshotId: string; mountPath: string }[] } {
  const byId = new Map<string, PublicProjectionSource>();
  for (const source of input.sources) {
    if (byId.has(source.sourceSpaceId)) {
      fail({
        code: "duplicate-source-space",
        message: "Public projection content names one Source Space more than once.",
        recoveryAction: "provide exactly one content snapshot for each selected public Source Space",
        receipt: "rule=unique-source-content-inputs",
      });
    }
    byId.set(source.sourceSpaceId, source);
  }
  const descriptors: { sourceSpaceId: string; snapshotId: string; mountPath: string }[] = [];
  const files: Record<string, string> = {};
  for (const id of input.selectedIds) {
    const source = byId.get(id);
    if (!source) {
      fail({
        code: "source-content-missing",
        message: "Public projection content is missing for one selected Source Space.",
        recoveryAction: "load the exact authorized Source Space snapshot and retry preview",
        receipt: "rule=content-for-every-selected-source-space",
      });
    }
    const expectedSnapshot = input.revision.sourceSpaceSnapshots[id];
    if (source.snapshotId !== expectedSnapshot) {
      fail({
        code: "source-snapshot-mismatch",
        message: "Public projection content does not match the exact Project Revision snapshot.",
        recoveryAction: "refresh the source content from the requested Project Revision",
        receipt: "rule=content-snapshot-equality",
      });
    }
    const mountPath = source.mountPath === undefined
      ? input.selectedIds.length === 1 ? "" : id
      : normalizePublicPath(source.mountPath);
    descriptors.push({ sourceSpaceId: id, snapshotId: source.snapshotId, mountPath });
    for (const [rawPath, content] of Object.entries(source.files)) {
      const path = normalizePublicPath(rawPath);
      const mounted = mountPath.length === 0 ? path : `${mountPath}/${path}`;
      if (Object.prototype.hasOwnProperty.call(files, mounted)) {
        fail({
          code: "public-file-collision",
          message: "Two public Source Spaces map to the same projection path.",
          recoveryAction: "assign explicit non-overlapping public mount paths and preview again",
          receipt: "rule=collision-free-public-projection",
        });
      }
      files[mounted] = content;
    }
  }
  return { files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))), descriptors };
}

export function createPublicProjection(input: PublicProjectionInput): PublicProjectionRevision {
  const selectedIds = publicSourceSpaceIds({
    project: input.project,
    revision: input.canonicalRevision,
    sourceSpaces: input.sourceSpaces,
    requestedIds: input.publicSourceSpaceIds,
  });
  const catalog = catalogById(input.sourceSpaces);
  const projected = projectionFiles({ sources: input.sources, selectedIds, revision: input.canonicalRevision });
  const profileId = input.profileId ?? "public";
  const sourceSpaces = selectedIds.map((id) => {
    const space = catalog.get(id);
    if (!space) {
      fail({
        code: "unknown-source-space",
        message: "The public Source Space disappeared while constructing the projection.",
        recoveryAction: "refresh the Source Space catalog and retry",
        receipt: "rule=stable-catalog-during-projection",
      });
    }
    const snapshotId = input.canonicalRevision.sourceSpaceSnapshots[id];
    if (snapshotId === undefined) {
      fail({
        code: "missing-public-snapshot",
        message: "A selected public Source Space has no snapshot in the Project Revision.",
        recoveryAction: "refresh the canonical Project Revision and retry",
        receipt: "rule=revision-snapshot-required",
      });
    }
    return { id, name: space.name, snapshotId };
  });
  const lineageId = digest({
    protocol: CONTRACT_VERSIONS.publicProjection,
    projectId: input.project.id,
    profileId,
    sourceSpaceIds: selectedIds,
  });
  const contentDigest = digest(projected.files);
  const publicSnapshotId = digest({
    protocol: CONTRACT_VERSIONS.publicProjection,
    lineageId,
    sourceSpaces,
    files: projected.files,
  });
  const projectionRevisionId = digest({
    protocol: CONTRACT_VERSIONS.publicProjection,
    lineageId,
    publicSnapshotId,
  });
  const sourceSpaceSnapshots = Object.fromEntries(sourceSpaces.map((space) => [space.id, space.snapshotId]));
  return {
    protocol: CONTRACT_VERSIONS.publicProjection,
    version: "v1",
    projectId: input.project.id,
    projectName: input.project.name,
    profileId,
    classification: "public",
    lineageId,
    projectionRevisionId,
    publicSnapshotId,
    contentDigest,
    sourceSpaces,
    sourceSpaceIds: selectedIds,
    sourceSpaceSnapshots,
    filePaths: Object.keys(projected.files),
    files: projected.files,
    receipt: `public-lineage=${lineageId}; projection-revision=${projectionRevisionId}; canonical-revision=omitted`,
  };
}

export type PublicProjectionPublishResult = {
  projection: PublicProjectionRevision;
  repository: RepositoryHandle;
  commitId: string;
  receipt: string;
};

async function assertEmptyDestination(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory);
    if (entries.length > 0) {
      fail({
        code: "public-destination-not-empty",
        message: "The public projection destination is not empty; refusing to mix public and private files.",
        recoveryAction: "choose a new empty destination or remove it only after independently verifying ownership",
        receipt: "rule=empty-public-projection-destination",
      });
    }
  } catch (error) {
    if (error instanceof HybridDisclosureError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function driverFailure(result: { status: "failed"; errorCode: string; message: string; receipt?: string; recoveryAction?: string }): never {
  fail({
    code: "repository-operation-failed",
    message: result.message,
    recoveryAction: result.recoveryAction ?? "inspect the RepositoryDriver checkpoint and retry the public projection",
    receipt: result.receipt ?? `driver-error=${result.errorCode}`,
  });
}

/**
 * Materialize only the public projection into a separate Git repository. The
 * destination is required to be empty so an old private checkout cannot be
 * accidentally reused as a public clone.
 */
export async function materializePublicProjection(input: {
  projection: PublicProjectionRevision;
  driver: RepositoryDriver;
  destination: string;
  author?: { name: string; email: string };
}): Promise<PublicProjectionPublishResult> {
  const destination = resolve(input.destination);
  await mkdir(dirname(destination), { recursive: true });
  await assertEmptyDestination(destination);
  const repositoryResult = await input.driver.createRepository({
    sourceSpaceId: input.projection.sourceSpaceIds[0] ?? `public-projection:${input.projection.lineageId}`,
    directory: destination,
  });
  if (repositoryResult.status === "failed") driverFailure(repositoryResult);
  for (const [path, content] of Object.entries(input.projection.files)) {
    const target = join(destination, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  const commitResult = await input.driver.commitRepository({
    repository: repositoryResult.value,
    message: `Publish public projection ${input.projection.projectionRevisionId}`,
    ...(input.author ? { author: input.author } : {}),
  });
  if (commitResult.status === "failed") driverFailure(commitResult);
  return {
    projection: input.projection,
    repository: repositoryResult.value,
    commitId: commitResult.value.commitId,
    receipt: `public-projection=${input.projection.projectionRevisionId}; commit=${commitResult.value.commitId}; private-content=not-materialized`,
  };
}

export type PublicChangeEffect = {
  sourceSpaceId: string;
  publicLabel: string;
  internalLabel?: string;
};

export type AudienceEvidenceProjection = {
  id: string;
  outcome: EvidenceOutcome;
  disclosure: DisclosureClassification;
};

export type AudienceChangeSummary = {
  protocol: typeof CONTRACT_VERSIONS.disclosure;
  version: "v1";
  audience: DisclosureClassification;
  projectId: string;
  changeId: string;
  revisionId: string;
  summary: string;
  affectedSourceSpaceIds: readonly string[];
  declaredEffects: readonly string[];
  evidence: readonly AudienceEvidenceProjection[];
  receipt: string;
};

export type AudienceIntentSummary = {
  protocol: typeof CONTRACT_VERSIONS.disclosure;
  version: "v1";
  audience: DisclosureClassification;
  projectId: string;
  intentId: string;
  title: string;
  description: string;
  status: "open" | "closed";
  labels: readonly string[];
  comments: readonly { id: string; body: string; disclosure: DisclosureClassification }[];
  receipt: string;
};

export type AudiencePullRequestSummary = {
  protocol: typeof CONTRACT_VERSIONS.disclosure;
  version: "v1";
  audience: DisclosureClassification;
  projectId: string;
  pullRequestId: string;
  changeId?: string;
  title: string;
  description: string;
  status: PullRequest["status"];
  reviewState: PullRequest["reviewState"];
  headRef: string;
  baseRef: string;
  revisionCount: number;
  receipt: string;
};

/**
 * Produce the Intent surface an audience is allowed to see. A restricted or
 * project-only Intent is omitted entirely from a public projection; callers
 * must not turn an omitted value into a redacted placeholder that leaks its
 * existence or metadata.
 */
export function summarizeIntentForAudience(input: {
  project: Project;
  intent: Intent;
  comments?: readonly IntentComment[];
  audience: DisclosureClassification;
}): AudienceIntentSummary | undefined {
  if (input.intent.projectId !== input.project.id) {
    fail({
      code: "project-mismatch",
      message: "The Intent does not belong to the requested Project.",
      recoveryAction: "derive the Intent summary from the same Project that owns the Intent",
      receipt: "rule=intent-project-equality",
    });
  }
  if (disclosureRank(input.intent.disclosure) > disclosureRank(input.audience)) return undefined;
  const comments = (input.comments ?? [])
    .filter((comment) => comment.intentId === input.intent.id && disclosureRank(comment.disclosure) <= disclosureRank(input.audience))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map((comment) => ({ id: comment.id, body: comment.body, disclosure: comment.disclosure }));
  return {
    protocol: CONTRACT_VERSIONS.disclosure,
    version: "v1",
    audience: input.audience,
    projectId: input.project.id,
    intentId: input.intent.id,
    title: input.intent.title,
    description: input.intent.description,
    status: input.intent.status,
    labels: [...input.intent.labels],
    comments,
    receipt: `audience=${input.audience}; intent=${input.intent.id}; inaccessible-metadata=omitted; author=omitted; assignees=omitted`,
  };
}

/**
 * Project a Pull Request without turning provider identity into a public
 * authority or leaking a private Change identifier. Restricted Pull Requests
 * are omitted rather than represented by a detectable placeholder.
 */
export function summarizePullRequestForAudience(input: {
  project: Project;
  pullRequest: PullRequest;
  audience: DisclosureClassification;
}): AudiencePullRequestSummary | undefined {
  if (input.pullRequest.projectId !== input.project.id) {
    fail({ code: "project-mismatch", message: "The Pull Request does not belong to the requested Project.", recoveryAction: "derive the Pull Request summary from the same Project that owns it", receipt: "rule=pull-request-project-equality" });
  }
  if (disclosureRank(input.pullRequest.disclosure) > disclosureRank(input.audience)) return undefined;
  return {
    protocol: CONTRACT_VERSIONS.disclosure,
    version: "v1",
    audience: input.audience,
    projectId: input.project.id,
    pullRequestId: input.pullRequest.id,
    ...(input.audience === "public" ? {} : { changeId: input.pullRequest.changeId }),
    title: input.pullRequest.title,
    description: input.pullRequest.description,
    status: input.pullRequest.status,
    reviewState: input.pullRequest.reviewState,
    headRef: input.pullRequest.headRef,
    baseRef: input.pullRequest.baseRef,
    revisionCount: input.pullRequest.revisionIds.length,
    receipt: `audience=${input.audience}; pullRequest=${input.pullRequest.id}; provider-identity=omitted; remoteRepository=omitted; canonicalAuthority=anyam`,
  };
}

export function summarizeChangeForAudience(input: {
  project: Project;
  changeRevision: ChangeRevision;
  sourceSpaces: readonly SourceSpace[];
  audience: DisclosureClassification;
  publicSummary: string;
  internalSummary?: string;
  publicProjection?: PublicProjectionRevision;
  effects?: readonly PublicChangeEffect[];
  evidence?: readonly EvidenceRecord[];
}): AudienceChangeSummary {
  const catalog = catalogById(input.sourceSpaces);
  if (input.audience === "public" && !input.publicProjection) {
    fail({
      code: "public-projection-required",
      message: "A public Change summary requires the exact public Project View Revision it describes.",
      recoveryAction: "derive or load the public projection before rendering the public Change summary",
      receipt: "rule=public-summary-binds-to-public-projection",
    });
  }
  const effectInputs = input.effects ?? [];
  const projectSourceIds = new Set(input.project.sourceSpaceIds);
  for (const effect of effectInputs) {
    if (!catalog.has(effect.sourceSpaceId)) {
      fail({
        code: "unknown-source-space",
        message: "A Change effect names a Source Space outside the disclosure catalog.",
        recoveryAction: "refresh the Project Source Space catalog and retry the audience projection",
        receipt: "rule=effect-source-space-catalog-membership",
      });
    }
    if (!projectSourceIds.has(effect.sourceSpaceId)) {
      fail({
        code: "source-space-not-in-project",
        message: "A Change effect names a Source Space outside the Project.",
        recoveryAction: "attach the effect to a Source Space owned by the Project",
        receipt: "rule=effect-project-membership",
      });
    }
  }
  const visibleEffects = effectInputs.filter((effect) => catalog.get(effect.sourceSpaceId)?.classification === "public");
  const affectedIds = input.audience === "public"
    ? [...new Set([
      ...(input.changeRevision.affectedSourceSpaceIds ?? []).filter((id) => catalog.get(id)?.classification === "public"),
      ...visibleEffects.map((effect) => effect.sourceSpaceId),
    ])].sort((left, right) => left.localeCompare(right))
    : [...new Set([
      ...(input.changeRevision.affectedSourceSpaceIds ?? []),
      ...effectInputs.map((effect) => effect.sourceSpaceId),
    ])].sort((left, right) => left.localeCompare(right));
  const effects = input.audience === "public"
    ? visibleEffects.map((effect) => effect.publicLabel)
    : effectInputs.map((effect) => effect.internalLabel ?? effect.publicLabel);
  const projectionId = input.publicProjection?.projectionRevisionId ?? `project:${input.project.id}`;
  const changeId = input.audience === "public"
    ? digest({ domain: "public-change", projectionId, changeId: input.changeRevision.changeId })
    : input.changeRevision.changeId;
  const revisionId = input.audience === "public"
    ? digest({ domain: "public-change-revision", projectionId, changeId, sequence: input.changeRevision.sequence })
    : input.changeRevision.id;
  const evidence = (input.evidence ?? [])
    .filter((record) => input.audience !== "public" || record.disclosure.classification === "public")
    .map((record) => ({
      id: input.audience === "public" ? digest({ domain: "public-evidence", projectionId, evidence: record.id }) : record.id,
      outcome: record.outcome,
      disclosure: input.audience === "public" ? "public" as const : record.disclosure.classification,
    }));
  return {
    protocol: CONTRACT_VERSIONS.disclosure,
    version: "v1",
    audience: input.audience,
    projectId: input.project.id,
    changeId,
    revisionId,
    summary: input.audience === "public" ? input.publicSummary : input.internalSummary ?? input.publicSummary,
    affectedSourceSpaceIds: affectedIds,
    declaredEffects: effects,
    evidence,
    receipt: `audience=${input.audience}; projection=${projectionId}; inaccessible-metadata=omitted`,
  };
}

export type SealedDisclosureClass = "status" | "safe-summary" | "redacted-findings" | "authorized-detail";

export type SealedVerifierContract = {
  protocol: typeof CONTRACT_VERSIONS.sealedVerifier;
  version: "v1";
  id: string;
  name: string;
  actionId: string;
  actionContractDigest: string;
  contractDigest: string;
  acceptedInput: "public-project-view" | "public-change-revision";
  privateSourceSpaceIds: readonly string[];
  allowedAudiences: readonly DisclosureClassification[];
  disclosure: SealedDisclosureClass;
  sideChannelPolicy: "coarse" | "owner-controlled";
  appealPolicy: "maintainer-review" | "deterministic-rerun" | "none";
};

export type SealedVerifierPrivateInput = {
  sourceSpaceIds: readonly string[];
  files: Readonly<Record<string, string>>;
  inputDigests: readonly string[];
};

export type SealedVerifierExecutionContext = {
  publicProjection: PublicProjectionRevision;
  changeRevision: ChangeRevision;
  privateInput: SealedVerifierPrivateInput;
};

export type SealedVerifierPrivateResult = {
  status: "passed" | "failed" | "indeterminate";
  safeSummary?: string;
  safeFindings?: readonly { code: string; summary: string }[];
  outputDigest: string;
  privateReceipt: string;
};

export type SealedEvidenceProjection = {
  id: string;
  outcome: EvidenceOutcome;
  disclosure: DisclosureClassification;
  verifierId: string;
  projectViewId: string;
};

export type SealedVerificationAppeal = {
  id: string;
  runId: string;
  status: "eligible" | "not-available";
  audience: DisclosureClassification;
  projectViewId: string;
  receipt: string;
};

export type SealedVerificationResult = {
  protocol: typeof CONTRACT_VERSIONS.sealedVerifier;
  version: "v1";
  id: string;
  runId: string;
  verifierId: string;
  audience: DisclosureClassification;
  status: SealedVerifierPrivateResult["status"];
  disclosure: SealedDisclosureClass;
  projectViewId: string;
  summary?: string;
  findings?: readonly { code: string; summary: string }[];
  evidence: SealedEvidenceProjection;
  appeal: SealedVerificationAppeal;
  contractDigest: string;
  receipt: string;
};

function containsRestrictedMarker(value: unknown, privateInput: SealedVerifierPrivateInput): boolean {
  const serialized = stableJson(value);
  const markers = [
    ...privateInput.sourceSpaceIds,
    ...Object.keys(privateInput.files),
    ...privateInput.inputDigests,
  ];
  if (markers.some((marker) => marker.length > 0 && serialized.includes(marker))) return true;
  return /\b\d+\s+tests?\b|\bduration\s*[:=]|\belapsed\s*[:=]|\bcache\s*[:=]|\b(?:cpu|memory|resource)\s+(?:usage|cost)\s*[:=]/i.test(serialized);
}

function validatePrivateInput(contract: SealedVerifierContract, privateInput: SealedVerifierPrivateInput): void {
  const expected = sortedUnique(contract.privateSourceSpaceIds, "duplicate-source-space", "A Sealed Verifier contract names a private Source Space more than once.");
  const actual = sortedUnique(privateInput.sourceSpaceIds, "duplicate-source-space", "A Sealed Verifier invocation names a private Source Space more than once.");
  if (stableJson(expected) !== stableJson(actual)) {
    fail({
      code: "private-input-mismatch",
      message: "The Sealed Verifier received private inputs outside its versioned contract.",
      recoveryAction: "invoke the verifier with the owner-selected private inputs for this exact contract",
      receipt: "rule=contract-private-input-equality",
    });
  }
}

/**
 * Run a private verifier while returning only its owner-approved disclosure
 * projection. The callback is the trust boundary: it sees private inputs,
 * while the returned object never carries the private receipt or raw result.
 */
export async function runSealedVerifier(input: {
  projectId: string;
  publicProjection: PublicProjectionRevision;
  changeRevision: ChangeRevision;
  contract: SealedVerifierContract;
  audience: DisclosureClassification;
  privateInput: SealedVerifierPrivateInput;
  execute: (context: SealedVerifierExecutionContext) => Promise<SealedVerifierPrivateResult> | SealedVerifierPrivateResult;
  ledger?: EvidenceLedger;
  actor: ActorRef;
  runnerId: string;
  policyVersion: string;
  authorizationEpoch: string;
  capabilityGrantId: string;
  owner: string;
  now?: () => string;
}): Promise<SealedVerificationResult> {
  const { contract } = input;
  if (!contract.allowedAudiences.includes(input.audience)) {
    fail({
      code: "audience-not-authorized",
      message: "This Sealed Verifier is not published for the requested audience.",
      recoveryAction: "request an explicitly published verifier disclosure policy or use a maintainer audience",
      receipt: "rule=verifier-audience-allowlist",
    });
  }
  if (input.publicProjection.projectId !== input.projectId || input.publicProjection.classification !== "public") {
    fail({
      code: "public-projection-required",
      message: "Sealed verification must bind to an exact public Project View Revision for this Project.",
      recoveryAction: "derive the public projection from the requested Project before invoking the verifier",
      receipt: "rule=public-project-view-input",
    });
  }
  validatePrivateInput(contract, input.privateInput);
  if (input.audience === "public" && contract.disclosure === "authorized-detail") {
    fail({
      code: "audience-not-authorized",
      message: "Authorized-detail Sealed Verifier output cannot be returned to a public audience.",
      recoveryAction: "publish a status, safe-summary, or redacted-findings verifier contract for public contributors",
      receipt: "rule=public-disclosure-side-channel-boundary",
    });
  }
  const privateResult = await input.execute({
    publicProjection: input.publicProjection,
    changeRevision: input.changeRevision,
    privateInput: input.privateInput,
  });
  if (privateResult.outputDigest.trim().length === 0 || privateResult.privateReceipt.trim().length === 0) {
    fail({
      code: "sealed-output-invalid",
      message: "The Sealed Verifier did not return an output digest and private receipt.",
      recoveryAction: "return an immutable output digest and an owner-held receipt from the verifier",
      receipt: "rule=sealed-result-receipt-required",
    });
  }
  const safePayload = { safeSummary: privateResult.safeSummary, safeFindings: privateResult.safeFindings };
  const disclosureIsPublicSafe = input.audience === "public" || contract.disclosure !== "authorized-detail";
  if (disclosureIsPublicSafe && containsRestrictedMarker(safePayload, input.privateInput)) {
    fail({
      code: "sealed-side-channel",
      message: "The Sealed Verifier safe result contains a restricted identifier or disallowed side-channel field.",
      recoveryAction: "replace private paths, identifiers, exact counts, timings, and resource details with an approved safe summary",
      receipt: "rule=disclosure-safe-result",
    });
  }
  if ((contract.disclosure === "safe-summary" || contract.disclosure === "redacted-findings")
    && (!privateResult.safeSummary || privateResult.safeSummary.trim().length === 0)
    && (!privateResult.safeFindings || privateResult.safeFindings.length === 0)) {
    fail({
      code: "sealed-output-invalid",
      message: "This Sealed Verifier contract promises disclosure-safe feedback but returned none.",
      recoveryAction: "return the contract's approved safe summary or redacted findings",
      receipt: "rule=approved-safe-feedback-required",
    });
  }
  const runId = opaqueId("sealed-run");
  const evidenceId = digest({ domain: "sealed-evidence", runId, projection: input.publicProjection.projectionRevisionId });
  const outcome: EvidenceOutcome = privateResult.status === "passed"
    ? "passed"
    : privateResult.status === "failed" ? "failed" : "indeterminate";
  const inputDigests = [input.publicProjection.contentDigest, ...input.privateInput.inputDigests];
  const validityKey = digest({
    projectViewId: input.publicProjection.projectionRevisionId,
    changeRevisionId: input.changeRevision.id,
    verifierContractDigest: contract.contractDigest,
    inputDigests,
  });
  const ledger = input.ledger ?? new EvidenceLedger();
  ledger.append({
    id: evidenceId,
    key: `sealed-verifier:${contract.id}`,
    criterion: `sealed-verifier:${contract.id}`,
    outcome,
    validityKey,
    actionId: contract.actionId,
    verifierId: contract.id,
    toolchainDigest: contract.actionContractDigest,
    dependencyDigest: digest(input.privateInput.inputDigests),
    environmentDigest: digest({ runnerId: input.runnerId, contract: contract.contractDigest }),
    inputDigests,
    effectDigests: [],
    outputDigest: privateResult.outputDigest,
    producer: { kind: "run", id: runId, version: contract.version },
    projectRevisionId: input.changeRevision.projectRevisionId,
    projectViewId: input.publicProjection.projectionRevisionId,
    changeRevisionId: input.changeRevision.id,
    runId,
    actor: input.actor,
    runnerId: input.runnerId,
    policyVersion: input.policyVersion,
    authorizationEpoch: input.authorizationEpoch,
    capabilityGrantId: input.capabilityGrantId,
    disclosure: { projectionId: input.publicProjection.projectionRevisionId, classification: input.audience },
    receipt: privateResult.privateReceipt,
    invalidators: ["project-view-revision", "change-revision", "sealed-verifier-contract", "private-inputs", "policy"],
    owner: input.owner,
    sourceSpaceSnapshots: input.publicProjection.sourceSpaceSnapshots,
    actionContractDigest: contract.actionContractDigest,
    verifierContractDigest: contract.contractDigest,
  });
  const now = input.now ?? (() => new Date().toISOString());
  const summary = contract.disclosure === "status" ? undefined : privateResult.safeSummary;
  const findings = contract.disclosure === "redacted-findings" || contract.disclosure === "authorized-detail"
    ? privateResult.safeFindings
    : undefined;
  const appeal: SealedVerificationAppeal = {
    id: opaqueId("sealed-appeal"),
    runId,
    status: contract.appealPolicy === "none" ? "not-available" : "eligible",
    audience: input.audience,
    projectViewId: input.publicProjection.projectionRevisionId,
    receipt: `appeal-policy=${contract.appealPolicy}; created-at=${now()}`,
  };
  const disclosedVerifierId = input.audience === "public"
    ? digest({ domain: "public-sealed-verifier", contractDigest: contract.contractDigest, projection: input.publicProjection.projectionRevisionId })
    : contract.id;
  const disclosedContractDigest = input.audience === "public"
    ? digest({ domain: "public-sealed-contract", contractDigest: contract.contractDigest, projection: input.publicProjection.projectionRevisionId })
    : contract.contractDigest;
  return {
    protocol: CONTRACT_VERSIONS.sealedVerifier,
    version: "v1",
    id: opaqueId("sealed-result"),
    runId,
    verifierId: disclosedVerifierId,
    audience: input.audience,
    status: privateResult.status,
    disclosure: contract.disclosure,
    projectViewId: input.publicProjection.projectionRevisionId,
    ...(summary ? { summary } : {}),
    ...(findings ? { findings: findings.map((finding) => ({ ...finding })) } : {}),
    evidence: {
      id: evidenceId,
      outcome,
      disclosure: input.audience,
      verifierId: disclosedVerifierId,
      projectViewId: input.publicProjection.projectionRevisionId,
    },
    appeal,
    contractDigest: disclosedContractDigest,
    receipt: `sealed-run=${runId}; projection=${input.publicProjection.projectionRevisionId}; private-inputs=not-disclosed`,
  };
}

export function appealSealedVerification(input: {
  result: SealedVerificationResult;
  reason: string;
}): SealedVerificationAppeal {
  if (input.result.appeal.status === "not-available") {
    fail({
      code: "audience-not-authorized",
      message: "This Sealed Verifier does not expose an appeal path for the requesting audience.",
      recoveryAction: "ask a maintainer to review the verifier contract or publish an appealable verifier",
      receipt: "rule=sealed-appeal-policy",
    });
  }
  if (input.reason.trim().length === 0) {
    fail({
      code: "sealed-output-invalid",
      message: "A Sealed Verifier appeal needs a non-empty reason.",
      recoveryAction: "describe the deterministic result or disclosure concern to review",
      receipt: "rule=appeal-reason-required",
    });
  }
  return {
    ...input.result.appeal,
    id: opaqueId("sealed-appeal"),
    status: "eligible",
    receipt: `appeal-for=${input.result.runId}; projection=${input.result.projectViewId}; reason=recorded-without-private-evidence`,
  };
}

export type PublicationHistoryPolicy = "curated" | "selected" | "full";
export type PublicationState = "draft" | "previewed" | "approved" | "landed" | "revoked";

export type PublicationChange = {
  protocol: typeof CONTRACT_VERSIONS.publicationChange;
  version: "v1";
  id: string;
  projectId: string;
  publicSourceSpaceId: string;
  publicProjection: PublicProjectionRevision;
  historyPolicy: PublicationHistoryPolicy;
  metadataDisclosure: "none" | "safe";
  state: PublicationState;
  createdAt: string;
  landedAt?: string;
  revokedAt?: string;
  receipt: string;
};

export type PublicationPreview = {
  change: PublicationChange;
  warnings: readonly string[];
  receipt: string;
};

export function createPublicationChange(input: {
  projectId: string;
  publicProjection: PublicProjectionRevision;
  historyPolicy?: PublicationHistoryPolicy;
  metadataDisclosure?: "none" | "safe";
  id?: string;
  createdAt?: string;
}): PublicationChange {
  if (input.publicProjection.projectId !== input.projectId || input.publicProjection.classification !== "public") {
    fail({
      code: "project-mismatch",
      message: "A Publication Change must belong to the Project and public lineage it publishes.",
      recoveryAction: "derive a public projection from the requested Project and retry",
      receipt: "rule=publication-project-equality",
    });
  }
  const publicSourceSpaceId = input.publicProjection.sourceSpaceIds[0];
  if (!publicSourceSpaceId) {
    fail({
      code: "source-content-missing",
      message: "A Publication Change needs at least one public Source Space lineage.",
      recoveryAction: "select an authorized public Source Space before creating the Publication Change",
      receipt: "rule=non-empty-public-lineage",
    });
  }
  const historyPolicy = input.historyPolicy ?? "curated";
  const metadataDisclosure = input.metadataDisclosure ?? "none";
  const id = input.id ?? opaqueId("publication-change");
  return {
    protocol: CONTRACT_VERSIONS.publicationChange,
    version: "v1",
    id,
    projectId: input.projectId,
    publicSourceSpaceId,
    publicProjection: input.publicProjection,
    historyPolicy,
    metadataDisclosure,
    state: "draft",
    createdAt: input.createdAt ?? new Date().toISOString(),
    receipt: `publication-change=${id}; lineage=${input.publicProjection.lineageId}; history=${historyPolicy}; private-parent=unreachable`,
  };
}

export function previewPublicationChange(change: PublicationChange): PublicationPreview {
  if (change.state !== "draft" && change.state !== "previewed") {
    fail({
      code: "publication-state",
      message: "Only a draft Publication Change can be previewed or refreshed.",
      recoveryAction: "create a new Publication Change for a new public lineage or inspect the existing landed lineage",
      receipt: `state=${change.state}; rule=draft-or-previewed-only`,
    });
  }
  const next: PublicationChange = { ...change, state: "previewed" };
  return {
    change: next,
    warnings: ["This preview proves disclosure integrity only; it makes no universal claim that the public projection builds, works, or is functionally complete."],
    receipt: `publication-change=${change.id}; preview=disclosure-only; lineage=${change.publicProjection.lineageId}`,
  };
}

export function approvePublicationChange(change: PublicationChange): PublicationChange {
  if (change.state !== "previewed") {
    fail({
      code: "publication-not-previewed",
      message: "A Publication Change must have a disclosure preview before approval.",
      recoveryAction: "preview the Publication Change and resolve its structural disclosure findings",
      receipt: `state=${change.state}; rule=preview-before-approval`,
    });
  }
  return { ...change, state: "approved" };
}

export function landPublicationChange(change: PublicationChange, landedAt = new Date().toISOString()): PublicationChange {
  if (change.state !== "approved" && change.state !== "previewed") {
    fail({
      code: "publication-not-previewed",
      message: "A Publication Change must be previewed and approved before Landing.",
      recoveryAction: "preview and approve the Publication Change without changing its public projection",
      receipt: `state=${change.state}; rule=approved-publication-required`,
    });
  }
  return {
    ...change,
    state: "landed",
    landedAt,
    receipt: `publication-change=${change.id}; state=landed; lineage=${change.publicProjection.lineageId}; immutable=true`,
  };
}

export function revokePublicationChange(change: PublicationChange, revokedAt = new Date().toISOString()): PublicationChange {
  if (change.state !== "landed") {
    fail({
      code: "publication-not-landed",
      message: "Only a landed Publication Change has a disclosed lineage that can be revoked prospectively.",
      recoveryAction: "Land the Publication Change first or discard the unpublished draft",
      receipt: `state=${change.state}; rule=prospective-revocation-after-disclosure`,
    });
  }
  return {
    ...change,
    state: "revoked",
    revokedAt,
    receipt: `publication-change=${change.id}; state=revoked; lineage-retained=true; future-distribution=blocked`,
  };
}
