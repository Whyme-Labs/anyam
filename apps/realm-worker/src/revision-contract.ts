import { AUTHORITY_PLANE_PROTOCOL } from "../../../src/cloudflare/authority-plane.ts";
import type { ChangeRevisionKind } from "../../../src/kernel/contracts.ts";

export const REVISION_PUBLISH_COMMAND = "revision.publish" as const;

export class RevisionPublishInputError extends Error {
  readonly kind: "auth" | "invalid_request" | "not_found" | "conflict" | "coordinator";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(message: string, recoveryAction: string, receipt: string, kind: RevisionPublishInputError["kind"] = "invalid_request") {
    super(message);
    this.name = "RevisionPublishInputError";
    this.kind = kind;
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

function invalid(message: string, recoveryAction: string, receipt: string): never {
  throw new RevisionPublishInputError(message, recoveryAction, receipt);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${field} is required.`, `provide a non-empty ${field}; no transition was accepted`, `operation=${REVISION_PUBLISH_COMMAND}; field=${field}; transition=not-applied`);
  }
  return value.trim();
}

function safeIdentifier(value: unknown, field: string): string {
  const identifier = requiredString(value, field);
  if (identifier.includes("/") || identifier.includes("\\") || identifier === "." || identifier === "..") {
    return invalid(`${field} must be one safe identifier.`, `remove path separators from ${field} and retry; no transition was accepted`, `operation=${REVISION_PUBLISH_COMMAND}; field=${field}; identifier=safe-required; transition=not-applied`);
  }
  return identifier;
}

function optionalSafeIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : safeIdentifier(value, field);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    return invalid(`${field} must be an array of non-empty strings.`, `provide ${field} as a string array; no transition was accepted`, `operation=${REVISION_PUBLISH_COMMAND}; field=${field}; stringArray=invalid; transition=not-applied`);
  }
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
}

function requiredStringList(body: Record<string, unknown>, field: string): string[] {
  if (body[field] === undefined) return invalid(`${field} is required.`, `provide ${field} as a string array; no transition was accepted`, `operation=${REVISION_PUBLISH_COMMAND}; field=${field}; stringArray=required; transition=not-applied`);
  return stringList(body[field], field);
}

function optionalStringList(body: Record<string, unknown>, field: string): string[] | undefined {
  return body[field] === undefined ? undefined : stringList(body[field], field);
}

function sourceSpaceSnapshots(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("sourceSpaceSnapshots must be an object.", "provide Source Space snapshot identifiers as a JSON object; no transition was accepted", `operation=${REVISION_PUBLISH_COMMAND}; sourceSpaceSnapshots=object-required; transition=not-applied`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return invalid("sourceSpaceSnapshots must contain at least one Source Space.", "declare the changed Source Space snapshots; no transition was accepted", `operation=${REVISION_PUBLISH_COMMAND}; sourceSpaceSnapshots=non-empty-required; transition=not-applied`);
  }
  const result: Record<string, string> = {};
  for (const [sourceSpaceId, snapshotId] of entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    result[safeIdentifier(sourceSpaceId, "sourceSpaceSnapshots.sourceSpaceId")] = requiredString(snapshotId, `sourceSpaceSnapshots.${sourceSpaceId}`);
  }
  return result;
}

function expectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid("expectedVersion must be a non-negative safe integer.", "read the current Authority version and retry with that expectedVersion; no transition was accepted", `operation=${REVISION_PUBLISH_COMMAND}; expectedVersion=non-negative-safe-integer-required; transition=not-applied`);
  }
  return value;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("change.publish_revision arguments must be an object.", "send the documented typed revision arguments; no transition was accepted", `operation=${REVISION_PUBLISH_COMMAND}; arguments=object-required; transition=not-applied`);
  }
  return value as Record<string, unknown>;
}

export function revisionPublishCommand(value: unknown): {
  command: typeof REVISION_PUBLISH_COMMAND;
  idempotencyKey: string;
  expectedVersion?: number;
  payload: Record<string, unknown>;
} {
  const body = objectBody(value);
  const allowed = new Set([
    "idempotencyKey",
    "expectedVersion",
    "projectId",
    "changeId",
    "workspaceId",
    "projectViewId",
    "projectRevisionId",
    "sourceSpaceSnapshots",
    "declaredEffects",
    "revisionId",
    "kind",
    "conflictIds",
    "affectedModuleIds",
    "affectedTargetIds",
  ]);
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) return invalid(`Field ${unknown} is not accepted by this typed route.`, `remove ${unknown} and send only the documented ${REVISION_PUBLISH_COMMAND} fields; no transition was accepted`, `operation=${REVISION_PUBLISH_COMMAND}; field=${unknown}; transition=not-applied`);

  const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey");
  const version = expectedVersion(body.expectedVersion);
  const projectId = safeIdentifier(body.projectId, "projectId");
  const changeId = safeIdentifier(body.changeId, "changeId");
  const workspaceId = safeIdentifier(body.workspaceId, "workspaceId");
  const projectViewId = safeIdentifier(body.projectViewId, "projectViewId");
  const projectRevisionId = safeIdentifier(body.projectRevisionId, "projectRevisionId");
  const snapshots = sourceSpaceSnapshots(body.sourceSpaceSnapshots);
  const declaredEffects = requiredStringList(body, "declaredEffects");
  const revisionId = optionalSafeIdentifier(body.revisionId, "revisionId");
  const kind = body.kind === undefined ? undefined : requiredString(body.kind, "kind") as ChangeRevisionKind;
  if (kind !== undefined && !["implementation", "rebase", "conflict-resolution", "handoff", "revert"].includes(kind)) {
    return invalid(`kind ${kind} is unsupported.`, "use implementation, rebase, conflict-resolution, handoff, or revert; no transition was accepted", `operation=${REVISION_PUBLISH_COMMAND}; kind=${kind}; transition=not-applied`);
  }

  const conflictIds = optionalStringList(body, "conflictIds");
  const affectedModuleIds = optionalStringList(body, "affectedModuleIds");
  const affectedTargetIds = optionalStringList(body, "affectedTargetIds");
  return {
    command: REVISION_PUBLISH_COMMAND,
    idempotencyKey,
    ...(version === undefined ? {} : { expectedVersion: version }),
    payload: {
      projectId,
      changeId,
      workspaceId,
      projectViewId,
      projectRevisionId,
      sourceSpaceSnapshots: snapshots,
      declaredEffects,
      ...(revisionId ? { revisionId } : {}),
      ...(kind ? { kind } : {}),
      ...(conflictIds ? { conflictIds } : {}),
      ...(affectedModuleIds ? { affectedModuleIds } : {}),
      ...(affectedTargetIds ? { affectedTargetIds } : {}),
    },
  };
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`coordinator_${field}_malformed`);
  return value as Record<string, unknown>;
}

function valueString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`coordinator_${field}_malformed`);
  return value;
}

function valueStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new Error(`coordinator_${field}_malformed`);
  return [...(value as string[])];
}

function safeRevision(value: unknown): Record<string, unknown> {
  const revision = recordValue(value, "revision");
  const parentRevisionId = revision.parentRevisionId === undefined ? undefined : valueString(revision.parentRevisionId, "revision.parentRevisionId");
  const baseProjectRevisionId = revision.baseProjectRevisionId === undefined ? undefined : valueString(revision.baseProjectRevisionId, "revision.baseProjectRevisionId");
  const workspaceId = revision.workspaceId === undefined ? undefined : valueString(revision.workspaceId, "revision.workspaceId");
  const affectedModuleIds = revision.affectedModuleIds === undefined ? undefined : valueStringList(revision.affectedModuleIds, "revision.affectedModuleIds");
  const affectedTargetIds = revision.affectedTargetIds === undefined ? undefined : valueStringList(revision.affectedTargetIds, "revision.affectedTargetIds");
  const conflictIds = revision.conflictIds === undefined ? undefined : valueStringList(revision.conflictIds, "revision.conflictIds");
  const kind = revision.kind === undefined ? undefined : valueString(revision.kind, "revision.kind");
  return {
    protocol: valueString(revision.protocol, "revision.protocol"),
    id: valueString(revision.id, "revision.id"),
    changeId: valueString(revision.changeId, "revision.changeId"),
    projectRevisionId: valueString(revision.projectRevisionId, "revision.projectRevisionId"),
    projectViewId: valueString(revision.projectViewId, "revision.projectViewId"),
    sequence: typeof revision.sequence === "number" && Number.isSafeInteger(revision.sequence) ? revision.sequence : (() => { throw new Error("coordinator_revision.sequence_malformed"); })(),
    ...(parentRevisionId ? { parentRevisionId } : {}),
    ...(baseProjectRevisionId ? { baseProjectRevisionId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    declaredEffects: valueStringList(revision.declaredEffects, "revision.declaredEffects"),
    ...(affectedModuleIds ? { affectedModuleIds } : {}),
    ...(affectedTargetIds ? { affectedTargetIds } : {}),
    ...(conflictIds ? { conflictIds } : {}),
    ...(kind ? { kind } : {}),
  };
}

function safeChange(value: unknown): Record<string, unknown> {
  const change = recordValue(value, "change");
  const latestRevisionId = change.latestRevisionId === null ? null : valueString(change.latestRevisionId, "change.latestRevisionId");
  const workspaceId = change.workspaceId === undefined ? undefined : valueString(change.workspaceId, "change.workspaceId");
  return {
    protocol: valueString(change.protocol, "change.protocol"),
    id: valueString(change.id, "change.id"),
    projectId: valueString(change.projectId, "change.projectId"),
    intentId: valueString(change.intentId, "change.intentId"),
    baseProjectRevisionId: valueString(change.baseProjectRevisionId, "change.baseProjectRevisionId"),
    status: valueString(change.status, "change.status"),
    latestRevisionId,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export function revisionPublishValue(result: Record<string, unknown>, idempotencyKey: string): Record<string, unknown> {
  const value = recordValue(result.value, "value");
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    status: valueString(result.status, "status"),
    version: typeof result.version === "number" && Number.isSafeInteger(result.version) ? result.version : (() => { throw new Error("coordinator_version_malformed"); })(),
    idempotencyKey,
    credentialFree: true,
    canonicalWrite: false,
    revision: safeRevision(value.revision),
    change: safeChange(value.change),
    receipt: `operation=${REVISION_PUBLISH_COMMAND}; typedMcp=true; credentialFree=true; canonicalWrite=false; authorityResult=projected`,
  };
}
