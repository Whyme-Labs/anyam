import { AUTHORITY_PLANE_PROTOCOL } from "../../../src/cloudflare/authority-plane.ts";
import type { DisclosureClassification, EvidenceOutcome, RunStatus } from "../../../src/kernel/contracts.ts";

export const RUN_RECORD_COMMAND = "run.record" as const;
export const EVIDENCE_RECORD_COMMAND = "evidence.record" as const;

export type RecordMutationKind = "auth" | "invalid_request" | "not_found" | "conflict" | "coordinator";

export class RunEvidenceInputError extends Error {
  readonly kind: RecordMutationKind;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(message: string, recoveryAction: string, receipt: string, kind: RecordMutationKind = "invalid_request") {
    super(message);
    this.name = "RunEvidenceInputError";
    this.kind = kind;
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

function invalid(message: string, recoveryAction: string, receipt: string): never {
  throw new RunEvidenceInputError(message, recoveryAction, receipt);
}

function objectBody(value: unknown, operation: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${operation} arguments must be an object.`, "send the documented typed arguments; no transition was accepted", `operation=${operation}; arguments=object-required; transition=not-applied`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, operation: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${field} is required.`, `provide a non-empty ${field}; no transition was accepted`, `operation=${operation}; field=${field}; transition=not-applied`);
  }
  return value.trim();
}

function safeIdentifier(value: unknown, field: string, operation: string): string {
  const identifier = requiredString(value, field, operation);
  if (identifier.includes("/") || identifier.includes("\\") || identifier === "." || identifier === "..") {
    return invalid(`${field} must be one safe identifier.`, `remove path separators from ${field} and retry; no transition was accepted`, `operation=${operation}; field=${field}; identifier=safe-required; transition=not-applied`);
  }
  return identifier;
}

function optionalSafeIdentifier(value: unknown, field: string, operation: string): string | undefined {
  return value === undefined ? undefined : safeIdentifier(value, field, operation);
}

function stringList(value: unknown, field: string, operation: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    return invalid(`${field} must be an ${allowEmpty ? "array" : "non-empty array"} of non-empty strings.`, `provide ${field} as a valid string array; no transition was accepted`, `operation=${operation}; field=${field}; stringArray=invalid; transition=not-applied`);
  }
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
}

function requiredStringList(body: Record<string, unknown>, field: string, operation: string, allowEmpty = false): string[] {
  if (body[field] === undefined) return invalid(`${field} is required.`, `provide ${field} as a string array; no transition was accepted`, `operation=${operation}; field=${field}; stringArray=required; transition=not-applied`);
  return stringList(body[field], field, operation, allowEmpty);
}

function expectedVersion(value: unknown, operation: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid("expectedVersion must be a non-negative safe integer.", "read the current Authority version and retry with that expectedVersion; no transition was accepted", `operation=${operation}; expectedVersion=non-negative-safe-integer-required; transition=not-applied`);
  }
  return value;
}

function assertAllowed(body: Record<string, unknown>, allowed: readonly string[], operation: string): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) return invalid(`Field ${unknown} is not accepted by this typed route.`, `remove ${unknown} and send only the documented ${operation} fields; no transition was accepted`, `operation=${operation}; field=${unknown}; transition=not-applied`);
}

function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[], operation: string): T {
  const parsed = requiredString(value, field, operation) as T;
  if (!allowed.includes(parsed)) return invalid(`${field} ${parsed} is unsupported.`, `use one of ${allowed.join(", ")}; no transition was accepted`, `operation=${operation}; field=${field}; value=${parsed}; transition=not-applied`);
  return parsed;
}

function disclosure(value: unknown, operation: string): { projectionId: string; classification: DisclosureClassification } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("disclosure must be an object.", "provide disclosure.projectionId and disclosure.classification; no transition was accepted", `operation=${operation}; disclosure=object-required; transition=not-applied`);
  const body = value as Record<string, unknown>;
  assertAllowed(body, ["projectionId", "classification"], operation);
  const classification = enumValue(body.classification, "disclosure.classification", ["public", "project", "restricted"] as const, operation);
  return { projectionId: safeIdentifier(body.projectionId, "disclosure.projectionId", operation), classification };
}

