import {
  CONTRACT_VERSIONS,
  createProject,
  createProjectRevision,
  deriveProjectView,
  opaqueId,
  type ActorRef,
  type Artifact,
  type Change,
  type ChangeRevision,
  type DisclosureClassification,
  type ExternalProposal,
  type Evidence,
  type Intent,
  type IntentComment,
  type Landing,
  type MirrorCheckpoint,
  type MirrorDelivery,
  type MirrorOperation,
  type RepositoryMirror,
  type Project,
  type ProjectRevision,
  type ProjectView,
  type Release,
  type ReleaseInputSet,
  type Run,
  type RunnerAttempt,
  type RunnerProfile,
  type RunnerJob,
  type RunnerOutputReference,
  type SourceSpace,
  type Target,
  type Workspace,
  type WorkspaceMount,
} from "../kernel/contracts.ts";
import type { PromotionReconciliationCheckpoint, PromotionRecord } from "../delivery/promotion.ts";
import {
  assertTargetCanPromote,
  assertTargetResourceIsolation,
  createTargetDeploymentProfile,
  defaultTargetDeploymentProfile,
  targetDeploymentProfile,
  TargetDeploymentProfileError,
} from "../delivery/target-deployment.ts";
import {
  assertReleaseInputSetMatches,
  createReleaseInputSet,
  deriveReleaseInputSet,
  ReleaseInputError,
} from "../delivery/release-input.ts";
import { createMigrationPlan, defaultMigrationPlan, MigrationPlanError } from "../delivery/migration-plan.ts";
import {
  PROMOTION_EXECUTION_PROTOCOL,
  createPromotionExecutionContext,
  normalizePromotionExecutionResult,
  targetAfterPromotion,
  type PromotionExecutionRequest,
  type PromotionReconciliationRequest,
  type PromotionExecutionResult,
  PromotionExecutionValidationError,
} from "./promotion-execution.ts";
import { runnerResultDigest, runnerResultMessage, verifyRunnerResultSignature } from "../execution/runner-proof.ts";
import type { RunnerResult } from "../execution/runner.ts";

export const AUTHORITY_PLANE_PROTOCOL = "anyam.authority-plane/v1" as const;
export const AUTHORITY_COMMAND_PROTOCOL = "anyam.authority-command/v1" as const;

export type AuthorityCommandName =
  | "project.create"
  | "intent.create"
  | "intent.assign"
  | "intent.comment"
  | "intent.close"
  | "intent.reopen"
  | "workspace.create"
  | "change.create"
  | "revision.publish"
  | "runner.register"
  | "run.request"
  | "runner.complete"
  | "run.record"
  | "evidence.record"
  | "artifact.record"
  | "landing.apply"
  | "release.create"
  | "target.configure"
  | "promotion.request"
  | "promotion.execute"
  | "promotion.reconcile"
  | "mirror.configure"
  | "mirror.sync"
  | "mirror.reconcile";

export type AuthoritySession = {
  realmId: string;
  principalId: string;
  actorId: string;
  sessionId: string;
  clientId: string;
  authorizationEpoch: number;
  taskId?: string;
  capabilityGrantId?: string;
  delegatedBySessionId?: string;
  modelProvider?: string;
  /** Only the internal Runner service may use the asynchronous completion path. */
  kind?: "human" | "agent" | "runner";
};

export type AuthorityAuditEvent = {
  id: string;
  command: AuthorityCommandName;
  idempotencyKey: string;
  actor: ActorRef;
  outcome: "succeeded" | "blocked" | "indeterminate";
  stateVersion: number;
  occurredAt: string;
  taskId?: string;
  capabilityGrantId?: string;
  delegatedBySessionId?: string;
  modelProvider?: string;
  receipt: string;
};

type IdempotencyRecord = {
  fingerprint: string;
  result: AuthorityCommandResult;
};

export type AuthorityPlaneSnapshot = {
  protocol: typeof AUTHORITY_PLANE_PROTOCOL;
  realmId: string;
  version: number;
  projects: Record<string, Project>;
  sourceSpaces: Record<string, SourceSpace>;
  projectRevisions: Record<string, ProjectRevision>;
  intents: Record<string, Intent>;
  intentComments: Record<string, IntentComment>;
  projectViews: Record<string, ProjectView>;
  workspaces: Record<string, Workspace>;
  changes: Record<string, Change>;
  changeRevisions: Record<string, ChangeRevision>;
  runs: Record<string, Run>;
  /** Enrolled Runner public identities mirrored into the Authority boundary. */
  runnerProfiles: Record<string, RunnerProfile>;
  /** Credential-free Attempt terminal state consumed by runner.complete. */
  runnerAttempts: Record<string, RunnerAttempt>;
  evidence: Record<string, Evidence>;
  artifacts: Record<string, Artifact>;
  landings: Record<string, Landing>;
  releases: Record<string, Release>;
  targets: Record<string, Target>;
  promotions: Record<string, PromotionRecord>;
  mirrors: Record<string, RepositoryMirror>;
  mirrorOperations: Record<string, MirrorOperation>;
  mirrorCheckpoints: Record<string, MirrorCheckpoint>;
  externalProposals: Record<string, ExternalProposal>;
  mirrorDeliveries: Record<string, MirrorDelivery>;
  canonicalByProject: Record<string, string>;
  idempotency: Record<string, IdempotencyRecord>;
  audit: AuthorityAuditEvent[];
};

export type AuthorityCommand = {
  protocol: typeof AUTHORITY_COMMAND_PROTOCOL;
  command: AuthorityCommandName;
  idempotencyKey: string;
  expectedVersion?: number;
  payload: Record<string, unknown>;
};

export type AuthorityCommandResult = {
  protocol: typeof AUTHORITY_PLANE_PROTOCOL;
  command: AuthorityCommandName;
  status: "succeeded" | "blocked" | "indeterminate";
  version: number;
  value: Record<string, unknown>;
  receipt: string;
  recoveryAction?: string;
};

export class AuthorityPlaneError extends Error {
  readonly code:
    | "invalid_request"
    | "idempotency_conflict"
    | "stale_state"
    | "not_found"
    | "conflict"
    | "blocked"
    | "indeterminate";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    code: AuthorityPlaneError["code"];
    message: string;
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "AuthorityPlaneError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: `${field} is required.`,
      recoveryAction: `provide a non-empty ${field} and retry; no authority transition was accepted`,
      receipt: `${field}=required; transition=not-applied`,
    });
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function receiptString(value: unknown, field: string): string {
  const receipt = requiredString(value, field);
  if (/(?:access|refresh|provider|api)?[_ -]?token\s*[:=]|bearer\s+|client[_ -]?secret\s*[:=]|password\s*[:=]|authorization\s*[:=]|private[_ -]?key\s*[:=]/i.test(receipt)) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: `${field} contains credential-like material and cannot be persisted.`,
      recoveryAction: `send a digest-only ${field} receipt without token, secret, password, authorization, or key material; no authority transition was accepted`,
      receipt: `${field}=credential-material-rejected; transition=not-applied`,
    });
  }
  return receipt;
}

function stringArray(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: `${field} must be an array of non-empty strings.`,
      recoveryAction: `provide a valid ${field} array and retry; no authority transition was accepted`,
      receipt: `${field}=string-array-required; transition=not-applied`,
    });
  }
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
}

function record<T>(value: unknown, field: string): Record<string, T> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: `${field} must be an object.`,
      recoveryAction: `provide a JSON object for ${field} and retry; no authority transition was accepted`,
      receipt: `${field}=object-required; transition=not-applied`,
    });
  }
  return value as Record<string, T>;
}

function enumString<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback?: T): T {
  const candidate = value === undefined && fallback !== undefined ? fallback : requiredString(value, field);
  if (!allowed.includes(candidate as T)) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: `${field} must be one of ${allowed.join(", ")}.`,
      recoveryAction: `provide a supported ${field} and retry; no authority transition was accepted`,
      receipt: `${field}=unsupported; value=${candidate}; transition=not-applied`,
    });
  }
  return candidate as T;
}

function gitRefs(value: unknown, field: string, allowEmpty = true): Array<{ name: string; oid: string }> {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: `${field} must be an array of Git ref objects.`,
      recoveryAction: `provide ${field} as [{name, oid}] and retry; no authority transition was accepted`,
      receipt: `${field}=git-ref-array-required; transition=not-applied`,
    });
  }
  const refs = value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AuthorityPlaneError({ code: "invalid_request", message: `${field}[${index}] must be an object.`, recoveryAction: `provide a Git ref object for ${field}[${index}]`, receipt: `${field}[${index}]=object-required; transition=not-applied` });
    }
    const ref = entry as Record<string, unknown>;
    return { name: requiredString(ref.name, `${field}[${index}].name`), oid: requiredString(ref.oid, `${field}[${index}].oid`) };
  });
  const names = new Set<string>();
  for (const ref of refs) {
    if (names.has(ref.name)) throw new AuthorityPlaneError({ code: "conflict", message: `${field} contains duplicate ref ${ref.name}.`, recoveryAction: "send one observation for each ref name; no authority transition was accepted", receipt: `${field}=duplicate-ref; ref=${ref.name}; transition=not-applied` });
    names.add(ref.name);
  }
  return refs;
}

function safeObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  return record<unknown>(value, field);
}

function fingerprint(command: AuthorityCommand): string {
  return JSON.stringify({
    protocol: command.protocol,
    command: command.command,
    idempotencyKey: command.idempotencyKey,
    expectedVersion: command.expectedVersion,
    payload: command.payload,
  });
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function disclosureRank(value: DisclosureClassification): number {
  return value === "public" ? 0 : value === "project" ? 1 : 2;
}

function disclosureAllows(outer: DisclosureClassification, inner: DisclosureClassification): boolean {
  return disclosureRank(inner) <= disclosureRank(outer);
}

function safeRunnerLocation(value: unknown, field: string): string {
  const location = requiredString(value, field).replaceAll("\\", "/").replace(/\/+$/u, "");
  if (!location || location.startsWith("/") || /^[A-Za-z]:\//u.test(location) || location.split("/").some((part) => part === "." || part === ".." || part.length === 0)) {
    throw new AuthorityPlaneError({ code: "conflict", message: `${field} is not a safe relative Runner output location.`, recoveryAction: "submit only a normalized path below the coordinator-assigned output root; no Authority state was changed", receipt: `${field}=unsafe; runnerCompletion=not-applied` });
  }
  return location;
}

function locationWithin(location: string, root: string): boolean {
  const normalizedRoot = root.replace(/\/$/u, "");
  return location === normalizedRoot || location.startsWith(`${normalizedRoot}/`);
}

function pathFromDigest(value: string): string | undefined {
  const separator = value.lastIndexOf("=");
  return separator > 0 ? value.slice(0, separator) : undefined;
}

function validateRunnerCompletionOutputScope(job: RunnerJob, result: RunnerResult, outputs: readonly RunnerOutputReference[]): void {
  if (result.output.status !== result.status || !sameStrings(result.output.inputDigests, job.inputDigests)) {
    throw new AuthorityPlaneError({ code: "conflict", message: `Runner Result output does not match the immutable Job inputs or status.`, recoveryAction: "return the exact normalized output produced for this Runner Job; no Authority state was changed", receipt: `job=${job.id}; output=status-or-input-mismatch; runnerCompletion=not-applied` });
  }
  const expectedPaths = new Set(job.outputPaths);
  const receivedPaths = result.output.outputDigests.map(pathFromDigest);
  if (result.status === "succeeded" && (receivedPaths.some((path) => path === undefined || !expectedPaths.has(path)) || new Set(receivedPaths).size !== receivedPaths.length || receivedPaths.length !== expectedPaths.size)) {
    throw new AuthorityPlaneError({ code: "conflict", message: `Runner Result output paths do not exactly match the declared Action outputs.`, recoveryAction: "produce one digest for every declared output path and no undeclared paths; no Authority state was changed", receipt: `job=${job.id}; expectedOutputs=${job.outputPaths.join(",")}; receivedOutputs=${result.output.outputDigests.join(",")}; runnerCompletion=not-applied` });
  }
  for (const output of outputs) {
    const location = safeRunnerLocation(output.location, "runnerOutput.location");
    const root = output.kind === "log" ? job.outputLocations.logs : output.kind === "artifact" ? job.outputLocations.artifacts : job.outputLocations.evidence;
    if (!locationWithin(location, root) || !disclosureAllows(job.disclosure.classification, output.disclosure.classification)) {
      throw new AuthorityPlaneError({ code: "conflict", message: `Runner output ${output.id} is outside the declared output or disclosure boundary.`, recoveryAction: "return output references below the Run-scoped root and within the Project View disclosure; no Authority state was changed", receipt: `job=${job.id}; output=${output.id}; root=${root}; runnerCompletion=not-applied` });
    }
    requiredString(output.digest, `runnerOutput.${output.id}.digest`);
    if (output.attemptId !== job.currentAttemptId) {
      throw new AuthorityPlaneError({ code: "conflict", message: `Runner output ${output.id} is bound to a different Attempt.`, recoveryAction: "submit only output references produced by the current Runner Attempt; no Authority state was changed", receipt: `job=${job.id}; output=${output.id}; expectedAttempt=${job.currentAttemptId}; receivedAttempt=${output.attemptId}; runnerCompletion=not-applied` });
    }
    if (output.kind === "artifact" && !location.includes(attemptToken(output.attemptId))) {
      throw new AuthorityPlaneError({ code: "conflict", message: `Artifact output ${output.id} is not bound to its Attempt.`, recoveryAction: "include the current Attempt identity in the artifact output location; no Authority state was changed", receipt: `output=${output.id}; attempt=${output.attemptId}; runnerCompletion=not-applied` });
    }
  }
}

function attemptToken(attemptId: string): string {
  return requiredString(attemptId, "runnerOutput.attemptId");
}

function actorRef(session: AuthoritySession): ActorRef {
  return {
    principalId: session.principalId,
    actorId: session.actorId,
    sessionId: session.sessionId,
    clientId: session.clientId,
  };
}

function now(): string {
  return new Date().toISOString();
}

function changeOriginFromPayload(value: unknown): Change["origin"] | undefined {
  if (value === undefined) return undefined;
  const origin = safeObject(value, "origin");
  const kind = enumString(origin.kind, "origin.kind", ["local", "mirror"] as const);
  const disclosure = enumString(origin.disclosure, "origin.disclosure", ["public", "project", "restricted"] as const);
  const remoteAuthorValue = origin.remoteAuthor === undefined ? undefined : safeObject(origin.remoteAuthor, "origin.remoteAuthor");
  const remoteAuthor = remoteAuthorValue
    ? (() => { const email = optionalString(remoteAuthorValue.email); return { name: requiredString(remoteAuthorValue.name, "origin.remoteAuthor.name"), ...(email ? { email } : {}) }; })()
    : undefined;
  const proposalKind = origin.externalProposalKind === undefined
    ? undefined
    : enumString(origin.externalProposalKind, "origin.externalProposalKind", ["pull-request", "ref", "commit"] as const);
  const mirrorId = optionalString(origin.mirrorId);
  const remoteRepository = optionalString(origin.remoteRepository);
  const remoteRef = optionalString(origin.remoteRef);
  const remoteCommit = optionalString(origin.remoteCommit);
  const externalProposalKey = optionalString(origin.externalProposalKey);
  const externalProposalHead = optionalString(origin.externalProposalHead);
  const externalProposalBase = optionalString(origin.externalProposalBase);
  const externalProposalInstallation = optionalString(origin.externalProposalInstallation);
  const externalProposalSourceIdentity = optionalString(origin.externalProposalSourceIdentity);
  const externalDeliveryId = optionalString(origin.externalDeliveryId);
  return {
    kind,
    source: requiredString(origin.source, "origin.source"),
    ...(mirrorId ? { mirrorId } : {}),
    ...(remoteRepository ? { remoteRepository } : {}),
    ...(remoteRef ? { remoteRef } : {}),
    ...(remoteCommit ? { remoteCommit } : {}),
    ...(remoteAuthor ? { remoteAuthor } : {}),
    ...(externalProposalKey ? { externalProposalKey } : {}),
    ...(proposalKind ? { externalProposalKind: proposalKind } : {}),
    ...(externalProposalHead ? { externalProposalHead } : {}),
    ...(externalProposalBase ? { externalProposalBase } : {}),
    ...(externalProposalInstallation ? { externalProposalInstallation } : {}),
    ...(externalProposalSourceIdentity ? { externalProposalSourceIdentity } : {}),
    ...(externalDeliveryId ? { externalDeliveryId } : {}),
    disclosure,
    receipt: receiptString(origin.receipt, "origin.receipt"),
  };
}

function mirrorProposalLedgerKey(input: { provider: string; installationId?: string; sourceIdentity: string; remoteRepository: string; proposalKind: string; proposalKey: string }): string {
  return JSON.stringify([input.provider, input.installationId ?? "-", input.sourceIdentity, input.remoteRepository, input.proposalKind, input.proposalKey]);
}

function mirrorDeliveryLedgerKey(input: { provider: string; installationId?: string; sourceIdentity: string; remoteRepository: string; deliveryId: string }): string {
  return JSON.stringify([input.provider, input.installationId ?? "-", input.sourceIdentity, input.remoteRepository, input.deliveryId]);
}

export function emptyAuthorityPlaneSnapshot(realmId: string): AuthorityPlaneSnapshot {
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    realmId,
    version: 0,
    projects: {},
    sourceSpaces: {},
    projectRevisions: {},
    intents: {},
    intentComments: {},
    projectViews: {},
    workspaces: {},
    changes: {},
    changeRevisions: {},
    runs: {},
    runnerProfiles: {},
    runnerAttempts: {},
    evidence: {},
    artifacts: {},
    landings: {},
    releases: {},
    targets: {},
    promotions: {},
    mirrors: {},
    mirrorOperations: {},
    mirrorCheckpoints: {},
    externalProposals: {},
    mirrorDeliveries: {},
    canonicalByProject: {},
    idempotency: {},
    audit: [],
  };
}

/** Hydrate snapshots written before the mirror ledger was introduced. The
 * Durable Object may reopen an older JSON value, so missing maps are treated
 * as empty rather than becoming a silent runtime failure. */
export function normalizeAuthorityPlaneSnapshot(snapshot: AuthorityPlaneSnapshot): AuthorityPlaneSnapshot {
  const externalProposalEntries: Array<[string, ExternalProposal]> = [];
  for (const proposal of Object.values(snapshot.externalProposals ?? {})) {
    const ledgerKey = mirrorProposalLedgerKey({ provider: proposal.provider, ...(proposal.installationId ? { installationId: proposal.installationId } : {}), sourceIdentity: proposal.sourceIdentity, remoteRepository: proposal.remoteRepository, proposalKind: proposal.proposalKind, proposalKey: proposal.proposalKey });
    const normalized = { ...proposal, ledgerKey };
    const existing = externalProposalEntries.find(([key]) => key === ledgerKey);
    if (existing && existing[1].id !== normalized.id) throw new AuthorityPlaneError({ code: "indeterminate", message: `External proposal ledger key ${ledgerKey} is claimed by multiple restored proposals.`, recoveryAction: "repair the credential-free export so each provider proposal identity is unique, then restore again", receipt: `proposalLedgerKey=${ledgerKey}; restore=blocked; duplicate=true` });
    if (!existing) externalProposalEntries.push([ledgerKey, normalized]);
  }
  const externalProposals = Object.fromEntries(externalProposalEntries);
  const mirrorDeliveryEntries: Array<[string, MirrorDelivery]> = [];
  for (const delivery of Object.values(snapshot.mirrorDeliveries ?? {})) {
    const deliveryKey = mirrorDeliveryLedgerKey({ provider: delivery.provider, ...(delivery.installationId ? { installationId: delivery.installationId } : {}), sourceIdentity: delivery.sourceIdentity, remoteRepository: delivery.remoteRepository, deliveryId: delivery.deliveryId });
    const normalized = { ...delivery, deliveryKey };
    const existing = mirrorDeliveryEntries.find(([key]) => key === deliveryKey);
    if (existing && existing[1].id !== normalized.id) throw new AuthorityPlaneError({ code: "indeterminate", message: `Mirror delivery ledger key ${deliveryKey} is claimed by multiple restored deliveries.`, recoveryAction: "repair the credential-free export so each provider delivery identity is unique, then restore again", receipt: `deliveryKey=${deliveryKey}; restore=blocked; duplicate=true` });
    if (!existing) mirrorDeliveryEntries.push([deliveryKey, normalized]);
  }
  const mirrorDeliveries = Object.fromEntries(mirrorDeliveryEntries);
  const targets = Object.fromEntries(Object.entries(snapshot.targets ?? {}).map(([id, target]) => [id, { ...target, deploymentProfile: targetDeploymentProfile(target) }]));
  return {
    ...snapshot,
    intents: snapshot.intents ?? {},
    intentComments: snapshot.intentComments ?? {},
    runnerProfiles: snapshot.runnerProfiles ?? {},
    runnerAttempts: snapshot.runnerAttempts ?? {},
    mirrors: snapshot.mirrors ?? {},
    mirrorOperations: snapshot.mirrorOperations ?? {},
    mirrorCheckpoints: snapshot.mirrorCheckpoints ?? {},
    targets,
    externalProposals,
    mirrorDeliveries,
  };
}

export class AuthorityPlaneCoordinator {
  private state: AuthorityPlaneSnapshot;

  constructor(snapshot: AuthorityPlaneSnapshot) {
    this.state = clone(normalizeAuthorityPlaneSnapshot(snapshot));
  }

  snapshot(): AuthorityPlaneSnapshot {
    return clone(this.state);
  }

