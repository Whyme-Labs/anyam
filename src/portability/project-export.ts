import { createHash } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  opaqueId,
  type Artifact,
  type Change,
  type Evidence,
  type ExtensionEvent,
  type ExtensionInstallation,
  type ExtensionManifest,
  type ExternalProposal,
  type GovernanceControlEvidence,
  type GovernanceEvaluation,
  type Intent,
  type IntentComment,
  type GovernanceProfile,
  type LargeObjectRef,
  type Project,
  type ProjectExport,
  type ProjectExportArtifactFile,
  type ProjectExportIntegrity,
  type ProjectExportLineage,
  type ProjectRevision,
  type RepositoryExport,
  type RepositoryMirror,
  type MirrorCheckpoint,
  type MirrorDelivery,
  type MirrorOperation,
  type Release,
  type SourceSpace,
  type Target,
} from "../kernel/contracts.ts";
import type {
  RepositoryDriver,
  RepositoryDriverFailure,
  RepositoryDriverResult,
  RepositoryExportReceipt,
  RepositoryHandle,
} from "./repository-driver.ts";

export type PortabilityBudgetReceipt = {
  name: string;
  limit: string;
  asked: string;
  receipt: string;
};

export type PortabilityFailure = {
  status: "failed";
  errorCode: string;
  message: string;
  retryable: boolean;
  affectedObject: string;
  checkpointId: string;
  recoveryAction: string;
  budget: PortabilityBudgetReceipt;
};

export type PortabilitySuccess<T> = {
  status: "succeeded";
  value: T;
};

export type PortabilityResult<T> = PortabilitySuccess<T> | PortabilityFailure;

export type ProjectExportRepositoryInput = {
  sourceSpaceId: string;
  repository: RepositoryHandle;
};

export type ProjectExportInput = {
  project: Project;
  sourceSpaces: readonly SourceSpace[];
  repositories: readonly ProjectExportRepositoryInput[];
  destination: string;
  projectRevisions?: readonly ProjectRevision[];
  intents?: readonly Intent[];
  intentComments?: readonly IntentComment[];
  changes?: readonly Change[];
  evidence?: readonly Evidence[];
  artifacts?: readonly Artifact[];
  /** Optional exact bytes for the declared non-repository Artifacts. */
  artifactFiles?: readonly ProjectExportArtifactInput[];
  releases?: readonly Release[];
  targets?: readonly Target[];
  extensions?: readonly ExtensionManifest[];
  extensionInstallations?: readonly ExtensionInstallation[];
  extensionEvents?: readonly ExtensionEvent[];
  governanceProfiles?: readonly GovernanceProfile[];
  governanceControlEvidence?: readonly GovernanceControlEvidence[];
  governanceEvaluations?: readonly GovernanceEvaluation[];
  mirrors?: readonly RepositoryMirror[];
  mirrorOperations?: readonly MirrorOperation[];
  mirrorCheckpoints?: readonly MirrorCheckpoint[];
  externalProposals?: readonly ExternalProposal[];
  mirrorDeliveries?: readonly MirrorDelivery[];
  mirrorOperationIds?: readonly string[];
  policies?: readonly string[];
  auditEventIds?: readonly string[];
  exportId?: string;
  idempotencyKey?: string;
};

export type ProjectExportArtifactInput = {
  artifactId: string;
  bytes?: Uint8Array;
  mediaType?: string;
};

export type ProjectExportPackage = {
  manifest: ProjectExport;
  directory: string;
  checkpointId: string;
  receipt: string;
};

export type ImportCheckpointState = "preflight" | "quarantined" | "verified" | "activating" | "blocked" | "activated";

export type ImportCheckpoint = {
  protocol: "anyam.recovery-checkpoint/v1";
  checkpointId: string;
  operationId: string;
  state: ImportCheckpointState;
  completedSourceSpaceIds: readonly string[];
  affectedObject: string;
  recoveryAction: string;
  receipt: string;
};

type ImportOperationRecord = {
  protocol: "anyam.import/v1";
  operationId: string;
  idempotencyKey: string;
  exportId: string;
  exportDigest: string;
  destination: string;
  state: ImportCheckpointState;
  completedSourceSpaceIds: readonly string[];
  checkpoint: ImportCheckpoint;
};

type GitImportOperationRecord = {
  protocol: "anyam.git-import/v1";
  operationId: string;
  idempotencyKey: string;
  sourceDigest: string;
  projectId: string;
  sourceSpaceId: string;
  packageDirectory?: string;
  state: ImportCheckpointState;
  checkpoint: ImportCheckpoint;
};

export type ImportProjectInput = {
  packageDirectory: string;
  destination: string;
  idempotencyKey: string;
};

export type GitProjectImportInput = {
  project: Project;
  sourceSpace: SourceSpace;
  source: string;
  destination: string;
  idempotencyKey: string;
};

export type ImportedProject = {
  manifest: ProjectExport;
  destination: string;
  operationId: string;
  checkpoint: ImportCheckpoint;
  repositories: Readonly<Record<string, RepositoryHandle>>;
  receipt: string;
};

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestText(value: string): string {
  return digestBytes(Buffer.from(value, "utf8"));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stableValue(nested)]));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function safeName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "-");
  return normalized === "." || normalized === ".." ? `_${normalized}` : normalized;
}

function artifactFilePath(artifact: Artifact): string {
  return `artifacts/${safeName(artifact.id)}-${safeName(artifact.digest)}.bin`;
}

type PreparedArtifactFile = {
  manifest: ProjectExportArtifactFile;
  bytes?: Uint8Array;
};

function prepareArtifactFiles(input: {
  artifacts: readonly Artifact[];
  artifactFiles: readonly ProjectExportArtifactInput[];
}): readonly PreparedArtifactFile[] {
  const provided = new Map<string, ProjectExportArtifactInput>();
  for (const entry of input.artifactFiles) {
    if (!entry.artifactId || provided.has(entry.artifactId)) {
      throw new Error(`artifactFiles=duplicate-or-missing-artifact-id; artifact=${entry.artifactId || "missing"}`);
    }
    provided.set(entry.artifactId, entry);
  }
  const declared = new Set(input.artifacts.map((artifact) => artifact.id));
  const paths = new Set<string>();
  for (const entry of input.artifactFiles) {
    if (!declared.has(entry.artifactId)) throw new Error(`artifactFiles=undeclared-artifact; artifact=${entry.artifactId}`);
  }
  return input.artifacts.map((artifact) => {
    const entry = provided.get(artifact.id);
    if (!entry?.bytes) {
      const unavailable: ProjectExportArtifactFile = {
        artifactId: artifact.id,
        digest: artifact.digest,
        state: "unavailable",
        reason: "bytes-not-provided-to-exporter",
      };
      return { manifest: unavailable };
    }
    const actualDigest = `sha256:${digestBytes(entry.bytes)}`;
    if (actualDigest !== artifact.digest) {
      throw new Error(`artifact=${artifact.id}; expectedDigest=${artifact.digest}; actualDigest=${actualDigest}; bytes=changed-before-export`);
    }
    const relativePath = artifactFilePath(artifact);
    if (paths.has(relativePath)) throw new Error(`artifactFiles=path-collision; path=${relativePath}; artifact=${artifact.id}`);
    paths.add(relativePath);
    const included: ProjectExportArtifactFile = {
      artifactId: artifact.id,
      digest: artifact.digest,
      state: "included",
      relativePath,
      byteLength: entry.bytes.byteLength,
      ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
    };
    return { manifest: included, bytes: new Uint8Array(entry.bytes) };
  });
}

