/**
 * Receipt-backed production-operation evidence.
 *
 * This module records observations; it does not run provider drills, invent
 * SLOs, or turn a fixture into a production claim. A Realm becomes ready only
 * when every required drill has a verified, evidence-linked receipt.
 */

import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, scanCredentialMaterial } from "../security/credential-material.ts";

export const PRODUCTION_OPERATIONS_PROTOCOL = "anyam.production-operations/v1" as const;

export const PRODUCTION_OPERATIONS_REQUIRED_DRILLS = [
  "sustained-load",
  "queue-recovery",
  "durable-object-contention",
  "backup-restore",
  "key-rotation",
  "auth-throttling",
  "incident-alerting",
] as const;

export type OperationalDrillKind = (typeof PRODUCTION_OPERATIONS_REQUIRED_DRILLS)[number];
export type OperationalDrillStatus = "verified" | "failed" | "indeterminate";
export type OperationalObservationValue = string | number | boolean | null;
export type OperationalObservations = Readonly<Record<string, OperationalObservationValue>>;

export type OperationalDrillReceipt = {
  readonly protocol: typeof PRODUCTION_OPERATIONS_PROTOCOL;
  readonly id: string;
  readonly kind: OperationalDrillKind;
  readonly status: OperationalDrillStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly observations: OperationalObservations;
  readonly evidenceRefs: readonly string[];
  readonly recoveryAction: string;
  readonly receipt: string;
  readonly credentialFree: true;
  readonly providerFactsAreNotAnyamLimits: true;
};

export type OperationalDrillInput = Omit<OperationalDrillReceipt, "protocol" | "credentialFree" | "providerFactsAreNotAnyamLimits">;

export type ProductionOperationsReadinessState = "ready" | "blocked" | "indeterminate";

export type ProductionOperationsReadiness = {
  readonly protocol: typeof PRODUCTION_OPERATIONS_PROTOCOL;
  readonly status: ProductionOperationsReadinessState;
  readonly requiredKinds: readonly OperationalDrillKind[];
  readonly verifiedKinds: readonly OperationalDrillKind[];
  readonly missingKinds: readonly OperationalDrillKind[];
  readonly failedKinds: readonly OperationalDrillKind[];
  readonly indeterminateKinds: readonly OperationalDrillKind[];
  readonly recoveryAction: string;
  readonly receipt: string;
  readonly credentialFree: true;
  readonly providerFactsAreNotAnyamLimits: true;
};

export type ProductionOperationsLedgerSnapshot = {
  readonly protocol: typeof PRODUCTION_OPERATIONS_PROTOCOL;
  readonly receipts: readonly OperationalDrillReceipt[];
  readonly credentialFree: true;
};

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,200}$/u;

function fail(message: string): never {
  throw new Error(message);
}

function nonEmpty(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) fail(`${field}_required`);
  return value.trim();
}

function safeId(value: string, field: string): string {
  const normalized = nonEmpty(value, field);
  if (!SAFE_ID_PATTERN.test(normalized)) fail(`${field}_invalid`);
  return normalized;
}

function timestamp(value: string, field: string): string {
  const normalized = nonEmpty(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(normalized) || Number.isNaN(Date.parse(normalized))) fail(`${field}_invalid`);
  return normalized;
}

function drillKind(value: string): OperationalDrillKind {
  if (isOperationalDrillKind(value)) return value;
  return fail("production_operations_drill_kind_invalid");
}

function isOperationalDrillKind(value: string): value is OperationalDrillKind {
  return PRODUCTION_OPERATIONS_REQUIRED_DRILLS.some((kind) => kind === value);
}

function drillStatus(value: string): OperationalDrillStatus {
  if (value === "verified" || value === "failed" || value === "indeterminate") return value;
  return fail("production_operations_drill_status_invalid");
}

function assertCredentialFree(value: unknown, location: string): void {
  const finding = scanCredentialMaterial(value, location);
  if (finding) fail(`credential_material_forbidden:${finding.path};scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}`);
}