export type TypedMutation = {
  command: typeof RUN_RECORD_COMMAND | typeof EVIDENCE_RECORD_COMMAND;
  idempotencyKey: string;
  expectedVersion?: number;
  payload: Record<string, unknown>;
};

export function runRecordCommand(value: unknown): TypedMutation {
  const operation = RUN_RECORD_COMMAND;
  const body = objectBody(value, operation);
  assertAllowed(body, ["idempotencyKey", "expectedVersion", "projectId", "runId", "actionId", "projectRevisionId", "projectViewId", "runnerId", "status", "outputDigest", "changeRevisionId", "workspaceId", "inputDigests", "outputDigests"], operation);
  const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey", operation);
  const version = expectedVersion(body.expectedVersion, operation);
  const projectId = safeIdentifier(body.projectId, "projectId", operation);
  const runId = optionalSafeIdentifier(body.runId, "runId", operation);
  const actionId = safeIdentifier(body.actionId, "actionId", operation);
  const projectRevisionId = safeIdentifier(body.projectRevisionId, "projectRevisionId", operation);
  const projectViewId = safeIdentifier(body.projectViewId, "projectViewId", operation);
  const runnerId = safeIdentifier(body.runnerId, "runnerId", operation);
  const status = enumValue(body.status, "status", ["queued", "running", "succeeded", "failed", "indeterminate"] as readonly RunStatus[], operation);
  const outputDigest = body.outputDigest === undefined ? undefined : requiredString(body.outputDigest, "outputDigest", operation);
  const changeRevisionId = safeIdentifier(body.changeRevisionId, "changeRevisionId", operation);
  const workspaceId = safeIdentifier(body.workspaceId, "workspaceId", operation);
  const inputDigests = body.inputDigests === undefined ? undefined : stringList(body.inputDigests, "inputDigests", operation, true);
  const outputDigests = body.outputDigests === undefined ? undefined : stringList(body.outputDigests, "outputDigests", operation, true);
  return { command: operation, idempotencyKey, ...(version === undefined ? {} : { expectedVersion: version }), payload: { projectId, ...(runId ? { runId } : {}), actionId, projectRevisionId, projectViewId, runnerId, status, ...(outputDigest ? { outputDigest } : {}), changeRevisionId, workspaceId, ...(inputDigests ? { inputDigests } : {}), ...(outputDigests ? { outputDigests } : {}) } };
}