  /**
   * Copy an already enrolled Runner identity into the durable Authority
   * snapshot. This is intentionally an in-process adapter seam: there is no
   * public Authority command that lets a browser, agent, or MCP client enroll
   * a signing key. The Runner service must perform its own enrollment and
   * then synchronize the credential-free profile here.
   */
  registerRunnerProfile(profile: RunnerProfile, session: AuthoritySession): void {
    if (session.kind !== "runner" || session.clientId !== "anyam-runner-coordinator") {
      throw new AuthorityPlaneError({ code: "invalid_request", message: "Only the internal Runner coordinator may synchronize Runner enrollment.", recoveryAction: "synchronize the enrolled profile through the bound Runner service; no Authority state was changed", receipt: `client=${session.clientId}; kind=${session.kind ?? "unspecified"}; runner=${profile.id}; enrollment=not-applied` });
    }
    if (profile.realmId !== this.state.realmId) {
      throw new AuthorityPlaneError({
        code: "invalid_request",
        message: `Runner ${profile.id} belongs to a different Realm.`,
        recoveryAction: "synchronize only an enrolled Runner profile from the current Realm; no Authority state was changed",
        receipt: `runner=${profile.id}; profileRealm=${profile.realmId}; authorityRealm=${this.state.realmId}; enrollment=not-applied`,
      });
    }
    const existing = this.state.runnerProfiles[profile.id];
    if (existing && existing.profileDigest !== profile.profileDigest) {
      throw new AuthorityPlaneError({
        code: "conflict",
        message: `Runner ${profile.id} is already enrolled with a different profile digest.`,
        recoveryAction: "rotate the Runner through an explicit enrollment ceremony; do not replace an enrolled public key implicitly",
        receipt: `runner=${profile.id}; existingProfileDigest=${existing.profileDigest}; receivedProfileDigest=${profile.profileDigest}; enrollment=not-applied`,
      });
    }
    if (existing) return;
    this.state.runnerProfiles[profile.id] = clone(profile);
    this.state.version += 1;
    this.state.audit.push({ id: opaqueId("authority-audit"), command: "runner.register", idempotencyKey: `runner.register:${profile.id}:${profile.profileDigest}`, actor: actorRef(session), outcome: "succeeded", stateVersion: this.state.version, occurredAt: now(), receipt: `runner=${profile.id}; enrollment=synchronized; profileDigest=${profile.profileDigest}; credentialMaterialStored=false` });
  }

