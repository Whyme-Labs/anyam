import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  type Artifact,
  type Evidence,
  type ReleaseInputSet,
} from "../kernel/contracts.ts";

export class ReleaseInputError extends Error {
  readonly code: "missing" | "mismatch" | "invalid";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: ReleaseInputError["code"]; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "ReleaseInputError";
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

function fail(input: ConstructorParameters<typeof ReleaseInputError>[0]): never {
  throw new ReleaseInputError(input);
}

function required(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail({ code: "missing", message: `Release input ${field} is missing.`, recoveryAction: `record the exact ${field} before creating or promoting a Release`, receipt: `inputClosure=${field}-missing` });
  }
  return value.trim();
}

function normalizeDigests(values: readonly string[]): readonly string[] {
  if (values.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    fail({ code: "invalid", message: "Release input Artifact digests must be non-empty strings.", recoveryAction: "record every exact Artifact digest before creating the Release", receipt: "inputClosure=artifact-digest-invalid" });
  }
  const normalized = values.map((value) => value.trim());
  return normalized;
}

export function createReleaseInputSet(input: {
  buildDefinitionDigest: string;
  dependencyDigest: string;
  toolchainDigest: string;
  environmentDigest: string;
  artifactDigests: readonly string[];
}): ReleaseInputSet {
  const body = {
    protocol: CONTRACT_VERSIONS.releaseInput,
    buildDefinitionDigest: required(input.buildDefinitionDigest, "buildDefinitionDigest"),
    dependencyDigest: required(input.dependencyDigest, "dependencyDigest"),
    toolchainDigest: required(input.toolchainDigest, "toolchainDigest"),
    environmentDigest: required(input.environmentDigest, "environmentDigest"),
    artifactDigests: normalizeDigests(input.artifactDigests),
  };
  return { ...body, inputClosureDigest: digest(body) };
}

function commonEvidenceDigest(evidence: readonly Evidence[], field: "dependencyDigest" | "toolchainDigest" | "environmentDigest"): string {
  if (evidence.length === 0) {
    fail({ code: "missing", message: `Release input ${field} cannot be derived without Evidence.`, recoveryAction: "attach passed Evidence from the exact Release build before creating a ready Release", receipt: `inputClosure=${field}-not-observed; evidence=0` });
  }
  const values = [...new Set(evidence.map((record) => record[field]))];
  if (values.length !== 1) {
    fail({ code: "mismatch", message: `Release Evidence has mismatched ${field} values.`, recoveryAction: `rerun the required Verifiers with one ${field} closure and retry Release creation`, receipt: `inputClosure=${field}-mismatch; values=${values.join(",")}` });
  }
  return required(values[0], field);
}

export function deriveReleaseInputSet(input: {
  configurationDigests: readonly string[];
  artifacts: readonly Artifact[];
  evidence: readonly Evidence[];
}): ReleaseInputSet {
  if (input.configurationDigests.length === 0) {
    fail({ code: "missing", message: "Release has no build-definition configuration digest.", recoveryAction: "record the exact manifest/build-definition digest before creating a ready Release", receipt: "inputClosure=buildDefinitionDigest-missing" });
  }
  const buildDefinitionDigest = input.configurationDigests.length === 1
    ? required(input.configurationDigests[0], "buildDefinitionDigest")
    : digest({ configurationDigests: input.configurationDigests });
  return createReleaseInputSet({
    buildDefinitionDigest,
    dependencyDigest: commonEvidenceDigest(input.evidence, "dependencyDigest"),
    toolchainDigest: commonEvidenceDigest(input.evidence, "toolchainDigest"),
    environmentDigest: commonEvidenceDigest(input.evidence, "environmentDigest"),
    artifactDigests: input.artifacts.map((artifact) => artifact.digest),
  });
}

export function assertReleaseInputSetMatches(input: {
  inputSet: ReleaseInputSet;
  configurationDigests: readonly string[];
  artifacts: readonly Artifact[];
  evidence: readonly Evidence[];
}): void {
  const expected = deriveReleaseInputSet(input);
  if (input.inputSet.protocol !== CONTRACT_VERSIONS.releaseInput || input.inputSet.inputClosureDigest !== expected.inputClosureDigest) {
    fail({ code: "mismatch", message: "Release input closure digest does not match the exact Artifacts, Evidence, and build inputs.", recoveryAction: "rebuild the Release input set from the exact passed Evidence and Artifact digests", receipt: `inputClosure=mismatch; expected=${expected.inputClosureDigest}; received=${input.inputSet.inputClosureDigest}` });
  }
  if (input.inputSet.buildDefinitionDigest !== expected.buildDefinitionDigest || input.inputSet.dependencyDigest !== expected.dependencyDigest || input.inputSet.toolchainDigest !== expected.toolchainDigest || input.inputSet.environmentDigest !== expected.environmentDigest || input.inputSet.artifactDigests.some((value, index) => value !== expected.artifactDigests[index]) || input.inputSet.artifactDigests.length !== expected.artifactDigests.length) {
    fail({ code: "mismatch", message: "Release input closure fields do not match the exact build inputs.", recoveryAction: "record one complete input closure for the selected Artifacts and passed Evidence", receipt: `inputClosure=fields-mismatch; expected=${expected.inputClosureDigest}; received=${input.inputSet.inputClosureDigest}` });
  }
}
