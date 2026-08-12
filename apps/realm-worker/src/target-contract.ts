import { AUTHORITY_PLANE_PROTOCOL } from "../../../src/cloudflare/authority-plane.ts";

export const TARGET_CONFIGURE_COMMAND = "target.configure" as const;

export class TargetConfigureInputError extends Error {
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(message: string, recoveryAction: string, receipt: string) {
    super(message);
    this.name = "TargetConfigureInputError";
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

function invalid(message: string, recoveryAction: string, receipt: string): never {
  throw new TargetConfigureInputError(message, recoveryAction, receipt);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${TARGET_CONFIGURE_COMMAND} arguments must be an object.`, "send the documented typed Target arguments; no transition was accepted", `operation=${TARGET_CONFIGURE_COMMAND}; arguments=object-required; transition=not-applied`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${field} is required.`, `provide a non-empty ${field}; no transition was accepted`, `operation=${TARGET_CONFIGURE_COMMAND}; field=${field}; transition=not-applied`);
  }
  return value.trim();
}

function safeIdentifier(value: unknown, field: string): string {
  const identifier = requiredString(value, field);
  if (identifier.includes("/") || identifier.includes("\\") || identifier === "." || identifier === "..") {
    return invalid(`${field} must be one safe identifier.`, `remove path separators from ${field} and retry; no transition was accepted`, `operation=${TARGET_CONFIGURE_COMMAND}; field=${field}; identifier=safe-required; transition=not-applied`);
  }
  return identifier;
}

function optionalSafeIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : safeIdentifier(value, field);
}

function expectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid("expectedVersion must be a non-negative safe integer.", "read the current Authority version and retry with that expectedVersion; no transition was accepted", `operation=${TARGET_CONFIGURE_COMMAND}; expectedVersion=non-negative-safe-integer-required; transition=not-applied`);
  }
  return value;
}

function stringList(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    return invalid(`${field} must be ${allowEmpty ? "an array" : "a non-empty array"} of non-empty strings.`, `provide a valid ${field} array; no transition was accepted`, `operation=${TARGET_CONFIGURE_COMMAND}; field=${field}; string-array-required; transition=not-applied`);
  }
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
}

function assertAllowed(body: Record<string, unknown>): void {
  const allowed = ["idempotencyKey", "expectedVersion", "projectId", "targetId", "name", "adapterId", "acceptedArtifactTypes", "requiredEvidenceKeys"];
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) return invalid(`Field ${unknown} is not accepted by this typed route.`, `remove ${unknown} and send only the documented ${TARGET_CONFIGURE_COMMAND} fields; no transition was accepted`, `operation=${TARGET_CONFIGURE_COMMAND}; field=${unknown}; transition=not-applied`);
}

export type TargetConfigureMutation = {
  command: typeof TARGET_CONFIGURE_COMMAND;
  idempotencyKey: string;
  expectedVersion?: number;
  payload: Record<string, unknown>;
};

export function targetConfigureCommand(value: unknown): TargetConfigureMutation {
  const body = objectBody(value);
  assertAllowed(body);
  const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey");
  const version = expectedVersion(body.expectedVersion);
  const projectId = safeIdentifier(body.projectId, "projectId");
  const targetId = optionalSafeIdentifier(body.targetId, "targetId");
  const name = requiredString(body.name, "name");
  const adapterId = safeIdentifier(body.adapterId, "adapterId");
  const acceptedArtifactTypes = stringList(body.acceptedArtifactTypes, "acceptedArtifactTypes", false);
  const requiredEvidenceKeys = stringList(body.requiredEvidenceKeys ?? [], "requiredEvidenceKeys", true);
  return {
    command: TARGET_CONFIGURE_COMMAND,
    idempotencyKey,
    ...(version === undefined ? {} : { expectedVersion: version }),
    payload: {
      projectId,
      ...(targetId ? { targetId } : {}),
      name,
      adapterId,
      acceptedArtifactTypes,
      requiredEvidenceKeys,
    },
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
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

function safeTarget(value: unknown): Record<string, unknown> {
  const target = record(value, "target");
  return {
    protocol: valueString(target.protocol, "target.protocol"),
    id: valueString(target.id, "target.id"),
    projectId: valueString(target.projectId, "target.projectId"),
    name: valueString(target.name, "target.name"),
    adapterId: valueString(target.adapterId, "target.adapterId"),
    acceptedArtifactTypes: valueStringList(target.acceptedArtifactTypes, "target.acceptedArtifactTypes"),
    requiredEvidenceKeys: valueStringList(target.requiredEvidenceKeys, "target.requiredEvidenceKeys"),
    state: valueString(target.state, "target.state"),
  };
}

export function targetConfigureValue(result: Record<string, unknown>, idempotencyKey: string, surface: "rest" | "mcp" = "rest"): Record<string, unknown> {
  const value = record(result.value, "value");
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    status: valueString(result.status, "status"),
    version: typeof result.version === "number" && Number.isSafeInteger(result.version) ? result.version : (() => { throw new Error("coordinator_version_malformed"); })(),
    idempotencyKey,
    credentialFree: true,
    canonicalWrite: false,
    target: safeTarget(value.target),
    receipt: `operation=${TARGET_CONFIGURE_COMMAND}; typedSurface=${surface}; credentialFree=true; canonicalWrite=false; authorityResult=projected`,
  };
}
