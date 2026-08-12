import { AUTHORITY_PLANE_PROTOCOL } from "../../../src/cloudflare/authority-plane.ts";
import type { DisclosureClassification } from "../../../src/kernel/contracts.ts";

export const ARTIFACT_RECORD_COMMAND = "artifact.record" as const;

export type ArtifactRecordErrorKind = "auth" | "invalid_request" | "not_found" | "conflict" | "coordinator";

export class ArtifactRecordInputError extends Error {
  readonly kind: ArtifactRecordErrorKind;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(message: string, recoveryAction: string, receipt: string, kind: ArtifactRecordErrorKind = "invalid_request") {
    super(message);
    this.name = "ArtifactRecordInputError";
    this.kind = kind;
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

function invalid(message: string, recoveryAction: string, receipt: string): never {
  throw new ArtifactRecordInputError(message, recoveryAction, receipt);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("artifact.record arguments must be an object.", "send the documented typed Artifact arguments; no transition was accepted", "operation=artifact.record; arguments=object-required; transition=not-applied");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${field} is required.`, `provide a non-empty ${field}; no transition was accepted`, `operation=artifact.record; field=${field}; transition=not-applied`);
  }
  return value.trim();
}

function safeIdentifier(value: unknown, field: string): string {
  const identifier = requiredString(value, field);
  if (identifier.includes("/") || identifier.includes("\\") || identifier === "." || identifier === "..") {
    return invalid(`${field} must be one safe identifier.`, `remove path separators from ${field} and retry; no transition was accepted`, `operation=artifact.record; field=${field}; identifier=safe-required; transition=not-applied`);
  }
  return identifier;
}

function optionalSafeIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : safeIdentifier(value, field);
}

function expectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid("expectedVersion must be a non-negative safe integer.", "read the current Authority version and retry with that expectedVersion; no transition was accepted", "operation=artifact.record; expectedVersion=non-negative-safe-integer-required; transition=not-applied");
  }
  return value;
}

function assertAllowed(body: Record<string, unknown>): void {
  const allowed = ["idempotencyKey", "expectedVersion", "projectId", "artifactId", "type", "digest", "projectRevisionId", "changeRevisionId", "runId", "actionId", "outputPath", "provenanceDigest", "disclosure"];
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) return invalid(`Field ${unknown} is not accepted by this typed route.`, `remove ${unknown} and send only the documented artifact.record fields; no transition was accepted`, `operation=artifact.record; field=${unknown}; transition=not-applied`);
}

function disclosure(value: unknown): { projectionId: string; classification: DisclosureClassification } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("disclosure must be an object.", "provide disclosure.projectionId and disclosure.classification; no transition was accepted", "operation=artifact.record; disclosure=object-required; transition=not-applied");
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).find((key) => !["projectionId", "classification"].includes(key));
  if (unknown) return invalid(`Field disclosure.${unknown} is not accepted.`, "send only disclosure.projectionId and disclosure.classification; no transition was accepted", `operation=artifact.record; field=disclosure.${unknown}; transition=not-applied`);
  const projectionId = safeIdentifier(body.projectionId, "disclosure.projectionId");
  const classification = requiredString(body.classification, "disclosure.classification") as DisclosureClassification;
  if (!["public", "project", "restricted"].includes(classification)) return invalid(`disclosure.classification ${classification} is unsupported.`, "use public, project, or restricted; no transition was accepted", `operation=artifact.record; disclosure.classification=${classification}; transition=not-applied`);
  return { projectionId, classification };
}

function relativeOutputPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const path = requiredString(value, "outputPath");
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return invalid("outputPath must be one non-empty relative path.", "provide a relative outputPath without empty, dot, or parent segments; no transition was accepted", "operation=artifact.record; field=outputPath; relative-path-required; transition=not-applied");
  }
  return path;
}

export type ArtifactRecordMutation = {
  command: typeof ARTIFACT_RECORD_COMMAND;
  idempotencyKey: string;
  expectedVersion?: number;
  payload: Record<string, unknown>;
};

export function artifactRecordCommand(value: unknown): ArtifactRecordMutation {
  const body = objectBody(value);
  assertAllowed(body);
  const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey");
  const version = expectedVersion(body.expectedVersion);
  const projectId = safeIdentifier(body.projectId, "projectId");
  const artifactId = optionalSafeIdentifier(body.artifactId, "artifactId");
  const type = requiredString(body.type, "type");
  const digest = requiredString(body.digest, "digest");
  const projectRevisionId = safeIdentifier(body.projectRevisionId, "projectRevisionId");
  const changeRevisionId = optionalSafeIdentifier(body.changeRevisionId, "changeRevisionId");
  const runId = optionalSafeIdentifier(body.runId, "runId");
  const actionId = optionalSafeIdentifier(body.actionId, "actionId");
  const outputPath = relativeOutputPath(body.outputPath);
  const provenanceDigest = body.provenanceDigest === undefined ? undefined : requiredString(body.provenanceDigest, "provenanceDigest");
  const disclosureValue = disclosure(body.disclosure);
  return {
    command: ARTIFACT_RECORD_COMMAND,
    idempotencyKey,
    ...(version === undefined ? {} : { expectedVersion: version }),
    payload: {
      projectId,
      ...(artifactId ? { artifactId } : {}),
      type,
      digest,
      projectRevisionId,
      ...(changeRevisionId ? { changeRevisionId } : {}),
      ...(runId ? { runId } : {}),
      ...(actionId ? { actionId } : {}),
      ...(outputPath ? { outputPath } : {}),
      ...(provenanceDigest ? { provenanceDigest } : {}),
      disclosure: disclosureValue,
    },
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`coordinator_${field}_malformed`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`coordinator_${field}_malformed`);
  return value;
}

function optionalStringValue(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, field);
}

function safeArtifact(value: unknown): Record<string, unknown> {
  const artifact = record(value, "artifact");
  const disclosureValue = record(artifact.disclosure, "artifact.disclosure");
  return {
    protocol: stringValue(artifact.protocol, "artifact.protocol"),
    id: stringValue(artifact.id, "artifact.id"),
    type: stringValue(artifact.type, "artifact.type"),
    digest: stringValue(artifact.digest, "artifact.digest"),
    projectRevisionId: stringValue(artifact.projectRevisionId, "artifact.projectRevisionId"),
    ...(optionalStringValue(artifact.changeRevisionId, "artifact.changeRevisionId") ? { changeRevisionId: optionalStringValue(artifact.changeRevisionId, "artifact.changeRevisionId") } : {}),
    ...(optionalStringValue(artifact.runId, "artifact.runId") ? { runId: optionalStringValue(artifact.runId, "artifact.runId") } : {}),
    ...(optionalStringValue(artifact.actionId, "artifact.actionId") ? { actionId: optionalStringValue(artifact.actionId, "artifact.actionId") } : {}),
    disclosure: { projectionId: stringValue(disclosureValue.projectionId, "artifact.disclosure.projectionId"), classification: stringValue(disclosureValue.classification, "artifact.disclosure.classification") },
  };
}

export function artifactRecordValue(result: Record<string, unknown>, idempotencyKey: string, surface: "mcp" | "rest" = "mcp"): Record<string, unknown> {
  const value = record(result.value, "value");
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    status: stringValue(result.status, "status"),
    version: typeof result.version === "number" && Number.isSafeInteger(result.version) ? result.version : (() => { throw new Error("coordinator_version_malformed"); })(),
    idempotencyKey,
    credentialFree: true,
    canonicalWrite: false,
    artifact: safeArtifact(value.artifact),
    receipt: `operation=${ARTIFACT_RECORD_COMMAND}; typedSurface=${surface}; credentialFree=true; canonicalWrite=false; authorityResult=projected`,
  };
}