export function evidenceRecordCommand(value: unknown): TypedMutation {
  const operation = EVIDENCE_RECORD_COMMAND;
  const body = objectBody(value, operation);
  assertAllowed(body, ["idempotencyKey", "expectedVersion", "projectId", "evidenceId", "runId", "key", "criterion", "outcome", "validityKey", "actionId", "verifierId", "toolchainDigest", "dependencyDigest", "environmentDigest", "inputDigests", "effectDigests", "outputDigest", "projectRevisionId", "projectViewId", "changeRevisionId", "runnerId", "policyVersion", "authorizationEpoch", "capabilityGrantId", "disclosure", "receipt", "invalidators", "owner", "targetId", "workspaceId"], operation);
  const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey", operation);
  const version = expectedVersion(body.expectedVersion, operation);
  const projectId = safeIdentifier(body.projectId, "projectId", operation);
  const evidenceId = optionalSafeIdentifier(body.evidenceId, "evidenceId", operation);
  const runId = safeIdentifier(body.runId, "runId", operation);
  const key = requiredString(body.key, "key", operation);
  const criterion = requiredString(body.criterion, "criterion", operation);
  const outcome = enumValue(body.outcome, "outcome", ["passed", "failed", "stale", "indeterminate"] as readonly EvidenceOutcome[], operation);
  const validityKey = requiredString(body.validityKey, "validityKey", operation);
  const actionId = safeIdentifier(body.actionId, "actionId", operation);
  const verifierId = safeIdentifier(body.verifierId, "verifierId", operation);
  const toolchainDigest = requiredString(body.toolchainDigest, "toolchainDigest", operation);
  const dependencyDigest = requiredString(body.dependencyDigest, "dependencyDigest", operation);
  const environmentDigest = requiredString(body.environmentDigest, "environmentDigest", operation);
  const inputDigests = requiredStringList(body, "inputDigests", operation, true);
  const effectDigests = requiredStringList(body, "effectDigests", operation, true);
  const outputDigest = requiredString(body.outputDigest, "outputDigest", operation);
  const projectRevisionId = safeIdentifier(body.projectRevisionId, "projectRevisionId", operation);
  const projectViewId = safeIdentifier(body.projectViewId, "projectViewId", operation);
  const changeRevisionId = safeIdentifier(body.changeRevisionId, "changeRevisionId", operation);
  const runnerId = safeIdentifier(body.runnerId, "runnerId", operation);
  const policyVersion = requiredString(body.policyVersion, "policyVersion", operation);
  const authorizationEpoch = requiredString(body.authorizationEpoch, "authorizationEpoch", operation);
  const capabilityGrantId = safeIdentifier(body.capabilityGrantId, "capabilityGrantId", operation);
  const disclosureValue = disclosure(body.disclosure, operation);
  const receipt = requiredString(body.receipt, "receipt", operation);
  const invalidators = requiredStringList(body, "invalidators", operation, true);
  const owner = requiredString(body.owner, "owner", operation);
  const targetId = optionalSafeIdentifier(body.targetId, "targetId", operation);
  const workspaceId = safeIdentifier(body.workspaceId, "workspaceId", operation);
  return {
    command: operation,
    idempotencyKey,
    ...(version === undefined ? {} : { expectedVersion: version }),
    payload: {
      projectId,
      ...(evidenceId ? { evidenceId } : {}),
      runId,
      key,
      criterion,
      outcome,
      validityKey,
      actionId,
      verifierId,
      toolchainDigest,
      dependencyDigest,
      environmentDigest,
      inputDigests,
      effectDigests,
      outputDigest,
      projectRevisionId,
      projectViewId,
      changeRevisionId,
      runnerId,
      policyVersion,
      authorizationEpoch,
      capabilityGrantId,
      disclosure: disclosureValue,
      receipt,
      invalidators,
      owner,
      ...(targetId ? { targetId } : {}),
      workspaceId,
    },
  };
}

function valueRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`coordinator_${field}_malformed`);
  return value as Record<string, unknown>;
}

function valueString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`coordinator_${field}_malformed`);
  return value;
}

function valueOptionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : valueString(value, field);
}

function valueStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new Error(`coordinator_${field}_malformed`);
  return [...(value as string[])];
}

function valueInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`coordinator_${field}_malformed`);
  return value;
}

function safeRun(value: unknown): Record<string, unknown> {
  const run = valueRecord(value, "run");
  return {
    protocol: valueString(run.protocol, "run.protocol"),
    id: valueString(run.id, "run.id"),
    actionId: valueString(run.actionId, "run.actionId"),
    projectRevisionId: valueString(run.projectRevisionId, "run.projectRevisionId"),
    projectViewId: valueString(run.projectViewId, "run.projectViewId"),
    runnerId: valueString(run.runnerId, "run.runnerId"),
    status: valueString(run.status, "run.status"),
    ...(valueOptionalString(run.outputDigest, "run.outputDigest") ? { outputDigest: valueOptionalString(run.outputDigest, "run.outputDigest") } : {}),
    ...(valueOptionalString(run.changeRevisionId, "run.changeRevisionId") ? { changeRevisionId: valueOptionalString(run.changeRevisionId, "run.changeRevisionId") } : {}),
    ...(valueOptionalString(run.workspaceId, "run.workspaceId") ? { workspaceId: valueOptionalString(run.workspaceId, "run.workspaceId") } : {}),
    ...(run.inputDigests === undefined ? {} : { inputDigests: valueStringList(run.inputDigests, "run.inputDigests") }),
    ...(run.outputDigests === undefined ? {} : { outputDigests: valueStringList(run.outputDigests, "run.outputDigests") }),
  };
}

