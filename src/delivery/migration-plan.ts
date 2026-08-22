import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  type MigrationCompatibility,
  type MigrationPlan,
  type MigrationRollback,
  type MigrationStrategy,
} from "../kernel/contracts.ts";

export class MigrationPlanError extends Error {
  readonly code: "invalid" | "incomplete" | "incompatible";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: MigrationPlanError["code"]; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "MigrationPlanError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function fail(input: ConstructorParameters<typeof MigrationPlanError>[0]): never {
  throw new MigrationPlanError(input);
}

function nonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail({ code: "invalid", message: `${field} must be a non-empty digest or identity.`, recoveryAction: `record a non-empty ${field} and retry`, receipt: `migration=${field}-missing` });
  return value.trim();
}

function unique(values: readonly string[], field: string): readonly string[] {
  if (values.some((value) => typeof value !== "string" || value.trim().length === 0)) fail({ code: "invalid", message: `${field} must contain only non-empty strings.`, recoveryAction: `repair ${field} and retry`, receipt: `migration=${field}-invalid` });
  const normalized = values.map((value) => value.trim());
  if (new Set(normalized).size !== normalized.length) fail({ code: "invalid", message: `${field} contains duplicate entries.`, recoveryAction: `remove duplicate ${field} entries and retry`, receipt: `migration=${field}-duplicate` });
  return normalized;
}

export function createMigrationPlan(input: {
  strategy?: MigrationStrategy;
  beforeSchemaDigest?: string;
  afterSchemaDigest?: string;
  compatibility?: MigrationCompatibility;
  rollback?: MigrationRollback;
  migrationArtifactIds?: readonly string[];
  requiredEvidenceKeys?: readonly string[];
  planDigest?: string;
}): MigrationPlan {
  const strategy = input.strategy ?? "none";
  const compatibility = input.compatibility ?? (strategy === "none" ? "backward-compatible" : "unknown");
  const rollback = input.rollback ?? (strategy === "none" ? "safe" : "blocked");
  const migrationArtifactIds = unique(input.migrationArtifactIds ?? [], "migrationArtifactIds");
  const requiredEvidenceKeys = unique(input.requiredEvidenceKeys ?? [], "requiredEvidenceKeys");
  if (strategy === "none" && (migrationArtifactIds.length > 0 || requiredEvidenceKeys.length > 0)) fail({ code: "invalid", message: "A no-migration plan cannot require migration Artifacts or Evidence.", recoveryAction: "use a migration strategy or clear migration-specific inputs", receipt: "migration=strategy-none; migrationInputs=unexpected" });
  if (strategy === "expand-contract" && (input.beforeSchemaDigest === undefined || input.afterSchemaDigest === undefined || compatibility !== "bidirectional")) fail({ code: "incomplete", message: "Expand/contract migration requires before and after schema digests plus bidirectional compatibility.", recoveryAction: "record both schema digests and prove old/new versions can overlap", receipt: `migration=strategy-expand-contract; before=${input.beforeSchemaDigest ? "present" : "missing"}; after=${input.afterSchemaDigest ? "present" : "missing"}; compatibility=${compatibility}` });
  const body = {
    protocol: CONTRACT_VERSIONS.migration,
    strategy,
    ...(input.beforeSchemaDigest ? { beforeSchemaDigest: nonEmpty(input.beforeSchemaDigest, "beforeSchemaDigest") } : {}),
    ...(input.afterSchemaDigest ? { afterSchemaDigest: nonEmpty(input.afterSchemaDigest, "afterSchemaDigest") } : {}),
    compatibility,
    rollback,
    migrationArtifactIds,
    requiredEvidenceKeys,
  } satisfies Omit<MigrationPlan, "planDigest">;
  const planDigest = digest(body);
  if (input.planDigest !== undefined && input.planDigest !== planDigest) fail({ code: "invalid", message: "Migration Plan digest does not match its fields.", recoveryAction: "recompute planDigest from the normalized migration plan and retry", receipt: `migration=plan-digest-mismatch; expected=${planDigest}; received=${input.planDigest}` });
  return { ...body, planDigest };
}

export function defaultMigrationPlan(): MigrationPlan {
  return createMigrationPlan({ strategy: "none" });
}

export function assertMigrationPlanSafeForTarget(input: { plan: MigrationPlan; environment: string }): void {
  const normalized = createMigrationPlan(input.plan);
  if (input.environment !== "production") return;
  if (normalized.compatibility === "unknown" || normalized.compatibility === "incompatible") fail({ code: "incompatible", message: `Production Target cannot consume migration compatibility ${normalized.compatibility}.`, recoveryAction: "prove compatibility with the required migration Verifiers or keep the Release out of production", receipt: `migration=production-blocked; compatibility=${normalized.compatibility}; planDigest=${normalized.planDigest}` });
  if (normalized.rollback === "blocked") fail({ code: "incompatible", message: "Production Target cannot consume a Release with blocked data rollback behavior.", recoveryAction: "provide a manual data recovery runbook or select a Release with a supported rollback mode", receipt: `migration=production-blocked; rollback=blocked; planDigest=${normalized.planDigest}` });
}