function observationRecord(value: OperationalObservations): OperationalObservations {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("production_operations_observations_object_required");
  assertCredentialFree(value, "observations");
  for (const [key, nested] of Object.entries(value)) {
    if (!SAFE_ID_PATTERN.test(key)) fail(`production_operations_observation_key_invalid:${key}`);
    if (nested !== null && typeof nested !== "string" && typeof nested !== "number" && typeof nested !== "boolean") fail(`production_operations_observation_value_invalid:${key}`);
    if (typeof nested === "number" && !Number.isFinite(nested)) fail(`production_operations_observation_value_invalid:${key}`);
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function cloneReceipt(receipt: OperationalDrillReceipt): OperationalDrillReceipt {
  return { ...receipt, observations: { ...receipt.observations }, evidenceRefs: [...receipt.evidenceRefs] };
}

function receiptFields(receipt: OperationalDrillReceipt): OperationalDrillInput {
  return {
    id: receipt.id,
    kind: receipt.kind,
    status: receipt.status,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    observations: receipt.observations,
    evidenceRefs: receipt.evidenceRefs,
    recoveryAction: receipt.recoveryAction,
    receipt: receipt.receipt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObservationValue(value: unknown): value is OperationalObservationValue {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function isObservations(value: unknown): value is OperationalObservations {
  return isRecord(value) && Object.values(value).every(isObservationValue);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function inputFromUnknown(value: unknown): OperationalDrillInput {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.kind !== "string"
    || typeof value.status !== "string"
    || typeof value.startedAt !== "string"
    || typeof value.finishedAt !== "string"
    || !isObservations(value.observations)
    || !isStringArray(value.evidenceRefs)
    || typeof value.recoveryAction !== "string"
    || typeof value.receipt !== "string") {
    return fail("production_operations_receipt_shape_invalid");
  }
  if (!isOperationalDrillKind(value.kind)) return fail("production_operations_drill_kind_invalid");
  if (value.status !== "verified" && value.status !== "failed" && value.status !== "indeterminate") return fail("production_operations_drill_status_invalid");
  return {
    id: value.id,
    kind: value.kind,
    status: value.status,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    observations: value.observations,
    evidenceRefs: value.evidenceRefs,
    recoveryAction: value.recoveryAction,
    receipt: value.receipt,
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stable(nested)]));
}

function isSnapshot(value: ProductionOperationsLedgerSnapshot | readonly OperationalDrillReceipt[]): value is ProductionOperationsLedgerSnapshot {
  return !Array.isArray(value);
}

function comparable(receipt: OperationalDrillReceipt): string {
  return JSON.stringify(stable(receipt));
}

function normalizeReceipt(input: OperationalDrillInput): OperationalDrillReceipt {
  const startedAt = timestamp(input.startedAt, "production_operations_startedAt");
  const finishedAt = timestamp(input.finishedAt, "production_operations_finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) fail("production_operations_time_order_invalid");
  const kind = drillKind(input.kind);
  const status = drillStatus(input.status);
  const evidenceRefs = input.evidenceRefs.map((value, index) => safeId(value, `production_operations_evidenceRefs[${index}]`));
  if (status === "verified" && evidenceRefs.length === 0) fail("production_operations_verified_evidence_required");
  const recoveryAction = nonEmpty(input.recoveryAction, "production_operations_recoveryAction");
  const receipt = nonEmpty(input.receipt, "production_operations_receipt");
  assertCredentialFree(input.observations, "observations");
  assertCredentialFree(input.evidenceRefs, "evidenceRefs");
  assertCredentialFree(input.recoveryAction, "recoveryAction");
  assertCredentialFree(input.receipt.replaceAll("credentialFree", ""), "receipt");
  return {
    protocol: PRODUCTION_OPERATIONS_PROTOCOL,
    id: safeId(input.id, "production_operations_id"),
    kind,
    status,
    startedAt,
    finishedAt,
    observations: observationRecord(input.observations),
    evidenceRefs,
    recoveryAction,
    receipt,
    credentialFree: true,
    providerFactsAreNotAnyamLimits: true,
  };
}

export class ProductionOperationsLedger {
  private readonly records = new Map<string, OperationalDrillReceipt>();

  constructor(snapshot: ProductionOperationsLedgerSnapshot | readonly OperationalDrillReceipt[] = []) {
    const receipts = isSnapshot(snapshot) ? snapshot.receipts : snapshot;
    for (const receipt of receipts) {
      const normalized = normalizeReceipt(receiptFields(receipt));
      const existing = this.records.get(normalized.id);
      if (existing && comparable(existing) !== comparable(normalized)) fail(`production_operations_receipt_conflict:${normalized.id}`);
      this.records.set(normalized.id, normalized);
    }
  }

  async record(input: OperationalDrillInput): Promise<OperationalDrillReceipt> {
    const normalized = normalizeReceipt(input);
    const existing = this.records.get(normalized.id);
    if (existing) {
      if (comparable(existing) !== comparable(normalized)) fail(`production_operations_receipt_conflict:${normalized.id}`);
      return cloneReceipt(existing);
    }
    this.records.set(normalized.id, normalized);
    return cloneReceipt(normalized);
  }

  list(): readonly OperationalDrillReceipt[] {
    return [...this.records.values()].sort((left, right) => left.id.localeCompare(right.id)).map(cloneReceipt);
  }

  evaluate(): ProductionOperationsReadiness {
    const latestByKind = new Map<OperationalDrillKind, OperationalDrillReceipt>();
    for (const receipt of this.records.values()) {
      const current = latestByKind.get(receipt.kind);
      if (!current || receipt.finishedAt > current.finishedAt) latestByKind.set(receipt.kind, receipt);
    }
    const verifiedKinds: OperationalDrillKind[] = [];
    const missingKinds: OperationalDrillKind[] = [];
    const failedKinds: OperationalDrillKind[] = [];
    const indeterminateKinds: OperationalDrillKind[] = [];
    for (const kind of PRODUCTION_OPERATIONS_REQUIRED_DRILLS) {
      const receipt = latestByKind.get(kind);
      if (!receipt) missingKinds.push(kind);
      else if (receipt.status === "verified") verifiedKinds.push(kind);
      else if (receipt.status === "failed") failedKinds.push(kind);
      else indeterminateKinds.push(kind);
    }
    const status: ProductionOperationsReadinessState = failedKinds.length > 0
      ? "blocked"
      : missingKinds.length > 0 || indeterminateKinds.length > 0
        ? "indeterminate"
        : "ready";
    const blockers = [
      ...failedKinds.map((kind) => `${kind}=failed`),
      ...indeterminateKinds.map((kind) => `${kind}=indeterminate`),
      ...missingKinds.map((kind) => `${kind}=missing`),
    ];
    return {
      protocol: PRODUCTION_OPERATIONS_PROTOCOL,
      status,
      requiredKinds: [...PRODUCTION_OPERATIONS_REQUIRED_DRILLS],
      verifiedKinds,
      missingKinds,
      failedKinds,
      indeterminateKinds,
      recoveryAction: blockers.length === 0 ? "No recovery action is currently required." : `Collect or repair the named production-operation receipts before activation: ${blockers.join(", ")}.`,
      receipt: `operations=${status}; verified=${verifiedKinds.length}; missing=${missingKinds.length}; failed=${failedKinds.length}; indeterminate=${indeterminateKinds.length}; credentialFree=true`,
      credentialFree: true,
      providerFactsAreNotAnyamLimits: true,
    };
  }

  snapshot(): ProductionOperationsLedgerSnapshot {
    return { protocol: PRODUCTION_OPERATIONS_PROTOCOL, receipts: this.list(), credentialFree: true };
  }
}

export function parseProductionOperationsLedger(value: string | undefined): ProductionOperationsLedger {
  if (!value || value.trim().length === 0) return new ProductionOperationsLedger();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("production_operations_ledger_json_invalid");
  }
  if (!isRecord(parsed)) fail("production_operations_ledger_object_required");
  const record = parsed;
  if (record.protocol !== PRODUCTION_OPERATIONS_PROTOCOL || !Array.isArray(record.receipts)) fail("production_operations_ledger_protocol_invalid");
  const receipts = record.receipts.map(inputFromUnknown).map(normalizeReceipt);
  return new ProductionOperationsLedger(receipts);
}