function safeRelativePath(root: string, candidate: string): boolean {
  if (isAbsolute(candidate)) return false;
  const resolved = resolve(root, candidate);
  const fromRoot = relative(root, resolved);
  return fromRoot.length > 0 && fromRoot !== ".." && !fromRoot.startsWith(`..${candidate.includes("\\") ? "\\" : "/"}`) && !isAbsolute(fromRoot);
}

function manifestProblems(manifest: ProjectExport): readonly string[] {
  const problems: string[] = [];
  if (!manifest.project.id || manifest.project.sourceSpaceIds.length === 0) problems.push("project identity or Source Space list is empty");
  if (new Set(manifest.project.sourceSpaceIds).size !== manifest.project.sourceSpaceIds.length) problems.push("Project Source Space IDs are duplicated");
  const declaredSpaces = new Set(manifest.project.sourceSpaceIds);
  const repositorySpaces = new Set<string>();
  for (const repository of manifest.repositories) {
    if (!declaredSpaces.has(repository.sourceSpaceId)) problems.push(`repository ${repository.repositoryId} names an undeclared Source Space`);
    if (repositorySpaces.has(repository.sourceSpaceId)) problems.push(`Source Space ${repository.sourceSpaceId} has more than one exported repository`);
    repositorySpaces.add(repository.sourceSpaceId);
    if (!repository.repositoryId || repository.refs.length === 0) problems.push(`repository ${repository.sourceSpaceId} has no identity or refs`);
    if (!safeRelativePath(".", repository.bundle.relativePath)) problems.push(`repository ${repository.sourceSpaceId} bundle path escapes the package`);
    for (const object of repository.lfs.objects) {
      if (!safeRelativePath(".", object.relativePath ?? "")) problems.push(`repository ${repository.sourceSpaceId} LFS path escapes the package`);
    }
  }
  const intentsValue = (manifest as ProjectExport & { intents?: unknown }).intents;
  const commentsValue = (manifest as ProjectExport & { intentComments?: unknown }).intentComments;
  if (!Array.isArray(intentsValue)) problems.push("Intent lifecycle array is missing");
  if (!Array.isArray(commentsValue)) problems.push("Intent comment lifecycle array is missing");
  const intents = Array.isArray(intentsValue) ? intentsValue : [];
  const intentIds = new Set<string>();
  const disclosureRank = (value: unknown): number => value === "public" ? 0 : value === "project" ? 1 : value === "restricted" ? 2 : -1;
  for (const intentValue of intents) {
    if (intentValue === null || typeof intentValue !== "object" || Array.isArray(intentValue)) {
      problems.push("Intent lifecycle entry is not an object");
      continue;
    }
    const intent = intentValue as Partial<Intent>;
    if (typeof intent.id !== "string" || intent.id.length === 0) problems.push("Intent lifecycle entry has no identity");
    else if (intentIds.has(intent.id)) problems.push(`Intent ${intent.id} is duplicated`);
    else intentIds.add(intent.id);
    if (intent.projectId !== manifest.project.id) problems.push(`Intent ${intent.id ?? "unknown"} names a different Project`);
    if (intent.status !== "open" && intent.status !== "closed") problems.push(`Intent ${intent.id ?? "unknown"} has an invalid status`);
    if (disclosureRank(intent.disclosure) < 0) problems.push(`Intent ${intent.id ?? "unknown"} has an invalid disclosure`);
  }
  const comments = Array.isArray(commentsValue) ? commentsValue : [];
  const commentIds = new Set<string>();
  for (const commentValue of comments) {
    if (commentValue === null || typeof commentValue !== "object" || Array.isArray(commentValue)) {
      problems.push("Intent comment entry is not an object");
      continue;
    }
    const comment = commentValue as Partial<IntentComment>;
    if (typeof comment.id !== "string" || comment.id.length === 0) problems.push("Intent comment entry has no identity");
    else if (commentIds.has(comment.id)) problems.push(`Intent comment ${comment.id} is duplicated`);
    else commentIds.add(comment.id);
    const parent = typeof comment.intentId === "string" ? intents.find((value) => value !== null && typeof value === "object" && !Array.isArray(value) && (value as { id?: unknown }).id === comment.intentId) as Partial<Intent> | undefined : undefined;
    if (!parent) problems.push(`Intent comment ${comment.id ?? "unknown"} names an unavailable Intent`);
    if (comment.projectId !== manifest.project.id) problems.push(`Intent comment ${comment.id ?? "unknown"} names a different Project`);
    if (disclosureRank(comment.disclosure) < 0) problems.push(`Intent comment ${comment.id ?? "unknown"} has an invalid disclosure`);
    if (parent && disclosureRank(comment.disclosure) > disclosureRank(parent.disclosure)) problems.push(`Intent comment ${comment.id ?? "unknown"} disclosure exceeds its Intent`);
  }
  const artifactEntries = manifest.artifactFiles;
  if (manifest.artifacts.length > 0 && !artifactEntries) problems.push("Artifact byte disposition is missing");
  if (artifactEntries) {
    const artifactIds = new Set(manifest.artifacts.map((artifact) => artifact.id));
    const seenArtifacts = new Set<string>();
    const seenPaths = new Set<string>();
    for (const entry of artifactEntries) {
      if (!artifactIds.has(entry.artifactId)) problems.push(`artifact file ${entry.artifactId} is not declared by the Project Export`);
      if (seenArtifacts.has(entry.artifactId)) problems.push(`artifact ${entry.artifactId} has duplicate byte dispositions`);
      seenArtifacts.add(entry.artifactId);
      const artifact = manifest.artifacts.find((candidate) => candidate.id === entry.artifactId);
      if (artifact && entry.digest !== artifact.digest) problems.push(`artifact ${entry.artifactId} byte disposition digest differs from Artifact`);
      if (entry.state === "included") {
        if (!entry.relativePath || !safeRelativePath(".", entry.relativePath) || !entry.relativePath.startsWith("artifacts/")) problems.push(`artifact ${entry.artifactId} included path escapes the artifact package`);
        if (entry.relativePath && seenPaths.has(entry.relativePath)) problems.push(`artifact ${entry.artifactId} included path is duplicated`);
        if (entry.relativePath) seenPaths.add(entry.relativePath);
        if (entry.byteLength === undefined || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) problems.push(`artifact ${entry.artifactId} included byte length is invalid`);
        if (entry.reason !== undefined) problems.push(`artifact ${entry.artifactId} included disposition has an unavailable reason`);
      } else if (entry.state === "unavailable") {
        if (!entry.reason || entry.reason.trim().length === 0) problems.push(`artifact ${entry.artifactId} unavailable disposition has no reason`);
        if (entry.relativePath !== undefined || entry.byteLength !== undefined) problems.push(`artifact ${entry.artifactId} unavailable disposition names bytes`);
      } else {
        problems.push(`artifact ${entry.artifactId} byte disposition state is invalid`);
      }
    }
    for (const artifact of manifest.artifacts) {
      if (!seenArtifacts.has(artifact.id)) problems.push(`artifact ${artifact.id} has no byte disposition`);
    }
  }
  return problems;
}