  execute(command: AuthorityCommand, session: AuthoritySession): AuthorityCommandResult {
    if (command.command === "runner.complete") {
      throw new AuthorityPlaneError({
        code: "invalid_request",
        message: "runner.complete is an internal asynchronous transition and cannot be executed through the generic Authority command path.",
        recoveryAction: "submit the signed completion through the bound Runner service; no Authority state was changed",
        receipt: "command=runner.complete; surface=generic-authority; transition=not-applied; internalOnly=true",
      });
    }
    if (command.protocol !== AUTHORITY_COMMAND_PROTOCOL) {
      throw new AuthorityPlaneError({
        code: "invalid_request",
        message: `Unsupported authority command protocol ${command.protocol}.`,
        recoveryAction: "send an anyam.authority-command/v1 envelope; no authority transition was accepted",
        receipt: `protocol=${command.protocol}; transition=not-applied`,
      });
    }
    if (session.realmId !== this.state.realmId) {
      throw new AuthorityPlaneError({
        code: "invalid_request",
        message: "The authenticated session belongs to a different Realm.",
        recoveryAction: "route the command through the Durable Object bound to the authenticated Realm",
        receipt: `sessionRealm=${session.realmId}; stateRealm=${this.state.realmId}; transition=not-applied`,
      });
    }
    const idempotencyKey = requiredString(command.idempotencyKey, "idempotencyKey");
    const existing = this.state.idempotency[idempotencyKey];
    const requestFingerprint = fingerprint({ ...command, idempotencyKey });
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new AuthorityPlaneError({
          code: "idempotency_conflict",
          message: `Idempotency key ${idempotencyKey} was already used for a different Authority command.`,
          recoveryAction: "reuse the original command payload or choose a new idempotency key; authoritative state was unchanged",
          receipt: `idempotencyKey=${idempotencyKey}; conflict=true; stateVersion=${this.state.version}; overwritten=false`,
        });
      }
      return clone(existing.result);
    }
    if (command.expectedVersion !== undefined && command.expectedVersion !== this.state.version) {
      throw new AuthorityPlaneError({
        code: "stale_state",
        message: `Authority state changed before ${command.command} was accepted.`,
        recoveryAction: "read the current authority state and retry the same intent with its version and a fresh idempotency key",
        receipt: `expectedVersion=${command.expectedVersion}; actualVersion=${this.state.version}; overwritten=false`,
      });
    }

    const next = clone(this.state);
    const result = this.apply(next, command, session);
    next.version += 1;
    result.version = next.version;
    next.idempotency[idempotencyKey] = { fingerprint: requestFingerprint, result: clone(result) };
    next.audit.push({
      id: opaqueId("authority-audit"),
      command: command.command,
      idempotencyKey,
      actor: actorRef(session),
      outcome: result.status,
      stateVersion: next.version,
      occurredAt: now(),
      ...(session.taskId ? { taskId: session.taskId } : {}),
      ...(session.capabilityGrantId ? { capabilityGrantId: session.capabilityGrantId } : {}),
      ...(session.delegatedBySessionId ? { delegatedBySessionId: session.delegatedBySessionId } : {}),
      ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}),
      receipt: result.receipt,
    });
    this.state = next;
    return clone(result);
  }

  /**
   * Consume one signed Runner completion. This is deliberately asynchronous
   * because Ed25519 verification is performed with Web Crypto. The state is
   * cloned and committed only after every Run, Evidence, Artifact, Attempt,
   * and digest check succeeds, so a rejected completion cannot leave a
   * half-terminal Authority snapshot behind.
   */
  async completeRunner(command: AuthorityCommand, session: AuthoritySession): Promise<AuthorityCommandResult> {
    if (command.protocol !== AUTHORITY_COMMAND_PROTOCOL) {
      throw new AuthorityPlaneError({ code: "invalid_request", message: `Unsupported authority command protocol ${command.protocol}.`, recoveryAction: "send an anyam.authority-command/v1 envelope; no authority transition was accepted", receipt: `protocol=${command.protocol}; command=runner.complete; transition=not-applied` });
    }
    if (command.command !== "runner.complete") {
      throw new AuthorityPlaneError({ code: "invalid_request", message: "The Runner completion boundary accepts only runner.complete.", recoveryAction: "send command=runner.complete through the internal Runner service; no authority transition was accepted", receipt: `command=${command.command}; runnerCompletion=not-accepted` });
    }
    if (session.realmId !== this.state.realmId) {
      throw new AuthorityPlaneError({ code: "invalid_request", message: "The Runner completion session belongs to a different Realm.", recoveryAction: "route the completion through the Durable Object bound to the Runner Realm", receipt: `sessionRealm=${session.realmId}; stateRealm=${this.state.realmId}; runnerCompletion=not-accepted` });
    }
    if (session.kind !== "runner" || session.clientId !== "anyam-runner-coordinator") {
      throw new AuthorityPlaneError({ code: "invalid_request", message: "Only the internal Runner coordinator may submit runner.complete.", recoveryAction: "submit the signed completion through the bound Runner service; browser, agent, OAuth, and MCP sessions cannot complete Runs", receipt: `client=${session.clientId}; kind=${session.kind ?? "unspecified"}; runnerCompletion=not-accepted` });
    }
    const idempotencyKey = requiredString(command.idempotencyKey, "idempotencyKey");
    const existing = this.state.idempotency[idempotencyKey];
    const requestFingerprint = fingerprint({ ...command, idempotencyKey });
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new AuthorityPlaneError({ code: "idempotency_conflict", message: `Idempotency key ${idempotencyKey} was already used for a different Runner completion.`, recoveryAction: "reuse the original signed completion or choose a new idempotency key; authoritative state was unchanged", receipt: `idempotencyKey=${idempotencyKey}; conflict=true; runnerCompletion=not-applied` });
      }
      return clone(existing.result);
    }
    if (command.expectedVersion !== undefined && command.expectedVersion !== this.state.version) {
      throw new AuthorityPlaneError({ code: "stale_state", message: `Authority state changed before Runner completion ${idempotencyKey} was accepted.`, recoveryAction: "read the current Authority version and retry the same signed completion with a fresh idempotency key", receipt: `expectedVersion=${command.expectedVersion}; actualVersion=${this.state.version}; runnerCompletion=not-applied` });
    }
    const next = clone(this.state);
    const result = await this.applyRunnerCompletion(next, command, session);
    next.version += 1;
    result.version = next.version;
    next.idempotency[idempotencyKey] = { fingerprint: requestFingerprint, result: clone(result) };
    next.audit.push({
      id: opaqueId("authority-audit"),
      command: command.command,
      idempotencyKey,
      actor: actorRef(session),
      outcome: result.status,
      stateVersion: next.version,
      occurredAt: now(),
      ...(session.taskId ? { taskId: session.taskId } : {}),
      ...(session.capabilityGrantId ? { capabilityGrantId: session.capabilityGrantId } : {}),
      ...(session.delegatedBySessionId ? { delegatedBySessionId: session.delegatedBySessionId } : {}),
      ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}),
      receipt: result.receipt,
    });
    this.state = next;
    return clone(result);
  }

  private async applyRunnerCompletion(next: AuthorityPlaneSnapshot, command: AuthorityCommand, session: AuthoritySession): Promise<AuthorityCommandResult> {
    const payload = command.payload;
    const completionValue = record(payload.completion, "completion");
    const result = record(completionValue.result, "completion.result") as unknown as RunnerResult;
    const job = completionValue.job as unknown as RunnerJob;
    const attempt = completionValue.attempt as unknown as RunnerAttempt;
    const runner = completionValue.runnerProfile as unknown as RunnerProfile;
    const completionRun = completionValue.run as unknown as Run;
    const outputsValue = completionValue.outputs;
    if (!Array.isArray(outputsValue)) throw new AuthorityPlaneError({ code: "invalid_request", message: "completion.outputs must be an array.", recoveryAction: "send the exact credential-free output references returned by the Runner coordinator", receipt: "runnerCompletion=invalid; outputs=array-required; transition=not-applied" });
    const outputs = outputsValue as RunnerOutputReference[];
    const resultDigest = requiredString(completionValue.resultDigest, "completion.resultDigest");
    const credentialState = requiredString(completionValue.credentialState, "completion.credentialState");
    if (credentialState !== "closed") throw new AuthorityPlaneError({ code: "conflict", message: "Runner completion arrived while its Attempt credential was not closed.", recoveryAction: "revoke the Attempt credential in the Runner coordinator before submitting completion; no Authority state was changed", receipt: `attempt=${attempt?.id ?? "unknown"}; credentialState=${credentialState}; runnerCompletion=not-applied` });
    const completionReceipt = receiptString(completionValue.receipt, "completion.receipt");
    const runnerId = requiredString(runner?.id, "completion.runnerProfile.id");
    const registeredRunner = next.runnerProfiles[runnerId];
    if (!registeredRunner) throw new AuthorityPlaneError({ code: "not_found", message: `Runner ${runnerId} is not enrolled in the Authority Realm.`, recoveryAction: "enroll and synchronize the Runner profile before submitting a completion", receipt: `runner=${runnerId}; enrolled=false; runnerCompletion=not-applied` });
    if (registeredRunner.profileDigest !== runner.profileDigest || registeredRunner.publicKey !== runner.publicKey) throw new AuthorityPlaneError({ code: "conflict", message: `Runner ${runnerId} completion uses a different enrolled profile.`, recoveryAction: "submit with the exact credential-free profile synchronized during Runner enrollment", receipt: `runner=${runnerId}; profileDigest=not-matched; runnerCompletion=not-applied` });
    if (registeredRunner.status !== "active" && registeredRunner.status !== "enrolled") throw new AuthorityPlaneError({ code: "blocked", message: `Runner ${runnerId} is ${registeredRunner.status} and cannot complete a Run.`, recoveryAction: "reactivate or replace the Runner, reconcile provider state, and retry from a fresh Attempt", receipt: `runner=${runnerId}; status=${registeredRunner.status}; runnerCompletion=not-applied` });
    if (job?.id === undefined || attempt?.id === undefined || completionRun?.id === undefined) throw new AuthorityPlaneError({ code: "invalid_request", message: "Runner completion is missing its Job, Attempt, or Run identity.", recoveryAction: "send the complete credential-free Runner completion envelope; no Authority state was changed", receipt: "runnerCompletion=identity-missing; transition=not-applied" });
    const run = next.runs[completionRun.id];
    if (!run) throw new AuthorityPlaneError({ code: "not_found", message: `Queued Run ${completionRun.id} is not present in Authority.`, recoveryAction: "request a fresh Run and submit its matching Runner completion; no Authority state was changed", receipt: `run=${completionRun.id}; runnerCompletion=not-applied; discoverable=false` });
    if (run.status !== "queued" && run.status !== "running") throw new AuthorityPlaneError({ code: "conflict", message: `Run ${run.id} is already ${run.status}; this Runner completion is a replay or stale Attempt.`, recoveryAction: "inspect the accepted Run result and do not replay the signed completion", receipt: `run=${run.id}; status=${run.status}; attempt=${attempt.id}; runnerCompletion=not-applied` });
    if (job.runId !== run.id || attempt.runId !== run.id || completionRun.id !== job.runId) throw new AuthorityPlaneError({ code: "conflict", message: "Runner Job, Attempt, and Run identities do not agree.", recoveryAction: "submit the completion produced for the exact queued Run; no Authority state was changed", receipt: `run=${run.id}; jobRun=${job.runId}; attemptRun=${attempt.runId}; runnerCompletion=not-applied` });
    if (attempt.jobId !== job.id || job.currentAttemptId !== attempt.id || attempt.runnerId !== runnerId || job.currentRunnerId !== runnerId) throw new AuthorityPlaneError({ code: "conflict", message: "Runner Job and Attempt are not the current enrolled Runner Attempt.", recoveryAction: "submit only the current Attempt returned by the Runner coordinator; no Authority state was changed", receipt: `job=${job.id}; attempt=${attempt.id}; runner=${runnerId}; runnerCompletion=not-applied` });
    if (job.state !== result.status || attempt.state !== result.status || completionRun.status !== result.status) throw new AuthorityPlaneError({ code: "conflict", message: "Runner completion states do not agree across Job, Attempt, Result, and Run.", recoveryAction: "return one immutable completion with matching succeeded, failed, or indeterminate states", receipt: `jobState=${job.state}; attemptState=${attempt.state}; resultStatus=${result.status}; runStatus=${completionRun.status}; runnerCompletion=not-applied` });
    const expectedRunFields: Array<[string, unknown, unknown]> = [
      ["actionId", run.actionId, job.actionId],
      ["projectRevisionId", run.projectRevisionId, job.projectRevisionId],
      ["projectViewId", run.projectViewId, job.projectViewId],
      ["changeRevisionId", run.changeRevisionId, job.changeRevisionId],
      ["workspaceId", run.workspaceId, job.workspaceId],
      ["verifierId", run.verifierId, job.verifierId],
      ["actionContractDigest", run.actionContractDigest, job.actionContractDigest],
      ["verifierContractDigest", run.verifierContractDigest, job.verifierContractDigest],
      ["policyVersion", run.policyVersion, job.policyVersion],
      ["capabilityGrantId", run.capabilityGrantId, job.capabilityGrantId],
    ];
    for (const [field, expected, received] of expectedRunFields) if (expected !== received) throw new AuthorityPlaneError({ code: "conflict", message: `Runner completion ${field} does not match queued Run ${run.id}.`, recoveryAction: "re-run the exact Authority Run request and submit its matching Runner Job; no Authority state was changed", receipt: `run=${run.id}; field=${field}; expected=${String(expected)}; received=${String(received)}; runnerCompletion=not-applied` });
    if (!sameStrings(run.inputDigests ?? [], job.inputDigests) || !sameStrings(run.effectDigests ?? [], job.effectDigests)) throw new AuthorityPlaneError({ code: "conflict", message: `Runner Job inputs or effects do not match queued Run ${run.id}.`, recoveryAction: "submit the result from the immutable input manifest recorded for this Run", receipt: `run=${run.id}; inputOrEffects=not-matched; runnerCompletion=not-applied` });
    const context = result.context;
    const expectedContext = {
      protocol: "anyam.runner-result-context/v1",
      replayId: `${job.id}:${attempt.id}`,
      jobId: job.id,
      attemptId: attempt.id,
      runnerId,
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
      networkEnforcement: job.networkEnforcement,
      networkBoundaryReceipt: job.networkBoundaryReceipt,
    };
    if (!context || stableJson(context) !== stableJson(expectedContext)) throw new AuthorityPlaneError({ code: "conflict", message: `Runner Result context does not match Attempt ${attempt.id}.`, recoveryAction: "echo the exact signed context issued by the enrolled Runner coordinator; no Authority state was changed", receipt: `job=${job.id}; attempt=${attempt.id}; context=not-matched; runnerCompletion=not-applied` });
    const message = runnerResultMessage({ context: result.context, status: result.status, output: result.output, outputs: result.outputs, ...(result.recoveryAction ? { recoveryAction: result.recoveryAction } : {}) });
    if (!(await verifyRunnerResultSignature({ publicKey: registeredRunner.publicKey, message, signature: requiredString(result.signature, "completion.result.signature") }))) throw new AuthorityPlaneError({ code: "blocked", message: `Runner ${runnerId} signed Result verification failed.`, recoveryAction: "submit the exact Result signed by the enrolled Runner key before the Attempt lease expires", receipt: `runner=${runnerId}; attempt=${attempt.id}; resultSignature=invalid; runnerCompletion=not-applied` });
    const recomputedDigest = await runnerResultDigest({ jobId: job.id, attemptId: attempt.id, result });
    if (recomputedDigest !== resultDigest || (attempt.resultDigest && attempt.resultDigest !== resultDigest)) throw new AuthorityPlaneError({ code: "conflict", message: `Runner Result digest does not match Attempt ${attempt.id}.`, recoveryAction: "submit the unchanged signed Result returned by the Runner coordinator; no Authority state was changed", receipt: `job=${job.id}; attempt=${attempt.id}; expectedDigest=${attempt.resultDigest ?? recomputedDigest}; receivedDigest=${resultDigest}; runnerCompletion=not-applied` });
    const signedOutputShape = result.outputs.map((output) => ({ kind: output.kind, location: output.location, digest: output.digest, disclosure: output.disclosure, receipt: output.receipt }));
    const receivedOutputShape = outputs.map((output) => ({ kind: output.kind, location: output.location, digest: output.digest, disclosure: output.disclosure, receipt: output.receipt }));
    if (stableJson(signedOutputShape) !== stableJson(receivedOutputShape)) throw new AuthorityPlaneError({ code: "conflict", message: `Runner completion outputs differ from the signed Result envelope.`, recoveryAction: "forward the exact output references returned by the Runner coordinator; no Authority state was changed", receipt: `job=${job.id}; attempt=${attempt.id}; outputs=signed-shape-mismatch; runnerCompletion=not-applied` });
    validateRunnerCompletionOutputScope(job, result, outputs);
    const terminalRun: Run = {
      ...run,
      runnerId,
      attemptId: attempt.id,
      status: result.status,
      outputDigest: result.output.outputDigest,
      inputDigests: [...result.output.inputDigests],
      outputDigests: [...result.output.outputDigests],
      effectDigests: [...job.effectDigests],
      dependencyDigest: job.dependencyDigest,
      toolchainDigest: job.toolchainDigest,
      environmentDigest: job.environmentDigest,
      actor: { ...job.actor },
      capabilityGrantId: job.capabilityGrantId,
      ...(result.output.exitCode === undefined ? {} : { exitCode: result.output.exitCode }),
      stdoutDigest: result.output.stdoutDigest,
      stderrDigest: result.output.stderrDigest,
      ...(job.targetId ? { targetId: job.targetId } : {}),
    };
    const evidenceId = `evidence:${attempt.id}`;
    if (next.evidence[evidenceId]) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence ${evidenceId} already exists for Attempt ${attempt.id}.`, recoveryAction: "reuse the original Authority idempotency key or inspect the accepted completion; no state was changed", receipt: `evidence=${evidenceId}; attempt=${attempt.id}; runnerCompletion=not-applied` });
    const evidence: Evidence = {
      protocol: CONTRACT_VERSIONS.evidence,
      version: "v1",
      id: evidenceId,
      key: `runner:${job.actionId}:${job.verifierId ?? "action"}`,
      criterion: "The enrolled Runner signed the exact Action result for the recorded Project Revision.",
      outcome: result.status === "succeeded" ? "passed" : result.status === "failed" ? "failed" : "indeterminate",
      validityKey: `${job.projectRevisionId}:${job.actionContractDigest}:${job.verifierContractDigest ?? "none"}:${resultDigest}`,
      actionId: job.actionId,
      verifierId: job.verifierId ?? "verifier:runner-result",
      toolchainDigest: job.toolchainDigest,
      dependencyDigest: job.dependencyDigest,
      environmentDigest: job.environmentDigest,
      inputDigests: [...job.inputDigests],
      effectDigests: [...job.effectDigests],
      outputDigest: result.output.outputDigest,
      createdAt: now(),
      producer: { kind: "run", id: run.id, version: CONTRACT_VERSIONS.run },
      projectRevisionId: run.projectRevisionId,
      projectViewId: run.projectViewId,
      ...(run.changeRevisionId ? { changeRevisionId: run.changeRevisionId } : {}),
      runId: run.id,
      actor: { ...job.actor },
      runnerId,
      policyVersion: job.policyVersion,
      authorizationEpoch: job.authorizationEpoch,
      capabilityGrantId: job.capabilityGrantId,
      disclosure: { ...job.disclosure },
      receipt: `${completionReceipt}; runnerSignature=verified; resultDigest=${resultDigest}; outputReadBack=runner-attested; credentialState=closed`,
      invalidators: ["project-revision", "action-contract", "verifier-contract", "runner-profile", "policy-version"],
      owner: runnerId,
      ...(job.targetId ? { targetId: job.targetId } : {}),
      ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
      sourceSpaceSnapshots: { ...job.sourceSpaceSnapshots },
      actionContractDigest: job.actionContractDigest,
      ...(job.verifierContractDigest ? { verifierContractDigest: job.verifierContractDigest } : {}),
    };
    const artifacts: Artifact[] = outputs.filter((output) => output.kind === "artifact").map((output, index) => {
      const id = output.id || `artifact:${attempt.id}:${index + 1}`;
      if (next.artifacts[id]) throw new AuthorityPlaneError({ code: "conflict", message: `Artifact ${id} already exists for Attempt ${attempt.id}.`, recoveryAction: "reuse the original Authority idempotency key or inspect the accepted completion; no state was changed", receipt: `artifact=${id}; attempt=${attempt.id}; runnerCompletion=not-applied` });
      return { protocol: CONTRACT_VERSIONS.artifact, id, type: "runner.output", digest: output.digest, projectRevisionId: run.projectRevisionId, ...(run.changeRevisionId ? { changeRevisionId: run.changeRevisionId } : {}), runId: run.id, actionId: job.actionId, outputPath: output.location, provenanceDigest: resultDigest, disclosure: { ...output.disclosure } };
    });
    next.runs[run.id] = terminalRun;
    next.evidence[evidence.id] = evidence;
    for (const artifact of artifacts) next.artifacts[artifact.id] = artifact;
    next.runnerAttempts[attempt.id] = clone(attempt);
    return { protocol: AUTHORITY_PLANE_PROTOCOL, command: command.command, status: result.status === "indeterminate" ? "indeterminate" : "succeeded", version: next.version, value: { run: terminalRun, evidence, artifacts, attempt: clone(attempt), runner: clone(registeredRunner) }, receipt: `run=${run.id}; attempt=${attempt.id}; runner=${runnerId}; status=${result.status}; evidence=${evidence.id}; artifacts=${artifacts.length}; resultDigest=${resultDigest}; credentialState=closed; outputReadBack=runner-attested; canonicalWrite=false`, ...(result.status === "indeterminate" ? { recoveryAction: result.recoveryAction ?? "reconcile the Runner provider result before using this Evidence or Artifact" } : {}) };
  }

  /**
   * Execute one already-recorded Promotion through a trusted provider
   * capability. The executor is injected by the coordinator boundary; a
   * caller can supply only the Promotion identity and execution idempotency
   * key. Provider results are validated against a detached Authority context
   * before the Target pointer or Promotion state changes.
   */
  async executePromotion(input: PromotionExecutionRequest): Promise<AuthorityCommandResult> {
    if (input.session.realmId !== this.state.realmId) {
      throw new AuthorityPlaneError({
        code: "invalid_request",
        message: "The authenticated session belongs to a different Realm.",
        recoveryAction: "route Promotion execution through the coordinator bound to the authenticated Realm",
        receipt: `sessionRealm=${input.session.realmId}; stateRealm=${this.state.realmId}; promotionExecution=not-accepted`,
      });
    }
    const executionIdempotencyKey = requiredString(input.executionIdempotencyKey, "executionIdempotencyKey");
    const idempotencyKey = `promotion.execute:${executionIdempotencyKey}`;
    const command: AuthorityCommand = {
      protocol: AUTHORITY_COMMAND_PROTOCOL,
      command: "promotion.execute",
      idempotencyKey,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      payload: { promotionId: input.promotionId, executionIdempotencyKey },
    };
    const existing = this.state.idempotency[idempotencyKey];
    const requestFingerprint = fingerprint(command);
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new AuthorityPlaneError({
          code: "idempotency_conflict",
          message: `Execution idempotency key ${executionIdempotencyKey} was already used for a different Promotion handoff.`,
          recoveryAction: "reuse the original execution payload or choose a new execution idempotency key",
          receipt: `executionIdempotencyKey=${executionIdempotencyKey}; conflict=true; stateVersion=${this.state.version}; overwritten=false`,
        });
      }
      return clone(existing.result);
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== this.state.version) {
      throw new AuthorityPlaneError({
        code: "stale_state",
        message: `Authority state changed before Promotion ${input.promotionId} execution was accepted.`,
        recoveryAction: "read the current Authority state and retry with a fresh execution idempotency key",
        receipt: `expectedVersion=${input.expectedVersion}; actualVersion=${this.state.version}; promotionExecution=not-accepted`,
      });
    }

    const promotion = this.state.promotions[input.promotionId];
    if (!promotion) {
      throw new AuthorityPlaneError({
        code: "not_found",
        message: `Promotion ${input.promotionId} does not exist.`,
        recoveryAction: "inspect the authoritative Promotion ledger and retry with the recorded Promotion ID",
        receipt: `promotion=${input.promotionId}; execution=not-started; discoverable=false`,
      });
    }
    if (promotion.executionIdempotencyKey && promotion.executionIdempotencyKey !== executionIdempotencyKey) {
      throw new AuthorityPlaneError({
        code: "conflict",
        message: `Promotion ${promotion.id} already has immutable execution identity ${promotion.executionIdempotencyKey}.`,
        recoveryAction: "use promotion.reconcile with the recorded execution identity; do not start a superseding provider operation",
        receipt: `promotion=${promotion.id}; requestedExecution=${executionIdempotencyKey}; recordedExecution=${promotion.executionIdempotencyKey}; providerInvocation=false`,
      });
    }
    if (!["blocked", "failed", "degraded"].includes(promotion.state)) {
      if (promotion.state === "healthy" || promotion.state === "rolled-back") {
        const target = this.state.targets[promotion.targetId];
        const release = this.state.releases[promotion.releaseId];
        const result: AuthorityCommandResult = {
          protocol: AUTHORITY_PLANE_PROTOCOL,
          command: "promotion.execute",
          status: "succeeded",
          version: this.state.version,
          value: { promotion, target, release },
          receipt: `promotion=${promotion.id}; execution=already-terminal; state=${promotion.state}; providerInvocation=false; credentialFree=true; canonicalWrite=false`,
        };
        this.state.idempotency[idempotencyKey] = { fingerprint: requestFingerprint, result: clone(result) };
        return clone(result);
      }
      throw new AuthorityPlaneError({
        code: "conflict",
        message: `Promotion ${promotion.id} is ${promotion.state}; it is not ready for a provider handoff.`,
        recoveryAction: "wait for a recoverable Promotion state or request a new Promotion without changing the existing record",
        receipt: `promotion=${promotion.id}; state=${promotion.state}; execution=not-started`,
      });
    }

    return this.runPromotionExecution({ promotion, promotionId: input.promotionId, executionIdempotencyKey, authorityIdempotencyKey: idempotencyKey, requestFingerprint, executor: input.executor, session: input.session, operation: "promotion.execute" });
  }

  /**
   * Resume one degraded/failed handoff without minting a new provider
   * operation. The operator supplies a fresh reconciliation request key for
   * the Authority ledger; the provider identity comes only from the durable
   * Promotion checkpoint.
   */
  async reconcilePromotion(input: PromotionReconciliationRequest): Promise<AuthorityCommandResult> {
    if (input.session.realmId !== this.state.realmId) {
      throw new AuthorityPlaneError({
        code: "invalid_request",
        message: "The authenticated session belongs to a different Realm.",
        recoveryAction: "route Promotion reconciliation through the coordinator bound to the authenticated Realm",
        receipt: `sessionRealm=${input.session.realmId}; stateRealm=${this.state.realmId}; promotionReconcile=not-accepted`,
      });
    }
    const reconciliationIdempotencyKey = requiredString(input.reconciliationIdempotencyKey, "reconciliationIdempotencyKey");
    const idempotencyKey = `promotion.reconcile:${reconciliationIdempotencyKey}`;
    const promotion = this.state.promotions[input.promotionId];
    if (!promotion) {
      throw new AuthorityPlaneError({
        code: "not_found",
        message: `Promotion ${input.promotionId} does not exist.`,
        recoveryAction: "inspect the authoritative Promotion ledger and retry with the recorded Promotion ID",
        receipt: `promotion=${input.promotionId}; reconciliation=not-started; discoverable=false`,
      });
    }
    const executionIdempotencyKey = promotion.executionIdempotencyKey ?? promotion.reconciliationCheckpoint?.idempotencyKey;
    if (!executionIdempotencyKey) {
      throw new AuthorityPlaneError({
        code: "conflict",
        message: `Promotion ${promotion.id} has no recorded provider execution identity to reconcile.`,
        recoveryAction: "start the original Promotion execution first; reconciliation cannot invent a provider operation",
        receipt: `promotion=${promotion.id}; executionIdentity=missing; providerInvocation=false`,
      });
    }
    const command: AuthorityCommand = {
      protocol: AUTHORITY_COMMAND_PROTOCOL,
      command: "promotion.reconcile",
      idempotencyKey,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      payload: { promotionId: input.promotionId, executionIdempotencyKey },
    };
    const requestFingerprint = fingerprint(command);
    const existing = this.state.idempotency[idempotencyKey];
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new AuthorityPlaneError({
          code: "idempotency_conflict",
          message: `Reconciliation idempotency key ${reconciliationIdempotencyKey} was already used for a different Promotion identity.`,
          recoveryAction: "reuse the original reconciliation payload or choose a new reconciliation idempotency key",
          receipt: `reconciliationIdempotencyKey=${reconciliationIdempotencyKey}; conflict=true; overwritten=false`,
        });
      }
      return clone(existing.result);
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== this.state.version) {
      throw new AuthorityPlaneError({
        code: "stale_state",
        message: `Authority state changed before Promotion ${promotion.id} reconciliation was accepted.`,
        recoveryAction: "read the current Promotion status and retry reconciliation with a fresh request idempotency key",
        receipt: `expectedVersion=${input.expectedVersion}; actualVersion=${this.state.version}; promotionReconcile=not-accepted`,
      });
    }
    if (promotion.state === "healthy" || promotion.state === "rolled-back") {
      const target = this.state.targets[promotion.targetId];
      const release = this.state.releases[promotion.releaseId];
      const result: AuthorityCommandResult = {
        protocol: AUTHORITY_PLANE_PROTOCOL,
        command: "promotion.reconcile",
        status: "succeeded",
        version: this.state.version,
        value: { promotion, target, release, ...(promotion.reconciliationCheckpoint ? { checkpoint: promotion.reconciliationCheckpoint } : {}) },
        receipt: `promotion=${promotion.id}; reconciliation=already-terminal; state=${promotion.state}; providerInvocation=false; credentialFree=true; canonicalWrite=false`,
      };
      this.state.idempotency[idempotencyKey] = { fingerprint: requestFingerprint, result: clone(result) };
      return clone(result);
    }
    if (!["blocked", "failed", "degraded"].includes(promotion.state)) {
      throw new AuthorityPlaneError({
        code: "conflict",
        message: `Promotion ${promotion.id} is ${promotion.state}; it cannot be reconciled from this state.`,
        recoveryAction: "wait for a recoverable Promotion state or request a new Promotion without changing this record",
        receipt: `promotion=${promotion.id}; state=${promotion.state}; reconciliation=not-started`,
      });
    }
    return this.runPromotionExecution({ promotion, promotionId: input.promotionId, executionIdempotencyKey, authorityIdempotencyKey: idempotencyKey, requestFingerprint, executor: input.executor, session: input.session, operation: "promotion.reconcile" });
  }

  private async runPromotionExecution(input: {
    promotion: PromotionRecord;
    promotionId: string;
    executionIdempotencyKey: string;
    authorityIdempotencyKey: string;
    requestFingerprint: string;
    executor: PromotionExecutionRequest["executor"];
    session: AuthoritySession;
    operation: "promotion.execute" | "promotion.reconcile";
  }): Promise<AuthorityCommandResult> {
    let context;
    try {
      context = createPromotionExecutionContext({ snapshot: this.state, promotionId: input.promotionId, executionIdempotencyKey: input.executionIdempotencyKey, session: input.session });
    } catch (error) {
      if (error instanceof PromotionExecutionValidationError) {
        throw new AuthorityPlaneError({ code: "conflict", message: error.message, recoveryAction: error.recoveryAction, receipt: `${error.receipt}; promotionExecution=not-accepted` });
      }
      throw error;
    }

    let execution: PromotionExecutionResult;
    try {
      execution = await input.executor.execute(clone(context));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      execution = this.indeterminatePromotionExecution(input.promotion, input.promotionId, input.executionIdempotencyKey, context.executionDigest, `provider executor threw: ${message}`, "inspect the provider operation by its immutable execution identity before retrying", `promotion=${input.promotion.id}; providerResult=thrown; message=${message}`);
    }

    const next = clone(this.state);
    let normalized: PromotionExecutionResult;
    try {
      normalized = normalizePromotionExecutionResult(context, execution);
    } catch (error) {
      if (!(error instanceof PromotionExecutionValidationError)) throw error;
      normalized = this.indeterminatePromotionExecution(input.promotion, input.promotionId, input.executionIdempotencyKey, context.executionDigest, `provider result rejected: ${error.message}`, error.recoveryAction, `${error.receipt}; providerResult=untrusted; promotionExecution=indeterminate`);
    }
    const target = next.targets[input.promotion.targetId];
    if (!target) throw new AuthorityPlaneError({ code: "not_found", message: `Target ${input.promotion.targetId} disappeared before Promotion execution was recorded.`, recoveryAction: "restore the exact Target record and reconcile the provider operation", receipt: `promotion=${input.promotion.id}; target=${input.promotion.targetId}; execution=not-recorded` });
    const updatedTarget = targetAfterPromotion({ target, result: normalized });
    const suppliedCheckpoint = normalized.promotion.reconciliationCheckpoint ?? normalized.checkpoint;
    const checkpoint: PromotionReconciliationCheckpoint = {
      ...(suppliedCheckpoint ?? {}),
      idempotencyKey: input.executionIdempotencyKey,
      attempt: normalized.promotion.attempt,
      stage: normalized.status === "indeterminate" ? "reconcile" : (suppliedCheckpoint?.stage ?? "complete"),
      providerOperationIds: suppliedCheckpoint?.providerOperationIds ?? [normalized.promotion.providerOperationId, normalized.promotion.rollbackProviderOperationId].filter((value): value is string => Boolean(value)),
      executionDigest: context.executionDigest,
      releaseId: input.promotion.releaseId,
      targetId: input.promotion.targetId,
      status: normalized.status,
      updatedAt: now(),
      receipt: suppliedCheckpoint?.receipt ?? `promotion=${input.promotion.id}; execution=${normalized.status}; checkpoint=authority-recorded; credentialFree=true`,
    };
    const nextPromotion = { ...normalized.promotion, reconciliationCheckpoint: checkpoint };
    next.promotions[input.promotion.id] = nextPromotion;
    next.targets[target.id] = { ...updatedTarget, currentReleaseId: normalized.target.currentReleaseId, releaseHistory: [...normalized.target.releaseHistory], lastPromotionId: input.promotion.id };
    next.version += 1;
    const result: AuthorityCommandResult = {
      protocol: AUTHORITY_PLANE_PROTOCOL,
      command: input.operation,
      status: normalized.status,
      version: next.version,
      value: { promotion: nextPromotion, target: next.targets[target.id], release: next.releases[input.promotion.releaseId], checkpoint },
      receipt: `${normalized.receipt}; executionIdempotencyKey=${input.executionIdempotencyKey}; authorityStateVersion=${next.version}; operation=${input.operation}`,
      ...(normalized.recoveryAction ? { recoveryAction: normalized.recoveryAction } : {}),
    };
    next.idempotency[input.authorityIdempotencyKey] = { fingerprint: input.requestFingerprint, result: clone(result) };
    const originalExecutionKey = `promotion.execute:${input.executionIdempotencyKey}`;
    if (input.authorityIdempotencyKey !== originalExecutionKey && next.idempotency[originalExecutionKey]) {
      next.idempotency[originalExecutionKey] = { ...next.idempotency[originalExecutionKey], result: clone(result) };
    }
    next.audit.push({ id: opaqueId("authority-audit"), command: input.operation, idempotencyKey: input.authorityIdempotencyKey, actor: actorRef(input.session), outcome: normalized.status, stateVersion: next.version, occurredAt: now(), receipt: result.receipt });
    this.state = next;
    return clone(result);
  }

  private indeterminatePromotionExecution(promotion: PromotionRecord, promotionId: string, executionIdempotencyKey: string, executionDigest: string, message: string, recoveryAction: string, receipt: string): PromotionExecutionResult {
    const updatedAt = now();
    const updated: PromotionRecord = {
      ...clone(promotion),
      state: "degraded",
      attempt: promotion.attempt + 1,
      updatedAt,
      executionIdempotencyKey,
      recoveryAction,
      receipt: `promotion=degraded; ${message}; ${receipt}`,
      reconciliationCheckpoint: { idempotencyKey: executionIdempotencyKey, attempt: promotion.attempt + 1, stage: "reconcile", providerOperationIds: [...(promotion.reconciliationCheckpoint?.providerOperationIds ?? [])], executionDigest, releaseId: promotion.releaseId, targetId: promotion.targetId, status: "indeterminate", updatedAt, receipt: `promotion=${promotionId}; providerResult=indeterminate; credentialFree=true` },
    };
    const target = this.state.targets[promotion.targetId];
    return {
      protocol: PROMOTION_EXECUTION_PROTOCOL,
      status: "indeterminate",
      adapterId: target?.adapterId ?? "unknown",
      executionDigest,
      promotion: updated,
      target: { id: promotion.targetId, projectId: promotion.projectId, state: "degraded", currentReleaseId: target?.currentReleaseId ?? null, releaseHistory: [...(target?.releaseHistory ?? [])] },
      ...(updated.reconciliationCheckpoint ? { checkpoint: updated.reconciliationCheckpoint } : {}),
      receipt: updated.receipt,
      recoveryAction,
    };
  }

  private apply(next: AuthorityPlaneSnapshot, command: AuthorityCommand, session: AuthoritySession): AuthorityCommandResult {
    const payload = command.payload;
    const actor = actorRef(session);
    const success = (value: Record<string, unknown>, receipt: string): AuthorityCommandResult => ({ protocol: AUTHORITY_PLANE_PROTOCOL, command: command.command, status: "succeeded", version: next.version, value, receipt });
    const blocked = (value: Record<string, unknown>, receipt: string, recoveryAction: string): AuthorityCommandResult => ({ protocol: AUTHORITY_PLANE_PROTOCOL, command: command.command, status: "blocked", version: next.version, value, receipt, recoveryAction });
    const indeterminate = (value: Record<string, unknown>, receipt: string, recoveryAction: string): AuthorityCommandResult => ({ protocol: AUTHORITY_PLANE_PROTOCOL, command: command.command, status: "indeterminate", version: next.version, value, receipt, recoveryAction });
    const projectId = optionalString(payload.projectId);
    const project = projectId ? next.projects[projectId] : undefined;

    switch (command.command) {
      case "intent.create": {
        const currentProject = project ?? (() => { throw new AuthorityPlaneError({ code: "not_found", message: `Project ${requiredString(payload.projectId, "projectId")} does not exist.`, recoveryAction: "create or restore the Project before creating an Intent", receipt: `project=${payload.projectId ?? "missing"}; intent=not-created` }); })();
        const id = optionalString(payload.intentId) ?? opaqueId("intent");
        if (next.intents[id]) throw new AuthorityPlaneError({ code: "conflict", message: `Intent ${id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Intent identity", receipt: `intent=${id}; exists=true; transition=not-applied` });
        const disclosure = enumString(payload.disclosure, "disclosure", ["public", "project", "restricted"] as const, "project");
        const assigneePrincipalIds = payload.assigneePrincipalIds === undefined ? [] : stringArray(payload.assigneePrincipalIds, "assigneePrincipalIds", true);
        const labels = payload.labels === undefined ? [] : stringArray(payload.labels, "labels", true);
        const intent: Intent = {
          protocol: CONTRACT_VERSIONS.intent,
          id,
          projectId: currentProject.id,
          title: requiredString(payload.title, "title"),
          description: optionalString(payload.description) ?? "",
          status: "open",
          author: actor,
          assigneePrincipalIds,
          labels,
          disclosure,
          createdAt: now(),
          updatedAt: now(),
          receipt: `intent=created; project=${currentProject.id}; status=open; disclosure=${disclosure}; canonicalWrite=false`,
        };
        next.intents[id] = intent;
        return success({ intent }, intent.receipt);
      }
      case "intent.assign": {
        const intentId = requiredString(payload.intentId, "intentId");
        const existing = next.intents[intentId];
        if (!existing) throw new AuthorityPlaneError({ code: "not_found", message: `Intent ${intentId} is not available in this Realm.`, recoveryAction: "verify the Intent identifier without probing undiscoverable resources", receipt: `intent=${intentId}; operation=intent.assign; discoverable=false` });
        if (projectId !== undefined && existing.projectId !== projectId) throw new AuthorityPlaneError({ code: "not_found", message: `Intent ${intentId} is not available for Project ${projectId}.`, recoveryAction: "verify the Intent identifier within the requested Project", receipt: `intent=${intentId}; project=${projectId}; operation=intent.assign; discoverable=false` });
        const assigneePrincipalIds = stringArray(payload.assigneePrincipalIds, "assigneePrincipalIds", true);
        const updated: Intent = { ...existing, assigneePrincipalIds, updatedAt: now(), receipt: `intent=assigned; id=${intentId}; assignees=${assigneePrincipalIds.join(",") || "none"}; canonicalWrite=false` };
        next.intents[intentId] = updated;
        return success({ intent: updated }, updated.receipt);
      }
      case "intent.comment": {
        const intentId = requiredString(payload.intentId, "intentId");
        const existing = next.intents[intentId];
        if (!existing) throw new AuthorityPlaneError({ code: "not_found", message: `Intent ${intentId} is not available in this Realm.`, recoveryAction: "verify the Intent identifier without probing undiscoverable resources", receipt: `intent=${intentId}; operation=intent.comment; discoverable=false` });
        const disclosure = enumString(payload.disclosure, "disclosure", ["public", "project", "restricted"] as const, existing.disclosure);
        if (!disclosureAllows(existing.disclosure, disclosure)) throw new AuthorityPlaneError({ code: "conflict", message: `Intent comment disclosure ${disclosure} exceeds Intent ${intentId} disclosure ${existing.disclosure}.`, recoveryAction: "use a disclosure no broader than the Intent or create a separately governed Intent", receipt: `intent=${intentId}; intentDisclosure=${existing.disclosure}; commentDisclosure=${disclosure}; comment=not-created` });
        const commentId = optionalString(payload.commentId) ?? opaqueId("intent-comment");
        if (next.intentComments[commentId]) throw new AuthorityPlaneError({ code: "conflict", message: `Intent comment ${commentId} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new comment identity", receipt: `comment=${commentId}; exists=true; transition=not-applied` });
        const comment: IntentComment = { protocol: CONTRACT_VERSIONS.intentComment, id: commentId, intentId, projectId: existing.projectId, author: actor, body: requiredString(payload.body, "body"), disclosure, createdAt: now(), receipt: `intent=commented; id=${intentId}; comment=${commentId}; disclosure=${disclosure}; canonicalWrite=false` };
        next.intentComments[commentId] = comment;
        const updated: Intent = { ...existing, updatedAt: comment.createdAt, receipt: `${existing.receipt}; comments=updated; lastComment=${commentId}` };
        next.intents[intentId] = updated;
        return success({ intent: updated, comment }, comment.receipt);
      }
      case "intent.close":
      case "intent.reopen": {
        const intentId = requiredString(payload.intentId, "intentId");
        const existing = next.intents[intentId];
        if (!existing) throw new AuthorityPlaneError({ code: "not_found", message: `Intent ${intentId} is not available in this Realm.`, recoveryAction: "verify the Intent identifier without probing undiscoverable resources", receipt: `intent=${intentId}; operation=${command.command}; discoverable=false` });
        const desired = command.command === "intent.close" ? "closed" : "open";
        if (existing.status === desired) return success({ intent: existing }, `intent=${desired}; id=${intentId}; unchanged=true; canonicalWrite=false`);
        const timestamp = now();
        const updated: Intent = desired === "closed"
          ? { ...existing, status: "closed", closedAt: timestamp, closedBy: actor, updatedAt: timestamp, receipt: `intent=closed; id=${intentId}; canonicalWrite=false` }
          : (() => { const { closedAt: _closedAt, closedBy: _closedBy, ...openIntent } = existing; return { ...openIntent, status: "open", updatedAt: timestamp, receipt: `intent=reopened; id=${intentId}; canonicalWrite=false` }; })();
        next.intents[intentId] = updated;
        return success({ intent: updated }, updated.receipt);
      }
      case "project.create": {
        const id = optionalString(payload.projectId) ?? opaqueId("project");
        if (next.projects[id]) throw new AuthorityPlaneError({ code: "conflict", message: `Project ${id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Project identity", receipt: `project=${id}; exists=true; transition=not-applied` });
        const sourcesValue = payload.sourceSpaces;
        if (!Array.isArray(sourcesValue) || sourcesValue.length === 0) throw new AuthorityPlaneError({ code: "invalid_request", message: "sourceSpaces must contain at least one declared Source Space.", recoveryAction: "declare each Source Space with an immutable snapshot identifier", receipt: "sourceSpaces=non-empty-required; transition=not-applied" });
        const sourceSpaces: SourceSpace[] = sourcesValue.map((entry, index) => {
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new AuthorityPlaneError({ code: "invalid_request", message: `sourceSpaces[${index}] must be an object.`, recoveryAction: "declare Source Space objects with id, name, classification, and snapshotId", receipt: `sourceSpaces[${index}]=object-required; transition=not-applied` });
          const source = entry as Record<string, unknown>;
          const sourceId = requiredString(source.id, `sourceSpaces[${index}].id`);
          const classification = requiredString(source.classification, `sourceSpaces[${index}].classification`) as SourceSpace["classification"];
          if (!["public", "internal", "restricted", "result-only"].includes(classification)) throw new AuthorityPlaneError({ code: "invalid_request", message: `Source Space ${sourceId} has an unsupported classification.`, recoveryAction: "choose public, internal, restricted, or result-only", receipt: `sourceSpace=${sourceId}; classification=${classification}; transition=not-applied` });
          const sourceSpace: SourceSpace = { protocol: CONTRACT_VERSIONS.sourceSpace, id: sourceId, name: requiredString(source.name, `sourceSpaces[${index}].name`), classification };
          if (next.sourceSpaces[sourceId]) throw new AuthorityPlaneError({ code: "conflict", message: `Source Space ${sourceId} already exists.`, recoveryAction: "use a new Source Space identity", receipt: `sourceSpace=${sourceId}; exists=true; transition=not-applied` });
          next.sourceSpaces[sourceId] = sourceSpace;
          return sourceSpace;
        });
        const createdProject = createProject({ id, name: requiredString(payload.name, "name"), referenceType: optionalString(payload.referenceType) ?? "git", sourceSpaceIds: sourceSpaces.map((source) => source.id) });
        const sourceSpaceSnapshots = Object.fromEntries(sourcesValue.map((entry) => { const source = entry as Record<string, unknown>; return [requiredString(source.id, "sourceSpace.id"), requiredString(source.snapshotId, "sourceSpace.snapshotId")]; }));
        const requestedProjectRevisionId = optionalString(payload.projectRevisionId);
        const initialRevision = createProjectRevision({ ...(requestedProjectRevisionId ? { id: requestedProjectRevisionId } : {}), projectId: id, sourceSpaceSnapshots });
        next.projects[id] = createdProject;
        next.projectRevisions[initialRevision.id] = initialRevision;
        next.canonicalByProject[id] = initialRevision.id;
        return success({ project: createdProject, canonicalRevision: initialRevision, sourceSpaces }, `project=${id}; canonicalRevision=${initialRevision.id}; sourceTransfer=not-performed; authority=coordinator`);
      }
      case "workspace.create": {
        const currentProject = project ?? (() => { throw new AuthorityPlaneError({ code: "not_found", message: `Project ${requiredString(payload.projectId, "projectId")} does not exist.`, recoveryAction: "create or import the Project before creating a Workspace", receipt: `project=${payload.projectId ?? "missing"}; workspace=not-created` }); })();
        const revisionId = requiredString(payload.projectRevisionId, "projectRevisionId");
        const revision = next.projectRevisions[revisionId];
        if (!revision || revision.projectId !== currentProject.id) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${revisionId} is not available for Project ${currentProject.id}.`, recoveryAction: "read the current canonical Project Revision and retry", receipt: `project=${currentProject.id}; revision=${revisionId}; workspace=not-created` });
        const sourceIds = stringArray(payload.sourceSpaceIds ?? currentProject.sourceSpaceIds, "sourceSpaceIds");
        const sourceSpaces = sourceIds.map((id) => next.sourceSpaces[id]).filter((value): value is SourceSpace => value !== undefined);
        const requestedClassification = optionalString(payload.classification) as ProjectView["classification"] | undefined;
        const view = deriveProjectView({ project: currentProject, revision, sourceSpaces, allowedSourceSpaceIds: sourceIds, projectionId: optionalString(payload.projectionId) ?? opaqueId("projection"), ...(requestedClassification ? { classification: requestedClassification } : {}) });
        const mountsValue = payload.mounts;
        const mounts: WorkspaceMount[] = mountsValue === undefined
          ? sourceIds.map((sourceSpaceId) => ({ sourceSpaceId, snapshotId: revision.sourceSpaceSnapshots[sourceSpaceId]!, mountPath: sourceSpaceId.replaceAll(":", "-") }))
          : stringArray(mountsValue, "mounts").map((mountPath, index) => ({ sourceSpaceId: sourceIds[index]!, snapshotId: revision.sourceSpaceSnapshots[sourceIds[index]!]!, mountPath }));
        const requestedWorkspaceChangeId = optionalString(payload.changeId);
        const workspace: Workspace = { protocol: CONTRACT_VERSIONS.workspace, id: optionalString(payload.workspaceId) ?? opaqueId("workspace"), projectId: currentProject.id, projectRevisionId: revision.id, projectViewId: view.id, mounts, state: "active", ...(requestedWorkspaceChangeId ? { changeId: requestedWorkspaceChangeId } : {}), actorId: session.actorId };
        if (next.workspaces[workspace.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Workspace ${workspace.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Workspace identity", receipt: `workspace=${workspace.id}; exists=true; transition=not-applied` });
        next.projectViews[view.id] = view;
        next.workspaces[workspace.id] = workspace;
        return success({ workspace, view }, `workspace=${workspace.id}; base=${revision.id}; actor=${session.actorId}; sourceTransfer=not-performed`);
      }
      case "change.create": {
        const currentProject = project ?? (() => { throw new AuthorityPlaneError({ code: "not_found", message: `Project ${requiredString(payload.projectId, "projectId")} does not exist.`, recoveryAction: "create the Project before creating a Change", receipt: `project=${payload.projectId ?? "missing"}; change=not-created` }); })();
        const baseRevisionId = optionalString(payload.baseProjectRevisionId) ?? next.canonicalByProject[currentProject.id];
        if (!baseRevisionId || !next.projectRevisions[baseRevisionId]) throw new AuthorityPlaneError({ code: "not_found", message: "The Change base Project Revision is unavailable.", recoveryAction: "read the canonical Project Revision and retry the Change creation", receipt: `project=${currentProject.id}; baseRevision=missing; change=not-created` });
        const workspaceId = optionalString(payload.workspaceId);
        if (workspaceId && (!next.workspaces[workspaceId] || next.workspaces[workspaceId].projectId !== currentProject.id)) throw new AuthorityPlaneError({ code: "not_found", message: `Workspace ${workspaceId} is not available for Project ${currentProject.id}.`, recoveryAction: "create a Workspace for this Project before creating the Change", receipt: `workspace=${workspaceId}; change=not-created` });
        const origin = changeOriginFromPayload(payload.origin);
        const intentId = requiredString(payload.intentId, "intentId");
        const existingIntent = next.intents[intentId];
        if (existingIntent && existingIntent.projectId !== currentProject.id) throw new AuthorityPlaneError({ code: "conflict", message: `Intent ${intentId} belongs to Project ${existingIntent.projectId}, not ${currentProject.id}.`, recoveryAction: "create the Change from an Intent belonging to the same Project", receipt: `intent=${intentId}; intentProject=${existingIntent.projectId}; changeProject=${currentProject.id}; transition=not-applied` });
        if (!existingIntent) next.intents[intentId] = { protocol: CONTRACT_VERSIONS.intent, id: intentId, projectId: currentProject.id, title: intentId, description: "", status: "open", author: actor, assigneePrincipalIds: [], labels: [], disclosure: "project", createdAt: now(), updatedAt: now(), receipt: `intent=legacy-materialized; id=${intentId}; source=change.create; canonicalWrite=false` };
        const change: Change = { protocol: CONTRACT_VERSIONS.change, id: optionalString(payload.changeId) ?? opaqueId("change"), projectId: currentProject.id, intentId, baseProjectRevisionId: baseRevisionId, status: "active", latestRevisionId: null, ...(workspaceId ? { workspaceId } : {}), author: actor, ...(origin ? { origin } : {}) };
        if (next.changes[change.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Change ${change.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Change identity", receipt: `change=${change.id}; exists=true; transition=not-applied` });
        next.changes[change.id] = change;
        if (workspaceId) next.workspaces[workspaceId] = { ...next.workspaces[workspaceId]!, changeId: change.id };
        return success({ change }, `change=${change.id}; base=${baseRevisionId}; canonicalWrite=false`);
      }
      case "revision.publish": {
        const changeId = requiredString(payload.changeId, "changeId");
        const change = next.changes[changeId];
        if (!change) throw new AuthorityPlaneError({ code: "not_found", message: `Change ${changeId} does not exist.`, recoveryAction: "create the Change before publishing a Revision", receipt: `change=${changeId}; revision=not-created` });
        const requestedProjectId = optionalString(payload.projectId);
        if (requestedProjectId && requestedProjectId !== change.projectId) throw new AuthorityPlaneError({ code: "not_found", message: `Change ${changeId} is not available for Project ${requestedProjectId}.`, recoveryAction: "verify the Project and Change identifiers without probing hidden resources", receipt: `project=${requestedProjectId}; change=not-available; discoverable=false` });
        if (change.status === "landed" || change.status === "abandoned") throw new AuthorityPlaneError({ code: "conflict", message: `Change ${changeId} is ${change.status} and cannot publish another Revision.`, recoveryAction: "create a new Change from the current canonical Project Revision", receipt: `change=${changeId}; status=${change.status}; revision=not-created` });
        const workspaceId = optionalString(payload.workspaceId) ?? change.workspaceId;
        const workspace = workspaceId ? next.workspaces[workspaceId] : undefined;
        if (workspaceId && (!workspace || workspace.changeId !== changeId || workspace.projectId !== change.projectId)) throw new AuthorityPlaneError({ code: "conflict", message: `Workspace ${workspaceId} is not assigned to Change ${changeId}.`, recoveryAction: "publish from the assigned Change Workspace in the same Project", receipt: `change=${changeId}; workspace=${workspaceId}; revision=not-created` });
        const projectViewId = requiredString(payload.projectViewId ?? workspace?.projectViewId, "projectViewId");
        if (workspace && workspace.projectViewId !== projectViewId) throw new AuthorityPlaneError({ code: "conflict", message: `Project View ${projectViewId} is not the View mounted by Workspace ${workspace.id}.`, recoveryAction: "publish with the Project View bound to the assigned Workspace", receipt: `workspace=${workspace.id}; projectView=${projectViewId}; revision=not-created` });
        const sourceSnapshots = record<string>(payload.sourceSpaceSnapshots ?? next.projectRevisions[change.baseProjectRevisionId]?.sourceSpaceSnapshots, "sourceSpaceSnapshots");
        const project = next.projects[change.projectId];
        if (!project) throw new AuthorityPlaneError({ code: "indeterminate", message: `Change ${changeId} refers to a Project that is not readable.`, recoveryAction: "reconcile the Authority snapshot before publishing a Revision", receipt: `change=${changeId}; project=${change.projectId}; revision=not-created` });
        const unknownSourceSpaceId = Object.keys(sourceSnapshots).find((sourceSpaceId) => !project.sourceSpaceIds.includes(sourceSpaceId));
        if (unknownSourceSpaceId) throw new AuthorityPlaneError({ code: "conflict", message: `Source Space ${unknownSourceSpaceId} is not part of Project ${project.id}.`, recoveryAction: "publish only snapshots belonging to the Change Project View", receipt: `project=${project.id}; sourceSpace=${unknownSourceSpaceId}; revision=not-created` });
        const sequence = Object.values(next.changeRevisions).filter((revision) => revision.changeId === changeId).length + 1;
        const projectRevisionId = optionalString(payload.projectRevisionId) ?? opaqueId("candidate-revision");
        const revisionKind = optionalString(payload.kind) as ChangeRevision["kind"] | undefined;
        const revision: ChangeRevision = { protocol: CONTRACT_VERSIONS.change, id: optionalString(payload.revisionId) ?? opaqueId("change-revision"), changeId, projectRevisionId, projectViewId, sequence, parentRevisionId: change.latestRevisionId ?? undefined, declaredEffects: stringArray(payload.declaredEffects ?? [], "declaredEffects", true), baseProjectRevisionId: change.baseProjectRevisionId, ...(workspaceId ? { workspaceId } : {}), sourceSpaceSnapshots: { ...sourceSnapshots }, affectedSourceSpaceIds: Object.keys(sourceSnapshots), author: actor, ...(revisionKind ? { kind: revisionKind } : {}) };
        if (next.changeRevisions[revision.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Change Revision ${revision.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Revision identity", receipt: `revision=${revision.id}; exists=true; transition=not-applied` });
        next.changeRevisions[revision.id] = revision;
        next.changes[changeId] = { ...change, latestRevisionId: revision.id, status: "submitted" };
        return success({ revision, change: next.changes[changeId] }, `change=${changeId}; revision=${revision.id}; sequence=${sequence}; canonicalWrite=false`);
      }
      case "runner.register": {
        throw new AuthorityPlaneError({
          code: "invalid_request",
          message: "runner.register is an internal Runner-service enrollment sync and cannot be submitted through execute().",
          recoveryAction: "use registerRunnerProfile through the bound Runner service; no Authority state was changed",
          receipt: "command=runner.register; surface=generic-authority; transition=not-applied; internalOnly=true",
        });
      }
      case "run.request": {
        const projectId = requiredString(payload.projectId, "projectId");
        const project = next.projects[projectId];
        if (!project) throw new AuthorityPlaneError({ code: "not_found", message: `Project ${projectId} does not exist.`, recoveryAction: "inspect the Project through the authenticated read surface before requesting a Run", receipt: `project=${projectId}; run=request-not-created; discoverable=false` });
        const projectRevisionId = requiredString(payload.projectRevisionId, "projectRevisionId");
        const projectRevision = next.projectRevisions[projectRevisionId];
        const requestedChangeRevisionId = optionalString(payload.changeRevisionId);
        const requestedChangeRevision = requestedChangeRevisionId ? next.changeRevisions[requestedChangeRevisionId] : undefined;
        const requestedChange = requestedChangeRevision ? next.changes[requestedChangeRevision.changeId] : undefined;
        const revisionBoundByChange = requestedChangeRevision?.projectRevisionId === projectRevisionId && requestedChange?.projectId === project.id;
        if ((!projectRevision || projectRevision.projectId !== project.id) && !revisionBoundByChange) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${projectRevisionId} is not available for Project ${project.id}.`, recoveryAction: "request the Run against an exact Project Revision in the same Project or its exact published Change Revision", receipt: `project=${project.id}; projectRevision=${projectRevisionId}; run=request-not-created; discoverable=false` });
        const projectViewId = requiredString(payload.projectViewId, "projectViewId");
        const projectView = next.projectViews[projectViewId];
        if (!projectView || projectView.projectId !== project.id || (projectView.projectRevisionId !== projectRevisionId && !revisionBoundByChange)) throw new AuthorityPlaneError({ code: "not_found", message: `Project View ${projectViewId} is not available for Project Revision ${projectRevisionId}.`, recoveryAction: "request the Run against the View mounted from the exact Project Revision", receipt: `project=${project.id}; projectView=${projectViewId}; run=request-not-created; discoverable=false` });
        const changeRevisionId = requestedChangeRevisionId;
        const changeRevision = requestedChangeRevision;
        const change = requestedChange;
        if (changeRevisionId && (!changeRevision || !change || change.projectId !== project.id || changeRevision.projectRevisionId !== projectRevisionId || changeRevision.projectViewId !== projectViewId)) throw new AuthorityPlaneError({ code: "conflict", message: `Change Revision ${changeRevisionId} is not bound to the requested Run context.`, recoveryAction: "request the Run against the exact Change Revision, Project View, and Project Revision that will be executed", receipt: `project=${project.id}; changeRevision=${changeRevisionId}; run=request-not-created` });
        const workspaceId = optionalString(payload.workspaceId);
        const workspace = workspaceId ? next.workspaces[workspaceId] : undefined;
        if (workspaceId && (!workspace || workspace.projectId !== project.id || workspace.projectViewId !== projectViewId || ((!projectRevision || workspace.projectRevisionId !== projectRevision.id) && !revisionBoundByChange) || (change && workspace.changeId !== change.id))) throw new AuthorityPlaneError({ code: "conflict", message: `Workspace ${workspaceId} is not bound to the requested Run context.`, recoveryAction: "request the Run from the active Workspace mounted on the exact Project View", receipt: `project=${project.id}; workspace=${workspaceId}; run=request-not-created` });
        const runId = optionalString(payload.runId) ?? opaqueId("run");
        if (next.runs[runId]) throw new AuthorityPlaneError({ code: "conflict", message: `Run ${runId} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Run identity", receipt: `run=${runId}; exists=true; transition=not-applied` });
        const verifierId = optionalString(payload.verifierId);
        const actionContractDigest = optionalString(payload.actionContractDigest);
        const verifierContractDigest = optionalString(payload.verifierContractDigest);
        const dependencyDigest = optionalString(payload.dependencyDigest);
        const toolchainDigest = optionalString(payload.toolchainDigest);
        const environmentDigest = optionalString(payload.environmentDigest);
        const targetId = optionalString(payload.targetId);
        const run: Run = {
          protocol: CONTRACT_VERSIONS.run,
          id: runId,
          actionId: requiredString(payload.actionId, "actionId"),
          projectRevisionId,
          projectViewId,
          runnerId: "runner:unassigned",
          status: "queued",
          outputDigest: undefined,
          ...(changeRevisionId ? { changeRevisionId } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(verifierId ? { verifierId } : {}),
          ...(actionContractDigest ? { actionContractDigest } : {}),
          ...(verifierContractDigest ? { verifierContractDigest } : {}),
          inputDigests: stringArray(payload.inputDigests ?? [], "inputDigests", true),
          outputDigests: stringArray(payload.outputDigests ?? [], "outputDigests", true),
          effectDigests: stringArray(payload.effectDigests ?? [], "effectDigests", true),
          ...(dependencyDigest ? { dependencyDigest } : {}),
          ...(toolchainDigest ? { toolchainDigest } : {}),
          ...(environmentDigest ? { environmentDigest } : {}),
          ...(targetId ? { targetId } : {}),
          policyVersion: requiredString(payload.policyVersion, "policyVersion"),
          actor: actorRef(session),
          capabilityGrantId: requiredString(payload.capabilityGrantId, "capabilityGrantId"),
        };
        next.runs[run.id] = run;
        return success({ run }, `run=${run.id}; status=queued; completion=runner-only; canonicalWrite=false`);
      }
      case "runner.complete": {
        throw new AuthorityPlaneError({
          code: "invalid_request",
          message: "runner.complete is an internal asynchronous transition and cannot be submitted through execute().",
          recoveryAction: "use completeRunner through the bound Runner service; no Authority state was changed",
          receipt: "command=runner.complete; surface=generic-authority; transition=not-applied; internalOnly=true",
        });
      }
      case "run.record": {
        const requestedRunProjectId = optionalString(payload.projectId);
        const runProjectRevisionId = requiredString(payload.projectRevisionId, "projectRevisionId");
        const runProjectRevision = next.projectRevisions[runProjectRevisionId];
        const runChangeRevisionId = optionalString(payload.changeRevisionId);
        const runChangeRevision = runChangeRevisionId ? next.changeRevisions[runChangeRevisionId] : undefined;
        const runChangeProjectId = runChangeRevision ? next.changes[runChangeRevision.changeId]?.projectId : undefined;
        const runWorkspaceId = optionalString(payload.workspaceId);
        const runWorkspace = runWorkspaceId ? next.workspaces[runWorkspaceId] : undefined;
        const runWorkspaceProjectId = runWorkspace?.projectId;
        const enforceRunBinding = requestedRunProjectId !== undefined || runChangeRevisionId !== undefined || runWorkspaceId !== undefined;
        if (enforceRunBinding && !runProjectRevision && ((!runChangeRevision || runChangeRevision.projectRevisionId !== runProjectRevisionId) && !runWorkspaceProjectId)) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${runProjectRevisionId} is not available.`, recoveryAction: "record the Run against an existing Project Revision or its exact published Change Revision", receipt: `projectRevision=${runProjectRevisionId}; run=not-created; discoverable=false` });
        if (requestedRunProjectId && ((runProjectRevision && runProjectRevision.projectId !== requestedRunProjectId) || (runChangeProjectId && runChangeProjectId !== requestedRunProjectId))) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${runProjectRevisionId} is not available for Project ${requestedRunProjectId}.`, recoveryAction: "record the Run against the Project Revision belonging to the requested Project", receipt: `project=${requestedRunProjectId}; projectRevision=${runProjectRevisionId}; run=not-created; discoverable=false` });
        const runProjectId = requestedRunProjectId ?? runProjectRevision?.projectId ?? runChangeProjectId ?? runWorkspaceProjectId;
        const runProject = runProjectId ? next.projects[runProjectId] : undefined;
        if (runProjectId && !runProject) throw new AuthorityPlaneError({ code: "indeterminate", message: `Run Project ${runProjectId} is not readable.`, recoveryAction: "reconcile the Authority snapshot before recording the Run", receipt: `project=${runProjectId}; run=not-created` });
        const runProjectViewId = requiredString(payload.projectViewId, "projectViewId");
        const runProjectView = next.projectViews[runProjectViewId];
        if (runProjectId && (!runProjectView || runProjectView.projectId !== runProjectId)) throw new AuthorityPlaneError({ code: "not_found", message: `Project View ${runProjectViewId} is not available for Project ${runProjectId}.`, recoveryAction: "record the Run against the Project View mounted by the Workspace", receipt: `project=${runProjectId}; projectView=${runProjectViewId}; run=not-created; discoverable=false` });
        if (runWorkspaceId && (!runWorkspace || (runProjectId && runWorkspace.projectId !== runProjectId) || runWorkspace.projectViewId !== runProjectViewId)) throw new AuthorityPlaneError({ code: "conflict", message: `Workspace ${runWorkspaceId} is not bound to Project ${runProjectId ?? "the Run"} and Project View ${runProjectViewId}.`, recoveryAction: "record the Run from the assigned Workspace and its mounted Project View", receipt: `project=${runProjectId ?? "not-supplied"}; workspace=${runWorkspaceId}; projectView=${runProjectViewId}; run=not-created` });
        if (runChangeRevisionId && (!runChangeRevision || (runProjectId && runChangeProjectId !== runProjectId) || runChangeRevision.projectViewId !== runProjectViewId || runChangeRevision.projectRevisionId !== runProjectRevisionId)) throw new AuthorityPlaneError({ code: "conflict", message: `Change Revision ${runChangeRevisionId} is not bound to the Run Project, View, and Revision.`, recoveryAction: "record the Run against the exact Change Revision and Project View that produced its result", receipt: `project=${runProjectId ?? "not-supplied"}; changeRevision=${runChangeRevisionId}; projectRevision=${runProjectRevisionId}; projectView=${runProjectViewId}; run=not-created` });
        if (runWorkspace && runChangeRevision && runChangeRevision.workspaceId !== runWorkspace.id) throw new AuthorityPlaneError({ code: "conflict", message: `Change Revision ${runChangeRevision.id} is not bound to Workspace ${runWorkspace.id}.`, recoveryAction: "record the Run against the Change Workspace that produced the Revision", receipt: `workspace=${runWorkspace.id}; changeRevision=${runChangeRevision.id}; run=not-created` });
        const run: Run = { protocol: CONTRACT_VERSIONS.run, id: optionalString(payload.runId) ?? opaqueId("run"), actionId: requiredString(payload.actionId, "actionId"), projectRevisionId: runProjectRevisionId, projectViewId: runProjectViewId, runnerId: requiredString(payload.runnerId, "runnerId"), status: (optionalString(payload.status) ?? "succeeded") as Run["status"], outputDigest: optionalString(payload.outputDigest), ...(runChangeRevisionId ? { changeRevisionId: runChangeRevisionId } : {}), ...(runWorkspaceId ? { workspaceId: runWorkspaceId } : {}), ...(Array.isArray(payload.inputDigests) ? { inputDigests: stringArray(payload.inputDigests, "inputDigests", true) } : {}), ...(Array.isArray(payload.outputDigests) ? { outputDigests: stringArray(payload.outputDigests, "outputDigests", true) } : {}), actor };
        if (!["queued", "running", "succeeded", "failed", "indeterminate"].includes(run.status)) throw new AuthorityPlaneError({ code: "invalid_request", message: `Run status ${run.status} is unsupported.`, recoveryAction: "record queued, running, succeeded, failed, or indeterminate", receipt: `run=${run.id}; status=${run.status}; transition=not-applied` });
        if (next.runs[run.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Run ${run.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Run identity", receipt: `run=${run.id}; exists=true; transition=not-applied` });
        next.runs[run.id] = run;
        const status = run.status === "indeterminate" ? "indeterminate" : "succeeded";
        return status === "indeterminate" ? indeterminate({ run }, `run=${run.id}; status=indeterminate; evidence=not-yet-valid`, "reconcile the Runner attempt and record a determinate Run before creating Evidence") : success({ run }, `run=${run.id}; status=${run.status}; runner=${run.runnerId}`);
      }
      case "evidence.record": {
        const runId = requiredString(payload.runId, "runId");
        const run = next.runs[runId];
        if (!run) throw new AuthorityPlaneError({ code: "not_found", message: `Run ${runId} does not exist.`, recoveryAction: "record the Run before attaching Evidence", receipt: `run=${runId}; evidence=not-created` });
        if (run.status !== "succeeded") throw new AuthorityPlaneError({ code: "conflict", message: `Run ${runId} is ${run.status}; Evidence cannot assert success from it.`, recoveryAction: "record a successful determinate Run or preserve the failure as an explicit non-passing result", receipt: `run=${runId}; status=${run.status}; evidence=not-created` });
        const evidenceProjectId = optionalString(payload.projectId);
        const evidenceProjectRevisionId = requiredString(payload.projectRevisionId ?? run.projectRevisionId, "projectRevisionId");
        if (evidenceProjectRevisionId !== run.projectRevisionId) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Project Revision ${evidenceProjectRevisionId} does not match Run ${run.id}.`, recoveryAction: "record Evidence against the exact Project Revision used by the successful Run", receipt: `run=${run.id}; runProjectRevision=${run.projectRevisionId}; evidenceProjectRevision=${evidenceProjectRevisionId}; evidence=not-created` });
        const evidenceProjectRevision = next.projectRevisions[evidenceProjectRevisionId];
        const evidenceChangeRevisionId = optionalString(payload.changeRevisionId ?? run.changeRevisionId);
        const evidenceChangeRevision = evidenceChangeRevisionId ? next.changeRevisions[evidenceChangeRevisionId] : undefined;
        const evidenceChangeProjectId = evidenceChangeRevision ? next.changes[evidenceChangeRevision.changeId]?.projectId : undefined;
        const evidenceRevisionIsBoundByChange = evidenceChangeRevision?.projectRevisionId === evidenceProjectRevisionId;
        const enforceEvidenceBinding = evidenceProjectId !== undefined || evidenceChangeRevisionId !== undefined || run.workspaceId !== undefined;
        if (enforceEvidenceBinding && !evidenceProjectRevision && (!evidenceRevisionIsBoundByChange || (evidenceProjectId !== undefined && evidenceChangeProjectId !== evidenceProjectId))) throw new AuthorityPlaneError({ code: "not_found", message: `Evidence Project Revision ${evidenceProjectRevisionId} is not available for the requested Project.`, recoveryAction: "record Evidence against an existing Project Revision or its exact published Change Revision", receipt: `project=${evidenceProjectId ?? evidenceProjectRevisionId}; projectRevision=${evidenceProjectRevisionId}; evidence=not-created; discoverable=false` });
        if (evidenceProjectId && ((evidenceProjectRevision && evidenceProjectRevision.projectId !== evidenceProjectId) || (evidenceChangeProjectId && evidenceChangeProjectId !== evidenceProjectId))) throw new AuthorityPlaneError({ code: "not_found", message: `Evidence Project Revision ${evidenceProjectRevisionId} is not available for the requested Project.`, recoveryAction: "record Evidence against a Project Revision belonging to the requested Project", receipt: `project=${evidenceProjectId}; projectRevision=${evidenceProjectRevisionId}; evidence=not-created; discoverable=false` });
        const resolvedEvidenceProjectId = evidenceProjectId ?? evidenceProjectRevision?.projectId ?? evidenceChangeProjectId;
        const evidenceProjectViewId = requiredString(payload.projectViewId ?? run.projectViewId, "projectViewId");
        if (evidenceProjectViewId !== run.projectViewId) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Project View ${evidenceProjectViewId} does not match Run ${run.id}.`, recoveryAction: "record Evidence against the exact Project View used by the successful Run", receipt: `run=${run.id}; runProjectView=${run.projectViewId}; evidenceProjectView=${evidenceProjectViewId}; evidence=not-created` });
        const evidenceProjectView = next.projectViews[evidenceProjectViewId];
        if (resolvedEvidenceProjectId && (!evidenceProjectView || evidenceProjectView.projectId !== resolvedEvidenceProjectId)) throw new AuthorityPlaneError({ code: "not_found", message: `Project View ${evidenceProjectViewId} is not available for Project ${resolvedEvidenceProjectId}.`, recoveryAction: "record Evidence against the Project View mounted by the Run Workspace", receipt: `project=${resolvedEvidenceProjectId}; projectView=${evidenceProjectViewId}; evidence=not-created; discoverable=false` });
        if (run.changeRevisionId && evidenceChangeRevisionId !== run.changeRevisionId) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Change Revision ${evidenceChangeRevisionId ?? "missing"} does not match Run ${run.id}.`, recoveryAction: "record Evidence against the exact Change Revision used by the successful Run", receipt: `run=${run.id}; runChangeRevision=${run.changeRevisionId}; evidenceChangeRevision=${evidenceChangeRevisionId ?? "missing"}; evidence=not-created` });
        if (evidenceChangeRevisionId && (!evidenceChangeRevision || (resolvedEvidenceProjectId && evidenceChangeProjectId !== resolvedEvidenceProjectId) || evidenceChangeRevision.projectViewId !== evidenceProjectViewId || evidenceChangeRevision.projectRevisionId !== evidenceProjectRevisionId)) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Change Revision ${evidenceChangeRevisionId} is not bound to the Run Project, View, and Revision.`, recoveryAction: "record Evidence against the exact Change Revision that produced the Run", receipt: `project=${resolvedEvidenceProjectId ?? "not-supplied"}; changeRevision=${evidenceChangeRevisionId}; evidence=not-created` });
        const evidenceTargetId = optionalString(payload.targetId);
        const evidenceWorkspaceId = optionalString(payload.workspaceId ?? run.workspaceId);
        if (run.workspaceId && evidenceWorkspaceId !== run.workspaceId) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Workspace ${evidenceWorkspaceId ?? "missing"} does not match Run ${run.id}.`, recoveryAction: "record Evidence against the exact Workspace used by the successful Run", receipt: `run=${run.id}; runWorkspace=${run.workspaceId}; evidenceWorkspace=${evidenceWorkspaceId ?? "missing"}; evidence=not-created` });
        const evidenceWorkspace = evidenceWorkspaceId ? next.workspaces[evidenceWorkspaceId] : undefined;
        if (evidenceWorkspaceId && (!evidenceWorkspace || (resolvedEvidenceProjectId && evidenceWorkspace.projectId !== resolvedEvidenceProjectId) || evidenceWorkspace.projectViewId !== evidenceProjectViewId)) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Workspace ${evidenceWorkspaceId} is not bound to the Run Project and View.`, recoveryAction: "record Evidence from the Run Workspace and its mounted Project View", receipt: `project=${resolvedEvidenceProjectId ?? "not-supplied"}; workspace=${evidenceWorkspaceId}; evidence=not-created` });
        const disclosure = payload.disclosure as Record<string, unknown> | undefined;
        const evidenceActionId = requiredString(payload.actionId, "actionId");
        if (evidenceActionId !== run.actionId) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Action ${evidenceActionId} does not match Run ${run.id}.`, recoveryAction: "record Evidence for the Action that produced the successful Run", receipt: `run=${run.id}; runAction=${run.actionId}; evidenceAction=${evidenceActionId}; evidence=not-created` });
        const evidenceRunnerId = requiredString(payload.runnerId ?? run.runnerId, "runnerId");
        if (evidenceRunnerId !== run.runnerId) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Runner ${evidenceRunnerId} does not match Run ${run.id}.`, recoveryAction: "record Evidence from the Runner that produced the successful Run", receipt: `run=${run.id}; runRunner=${run.runnerId}; evidenceRunner=${evidenceRunnerId}; evidence=not-created` });
        const evidenceOutputDigest = requiredString(payload.outputDigest, "outputDigest");
        if (run.outputDigest && run.outputDigest !== evidenceOutputDigest) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence output digest does not match Run ${run.id}.`, recoveryAction: "record Evidence with the exact output digest produced by the successful Run", receipt: `run=${run.id}; outputDigest=match-required; evidence=not-created` });
        const evidence: Evidence = { protocol: CONTRACT_VERSIONS.evidence, version: "v1", id: optionalString(payload.evidenceId) ?? opaqueId("evidence"), key: requiredString(payload.key, "key"), criterion: requiredString(payload.criterion, "criterion"), outcome: (optionalString(payload.outcome) ?? "passed") as Evidence["outcome"], validityKey: requiredString(payload.validityKey, "validityKey"), actionId: evidenceActionId, verifierId: requiredString(payload.verifierId, "verifierId"), toolchainDigest: requiredString(payload.toolchainDigest, "toolchainDigest"), dependencyDigest: requiredString(payload.dependencyDigest, "dependencyDigest"), environmentDigest: requiredString(payload.environmentDigest, "environmentDigest"), inputDigests: stringArray(payload.inputDigests, "inputDigests", true), effectDigests: stringArray(payload.effectDigests, "effectDigests", true), outputDigest: evidenceOutputDigest, createdAt: now(), producer: { kind: "run", id: runId, version: CONTRACT_VERSIONS.run }, projectRevisionId: evidenceProjectRevisionId, projectViewId: evidenceProjectViewId, ...(evidenceChangeRevisionId ? { changeRevisionId: evidenceChangeRevisionId } : {}), runId, actor, runnerId: evidenceRunnerId, policyVersion: requiredString(payload.policyVersion, "policyVersion"), authorizationEpoch: String(payload.authorizationEpoch ?? session.authorizationEpoch), capabilityGrantId: requiredString(payload.capabilityGrantId, "capabilityGrantId"), disclosure: { projectionId: requiredString(disclosure?.projectionId, "disclosure.projectionId"), classification: requiredString(disclosure?.classification, "disclosure.classification") as DisclosureClassification }, receipt: requiredString(payload.receipt, "receipt"), invalidators: stringArray(payload.invalidators, "invalidators", true), owner: requiredString(payload.owner, "owner"), ...(evidenceTargetId ? { targetId: evidenceTargetId } : {}), ...(evidenceWorkspaceId ? { workspaceId: evidenceWorkspaceId } : {}) };
        if (!["passed", "failed", "stale", "indeterminate"].includes(evidence.outcome)) throw new AuthorityPlaneError({ code: "invalid_request", message: `Evidence outcome ${evidence.outcome} is unsupported.`, recoveryAction: "record passed, failed, stale, or indeterminate Evidence", receipt: `evidence=${evidence.id}; outcome=${evidence.outcome}; transition=not-applied` });
        if (next.evidence[evidence.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence ${evidence.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Evidence identity", receipt: `evidence=${evidence.id}; exists=true; transition=not-applied` });
        next.evidence[evidence.id] = evidence;
        return success({ evidence }, `evidence=${evidence.id}; outcome=${evidence.outcome}; run=${runId}`);
      }
      case "artifact.record": {
        const requestedArtifactProjectId = optionalString(payload.projectId);
        const artifactProjectRevisionId = requiredString(payload.projectRevisionId, "projectRevisionId");
        const artifactProjectRevision = next.projectRevisions[artifactProjectRevisionId];
        const artifactChangeRevisionId = optionalString(payload.changeRevisionId);
        const artifactChangeRevision = artifactChangeRevisionId ? next.changeRevisions[artifactChangeRevisionId] : undefined;
        const artifactChangeProjectId = artifactChangeRevision ? next.changes[artifactChangeRevision.changeId]?.projectId : undefined;
        const artifactRunId = optionalString(payload.runId);
        const artifactRun = artifactRunId ? next.runs[artifactRunId] : undefined;
        const artifactActionId = optionalString(payload.actionId);
        const artifactWorkspaceId = optionalString(payload.workspaceId);
        const artifactWorkspace = artifactWorkspaceId ? next.workspaces[artifactWorkspaceId] : undefined;
        const enforceArtifactBinding = requestedArtifactProjectId !== undefined || artifactChangeRevisionId !== undefined || artifactRunId !== undefined || artifactWorkspaceId !== undefined;
        if (enforceArtifactBinding && !artifactProjectRevision && !artifactChangeRevision) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${artifactProjectRevisionId} is not available.`, recoveryAction: "record the Artifact against an existing Project Revision or its exact published Change Revision", receipt: `project=${requestedArtifactProjectId ?? artifactProjectRevisionId}; projectRevision=${artifactProjectRevisionId}; artifact=not-created; discoverable=false` });
        if (requestedArtifactProjectId && ((artifactProjectRevision && artifactProjectRevision.projectId !== requestedArtifactProjectId) || (artifactChangeProjectId && artifactChangeProjectId !== requestedArtifactProjectId))) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${artifactProjectRevisionId} is not available for Project ${requestedArtifactProjectId}.`, recoveryAction: "record the Artifact against the Project Revision belonging to the requested Project", receipt: `project=${requestedArtifactProjectId}; projectRevision=${artifactProjectRevisionId}; artifact=not-created; discoverable=false` });
        const artifactProjectId = requestedArtifactProjectId ?? artifactProjectRevision?.projectId ?? artifactChangeProjectId ?? artifactWorkspace?.projectId;
        if (artifactProjectId && !next.projects[artifactProjectId]) throw new AuthorityPlaneError({ code: "indeterminate", message: `Artifact Project ${artifactProjectId} is not readable.`, recoveryAction: "reconcile the Authority snapshot before recording the Artifact", receipt: `project=${artifactProjectId}; artifact=not-created` });
        if (artifactChangeRevisionId && (!artifactChangeRevision || !artifactChangeProjectId || (artifactProjectId && artifactChangeProjectId !== artifactProjectId) || artifactChangeRevision.projectRevisionId !== artifactProjectRevisionId)) throw new AuthorityPlaneError({ code: "conflict", message: `Change Revision ${artifactChangeRevisionId} is not bound to the Artifact Project and Project Revision.`, recoveryAction: "record the Artifact from the exact Change Revision that produced it", receipt: `project=${artifactProjectId ?? "not-supplied"}; changeRevision=${artifactChangeRevisionId}; projectRevision=${artifactProjectRevisionId}; artifact=not-created` });
        if (artifactRunId && (!artifactRun || (artifactProjectId && (artifactRun.projectRevisionId !== artifactProjectRevisionId || (artifactChangeProjectId && next.changes[artifactChangeRevision!.changeId]?.projectId !== artifactProjectId))) || (artifactChangeRevisionId && artifactRun.changeRevisionId !== artifactChangeRevisionId))) throw new AuthorityPlaneError({ code: "conflict", message: `Run ${artifactRunId} is not bound to the Artifact Project, Project Revision, or Change Revision.`, recoveryAction: "record the Artifact from the exact Run that produced it", receipt: `run=${artifactRunId}; projectRevision=${artifactProjectRevisionId}; artifact=not-created` });
        if (artifactRunId && artifactRun?.status !== "succeeded") throw new AuthorityPlaneError({ code: "conflict", message: `Run ${artifactRunId} is ${artifactRun?.status ?? "missing"}; Artifact cannot assert a successful output from it.`, recoveryAction: "record a successful determinate Run before recording the Artifact", receipt: `run=${artifactRunId}; status=${artifactRun?.status ?? "missing"}; artifact=not-created` });
        if (artifactRunId && artifactActionId && artifactRun?.actionId !== artifactActionId) throw new AuthorityPlaneError({ code: "conflict", message: `Artifact Action ${artifactActionId} does not match Run ${artifactRunId}.`, recoveryAction: "record the Artifact with the Action that produced the Run", receipt: `run=${artifactRunId}; action=match-required; artifact=not-created` });
        if (artifactWorkspaceId && (!artifactWorkspace || (artifactProjectId && artifactWorkspace.projectId !== artifactProjectId) || (artifactChangeRevision && artifactChangeRevision.workspaceId !== artifactWorkspaceId))) throw new AuthorityPlaneError({ code: "conflict", message: `Workspace ${artifactWorkspaceId} is not bound to the Artifact Project or Change Revision.`, recoveryAction: "record the Artifact from the Workspace that produced the output", receipt: `workspace=${artifactWorkspaceId}; artifact=not-created` });
        const artifactOutputPath = optionalString(payload.outputPath);
        const artifactProvenanceDigest = optionalString(payload.provenanceDigest);
        const artifactDisclosure = payload.disclosure as Record<string, unknown> | undefined;
        const artifact: Artifact = { protocol: CONTRACT_VERSIONS.artifact, id: optionalString(payload.artifactId) ?? opaqueId("artifact"), type: requiredString(payload.type, "type"), digest: requiredString(payload.digest, "digest"), projectRevisionId: artifactProjectRevisionId, ...(artifactChangeRevisionId ? { changeRevisionId: artifactChangeRevisionId } : {}), ...(artifactRunId ? { runId: artifactRunId } : {}), ...(artifactActionId ? { actionId: artifactActionId } : {}), ...(artifactOutputPath ? { outputPath: artifactOutputPath } : {}), ...(artifactProvenanceDigest ? { provenanceDigest: artifactProvenanceDigest } : {}), ...(artifactDisclosure ? { disclosure: { projectionId: requiredString(artifactDisclosure.projectionId, "disclosure.projectionId"), classification: requiredString(artifactDisclosure.classification, "disclosure.classification") as DisclosureClassification } } : {}) };
        if (next.artifacts[artifact.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Artifact ${artifact.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Artifact identity", receipt: `artifact=${artifact.id}; exists=true; transition=not-applied` });
        next.artifacts[artifact.id] = artifact;
        return success({ artifact }, `artifact=${artifact.id}; digest=${artifact.digest}; immutable=true`);
      }
      case "mirror.configure": {
        const mirrorProjectId = requiredString(payload.projectId, "projectId");
        const mirrorProject = next.projects[mirrorProjectId];
        if (!mirrorProject) throw new AuthorityPlaneError({ code: "not_found", message: `Project ${mirrorProjectId} does not exist.`, recoveryAction: "create or restore the Project before configuring a Repository Mirror", receipt: `project=${mirrorProjectId}; mirror=not-configured; discoverable=false` });
        const mirrorSourceSpaceId = requiredString(payload.sourceSpaceId, "sourceSpaceId");
        const mirrorSourceSpace = next.sourceSpaces[mirrorSourceSpaceId];
        if (!mirrorSourceSpace || !mirrorProject.sourceSpaceIds.includes(mirrorSourceSpaceId)) throw new AuthorityPlaneError({ code: "not_found", message: `Source Space ${mirrorSourceSpaceId} is not available for Project ${mirrorProjectId}.`, recoveryAction: "configure a Mirror only for a Source Space disclosed by the Project", receipt: `project=${mirrorProjectId}; sourceSpace=${mirrorSourceSpaceId}; mirror=not-configured; discoverable=false` });
        const mirrorCanonicalProjectRevisionId = requiredString(payload.canonicalProjectRevisionId ?? next.canonicalByProject[mirrorProjectId], "canonicalProjectRevisionId");
        if (next.canonicalByProject[mirrorProjectId] !== mirrorCanonicalProjectRevisionId) throw new AuthorityPlaneError({ code: "stale_state", message: `Mirror configuration names ${mirrorCanonicalProjectRevisionId}, not the current canonical Project Revision.`, recoveryAction: "read the current canonical Project Revision and retry with a fresh idempotency key", receipt: `project=${mirrorProjectId}; expectedCanonical=${mirrorCanonicalProjectRevisionId}; actualCanonical=${next.canonicalByProject[mirrorProjectId] ?? "missing"}; mirror=not-configured` });
        const mirrorCanonicalProjectRevision = next.projectRevisions[mirrorCanonicalProjectRevisionId];
        if (!mirrorCanonicalProjectRevision || mirrorCanonicalProjectRevision.projectId !== mirrorProjectId) throw new AuthorityPlaneError({ code: "indeterminate", message: `Canonical Project Revision ${mirrorCanonicalProjectRevisionId} is not readable for Project ${mirrorProjectId}.`, recoveryAction: "restore the canonical Project Revision before configuring the Repository Mirror", receipt: `project=${mirrorProjectId}; canonicalRevision=${mirrorCanonicalProjectRevisionId}; mirror=not-configured; lineage=incomplete` });
        const disclosure = enumString(payload.disclosure, "disclosure", ["public", "project", "restricted"] as const);
        if (payload.canonicalAuthority !== undefined && payload.canonicalAuthority !== "anyam") throw new AuthorityPlaneError({ code: "invalid_request", message: "Provider-authoritative Repository Mirrors are not supported.", recoveryAction: "configure the external repository as an Anyam projection; provider branch protection is optional and never replaces Anyam Landing", receipt: `canonicalAuthority=${typeof payload.canonicalAuthority === "string" ? payload.canonicalAuthority : "invalid"}; providerRole=projection; transition=not-applied` });
        const canonicalAuthority = "anyam";
        if (disclosure === "public" && mirrorSourceSpace.classification !== "public") throw new AuthorityPlaneError({ code: "conflict", message: `Public Mirror disclosure is not permitted for ${mirrorSourceSpace.classification} Source Space ${mirrorSourceSpaceId}.`, recoveryAction: "choose a Project or restricted disclosure, or configure a public Source Space", receipt: `project=${mirrorProjectId}; sourceSpace=${mirrorSourceSpaceId}; disclosure=public; mirror=not-configured` });
        const mappingValue = payload.refMappings;
        if (!Array.isArray(mappingValue) || mappingValue.length === 0) throw new AuthorityPlaneError({ code: "invalid_request", message: "refMappings must contain at least one local and remote ref mapping.", recoveryAction: "declare the exact Git refs the Mirror may project", receipt: "refMappings=non-empty-required; mirror=not-configured" });
        const refMappings = mappingValue.map((entry, index) => {
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new AuthorityPlaneError({ code: "invalid_request", message: `refMappings[${index}] must be an object.`, recoveryAction: "declare each ref mapping with localRef and remoteRef", receipt: `refMappings[${index}]=object-required; mirror=not-configured` });
          const mapping = entry as Record<string, unknown>;
          return { localRef: requiredString(mapping.localRef, `refMappings[${index}].localRef`), remoteRef: requiredString(mapping.remoteRef, `refMappings[${index}].remoteRef`) };
        });
        if (new Set(refMappings.map((mapping) => mapping.localRef)).size !== refMappings.length || new Set(refMappings.map((mapping) => mapping.remoteRef)).size !== refMappings.length) throw new AuthorityPlaneError({ code: "conflict", message: "refMappings must not contain duplicate local or remote refs.", recoveryAction: "declare one mapping per local and remote ref", receipt: "refMappings=duplicates; mirror=not-configured" });
        const mirror: RepositoryMirror = {
          protocol: CONTRACT_VERSIONS.mirror,
          id: optionalString(payload.mirrorId) ?? opaqueId("mirror"),
          projectId: mirrorProjectId,
          sourceSpaceId: mirrorSourceSpaceId,
          provider: requiredString(payload.provider, "provider"),
          remoteRepository: requiredString(payload.remoteRepository, "remoteRepository"),
          direction: "bidirectional",
          canonicalAuthority,
          refMappings,
          disclosure,
          state: enumString(payload.state, "state", ["healthy", "lagging", "divergent", "force-pushed", "blocked", "credential-failed", "disabled"] as const, "healthy"),
          canonicalProjectRevisionId: mirrorCanonicalProjectRevisionId,
          canonicalRefs: gitRefs(payload.canonicalRefs ?? [], "canonicalRefs"),
          remoteGeneration: requiredString(payload.remoteGeneration, "remoteGeneration"),
          remoteRefs: gitRefs(payload.remoteRefs ?? [], "remoteRefs"),
          pendingInboundChangeIds: [],
          createdAt: now(),
          updatedAt: now(),
          receipt: receiptString(payload.receipt, "receipt"),
        };
        const configuredLocalRefs = new Set(refMappings.map((mapping) => mapping.localRef));
        const configuredRemoteRefs = new Set(refMappings.map((mapping) => mapping.remoteRef));
        if (mirror.canonicalRefs.some((ref) => !configuredLocalRefs.has(ref.name)) || mirror.remoteRefs.some((ref) => !configuredRemoteRefs.has(ref.name))) throw new AuthorityPlaneError({ code: "conflict", message: `Repository Mirror ${mirror.id} includes a ref outside its declared mapping.`, recoveryAction: "declare only canonical and remote refs covered by refMappings", receipt: `mirror=${mirror.id}; refMapping=configuration-rejected; transition=not-applied` });
        const configuredPendingChangeIds = stringArray(payload.pendingInboundChangeIds ?? [], "pendingInboundChangeIds", true);
        for (const changeId of configuredPendingChangeIds) {
          const change = next.changes[changeId];
          if (!change || change.projectId !== mirrorProjectId || change.baseProjectRevisionId !== mirrorCanonicalProjectRevisionId) throw new AuthorityPlaneError({ code: "conflict", message: `Pending Change ${changeId} is not available for Mirror ${mirror.id}.`, recoveryAction: "declare only existing Changes for this Project and canonical base; no Mirror transition was accepted", receipt: `mirror=${mirror.id}; change=${changeId}; pending=not-accepted; discoverable=false` });
        }
        if (next.mirrors[mirror.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Repository Mirror ${mirror.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Mirror identity", receipt: `mirror=${mirror.id}; exists=true; transition=not-applied` });
        const configuredMirror = { ...mirror, pendingInboundChangeIds: configuredPendingChangeIds };
        next.mirrors[mirror.id] = configuredMirror;
        return success({ mirror: configuredMirror }, `mirror=${mirror.id}; project=${mirror.projectId}; sourceSpace=${mirror.sourceSpaceId}; canonicalAuthority=${mirror.canonicalAuthority}; providerRole=projection; providerProtection=not-required; canonicalWrite=false; credentialFree=true`);
      }
      case "mirror.sync":
      case "mirror.reconcile": {
        const mirrorId = requiredString(payload.mirrorId, "mirrorId");
        const mirror = next.mirrors[mirrorId];
        if (!mirror) throw new AuthorityPlaneError({ code: "not_found", message: `Repository Mirror ${mirrorId} does not exist.`, recoveryAction: "configure the Repository Mirror before recording a sync or reconciliation", receipt: `mirror=${mirrorId}; operation=${command.command}; not-started; discoverable=false` });
        const currentProject = next.projects[mirror.projectId];
        const sourceSpace = next.sourceSpaces[mirror.sourceSpaceId];
        if (!currentProject || !sourceSpace || !currentProject.sourceSpaceIds.includes(mirror.sourceSpaceId)) throw new AuthorityPlaneError({ code: "indeterminate", message: `Repository Mirror ${mirrorId} has incomplete Project or Source Space lineage.`, recoveryAction: "restore the Project and Source Space catalog before resuming the Mirror checkpoint", receipt: `mirror=${mirrorId}; lineage=incomplete; operation=${command.command}; providerInvocation=false` });
        const canonicalProjectRevisionId = requiredString(payload.canonicalProjectRevisionId, "canonicalProjectRevisionId");
        const currentCanonical = next.canonicalByProject[mirror.projectId];
        if (canonicalProjectRevisionId !== currentCanonical) throw new AuthorityPlaneError({ code: "stale_state", message: `Mirror ${mirrorId} observed canonical Project Revision ${canonicalProjectRevisionId}, but the Authority is at ${currentCanonical ?? "missing"}.`, recoveryAction: "read the current canonical Project Revision and resume the provider operation from its checkpoint", receipt: `mirror=${mirrorId}; expectedCanonical=${canonicalProjectRevisionId}; actualCanonical=${currentCanonical ?? "missing"}; operation=${command.command}; providerInvocation=false` });
        const canonicalProjectRevision = next.projectRevisions[canonicalProjectRevisionId];
        if (!canonicalProjectRevision || canonicalProjectRevision.projectId !== mirror.projectId) throw new AuthorityPlaneError({ code: "indeterminate", message: `Canonical Project Revision ${canonicalProjectRevisionId} is not readable for Mirror ${mirrorId}.`, recoveryAction: "restore the canonical Project Revision before resuming the Mirror checkpoint", receipt: `mirror=${mirrorId}; canonicalRevision=${canonicalProjectRevisionId}; operation=${command.command}; lineage=incomplete; providerInvocation=false` });
        const canonicalRefs = gitRefs(payload.canonicalRefs, "canonicalRefs");
        const remoteRefs = gitRefs(payload.remoteRefs, "remoteRefs");
        const mappedLocalRefs = new Set(mirror.refMappings.map((mapping) => mapping.localRef));
        const mappedRemoteRefs = new Set(mirror.refMappings.map((mapping) => mapping.remoteRef));
        if (canonicalRefs.some((ref) => !mappedLocalRefs.has(ref.name)) || remoteRefs.some((ref) => !mappedRemoteRefs.has(ref.name))) throw new AuthorityPlaneError({ code: "conflict", message: `Mirror ${mirrorId} received a ref outside its declared mapping.`, recoveryAction: "project only the explicitly mapped refs and retry from the same provider checkpoint", receipt: `mirror=${mirrorId}; disclosure=ref-mapping-rejected; operation=${command.command}; providerInvocation=false` });
        const expectedRemoteGeneration = requiredString(payload.expectedRemoteGeneration, "expectedRemoteGeneration");
        const actualRemoteGeneration = requiredString(payload.remoteGeneration, "remoteGeneration");
        const reconciliation = command.command === "mirror.reconcile" ? enumString(payload.reconciliation, "reconciliation", ["remote-as-proposal", "canonical-wins"] as const) : undefined;
        if (reconciliation === "canonical-wins" && enumString(payload.operationState, "operationState", ["started", "succeeded", "failed", "blocked", "degraded"] as const, "succeeded") === "succeeded") {
          for (const mapping of mirror.refMappings) {
            const canonicalRef = canonicalRefs.find((ref) => ref.name === mapping.localRef);
            const remoteRef = remoteRefs.find((ref) => ref.name === mapping.remoteRef);
            if (!canonicalRef || !remoteRef || canonicalRef.oid !== remoteRef.oid) throw new AuthorityPlaneError({ code: "blocked", message: `Canonical-wins reconciliation for Mirror ${mirrorId} has not verified remote ref ${mapping.remoteRef}.`, recoveryAction: "complete the provider apply and report remote refs equal to the canonical mapped refs before marking reconciliation succeeded", receipt: `mirror=${mirrorId}; reconciliation=canonical-wins; ref=${mapping.remoteRef}; remote=not-verified; providerInvocation=false` });
          }
        }
        const generationMismatch = expectedRemoteGeneration !== mirror.remoteGeneration;
        const requestedOperationState = enumString(payload.operationState, "operationState", ["started", "succeeded", "failed", "blocked", "degraded"] as const, "succeeded");
        const operationState = generationMismatch && !reconciliation ? "blocked" : requestedOperationState;
        const operationId = optionalString(payload.operationId) ?? opaqueId("mirror-operation");
        if (next.mirrorOperations[operationId]) throw new AuthorityPlaneError({ code: "conflict", message: `Mirror Operation ${operationId} already exists.`, recoveryAction: "resume the recorded Mirror checkpoint or choose a new operation identity", receipt: `mirror=${mirrorId}; operation=${operationId}; exists=true; providerInvocation=false` });
        const resumeCheckpointId = optionalString(payload.resumeCheckpointId);
        if (resumeCheckpointId) {
          const resumeCheckpoint = next.mirrorCheckpoints[resumeCheckpointId];
          if (!resumeCheckpoint || resumeCheckpoint.mirrorId !== mirrorId || resumeCheckpoint.canonicalProjectRevisionId !== canonicalProjectRevisionId) throw new AuthorityPlaneError({ code: "not_found", message: `Mirror Checkpoint ${resumeCheckpointId} is not resumable for Mirror ${mirrorId}.`, recoveryAction: "resume from the owner-visible checkpoint belonging to this Mirror and canonical Project Revision", receipt: `mirror=${mirrorId}; checkpoint=${resumeCheckpointId}; resume=not-accepted; discoverable=false` });
        }
        const requestedOperationKind = enumString(payload.operationKind, "operationKind", ["sync", "outbound", "inbound", "reconcile"] as const, command.command === "mirror.reconcile" ? "reconcile" : "sync");
        if (command.command === "mirror.reconcile" && requestedOperationKind !== "reconcile") throw new AuthorityPlaneError({ code: "conflict", message: "mirror.reconcile requires operationKind=reconcile.", recoveryAction: "send a reconciliation operation with operationKind=reconcile; no provider operation was accepted", receipt: `mirror=${mirrorId}; operationKind=${requestedOperationKind}; command=mirror.reconcile; transition=not-applied` });
        const operationKind = requestedOperationKind;
        const checkpointId = optionalString(payload.checkpointId) ?? opaqueId("mirror-checkpoint");
        if (next.mirrorCheckpoints[checkpointId]) throw new AuthorityPlaneError({ code: "conflict", message: `Mirror Checkpoint ${checkpointId} already exists.`, recoveryAction: "resume the existing checkpoint or choose a new checkpoint identity", receipt: `mirror=${mirrorId}; checkpoint=${checkpointId}; exists=true; providerInvocation=false` });
        const operationRecoveryAction = optionalString(payload.recoveryAction) ?? (operationState === "succeeded" ? "inspect the completed Mirror checkpoint before starting another provider operation" : "inspect the named provider receipt and resume this checkpoint only after reconciling remote generation");
        const inboundChangeIds = stringArray(payload.inboundChangeIds ?? [], "inboundChangeIds", true);
        const completedInboundChangeIds = stringArray(payload.completedInboundChangeIds ?? [], "completedInboundChangeIds", true);
        const pendingInboundChangeIds = stringArray(payload.pendingInboundChangeIds ?? [], "pendingInboundChangeIds", true);
        for (const changeId of [...new Set([...inboundChangeIds, ...completedInboundChangeIds, ...pendingInboundChangeIds])]) {
          const change = next.changes[changeId];
          if (!change || change.projectId !== mirror.projectId || change.baseProjectRevisionId !== canonicalProjectRevisionId) throw new AuthorityPlaneError({ code: "conflict", message: `Mirror Change ${changeId} is not available for canonical Project Revision ${canonicalProjectRevisionId}.`, recoveryAction: "declare only existing Changes for this Project and canonical base; no Mirror transition was accepted", receipt: `mirror=${mirrorId}; change=${changeId}; operation=${command.command}; transition=not-applied; discoverable=false` });
        }
        const proposalValue = payload.externalProposal === undefined ? undefined : safeObject(payload.externalProposal, "externalProposal");
        let proposal: ExternalProposal | undefined;
        let proposalChange: Change | undefined;
        let proposalRevision: ChangeRevision | undefined;
        let proposalDelivery: MirrorDelivery | undefined;
        const deliveryValue = payload.delivery === undefined ? undefined : safeObject(payload.delivery, "delivery");
        if (deliveryValue) {
          const deliveryProvider = optionalString(deliveryValue.provider) ?? mirror.provider;
          const deliverySourceIdentity = requiredString(deliveryValue.sourceIdentity, "delivery.sourceIdentity");
          const deliveryRepository = requiredString(deliveryValue.remoteRepository, "delivery.remoteRepository");
          const deliveryId = requiredString(deliveryValue.deliveryId, "delivery.deliveryId");
          const deliveryInstallationId = optionalString(deliveryValue.installationId);
          const deliveryProposalKey = optionalString(deliveryValue.proposalKey);
          const deliveryEventType = requiredString(deliveryValue.eventType, "delivery.eventType");
          if (deliveryProvider !== mirror.provider || deliveryRepository !== mirror.remoteRepository) throw new AuthorityPlaneError({ code: "conflict", message: `Mirror delivery identity does not match Mirror ${mirrorId}.`, recoveryAction: "bind the delivery to the configured provider and repository; no provider credential was accepted", receipt: `mirror=${mirrorId}; delivery=${deliveryId}; identity=mirror-mismatch; providerInvocation=false` });
          const deliveryKey = mirrorDeliveryLedgerKey({ provider: deliveryProvider, ...(deliveryInstallationId ? { installationId: deliveryInstallationId } : {}), sourceIdentity: deliverySourceIdentity, remoteRepository: deliveryRepository, deliveryId });
          const existingDelivery = next.mirrorDeliveries[deliveryKey];
          if (existingDelivery) {
            if (existingDelivery.eventType !== deliveryEventType || existingDelivery.proposalKey !== deliveryProposalKey) throw new AuthorityPlaneError({ code: "conflict", message: `Delivery ${deliveryId} was previously recorded with different event identity.`, recoveryAction: "replay the original delivery envelope or use a new provider delivery identity", receipt: `mirror=${mirrorId}; delivery=${deliveryId}; duplicate=identity-conflict; providerInvocation=false` });
            const existingOperation = existingDelivery.operationId ? next.mirrorOperations[existingDelivery.operationId] : undefined;
            const existingCheckpoint = existingOperation ? next.mirrorCheckpoints[existingOperation.checkpointId] : undefined;
            const duplicateProposal = existingDelivery.proposalKey ? Object.values(next.externalProposals).find((candidate) => candidate.mirrorId === mirrorId && candidate.proposalKey === existingDelivery.proposalKey) : undefined;
            return success({ mirror, ...(existingOperation ? { operation: existingOperation } : {}), ...(existingCheckpoint ? { checkpoint: existingCheckpoint } : {}), delivery: existingDelivery, ...(duplicateProposal ? { proposal: duplicateProposal } : {}) }, `mirror=${mirrorId}; delivery=${deliveryId}; duplicate=true; transition=not-repeated; credentialFree=true; canonicalWrite=false`);
          }
          proposalDelivery = { protocol: CONTRACT_VERSIONS.mirrorDelivery, id: optionalString(deliveryValue.id) ?? opaqueId("mirror-delivery"), mirrorId, provider: deliveryProvider, ...(deliveryInstallationId ? { installationId: deliveryInstallationId } : {}), sourceIdentity: deliverySourceIdentity, remoteRepository: deliveryRepository, deliveryId, deliveryKey, eventType: deliveryEventType, ...(deliveryProposalKey ? { proposalKey: deliveryProposalKey } : {}), operationId, state: operationState === "succeeded" ? "processed" : "blocked", createdAt: now(), ...(operationState === "succeeded" ? { processedAt: now() } : {}), receipt: `delivery=${deliveryId}; mirror=${mirrorId}; state=${operationState === "succeeded" ? "processed" : "blocked"}; credentialFree=true` };
        }
        if (proposalValue && operationState === "succeeded" && reconciliation !== "canonical-wins") {
          const proposalProvider = optionalString(proposalValue.provider) ?? mirror.provider;
          const proposalSourceIdentity = requiredString(proposalValue.sourceIdentity, "externalProposal.sourceIdentity");
          const proposalRepository = requiredString(proposalValue.remoteRepository, "externalProposal.remoteRepository");
          const proposalKind = enumString(proposalValue.proposalKind, "externalProposal.proposalKind", ["pull-request", "ref", "commit"] as const);
          const proposalKey = requiredString(proposalValue.proposalKey, "externalProposal.proposalKey");
          const proposalHead = requiredString(proposalValue.latestHeadCommit ?? proposalValue.headCommit, "externalProposal.latestHeadCommit");
          const proposalBaseProjectRevisionId = requiredString(proposalValue.baseProjectRevisionId, "externalProposal.baseProjectRevisionId");
          const proposalDisclosure = enumString(proposalValue.disclosure, "externalProposal.disclosure", ["public", "project", "restricted"] as const, mirror.disclosure);
          const proposalInstallationId = optionalString(proposalValue.installationId);
          if (proposalProvider !== mirror.provider || proposalRepository !== mirror.remoteRepository) throw new AuthorityPlaneError({ code: "conflict", message: `External proposal identity does not match Mirror ${mirrorId}.`, recoveryAction: "bind the proposal to the configured provider and repository", receipt: `mirror=${mirrorId}; proposal=${proposalKey}; identity=mirror-mismatch; providerInvocation=false` });
          if (proposalDelivery && (proposalDelivery.provider !== proposalProvider || proposalDelivery.installationId !== proposalInstallationId || proposalDelivery.sourceIdentity !== proposalSourceIdentity || proposalDelivery.remoteRepository !== proposalRepository || proposalDelivery.proposalKey !== proposalKey)) throw new AuthorityPlaneError({ code: "conflict", message: `Mirror delivery identity does not match external proposal ${proposalKey}.`, recoveryAction: "send a delivery and proposal envelope with matching provider, installation, source identity, repository, and proposal key", receipt: `mirror=${mirrorId}; proposal=${proposalKey}; delivery=${proposalDelivery.deliveryId}; identity=proposal-delivery-mismatch; providerInvocation=false` });
          if (proposalBaseProjectRevisionId !== canonicalProjectRevisionId) throw new AuthorityPlaneError({ code: "stale_state", message: `External proposal ${proposalKey} is based on ${proposalBaseProjectRevisionId}, not the current canonical Project Revision ${canonicalProjectRevisionId}.`, recoveryAction: "rebase or quarantine the proposal against the current canonical Project Revision; no Change was advanced", receipt: `mirror=${mirrorId}; proposal=${proposalKey}; base=${proposalBaseProjectRevisionId}; canonical=${canonicalProjectRevisionId}; proposal=blocked` });
          const proposalBaseCommit = optionalString(proposalValue.baseCommit);
          const canonicalSourceSnapshot = canonicalProjectRevision.sourceSpaceSnapshots[mirror.sourceSpaceId];
          if (proposalBaseCommit && proposalBaseCommit !== canonicalSourceSnapshot) throw new AuthorityPlaneError({ code: "stale_state", message: `External proposal ${proposalKey} names base commit ${proposalBaseCommit}, not the canonical ${canonicalSourceSnapshot ?? "missing"} Source Space snapshot.`, recoveryAction: "rebase the proposal against the current canonical Source Space snapshot before importing it", receipt: `mirror=${mirrorId}; proposal=${proposalKey}; baseCommit=${proposalBaseCommit}; canonicalSource=${canonicalSourceSnapshot ?? "missing"}; proposal=blocked` });
          if (proposalDisclosure !== mirror.disclosure || (proposalDisclosure === "public" && sourceSpace.classification !== "public")) throw new AuthorityPlaneError({ code: "conflict", message: `External proposal ${proposalKey} disclosure is not permitted by Mirror ${mirrorId}.`, recoveryAction: "use a Project View whose disclosure matches the Mirror and Source Space policy", receipt: `mirror=${mirrorId}; proposal=${proposalKey}; disclosure=${proposalDisclosure}; sourceClassification=${sourceSpace.classification}; proposal=blocked; discoverable=false` });
          const proposalViewId = requiredString(proposalValue.projectViewId, "externalProposal.projectViewId");
          const proposalView = next.projectViews[proposalViewId];
          if (!proposalView || proposalView.projectId !== mirror.projectId || proposalView.projectRevisionId !== canonicalProjectRevisionId || !proposalView.visibleSourceSpaceIds.includes(mirror.sourceSpaceId) || proposalView.classification !== proposalDisclosure) throw new AuthorityPlaneError({ code: "not_found", message: `Project View ${proposalViewId} is not a permitted disclosure View for external proposal ${proposalKey}.`, recoveryAction: "create or select the exact Project View that discloses this Source Space at the current canonical Project Revision", receipt: `mirror=${mirrorId}; proposal=${proposalKey}; projectView=${proposalViewId}; disclosure=blocked; discoverable=false` });
          const proposalLedgerKey = mirrorProposalLedgerKey({ provider: proposalProvider, ...(proposalInstallationId ? { installationId: proposalInstallationId } : {}), sourceIdentity: proposalSourceIdentity, remoteRepository: proposalRepository, proposalKind, proposalKey });
          const existingProposal = next.externalProposals[proposalLedgerKey];
          if (existingProposal) {
            if (existingProposal.mirrorId !== mirrorId || existingProposal.projectId !== mirror.projectId || existingProposal.sourceSpaceId !== mirror.sourceSpaceId) throw new AuthorityPlaneError({ code: "conflict", message: `External proposal ${proposalKey} is already mapped to a different Anyam Mirror.`, recoveryAction: "inspect the proposal ledger and reconcile the provider source identity before retrying", receipt: `proposal=${proposalKey}; ledgerKey=${proposalLedgerKey}; mapping=conflict; providerInvocation=false` });
            proposal = { ...existingProposal };
            proposalChange = next.changes[proposal.changeId];
            if (!proposalChange) throw new AuthorityPlaneError({ code: "indeterminate", message: `External proposal ${proposalKey} refers to missing Change ${proposal.changeId}.`, recoveryAction: "restore the stable Change before resuming the Mirror checkpoint", receipt: `proposal=${proposalKey}; change=${proposal.changeId}; lineage=incomplete` });
          } else {
            const remoteRef = optionalString(proposalValue.remoteRef);
            const remoteAuthorValue = proposalValue.remoteAuthor && typeof proposalValue.remoteAuthor === "object" && !Array.isArray(proposalValue.remoteAuthor) ? proposalValue.remoteAuthor as Record<string, unknown> : undefined;
            const remoteAuthorEmail = remoteAuthorValue ? optionalString(remoteAuthorValue.email) : undefined;
            const origin: Change["origin"] = { kind: "mirror", source: proposalProvider, mirrorId, remoteRepository: proposalRepository, ...(remoteRef ? { remoteRef } : {}), remoteCommit: proposalHead, ...(remoteAuthorValue ? { remoteAuthor: { name: requiredString(remoteAuthorValue.name, "externalProposal.remoteAuthor.name"), ...(remoteAuthorEmail ? { email: remoteAuthorEmail } : {}) } } : {}), externalProposalKey: proposalKey, externalProposalKind: proposalKind, externalProposalHead: proposalHead, ...(proposalBaseCommit ? { externalProposalBase: proposalBaseCommit } : {}), ...(proposalInstallationId ? { externalProposalInstallation: proposalInstallationId } : {}), externalProposalSourceIdentity: proposalSourceIdentity, ...(proposalDelivery ? { externalDeliveryId: proposalDelivery.deliveryId } : {}), disclosure: proposalDisclosure, receipt: receiptString(proposalValue.receipt, "externalProposal.receipt") };
            const changeResult = this.apply(next, { protocol: AUTHORITY_COMMAND_PROTOCOL, command: "change.create", idempotencyKey: `${command.idempotencyKey}:external-change`, payload: { projectId: mirror.projectId, intentId: optionalString(proposalValue.intentId) ?? `intent:external:${proposalKey}`, ...(optionalString(proposalValue.changeId) ? { changeId: optionalString(proposalValue.changeId) } : {}), baseProjectRevisionId: canonicalProjectRevisionId, origin } }, session);
            proposalChange = changeResult.value.change as Change;
          }
          const observedHeadAlready = proposal?.observedHeadCommits.includes(proposalHead) ?? false;
          if (!observedHeadAlready) {
            const suppliedSourceSnapshots = proposalValue.sourceSpaceSnapshots === undefined ? undefined : record<string>(proposalValue.sourceSpaceSnapshots, "externalProposal.sourceSpaceSnapshots");
            const visibleSourceSpaceIds = new Set(proposalView.visibleSourceSpaceIds);
            const sourceSnapshots = suppliedSourceSnapshots === undefined
              ? { ...proposalView.disclosedSourceSpaceSnapshots, [mirror.sourceSpaceId]: proposalHead }
              : { ...suppliedSourceSnapshots };
            for (const sourceSpaceId of Object.keys(sourceSnapshots)) {
              if (!visibleSourceSpaceIds.has(sourceSpaceId) || proposalView.disclosedSourceSpaceSnapshots[sourceSpaceId] === undefined) throw new AuthorityPlaneError({ code: "conflict", message: `External proposal ${proposalKey} includes Source Space ${sourceSpaceId} outside Project View ${proposalViewId}.`, recoveryAction: "publish only the Source Space snapshots disclosed by the exact Project View", receipt: `mirror=${mirrorId}; proposal=${proposalKey}; sourceSpace=${sourceSpaceId}; disclosure=blocked; providerInvocation=false` });
              if (sourceSpaceId !== mirror.sourceSpaceId && sourceSnapshots[sourceSpaceId] !== proposalView.disclosedSourceSpaceSnapshots[sourceSpaceId]) throw new AuthorityPlaneError({ code: "conflict", message: `External proposal ${proposalKey} changes disclosed Source Space ${sourceSpaceId} outside the mirrored Source Space.`, recoveryAction: "use the Project View snapshot for every non-mirrored Source Space", receipt: `mirror=${mirrorId}; proposal=${proposalKey}; sourceSpace=${sourceSpaceId}; snapshot=disclosure-mismatch; providerInvocation=false` });
            }
            if (sourceSnapshots[mirror.sourceSpaceId] !== proposalHead) throw new AuthorityPlaneError({ code: "conflict", message: `External proposal ${proposalKey} does not map its mirrored Source Space to head ${proposalHead}.`, recoveryAction: "include the mirrored Source Space with the exact external proposal head commit", receipt: `mirror=${mirrorId}; proposal=${proposalKey}; sourceSpace=${mirror.sourceSpaceId}; expectedHead=${proposalHead}; snapshot=not-accepted; providerInvocation=false` });
            const revisionResult = this.apply(next, { protocol: AUTHORITY_COMMAND_PROTOCOL, command: "revision.publish", idempotencyKey: `${command.idempotencyKey}:external-revision:${proposalHead}`, payload: { changeId: proposalChange!.id, projectId: mirror.projectId, projectViewId: proposalViewId, projectRevisionId: optionalString(proposalValue.projectRevisionId) ?? `proposal-revision:${proposalHead}`, sourceSpaceSnapshots: sourceSnapshots, declaredEffects: proposalValue.declaredEffects ?? ["mirror.external-proposal"], kind: "implementation" } }, session);
            proposalRevision = revisionResult.value.revision as ChangeRevision;
          }
          const nowAt = now();
          const previousProposal = existingProposal;
          const proposalRemoteRef = optionalString(proposalValue.remoteRef);
          const proposalBaseRef = optionalString(proposalValue.baseRef);
          const proposalStatus = enumString(proposalValue.status, "externalProposal.status", ["open", "closed", "merged", "blocked"] as const, previousProposal?.status ?? "open");
          const persistedProposal: ExternalProposal = previousProposal
            ? { ...previousProposal, latestHeadCommit: proposalHead, ...(proposalRemoteRef ? { remoteRef: proposalRemoteRef } : {}), ...(proposalBaseRef ? { baseRef: proposalBaseRef } : {}), ...(proposalBaseCommit ? { baseCommit: proposalBaseCommit } : {}), status: proposalStatus, observedHeadCommits: observedHeadAlready ? [...previousProposal.observedHeadCommits] : [...previousProposal.observedHeadCommits, proposalHead], changeRevisionIds: proposalRevision ? [...previousProposal.changeRevisionIds, proposalRevision.id] : [...previousProposal.changeRevisionIds], ...(proposalDelivery?.deliveryId ? { lastDeliveryId: proposalDelivery.deliveryId } : {}), updatedAt: nowAt, receipt: `proposal=${proposalKey}; change=${previousProposal.changeId}; head=${proposalHead}; status=${proposalStatus}; revision=${proposalRevision?.id ?? "unchanged"}; mapping=stable; credentialFree=true` }
            : { protocol: CONTRACT_VERSIONS.externalProposal, id: opaqueId("external-proposal"), ledgerKey: proposalLedgerKey, mirrorId, projectId: mirror.projectId, sourceSpaceId: mirror.sourceSpaceId, provider: proposalProvider, ...(proposalInstallationId ? { installationId: proposalInstallationId } : {}), sourceIdentity: proposalSourceIdentity, remoteRepository: proposalRepository, proposalKind, proposalKey, ...(proposalRemoteRef ? { remoteRef: proposalRemoteRef } : {}), ...(proposalBaseRef ? { baseRef: proposalBaseRef } : {}), ...(proposalBaseCommit ? { baseCommit: proposalBaseCommit } : {}), latestHeadCommit: proposalHead, observedHeadCommits: [proposalHead], changeId: proposalChange!.id, changeRevisionIds: proposalRevision ? [proposalRevision.id] : [], status: proposalStatus, ...(proposalDelivery ? { lastDeliveryId: proposalDelivery.deliveryId } : {}), disclosure: proposalDisclosure, createdAt: nowAt, updatedAt: nowAt, receipt: `proposal=${proposalKey}; change=${proposalChange!.id}; head=${proposalHead}; status=${proposalStatus}; revision=${proposalRevision?.id ?? "none"}; mapping=created; credentialFree=true` };
          proposal = persistedProposal;
          next.externalProposals[proposalLedgerKey] = persistedProposal;
        }
        if (proposalDelivery) next.mirrorDeliveries[proposalDelivery.deliveryKey] = proposalDelivery;
        const checkpointState = operationState === "succeeded" ? "completed" : operationState === "started" ? "remote-inspected" : "blocked";
        const checkpoint: MirrorCheckpoint = { protocol: CONTRACT_VERSIONS.mirrorCheckpoint, id: checkpointId, mirrorId, operationId, state: checkpointState, canonicalProjectRevisionId, canonicalRefs, remoteGeneration: actualRemoteGeneration, remoteRefs, completedInboundChangeIds: [...new Set([...stringArray(payload.completedInboundChangeIds ?? [], "completedInboundChangeIds", true), ...(proposalChange ? [proposalChange.id] : []), ...inboundChangeIds])], recoveryAction: operationRecoveryAction, receipt: `mirror=${mirrorId}; checkpoint=${checkpointId}; state=${checkpointState}; operation=${operationId}; credentialFree=true` };
        const errorCode = optionalString(payload.errorCode);
        const operationReceipt = receiptString(payload.receipt, "receipt");
        const operation: MirrorOperation = { protocol: CONTRACT_VERSIONS.mirrorOperation, id: operationId, mirrorId, kind: operationKind, state: operationState, canonicalProjectRevisionId, expectedRemoteGeneration, actualRemoteGeneration, actor, inboundChangeIds: [...new Set([...inboundChangeIds, ...(proposalChange ? [proposalChange.id] : [])])], checkpointId, ...(errorCode ? { errorCode } : {}), createdAt: now(), ...(operationState === "succeeded" ? { completedAt: now() } : {}), receipt: operationReceipt };
        const nextMirrorState = operationState === "succeeded" ? enumString(payload.mirrorState, "mirrorState", ["healthy", "lagging", "divergent", "force-pushed", "blocked", "credential-failed", "disabled"] as const, "healthy") : operationState === "failed" ? "divergent" : operationState === "degraded" ? "lagging" : "blocked";
        const originOperationId = optionalString(payload.originOperationId);
        const acceptsRemoteBoundary = operationState === "succeeded";
        const updatedMirror: RepositoryMirror = {
          ...mirror,
          state: nextMirrorState,
          ...(acceptsRemoteBoundary ? { canonicalProjectRevisionId, canonicalRefs, remoteGeneration: actualRemoteGeneration, remoteRefs, pendingInboundChangeIds: [...new Set([...mirror.pendingInboundChangeIds, ...pendingInboundChangeIds, ...inboundChangeIds, ...(proposalChange ? [proposalChange.id] : [])])] } : {}),
          lastOperationId: operationId,
          ...(originOperationId ? { lastOriginOperationId: originOperationId } : {}),
          checkpointId,
          updatedAt: now(),
          receipt: `mirror=${mirrorId}; state=${nextMirrorState}; operation=${operationId}; acceptedRemoteBoundary=${acceptsRemoteBoundary}; canonicalWrite=false; credentialFree=true`,
        };
        next.mirrorOperations[operation.id] = operation;
        next.mirrorCheckpoints[checkpoint.id] = checkpoint;
        next.mirrors[mirror.id] = updatedMirror;
        return operationState === "succeeded" ? success({ mirror: updatedMirror, operation, checkpoint, ...(proposal ? { proposal } : {}), ...(proposalChange ? { change: proposalChange } : {}), ...(proposalRevision ? { revision: proposalRevision } : {}), ...(proposalDelivery ? { delivery: proposalDelivery } : {}) }, `mirror=${mirrorId}; operation=${operation.id}; state=succeeded; canonicalWrite=false; credentialFree=true`) : blocked({ mirror: updatedMirror, operation, checkpoint, ...(proposalDelivery ? { delivery: proposalDelivery } : {}) }, `mirror=${mirrorId}; operation=${operation.id}; state=${operationState}; checkpoint=${checkpoint.id}; canonicalWrite=false; credentialFree=true`, operationRecoveryAction);
      }
      case "landing.apply": {
        const changeRevisionId = requiredString(payload.changeRevisionId, "changeRevisionId");
        const revision = next.changeRevisions[changeRevisionId];
        if (!revision) throw new AuthorityPlaneError({ code: "not_found", message: `Change Revision ${changeRevisionId} does not exist.`, recoveryAction: "publish the Change Revision before Landing", receipt: `changeRevision=${changeRevisionId}; landing=not-created` });
        const change = next.changes[revision.changeId];
        if (!change) throw new AuthorityPlaneError({ code: "not_found", message: `Change ${revision.changeId} does not exist for Change Revision ${changeRevisionId}.`, recoveryAction: "restore the stable Change record before Landing", receipt: `changeRevision=${changeRevisionId}; landing=not-created` });
        const projectId = change.projectId;
        const requestedProjectId = optionalString(payload.projectId);
        if (requestedProjectId && requestedProjectId !== projectId) throw new AuthorityPlaneError({ code: "not_found", message: `Change Revision ${changeRevisionId} is not available for Project ${requestedProjectId}.`, recoveryAction: "verify the Project and Change Revision identifiers without probing hidden resources", receipt: `project=${requestedProjectId}; changeRevision=${changeRevisionId}; landing=not-created; discoverable=false` });
        const requestedChangeId = optionalString(payload.changeId);
        if (requestedChangeId && requestedChangeId !== change.id) throw new AuthorityPlaneError({ code: "not_found", message: `Change Revision ${changeRevisionId} is not available for Change ${requestedChangeId}.`, recoveryAction: "verify the Change and Change Revision identifiers without probing hidden resources", receipt: `change=${requestedChangeId}; changeRevision=${changeRevisionId}; landing=not-created; discoverable=false` });
        const expected = optionalString(payload.expectedCanonicalProjectRevisionId);
        const actual = next.canonicalByProject[projectId];
        if (expected !== undefined && expected !== actual) throw new AuthorityPlaneError({ code: "stale_state", message: `Canonical Project Revision changed before Landing ${changeRevisionId}.`, recoveryAction: "read the current canonical Project Revision, rebase or compose the Change, and retry with a new idempotency key", receipt: `project=${projectId}; expectedCanonical=${expected}; actualCanonical=${actual}; landing=not-created` });
        if (actual !== change.baseProjectRevisionId) throw new AuthorityPlaneError({ code: "conflict", message: `Change ${change.id} was based on ${change.baseProjectRevisionId}, not the current canonical Project Revision ${actual}.`, recoveryAction: "publish a rebase or conflict-resolution Revision before Landing", receipt: `change=${change.id}; base=${change.baseProjectRevisionId}; canonical=${actual}; landing=not-created` });
        if (change.status !== "submitted" || change.latestRevisionId !== revision.id) throw new AuthorityPlaneError({ code: "conflict", message: `Change ${change.id} is not ready to Land at Change Revision ${revision.id}.`, recoveryAction: "publish the latest Revision and submit the Change before Landing", receipt: `change=${change.id}; status=${change.status}; latest=${change.latestRevisionId ?? "none"}; requested=${revision.id}; landing=not-created` });
        const requestedLandedRevisionId = optionalString(payload.projectRevisionId);
        if (requestedLandedRevisionId && next.projectRevisions[requestedLandedRevisionId]) throw new AuthorityPlaneError({ code: "conflict", message: `Project Revision ${requestedLandedRevisionId} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Project Revision identity", receipt: `projectRevision=${requestedLandedRevisionId}; exists=true; landing=not-created` });
        const currentCanonicalRevision = next.projectRevisions[actual];
        if (!currentCanonicalRevision || currentCanonicalRevision.projectId !== projectId) throw new AuthorityPlaneError({ code: "indeterminate", message: `Current canonical Project Revision ${actual} is not readable for Project ${projectId}.`, recoveryAction: "restore the canonical Project Revision before Landing this Change", receipt: `project=${projectId}; canonical=${actual}; landing=not-created; lineage=incomplete` });
        const changeSnapshots = revision.sourceSpaceSnapshots ?? {};
        const unknownChangeSourceSpace = Object.keys(changeSnapshots).find((sourceSpaceId) => !next.projects[projectId]?.sourceSpaceIds.includes(sourceSpaceId));
        if (unknownChangeSourceSpace) throw new AuthorityPlaneError({ code: "conflict", message: `Change Revision ${revision.id} names Source Space ${unknownChangeSourceSpace} outside Project ${projectId}.`, recoveryAction: "publish only Source Spaces belonging to the Project before Landing", receipt: `project=${projectId}; sourceSpace=${unknownChangeSourceSpace}; landing=not-created` });
        const nextProjectRevision = createProjectRevision({ ...(requestedLandedRevisionId ? { id: requestedLandedRevisionId } : {}), projectId, sourceSpaceSnapshots: { ...currentCanonicalRevision.sourceSpaceSnapshots, ...changeSnapshots }, parentProjectRevisionId: actual, landedChangeRevisionId: revision.id });
        const landing: Landing = { protocol: CONTRACT_VERSIONS.landing, id: optionalString(payload.landingId) ?? opaqueId("landing"), projectId, changeId: change.id, changeRevisionId: revision.id, previousProjectRevisionId: actual, projectRevisionId: nextProjectRevision.id, receipt: `landing=accepted; canonicalMutation=coordinator-only; previous=${actual}; next=${nextProjectRevision.id}` };
        next.projectRevisions[nextProjectRevision.id] = nextProjectRevision;
        next.canonicalByProject[projectId] = nextProjectRevision.id;
        next.landings[landing.id] = landing;
        next.changes[change.id] = { ...change, status: "landed" };
        if (change.workspaceId && next.workspaces[change.workspaceId]) next.workspaces[change.workspaceId] = { ...next.workspaces[change.workspaceId]!, state: "closed" };
        return success({ landing, canonicalRevision: nextProjectRevision, change: next.changes[change.id] }, `landing=${landing.id}; canonicalMutation=accepted; sourceWrite=landing-only`);
      }
      case "release.create": {
        const releaseProjectId = requiredString(payload.projectId, "projectId");
        const releaseProject = next.projects[releaseProjectId];
        if (!releaseProject) throw new AuthorityPlaneError({ code: "not_found", message: `Project ${releaseProjectId} does not exist.`, recoveryAction: "verify the Project identifier without probing hidden resources before creating a Release", receipt: `project=${releaseProjectId}; release=not-created; discoverable=false` });
        const projectRevisionId = requiredString(payload.projectRevisionId, "projectRevisionId");
        const projectRevision = next.projectRevisions[projectRevisionId];
        if (!projectRevision || projectRevision.projectId !== releaseProject.id) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${projectRevisionId} is not available for Project ${releaseProjectId}.`, recoveryAction: "verify the Project and Project Revision identifiers without probing hidden resources", receipt: `project=${releaseProjectId}; projectRevision=${projectRevisionId}; release=not-created; discoverable=false` });
        if (next.canonicalByProject[releaseProjectId] !== projectRevisionId) throw new AuthorityPlaneError({ code: "conflict", message: `Project Revision ${projectRevisionId} is not the current canonical Revision for Project ${releaseProjectId}.`, recoveryAction: "Land the Change first, then create the Release from the current canonical Project Revision", receipt: `project=${releaseProjectId}; projectRevision=${projectRevisionId}; canonical=${next.canonicalByProject[releaseProjectId] ?? "missing"}; release=not-created` });
        const artifactIds = stringArray(payload.artifactIds, "artifactIds");
        const evidenceIds = stringArray(payload.evidenceIds, "evidenceIds");
        const artifacts = artifactIds.map((id) => next.artifacts[id]);
        const evidence = evidenceIds.map((id) => next.evidence[id]);
        if (artifacts.some((item) => !item) || evidence.some((item) => !item)) throw new AuthorityPlaneError({ code: "not_found", message: "Release references an Artifact or Evidence record that is not present.", recoveryAction: "restore the complete immutable lineage before creating the Release", receipt: `projectRevision=${projectRevisionId}; artifacts=${artifactIds.length}; evidence=${evidenceIds.length}; release=not-created` });
        if (artifacts.some((item) => item!.projectRevisionId !== projectRevisionId)) throw new AuthorityPlaneError({ code: "conflict", message: "Release Artifacts must be bound to the exact canonical Project Revision.", recoveryAction: "record or select Artifacts produced from the exact canonical Project Revision before creating the Release", receipt: `project=${releaseProjectId}; projectRevision=${projectRevisionId}; artifacts=exact-project-revision-required; release=not-created` });
        if (evidence.some((item) => item!.projectRevisionId !== projectRevisionId || item!.outcome !== "passed")) throw new AuthorityPlaneError({ code: "conflict", message: "Release Evidence must be passed and bound to the exact Project Revision.", recoveryAction: "rerun the verifier against the exact Project Revision and attach fresh passed Evidence", receipt: `projectRevision=${projectRevisionId}; evidence=exact-passed-required; release=not-created` });
        const configurationDigests = stringArray(payload.configurationDigests ?? [], "configurationDigests", true);
        const artifactRecords = artifacts.filter((item): item is Artifact => item !== undefined);
        const evidenceRecords = evidence.filter((item): item is Evidence => item !== undefined);
        const inputSetValue = payload.inputSet === undefined ? undefined : record<unknown>(payload.inputSet, "inputSet");
        let inputSet: ReleaseInputSet;
        try {
          const derived = deriveReleaseInputSet({ configurationDigests, artifacts: artifactRecords, evidence: evidenceRecords });
          if (inputSetValue === undefined) {
            inputSet = derived;
          } else {
            const supplied = createReleaseInputSet({
              buildDefinitionDigest: requiredString(inputSetValue.buildDefinitionDigest, "inputSet.buildDefinitionDigest"),
              dependencyDigest: requiredString(inputSetValue.dependencyDigest, "inputSet.dependencyDigest"),
              toolchainDigest: requiredString(inputSetValue.toolchainDigest, "inputSet.toolchainDigest"),
              environmentDigest: requiredString(inputSetValue.environmentDigest, "inputSet.environmentDigest"),
              artifactDigests: stringArray(inputSetValue.artifactDigests, "inputSet.artifactDigests", true),
            });
            if (requiredString(inputSetValue.inputClosureDigest, "inputSet.inputClosureDigest") !== supplied.inputClosureDigest) throw new ReleaseInputError({ code: "mismatch", message: "Release inputSet digest does not match its fields.", recoveryAction: "recompute inputSet.inputClosureDigest from the exact fields and retry", receipt: `inputClosure=declared-digest-mismatch; expected=${supplied.inputClosureDigest}` });
            assertReleaseInputSetMatches({ inputSet: supplied, configurationDigests, artifacts: artifactRecords, evidence: evidenceRecords });
            inputSet = supplied;
          }
        } catch (error) {
          if (error instanceof ReleaseInputError) throw new AuthorityPlaneError({ code: error.code === "missing" ? "invalid_request" : "conflict", message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt });
          throw error;
        }
        const migrationValue = payload.migrationPlan === undefined ? undefined : record<unknown>(payload.migrationPlan, "migrationPlan");
        let migrationPlan;
        try {
          migrationPlan = migrationValue === undefined
            ? defaultMigrationPlan()
            : createMigrationPlan({
              ...(migrationValue.strategy === undefined ? {} : { strategy: enumString(migrationValue.strategy, "migrationPlan.strategy", ["none", "expand-contract", "manual", "custom"] as const) }),
              ...(migrationValue.beforeSchemaDigest === undefined ? {} : { beforeSchemaDigest: requiredString(migrationValue.beforeSchemaDigest, "migrationPlan.beforeSchemaDigest") }),
              ...(migrationValue.afterSchemaDigest === undefined ? {} : { afterSchemaDigest: requiredString(migrationValue.afterSchemaDigest, "migrationPlan.afterSchemaDigest") }),
              ...(migrationValue.compatibility === undefined ? {} : { compatibility: enumString(migrationValue.compatibility, "migrationPlan.compatibility", ["backward-compatible", "bidirectional", "forward-only", "incompatible", "unknown"] as const) }),
              ...(migrationValue.rollback === undefined ? {} : { rollback: enumString(migrationValue.rollback, "migrationPlan.rollback", ["safe", "application-only", "manual-data-action", "blocked"] as const) }),
              migrationArtifactIds: stringArray(migrationValue.migrationArtifactIds ?? [], "migrationPlan.migrationArtifactIds", true),
              requiredEvidenceKeys: stringArray(migrationValue.requiredEvidenceKeys ?? [], "migrationPlan.requiredEvidenceKeys", true),
              ...(migrationValue.planDigest === undefined ? {} : { planDigest: requiredString(migrationValue.planDigest, "migrationPlan.planDigest") }),
            });
        } catch (error) {
          if (error instanceof MigrationPlanError) throw new AuthorityPlaneError({ code: error.code === "invalid" ? "invalid_request" : "conflict", message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt });
          throw error;
        }
        const releaseName = optionalString(payload.name);
        const releaseChangeRevisionId = optionalString(payload.changeRevisionId);
        const releaseChangeRevision = releaseChangeRevisionId ? next.changeRevisions[releaseChangeRevisionId] : undefined;
        if (releaseChangeRevisionId && (!releaseChangeRevision || next.changes[releaseChangeRevision.changeId]?.projectId !== releaseProjectId || releaseChangeRevision.projectRevisionId !== projectRevisionId)) throw new AuthorityPlaneError({ code: "conflict", message: "Release Change Revision must belong to the exact Project and canonical Project Revision.", recoveryAction: "create the Release from the Change Revision that produced this canonical Project Revision", receipt: `project=${releaseProjectId}; projectRevision=${projectRevisionId}; changeRevision=${releaseChangeRevisionId}; release=not-created` });
        const releaseProvenanceDigest = optionalString(payload.provenanceDigest);
        const release: Release = { protocol: CONTRACT_VERSIONS.release, id: optionalString(payload.releaseId) ?? opaqueId("release"), projectRevisionId, artifactIds, evidenceIds, configurationDigests, stateAssumptions: stringArray(payload.stateAssumptions ?? [], "stateAssumptions", true), policyVersion: requiredString(payload.policyVersion, "policyVersion"), status: "ready", ...(releaseName ? { name: releaseName } : {}), ...(releaseChangeRevisionId ? { changeRevisionId: releaseChangeRevisionId } : {}), ...(releaseProvenanceDigest ? { provenanceDigest: releaseProvenanceDigest } : {}), inputSet, migrationPlan, receipt: `release=ready; project=${releaseProjectId}; projectRevision=${projectRevisionId}; artifacts=${artifactIds.length}; evidence=${evidenceIds.length}; inputClosure=${inputSet.inputClosureDigest}; migrationPlan=${migrationPlan.planDigest}` };
        if (next.releases[release.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Release ${release.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Release identity", receipt: `release=${release.id}; exists=true; transition=not-applied` });
        next.releases[release.id] = release;
        return success({ release: { ...release, projectId: releaseProjectId } }, `release=${release.id}; project=${releaseProjectId}; status=ready; providerPromotion=not-performed; canonicalWrite=false`);
      }
      case "target.configure": {
        const targetWithoutProfile: Target = { protocol: CONTRACT_VERSIONS.target, id: optionalString(payload.targetId) ?? opaqueId("target"), projectId: requiredString(payload.projectId, "projectId"), name: requiredString(payload.name, "name"), adapterId: requiredString(payload.adapterId, "adapterId"), acceptedArtifactTypes: stringArray(payload.acceptedArtifactTypes, "acceptedArtifactTypes"), requiredEvidenceKeys: stringArray(payload.requiredEvidenceKeys ?? [], "requiredEvidenceKeys", true), state: "configured" };
        const profileValue = payload.deploymentProfile === undefined ? undefined : record<unknown>(payload.deploymentProfile, "deploymentProfile");
        let deploymentProfile;
        try {
          const sharingPolicyDigest = profileValue === undefined ? undefined : optionalString(profileValue.sharingPolicyDigest);
          deploymentProfile = profileValue === undefined
            ? defaultTargetDeploymentProfile(targetWithoutProfile)
            : createTargetDeploymentProfile({
              environment: enumString(profileValue.environment, "deploymentProfile.environment", ["preview", "development", "staging", "production", "custom"] as const),
              channel: enumString(profileValue.channel, "deploymentProfile.channel", ["alpha", "beta", "stable", "custom"] as const, "stable"),
              audience: requiredString(profileValue.audience, "deploymentProfile.audience"),
              runtimeIdentity: requiredString(profileValue.runtimeIdentity, "deploymentProfile.runtimeIdentity"),
              routeIdentities: stringArray(profileValue.routeIdentities ?? [], "deploymentProfile.routeIdentities", true),
              bindingIdentities: stringArray(profileValue.bindingIdentities ?? [], "deploymentProfile.bindingIdentities", true),
              dataResourceIdentities: stringArray(profileValue.dataResourceIdentities ?? [], "deploymentProfile.dataResourceIdentities", true),
              configurationDigests: stringArray(profileValue.configurationDigests ?? [], "deploymentProfile.configurationDigests", true),
              secretUseAliases: stringArray(profileValue.secretUseAliases ?? [], "deploymentProfile.secretUseAliases", true),
              dataClass: enumString(profileValue.dataClass, "deploymentProfile.dataClass", ["synthetic", "isolated", "production-shaped", "production", "custom"] as const, "custom"),
              resourceSharing: enumString(profileValue.resourceSharing, "deploymentProfile.resourceSharing", ["isolated", "owner-approved"] as const, "isolated"),
              ...(sharingPolicyDigest ? { sharingPolicyDigest } : {}),
            });
        } catch (error) {
          if (error instanceof TargetDeploymentProfileError) throw new AuthorityPlaneError({ code: error.code === "resource-conflict" ? "conflict" : "invalid_request", message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt });
          throw error;
        }
        const target: Target = { ...targetWithoutProfile, deploymentProfile };
        if (!next.projects[target.projectId]) throw new AuthorityPlaneError({ code: "not_found", message: `Project ${target.projectId} does not exist.`, recoveryAction: "create the Project before configuring its Target", receipt: `target=${target.id}; project=${target.projectId}; target=not-configured` });
        if (next.targets[target.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Target ${target.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Target identity", receipt: `target=${target.id}; exists=true; transition=not-applied` });
        try {
          assertTargetResourceIsolation({ existing: Object.values(next.targets), candidate: target });
        } catch (error) {
          if (error instanceof TargetDeploymentProfileError) throw new AuthorityPlaneError({ code: "conflict", message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt });
          throw error;
        }
        next.targets[target.id] = target;
        return success({ target }, `target=${target.id}; state=configured; providerAdapter=${target.adapterId}; environment=${deploymentProfile.environment}; channel=${deploymentProfile.channel}; profileDigest=${deploymentProfile.profileDigest}; qualification=not-performed; canonicalWrite=false`);
      }
      case "promotion.request": {
        const promotionProjectId = requiredString(payload.projectId, "projectId");
        const releaseId = requiredString(payload.releaseId, "releaseId");
        const targetId = requiredString(payload.targetId, "targetId");
        const release = next.releases[releaseId];
        const target = next.targets[targetId];
        if (!next.projects[promotionProjectId] || !release || !target) throw new AuthorityPlaneError({ code: "not_found", message: "Promotion requires an existing Project, Release, and Target.", recoveryAction: "verify the Project, Release, and Target identifiers without probing hidden resources before requesting Promotion", receipt: `promotion=not-created; discoverable=false` });
        const releaseProjectId = next.projectRevisions[release.projectRevisionId]?.projectId;
        if (!releaseProjectId || releaseProjectId !== promotionProjectId || target.projectId !== promotionProjectId) throw new AuthorityPlaneError({ code: "conflict", message: "Promotion Project, Release, and Target bindings do not match.", recoveryAction: "request Promotion against the Target and Release belonging to the same Project", receipt: `project=${promotionProjectId}; promotion=not-created; exact-project-binding-required` });
        try {
          assertTargetCanPromote(target);
        } catch (error) {
          if (error instanceof TargetDeploymentProfileError) throw new AuthorityPlaneError({ code: "blocked", message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt });
          throw error;
        }
        const expectedCurrentReleaseId = optionalString(payload.expectedCurrentReleaseId) ?? target.currentReleaseId ?? null;
        if (expectedCurrentReleaseId !== (target.currentReleaseId ?? null)) throw new AuthorityPlaneError({ code: "conflict", message: `Promotion expected Release ${expectedCurrentReleaseId ?? "none"}, but Target ${target.id} is at ${target.currentReleaseId ?? "none"}.`, recoveryAction: "read the current Target pointer and request Promotion with that exact expected Release ID", receipt: `target=${target.id}; expectedCurrent=${expectedCurrentReleaseId ?? "none"}; actualCurrent=${target.currentReleaseId ?? "none"}; promotion=not-created` });
        const promotion: PromotionRecord = { protocol: CONTRACT_VERSIONS.promotion, id: optionalString(payload.promotionId) ?? opaqueId("promotion"), projectId: promotionProjectId, targetId, releaseId, releaseDigest: optionalString(payload.releaseDigest) ?? `declared:${release.id}`, previousReleaseId: expectedCurrentReleaseId, expectedCurrentReleaseId, state: "blocked", attempt: 0, kind: "promotion", idempotencyKey: command.idempotencyKey, actor, createdAt: now(), updatedAt: now(), receipt: `promotion=blocked; project=${promotionProjectId}; target=${targetId}; release=${releaseId}; expectedCurrentRelease=${expectedCurrentReleaseId ?? "not-declared"}; providerAdapter=${target.adapterId}; canonicalWrite=false`, recoveryAction: "qualify and bind the Target adapter, then request Promotion again after inspecting the immutable Release lineage" };
        if (next.promotions[promotion.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Promotion ${promotion.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Promotion identity", receipt: `promotion=${promotion.id}; exists=true; transition=not-applied` });
        next.promotions[promotion.id] = promotion;
        return blocked({ promotion, target, release }, promotion.receipt, promotion.recoveryAction!);
      }
      case "promotion.execute": {
        throw new AuthorityPlaneError({
          code: "invalid_request",
          message: "promotion.execute is an internal provider handoff and cannot be submitted as a public Authority command.",
          recoveryAction: "use the coordinator's internal Promotion execution boundary; no provider operation was started",
          receipt: "command=promotion.execute; publicCommand=false; transition=not-applied",
        });
      }
      case "promotion.reconcile": {
        throw new AuthorityPlaneError({
          code: "invalid_request",
          message: "promotion.reconcile is an internal provider reconciliation and cannot be submitted as a public Authority command.",
          recoveryAction: "use the owner-authenticated Promotion reconciliation boundary; no provider operation was started",
          receipt: "command=promotion.reconcile; publicCommand=false; transition=not-applied",
        });
      }
    }
  }
}

export function authorityStateSummary(snapshot: AuthorityPlaneSnapshot): Record<string, unknown> {
  const normalized = normalizeAuthorityPlaneSnapshot(snapshot);
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    realmId: normalized.realmId,
    version: normalized.version,
    canonicalByProject: { ...normalized.canonicalByProject },
    counts: {
      projects: Object.keys(normalized.projects).length,
      intents: Object.keys(normalized.intents).length,
      intentComments: Object.keys(normalized.intentComments).length,
      workspaces: Object.keys(normalized.workspaces).length,
      changes: Object.keys(normalized.changes).length,
      revisions: Object.keys(normalized.changeRevisions).length,
      runs: Object.keys(normalized.runs).length,
      runnerProfiles: Object.keys(normalized.runnerProfiles).length,
      runnerAttempts: Object.keys(normalized.runnerAttempts).length,
      evidence: Object.keys(normalized.evidence).length,
      artifacts: Object.keys(normalized.artifacts).length,
      landings: Object.keys(normalized.landings).length,
      releases: Object.keys(normalized.releases).length,
      targets: Object.keys(normalized.targets).length,
      promotions: Object.keys(normalized.promotions).length,
      mirrors: Object.keys(normalized.mirrors).length,
      mirrorOperations: Object.keys(normalized.mirrorOperations).length,
      mirrorCheckpoints: Object.keys(normalized.mirrorCheckpoints).length,
      externalProposals: Object.keys(normalized.externalProposals).length,
      mirrorDeliveries: Object.keys(normalized.mirrorDeliveries).length,
      audit: normalized.audit.length,
    },
    credentialFree: true,
    canonicalWrite: "landing-only",
    recovery: "snapshot-and-idempotency-record-persisted-by-coordinator",
  };
}
