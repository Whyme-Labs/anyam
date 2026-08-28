/**
 * Canonical validation for the mapping between disclosed Source Spaces and
 * Workspace mount paths.
 *
 * The same validator is used by local materialization, Authority bootstrap,
 * and Authority restore. It deliberately canonicalizes path separators while
 * rejecting ambiguous dot, empty, absolute, and traversal segments. Collision
 * checks use a case-folded, Unicode-normalized form so a Workspace is safe on
 * both case-sensitive and case-insensitive filesystems.
 */

export const WORKSPACE_MOUNT_VALIDATION_PROTOCOL = "anyam.workspace-mount-validation/v1" as const;

export type WorkspaceMountValidationCode =
  | "source-space-array-invalid"
  | "source-space-empty"
  | "source-space-duplicate"
  | "mount-array-invalid"
  | "mount-count-mismatch"
  | "mount-invalid"
  | "mount-source-undisclosed"
  | "mount-source-duplicate"
  | "mount-path-duplicate"
  | "mount-path-overlap";

export type WorkspaceMountCandidate = {
  sourceSpaceId: string;
  mountPath: string;
};

export class WorkspaceMountValidationError extends Error {
  readonly code: WorkspaceMountValidationCode;
  readonly sourceSpaceId: string | undefined;
  readonly mountPath: string | undefined;
  readonly conflictingSourceSpaceId: string | undefined;
  readonly conflictingMountPath: string | undefined;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    code: WorkspaceMountValidationCode;
    message: string;
    sourceSpaceId?: string;
    mountPath?: string;
    conflictingSourceSpaceId?: string;
    conflictingMountPath?: string;
    recoveryAction: string;
  }) {
    super(input.message);
    this.name = "WorkspaceMountValidationError";
    this.code = input.code;
    this.sourceSpaceId = input.sourceSpaceId;
    this.mountPath = input.mountPath;
    this.conflictingSourceSpaceId = input.conflictingSourceSpaceId;
    this.conflictingMountPath = input.conflictingMountPath;
    this.recoveryAction = input.recoveryAction;
    const fields = [
      `protocol=${WORKSPACE_MOUNT_VALIDATION_PROTOCOL}`,
      `code=${input.code}`,
      input.sourceSpaceId === undefined ? undefined : `sourceSpaceId=${JSON.stringify(input.sourceSpaceId)}`,
      input.mountPath === undefined ? undefined : `mountPath=${JSON.stringify(input.mountPath)}`,
      input.conflictingSourceSpaceId === undefined ? undefined : `conflictingSourceSpaceId=${JSON.stringify(input.conflictingSourceSpaceId)}`,
      input.conflictingMountPath === undefined ? undefined : `conflictingMountPath=${JSON.stringify(input.conflictingMountPath)}`,
      "transition=not-applied",
    ].filter((value): value is string => value !== undefined);
    this.receipt = fields.join("; ");
  }
}

function invalid(input: ConstructorParameters<typeof WorkspaceMountValidationError>[0]): never {
  throw new WorkspaceMountValidationError(input);
}

function requiredSourceSpaceId(value: unknown, index: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid({
      code: "source-space-empty",
      message: `Source Space ID at index ${index} must be a non-empty string.`,
      recoveryAction: "provide one non-empty Source Space ID for every disclosed Source Space",
    });
  }
  return value.trim();
}

function normalizedMountPath(value: unknown, index: number): string {
  if (typeof value !== "string") {
    invalid({
      code: "mount-invalid",
      message: `Workspace mount at index ${index} must have a string path.`,
      recoveryAction: "provide one relative string mount path for every disclosed Source Space",
    });
  }
  const replaced = value.replaceAll("\\", "/").normalize("NFKC");
  const segments = replaced.split("/");
  const drivePath = /^[A-Za-z]:/u.test(replaced);
  const invalidSegment = segments.find((segment) => segment.length === 0 || segment === "." || segment === "..");
  if (
    replaced.length === 0
    || drivePath
    || replaced.startsWith("/")
    || replaced.includes("\0")
    || invalidSegment !== undefined
  ) {
    invalid({
      code: "mount-invalid",
      message: `Workspace mount path ${JSON.stringify(value)} is not a normalized relative path.`,
      mountPath: value,
      recoveryAction: "use a non-empty relative mount path with no absolute, empty, dot, or traversal segment",
    });
  }
  return segments.join("/");
}

