import { AUTHORITY_PLANE_PROTOCOL } from "../../../src/cloudflare/authority-plane.ts";

export const LANDING_APPLY_COMMAND = "landing.apply" as const;

export type LandingInputErrorKind = "auth" | "invalid_request" | "not_found" | "conflict" | "coordinator";

export class LandingInputError extends Error {
  readonly kind: LandingInputErrorKind;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(message: string, recoveryAction: string, receipt: string, kind: LandingInputErrorKind = "invalid_request") {
    super(message);
    this.name = "LandingInputError";
    this.kind = kind;
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

function invalid(message: string, recoveryAction: string, receipt: string): never {
  throw new LandingInputError(message, recoveryAction, receipt);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${LANDING_APPLY_COMMAND} arguments must be an object.`, "send the documented typed Landing arguments; no transition was accepted", `operation=${LANDING_APPLY_COMMAND}; arguments=object-required; transition=not-applied`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${field} is required.`, `provide a non-empty ${field}; no transition was accepted`, `operation=${LANDING_APPLY_COMMAND}; field=${field}; transition=not-applied`);
  }
  return value.trim();
}

function safeIdentifier(value: unknown, field: string): string {
  const identifier = requiredString(value, field);
  if (identifier.includes("/") || identifier.includes("\\") || identifier === "." || identifier === "..") {
    return invalid(`${field} must be one safe identifier.`, `remove path separators from ${field} and retry; no transition was accepted`, `operation=${LANDING_APPLY_COMMAND}; field=${field}; identifier=safe-required; transition=not-applied`);
  }
  return identifier;
}

function optionalSafeIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : safeIdentifier(value, field);
}

function expectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid("expectedVersion must be a non-negative safe integer.", "read the current Authority version and retry with that expectedVersion; no transition was accepted", `operation=${LANDING_APPLY_COMMAND}; expectedVersion=non-negative-safe-integer-required; transition=not-applied`);
  }
  return value;
}

export function landingApplyCommand(value: unknown): {
  command: typeof LANDING_APPLY_COMMAND;
  idempotencyKey: string;
  expectedVersion?: number;
  payload: Record<string, unknown>;
} {
  const body = objectBody(value);
  const allowed = [
    "idempotencyKey",
    "expectedVersion",
    "projectId",
    "changeId",
    "changeRevisionId",
    "expectedCanonicalProjectRevisionId",
    "projectRevisionId",
    "landingId",
  ] as const;
  const unknown = Object.keys(body).find((key) => !allowed.includes(key as (typeof allowed)[number]));
  if (unknown) return invalid(`Field ${unknown} is not accepted by this typed route.`, `remove ${unknown} and send only the documented ${LANDING_APPLY_COMMAND} fields; no transition was accepted`, `operation=${LANDING_APPLY_COMMAND}; field=${unknown}; transition=not-applied`);

  const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey");
  const version = expectedVersion(body.expectedVersion);
  const projectId = safeIdentifier(body.projectId, "projectId");
  const changeId = safeIdentifier(body.changeId, "changeId");
  const changeRevisionId = safeIdentifier(body.changeRevisionId, "changeRevisionId");
  const expectedCanonicalProjectRevisionId = safeIdentifier(body.expectedCanonicalProjectRevisionId, "expectedCanonicalProjectRevisionId");
  const projectRevisionId = optionalSafeIdentifier(body.projectRevisionId, "projectRevisionId");
  const landingId = optionalSafeIdentifier(body.landingId, "landingId");

  return {
    command: LANDING_APPLY_COMMAND,
    idempotencyKey,
    ...(version === undefined ? {} : { expectedVersion: version }),
    payload: {
      projectId,
      changeId,
      changeRevisionId,
      expectedCanonicalProjectRevisionId,
      ...(projectRevisionId ? { projectRevisionId } : {}),
      ...(landingId ? { landingId } : {}),
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

function safeLanding(value: unknown): Record<string, unknown> {
  const landing = recordValue(value, "landing");
  const cohortId = landing.cohortId === undefined ? undefined : valueString(landing.cohortId, "landing.cohortId");
  const changeIds = landing.changeIds === undefined ? undefined : valueStringList(landing.changeIds, "landing.changeIds");
  const changeRevisionIds = landing.changeRevisionIds === undefined ? undefined : valueStringList(landing.changeRevisionIds, "landing.changeRevisionIds");
  return {
    protocol: valueString(landing.protocol, "landing.protocol"),
    id: valueString(landing.id, "landing.id"),
    projectId: valueString(landing.projectId, "landing.projectId"),
    changeId: valueString(landing.changeId, "landing.changeId"),
    changeRevisionId: valueString(landing.changeRevisionId, "landing.changeRevisionId"),
    previousProjectRevisionId: valueString(landing.previousProjectRevisionId, "landing.previousProjectRevisionId"),
    projectRevisionId: valueString(landing.projectRevisionId, "landing.projectRevisionId"),
    ...(cohortId ? { cohortId } : {}),
    ...(changeIds ? { changeIds } : {}),
    ...(changeRevisionIds ? { changeRevisionIds } : {}),
  };
}

function safeCanonicalRevision(value: unknown): Record<string, unknown> {
  const revision = recordValue(value, "canonicalRevision");
  const parentProjectRevisionId = revision.parentProjectRevisionId === undefined ? undefined : valueString(revision.parentProjectRevisionId, "canonicalRevision.parentProjectRevisionId");
  const landedChangeRevisionId = revision.landedChangeRevisionId === undefined ? undefined : valueString(revision.landedChangeRevisionId, "canonicalRevision.landedChangeRevisionId");
  const landedChangeRevisionIds = revision.landedChangeRevisionIds === undefined ? undefined : valueStringList(revision.landedChangeRevisionIds, "canonicalRevision.landedChangeRevisionIds");
  const landingCohortId = revision.landingCohortId === undefined ? undefined : valueString(revision.landingCohortId, "canonicalRevision.landingCohortId");
  return {
    protocol: valueString(revision.protocol, "canonicalRevision.protocol"),
    id: valueString(revision.id, "canonicalRevision.id"),
    projectId: valueString(revision.projectId, "canonicalRevision.projectId"),
    ...(parentProjectRevisionId ? { parentProjectRevisionId } : {}),
    ...(landedChangeRevisionId ? { landedChangeRevisionId } : {}),
    ...(landedChangeRevisionIds ? { landedChangeRevisionIds } : {}),
    ...(landingCohortId ? { landingCohortId } : {}),
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

export function landingApplyValue(result: Record<string, unknown>, idempotencyKey: string, surface: "rest" | "mcp" = "rest"): Record<string, unknown> {
  const value = recordValue(result.value, "value");
  const canonicalWrite = surface === "mcp" ? false : "landing-only";
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    status: valueString(result.status, "status"),
    version: typeof result.version === "number" && Number.isSafeInteger(result.version) ? result.version : (() => { throw new Error("coordinator_version_malformed"); })(),
    idempotencyKey,
    credentialFree: true,
    canonicalWrite,
    landing: safeLanding(value.landing),
    canonicalRevision: safeCanonicalRevision(value.canonicalRevision),
    change: safeChange(value.change),
    receipt: `operation=${LANDING_APPLY_COMMAND}; typedSurface=${surface}; credentialFree=true; canonicalWrite=${canonicalWrite === false ? "false" : "landing-only"}; authorityResult=projected`,
  };
}
