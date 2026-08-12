import { AUTHORITY_PLANE_PROTOCOL } from "../../../src/cloudflare/authority-plane.ts";

export const RELEASE_CREATE_COMMAND = "release.create" as const;

export class ReleaseCreateInputError extends Error {
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(message: string, recoveryAction: string, receipt: string) {
    super(message);
    this.name = "ReleaseCreateInputError";
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

function invalid(message: string, recoveryAction: string, receipt: string): never {
  throw new ReleaseCreateInputError(message, recoveryAction, receipt);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${RELEASE_CREATE_COMMAND} arguments must be an object.`, "send the documented typed Release arguments; no transition was accepted", `operation=${RELEASE_CREATE_COMMAND}; arguments=object-required; transition=not-applied`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${field} is required.`, `provide a non-empty ${field}; no transition was accepted`, `operation=${RELEASE_CREATE_COMMAND}; field=${field}; transition=not-applied`);
  }
  return value.trim();
}

function safeIdentifier(value: unknown, field: string): string {
  const identifier = requiredString(value, field);
  if (identifier.includes("/") || identifier.includes("\\") || identifier === "." || identifier === "..") {
    return invalid(`${field} must be one safe identifier.`, `remove path separators from ${field} and retry; no transition was accepted`, `operation=${RELEASE_CREATE_COMMAND}; field=${field}; identifier=safe-required; transition=not-applied`);
  }
  return identifier;
}

function optionalSafeIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : safeIdentifier(value, field);
}

function expectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid("expectedVersion must be a non-negative safe integer.", "read the current Authority version and retry with that expectedVersion; no transition was accepted", `operation=${RELEASE_CREATE_COMMAND}; expectedVersion=non-negative-safe-integer-required; transition=not-applied`);
  }
  return value;
}

function identifierList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid(`${field} must be a non-empty array of safe identifiers.`, `provide at least one ${field} identifier; no transition was accepted`, `operation=${RELEASE_CREATE_COMMAND}; field=${field}; non-empty-array-required; transition=not-applied`);
  }
  return [...new Set(value.map((entry, index) => safeIdentifier(entry, `${field}[${index}]`)))];
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    return invalid(`${field} must be an array of non-empty strings.`, `provide a valid ${field} array; no transition was accepted`, `operation=${RELEASE_CREATE_COMMAND}; field=${field}; string-array-required; transition=not-applied`);
  }
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
}

function assertAllowed(body: Record<string, unknown>): void {
  const allowed = [
    "idempotencyKey",
    "expectedVersion",
    "projectId",
    "releaseId",
    "name",
    "projectRevisionId",
    "artifactIds",
    "evidenceIds",
    "configurationDigests",
    "stateAssumptions",
    "policyVersion",
    "changeRevisionId",
    "provenanceDigest",
  ];
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) return invalid(`Field ${unknown} is not accepted by this typed route.`, `remove ${unknown} and send only the documented ${RELEASE_CREATE_COMMAND} fields; no transition was accepted`, `operation=${RELEASE_CREATE_COMMAND}; field=${unknown}; transition=not-applied`);
}

export type ReleaseCreateMutation = {
  command: typeof RELEASE_CREATE_COMMAND;
  idempotencyKey: string;
  expectedVersion?: number;
  payload: Record<string, unknown>;
};

export function releaseCreateCommand(value: unknown): ReleaseCreateMutation {
  const body = objectBody(value);
  assertAllowed(body);
  const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey");
  const version = expectedVersion(body.expectedVersion);
  const projectId = safeIdentifier(body.projectId, "projectId");
  const releaseId = optionalSafeIdentifier(body.releaseId, "releaseId");
  const name = body.name === undefined ? undefined : requiredString(body.name, "name");
  const projectRevisionId = safeIdentifier(body.projectRevisionId, "projectRevisionId");
  const artifactIds = identifierList(body.artifactIds, "artifactIds");
  const evidenceIds = identifierList(body.evidenceIds, "evidenceIds");
  const configurationDigests = stringList(body.configurationDigests, "configurationDigests");
  const stateAssumptions = stringList(body.stateAssumptions, "stateAssumptions");
  const policyVersion = requiredString(body.policyVersion, "policyVersion");
  const changeRevisionId = optionalSafeIdentifier(body.changeRevisionId, "changeRevisionId");
  const provenanceDigest = body.provenanceDigest === undefined ? undefined : requiredString(body.provenanceDigest, "provenanceDigest");
  return {
    command: RELEASE_CREATE_COMMAND,
    idempotencyKey,
    ...(version === undefined ? {} : { expectedVersion: version }),
    payload: {
      projectId,
      ...(releaseId ? { releaseId } : {}),
      ...(name ? { name } : {}),
      projectRevisionId,
      artifactIds,
      evidenceIds,
      configurationDigests,
      stateAssumptions,
      policyVersion,
      ...(changeRevisionId ? { changeRevisionId } : {}),
      ...(provenanceDigest ? { provenanceDigest } : {}),
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

function optionalStringValue(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : valueString(value, field);
}

function valueStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new Error(`coordinator_${field}_malformed`);
  return [...(value as string[])];
}

function safeRelease(value: unknown): Record<string, unknown> {
  const release = record(value, "release");
  const projectId = valueString(release.projectId, "release.projectId");
  const name = optionalStringValue(release.name, "release.name");
  const changeRevisionId = optionalStringValue(release.changeRevisionId, "release.changeRevisionId");
  return {
    protocol: valueString(release.protocol, "release.protocol"),
    id: valueString(release.id, "release.id"),
    projectId,
    projectRevisionId: valueString(release.projectRevisionId, "release.projectRevisionId"),
    artifactIds: valueStringList(release.artifactIds, "release.artifactIds"),
    evidenceIds: valueStringList(release.evidenceIds, "release.evidenceIds"),
    policyVersion: valueString(release.policyVersion, "release.policyVersion"),
    status: valueString(release.status, "release.status"),
    ...(name ? { name } : {}),
    ...(changeRevisionId ? { changeRevisionId } : {}),
  };
}

export function releaseCreateValue(result: Record<string, unknown>, idempotencyKey: string, surface: "rest" | "mcp" = "rest"): Record<string, unknown> {
  const value = record(result.value, "value");
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    status: valueString(result.status, "status"),
    version: typeof result.version === "number" && Number.isSafeInteger(result.version) ? result.version : (() => { throw new Error("coordinator_version_malformed"); })(),
    idempotencyKey,
    credentialFree: true,
    canonicalWrite: false,
    release: safeRelease(value.release),
    receipt: `operation=${RELEASE_CREATE_COMMAND}; typedSurface=${surface}; credentialFree=true; canonicalWrite=false; authorityResult=projected`,
  };
}