function collisionKey(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function overlaps(left: string, right: string): boolean {
  const leftKey = collisionKey(left);
  const rightKey = collisionKey(right);
  return leftKey === rightKey || leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`);
}

/**
 * Validate and normalize a complete Source Space → mount-path bijection.
 * The returned array preserves mount order and contains canonical `/`
 * separators so callers can persist one unambiguous representation.
 */
export function validateWorkspaceMounts(input: {
  sourceSpaceIds: readonly unknown[];
  mounts: readonly unknown[];
}): WorkspaceMountCandidate[] {
  if (!Array.isArray(input.sourceSpaceIds)) {
    invalid({
      code: "source-space-array-invalid",
      message: "Workspace Source Space IDs must be an array.",
      recoveryAction: "provide the complete disclosed Source Space ID array",
    });
  }
  if (!Array.isArray(input.mounts)) {
    invalid({
      code: "mount-array-invalid",
      message: "Workspace mounts must be an array.",
      recoveryAction: "provide one mount object for every disclosed Source Space",
    });
  }
  if (input.sourceSpaceIds.length === 0) {
    invalid({
      code: "source-space-array-invalid",
      message: "Workspace composition must disclose at least one Source Space.",
      recoveryAction: "disclose at least one Source Space before creating a Workspace",
    });
  }

  const sourceSpaceIds: string[] = [];
  const sourceSpaceSet = new Set<string>();
  for (const [index, value] of input.sourceSpaceIds.entries()) {
    const sourceSpaceId = requiredSourceSpaceId(value, index);
    if (sourceSpaceSet.has(sourceSpaceId)) {
      invalid({
        code: "source-space-duplicate",
        message: `Source Space ${sourceSpaceId} is disclosed more than once.`,
        sourceSpaceId,
        recoveryAction: "include each disclosed Source Space exactly once",
      });
    }
    sourceSpaceSet.add(sourceSpaceId);
    sourceSpaceIds.push(sourceSpaceId);
  }

  const mountedSourceSpaces = new Map<string, WorkspaceMountCandidate>();
  const mountedPaths: WorkspaceMountCandidate[] = [];
  for (const [index, value] of input.mounts.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      invalid({
        code: "mount-invalid",
        message: `Workspace mount at index ${index} must be an object.`,
        recoveryAction: "provide one { sourceSpaceId, mountPath } object for every disclosed Source Space",
      });
    }
    const candidate = value as Record<string, unknown>;
    const sourceSpaceId = requiredSourceSpaceId(candidate.sourceSpaceId, index);
    const mountPath = normalizedMountPath(candidate.mountPath, index);
    if (!sourceSpaceSet.has(sourceSpaceId)) {
      invalid({
        code: "mount-source-undisclosed",
        message: `Workspace mount ${mountPath} references Source Space ${sourceSpaceId}, which is not disclosed by the Project View.`,
        sourceSpaceId,
        mountPath,
        recoveryAction: "mount only Source Spaces disclosed by the authorized Project View",
      });
    }
    const priorSource = mountedSourceSpaces.get(sourceSpaceId);
    if (priorSource) {
      invalid({
        code: "mount-source-duplicate",
        message: `Source Space ${sourceSpaceId} is assigned more than one Workspace mount.`,
        sourceSpaceId,
        mountPath,
        conflictingMountPath: priorSource.mountPath,
        recoveryAction: "assign exactly one mount path to each disclosed Source Space",
      });
    }
    const current: WorkspaceMountCandidate = { sourceSpaceId, mountPath };
    for (const prior of mountedPaths) {
      if (!overlaps(prior.mountPath, mountPath)) continue;
      const code = collisionKey(prior.mountPath) === collisionKey(mountPath) ? "mount-path-duplicate" : "mount-path-overlap";
      invalid({
        code,
        message: code === "mount-path-duplicate"
          ? `Workspace mount path ${mountPath} collides with ${prior.mountPath}.`
          : `Workspace mount path ${mountPath} overlaps ${prior.mountPath}.`,
        sourceSpaceId,
        mountPath,
        conflictingSourceSpaceId: prior.sourceSpaceId,
        conflictingMountPath: prior.mountPath,
        recoveryAction: "choose unique, non-overlapping mount paths; separators and case must resolve to distinct paths",
      });
    }
    mountedSourceSpaces.set(sourceSpaceId, current);
    mountedPaths.push(current);
  }

  if (input.mounts.length !== sourceSpaceIds.length) {
    invalid({
      code: "mount-count-mismatch",
      message: `Workspace mount count ${input.mounts.length} does not match disclosed Source Space count ${sourceSpaceIds.length}.`,
      recoveryAction: "provide exactly one mount for every disclosed Source Space, with no extras",
    });
  }

  // The count check plus source set membership/duplicate checks establish the
  // other side of the bijection, but keep this explicit assertion close to the
  // contract so future edits cannot accidentally weaken it.
  for (const sourceSpaceId of sourceSpaceIds) {
    if (!mountedSourceSpaces.has(sourceSpaceId)) {
      invalid({
        code: "mount-count-mismatch",
        message: `Workspace Source Space ${sourceSpaceId} has no mount.`,
        sourceSpaceId,
        recoveryAction: "provide exactly one mount for every disclosed Source Space",
      });
    }
  }
  return mountedPaths;
}

/**
 * Validate the positional `sourceSpaceIds` + `mounts` shape used by the REST
 * and MCP bootstrap envelopes. Count is checked before positional expansion so
 * an extra path cannot turn into an undefined Source Space identifier.
 */
export function validateWorkspaceMountPaths(input: {
  sourceSpaceIds: readonly unknown[];
  mountPaths: readonly unknown[];
}): WorkspaceMountCandidate[] {
  if (!Array.isArray(input.sourceSpaceIds) || !Array.isArray(input.mountPaths)) {
    invalid({
      code: !Array.isArray(input.sourceSpaceIds) ? "source-space-array-invalid" : "mount-array-invalid",
      message: "Workspace Source Space IDs and mount paths must be arrays.",
      recoveryAction: "provide one Source Space ID and one mount path for every disclosed Source Space",
    });
  }
  if (input.mountPaths.length !== input.sourceSpaceIds.length) {
    invalid({
      code: "mount-count-mismatch",
      message: `Workspace mount count ${input.mountPaths.length} does not match disclosed Source Space count ${input.sourceSpaceIds.length}.`,
      recoveryAction: "provide exactly one mount path for every disclosed Source Space, with no extras",
    });
  }
  return validateWorkspaceMounts({
    sourceSpaceIds: input.sourceSpaceIds,
    mounts: input.mountPaths.map((mountPath, index) => ({ sourceSpaceId: input.sourceSpaceIds[index], mountPath })),
  });
}
