import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  opaqueId,
  type ActorRef,
  type DisclosureClassification,
  type DisclosurePolicyRef,
  type Run,
  type RunnerAttempt,
  type RunnerAttemptState,
  type RunnerEvent,
  type RunnerJob,
  type RunnerJobState,
  type RunnerOutputKind,
  type RunnerOutputLocations,
  type RunnerOutputReference,
  type RunnerProfile,
  type RunnerStatus,
} from "../kernel/contracts.ts";
import type { NormalizedActionInput, NormalizedActionOutput } from "./local.ts";

type JsonRecord = Record<string, unknown>;

export type RunnerEnrollmentInput = {
  id: string;
  provider: string;
  publicKey: string;
  platform: RunnerProfile["platform"];
  capabilities: readonly string[];
  networkDestinations: readonly string[];
  secretUse: RunnerProfile["secretUse"];
  canUploadArtifacts: boolean;
  canUploadEvidence: boolean;
  approvedBy: ActorRef;
  enrollmentReceipt: string;
};

export type ExternalRunRequest = {
  idempotencyKey: string;
  actionInput: NormalizedActionInput;
  runnerRequirements: readonly string[];
  secretUseAliases?: readonly string[];
  outputLocations: RunnerOutputLocations;
  leaseExpiresAt: string;
};

export type RunnerJobCredential = {
  id: string;
  audience: "runner-job";
  jobId: string;
  attemptId: string;
  runnerId: string;
  expiresAt: string;
  token: string;
};

export type RunnerJobOffer = {
  job: RunnerJob;
  attempt: RunnerAttempt;
  challenge: string;
  receipt: string;
};

export type RunnerJobLease = {
  job: RunnerJob;
  attempt: RunnerAttempt;
  credential: RunnerJobCredential;
  receipt: string;
};

export type RunnerOutputInput = Omit<RunnerOutputReference, "protocol" | "id" | "runId" | "attemptId"> & {
  id?: string;
  runId?: never;
  attemptId?: never;
};

export type RunnerResult = {
  status: "succeeded" | "failed" | "indeterminate";
  output: NormalizedActionOutput;
  outputs: readonly RunnerOutputInput[];
  /** Immutable context echoed by the Runner and covered by its signature. */
  context: RunnerResultContext;
  recoveryAction?: string;
  signature: string;
};

export type RunnerResultContext = {
  protocol: "anyam.runner-result-context/v1";
  replayId: string;
  jobId: string;
  attemptId: string;
  runnerId: string;
  leaseExpiresAt: string;
  inputManifestDigest: string;
  sourceSpaceSnapshots: Readonly<Record<string, string>>;
  actionId: string;
  actionContractDigest: string;
  verifierId?: string;
  verifierContractDigest?: string;
  projectRevisionId: string;
  projectViewId: string;
  changeRevisionId?: string;
  workspaceId?: string;
  policyVersion: string;
  authorizationEpoch: string;
  capabilityGrantId: string;
};

export type RunnerCompletion = {
  job: RunnerJob;
  attempt: RunnerAttempt;
  run: Run;
  outputs: readonly RunnerOutputReference[];
  resultDigest: string;
  receipt: string;
};

export type RunnerCancellationOutcome = "stopped" | "forced" | "unknown";

export type RunnerCoordinatorInput = {
  realmId: string;
  projectId: string;
  now?: () => string;
};

export type RunnerErrorCode =
  | "invalid-input"
  | "runner-exists"
  | "runner-not-found"
  | "runner-not-eligible"
  | "runner-proof-invalid"
  | "runner-state"
  | "job-not-found"
  | "job-idempotency-conflict"
  | "job-state"
  | "attempt-not-found"
  | "attempt-mismatch"
  | "lease-invalid"
  | "lease-expired"
  | "lease-not-expired"
  | "credential-invalid"
  | "result-signature-invalid"
  | "result-replay"
  | "result-input-mismatch"
  | "result-output-invalid"
  | "result-output-scope"
  | "cancellation-invalid"
  | "retry-invalid";

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly affectedObject: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    code: RunnerErrorCode;
    message: string;
    affectedObject: string;
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "RunnerError";
    this.code = input.code;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

type StoredCredential = {
  id: string;
  digest: string;
  jobId: string;
  attemptId: string;
  runnerId: string;
  expiresAt: string;
  status: "active" | "revoked";
};

type StoredJob = {
  job: RunnerJob;
  run: Run;
  requestDigest: string;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex")}`;
}

function nonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new RunnerError({
      code: "invalid-input",
      message: `${field} must not be empty.`,
      affectedObject: field,
      recoveryAction: `provide a non-empty ${field} and retry`,
      receipt: `field=${field}; present=false`,
    });
  }
}

function unique(values: readonly string[], field: string): readonly string[] {
  if (new Set(values).size !== values.length) {
    throw new RunnerError({
      code: "invalid-input",
      message: `${field} contains duplicate values.`,
      affectedObject: field,
      recoveryAction: `remove duplicate ${field} entries and retry`,
      receipt: `field=${field}; count=${values.length}; unique=${new Set(values).size}`,
    });
  }
  return [...values];
}

function futureTimestamp(value: string, now: string, field: string): void {
  if (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.parse(now)) {
    throw new RunnerError({
      code: "invalid-input",
      message: `${field} must be a valid future timestamp.`,
      affectedObject: field,
      recoveryAction: `set ${field} after the current coordinator time and retry`,
      receipt: `field=${field}; value=${value}; now=${now}`,
    });
  }
}

function arrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function disclosureRank(value: DisclosureClassification): number {
  return value === "public" ? 0 : value === "project" ? 1 : 2;
}

function disclosureAllows(outer: DisclosureClassification, inner: DisclosureClassification): boolean {
  return disclosureRank(inner) <= disclosureRank(outer);
}

function pathFromDigest(value: string): string | undefined {
  const separator = value.lastIndexOf("=");
  return separator > 0 ? value.slice(0, separator) : undefined;
}

function locationWithin(location: string, root: string): boolean {
  return location === root || location.startsWith(`${root.replace(/\/$/, "")}/`);
}

function safeLocation(value: string, field: string, code: RunnerErrorCode = "invalid-input"): string {
  nonEmpty(value, field);
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  const unsafe = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some((segment) => segment === ".." || segment === ".");
  if (unsafe || normalized.length === 0) {
    error({
      code,
      message: `${field} must be a non-empty scoped location without traversal.`,
      affectedObject: field,
      recoveryAction: `use a relative ${field} location below the coordinator-assigned Run output root`,
      receipt: `field=${field}; value=${JSON.stringify(value)}; rule=normalized-no-traversal`,
    });
  }
  return normalized;
}

function normalizeOutputLocations(input: RunnerOutputLocations): RunnerOutputLocations {
  return {
    logs: safeLocation(input.logs, "outputLocations.logs"),
    artifacts: safeLocation(input.artifacts, "outputLocations.artifacts"),
    evidence: safeLocation(input.evidence, "outputLocations.evidence"),
  };
}

function verifyPublicKey(publicKey: string): boolean {
  try {
    createPublicKey(publicKey);
    return true;
  } catch {
    return false;
  }
}