function checkpointId(operationId: string, state: ImportCheckpointState): string {
  return `checkpoint:${state}:${digestText(`${operationId}:${state}`)}`;
}

function budgetReceipt(asked: string, receipt: string): PortabilityBudgetReceipt {
  return {
    name: "portable-transfer-integrity",
    limit: "the complete declared object set and manifest",
    asked,
    receipt,
  };
}

function blocked(
  errorCode: string,
  operation: string,
  affectedObject: string,
  checkpoint: ImportCheckpoint,
  retryable: boolean,
  recoveryAction: string,
  asked: string,
  receipt: string,
): Omit<PortabilityFailure, "status"> {
  const budget = budgetReceipt(asked, receipt);
  return {
    errorCode,
    message: `Project ${operation} is blocked for ${affectedObject}; budget=${budget.name}; limit=${budget.limit}; asked=${budget.asked}; receipt=${budget.receipt}; fix=${recoveryAction}.`,
    retryable,
    affectedObject,
    checkpointId: checkpoint.checkpointId,
    recoveryAction,
    budget,
  };
}

function providerFailure(
  operation: string,
  affectedObject: string,
  checkpoint: ImportCheckpoint,
  result: RepositoryDriverFailure,
): Omit<PortabilityFailure, "status"> {
  return blocked(
    result.errorCode,
    operation,
    affectedObject,
    checkpoint,
    result.retryable,
    result.recoveryAction ?? "inspect the RepositoryDriver receipt and retry from this checkpoint",
    result.budget?.asked ?? "the complete repository object set",
    result.budget?.receipt ?? result.receipt ?? `${operation}; object=${affectedObject}; driver-failure=${result.errorCode}`,
  );
}

function singleRepositoryProjectExport(input: {
  project: Project;
  sourceSpace: SourceSpace;
  repository: RepositoryExport;
  exportId: string;
  checkpointId: string;
}): ProjectExport {
  const defaultRef = input.repository.defaultBranch
    ? input.repository.refs.find((ref) => ref.name === `refs/heads/${input.repository.defaultBranch}`)
    : input.repository.refs[0];
  const projectRevision: ProjectRevision = {
    protocol: "anyam.kernel/v1",
    id: opaqueId("project-revision"),
    projectId: input.project.id,
    sourceSpaceSnapshots: { [input.sourceSpace.id]: defaultRef?.oid ?? input.repository.refs[0]?.oid ?? "" },
  };
  const initial: ProjectExport = {
    protocol: "anyam.export/v1",
    version: "v1",
    exportId: input.exportId,
    createdAt: new Date().toISOString(),
    project: { ...input.project, sourceSpaceIds: [...input.project.sourceSpaceIds] },
    sourceSpaces: [{ ...input.sourceSpace }],
    repositories: [input.repository],
    largeObjects: [...input.repository.lfs.objects],
    lineage: [{ projectRevisionId: projectRevision.id, sourceSpaceSnapshots: { ...projectRevision.sourceSpaceSnapshots } }],
    projectRevisions: [projectRevision],
    intents: [],
    intentComments: [],
    changes: [],
    evidence: [],
    artifacts: [],
    artifactFiles: [],
    releases: [],
    targets: [],
    capabilityGrants: [],
    extensions: [],
    policies: [],
    auditEventIds: [],
    recoveryCheckpointIds: [input.checkpointId],
    recovery: {
      checkpointId: input.checkpointId,
      state: "verified",
      resumeAction: "resume the Git import from its visible checkpoint",
      receipt: `project=${input.project.id}; sourceSpace=${input.sourceSpace.id}; refs=${input.repository.refs.length}`,
    },
    integrity: {
      manifestDigest: "pending",
      repositoryDigests: [input.repository.bundle.digest],
      credentialFree: true,
      receipt: `repositories=1; largeObjects=${input.repository.lfs.objects.length}; credentialFields=none`,
    },
  };
  return { ...initial, integrity: { ...initial.integrity, manifestDigest: manifestDigest(initial) } };
}

async function writeProjectExportPackage(directory: string, manifest: ProjectExport, checkpoint: ImportCheckpoint): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "export.json"), `${stableStringify(manifest)}\n`, "utf8");
  await mkdir(join(directory, "recovery"), { recursive: true });
  await writeFile(join(directory, "recovery", "checkpoint.json"), `${stableStringify({ ...checkpoint, state: "verified" })}\n`, "utf8");
}