function safeEvidence(value: unknown): Record<string, unknown> {
  const evidence = valueRecord(value, "evidence");
  const disclosureValue = valueRecord(evidence.disclosure, "evidence.disclosure");
  return {
    protocol: valueString(evidence.protocol, "evidence.protocol"),
    version: valueString(evidence.version, "evidence.version"),
    id: valueString(evidence.id, "evidence.id"),
    key: valueString(evidence.key, "evidence.key"),
    criterion: valueString(evidence.criterion, "evidence.criterion"),
    outcome: valueString(evidence.outcome, "evidence.outcome"),
    validityKey: valueString(evidence.validityKey, "evidence.validityKey"),
    actionId: valueString(evidence.actionId, "evidence.actionId"),
    verifierId: valueString(evidence.verifierId, "evidence.verifierId"),
    projectRevisionId: valueString(evidence.projectRevisionId, "evidence.projectRevisionId"),
    projectViewId: valueString(evidence.projectViewId, "evidence.projectViewId"),
    ...(valueOptionalString(evidence.changeRevisionId, "evidence.changeRevisionId") ? { changeRevisionId: valueOptionalString(evidence.changeRevisionId, "evidence.changeRevisionId") } : {}),
    runId: valueString(evidence.runId, "evidence.runId"),
    runnerId: valueString(evidence.runnerId, "evidence.runnerId"),
    ...(valueOptionalString(evidence.targetId, "evidence.targetId") ? { targetId: valueOptionalString(evidence.targetId, "evidence.targetId") } : {}),
    ...(valueOptionalString(evidence.workspaceId, "evidence.workspaceId") ? { workspaceId: valueOptionalString(evidence.workspaceId, "evidence.workspaceId") } : {}),
    disclosure: { projectionId: valueString(disclosureValue.projectionId, "evidence.disclosure.projectionId"), classification: valueString(disclosureValue.classification, "evidence.disclosure.classification") },
    authorizationEpoch: valueString(evidence.authorizationEpoch, "evidence.authorizationEpoch"),
    createdAt: valueString(evidence.createdAt, "evidence.createdAt"),
  };
}

function mutationResult(result: Record<string, unknown>, operation: string, idempotencyKey: string): { status: string; version: number; value: Record<string, unknown> } {
  const value = valueRecord(result.value, "value");
  return { status: valueString(result.status, "status"), version: valueInteger(result.version, "version"), value };
}

export function runRecordValue(result: Record<string, unknown>, idempotencyKey: string): Record<string, unknown> {
  const parsed = mutationResult(result, RUN_RECORD_COMMAND, idempotencyKey);
  return { protocol: AUTHORITY_PLANE_PROTOCOL, status: parsed.status, version: parsed.version, idempotencyKey, credentialFree: true, canonicalWrite: false, run: safeRun(parsed.value.run), receipt: `operation=${RUN_RECORD_COMMAND}; typedMcp=true; credentialFree=true; canonicalWrite=false; authorityResult=projected` };
}

export function evidenceRecordValue(result: Record<string, unknown>, idempotencyKey: string): Record<string, unknown> {
  const parsed = mutationResult(result, EVIDENCE_RECORD_COMMAND, idempotencyKey);
  return { protocol: AUTHORITY_PLANE_PROTOCOL, status: parsed.status, version: parsed.version, idempotencyKey, credentialFree: true, canonicalWrite: false, evidence: safeEvidence(parsed.value.evidence), receipt: `operation=${EVIDENCE_RECORD_COMMAND}; typedMcp=true; credentialFree=true; canonicalWrite=false; authorityResult=projected` };
}