function verifyProof(publicKey: string, message: string, signature: string): boolean {
  try {
    return verifySignature(null, Buffer.from(message), createPublicKey(publicKey), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function credentialDigest(token: string): string {
  return digest(token);
}

function copyProfile(profile: RunnerProfile): RunnerProfile {
  return {
    ...profile,
    platform: { ...profile.platform },
    capabilities: [...profile.capabilities],
    networkDestinations: [...profile.networkDestinations],
  };
}

function copyJob(job: RunnerJob): RunnerJob {
  return {
    ...job,
    sourceSpaceSnapshots: { ...job.sourceSpaceSnapshots },
    inputDigests: [...job.inputDigests],
    outputPaths: [...job.outputPaths],
    effectDigests: [...job.effectDigests],
    actor: { ...job.actor },
    disclosure: { ...job.disclosure },
    runnerRequirements: [...job.runnerRequirements],
    networkDestinations: [...job.networkDestinations],
    secretUseAliases: [...job.secretUseAliases],
    outputLocations: { ...job.outputLocations },
    attemptIds: [...job.attemptIds],
  };
}

function copyAttempt(attempt: RunnerAttempt): RunnerAttempt {
  return { ...attempt };
}

function copyRun(run: Run): Run {
  return {
    ...run,
    ...(run.inputDigests ? { inputDigests: [...run.inputDigests] } : {}),
    ...(run.outputDigests ? { outputDigests: [...run.outputDigests] } : {}),
    ...(run.effectDigests ? { effectDigests: [...run.effectDigests] } : {}),
    ...(run.actor ? { actor: { ...run.actor } } : {}),
  };
}

function copyOutput(output: RunnerOutputReference): RunnerOutputReference {
  return { ...output, disclosure: { ...output.disclosure } };
}

function copyEvent(event: RunnerEvent): RunnerEvent {
  return { ...event, ...(event.actor ? { actor: { ...event.actor } } : {}) };
}

function claimMessage(challenge: string): string {
  return `anyam.runner-claim/v1|${challenge}`;
}

export function runnerResultMessage(input: {
  context: RunnerResultContext;
  status: RunnerResult["status"];
  output: NormalizedActionOutput;
  outputs: readonly RunnerOutputInput[];
  recoveryAction?: string;
}): string {
  return `anyam.runner-result/v1|${stableJson({
    context: input.context,
    status: input.status,
    output: input.output,
    outputs: input.outputs,
    recoveryAction: input.recoveryAction,
  })}`;
}

export function runnerResultContext(input: { job: RunnerJob; attempt: RunnerAttempt }): RunnerResultContext {
  const { job, attempt } = input;
  return {
    protocol: "anyam.runner-result-context/v1",
    replayId: `${job.id}:${attempt.id}`,
    jobId: job.id,
    attemptId: attempt.id,
    runnerId: attempt.runnerId ?? job.currentRunnerId ?? "runner:unassigned",
    leaseExpiresAt: attempt.leaseExpiresAt,
    inputManifestDigest: job.inputManifestDigest,
    sourceSpaceSnapshots: { ...job.sourceSpaceSnapshots },
    actionId: job.actionId,
    actionContractDigest: job.actionContractDigest,
    ...(job.verifierId ? { verifierId: job.verifierId } : {}),
    ...(job.verifierContractDigest ? { verifierContractDigest: job.verifierContractDigest } : {}),
    projectRevisionId: job.projectRevisionId,
    projectViewId: job.projectViewId,
    ...(job.changeRevisionId ? { changeRevisionId: job.changeRevisionId } : {}),
    ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
    policyVersion: job.policyVersion,
    authorizationEpoch: job.authorizationEpoch,
    capabilityGrantId: job.capabilityGrantId,
  };
}

export function runnerInputManifestDigest(input: {
  actionInput: NormalizedActionInput;
  runnerRequirements: readonly string[];
  secretUseAliases: readonly string[];
  outputLocations: RunnerOutputLocations;
}): string {
  return digest({
    actionInput: input.actionInput,
    runnerRequirements: [...input.runnerRequirements],
    secretUseAliases: [...input.secretUseAliases],
    outputLocations: { ...input.outputLocations },
  });
}

function error(input: ConstructorParameters<typeof RunnerError>[0]): never {
  throw new RunnerError(input);
}

export class ExternalRunnerCoordinator {
  private readonly realmId: string;
  private readonly projectId: string;
  private readonly now: () => string;
  private readonly runners = new Map<string, RunnerProfile>();
  private readonly jobs = new Map<string, StoredJob>();
  private readonly attempts = new Map<string, RunnerAttempt>();
  private readonly offers = new Map<string, string>();
  private readonly credentials = new Map<string, StoredCredential>();
  private readonly outputs = new Map<string, RunnerOutputReference[]>();
  private readonly idempotency = new Map<string, string>();
  private readonly retryIdempotency = new Map<string, string>();
  private readonly events: RunnerEvent[] = [];

  constructor(input: RunnerCoordinatorInput) {
    nonEmpty(input.realmId, "realmId");
    nonEmpty(input.projectId, "projectId");
    this.realmId = input.realmId;
    this.projectId = input.projectId;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  getRunner(runnerId: string): RunnerProfile | undefined {
    const runner = this.runners.get(runnerId);
    return runner ? copyProfile(runner) : undefined;
  }

  listRunners(): readonly RunnerProfile[] {
    return [...this.runners.values()].sort((left, right) => left.id.localeCompare(right.id)).map(copyProfile);
  }

  enrollRunner(input: RunnerEnrollmentInput): RunnerProfile {
    nonEmpty(input.id, "runner.id");
    nonEmpty(input.provider, "runner.provider");
    nonEmpty(input.publicKey, "runner.publicKey");
    nonEmpty(input.enrollmentReceipt, "runner.enrollmentReceipt");
    if (!verifyPublicKey(input.publicKey)) {
      error({
        code: "invalid-input",
        message: `Runner ${input.id} supplied an invalid public key.`,
        affectedObject: input.id,
        recoveryAction: "enroll the Runner with a parseable public key and retry",
        receipt: `runner=${input.id}; publicKey=invalid`,
      });
    }
    if (this.runners.has(input.id)) {
      error({
        code: "runner-exists",
        message: `Runner ${input.id} is already enrolled.`,
        affectedObject: input.id,
        recoveryAction: "rotate the existing Runner identity through an explicit replacement operation or choose a new Runner ID",
        receipt: `runner=${input.id}; enrollment=duplicate`,
      });
    }
    const capabilities = unique(input.capabilities, "runner.capabilities");
    const networkDestinations = unique(input.networkDestinations, "runner.networkDestinations");
    const enrolledAt = this.now();
    const profileWithoutDigest: Omit<RunnerProfile, "protocol" | "profileDigest"> = {
      id: input.id,
      realmId: this.realmId,
      provider: input.provider,
      publicKey: input.publicKey,
      platform: { ...input.platform },
      capabilities,
      networkDestinations,
      secretUse: input.secretUse,
      canUploadArtifacts: input.canUploadArtifacts,
      canUploadEvidence: input.canUploadEvidence,
      status: "enrolled",
      enrolledAt,
      updatedAt: enrolledAt,
      receipt: `runner=${input.id}; enrolled=true; approvedBy=${input.approvedBy.actorId}; ${input.enrollmentReceipt}`,
    };
    const profile: RunnerProfile = {
      protocol: CONTRACT_VERSIONS.runner,
      ...profileWithoutDigest,
      profileDigest: digest(profileWithoutDigest),
    };
    this.runners.set(profile.id, profile);
    this.emit({
      type: "runner.enrolled",
      runnerId: profile.id,
      actor: input.approvedBy,
      receipt: profile.receipt,
    });
    return copyProfile(profile);
  }

  activateRunner(runnerId: string, actor: ActorRef): RunnerProfile {
    const runner = this.requireRunner(runnerId);
    if (runner.status !== "enrolled" && runner.status !== "unavailable") {
      error({
        code: "runner-state",
        message: `Runner ${runner.id} is ${runner.status}; only enrolled or unavailable Runners can be activated.`,
        affectedObject: runner.id,
        recoveryAction: "inspect Runner state and activate only an enrolled or recovered Runner",
        receipt: `runner=${runner.id}; state=${runner.status}; required=enrolled|unavailable`,
      });
    }
    runner.status = "active";
    runner.updatedAt = this.now();
    runner.receipt = `runner=${runner.id}; state=active; actor=${actor.actorId}`;
    this.emit({ type: "runner.activated", runnerId: runner.id, actor, receipt: runner.receipt });
    return copyProfile(runner);
  }

  disableRunner(runnerId: string, actor: ActorRef, reason: string): RunnerProfile {
    nonEmpty(reason, "reason");
    const runner = this.requireRunner(runnerId);
    runner.status = "disabled";
    runner.updatedAt = this.now();
    runner.receipt = `runner=${runner.id}; state=disabled; reason=${reason}`;
    this.emit({ type: "runner.disabled", runnerId: runner.id, actor, receipt: runner.receipt });
    return copyProfile(runner);
  }

  enqueue(input: ExternalRunRequest): { job: RunnerJob; run: Run; attempt: RunnerAttempt } {
    nonEmpty(input.idempotencyKey, "idempotencyKey");
    const existingId = this.idempotency.get(input.idempotencyKey);
    const secretUseAliases = unique([...(input.secretUseAliases ?? [])], "secretUseAliases");
    const outputLocations = normalizeOutputLocations(input.outputLocations);
    const requestDigest = runnerInputManifestDigest({
      actionInput: input.actionInput,
      runnerRequirements: input.runnerRequirements,
      secretUseAliases,
      outputLocations,
    });
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (!existing || existing.requestDigest !== requestDigest) {
        error({
          code: "job-idempotency-conflict",
          message: `Runner Job idempotency key ${input.idempotencyKey} was already used for a different input manifest.`,
          affectedObject: input.idempotencyKey,
          recoveryAction: "use a new idempotency key only after checking the existing Run and its immutable input digest",
          receipt: `idempotencyKey=${input.idempotencyKey}; existingJob=${existingId}; requestDigest=${requestDigest}`,
        });
      }
      if (!existing) {
        error({ code: "job-not-found", message: `Runner Job ${existingId} disappeared from the coordinator.`, affectedObject: existingId, recoveryAction: "restore the Run ledger or create a new idempotent job", receipt: `job=${existingId}; record=missing` });
      }
      return { job: copyJob(existing.job), run: copyRun(existing.run), attempt: copyAttempt(this.requireAttempt(existing.job.currentAttemptId)) };
    }
    nonEmpty(input.actionInput.projectRevisionId, "actionInput.projectRevisionId");
    nonEmpty(input.actionInput.projectViewId, "actionInput.projectViewId");
    nonEmpty(input.actionInput.capabilityGrantId, "actionInput.capabilityGrantId");
    nonEmpty(input.actionInput.policyVersion, "actionInput.policyVersion");
    nonEmpty(input.actionInput.authorizationEpoch, "actionInput.authorizationEpoch");
    futureTimestamp(input.leaseExpiresAt, this.now(), "leaseExpiresAt");
    if (input.actionInput.action.network.some((destination) => destination.trim().length === 0)) {
      error({ code: "invalid-input", message: "Action network destinations must be non-empty.", affectedObject: input.actionInput.action.id, recoveryAction: "remove empty network destinations from the Action contract", receipt: `action=${input.actionInput.action.id}; network=invalid` });
    }
    const runnerRequirements = unique(input.runnerRequirements, "runnerRequirements");
    const runId = opaqueId("run");
    const attemptId = opaqueId("runner-attempt");
    const jobId = opaqueId("runner-job");
    const createdAt = this.now();
    const run: Run = {
      protocol: CONTRACT_VERSIONS.run,
      id: runId,
      actionId: input.actionInput.action.id,
      projectRevisionId: input.actionInput.projectRevisionId,
      projectViewId: input.actionInput.projectViewId,
      runnerId: "runner:unassigned",
      attemptId,
      ...(input.actionInput.verifier ? { verifierId: input.actionInput.verifier.id } : {}),
      actionContractDigest: input.actionInput.action.contractDigest,
      ...(input.actionInput.verifier ? { verifierContractDigest: input.actionInput.verifier.contractDigest } : {}),
      status: "queued",
      outputDigest: undefined,
      ...(input.actionInput.changeRevisionId ? { changeRevisionId: input.actionInput.changeRevisionId } : {}),
      ...(input.actionInput.workspaceId ? { workspaceId: input.actionInput.workspaceId } : {}),
      inputDigests: [...input.actionInput.inputDigests],
      effectDigests: [...input.actionInput.effectDigests],
      dependencyDigest: input.actionInput.dependencyDigest,
      toolchainDigest: input.actionInput.toolchainDigest,
      environmentDigest: input.actionInput.environmentDigest,
      policyVersion: input.actionInput.policyVersion,
      ...(input.actionInput.targetId ? { targetId: input.actionInput.targetId } : {}),
      actor: { ...input.actionInput.actor },
      capabilityGrantId: input.actionInput.capabilityGrantId,
    };
    const job: RunnerJob = {
      protocol: CONTRACT_VERSIONS.runnerJob,
      id: jobId,
      projectId: this.projectId,
      runId,
      actionId: input.actionInput.action.id,
      actionContractDigest: input.actionInput.action.contractDigest,
      ...(input.actionInput.verifier ? { verifierId: input.actionInput.verifier.id } : {}),
      ...(input.actionInput.verifier ? { verifierContractDigest: input.actionInput.verifier.contractDigest } : {}),
      projectRevisionId: input.actionInput.projectRevisionId,
      projectViewId: input.actionInput.projectViewId,
      sourceSpaceSnapshots: { ...input.actionInput.sourceSpaceSnapshots },
      ...(input.actionInput.changeRevisionId ? { changeRevisionId: input.actionInput.changeRevisionId } : {}),
      ...(input.actionInput.workspaceId ? { workspaceId: input.actionInput.workspaceId } : {}),
      ...(input.actionInput.targetId ? { targetId: input.actionInput.targetId } : {}),
      inputManifestDigest: requestDigest,
      inputDigests: [...input.actionInput.inputDigests],
      outputPaths: [...input.actionInput.action.outputPaths],
      effectDigests: [...input.actionInput.effectDigests],
      dependencyDigest: input.actionInput.dependencyDigest,
      toolchainDigest: input.actionInput.toolchainDigest,
      environmentDigest: input.actionInput.environmentDigest,
      policyVersion: input.actionInput.policyVersion,
      authorizationEpoch: input.actionInput.authorizationEpoch,
      capabilityGrantId: input.actionInput.capabilityGrantId,
      actor: { ...input.actionInput.actor },
      disclosure: { ...input.actionInput.disclosure },
      runnerRequirements,
      networkDestinations: [...input.actionInput.action.network],
      secretUseAliases,
      outputLocations: { ...outputLocations },
      state: "queued",
      idempotencyKey: input.idempotencyKey,
      attemptIds: [attemptId],
      currentAttemptId: attemptId,
      createdAt,
      updatedAt: createdAt,
      receipt: `runnerJob=queued; job=${jobId}; run=${runId}; inputManifest=${requestDigest}; canonicalWrite=false`,
    };
    const attempt: RunnerAttempt = {
      protocol: CONTRACT_VERSIONS.runnerAttempt,
      id: attemptId,
      jobId,
      runId,
      state: "queued",
      leaseExpiresAt: input.leaseExpiresAt,
      receipt: `runnerAttempt=queued; attempt=${attemptId}; job=${jobId}; leaseExpiresAt=${input.leaseExpiresAt}`,
    };
    this.jobs.set(jobId, { job, run, requestDigest });
    this.attempts.set(attemptId, attempt);
    this.idempotency.set(input.idempotencyKey, jobId);
    this.emit({ type: "runner.job.queued", jobId, attemptId, runId, actor: input.actionInput.actor, to: "queued", receipt: job.receipt });
    return { job: copyJob(job), run: copyRun(run), attempt: copyAttempt(attempt) };
  }

  pull(runnerId: string): RunnerJobOffer | undefined {
    const runner = this.requireRunner(runnerId);
    if (runner.status !== "active") {
      error({
        code: "runner-not-eligible",
        message: `Runner ${runner.id} is ${runner.status} and cannot pull jobs.`,
        affectedObject: runner.id,
        recoveryAction: "activate a qualified Runner or select another enrolled Runner",
        receipt: `runner=${runner.id}; state=${runner.status}; required=active`,
      });
    }
    const candidate = [...this.jobs.values()]
      .filter((stored) => stored.job.state === "queued" && this.runnerMatchesJob(runner, stored.job))
      .sort((left, right) => left.job.createdAt.localeCompare(right.job.createdAt) || left.job.id.localeCompare(right.job.id))[0];
    if (!candidate) return undefined;
    const attempt = this.requireAttempt(candidate.job.currentAttemptId);
    if (attempt.state !== "queued") return undefined;
    const challenge = randomBytes(24).toString("base64url");
    this.offers.set(attempt.id, challenge);
    attempt.challengeDigest = digest(challenge);
    attempt.state = "offered";
    candidate.job.state = "offered";
    candidate.job.currentRunnerId = runner.id;
    candidate.job.updatedAt = this.now();
    attempt.receipt = `runnerAttempt=offered; attempt=${attempt.id}; runner=${runner.id}; challengeDigest=${attempt.challengeDigest}`;
    candidate.job.receipt = `runnerJob=offered; job=${candidate.job.id}; runner=${runner.id}; attempt=${attempt.id}`;
    this.emit({ type: "runner.job.offered", runnerId: runner.id, jobId: candidate.job.id, attemptId: attempt.id, runId: candidate.run.id, to: "offered", receipt: candidate.job.receipt });
    return { job: copyJob(candidate.job), attempt: copyAttempt(attempt), challenge, receipt: attempt.receipt };
  }

  claim(input: { runnerId: string; jobId: string; attemptId: string; challenge: string; signature: string }): RunnerJobLease {
    const runner = this.requireRunner(input.runnerId);
    const stored = this.requireJob(input.jobId);
    const attempt = this.requireAttempt(input.attemptId);
    if (runner.status !== "active") {
      error({ code: "runner-not-eligible", message: `Runner ${runner.id} is ${runner.status} and cannot claim Runner Job ${stored.job.id}.`, affectedObject: runner.id, recoveryAction: "activate a qualified Runner or retry the Job with another active Runner", receipt: `runner=${runner.id}; state=${runner.status}; job=${stored.job.id}` });
    }
    if (attempt.jobId !== stored.job.id || stored.job.currentAttemptId !== attempt.id) {
      error({ code: "attempt-mismatch", message: `Runner Attempt ${attempt.id} is not the current Attempt for Job ${stored.job.id}.`, affectedObject: attempt.id, recoveryAction: "pull the current offered Attempt and retry the claim", receipt: `job=${stored.job.id}; currentAttempt=${stored.job.currentAttemptId}; receivedAttempt=${attempt.id}` });
    }
    if (stored.job.state !== "offered" || attempt.state !== "offered") {
      error({ code: "job-state", message: `Runner Job ${stored.job.id} is ${stored.job.state}; only an offered Job can be claimed.`, affectedObject: stored.job.id, recoveryAction: "pull a queued Job or inspect the existing Attempt state", receipt: `job=${stored.job.id}; jobState=${stored.job.state}; attemptState=${attempt.state}` });
    }
    if (Date.parse(attempt.leaseExpiresAt) <= Date.parse(this.now())) return this.expire(input.jobId);
    const offeredChallenge = this.offers.get(attempt.id);
    if (!offeredChallenge || offeredChallenge !== input.challenge || attempt.challengeDigest !== digest(input.challenge) || !verifyProof(runner.publicKey, claimMessage(input.challenge), input.signature)) {
      error({ code: "runner-proof-invalid", message: `Runner ${runner.id} did not prove possession of its enrolled identity for Attempt ${attempt.id}.`, affectedObject: runner.id, recoveryAction: "sign the exact pull challenge with the enrolled private key and retry the claim", receipt: `runner=${runner.id}; attempt=${attempt.id}; proof=invalid` });
    }
    const token = randomBytes(32).toString("base64url");
    const credential: StoredCredential = {
      id: opaqueId("runner-job-credential"),
      digest: credentialDigest(token),
      jobId: stored.job.id,
      attemptId: attempt.id,
      runnerId: runner.id,
      expiresAt: attempt.leaseExpiresAt,
      status: "active",
    };
    this.credentials.set(credential.id, credential);
    attempt.runnerId = runner.id;
    attempt.state = "running";
    attempt.claimedAt = this.now();
    attempt.lastHeartbeatAt = attempt.claimedAt;
    attempt.jobCredentialDigest = credential.digest;
    attempt.receipt = `runnerAttempt=running; attempt=${attempt.id}; runner=${runner.id}; credential=${credential.id}; credentialStored=false`;
    stored.job.state = "running";
    stored.job.currentRunnerId = runner.id;
    stored.job.updatedAt = this.now();
    stored.job.receipt = `runnerJob=running; job=${stored.job.id}; attempt=${attempt.id}; runner=${runner.id}; canonicalWrite=false`;
    stored.run.runnerId = runner.id;
    stored.run.status = "running";
    this.emit({ type: "runner.job.claimed", runnerId: runner.id, jobId: stored.job.id, attemptId: attempt.id, runId: stored.run.id, to: "running", receipt: stored.job.receipt });
    return {
      job: copyJob(stored.job),
      attempt: copyAttempt(attempt),
      credential: { id: credential.id, audience: "runner-job", jobId: stored.job.id, attemptId: attempt.id, runnerId: runner.id, expiresAt: credential.expiresAt, token },
      receipt: attempt.receipt,
    };
  }

  heartbeat(input: { credential: RunnerJobCredential; progressDigest?: string }): RunnerAttempt {
    const { stored, attempt, credential } = this.authorizeCredential(input.credential);
    if (stored.job.state !== "running" && stored.job.state !== "cancel-requested") {
      error({ code: "job-state", message: `Runner Job ${stored.job.id} is ${stored.job.state}; it cannot receive a heartbeat.`, affectedObject: stored.job.id, recoveryAction: "inspect the current Job state and stop work when the Attempt is no longer active", receipt: `job=${stored.job.id}; state=${stored.job.state}` });
    }
    attempt.lastHeartbeatAt = this.now();
    attempt.receipt = `runnerAttempt=heartbeat; attempt=${attempt.id}; runner=${credential.runnerId}; progressDigest=${input.progressDigest ?? "none"}`;
    this.emit({ type: "runner.attempt.heartbeat", runnerId: credential.runnerId, jobId: stored.job.id, attemptId: attempt.id, runId: stored.run.id, receipt: attempt.receipt });
    return copyAttempt(attempt);
  }

  requestCancellation(input: { jobId: string; actor: ActorRef; reason: string }): RunnerJob {
    nonEmpty(input.reason, "reason");
    const stored = this.requireJob(input.jobId);
    const attempt = this.requireAttempt(stored.job.currentAttemptId);
    if (stored.job.state !== "running" && stored.job.state !== "offered" && stored.job.state !== "claimed") {
      error({ code: "cancellation-invalid", message: `Runner Job ${stored.job.id} is ${stored.job.state}; cancellation requires an active Attempt.`, affectedObject: stored.job.id, recoveryAction: "inspect the recorded Job state and retry only while the Attempt is active", receipt: `job=${stored.job.id}; state=${stored.job.state}` });
    }
    const previousState = stored.job.state;
    stored.job.state = "cancel-requested";
    stored.job.updatedAt = this.now();
    stored.job.recoveryAction = "the Runner must report cooperative stop, forced termination, or unknown cleanup before the Job can be retried";
    attempt.state = "cancel-requested";
    attempt.recoveryAction = stored.job.recoveryAction;
    attempt.receipt = `runnerAttempt=cancel-requested; attempt=${attempt.id}; reason=${input.reason}`;
    stored.job.receipt = `runnerJob=cancel-requested; job=${stored.job.id}; attempt=${attempt.id}; reason=${input.reason}`;
    this.emit({ type: "runner.job.cancel-requested", ...(attempt.runnerId ? { runnerId: attempt.runnerId } : {}), jobId: stored.job.id, attemptId: attempt.id, runId: stored.run.id, actor: input.actor, from: previousState, to: "cancel-requested", receipt: stored.job.receipt });
    return copyJob(stored.job);
  }

  finalizeCancellation(input: { credential: RunnerJobCredential; outcome: RunnerCancellationOutcome; receipt: string }): RunnerCompletion {
    nonEmpty(input.receipt, "receipt");
    const { stored, attempt, credential } = this.authorizeCredential(input.credential);
    if (stored.job.state !== "cancel-requested" || attempt.state !== "cancel-requested") {
      error({ code: "cancellation-invalid", message: `Runner Job ${stored.job.id} is not waiting for cancellation confirmation.`, affectedObject: stored.job.id, recoveryAction: "request cancellation first and report the current Attempt state", receipt: `job=${stored.job.id}; jobState=${stored.job.state}; attemptState=${attempt.state}` });
    }
    const quarantined = input.outcome === "unknown";
    const state: RunnerJobState = quarantined ? "quarantined" : "cancelled";
    const attemptState: RunnerAttemptState = quarantined ? "quarantined" : "cancelled";
    const recoveryAction = quarantined
      ? "revoke Runner credentials, quarantine the Runner, inspect cleanup, and retry from a fresh Attempt only after reconciliation"
      : "retry the immutable Job with a new idempotency key when the cancellation cause is understood";
    this.completeAttempt(stored, attempt, credential.runnerId, state, attemptState, "indeterminate", digest({ outcome: input.outcome, receipt: input.receipt }), recoveryAction, input.receipt);
    return this.completion(stored, attempt, input.receipt);
  }

  submit(input: { credential: RunnerJobCredential; result: RunnerResult }): RunnerCompletion {
    const { stored, attempt, credential } = this.authorizeCredential(input.credential);
    if (stored.job.state !== "running" && stored.job.state !== "cancel-requested") {
      if (["succeeded", "failed", "indeterminate", "cancelled", "expired", "quarantined"].includes(stored.job.state)) {
        error({ code: "result-replay", message: `Runner Job ${stored.job.id} already reached ${stored.job.state}; this result is a replay.`, affectedObject: stored.job.id, recoveryAction: "inspect the accepted Attempt result and create a new retry Attempt instead of replaying the old result", receipt: `job=${stored.job.id}; state=${stored.job.state}; attempt=${attempt.id}` });
      }
      error({ code: "job-state", message: `Runner Job ${stored.job.id} is ${stored.job.state}; it cannot accept a result.`, affectedObject: stored.job.id, recoveryAction: "submit only while the current Attempt is running or cancellation is being confirmed", receipt: `job=${stored.job.id}; state=${stored.job.state}` });
    }
    if (stored.job.state === "cancel-requested") {
      error({ code: "cancellation-invalid", message: `Runner Job ${stored.job.id} has a pending cancellation and cannot accept a normal result.`, affectedObject: stored.job.id, recoveryAction: "report cancellation outcome through finalizeCancellation", receipt: `job=${stored.job.id}; state=cancel-requested` });
    }
    const expectedContext = runnerResultContext({ job: stored.job, attempt });
    if (stableJson(input.result.context) !== stableJson(expectedContext)) {
      error({ code: "result-input-mismatch", message: `Runner Result for Job ${stored.job.id} does not carry the immutable execution context issued for Attempt ${attempt.id}.`, affectedObject: attempt.id, recoveryAction: "echo the exact signed Runner Result context from the claimed Job and Attempt; do not alter source, Action, Verifier, policy, lease, or replay fields", receipt: `job=${stored.job.id}; attempt=${attempt.id}; context=not-matched; replayId=${input.result.context.replayId}` });
    }
    const message = runnerResultMessage({ context: expectedContext, status: input.result.status, output: input.result.output, outputs: input.result.outputs, ...(input.result.recoveryAction ? { recoveryAction: input.result.recoveryAction } : {}) });
    if (!verifyProof(credentialRunnerPublicKey(this.runners, credential.runnerId), message, input.result.signature)) {
      error({ code: "result-signature-invalid", message: `Runner ${credential.runnerId} did not sign the exact Result for Attempt ${attempt.id}.`, affectedObject: attempt.id, recoveryAction: "sign the canonical Runner Result with the enrolled Runner identity and retry before the lease expires", receipt: `runner=${credential.runnerId}; attempt=${attempt.id}; resultSignature=invalid` });
    }
    if (!arrayEqual(input.result.output.inputDigests, stored.job.inputDigests)) {
      error({ code: "result-input-mismatch", message: `Runner Result for Job ${stored.job.id} names inputs different from the immutable input manifest.`, affectedObject: stored.job.id, recoveryAction: "rerun against the exact Project View and input digest set recorded in the Runner Job", receipt: `job=${stored.job.id}; expectedInputs=${stored.job.inputDigests.join(",")}; receivedInputs=${input.result.output.inputDigests.join(",")}` });
    }
    this.validateOutput(stored.job, attempt, input.result);
    const resultDigest = digest({ jobId: stored.job.id, attemptId: attempt.id, result: input.result });
    const runStatus = input.result.status;
    const recoveryAction = input.result.recoveryAction ?? (runStatus === "succeeded" ? undefined : "inspect the scoped Runner outputs and retry with a new idempotency key after correcting the failure");
    this.completeAttempt(stored, attempt, credential.runnerId, runStatus, runStatus, runStatus, resultDigest, recoveryAction, `runnerResult=${runStatus}; ${resultDigest}`, input.result.output);
    const normalizedOutputs = input.result.outputs.map((output) => ({
      protocol: CONTRACT_VERSIONS.runnerOutput,
      id: output.id ?? opaqueId("runner-output"),
      kind: output.kind,
      runId: stored.run.id,
      attemptId: attempt.id,
      location: safeLocation(output.location, "runnerOutput.location", "result-output-scope"),
      digest: output.digest,
      disclosure: { ...output.disclosure },
      receipt: output.receipt,
    }));
    this.outputs.set(attempt.id, normalizedOutputs);
    return this.completion(stored, attempt, `runnerResult=${runStatus}; outputs=${normalizedOutputs.length}`);
  }

  expire(jobId: string): never {
    const stored = this.requireJob(jobId);
    const attempt = this.requireAttempt(stored.job.currentAttemptId);
    if (Date.parse(attempt.leaseExpiresAt) > Date.parse(this.now())) {
      error({ code: "lease-not-expired", message: `Runner Attempt ${attempt.id} has not reached its lease expiry.`, affectedObject: attempt.id, recoveryAction: "wait for the recorded lease expiry or request explicit cancellation", receipt: `attempt=${attempt.id}; leaseExpiresAt=${attempt.leaseExpiresAt}; now=${this.now()}` });
    }
    if (["succeeded", "failed", "indeterminate", "cancelled", "expired", "quarantined"].includes(attempt.state)) {
      error({ code: "result-replay", message: `Runner Attempt ${attempt.id} is already finalized as ${attempt.state}.`, affectedObject: attempt.id, recoveryAction: "inspect the existing Attempt and create a retry only when recovery is permitted", receipt: `attempt=${attempt.id}; state=${attempt.state}` });
    }
    const previousJobState = stored.job.state;
    this.revokeAttemptCredentials(attempt.id);
    attempt.state = "expired";
    attempt.completedAt = this.now();
    attempt.recoveryAction = "inspect Runner availability and retry from a fresh Attempt after confirming no provider side effect escaped the lease";
    attempt.receipt = `runnerAttempt=expired; attempt=${attempt.id}; leaseExpiresAt=${attempt.leaseExpiresAt}; now=${this.now()}`;
    stored.job.state = "expired";
    stored.job.updatedAt = this.now();
    stored.job.recoveryAction = attempt.recoveryAction;
    stored.job.receipt = `runnerJob=expired; job=${stored.job.id}; attempt=${attempt.id}; providerResult=unknown`;
    stored.run.status = "indeterminate";
    this.emit({ type: "runner.attempt.expired", ...(attempt.runnerId ? { runnerId: attempt.runnerId } : {}), jobId: stored.job.id, attemptId: attempt.id, runId: stored.run.id, from: previousJobState, to: "expired", receipt: attempt.receipt });
    error({ code: "lease-expired", message: `Runner Attempt ${attempt.id} expired before a trusted Result was accepted.`, affectedObject: attempt.id, recoveryAction: attempt.recoveryAction, receipt: attempt.receipt });
  }

  markRunnerUnavailable(runnerId: string, actor: ActorRef, reason: string): RunnerProfile {
    nonEmpty(reason, "reason");
    const runner = this.requireRunner(runnerId);
    runner.status = "unavailable";
    runner.updatedAt = this.now();
    runner.receipt = `runner=${runner.id}; state=unavailable; reason=${reason}`;
    this.emit({ type: "runner.unavailable", runnerId: runner.id, actor, receipt: runner.receipt });
    for (const stored of this.jobs.values()) {
      if (stored.job.currentRunnerId !== runner.id || !["offered", "claimed", "running", "cancel-requested"].includes(stored.job.state)) continue;
      const attempt = this.requireAttempt(stored.job.currentAttemptId);
      const previousJobState = stored.job.state;
      this.revokeAttemptCredentials(attempt.id);
      attempt.state = "indeterminate";
      attempt.completedAt = this.now();
      attempt.recoveryAction = "restore or replace the unavailable Runner, reconcile provider state, then retry from a fresh Attempt";
      attempt.receipt = `runnerAttempt=indeterminate; attempt=${attempt.id}; runner=${runner.id}; provider=unavailable; reason=${reason}`;
      stored.job.state = "indeterminate";
      stored.job.updatedAt = this.now();
      stored.job.recoveryAction = attempt.recoveryAction;
      stored.job.receipt = `runnerJob=indeterminate; job=${stored.job.id}; runner=${runner.id}; provider=unavailable`;
      stored.run.status = "indeterminate";
      this.emit({ type: "runner.job.indeterminate", runnerId: runner.id, jobId: stored.job.id, attemptId: attempt.id, runId: stored.run.id, from: previousJobState, to: "indeterminate", receipt: stored.job.receipt });
    }
    return copyProfile(runner);
  }

  quarantineRunner(runnerId: string, actor: ActorRef, reason: string): RunnerProfile {
    nonEmpty(reason, "reason");
    const runner = this.requireRunner(runnerId);
    runner.status = "quarantined";
    runner.updatedAt = this.now();
    runner.receipt = `runner=${runner.id}; state=quarantined; reason=${reason}`;
    this.emit({ type: "runner.quarantined", runnerId: runner.id, actor, receipt: runner.receipt });
    for (const stored of this.jobs.values()) {
      if (stored.job.currentRunnerId !== runner.id || !["offered", "claimed", "running", "cancel-requested"].includes(stored.job.state)) continue;
      const attempt = this.requireAttempt(stored.job.currentAttemptId);
      const previousJobState = stored.job.state;
      this.revokeAttemptCredentials(attempt.id);
      attempt.state = "quarantined";
      attempt.completedAt = this.now();
      attempt.recoveryAction = "preserve the Attempt as quarantined, rotate Runner credentials, inspect cleanup, and retry only with a qualified Runner";
      attempt.receipt = `runnerAttempt=quarantined; attempt=${attempt.id}; runner=${runner.id}; reason=${reason}`;
      stored.job.state = "quarantined";
      stored.job.updatedAt = this.now();
      stored.job.recoveryAction = attempt.recoveryAction;
      stored.job.receipt = `runnerJob=quarantined; job=${stored.job.id}; runner=${runner.id}; reason=${reason}`;
      stored.run.status = "indeterminate";
      this.emit({ type: "runner.job.quarantined", runnerId: runner.id, jobId: stored.job.id, attemptId: attempt.id, runId: stored.run.id, from: previousJobState, to: "quarantined", receipt: stored.job.receipt });
    }
    return copyProfile(runner);
  }

  retry(input: { jobId: string; idempotencyKey: string; leaseExpiresAt: string; actor: ActorRef }): { job: RunnerJob; run: Run; attempt: RunnerAttempt } {
    nonEmpty(input.idempotencyKey, "idempotencyKey");
    const existingJobId = this.retryIdempotency.get(input.idempotencyKey);
    if (existingJobId) {
      if (existingJobId !== input.jobId) error({ code: "job-idempotency-conflict", message: `Retry idempotency key ${input.idempotencyKey} belongs to another Runner Job.`, affectedObject: input.idempotencyKey, recoveryAction: "use a fresh retry idempotency key", receipt: `idempotencyKey=${input.idempotencyKey}; existingJob=${existingJobId}; requestedJob=${input.jobId}` });
      const existing = this.requireJob(input.jobId);
      return { job: copyJob(existing.job), run: copyRun(existing.run), attempt: copyAttempt(this.requireAttempt(existing.job.currentAttemptId)) };
    }
    const stored = this.requireJob(input.jobId);
    if (!["failed", "indeterminate", "cancelled", "expired", "quarantined"].includes(stored.job.state)) {
      error({ code: "retry-invalid", message: `Runner Job ${stored.job.id} is ${stored.job.state}; it cannot be retried from this state.`, affectedObject: stored.job.id, recoveryAction: "retry only a failed, indeterminate, cancelled, expired, or quarantined Job", receipt: `job=${stored.job.id}; state=${stored.job.state}` });
    }
    futureTimestamp(input.leaseExpiresAt, this.now(), "leaseExpiresAt");
    const previousAttempt = this.requireAttempt(stored.job.currentAttemptId);
    const attemptId = opaqueId("runner-attempt");
    const attempt: RunnerAttempt = {
      protocol: CONTRACT_VERSIONS.runnerAttempt,
      id: attemptId,
      jobId: stored.job.id,
      runId: stored.run.id,
      state: "queued",
      leaseExpiresAt: input.leaseExpiresAt,
      recoveryAction: "pull and claim this fresh Attempt only after selecting a Runner whose capability profile satisfies the immutable Job",
      receipt: `runnerAttempt=queued; attempt=${attemptId}; previousAttempt=${previousAttempt.id}; retry=true; actor=${input.actor.actorId}`,
    };
    this.attempts.set(attemptId, attempt);
    stored.job.attemptIds = [...stored.job.attemptIds, attemptId];
    stored.job.currentAttemptId = attemptId;
    delete stored.job.currentRunnerId;
    stored.job.state = "queued";
    stored.job.updatedAt = this.now();
    stored.job.recoveryAction = "pull and claim the fresh Attempt; the previous Attempt remains immutable and inspectable";
    stored.job.receipt = `runnerJob=queued; job=${stored.job.id}; retry=true; previousAttempt=${previousAttempt.id}; currentAttempt=${attemptId}`;
    stored.run.runnerId = "runner:unassigned";
    stored.run.status = "queued";
    stored.run.attemptId = attemptId;
    this.retryIdempotency.set(input.idempotencyKey, stored.job.id);
    this.emit({ type: "runner.job.retried", jobId: stored.job.id, attemptId, runId: stored.run.id, actor: input.actor, to: "queued", receipt: stored.job.receipt });
    return { job: copyJob(stored.job), run: copyRun(stored.run), attempt: copyAttempt(attempt) };
  }

  getJob(jobId: string): RunnerJob | undefined {
    const stored = this.jobs.get(jobId);
    return stored ? copyJob(stored.job) : undefined;
  }

  getRun(jobId: string): Run | undefined {
    const stored = this.jobs.get(jobId);
    return stored ? copyRun(stored.run) : undefined;
  }

  getAttempt(attemptId: string): RunnerAttempt | undefined {
    const attempt = this.attempts.get(attemptId);
    return attempt ? copyAttempt(attempt) : undefined;
  }

  listAttempts(jobId: string): readonly RunnerAttempt[] {
    const stored = this.requireJob(jobId);
    return stored.job.attemptIds.map((attemptId) => copyAttempt(this.requireAttempt(attemptId)));
  }

  listOutputs(attemptId: string): readonly RunnerOutputReference[] {
    return (this.outputs.get(attemptId) ?? []).map(copyOutput);
  }

  listEvents(): readonly RunnerEvent[] {
    return this.events.map(copyEvent);
  }

  private requireRunner(runnerId: string): RunnerProfile {
    const runner = this.runners.get(runnerId);
    if (!runner) error({ code: "runner-not-found", message: `Runner ${runnerId} is not enrolled in this Realm.`, affectedObject: runnerId, recoveryAction: "enroll the Runner in this Realm before using the pull protocol", receipt: `runner=${runnerId}; enrolled=false` });
    return runner;
  }

  private requireJob(jobId: string): StoredJob {
    const stored = this.jobs.get(jobId);
    if (!stored) error({ code: "job-not-found", message: `Runner Job ${jobId} is not present in the authoritative Run ledger.`, affectedObject: jobId, recoveryAction: "restore the Run ledger or enqueue a new immutable Job", receipt: `job=${jobId}; present=false` });
    return stored;
  }

  private requireAttempt(attemptId: string): RunnerAttempt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) error({ code: "attempt-not-found", message: `Runner Attempt ${attemptId} is not present in the authoritative Attempt ledger.`, affectedObject: attemptId, recoveryAction: "restore the Attempt ledger or retry the Job from its last verified checkpoint", receipt: `attempt=${attemptId}; present=false` });
    return attempt;
  }

  private runnerMatchesJob(runner: RunnerProfile, job: RunnerJob): boolean {
    if (runner.status !== "active") return false;
    if (!job.runnerRequirements.every((required) => runner.capabilities.includes(required))) return false;
    if (!job.networkDestinations.every((destination) => runner.networkDestinations.includes(destination))) return false;
    if (job.secretUseAliases.length > 0 && runner.secretUse !== "brokered") return false;
    if (job.outputPaths.length > 0 && !runner.canUploadArtifacts) return false;
    if (job.verifierId && !runner.canUploadEvidence) return false;
    return true;
  }

  private authorizeCredential(token: RunnerJobCredential): { stored: StoredJob; attempt: RunnerAttempt; credential: StoredCredential } {
    if (token.audience !== "runner-job") error({ code: "credential-invalid", message: "Runner Job credential audience is invalid.", affectedObject: token.id, recoveryAction: "use the short-lived credential returned by the current Attempt claim", receipt: `credential=${token.id}; audience=${token.audience}` });
    const credential = [...this.credentials.values()].find((candidate) => candidate.id === token.id && candidate.digest === credentialDigest(token.token));
    if (!credential || credential.status !== "active") error({ code: "credential-invalid", message: `Runner Job credential ${token.id} is not active.`, affectedObject: token.id, recoveryAction: "claim the current Attempt again or request a fresh retry Attempt", receipt: `credential=${token.id}; present=${Boolean(credential)}; status=${credential?.status ?? "missing"}` });
    if (credential.jobId !== token.jobId || credential.attemptId !== token.attemptId || credential.runnerId !== token.runnerId) error({ code: "lease-invalid", message: `Runner Job credential ${token.id} is bound to another Job, Attempt, or Runner.`, affectedObject: token.id, recoveryAction: "use the exact credential returned for this Runner Attempt", receipt: `credential=${token.id}; job=${token.jobId}; attempt=${token.attemptId}; runner=${token.runnerId}` });
    if (Date.parse(credential.expiresAt) <= Date.parse(this.now())) {
      credential.status = "revoked";
      error({ code: "lease-expired", message: `Runner Job credential ${token.id} has expired with its Attempt lease.`, affectedObject: token.id, recoveryAction: "inspect provider state and retry from a fresh Attempt", receipt: `credential=${token.id}; expiresAt=${credential.expiresAt}; now=${this.now()}` });
    }
    const stored = this.requireJob(credential.jobId);
    const attempt = this.requireAttempt(credential.attemptId);
    if (attempt.runnerId !== credential.runnerId || stored.job.currentAttemptId !== attempt.id) error({ code: "lease-invalid", message: `Runner Job credential ${token.id} no longer matches the authoritative Attempt.`, affectedObject: token.id, recoveryAction: "stop the Runner process and inspect the current Attempt before retrying", receipt: `credential=${token.id}; attemptRunner=${attempt.runnerId ?? "none"}; credentialRunner=${credential.runnerId}; currentAttempt=${stored.job.currentAttemptId}` });
    return { stored, attempt, credential };
  }

  private validateOutput(job: RunnerJob, attempt: RunnerAttempt, result: RunnerResult): void {
    const expectedPaths = new Set(job.outputPaths);
    const receivedPaths = result.output.outputDigests.map(pathFromDigest);
    if (result.output.status !== result.status) {
      error({ code: "result-output-invalid", message: `Runner Result for Job ${job.id} has a status mismatch between its envelope and normalized output.`, affectedObject: job.id, recoveryAction: "set the Runner Result and NormalizedActionOutput statuses to the same value", receipt: `job=${job.id}; resultStatus=${result.status}; outputStatus=${result.output.status}` });
    }
    if (receivedPaths.some((path) => path === undefined || !expectedPaths.has(path))) {
      error({ code: "result-output-invalid", message: `Runner Result for Job ${job.id} names an output outside the Action contract.`, affectedObject: job.id, recoveryAction: "return only output digests for the declared Action output paths", receipt: `job=${job.id}; expectedOutputs=${job.outputPaths.join(",")}; receivedOutputs=${result.output.outputDigests.join(",")}` });
    }
    if (new Set(receivedPaths).size !== receivedPaths.length || (result.status === "succeeded" && receivedPaths.length !== expectedPaths.size)) {
      error({ code: "result-output-invalid", message: `Runner Result for Job ${job.id} does not contain exactly one digest for each declared output.`, affectedObject: job.id, recoveryAction: "produce every declared output exactly once or return a failed Result with the missing-output receipt", receipt: `job=${job.id}; expectedCount=${expectedPaths.size}; receivedCount=${receivedPaths.length}` });
    }
    for (const output of result.outputs) {
      const normalizedLocation = safeLocation(output.location, "runnerOutput.location", "result-output-scope");
      nonEmpty(output.digest, "runnerOutput.digest");
      nonEmpty(output.receipt, "runnerOutput.receipt");
      if (output.runId !== undefined || output.attemptId !== undefined) {
        error({ code: "result-output-invalid", message: `Runner output references must not override coordinator-owned Run or Attempt identity.`, affectedObject: job.id, recoveryAction: "omit runId and attemptId from submitted output references; Anyam attaches them after validation", receipt: `job=${job.id}; runIdInput=${String((output as JsonRecord).runId)}; attemptIdInput=${String((output as JsonRecord).attemptId)}` });
      }
      const expectedLocation = output.kind === "log" ? job.outputLocations.logs : output.kind === "artifact" ? job.outputLocations.artifacts : job.outputLocations.evidence;
      if (!locationWithin(normalizedLocation, expectedLocation)) {
        error({ code: "result-output-scope", message: `Runner output ${output.id ?? "unnamed"} is outside its Run-scoped ${output.kind} location.`, affectedObject: job.id, recoveryAction: `upload ${output.kind} only below ${expectedLocation} for this Run Attempt`, receipt: `job=${job.id}; kind=${output.kind}; location=${normalizedLocation}; expectedRoot=${expectedLocation}` });
      }
      if (!disclosureAllows(job.disclosure.classification, output.disclosure.classification)) {
        error({ code: "result-output-scope", message: `Runner output ${output.id ?? "unnamed"} discloses more than the Job's Project View.`, affectedObject: job.id, recoveryAction: "return a disclosure-safe output projection or request an authorized Project View before retrying", receipt: `job=${job.id}; jobDisclosure=${job.disclosure.classification}; outputDisclosure=${output.disclosure.classification}` });
      }
      if (output.kind === "artifact" && !normalizedLocation.includes(attempt.id)) {
        error({ code: "result-output-scope", message: `Artifact output ${output.id ?? "unnamed"} is not bound to Attempt ${attempt.id}.`, affectedObject: job.id, recoveryAction: "include the current Attempt identity in the Artifact output location", receipt: `job=${job.id}; attempt=${attempt.id}; location=${normalizedLocation}` });
      }
    }
  }

  private completeAttempt(stored: StoredJob, attempt: RunnerAttempt, runnerId: string, jobState: RunnerJobState, attemptState: RunnerAttemptState, runStatus: Run["status"], resultDigest: string, recoveryAction: string | undefined, receipt: string, normalizedOutput?: NormalizedActionOutput): void {
    const previousJobState = stored.job.state;
    this.revokeAttemptCredentials(attempt.id);
    attempt.state = attemptState;
    attempt.completedAt = this.now();
    attempt.resultDigest = resultDigest;
    if (recoveryAction) attempt.recoveryAction = recoveryAction;
    attempt.receipt = `runnerAttempt=${attemptState}; attempt=${attempt.id}; runner=${runnerId}; resultDigest=${resultDigest}; ${receipt}`;
    stored.job.state = jobState;
    stored.job.updatedAt = this.now();
    if (recoveryAction) stored.job.recoveryAction = recoveryAction;
    stored.job.receipt = `runnerJob=${jobState}; job=${stored.job.id}; attempt=${attempt.id}; resultDigest=${resultDigest}; ${receipt}`;
    stored.run.runnerId = runnerId;
    stored.run.status = runStatus;
    stored.run.outputDigest = normalizedOutput?.outputDigest ?? resultDigest;
    if (normalizedOutput) {
      stored.run.inputDigests = [...normalizedOutput.inputDigests];
      stored.run.outputDigests = [...normalizedOutput.outputDigests];
      if (normalizedOutput.exitCode !== undefined) stored.run.exitCode = normalizedOutput.exitCode;
      stored.run.stdoutDigest = normalizedOutput.stdoutDigest;
      stored.run.stderrDigest = normalizedOutput.stderrDigest;
    }
    this.emit({ type: `runner.job.${jobState}`, runnerId, jobId: stored.job.id, attemptId: attempt.id, runId: stored.run.id, from: previousJobState, to: jobState, receipt: stored.job.receipt });
  }

  private completion(stored: StoredJob, attempt: RunnerAttempt, receipt: string): RunnerCompletion {
    const outputs = (this.outputs.get(attempt.id) ?? []).map(copyOutput);
    return { job: copyJob(stored.job), attempt: copyAttempt(attempt), run: copyRun(stored.run), outputs, resultDigest: attempt.resultDigest ?? digest(receipt), receipt };
  }

  private revokeAttemptCredentials(attemptId: string): void {
    for (const credential of this.credentials.values()) {
      if (credential.attemptId === attemptId) credential.status = "revoked";
    }
  }

  private emit(input: { type: string; runnerId?: string; jobId?: string; attemptId?: string; runId?: string; actor?: ActorRef; from?: RunnerJobState | RunnerAttemptState; to?: RunnerJobState | RunnerAttemptState; receipt: string }): void {
    this.events.push({
      protocol: CONTRACT_VERSIONS.runnerEvent,
      id: opaqueId("runner-event"),
      sequence: this.events.length + 1,
      type: input.type,
      ...(input.runnerId ? { runnerId: input.runnerId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.actor ? { actor: { ...input.actor } } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      occurredAt: this.now(),
      receipt: input.receipt,
    });
  }
}

function credentialRunnerPublicKey(runners: ReadonlyMap<string, RunnerProfile>, runnerId: string): string {
  const runner = runners.get(runnerId);
  if (!runner) {
    error({ code: "runner-not-found", message: `Runner ${runnerId} is not enrolled.`, affectedObject: runnerId, recoveryAction: "enroll the Runner before submitting a Result", receipt: `runner=${runnerId}; enrolled=false` });
  }
  return runner.publicKey;
}