async function exists(directory: string): Promise<boolean> {
  try {
    await stat(directory);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function hasGitRepositoryDirectory(directory: string): Promise<boolean> {
  return (await exists(join(directory, ".git")))
    || ((await exists(join(directory, "HEAD"))) && (await exists(join(directory, "objects"))));
}

function manifestForDigest(manifest: ProjectExport): Omit<ProjectExportIntegrity, "manifestDigest"> & { manifest: Omit<ProjectExport, "integrity"> } {
  const { integrity: _integrity, ...withoutIntegrity } = manifest;
  return {
    manifest: withoutIntegrity,
    credentialFree: true,
    repositoryDigests: manifest.repositories.map((repository) => repository.bundle.digest),
    receipt: `repositories=${manifest.repositories.length}; largeObjects=${manifest.largeObjects.length}; credentialFields=none`,
  };
}

function manifestDigest(manifest: ProjectExport): string {
  return digestText(stableStringify(manifestForDigest(manifest)));
}

/** Digest used by installation and recovery adapters without exposing the
 * manifest's private integrity implementation. */
export function projectExportDigest(manifest: ProjectExport): string {
  return manifestDigest(manifest);
}

export function verifyProjectExportManifest(manifest: ProjectExport): PortabilityResult<ProjectExport> {
  const problems = manifestProblems(manifest);
  if (manifest.protocol !== "anyam.export/v1" || manifest.version !== "v1") {
    return {
      status: "failed",
      errorCode: "export.protocol_invalid",
      message: "Project Export protocol is not supported.",
      retryable: false,
      affectedObject: manifest.exportId || "export",
      checkpointId: "checkpoint:manifest:invalid",
      recoveryAction: "provide an anyam.export/v1 manifest",
      budget: budgetReceipt("a v1 Project Export manifest", `protocol=${String(manifest.protocol)}; version=${String(manifest.version)}`),
    };
  }
  if (problems.length > 0) {
    return {
      status: "failed",
      errorCode: "export.shape_invalid",
      message: "Project Export shape is incomplete.",
      retryable: false,
      affectedObject: manifest.exportId || "export",
      checkpointId: "checkpoint:manifest:shape",
      recoveryAction: "regenerate the Project Export with complete Source Space repositories and lineage",
      budget: budgetReceipt("the declared Project Export shape", problems.join("; ")),
    };
  }
  if (!isProjectExportCredentialFree(manifest)) {
    return {
      status: "failed",
      errorCode: "export.credential_present",
      message: "Project Export contains credential material.",
      retryable: false,
      affectedObject: manifest.exportId || "export",
      checkpointId: "checkpoint:manifest:credentials",
      recoveryAction: "remove credential material and regenerate the export",
      budget: budgetReceipt("a credential-free Project Export", "credential field detected in manifest"),
    };
  }
  const actualDigest = manifestDigest(manifest);
  if (manifest.integrity.manifestDigest !== actualDigest) {
    return {
      status: "failed",
      errorCode: "export.manifest_digest_mismatch",
      message: "Project Export manifest digest does not match its contents.",
      retryable: false,
      affectedObject: manifest.exportId || "export",
      checkpointId: "checkpoint:manifest:digest",
      recoveryAction: "restore the manifest from the owner-controlled export source",
      budget: budgetReceipt("the declared manifest digest", `expected=${manifest.integrity.manifestDigest}; actual=${actualDigest}`),
    };
  }
  return { status: "succeeded", value: manifest };
}

function credentialField(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = credentialField(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (lower !== "credentialfree" && lower !== "secretusealiases" && /token|password|secret|credential/.test(lower)) return key;
    const found = credentialField(nested);
    if (found) return found;
  }
  return undefined;
}

export function isProjectExportCredentialFree(manifest: ProjectExport): boolean {
  return credentialField(manifest) === undefined;
}

export async function verifyProjectExportPackage(directory: string): Promise<PortabilityResult<ProjectExport>> {
  const packageDirectory = resolve(directory);
  const exportFile = join(packageDirectory, "export.json");
  const checkpoint: ImportCheckpoint = {
    protocol: "anyam.recovery-checkpoint/v1",
    checkpointId: checkpointId(`verify:${packageDirectory}`, "preflight"),
    operationId: `verify:${digestText(packageDirectory)}`,
    state: "preflight",
    completedSourceSpaceIds: [],
    affectedObject: exportFile,
    recoveryAction: "restore or regenerate export.json, then rerun verification",
    receipt: `package=${packageDirectory}`,
  };
  try {
    const manifest = JSON.parse(await readFile(exportFile, "utf8")) as ProjectExport;
    if (manifest.protocol !== "anyam.export/v1" || manifest.version !== "v1") {
      return { status: "failed", ...blocked("export.protocol_invalid", "verification", exportFile, checkpoint, false, "provide a supported anyam.export/v1 manifest", "a v1 Project Export manifest", `protocol=${String(manifest.protocol)}; version=${String(manifest.version)}`) };
    }
    const shapeProblems = manifestProblems(manifest);
    if (shapeProblems.length > 0) {
      return { status: "failed", ...blocked("export.shape_invalid", "verification", exportFile, checkpoint, false, "regenerate the export with one complete repository per declared Source Space", "the declared Project Export shape", shapeProblems.join("; ")) };
    }
    if (!isProjectExportCredentialFree(manifest)) {
      return { status: "failed", ...blocked("export.credential_present", "verification", exportFile, checkpoint, false, "remove credentials and regenerate the export", "a credential-free manifest", "credential field detected in manifest") };
    }
    if (manifest.integrity.manifestDigest !== manifestDigest(manifest)) {
      return { status: "failed", ...blocked("export.manifest_digest_mismatch", "verification", exportFile, checkpoint, false, "restore the manifest from its owner-controlled export source", "the declared manifest digest", `expected=${manifest.integrity.manifestDigest}; actual=${manifestDigest(manifest)}`) };
    }
    for (const repository of manifest.repositories) {
      const bundlePath = join(packageDirectory, "repositories", safeName(repository.sourceSpaceId), repository.bundle.relativePath);
      if (!(await exists(bundlePath))) {
        return { status: "failed", ...blocked("export.bundle_missing", "verification", repository.sourceSpaceId, checkpoint, true, "restore the missing bundle into the quarantine and rerun verification", "the declared Git bundle", `bundle=${repository.bundle.relativePath}`) };
      }
      const bundle = await readFile(bundlePath);
      const actual = digestBytes(bundle);
      if (actual !== repository.bundle.digest) {
        return { status: "failed", ...blocked("export.bundle_digest_mismatch", "verification", repository.sourceSpaceId, checkpoint, false, "replace the corrupt bundle and rerun verification", "the complete Git bundle", `expected=${repository.bundle.digest}; actual=${actual}`) };
      }
      for (const object of repository.lfs.objects) {
        const objectPath = join(packageDirectory, "repositories", safeName(repository.sourceSpaceId), object.relativePath ?? "");
        if (!(await exists(objectPath))) {
          return { status: "failed", ...blocked("export.lfs_object_missing", "verification", repository.sourceSpaceId, checkpoint, true, "restore the missing LFS object into the quarantine and rerun verification", "the complete declared LFS object set", `oid=${object.oid}; path=${object.relativePath ?? "missing"}`) };
        }
        if (object.digest) {
          const objectDigest = digestBytes(await readFile(objectPath));
          if (objectDigest !== object.digest) {
            return { status: "failed", ...blocked("export.lfs_digest_mismatch", "verification", repository.sourceSpaceId, checkpoint, false, "replace the corrupt LFS object and rerun verification", "the declared LFS object digest", `oid=${object.oid}; expected=${object.digest}; actual=${objectDigest}`) };
          }
        }
      }
    }
    for (const artifactFile of manifest.artifactFiles ?? []) {
      if (artifactFile.state !== "included") continue;
      const artifactPath = join(packageDirectory, artifactFile.relativePath ?? "");
      if (!(await exists(artifactPath))) {
        return { status: "failed", ...blocked("export.artifact_file_missing", "verification", artifactFile.artifactId, checkpoint, true, "restore the missing Artifact bytes into the export package and rerun verification", "the declared included Artifact bytes", `artifact=${artifactFile.artifactId}; path=${artifactFile.relativePath ?? "missing"}`) };
      }
      const bytes = await readFile(artifactPath);
      const actualDigest = `sha256:${digestBytes(bytes)}`;
      if (actualDigest !== artifactFile.digest) {
        return { status: "failed", ...blocked("export.artifact_digest_mismatch", "verification", artifactFile.artifactId, checkpoint, false, "replace the corrupt Artifact bytes and regenerate the owner-controlled export", "the declared Artifact digest", `artifact=${artifactFile.artifactId}; expected=${artifactFile.digest}; actual=${actualDigest}`) };
      }
      if (bytes.byteLength !== artifactFile.byteLength) {
        return { status: "failed", ...blocked("export.artifact_byte_length_mismatch", "verification", artifactFile.artifactId, checkpoint, false, "replace the incomplete Artifact bytes and regenerate the owner-controlled export", "the declared Artifact byte length", `artifact=${artifactFile.artifactId}; expected=${artifactFile.byteLength}; actual=${bytes.byteLength}`) };
      }
    }
    return { status: "succeeded", value: manifest };
  } catch (error) {
    return { status: "failed", ...blocked("export.manifest_unreadable", "verification", exportFile, checkpoint, false, "restore a readable export package and rerun verification", "export.json", `cause=${error instanceof Error ? error.name : "unknown"}`) };
  }
}

export class LocalProjectExporter {
  constructor(private readonly driver: RepositoryDriver) {}

  async exportProject(input: ProjectExportInput): Promise<PortabilityResult<ProjectExportPackage>> {
    const exportId = input.exportId ?? opaqueId("export");
    const operationId = input.idempotencyKey ? `export:${digestText(input.idempotencyKey)}` : opaqueId("export-operation");
    const checkpoint: ImportCheckpoint = {
      protocol: "anyam.recovery-checkpoint/v1",
      checkpointId: checkpointId(operationId, "preflight"),
      operationId,
      state: "preflight",
      completedSourceSpaceIds: [],
      affectedObject: input.project.id,
      recoveryAction: "resume export from this checkpoint after fixing the named repository",
      receipt: `project=${input.project.id}; repositories=${input.repositories.length}`,
    };
    try {
      if (input.repositories.some((entry) => entry.sourceSpaceId !== entry.repository.sourceSpaceId)) {
        return { status: "failed", ...blocked("export.source_space_mismatch", "export", input.project.id, checkpoint, false, "align each repository handle with its Source Space", "one repository per declared Source Space", "repository/source-space mapping mismatch") };
      }
      const destination = resolve(input.destination);
      await mkdir(join(destination, "repositories"), { recursive: true });
      const repositoryManifests: RepositoryExport[] = [];
      const largeObjects: LargeObjectRef[] = [];
      const repositoryDigests: string[] = [];
      for (const entry of input.repositories) {
        const repositoryDirectory = join(destination, "repositories", safeName(entry.sourceSpaceId));
        const exported = await this.driver.exportRepository({ repository: entry.repository, destination: repositoryDirectory, checkpointId: checkpoint.checkpointId });
        if (exported.status !== "succeeded") return { status: "failed", ...providerFailure("export", entry.sourceSpaceId, checkpoint, exported) };
        const repository = {
          ...exported.value.repository,
          bundle: {
            ...exported.value.repository.bundle,
            relativePath: exported.value.repository.bundle.relativePath,
          },
        };
        repositoryManifests.push(repository);
        largeObjects.push(...repository.lfs.objects);
        repositoryDigests.push(repository.bundle.digest);
      }
      const preparedArtifactFiles = prepareArtifactFiles({ artifacts: input.artifacts ?? [], artifactFiles: input.artifactFiles ?? [] });
      for (const entry of preparedArtifactFiles) {
        if (entry.manifest.state !== "included" || !entry.manifest.relativePath || !entry.bytes) continue;
        const artifactPath = join(destination, entry.manifest.relativePath);
        await mkdir(dirname(artifactPath), { recursive: true });
        await writeFile(artifactPath, entry.bytes);
      }
      const lineage: ProjectExportLineage[] = (input.projectRevisions ?? []).map((revision) => ({
        projectRevisionId: revision.id,
        sourceSpaceSnapshots: { ...revision.sourceSpaceSnapshots },
      }));
      const initial: ProjectExport = {
        protocol: "anyam.export/v1",
        version: "v1",
        exportId,
        createdAt: new Date().toISOString(),
        project: { ...input.project, sourceSpaceIds: [...input.project.sourceSpaceIds] },
        sourceSpaces: input.sourceSpaces.map((space) => ({ ...space })),
        repositories: repositoryManifests,
        largeObjects,
        lineage,
        projectRevisions: [...(input.projectRevisions ?? [])],
        intents: [...(input.intents ?? [])],
        intentComments: [...(input.intentComments ?? [])],
        changes: [...(input.changes ?? [])],
        evidence: [...(input.evidence ?? [])],
        artifacts: [...(input.artifacts ?? [])],
        artifactFiles: preparedArtifactFiles.map((entry) => ({ ...entry.manifest })),
        releases: [...(input.releases ?? [])],
        targets: [...(input.targets ?? [])],
        ...(input.mirrors ? { mirrors: input.mirrors.map((mirror) => ({ ...mirror, refMappings: mirror.refMappings.map((mapping) => ({ ...mapping })), canonicalRefs: mirror.canonicalRefs.map((ref) => ({ ...ref })), remoteRefs: mirror.remoteRefs.map((ref) => ({ ...ref })), pendingInboundChangeIds: [...mirror.pendingInboundChangeIds] })) } : {}),
        ...(input.mirrorOperations ? { mirrorOperations: input.mirrorOperations.map((operation) => ({ ...operation, inboundChangeIds: [...operation.inboundChangeIds] })) } : {}),
        ...(input.mirrorCheckpoints ? { mirrorCheckpoints: input.mirrorCheckpoints.map((checkpoint) => ({ ...checkpoint, canonicalRefs: checkpoint.canonicalRefs.map((ref) => ({ ...ref })), remoteRefs: checkpoint.remoteRefs.map((ref) => ({ ...ref })), completedInboundChangeIds: [...checkpoint.completedInboundChangeIds] })) } : {}),
        ...(input.externalProposals ? { externalProposals: input.externalProposals.map((proposal) => ({ ...proposal, observedHeadCommits: [...proposal.observedHeadCommits], changeRevisionIds: [...proposal.changeRevisionIds] })) } : {}),
        ...(input.mirrorDeliveries ? { mirrorDeliveries: input.mirrorDeliveries.map((delivery) => ({ ...delivery })) } : {}),
        ...(input.mirrorOperationIds ? { mirrorOperationIds: [...input.mirrorOperationIds] } : {}),
        capabilityGrants: [],
        extensions: [...(input.extensions ?? [])],
        ...(input.extensionInstallations ? { extensionInstallations: [...input.extensionInstallations] } : {}),
        ...(input.extensionEvents ? { extensionEvents: [...input.extensionEvents] } : {}),
        ...(input.governanceProfiles ? { governanceProfiles: [...input.governanceProfiles] } : {}),
        ...(input.governanceControlEvidence ? { governanceControlEvidence: [...input.governanceControlEvidence] } : {}),
        ...(input.governanceEvaluations ? { governanceEvaluations: [...input.governanceEvaluations] } : {}),
        policies: [...(input.policies ?? [])],
        auditEventIds: [...(input.auditEventIds ?? [])],
        recoveryCheckpointIds: [checkpoint.checkpointId],
        recovery: {
          checkpointId: checkpoint.checkpointId,
          state: "verified",
          resumeAction: "resume export from the repository checkpoint",
          receipt: `project=${input.project.id}; repositories=${repositoryManifests.length}; repositoryDigests=${repositoryDigests.length}`,
        },
        integrity: {
          manifestDigest: "pending",
          repositoryDigests,
          credentialFree: true,
          receipt: `repositories=${repositoryManifests.length}; largeObjects=${largeObjects.length}; credentialFields=none`,
        },
      };
      const manifest: ProjectExport = { ...initial, integrity: { ...initial.integrity, manifestDigest: manifestDigest(initial) } };
      await writeFile(join(destination, "export.json"), `${stableStringify(manifest)}\n`, "utf8");
      await mkdir(join(destination, "recovery"), { recursive: true });
      await writeFile(join(destination, "recovery", "checkpoint.json"), `${stableStringify({ ...checkpoint, state: "verified" })}\n`, "utf8");
      return {
        status: "succeeded",
        value: {
          manifest,
          directory: destination,
          checkpointId: checkpoint.checkpointId,
          receipt: `export=${exportId}; project=${input.project.id}; repositories=${repositoryManifests.length}; manifestDigest=${manifest.integrity.manifestDigest}`,
        },
      };
    } catch (error) {
      return { status: "failed", ...blocked("export.failed", "export", input.project.id, checkpoint, true, "resume export from the named checkpoint after inspecting the affected object", "the complete Project Export package", `cause=${error instanceof Error ? error.name : "unknown"}`) };
    }
  }

  async importGitRepository(input: GitProjectImportInput): Promise<PortabilityResult<ImportedProject>> {
    if (!input.project.sourceSpaceIds.includes(input.sourceSpace.id)) {
      const checkpoint: ImportCheckpoint = {
        protocol: "anyam.recovery-checkpoint/v1",
        checkpointId: checkpointId(`git-import:${digestText(input.idempotencyKey)}`, "preflight"),
        operationId: `git-import:${digestText(input.idempotencyKey)}`,
        state: "preflight",
        completedSourceSpaceIds: [],
        affectedObject: input.sourceSpace.id,
        recoveryAction: "add the Source Space to the Project before retrying the import",
        receipt: `project=${input.project.id}; sourceSpace=${input.sourceSpace.id}`,
      };
      return {
        status: "failed",
        ...blocked("git-import.source_space_not_in_project", "Git import", input.sourceSpace.id, checkpoint, false, checkpoint.recoveryAction, "a declared Project Source Space", checkpoint.receipt),
      };
    }
    const operationId = `git-import:${digestText(input.idempotencyKey)}`;
    const destination = resolve(input.destination);
    const operationDirectory = join(destination, ".anyam", "imports", safeName(digestText(input.idempotencyKey)));
    const operationFile = join(operationDirectory, "git-operation.json");
    const sourceDigest = digestText(input.source);
    const preflight: ImportCheckpoint = {
      protocol: "anyam.recovery-checkpoint/v1",
      checkpointId: checkpointId(operationId, "preflight"),
      operationId,
      state: "preflight",
      completedSourceSpaceIds: [],
      affectedObject: input.sourceSpace.id,
      recoveryAction: "retry the same idempotency key with the source still available",
      receipt: `project=${input.project.id}; sourceSpace=${input.sourceSpace.id}; sourceDigest=${sourceDigest}`,
    };
    let operation = await this.readGitOperation(operationFile);
    if (operation && (operation.idempotencyKey !== input.idempotencyKey || operation.sourceDigest !== sourceDigest || operation.projectId !== input.project.id || operation.sourceSpaceId !== input.sourceSpace.id)) {
      return {
        status: "failed",
        ...blocked("git-import.idempotency_conflict", "Git import", input.sourceSpace.id, operation.checkpoint, false, "use a new idempotency key for a different source or Project", "one source identity per idempotency key", `existingSourceDigest=${operation.sourceDigest}; requestedSourceDigest=${sourceDigest}`),
      };
    }
    await mkdir(operationDirectory, { recursive: true });
    if (!operation) {
      operation = {
        protocol: "anyam.git-import/v1",
        operationId,
        idempotencyKey: input.idempotencyKey,
        sourceDigest,
        projectId: input.project.id,
        sourceSpaceId: input.sourceSpace.id,
        state: "preflight",
        checkpoint: preflight,
      };
      await this.writeGitOperation(operationFile, operation);
    }

    const sourceDirectory = join(operationDirectory, "source-quarantine");
    const packageDirectory = operation.packageDirectory ?? join(operationDirectory, "project-export");
    let packageVerification: PortabilityResult<ProjectExport>;
    if (await exists(join(packageDirectory, "export.json"))) {
      packageVerification = await verifyProjectExportPackage(packageDirectory);
    } else {
      packageVerification = {
        status: "failed",
        ...blocked("git-import.package_missing", "Git import", input.sourceSpace.id, operation.checkpoint, true, "resume the source quarantine and regenerate the Project Export package", "the complete quarantined Project Export package", `package=${packageDirectory}`),
      };
    }

    if (packageVerification.status !== "succeeded") {
      let sourceRepository: RepositoryHandle | undefined;
      if (await hasGitRepositoryDirectory(sourceDirectory)) {
        const registered = await this.driver.createRepository({ sourceSpaceId: input.sourceSpace.id, directory: sourceDirectory, idempotencyKey: input.idempotencyKey });
        if (registered.status !== "succeeded") {
          operation = this.withGitCheckpoint(operation, "blocked", input.sourceSpace.id, registered.message);
          await this.writeGitOperation(operationFile, operation);
          return { status: "failed", ...providerFailure("Git import", input.sourceSpace.id, operation.checkpoint, registered) };
        }
        sourceRepository = registered.value;
      } else if (await exists(sourceDirectory)) {
        operation = this.withGitCheckpoint(operation, "blocked", input.sourceSpace.id, `quarantine=${sourceDirectory}; no .git directory; source transfer is incomplete`);
        await this.writeGitOperation(operationFile, operation);
        return {
          status: "failed",
          ...blocked("git-import.quarantine_incomplete", "Git import", input.sourceSpace.id, operation.checkpoint, true, "repair or remove the incomplete quarantine, then retry the same idempotency key", "a complete quarantined Git repository", `quarantine=${sourceDirectory}; gitDirectory=false`),
        };
      } else {
        const cloned = await this.driver.cloneRepository({ sourceSpaceId: input.sourceSpace.id, source: input.source, destination: sourceDirectory, mirror: true, idempotencyKey: input.idempotencyKey });
        if (cloned.status !== "succeeded") {
          operation = this.withGitCheckpoint(operation, "blocked", input.sourceSpace.id, cloned.message);
          await this.writeGitOperation(operationFile, operation);
          return { status: "failed", ...providerFailure("Git import", input.sourceSpace.id, operation.checkpoint, cloned) };
        }
        sourceRepository = cloned.value;
      }
      const inspected = await this.driver.inspectRepository({ repository: sourceRepository });
      if (inspected.status !== "succeeded") {
        operation = this.withGitCheckpoint(operation, "blocked", input.sourceSpace.id, inspected.message);
        await this.writeGitOperation(operationFile, operation);
        return { status: "failed", ...providerFailure("Git import inspection", input.sourceSpace.id, operation.checkpoint, inspected) };
      }
      operation = this.withGitCheckpoint(operation, "quarantined", input.sourceSpace.id, `quarantine=${sourceDirectory}; refs=${inspected.value.refs.length}; generation=${inspected.value.generation}`);
      await this.writeGitOperation(operationFile, operation);
      const repositoryDirectory = join(packageDirectory, "repositories", safeName(input.sourceSpace.id));
      const exported = await this.driver.exportRepository({ repository: sourceRepository, destination: repositoryDirectory, checkpointId: operation.checkpoint.checkpointId });
      if (exported.status !== "succeeded") {
        operation = this.withGitCheckpoint(operation, "blocked", input.sourceSpace.id, exported.message);
        await this.writeGitOperation(operationFile, operation);
        return { status: "failed", ...providerFailure("Git import export", input.sourceSpace.id, operation.checkpoint, exported) };
      }
      const lfsComplete = exported.value.repository.lfs.state === "empty" || exported.value.repository.lfs.state === "complete";
      if (!lfsComplete) {
        operation = this.withGitCheckpoint(operation, "blocked", input.sourceSpace.id, `lfsState=${exported.value.repository.lfs.state}; objects=${exported.value.repository.lfs.objects.length}`);
        await this.writeGitOperation(operationFile, operation);
        return {
          status: "failed",
          ...blocked("git-import.lfs_incomplete", "Git import", input.sourceSpace.id, operation.checkpoint, true, "make every declared Git LFS object available, then retry the same idempotency key", "the complete declared Git LFS object set", `state=${exported.value.repository.lfs.state}; objects=${exported.value.repository.lfs.objects.length}`),
        };
      }
      const integrity = await this.driver.verifyRepository({ repository: sourceRepository, expected: exported.value.repository, bundlePath: exported.value.bundlePath });
      if (integrity.status !== "succeeded") {
        operation = this.withGitCheckpoint(operation, "blocked", input.sourceSpace.id, integrity.message);
        await this.writeGitOperation(operationFile, operation);
        return { status: "failed", ...providerFailure("Git import verification", input.sourceSpace.id, operation.checkpoint, integrity) };
      }
      if (!integrity.value.refsMatch || !integrity.value.bundleVerified || !integrity.value.fsckPassed || !integrity.value.lfsComplete) {
        operation = this.withGitCheckpoint(operation, "blocked", input.sourceSpace.id, integrity.value.receipt);
        await this.writeGitOperation(operationFile, operation);
        return {
          status: "failed",
          ...blocked("git-import.integrity_failed", "Git import", input.sourceSpace.id, operation.checkpoint, false, "repair the quarantined repository or source bundle, then retry the same idempotency key", "the complete Git object and LFS set", integrity.value.receipt),
        };
      }
      const manifest = singleRepositoryProjectExport({
        project: input.project,
        sourceSpace: input.sourceSpace,
        repository: exported.value.repository,
        exportId: opaqueId("export"),
        checkpointId: operation.checkpoint.checkpointId,
      });
      await writeProjectExportPackage(packageDirectory, manifest, operation.checkpoint);
      packageVerification = await verifyProjectExportPackage(packageDirectory);
      if (packageVerification.status !== "succeeded") {
        operation = this.withGitCheckpoint(operation, "blocked", input.sourceSpace.id, packageVerification.message);
        await this.writeGitOperation(operationFile, operation);
        return packageVerification;
      }
      operation = { ...operation, packageDirectory, state: "verified", checkpoint: this.gitCheckpoint(operation, "verified", input.sourceSpace.id, `package=${packageDirectory}; manifestDigest=${manifest.integrity.manifestDigest}`) };
      await this.writeGitOperation(operationFile, operation);
    }

    const imported = await this.importProject({ packageDirectory, destination, idempotencyKey: input.idempotencyKey });
    if (imported.status !== "succeeded") {
      operation = this.withGitCheckpoint(operation, "blocked", input.sourceSpace.id, imported.message);
      await this.writeGitOperation(operationFile, operation);
      return imported;
    }
    operation = { ...operation, packageDirectory, state: "activated", checkpoint: this.gitCheckpoint(operation, "activated", input.sourceSpace.id, imported.value.receipt) };
    await this.writeGitOperation(operationFile, operation);
    return imported;
  }

  async importProject(input: ImportProjectInput): Promise<PortabilityResult<ImportedProject>> {
    const verification = await verifyProjectExportPackage(input.packageDirectory);
    const operationId = `import:${digestText(input.idempotencyKey)}`;
    const operationDirectory = join(resolve(input.destination), ".anyam", "imports", safeName(digestText(input.idempotencyKey)));
    const operationFile = join(operationDirectory, "operation.json");
    if (verification.status !== "succeeded") return verification;
    const manifest = verification.value;
    const existing = await this.readOperation(operationFile);
    if (existing && (existing.idempotencyKey !== input.idempotencyKey || existing.exportDigest !== manifest.integrity.manifestDigest)) {
      const conflictCheckpoint = existing.checkpoint;
      return { status: "failed", ...blocked("import.idempotency_conflict", "import", manifest.project.id, conflictCheckpoint, false, "use a new idempotency key for a different Project Export", "one export identity per idempotency key", `existingExport=${existing.exportDigest}; requestedExport=${manifest.integrity.manifestDigest}`) };
    }
    if (existing?.state === "activated") {
      return this.successFromOperation(existing, manifest, input.destination);
    }
    let operation: ImportOperationRecord = existing ?? {
      protocol: "anyam.import/v1",
      operationId,
      idempotencyKey: input.idempotencyKey,
      exportId: manifest.exportId,
      exportDigest: manifest.integrity.manifestDigest,
      destination: resolve(input.destination),
      state: "preflight",
      completedSourceSpaceIds: [],
      checkpoint: {
        protocol: "anyam.recovery-checkpoint/v1",
        checkpointId: checkpointId(operationId, "preflight"),
        operationId,
        state: "preflight",
        completedSourceSpaceIds: [],
        affectedObject: manifest.project.id,
        recoveryAction: "continue the staged import from the preflight checkpoint",
        receipt: `project=${manifest.project.id}; export=${manifest.exportId}`,
      },
    };
    await mkdir(operationDirectory, { recursive: true });
    if (operation.state === "preflight") {
      const quarantineDirectory = join(operationDirectory, "quarantine");
      if (!(await exists(quarantineDirectory))) await cp(resolve(input.packageDirectory), quarantineDirectory, { recursive: true });
      operation = this.withCheckpoint(operation, "quarantined", manifest.project.id, [], `quarantine=${quarantineDirectory}`);
      await this.writeOperation(operationFile, operation);
    }
    const quarantineDirectory = join(operationDirectory, "quarantine");
    const quarantinedVerification = await verifyProjectExportPackage(quarantineDirectory);
    if (quarantinedVerification.status !== "succeeded") {
      operation = this.withCheckpoint(operation, "blocked", manifest.project.id, operation.completedSourceSpaceIds, quarantinedVerification.message);
      await this.writeOperation(operationFile, operation);
      return quarantinedVerification;
    }
    operation = this.withCheckpoint(operation, "verified", manifest.project.id, operation.completedSourceSpaceIds, `quarantine=${quarantineDirectory}; manifestDigest=${manifest.integrity.manifestDigest}`);
    await this.writeOperation(operationFile, operation);
    const repositories: Record<string, RepositoryHandle> = {};
    for (const repository of manifest.repositories) {
      if (operation.completedSourceSpaceIds.includes(repository.sourceSpaceId)) continue;
      operation = this.withCheckpoint(operation, "activating", repository.sourceSpaceId, operation.completedSourceSpaceIds, `destination=${input.destination}`);
      await this.writeOperation(operationFile, operation);
      const bundlePath = join(quarantineDirectory, "repositories", safeName(repository.sourceSpaceId), repository.bundle.relativePath);
      const restored = await this.driver.restoreRepository({
        sourceSpaceId: repository.sourceSpaceId,
        bundlePath,
        destination: join(resolve(input.destination), "repositories", safeName(repository.sourceSpaceId)),
        expectedDigest: repository.bundle.digest,
        lfsObjects: repository.lfs.objects.map((object) => ({
          oid: object.oid,
          sourcePath: join(quarantineDirectory, "repositories", safeName(repository.sourceSpaceId), object.relativePath ?? ""),
          ...(object.digest ? { digest: object.digest } : {}),
        })),
        refs: repository.refs,
        defaultBranch: repository.defaultBranch,
        idempotencyKey: input.idempotencyKey,
      });
      if (restored.status !== "succeeded") {
        operation = this.withCheckpoint(operation, "blocked", repository.sourceSpaceId, operation.completedSourceSpaceIds, restored.message);
        await this.writeOperation(operationFile, operation);
        return { status: "failed", ...providerFailure("import", repository.sourceSpaceId, operation.checkpoint, restored) };
      }
      const integrity = await this.driver.verifyRepository({ repository: restored.value.repository, expected: repository, bundlePath });
      if (integrity.status !== "succeeded") {
        operation = this.withCheckpoint(operation, "blocked", repository.sourceSpaceId, operation.completedSourceSpaceIds, integrity.message);
        await this.writeOperation(operationFile, operation);
        return { status: "failed", ...providerFailure("import verification", repository.sourceSpaceId, operation.checkpoint, integrity) };
      }
      if (!integrity.value.refsMatch || !integrity.value.bundleVerified || !integrity.value.fsckPassed || !integrity.value.lfsComplete) {
        operation = this.withCheckpoint(operation, "blocked", repository.sourceSpaceId, operation.completedSourceSpaceIds, integrity.value.receipt);
        await this.writeOperation(operationFile, operation);
        return {
          status: "failed",
          ...blocked("import.integrity_failed", "import verification", repository.sourceSpaceId, operation.checkpoint, false, "repair the restored repository or bundle and retry the same idempotency key", "the complete repository and LFS object set", integrity.value.receipt),
        };
      }
      repositories[repository.sourceSpaceId] = restored.value.repository;
      operation = {
        ...operation,
        completedSourceSpaceIds: [...operation.completedSourceSpaceIds, repository.sourceSpaceId],
      };
      await this.writeOperation(operationFile, operation);
    }
    operation = this.withCheckpoint(operation, "activated", manifest.project.id, operation.completedSourceSpaceIds, `repositories=${operation.completedSourceSpaceIds.length}; manifestDigest=${manifest.integrity.manifestDigest}`);
    await this.writeOperation(operationFile, operation);
    await mkdir(resolve(input.destination), { recursive: true });
    await writeFile(join(resolve(input.destination), "project-export.json"), `${stableStringify(manifest)}\n`, "utf8");
    return {
      status: "succeeded",
      value: {
        manifest,
        destination: resolve(input.destination),
        operationId,
        checkpoint: operation.checkpoint,
        repositories,
        receipt: `import=${operationId}; project=${manifest.project.id}; repositories=${operation.completedSourceSpaceIds.length}; checkpoint=${operation.checkpoint.checkpointId}`,
      },
    };
  }

  private withCheckpoint(
    operation: ImportOperationRecord,
    state: ImportCheckpointState,
    affectedObject: string,
    completedSourceSpaceIds: readonly string[],
    receipt: string,
  ): ImportOperationRecord {
    const checkpoint: ImportCheckpoint = {
      protocol: "anyam.recovery-checkpoint/v1",
      checkpointId: checkpointId(operation.operationId, state),
      operationId: operation.operationId,
      state,
      completedSourceSpaceIds: [...completedSourceSpaceIds],
      affectedObject,
      recoveryAction: state === "activated" ? "no recovery action required" : "retry the same idempotency key to resume from this checkpoint",
      receipt,
    };
    return { ...operation, state, completedSourceSpaceIds: [...completedSourceSpaceIds], checkpoint };
  }

  private gitCheckpoint(
    operation: GitImportOperationRecord,
    state: ImportCheckpointState,
    affectedObject: string,
    receipt: string,
  ): ImportCheckpoint {
    return {
      protocol: "anyam.recovery-checkpoint/v1",
      checkpointId: checkpointId(operation.operationId, state),
      operationId: operation.operationId,
      state,
      completedSourceSpaceIds: state === "activated" ? [operation.sourceSpaceId] : [],
      affectedObject,
      recoveryAction: state === "activated" ? "no recovery action required" : "retry the same idempotency key to resume from this checkpoint",
      receipt,
    };
  }

  private withGitCheckpoint(
    operation: GitImportOperationRecord,
    state: ImportCheckpointState,
    affectedObject: string,
    receipt: string,
  ): GitImportOperationRecord {
    return { ...operation, state, checkpoint: this.gitCheckpoint(operation, state, affectedObject, receipt) };
  }

  private async readOperation(file: string): Promise<ImportOperationRecord | undefined> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as ImportOperationRecord;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readGitOperation(file: string): Promise<GitImportOperationRecord | undefined> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as GitImportOperationRecord;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeOperation(file: string, operation: ImportOperationRecord): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${stableStringify(operation)}\n`, "utf8");
  }

  private async writeGitOperation(file: string, operation: GitImportOperationRecord): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${stableStringify(operation)}\n`, "utf8");
  }

  private async successFromOperation(operation: ImportOperationRecord, manifest: ProjectExport, destination: string): Promise<PortabilityResult<ImportedProject>> {
    const repositories: Record<string, RepositoryHandle> = {};
    for (const sourceSpaceId of operation.completedSourceSpaceIds) {
      const restored = await this.driver.createRepository({
        sourceSpaceId,
        directory: join(resolve(destination), "repositories", safeName(sourceSpaceId)),
        idempotencyKey: operation.idempotencyKey,
      });
      if (restored.status === "succeeded") repositories[sourceSpaceId] = restored.value;
    }
    return {
      status: "succeeded",
      value: {
        manifest,
        destination: resolve(destination),
        operationId: operation.operationId,
        checkpoint: operation.checkpoint,
        repositories,
        receipt: `import=${operation.operationId}; state=activated; checkpoint=${operation.checkpoint.checkpointId}`,
      },
    };
  }
}

export function projectExportManifestDigest(manifest: ProjectExport): string {
  return manifestDigest(manifest);
}

export function portabilityResultError(result: PortabilityResult<unknown>): string | undefined {
  return result.status === "failed" ? result.message : undefined;
}
