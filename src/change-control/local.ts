import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, posix, relative } from "node:path";

import {
  CONTRACT_VERSIONS,
  createProjectRevision,
  opaqueId,
  type Change,
  type ChangeRevision,
  type ChangeRevisionKind,
  type Conflict,
  type ConflictKind,
  type Landing,
  type ActorRef,
  type ChangeOrigin,
  type Project,
  type ProjectRevision,
  type ProjectView,
  type SourceSpace,
  type Workspace,
  type WorkspaceMount,
} from "../kernel/contracts.ts";

/**
 * A provider-neutral source snapshot used by the local Workspace materializer.
 * The snapshot ID is authoritative; files are the local adapter's content
 * view and never become a second source of identity.
 */
export type WorkspaceSource = {
  sourceSpaceId: string;
  snapshotId: string;
  files: Readonly<Record<string, string>>;
};

export type WorkspaceMountInput = {
  sourceSpaceId: string;
  mountPath: string;
};

export type MaterializeWorkspaceInput = {
  project: Project;
  view: ProjectView;
  sources: readonly WorkspaceSource[];
  mounts: readonly WorkspaceMountInput[];
  directory: string;
  id?: string;
  changeId?: string;
  actorId?: string;
};

export type MaterializedWorkspace = {
  workspace: Workspace;
  directory: string;
};

export type ChangeControlErrorCode =
  | "project-mismatch"
  | "unknown-project-revision"
  | "workspace-not-found"
  | "workspace-state"
  | "workspace-source-not-authorized"
  | "workspace-source-mismatch"
  | "workspace-source-missing"
  | "workspace-source-duplicate"
  | "workspace-mount-invalid"
  | "workspace-mount-collision"
  | "workspace-file-invalid"
  | "workspace-directory-exists"
  | "workspace-directory-not-empty"
  | "change-not-found"
  | "change-workspace-mismatch"
  | "conflict-not-found"
  | "conflict-open"
  | "conflict-change-mismatch"
  | "stale-canonical-revision"
  | "change-revision-not-found"
  | "change-revision-not-latest"
  | "change-revision-base-mismatch"
  | "landing-source-space-invalid"
  | "landing-blocked"
  | "revert-source-not-found";

/**
 * Every failure is actionable and carries a receipt. Callers can render this
 * directly to an agent without converting a silent exception into a blank UI.
 */
export class ChangeControlError extends Error {
  readonly code: ChangeControlErrorCode;
  readonly affectedObject: string;
  readonly recoveryAction: string;
  readonly receipt: string;
  readonly conflictingIds: readonly string[];

  constructor(input: {
    code: ChangeControlErrorCode;
    message: string;
    affectedObject: string;
    recoveryAction: string;
    receipt: string;
    conflictingIds?: readonly string[];
  }) {
    super(input.message);
    this.name = "ChangeControlError";
    this.code = input.code;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
    this.conflictingIds = [...(input.conflictingIds ?? [])];
  }
}

function failure(input: ConstructorParameters<typeof ChangeControlError>[0]): never {
  throw new ChangeControlError(input);
}

function notFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizedMountPath(value: string): string {
  const replaced = value.replaceAll("\\", "/");
  const normalized = posix.normalize(replaced).replace(/^\.\//, "").replace(/\/$/, "");
  const containsTraversalSegment = replaced.split("/").some((segment) => segment === "..");
  if (
    replaced.length === 0 ||
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("/") ||
    containsTraversalSegment ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0")
  ) {
    failure({
      code: "workspace-mount-invalid",
      message: `Workspace mount path is invalid; use a non-empty relative path without traversal.`,
      affectedObject: "workspace-mount",
      recoveryAction: "choose an explicit relative mount path and retry materialization",
      receipt: `mount-path=${JSON.stringify(value)}; rule=relative-no-traversal`,
    });
  }
  return normalized;
}

function normalizedFilePath(value: string): string {
  const replaced = value.replaceAll("\\", "/");
  const normalized = posix.normalize(replaced).replace(/^\.\//, "");
  const containsTraversalSegment = replaced.split("/").some((segment) => segment === "..");
  if (
    replaced.length === 0 ||
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("/") ||
    containsTraversalSegment ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0")
  ) {
    failure({
      code: "workspace-file-invalid",
      message: `Workspace source file path is invalid; source files must remain below their Source Space mount.`,
      affectedObject: "workspace-file",
      recoveryAction: "remove absolute or traversal segments from the source file path",
      receipt: `file-path=${JSON.stringify(value)}; rule=relative-no-traversal`,
    });
  }
  return normalized;
}

function mountCollision(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function cloneWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    mounts: workspace.mounts.map((mount) => ({ ...mount })),
  };
}

function cloneChange(change: Change): Change {
  return {
    ...change,
    ...(change.author ? { author: { ...change.author } } : {}),
    ...(change.origin ? { origin: { ...change.origin, ...(change.origin.remoteAuthor ? { remoteAuthor: { ...change.origin.remoteAuthor } } : {}) } } : {}),
  };
}

function cloneRevision(revision: ChangeRevision): ChangeRevision {
  return {
    ...revision,
    declaredEffects: [...revision.declaredEffects],
    ...(revision.author ? { author: { ...revision.author } } : {}),
    ...(revision.sourceSpaceSnapshots ? { sourceSpaceSnapshots: { ...revision.sourceSpaceSnapshots } } : {}),
    ...(revision.affectedSourceSpaceIds ? { affectedSourceSpaceIds: [...revision.affectedSourceSpaceIds] } : {}),
    ...(revision.affectedModuleIds ? { affectedModuleIds: [...revision.affectedModuleIds] } : {}),
    ...(revision.affectedTargetIds ? { affectedTargetIds: [...revision.affectedTargetIds] } : {}),
    ...(revision.conflictIds ? { conflictIds: [...revision.conflictIds] } : {}),
  };
}

function cloneConflict(conflict: Conflict): Conflict {
  return {
    ...conflict,
    sourceSpaceIds: [...conflict.sourceSpaceIds],
    paths: [...conflict.paths],
  };
}

/**
 * Materialize one authorized Project View as a collision-safe composed
 * filesystem. All authorization, path, and collision checks run before the
 * staging directory is created, so a failed request cannot partially mutate a
 * target Workspace.
 */
export async function materializeWorkspace(input: MaterializeWorkspaceInput): Promise<MaterializedWorkspace> {
  if (input.view.projectId !== input.project.id) {
    failure({
      code: "project-mismatch",
      message: `Project View does not belong to the requested Project.`,
      affectedObject: "workspace",
      recoveryAction: "derive the Project View from the same Project and retry",
      receipt: `project=${input.project.id}; view=${input.view.id}`,
    });
  }

  const visibleIds = new Set(input.view.visibleSourceSpaceIds);
  const sourceById = new Map<string, WorkspaceSource>();
  for (const source of input.sources) {
    if (sourceById.has(source.sourceSpaceId)) {
      failure({
        code: "workspace-source-duplicate",
        message: `Workspace source content names one Source Space more than once.`,
        affectedObject: input.view.id,
        recoveryAction: "provide exactly one snapshot content entry for each Source Space",
        receipt: `view=${input.view.id}; rule=unique-source-snapshot-inputs`,
      });
    }
    sourceById.set(source.sourceSpaceId, source);
  }
  const mountById = new Map<string, WorkspaceMount>();
  const mounts: WorkspaceMount[] = [];
  const mountPaths: string[] = [];

  for (const mountInput of input.mounts) {
    if (!visibleIds.has(mountInput.sourceSpaceId)) {
      // Deliberately do not echo the unauthorized Source Space ID. A public
      // projection must not turn a failed request into a metadata oracle.
      failure({
        code: "workspace-source-not-authorized",
        message: `Workspace composition requested a Source Space outside the authorized Project View.`,
        affectedObject: input.view.id,
        recoveryAction: "request a new authorized Project View before materializing the Workspace",
        receipt: `view=${input.view.id}; rule=visible-source-spaces-only`,
      });
    }
    if (mountById.has(mountInput.sourceSpaceId)) {
      failure({
        code: "workspace-mount-collision",
        message: `Workspace composition names one Source Space more than once.`,
        affectedObject: input.view.id,
        recoveryAction: "assign exactly one mount path to each authorized Source Space",
        receipt: `view=${input.view.id}; rule=unique-source-space-mounts`,
      });
    }

    const mountPath = normalizedMountPath(mountInput.mountPath);
    for (const priorPath of mountPaths) {
      if (mountCollision(priorPath, mountPath)) {
        failure({
          code: "workspace-mount-collision",
          message: `Workspace mount paths overlap; materialization was not started.`,
          affectedObject: input.view.id,
          recoveryAction: "choose non-overlapping explicit mount paths and retry",
          receipt: `view=${input.view.id}; mount-a=${priorPath}; mount-b=${mountPath}`,
        });
      }
    }

    const source = sourceById.get(mountInput.sourceSpaceId);
    const disclosedSnapshot = input.view.disclosedSourceSpaceSnapshots[mountInput.sourceSpaceId];
    if (!source) {
      failure({
        code: "workspace-source-missing",
        message: `An authorized Source Space snapshot is unavailable to the Workspace adapter.`,
        affectedObject: input.view.id,
        recoveryAction: "load the authorized Source Space snapshot and retry",
        receipt: `view=${input.view.id}; source-space=authorized-but-unavailable`,
      });
    }
    if (source.snapshotId !== disclosedSnapshot) {
      failure({
        code: "workspace-source-mismatch",
        message: `Workspace source content does not match the authorized Project View snapshot.`,
        affectedObject: mountInput.sourceSpaceId,
        recoveryAction: "refresh the Source Space snapshot and derive a new Project View",
        receipt: `source-space=${mountInput.sourceSpaceId}; view=${input.view.id}; snapshot-mismatch`,
      });
    }

    mountPaths.push(mountPath);
    const mount: WorkspaceMount = {
      sourceSpaceId: mountInput.sourceSpaceId,
      snapshotId: source.snapshotId,
      mountPath,
    };
    mounts.push(mount);
    mountById.set(mountInput.sourceSpaceId, mount);
  }

  for (const visibleId of input.view.visibleSourceSpaceIds) {
    if (!mountById.has(visibleId)) {
      failure({
        code: "workspace-source-missing",
        message: `Workspace composition omitted an authorized Source Space.`,
        affectedObject: input.view.id,
        recoveryAction: "provide one mount for every Source Space in the Project View",
        receipt: `view=${input.view.id}; missing-authorized-mount=true`,
      });
    }
  }

  for (const mount of mounts) {
    const source = sourceById.get(mount.sourceSpaceId);
    if (!source) continue;
    for (const path of Object.keys(source.files)) normalizedFilePath(path);
  }

  try {
    await stat(input.directory);
    failure({
      code: "workspace-directory-exists",
      message: `Workspace target already exists; materialization refused to overwrite it.`,
      affectedObject: input.directory,
      recoveryAction: "choose a new Workspace directory or explicitly remove the old Workspace",
      receipt: `directory=${input.directory}; overwrite=false`,
    });
  } catch (error) {
    if (!notFound(error)) throw error;
  }

  await mkdir(dirname(input.directory), { recursive: true });
  const staging = await mkdtemp(join(dirname(input.directory), ".anyam-workspace-stage-"));
  try {
    for (const mount of mounts) {
      const source = sourceById.get(mount.sourceSpaceId);
      if (!source) continue;
      for (const [sourcePath, content] of Object.entries(source.files)) {
        const destination = join(staging, mount.mountPath, normalizedFilePath(sourcePath));
        const relativeDestination = relative(staging, normalize(destination));
        if (relativeDestination.startsWith("..") || relativeDestination.includes("\0")) {
          failure({
            code: "workspace-file-invalid",
            message: `Workspace source file escaped its Source Space mount.`,
            affectedObject: mount.sourceSpaceId,
            recoveryAction: "remove traversal from the source file path and retry",
            receipt: `source-space=${mount.sourceSpaceId}; rule=mount-contained`,
          });
        }
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content, "utf8");
      }
    }
    await mkdir(dirname(input.directory), { recursive: true });
    await rename(staging, input.directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    directory: input.directory,
    workspace: {
      protocol: CONTRACT_VERSIONS.workspace,
      id: input.id ?? opaqueId("workspace"),
      projectId: input.project.id,
      projectRevisionId: input.view.projectRevisionId,
      projectViewId: input.view.id,
      mounts,
      state: "active",
      ...(input.changeId ? { changeId: input.changeId } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {}),
    },
  };
}

export type LocalChangeCoordinatorInput = {
  project: Project;
  sourceSpaces: readonly SourceSpace[];
  canonicalRevision: ProjectRevision;
};

export type CreateWorkspaceInput = Omit<MaterializeWorkspaceInput, "project">;

export class LocalChangeCoordinator {
  readonly project: Project;
  readonly sourceSpaces: readonly SourceSpace[];
  private canonical: ProjectRevision;
  private readonly projectRevisions = new Map<string, ProjectRevision>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly changes = new Map<string, Change>();
  private readonly revisions = new Map<string, ChangeRevision>();
  private readonly conflicts = new Map<string, Conflict>();

  constructor(input: LocalChangeCoordinatorInput) {
    if (input.canonicalRevision.projectId !== input.project.id) {
      failure({
        code: "project-mismatch",
        message: `Canonical Project Revision does not belong to the Project.`,
        affectedObject: input.canonicalRevision.id,
        recoveryAction: "load a canonical revision for the requested Project",
        receipt: `project=${input.project.id}; revision=${input.canonicalRevision.id}`,
      });
    }
    this.project = input.project;
    this.sourceSpaces = input.sourceSpaces.map((space) => ({ ...space }));
    this.canonical = {
      ...input.canonicalRevision,
      sourceSpaceSnapshots: { ...input.canonicalRevision.sourceSpaceSnapshots },
    };
    this.projectRevisions.set(this.canonical.id, this.canonical);
  }

  get canonicalRevision(): ProjectRevision {
    return {
      ...this.canonical,
      sourceSpaceSnapshots: { ...this.canonical.sourceSpaceSnapshots },
      ...(this.canonical.landedChangeRevisionIds ? { landedChangeRevisionIds: [...this.canonical.landedChangeRevisionIds] } : {}),
    };
  }

  getWorkspace(workspaceId: string): Workspace | undefined {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? cloneWorkspace(workspace) : undefined;
  }

  getChange(changeId: string): Change | undefined {
    const change = this.changes.get(changeId);
    return change ? cloneChange(change) : undefined;
  }

  getRevision(revisionId: string): ChangeRevision | undefined {
    const revision = this.revisions.get(revisionId);
    return revision ? cloneRevision(revision) : undefined;
  }

  listConflicts(changeId: string): readonly Conflict[] {
    return [...this.conflicts.values()]
      .filter((conflict) => conflict.changeId === changeId)
      .map(cloneConflict);
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<MaterializedWorkspace> {
    const projectRevision = this.projectRevisions.get(input.view.projectRevisionId);
    if (!projectRevision) {
      failure({
        code: "unknown-project-revision",
        message: `Workspace base Project Revision is not known to this coordinator.`,
        affectedObject: input.view.id,
        recoveryAction: "refresh the canonical Project Revision and derive a new Project View",
        receipt: `view=${input.view.id}; revision=${input.view.projectRevisionId}`,
      });
    }
    if (projectRevision.projectId !== this.project.id) {
      failure({
        code: "project-mismatch",
        message: `Workspace base Project Revision belongs to a different Project.`,
        affectedObject: input.view.id,
        recoveryAction: "derive the Project View from this Project",
        receipt: `view=${input.view.id}; project=${this.project.id}`,
      });
    }
    for (const sourceSpaceId of input.view.visibleSourceSpaceIds) {
      const disclosedSnapshot = input.view.disclosedSourceSpaceSnapshots[sourceSpaceId];
      if (projectRevision.sourceSpaceSnapshots[sourceSpaceId] !== disclosedSnapshot) {
        failure({
          code: "workspace-source-mismatch",
          message: `Project View disclosure does not match its exact Project Revision.`,
          affectedObject: input.view.id,
          recoveryAction: "derive a fresh Project View from the exact Project Revision",
          receipt: `view=${input.view.id}; revision=${projectRevision.id}; snapshot-mismatch=true`,
        });
      }
    }
    const materialized = await materializeWorkspace({ ...input, project: this.project });
    this.workspaces.set(materialized.workspace.id, materialized.workspace);
    return {
      directory: materialized.directory,
      workspace: cloneWorkspace(materialized.workspace),
    };
  }

  createChange(input: { intentId: string; workspaceId: string; id?: string; author?: ActorRef; origin?: ChangeOrigin }): Change {
    const workspace = this.workspaces.get(input.workspaceId);
    if (!workspace) {
      failure({
        code: "workspace-not-found",
        message: `Cannot create a Change without a known Workspace.`,
        affectedObject: input.workspaceId,
        recoveryAction: "create or restore the Workspace and retry",
        receipt: `workspace=${input.workspaceId}; operation=change.create`,
      });
    }
    if (workspace.state !== "active") {
      failure({
        code: "workspace-state",
        message: `Cannot attach a Change to a non-active Workspace.`,
        affectedObject: workspace.id,
        recoveryAction: "create a fresh active Workspace from the desired Project Revision",
        receipt: `workspace=${workspace.id}; state=${workspace.state}`,
      });
    }
    if (workspace.changeId) {
      failure({
        code: "change-workspace-mismatch",
        message: `Workspace already belongs to a Change.`,
        affectedObject: workspace.id,
        recoveryAction: "reuse the existing Change or create another Workspace",
        receipt: `workspace=${workspace.id}; change=${workspace.changeId}`,
      });
    }
    const change: Change = {
      protocol: CONTRACT_VERSIONS.change,
      id: input.id ?? opaqueId("change"),
      projectId: this.project.id,
      intentId: input.intentId,
      baseProjectRevisionId: workspace.projectRevisionId,
      status: "active",
      latestRevisionId: null,
      workspaceId: workspace.id,
      ...(input.author ? { author: { ...input.author } } : {}),
      ...(input.origin ? { origin: { ...input.origin, ...(input.origin.remoteAuthor ? { remoteAuthor: { ...input.origin.remoteAuthor } } : {}) } } : {}),
    };
    this.changes.set(change.id, change);
    this.workspaces.set(workspace.id, { ...workspace, changeId: change.id });
    return cloneChange(change);
  }

  registerConflict(input: {
    changeId: string;
    workspaceId: string;
    kind: ConflictKind;
    sourceSpaceIds: readonly string[];
    paths: readonly string[];
    description: string;
    id?: string;
  }): Conflict {
    const change = this.requireChange(input.changeId);
    const workspace = this.requireWorkspace(input.workspaceId);
    if (change.workspaceId !== workspace.id) {
      failure({
        code: "change-workspace-mismatch",
        message: `Conflict Workspace is not the current Workspace for this Change.`,
        affectedObject: change.id,
        recoveryAction: "handoff or rebase the Change onto its current Workspace before recording a conflict",
        receipt: `change=${change.id}; workspace=${workspace.id}`,
      });
    }
    for (const sourceSpaceId of input.sourceSpaceIds) {
      if (!this.project.sourceSpaceIds.includes(sourceSpaceId)) {
        failure({
          code: "workspace-source-not-authorized",
          message: `Conflict references a Source Space outside the Project.`,
          affectedObject: change.id,
          recoveryAction: "record the conflict against a Project Source Space",
          receipt: `change=${change.id}; rule=project-source-spaces-only`,
        });
      }
      if (!workspace.mounts.some((mount) => mount.sourceSpaceId === sourceSpaceId)) {
        failure({
          code: "workspace-source-not-authorized",
          message: `Conflict references a Source Space outside the current Workspace View.`,
          affectedObject: change.id,
          recoveryAction: "record the conflict only against Source Spaces materialized in this Workspace",
          receipt: `change=${change.id}; rule=workspace-view-only`,
        });
      }
    }
    const conflict: Conflict = {
      protocol: CONTRACT_VERSIONS.conflict,
      id: input.id ?? opaqueId("conflict"),
      projectId: this.project.id,
      changeId: change.id,
      workspaceId: workspace.id,
      kind: input.kind,
      sourceSpaceIds: [...input.sourceSpaceIds],
      paths: input.paths.map(normalizedFilePath),
      description: input.description,
      state: "open",
    };
    this.conflicts.set(conflict.id, conflict);
    this.workspaces.set(workspace.id, { ...workspace, state: "blocked" });
    return cloneConflict(conflict);
  }

  resolveConflict(input: { conflictId: string; resolutionNote?: string }): Conflict {
    const conflict = this.conflicts.get(input.conflictId);
    if (!conflict) {
      failure({
        code: "conflict-not-found",
        message: `Conflict cannot be resolved because it is not known to this coordinator.`,
        affectedObject: input.conflictId,
        recoveryAction: "refresh the Change and resolve an active Conflict",
        receipt: `conflict=${input.conflictId}; operation=conflict.resolve`,
      });
    }
    const updated: Conflict = { ...conflict, state: "resolved" };
    this.conflicts.set(updated.id, updated);
    const workspace = this.workspaces.get(updated.workspaceId);
    if (workspace) {
      const hasOpenConflict = [...this.conflicts.values()].some(
        (candidate) => candidate.workspaceId === workspace.id && candidate.state === "open",
      );
      this.workspaces.set(workspace.id, { ...workspace, state: hasOpenConflict ? "blocked" : "active" });
    }
    // The note is intentionally not treated as evidence or authoritative
    // resolution state. A new Change Revision is the durable resolution.
    void input.resolutionNote;
    return cloneConflict(updated);
  }

  publishRevision(input: {
    changeId: string;
    workspaceId?: string;
    declaredEffects: readonly string[];
    conflictIds?: readonly string[];
    kind?: ChangeRevisionKind;
    actor?: ActorRef;
    affectedModuleIds?: readonly string[];
    affectedTargetIds?: readonly string[];
  }): ChangeRevision {
    const change = this.requireChange(input.changeId);
    const workspaceId = input.workspaceId ?? change.workspaceId;
    if (!workspaceId) {
      failure({
        code: "workspace-not-found",
        message: `Change has no Workspace from which to publish a revision.`,
        affectedObject: change.id,
        recoveryAction: "attach an active Workspace before publishing a Change Revision",
        receipt: `change=${change.id}; operation=change.publish-revision`,
      });
    }
    const workspace = this.requireWorkspace(workspaceId);
    if (change.workspaceId !== workspace.id) {
      failure({
        code: "change-workspace-mismatch",
        message: `Requested Workspace is not attached to the Change.`,
        affectedObject: change.id,
        recoveryAction: "handoff or rebase the Change onto the requested Workspace",
        receipt: `change=${change.id}; workspace=${workspace.id}`,
      });
    }
    if (workspace.state === "closed") {
      failure({
        code: "workspace-state",
        message: `Closed Workspaces cannot publish new Change Revisions.`,
        affectedObject: workspace.id,
        recoveryAction: "create a new Workspace from the latest Change Revision",
        receipt: `workspace=${workspace.id}; state=closed`,
      });
    }

    const relevantConflicts = [...this.conflicts.values()].filter(
      (conflict) => conflict.changeId === change.id && conflict.workspaceId === workspace.id,
    );
    for (const conflictId of input.conflictIds ?? []) {
      const conflict = this.conflicts.get(conflictId);
      if (!conflict) {
        failure({
          code: "conflict-not-found",
          message: `Change Revision names a Conflict that is not known to this coordinator.`,
          affectedObject: change.id,
          recoveryAction: "refresh the Change and publish with known Conflict IDs",
          receipt: `change=${change.id}; conflict=${conflictId}`,
        });
      }
      if (conflict.changeId !== change.id || conflict.workspaceId !== workspace.id) {
        failure({
          code: "conflict-change-mismatch",
          message: `Change Revision names a Conflict from another Change or Workspace.`,
          affectedObject: change.id,
          recoveryAction: "publish only the Conflicts attached to the current Change Workspace",
          receipt: `change=${change.id}; conflict=${conflictId}`,
        });
      }
    }
    const openConflicts = relevantConflicts.filter((conflict) => conflict.state === "open");
    if (openConflicts.length > 0) {
      failure({
        code: "conflict-open",
        message: `Change Revision publication is blocked by unresolved explicit conflicts.`,
        affectedObject: change.id,
        recoveryAction: "resolve every listed Conflict, then publish a new Change Revision",
        receipt: `change=${change.id}; open-conflicts=${openConflicts.length}`,
        conflictingIds: openConflicts.map((conflict) => conflict.id),
      });
    }

    const priorRevision = change.latestRevisionId ? this.revisions.get(change.latestRevisionId) : undefined;
    const sourceSpaceSnapshots = Object.fromEntries(
      workspace.mounts.map((mount) => [mount.sourceSpaceId, mount.snapshotId]),
    ) as Readonly<Record<string, string>>;
    const revision: ChangeRevision = {
      protocol: CONTRACT_VERSIONS.change,
      id: opaqueId("change-revision"),
      changeId: change.id,
      // Kept for compatibility with the existing Run/Evidence contracts; the
      // explicit base field is authoritative for Landing.
      projectRevisionId: workspace.projectRevisionId,
      projectViewId: workspace.projectViewId,
      sequence: (priorRevision?.sequence ?? 0) + 1,
      parentRevisionId: priorRevision?.id,
      declaredEffects: [...input.declaredEffects],
      baseProjectRevisionId: workspace.projectRevisionId,
      workspaceId: workspace.id,
      sourceSpaceSnapshots,
      affectedSourceSpaceIds: workspace.mounts.map((mount) => mount.sourceSpaceId),
      ...(input.affectedModuleIds ? { affectedModuleIds: [...input.affectedModuleIds] } : {}),
      ...(input.affectedTargetIds ? { affectedTargetIds: [...input.affectedTargetIds] } : {}),
      ...(input.actor ? { author: { ...input.actor } } : (change.author ? { author: { ...change.author } } : {})),
      conflictIds: [...(input.conflictIds ?? relevantConflicts.map((conflict) => conflict.id))],
      kind: input.kind ?? "implementation",
    };
    this.revisions.set(revision.id, revision);
    const updatedChange: Change = {
      ...change,
      latestRevisionId: revision.id,
      status: "submitted",
      workspaceId: workspace.id,
    };
    this.changes.set(change.id, updatedChange);
    for (const conflict of relevantConflicts) {
      if (conflict.state === "resolved") {
        this.conflicts.set(conflict.id, { ...conflict, resolutionRevisionId: revision.id });
      }
    }
    return cloneRevision(revision);
  }

  async rebaseChange(input: {
    changeId: string;
    view: ProjectView;
    sources: readonly WorkspaceSource[];
    mounts: readonly WorkspaceMountInput[];
    directory: string;
    actorId?: string;
    declaredEffects: readonly string[];
  }): Promise<{ workspace: Workspace; revision: ChangeRevision }> {
    const change = this.requireChange(input.changeId);
    const materialized = await this.createWorkspace({
      view: input.view,
      sources: input.sources,
      mounts: input.mounts,
      directory: input.directory,
      changeId: change.id,
      ...(input.actorId ? { actorId: input.actorId } : {}),
    });
    const rebasedWorkspace = materialized.workspace;
    this.workspaces.set(rebasedWorkspace.id, rebasedWorkspace);
    this.changes.set(change.id, {
      ...change,
      baseProjectRevisionId: rebasedWorkspace.projectRevisionId,
      workspaceId: rebasedWorkspace.id,
      status: "active",
    });
    const revision = this.publishRevision({
      changeId: change.id,
      workspaceId: rebasedWorkspace.id,
      declaredEffects: input.declaredEffects,
      kind: "rebase",
    });
    return { workspace: cloneWorkspace(rebasedWorkspace), revision };
  }

  handoffChange(input: { changeId: string; actorId: string }): Workspace {
    const change = this.requireChange(input.changeId);
    const workspace = this.requireWorkspace(change.workspaceId);
    const updated = { ...workspace, actorId: input.actorId };
    this.workspaces.set(updated.id, updated);
    return cloneWorkspace(updated);
  }

  revertChange(input: { landedChangeRevisionId: string; intentId: string; workspaceId?: string; id?: string }): Change {
    const landedRevision = this.revisions.get(input.landedChangeRevisionId);
    if (!landedRevision) {
      failure({
        code: "revert-source-not-found",
        message: `Revert source Change Revision is not known to this coordinator.`,
        affectedObject: input.landedChangeRevisionId,
        recoveryAction: "select a landed Change Revision from the canonical lineage",
        receipt: `change-revision=${input.landedChangeRevisionId}; operation=revert`,
      });
    }
    const wasLanded = [...this.projectRevisions.values()].some(
      (revision) => revision.landedChangeRevisionId === landedRevision.id,
    );
    if (!wasLanded) {
      failure({
        code: "revert-source-not-found",
        message: `Revert source Change Revision is known but has not been landed.`,
        affectedObject: landedRevision.id,
        recoveryAction: "select a Change Revision from the canonical Project Revision lineage",
        receipt: `change-revision=${landedRevision.id}; landed=false`,
      });
    }
    const workspace = input.workspaceId ? this.requireWorkspace(input.workspaceId) : undefined;
    if (workspace && workspace.projectRevisionId !== this.canonical.id) {
      failure({
        code: "change-revision-base-mismatch",
        message: `Revert Workspace is not based on the current canonical Project Revision.`,
        affectedObject: workspace.id,
        recoveryAction: "rebase the revert Workspace onto the current canonical Project Revision",
        receipt: `workspace=${workspace.id}; canonical=${this.canonical.id}`,
      });
    }
    const change: Change = {
      protocol: CONTRACT_VERSIONS.change,
      id: input.id ?? opaqueId("change-revert"),
      projectId: this.project.id,
      intentId: input.intentId,
      baseProjectRevisionId: workspace?.projectRevisionId ?? this.canonical.id,
      status: "active",
      latestRevisionId: null,
      ...(workspace ? { workspaceId: workspace.id } : {}),
      revertsChangeRevisionId: landedRevision.id,
    };
    this.changes.set(change.id, change);
    void landedRevision;
    return cloneChange(change);
  }

  landChange(input: { changeId: string; changeRevisionId: string; expectedCanonicalProjectRevisionId: string }): Landing {
    return this.landCohort({
      members: [{ changeId: input.changeId, changeRevisionId: input.changeRevisionId }],
      expectedCanonicalProjectRevisionId: input.expectedCanonicalProjectRevisionId,
    });
  }

  /**
   * Atomically Lands one or more exact Change Revisions. All validation runs
   * before the compare-and-swap mutation, so a failed cohort never partially
   * advances one Source Space or Change.
   */
  landCohort(input: {
    cohortId?: string;
    members: readonly { changeId: string; changeRevisionId: string }[];
    expectedCanonicalProjectRevisionId: string;
  }): Landing {
    if (input.members.length === 0) {
      failure({
        code: "landing-blocked",
        message: "Landing requires at least one Change Revision.",
        affectedObject: input.cohortId ?? "landing",
        recoveryAction: "compose a non-empty Integration Cohort and retry Landing",
        receipt: "members=0",
      });
    }
    const uniqueChanges = new Set(input.members.map((member) => member.changeId));
    if (uniqueChanges.size !== input.members.length) {
      failure({
        code: "landing-blocked",
        message: "Landing cannot include the same Change more than once.",
        affectedObject: input.cohortId ?? "landing",
        recoveryAction: "select one exact Change Revision for each stable Change",
        receipt: `members=${input.members.length}; uniqueChanges=${uniqueChanges.size}`,
      });
    }
    const selected: Array<{ change: Change; revision: ChangeRevision }> = [];
    for (const member of input.members) {
      const change = this.requireChange(member.changeId);
      const revision = this.revisions.get(member.changeRevisionId);
      if (!revision) {
        failure({
          code: "change-revision-not-found",
          message: "Landing requested an unknown Change Revision.",
          affectedObject: member.changeRevisionId,
          recoveryAction: "refresh the Change and select an immutable published revision",
          receipt: `change=${change.id}; revision=${member.changeRevisionId}`,
        });
      }
      if (revision.changeId !== change.id) {
        failure({
          code: "change-revision-not-found",
          message: "Landing requested a Change Revision from another Change.",
          affectedObject: member.changeRevisionId,
          recoveryAction: "select a revision belonging to the requested Change",
          receipt: `change=${change.id}; revision=${member.changeRevisionId}`,
        });
      }
      if (change.latestRevisionId !== revision.id) {
        failure({
          code: "change-revision-not-latest",
          message: "Only the latest immutable Change Revision can be landed.",
          affectedObject: change.id,
          recoveryAction: "land the latest revision or publish a new revision from it",
          receipt: `change=${change.id}; latest=${change.latestRevisionId ?? "none"}; requested=${revision.id}`,
        });
      }
      const openConflicts = [...this.conflicts.values()].filter(
        (conflict) => conflict.changeId === change.id && conflict.workspaceId === revision.workspaceId && conflict.state === "open",
      );
      if (openConflicts.length > 0) {
        failure({
          code: "landing-blocked",
          message: "Landing is blocked by unresolved explicit Conflicts.",
          affectedObject: change.id,
          recoveryAction: "resolve the Conflicts, publish a new Change Revision, and retry Landing",
          receipt: `change=${change.id}; open-conflicts=${openConflicts.length}`,
          conflictingIds: openConflicts.map((conflict) => conflict.id),
        });
      }
      selected.push({ change, revision });
    }

    // This compare happens before any state mutation. A stale request is a
    // clean failure, never a partial write or last-writer-wins overwrite.
    if (this.canonical.id !== input.expectedCanonicalProjectRevisionId) {
      failure({
        code: "stale-canonical-revision",
        message: "Landing is stale because the canonical Project Revision advanced.",
        affectedObject: input.cohortId ?? selected[0]!.change.id,
        recoveryAction: "rebase every Change in the Integration Cohort onto the current canonical Project Revision and reverify",
        receipt: `expected=${input.expectedCanonicalProjectRevisionId}; actual=${this.canonical.id}; compare-and-swap=false`,
      });
    }

    // Preserve the compare-and-swap error as the first stale-state signal.
    // Once the caller has the current canonical revision, validate each
    // member's declared base before composing Source Space snapshots.
    for (const { change, revision } of selected) {
      const baseProjectRevisionId = revision.baseProjectRevisionId ?? revision.projectRevisionId;
      if (baseProjectRevisionId !== this.canonical.id || change.baseProjectRevisionId !== this.canonical.id) {
        failure({
          code: "change-revision-base-mismatch",
          message: "Change Revision is not based on the canonical Project Revision.",
          affectedObject: change.id,
          recoveryAction: `rebase ${change.id} onto ${this.canonical.id}, then publish and verify a new revision`,
          receipt: `change-base=${change.baseProjectRevisionId}; revision-base=${baseProjectRevisionId}; canonical=${this.canonical.id}`,
        });
      }
    }

    const nextSnapshots = { ...this.canonical.sourceSpaceSnapshots };
    for (const { change, revision } of selected) {
      for (const [sourceSpaceId, snapshotId] of Object.entries(revision.sourceSpaceSnapshots ?? {})) {
        if (!this.project.sourceSpaceIds.includes(sourceSpaceId)) {
          failure({
            code: "landing-source-space-invalid",
            message: "Change Revision names a Source Space outside the Project.",
            affectedObject: change.id,
            recoveryAction: "publish a revision containing only Project Source Spaces",
            receipt: `change=${change.id}; sourceSpace=${sourceSpaceId}; rule=project-source-spaces-only`,
          });
        }
        const existing = nextSnapshots[sourceSpaceId];
        if (existing !== undefined && existing !== snapshotId && existing !== this.canonical.sourceSpaceSnapshots[sourceSpaceId]) {
          failure({
            code: "landing-blocked",
            message: "Integration Cohort contains incompatible Snapshots for one Source Space.",
            affectedObject: input.cohortId ?? change.id,
            recoveryAction: "resolve the Source Space conflict in a new Change Revision, then refresh the Integration Cohort",
            receipt: `sourceSpace=${sourceSpaceId}; existing=${existing}; incoming=${snapshotId}`,
          });
        }
        nextSnapshots[sourceSpaceId] = snapshotId;
      }
    }
    const previousProjectRevisionId = this.canonical.id;
    const changeIds = selected.map(({ change }) => change.id);
    const changeRevisionIds = selected.map(({ revision }) => revision.id);
    const next = createProjectRevision({
      projectId: this.project.id,
      sourceSpaceSnapshots: nextSnapshots,
      parentProjectRevisionId: previousProjectRevisionId,
      landedChangeRevisionId: changeRevisionIds[0]!,
      landedChangeRevisionIds: changeRevisionIds,
      ...(input.cohortId ? { landingCohortId: input.cohortId } : {}),
    });
    this.projectRevisions.set(next.id, next);
    this.canonical = next;
    for (const { change } of selected) this.changes.set(change.id, { ...change, status: "landed" });
    return {
      protocol: CONTRACT_VERSIONS.landing,
      id: opaqueId("landing"),
      projectId: this.project.id,
      changeId: changeIds[0]!,
      changeRevisionId: changeRevisionIds[0]!,
      previousProjectRevisionId,
      projectRevisionId: next.id,
      ...(input.cohortId ? { cohortId: input.cohortId } : {}),
      changeIds,
      changeRevisionIds,
      receipt: `compare-and-swap=true; previous=${previousProjectRevisionId}; next=${next.id}; changes=${changeIds.join(",")}; cohort=${input.cohortId ?? "single-change"}`,
    };
  }

  private requireWorkspace(workspaceId: string | undefined): Workspace {
    if (!workspaceId) {
      failure({
        code: "workspace-not-found",
        message: `Change operation requires an attached Workspace.`,
        affectedObject: "change",
        recoveryAction: "create or attach a Workspace and retry",
        receipt: "workspace=missing",
      });
    }
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      failure({
        code: "workspace-not-found",
        message: `Requested Workspace is not known to this coordinator.`,
        affectedObject: workspaceId,
        recoveryAction: "restore the Workspace or create a new one",
        receipt: `workspace=${workspaceId}; known=false`,
      });
    }
    return workspace;
  }

  private requireChange(changeId: string): Change {
    const change = this.changes.get(changeId);
    if (!change) {
      failure({
        code: "change-not-found",
        message: `Requested Change is not known to this coordinator.`,
        affectedObject: changeId,
        recoveryAction: "refresh the Project and select an existing Change",
        receipt: `change=${changeId}; known=false`,
      });
    }
    return change;
  }
}
