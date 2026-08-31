import { createHash, createHmac, createSign, timingSafeEqual } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type {
  MirrorRemoteAdapter,
  MirrorRemoteCommit,
  MirrorRemoteState,
  MirrorRefUpdate,
  MirrorProviderFailure,
  MirrorProviderResult,
} from "./mirror.ts";
import type { GitRef, MirrorRepositoryObservation, RepositoryMirror } from "../kernel/contracts.ts";
import {
  MIRROR_HANDOFF_SIZING_RECEIPT,
  MIRROR_HANDOFF_CLOCK_SKEW_MS,
  MIRROR_HANDOFF_TTL_MS,
  mirrorObservationDigest,
  signMirrorIngestionHandoff,
  verifyMirrorRepositoryObservation,
  type MirrorIngestionHandoff,
  type MirrorIngestionCommand,
} from "./mirror-observation.ts";
import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, scanCredentialMaterial } from "../security/credential-material.ts";

export const GITHUB_APP_ADAPTER_PROTOCOL = "anyam.github-app-adapter/v1" as const;
const execFile = promisify(execFileCallback);

type GitRetryPolicyInput = {
  delaysMs: readonly number[];
  sizingReceipt: string;
  sleep?: (milliseconds: number) => Promise<void>;
};

type GitRetryPolicy = {
  delaysMs: readonly number[];
  sizingReceipt: string;
  sleep: (milliseconds: number) => Promise<void>;
};

export type GitHubWebhookEventName = "push" | "pull_request";
export type GitHubAppPermission = "contents:read" | "contents:write" | "metadata:read" | "pull_requests:read" | "pull_requests:write" | "administration:write";

export type GitHubAppInstallation = {
  installationId: string;
  repository: string;
  repositoryUrl: string;
  /** Qualification-only binding. Production adapters must not expose cleanup. */
  disposableQualificationId?: string;
  selectedRepository: true;
  permissions: {
    contents: "read" | "write";
    metadata: "read";
    pullRequests: "read" | "write";
    administration?: "write";
  };
  events: readonly GitHubWebhookEventName[];
};

export type GitHubAppTokenIssuer = {
  issue(input: { installationId: string; repository: string; permissions: readonly GitHubAppPermission[] }): Promise<{ token: string; expiresAt: string }>;
};

export type GitHubSmartHttpRefs = {
  generation: string;
  refs: readonly GitRef[];
  originOperationId?: string;
  receipt: string;
};

export type GitHubSmartHttpTransport = {
  inspect(input: { repositoryUrl: string; token: string; refs: readonly string[]; knownGeneration: string }): Promise<GitHubSmartHttpRefs>;
  push(input: { repositoryUrl: string; token: string; expectedRefs: readonly GitRef[]; desiredRefs: readonly GitRef[]; refMappings: readonly { localRef: string; remoteRef: string }[]; operationId: string; idempotencyKey: string }): Promise<GitHubSmartHttpRefs>;
};

/** GitHub's Git-over-HTTPS transport accepts an installation token as the
 * password for the x-access-token user, unlike the REST Bearer header. */
export function gitInstallationAuthorizationHeader(token: string): string {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
}

function gitErrorClass(stderr: string): string {
  const value = stderr.toLowerCase();
  if (value.includes("authentication") || value.includes("auth failed") || value.includes("bad credentials")) return "authentication";
  if (value.includes("permission") || value.includes("403")) return "permission";
  if (value.includes("atomic")) return "atomic";
  if (value.includes("non-fast-forward") || value.includes("rejected")) return "ref-rejected";
  if (value.includes("repository not found") || value.includes("not found")) return "repository-not-found";
  return "provider-or-transport";
}

export function gitTransportFailure(error: unknown, operation: "inspect" | "push", retryAttempts?: number, retrySizingReceipt?: string): GitHubAppAdapterError {
  const record = error as { code?: unknown; stderr?: unknown };
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const exitCode = typeof record.code === "number" || typeof record.code === "string" ? String(record.code) : "unknown";
  const retryReceipt = retryAttempts === undefined ? "" : `; retryAttempts=${retryAttempts}; retry=${retrySizingReceipt ?? "not-configured"}`;
  return new GitHubAppAdapterError({
    errorCode: "github_app.git_transport",
    message: `Git Smart HTTP ${operation} failed; provider stderr is redacted.`,
    retryable: false,
    recoveryAction: "inspect the redacted Git transport receipt, reconcile the selected App installation and repository state, then retry the same disposable qualification",
    receipt: `provider=github-app; transport=git-smart-http; operation=${operation}; exit=${exitCode}; stderrClass=${gitErrorClass(stderr)}; stderrDigest=${digest(stderr)}${retryReceipt}; credentialMaterialStored=false`,
  });
}

export type GitHubCommitObservation = {
  oid: string;
  author: { name: string; email?: string };
  treeOid?: string;
};

export type GitHubPullRequestObservation = {
  number: number;
  repository: string;
  state: "open" | "closed";
  merged: boolean;
  headRef: string;
  headCommit: string;
  baseRef: string;
  baseCommit: string;
};

export type GitHubRestClient = {
  getCommit(input: { repository: string; oid: string; ref: string; token: string }): Promise<GitHubCommitObservation>;
  compare(input: { repository: string; baseOid: string; headOid: string; baseRef?: string; headRef?: string; token: string }): Promise<{ status: "identical" | "ahead" | "behind" | "diverged"; receipt: string }>;
  getPullRequest(input: { repository: string; number: number; token: string }): Promise<GitHubPullRequestObservation>;
  createPullRequest(input: { repository: string; head: string; base: string; title: string; token: string }): Promise<{ number: number; receipt: string }>;
  deleteRepository(input: { repository: string; token: string }): Promise<{ receipt: string }>;
};

export type GitHubReconciliationTask = {
  mirrorId: string;
  deliveryId: string;
  eventType: GitHubWebhookEventName;
  action?: string;
  repository: string;
  installationId: string;
  ref?: string;
  proposalKey?: string;
  bodyDigest: string;
  receipt: string;
};

export type GitHubReconciliationQueueOptions = {
  maxPending: number;
  sizingReceipt: string;
  /** Realm-persisted delivery identity store; required for restart-safe dedupe. */
  deliveryLedger: GitHubWebhookDeliveryLedger;
};

export type GitHubWebhookDeliveryLedger = {
  /** Atomically persist the task if deliveryId is new. */
  recordIfAbsent(task: GitHubReconciliationTask): "accepted" | "duplicate" | "conflict";
  listPending(): readonly GitHubReconciliationTask[];
  markProcessed(deliveryId: string): void;
};

export type GitHubWebhookReceipt = {
  status: "accepted" | "duplicate" | "ignored" | "blocked";
  mirrorId: string;
  deliveryId: string;
  eventType: string;
  reinspectionRequired: boolean;
  credentialFree: true;
  receipt: string;
  recoveryAction?: string;
};

export class GitHubAppAdapterError extends Error {
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { errorCode: string; message: string; retryable: boolean; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "GitHubAppAdapterError";
    this.errorCode = input.errorCode;
    this.retryable = input.retryable;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new GitHubAppAdapterError({ errorCode: "github_app.invalid_input", message: `${field} is required.`, retryable: false, recoveryAction: `provide a non-empty ${field} and retry without invoking a provider`, receipt: `field=${field}; transition=not-applied; credentialMaterialStored=false` });
  return value.trim();
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

function safeReceipt(value: unknown, field: string): string {
  const receipt = required(value, field);
  const finding = scanCredentialMaterial(receipt, field);
  if (finding) {
    throw new GitHubAppAdapterError({ errorCode: "github_app.unsafe_receipt", message: `${field} contains credential-like material.`, retryable: false, recoveryAction: `return a digest-only ${field} receipt without credential material`, receipt: `field=${field}; fieldPath=${finding.path}; scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; credentialMaterialStored=false; transition=not-applied` });
  }
  return receipt;
}

function retryPolicy(input: GitRetryPolicyInput | undefined, field: string): GitRetryPolicy {
  if (input === undefined) return { delaysMs: [], sizingReceipt: "not-configured", sleep: async () => undefined };
  if (input.delaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0) || input.sizingReceipt.trim().length === 0) {
    throw new GitHubAppAdapterError({ errorCode: "github_app.git_retry_invalid", message: `${field} requires non-negative measured delays and a sizing receipt.`, retryable: false, recoveryAction: `configure ${field} with non-negative delay values and its measurement receipt`, receipt: `${field}=invalid; transition=not-applied; credentialMaterialStored=false` });
  }
  return {
    delaysMs: [...input.delaysMs],
    sizingReceipt: safeReceipt(input.sizingReceipt, `${field}.sizingReceipt`),
    sleep: input.sleep ?? (async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

function providerFailure(mirror: RepositoryMirror, error: unknown, operation: string): MirrorProviderFailure {
  const typed = error instanceof GitHubAppAdapterError ? error : undefined;
  const errorCode = typed?.errorCode ?? "github_app.adapter_exception";
  return {
    status: "failed",
    errorCode,
    message: `GitHub App ${operation} is blocked for ${mirror.remoteRepository}.`,
    retryable: typed?.retryable ?? true,
    affectedObject: mirror.remoteRepository,
    recoveryAction: typed?.recoveryAction ?? "inspect the provider checkpoint and retry with a fresh installation credential",
    receipt: `provider=github-app; operation=${operation}; repository=${mirror.remoteRepository}; error=${errorCode}; ${typed?.receipt ?? "exception=redacted"}; credentialMaterialStored=false`,
  };
}

function validateInstallation(input: GitHubAppInstallation): void {
  required(input.installationId, "installation.installationId");
  const repository = required(input.repository, "installation.repository");
  if (repository.split("/").length !== 2) throw new GitHubAppAdapterError({ errorCode: "github_app.repository_invalid", message: "GitHub App installation repository must be owner/name.", retryable: false, recoveryAction: "configure the exact selected repository full name", receipt: `repository=${repository}; selectedRepository=true; transition=not-applied` });
  let repositoryUrl: URL;
  try {
    repositoryUrl = new URL(required(input.repositoryUrl, "installation.repositoryUrl"));
  } catch {
    throw new GitHubAppAdapterError({ errorCode: "github_app.repository_url_invalid", message: "The selected GitHub App repository URL is malformed.", retryable: false, recoveryAction: "configure a valid https://github.com owner/name repository URL", receipt: `repository=${repository}; repositoryUrl=invalid; transition=not-applied; credentialMaterialStored=false` });
  }
  if (repositoryUrl.protocol !== "https:" || repositoryUrl.hostname !== "github.com") throw new GitHubAppAdapterError({ errorCode: "github_app.repository_host_invalid", message: "The selected GitHub App repository must use the public GitHub HTTPS host.", retryable: false, recoveryAction: "configure a github.com HTTPS repository URL; use a separately qualified enterprise adapter for another host", receipt: `repositoryHost=${repositoryUrl.hostname}; transition=not-applied; credentialMaterialStored=false` });
  const urlSegments = repositoryUrl.pathname.split("/").filter(Boolean);
  const urlRepository = urlSegments.length === 2 ? `${urlSegments[0]}/${urlSegments[1]!.replace(/\.git$/i, "")}` : undefined;
  if (urlRepository !== repository) throw new GitHubAppAdapterError({ errorCode: "github_app.repository_url_mismatch", message: "The GitHub App repository URL does not identify the configured selected repository.", retryable: false, recoveryAction: "configure the exact https://github.com/owner/name.git URL for the selected owner/name repository", receipt: `repository=${repository}; urlRepository=${urlRepository ?? "invalid"}; transition=not-applied; credentialMaterialStored=false` });
  if (input.selectedRepository !== true) throw new GitHubAppAdapterError({ errorCode: "github_app.repository_not_selected", message: "The GitHub App installation is not bound to a selected repository.", retryable: false, recoveryAction: "install the GitHub App with selected-repository access and retry", receipt: `repository=${repository}; selectedRepository=false; credentialMaterialStored=false` });
  const requiredEvents: readonly GitHubWebhookEventName[] = ["push", "pull_request"];
  if (input.events.length !== requiredEvents.length || requiredEvents.some((event) => !input.events.includes(event))) throw new GitHubAppAdapterError({ errorCode: "github_app.events_incomplete", message: "The GitHub App installation must subscribe only to push and pull_request events.", retryable: false, recoveryAction: "subscribe the App installation to push and pull_request only, then retry", receipt: `repository=${repository}; configuredEvents=${input.events.join(",")}; requiredEvents=push,pull_request; transition=not-applied` });
  if (input.permissions.contents !== "write" || input.permissions.metadata !== "read" || (input.permissions.pullRequests !== "read" && input.permissions.pullRequests !== "write")) throw new GitHubAppAdapterError({ errorCode: "github_app.permissions_incomplete", message: "The selected GitHub App installation lacks the minimum mirror permissions.", retryable: false, recoveryAction: "grant Contents write, Metadata read, and Pull requests read or write to the installed App", receipt: `repository=${repository}; permissions=minimum-required; transition=not-applied` });
}

function installationTokenPermissions(mode: "read" | "write" | "cleanup"): readonly GitHubAppPermission[] {
  if (mode === "read") return ["contents:read", "metadata:read", "pull_requests:read"];
  if (mode === "write") return ["contents:write", "metadata:read", "pull_requests:read"];
  return ["administration:write", "metadata:read"];
}

function validateToken(token: { token: string; expiresAt: string }): void {
  required(token.token, "installation token");
  const expiresAt = Date.parse(required(token.expiresAt, "installation token expiry"));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new GitHubAppAdapterError({ errorCode: "github_app.credential_expired", message: "The just-in-time GitHub App installation credential is expired.", retryable: true, recoveryAction: "issue a fresh short-lived installation credential and resume the same Mirror checkpoint", receipt: `credential=expired; expiresAt=${token.expiresAt}; credentialMaterialStored=false` });
}

function mappedRemoteRefs(mirror: RepositoryMirror): Set<string> {
  return new Set(mirror.refMappings.map((mapping) => mapping.remoteRef));
}

function refMap(refs: readonly GitRef[]): Map<string, string> {
  return new Map(refs.map((ref) => [ref.name, ref.oid]));
}

export function gitPushArguments(input: { repositoryUrl: string; expectedRefs: readonly GitRef[]; refMappings: readonly { localRef: string; remoteRef: string }[] }): string[] {
  const expected = refMap(input.expectedRefs);
  const args = ["push", "--atomic"];
  for (const mapping of input.refMappings) args.push(`--force-with-lease=${mapping.remoteRef}:${expected.get(mapping.remoteRef) ?? ""}`);
  args.push(input.repositoryUrl);
  for (const mapping of input.refMappings) args.push(`${mapping.localRef}:${mapping.remoteRef}`);
  return args;
}

function refsEqual(left: readonly GitRef[], right: readonly GitRef[]): boolean {
  if (left.length !== right.length) return false;
  const rightMap = refMap(right);
  return left.every((ref) => rightMap.get(ref.name) === ref.oid);
}

function parseInstallationId(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

function webhookBodyDigest(body: string): string {
  return digest(body);
}

function sameDelivery(left: GitHubReconciliationTask, right: GitHubReconciliationTask): boolean {
  return left.deliveryId === right.deliveryId && left.eventType === right.eventType && left.action === right.action && left.repository === right.repository && left.installationId === right.installationId && left.ref === right.ref && left.proposalKey === right.proposalKey && left.bodyDigest === right.bodyDigest;
}

export function verifyGitHubWebhookSignature(input: { body: string; signature: string; secret: string }): boolean {
  if (input.secret.trim().length === 0 || !/^sha256=[0-9a-f]{64}$/i.test(input.signature)) return false;
  const expected = createHmac("sha256", input.secret).update(input.body).digest("hex");
  const actual = input.signature.slice("sha256=".length);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

export async function cleanupGitHubAppDisposable(input: { installation: GitHubAppInstallation; issuer: GitHubAppTokenIssuer; api: GitHubRestClient; repositoryPrefix: string; qualificationId: string; disposableRepository?: string }): Promise<{ status: "succeeded" | "blocked"; receipt: string; recoveryAction?: string }> {
  const qualificationId = required(input.qualificationId, "qualificationId");
  const installation = input.installation;
  if (installation.disposableQualificationId !== qualificationId || installation.permissions.administration !== "write" || input.disposableRepository !== installation.repository || input.repositoryPrefix !== installation.repository) return { status: "blocked", receipt: `provider=github-app; cleanup=not-authorized; repository=${installation.repository}; qualification=${qualificationId}; credentialMaterialStored=false`, recoveryAction: "bind cleanup to the exact qualification identity, administration permission, and selected repository before deleting any provider resource" };
  try {
    const issued = await input.issuer.issue({ installationId: installation.installationId, repository: installation.repository, permissions: ["administration:write", "metadata:read"] });
    validateToken(issued);
    const result = await input.api.deleteRepository({ repository: installation.repository, token: issued.token });
    return { status: "succeeded", receipt: `provider=github-app; cleanup=repository-deleted; repository=${installation.repository}; qualification=${qualificationId}; providerReceipt=${safeReceipt(result.receipt, "cleanup.receipt")}; credentialMaterialStored=false` };
  } catch (error) {
    const failure = providerFailure({ remoteRepository: installation.repository } as RepositoryMirror, error, "cleanup");
    return { status: "blocked", receipt: failure.receipt, recoveryAction: failure.recoveryAction };
  }
}

type QueueResult = { status: "accepted" | "duplicate" | "blocked"; task?: GitHubReconciliationTask; receipt: string; recoveryAction?: string };

class GitHubReconciliationQueue {
  private readonly pending: GitHubReconciliationTask[] = [];
  private readonly seen = new Map<string, GitHubReconciliationTask>();
  private readonly options: GitHubReconciliationQueueOptions;

  constructor(options: GitHubReconciliationQueueOptions) {
    if (!Number.isInteger(options.maxPending) || options.maxPending <= 0) throw new GitHubAppAdapterError({ errorCode: "github_app.queue_limit_invalid", message: "The reconciliation queue requires a positive measured capacity.", retryable: false, recoveryAction: "configure a positive maxPending with its sizing receipt", receipt: "queue=maxPending-invalid; transition=not-applied" });
    this.options = { maxPending: options.maxPending, sizingReceipt: safeReceipt(options.sizingReceipt, "queue.sizingReceipt"), deliveryLedger: options.deliveryLedger };
    const restored = options.deliveryLedger.listPending();
    if (restored.length > options.maxPending) throw new GitHubAppAdapterError({ errorCode: "github_app.queue_restore_over_capacity", message: "Persisted GitHub webhook work exceeds the measured reconciliation queue capacity.", retryable: false, recoveryAction: "increase the measured queue tripwire or drain persisted deliveries before starting this adapter", receipt: `queue=restore-over-capacity; pending=${restored.length}; maxPending=${options.maxPending}; sizingReceipt=${this.options.sizingReceipt}; credentialMaterialStored=false` });
    for (const task of restored) {
      if (this.seen.has(task.deliveryId)) throw new GitHubAppAdapterError({ errorCode: "github_app.queue_restore_duplicate", message: "Persisted GitHub webhook work contains duplicate delivery identities.", retryable: false, recoveryAction: "repair the Realm delivery ledger before starting reconciliation", receipt: `queue=restore-duplicate; delivery=${task.deliveryId}; credentialMaterialStored=false` });
      this.seen.set(task.deliveryId, { ...task });
      this.pending.push({ ...task });
    }
  }

  enqueue(task: GitHubReconciliationTask): QueueResult {
    const seenTask = this.seen.get(task.deliveryId);
    if (seenTask) return sameDelivery(seenTask, task)
      ? { status: "duplicate", receipt: `provider=github-app; queue=duplicate; delivery=${task.deliveryId}; reinspectionRequired=true; credentialMaterialStored=false` }
      : { status: "blocked", receipt: `provider=github-app; queue=delivery-conflict; delivery=${task.deliveryId}; credentialMaterialStored=false`, recoveryAction: "retain the first signed delivery and reconcile the changed payload as a provider identity conflict" };
    if (this.pending.length >= this.options.maxPending) return { status: "blocked", receipt: `provider=github-app; queue=full; delivery=${task.deliveryId}; maxPending=${this.options.maxPending}; sizingReceipt=${this.options.sizingReceipt}; credentialMaterialStored=false`, recoveryAction: "drain the bounded reconciliation queue after re-inspecting remote state; do not drop the webhook hint" };
    try {
      const persisted = this.options.deliveryLedger.recordIfAbsent(task);
      if (persisted === "duplicate") return { status: "duplicate", receipt: `provider=github-app; queue=persisted-duplicate; delivery=${task.deliveryId}; reinspectionRequired=true; credentialMaterialStored=false` };
      if (persisted === "conflict") return { status: "blocked", receipt: `provider=github-app; queue=persisted-delivery-conflict; delivery=${task.deliveryId}; credentialMaterialStored=false`, recoveryAction: "retain the first signed delivery and reconcile the changed payload as a provider identity conflict" };
    } catch (error) {
      return { status: "blocked", receipt: `provider=github-app; queue=delivery-ledger-failed; delivery=${task.deliveryId}; exception=${error instanceof Error ? error.name : "unknown"}; credentialMaterialStored=false`, recoveryAction: "persist the delivery identity before queueing the wake-up hint, then retry the same signed delivery" };
    }
    this.seen.set(task.deliveryId, { ...task });
    this.pending.push({ ...task });
    return { status: "accepted", task: { ...task }, receipt: `provider=github-app; queue=enqueued; delivery=${task.deliveryId}; pending=${this.pending.length}; reinspectionRequired=true; credentialMaterialStored=false` };
  }

  async drain(input: { limit: number; reinspect: (task: GitHubReconciliationTask) => Promise<{ status: "succeeded" | "blocked"; receipt: string }> }): Promise<{ status: "succeeded" | "blocked"; value?: { processedDeliveryIds: readonly string[]; receipts: readonly string[] }; receipt: string; recoveryAction?: string }> {
    if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > this.options.maxPending) return { status: "blocked", receipt: `provider=github-app; queue=drain-limit-invalid; limit=${input.limit}; maxPending=${this.options.maxPending}; sizingReceipt=${this.options.sizingReceipt}; credentialMaterialStored=false`, recoveryAction: "request a drain limit within the measured queue capacity" };
    const batch = this.pending.splice(0, input.limit);
    const processed: string[] = [];
    const receipts: string[] = [];
    for (const task of batch) {
      try {
        const result = await input.reinspect({ ...task });
        receipts.push(result.receipt);
        if (result.status === "succeeded") {
          try {
            this.options.deliveryLedger.markProcessed(task.deliveryId);
            processed.push(task.deliveryId);
          } catch (error) {
            this.pending.unshift(task);
            return { status: "blocked", receipt: `provider=github-app; queue=delivery-ledger-process-failed; delivery=${task.deliveryId}; exception=${error instanceof Error ? error.name : "unknown"}; credentialMaterialStored=false`, recoveryAction: "persist the processed delivery outcome before acknowledging the provider hint" };
          }
        } else this.pending.unshift(task);
      } catch (error) {
        this.pending.unshift(task);
        return { status: "blocked", receipt: `provider=github-app; queue=reinspect-failed; delivery=${task.deliveryId}; exception=${error instanceof Error ? error.name : "unknown"}; credentialMaterialStored=false`, recoveryAction: "inspect the Mirror checkpoint and retry reconciliation without acknowledging the delivery" };
      }
    }
    if (this.pending.length > 0) return { status: "blocked", value: { processedDeliveryIds: processed, receipts }, receipt: `provider=github-app; queue=partially-drained; processed=${processed.length}; pending=${this.pending.length}; credentialMaterialStored=false`, recoveryAction: "drain the remaining webhook hints after the provider state has been re-inspected" };
    return { status: "succeeded", value: { processedDeliveryIds: processed, receipts }, receipt: `provider=github-app; queue=drained; processed=${processed.length}; pending=0; credentialMaterialStored=false` };
  }
}

export class GitHubAppProjectionAdapter implements MirrorRemoteAdapter {
  readonly protocol = GITHUB_APP_ADAPTER_PROTOCOL;
  private readonly installation: GitHubAppInstallation;
  private readonly issuer: GitHubAppTokenIssuer;
  private readonly git: GitHubSmartHttpTransport;
  private readonly api: GitHubRestClient;
  private readonly queue: GitHubReconciliationQueue;
  private readonly readAfterWriteRetry: GitRetryPolicy;

  constructor(input: { installation: GitHubAppInstallation; issuer: GitHubAppTokenIssuer; git: GitHubSmartHttpTransport; api: GitHubRestClient; queue: GitHubReconciliationQueueOptions; readAfterWriteRetry?: GitRetryPolicyInput }) {
    validateInstallation(input.installation);
    this.installation = { ...input.installation, permissions: { ...input.installation.permissions }, events: [...input.installation.events] };
    this.issuer = input.issuer;
    this.git = input.git;
    this.api = input.api;
    this.queue = new GitHubReconciliationQueue(input.queue);
    this.readAfterWriteRetry = retryPolicy(input.readAfterWriteRetry, "readAfterWriteRetry");
  }

  private assertMirror(mirror: RepositoryMirror): void {
    if (mirror.canonicalAuthority !== "anyam") throw new GitHubAppAdapterError({ errorCode: "github_app.canonical_authority_unsupported", message: "GitHub is a projection provider and cannot become Anyam canonical authority.", retryable: false, recoveryAction: "configure the GitHub repository as an external Mirror and route canonical changes through Anyam Landing", receipt: `mirror=${mirror.id}; canonicalAuthority=${String(mirror.canonicalAuthority)}; providerRole=projection; credentialMaterialStored=false` });
    if (mirror.provider !== "github" || mirror.remoteRepository !== this.installation.repository) throw new GitHubAppAdapterError({ errorCode: "github_app.repository_mismatch", message: "The Repository Mirror is not bound to the selected GitHub App repository.", retryable: false, recoveryAction: "configure the GitHub App installation for the exact mapped repository", receipt: `mirror=${mirror.id}; expectedRepository=${this.installation.repository}; actualRepository=${mirror.remoteRepository}; credentialMaterialStored=false` });
    if (mirror.disclosure !== "public") throw new GitHubAppAdapterError({ errorCode: "github_app.disclosure_unsupported", message: "This GitHub App projection adapter only exposes public Source Space state.", retryable: false, recoveryAction: "use a public Source Space and public Mirror disclosure for this qualification adapter", receipt: `mirror=${mirror.id}; disclosure=${mirror.disclosure}; publicProjection=false; credentialMaterialStored=false` });
  }

  private async token(mode: "read" | "write" | "cleanup"): Promise<{ token: string; expiresAt: string }> {
    const issued = await this.issuer.issue({ installationId: this.installation.installationId, repository: this.installation.repository, permissions: installationTokenPermissions(mode) });
    validateToken(issued);
    return issued;
  }

  async inspect(input: Parameters<MirrorRemoteAdapter["inspect"]>[0]): Promise<MirrorProviderResult<MirrorRemoteState>> {
    try {
      this.assertMirror(input.mirror);
      const token = await this.token("read");
      const permitted = [...mappedRemoteRefs(input.mirror)];
      const remote = await this.git.inspect({ repositoryUrl: this.installation.repositoryUrl, token: token.token, refs: permitted, knownGeneration: input.knownGeneration });
      const filteredRefs = remote.refs.filter((ref) => mappedRemoteRefs(input.mirror).has(ref.name)).map((ref) => ({ ...ref }));
      const previous = refMap(input.knownRefs);
      const current = refMap(filteredRefs);
      const updates: MirrorRefUpdate[] = [];
      const commits: MirrorRemoteCommit[] = [];
      for (const name of new Set([...previous.keys(), ...current.keys()])) {
        const before = previous.get(name);
        const after = current.get(name);
        if (before === after) {
          updates.push({ remoteRef: name, ...(before ? { previousOid: before } : {}), ...(after ? { currentOid: after } : {}), kind: "unchanged", receipt: `provider=github-app; ref=${name}; state=unchanged; credentialMaterialStored=false` });
          continue;
        }
        if (after === undefined) {
          updates.push({ remoteRef: name, ...(before ? { previousOid: before } : {}), kind: "deleted", receipt: `provider=github-app; ref=${name}; state=deleted; credentialMaterialStored=false` });
          continue;
        }
        let kind: MirrorRefUpdate["kind"];
        let comparisonReceipt = "comparison=not-needed";
        if (before === undefined) {
          kind = "created";
        } else {
          try {
            const comparison = await this.api.compare({ repository: this.installation.repository, baseOid: before, headOid: after, token: token.token });
            kind = comparison.status === "ahead" ? "fast-forward" : "force-push";
            comparisonReceipt = comparison.receipt;
          } catch (error) {
            // After a forced rewrite GitHub may no longer expose the old OID
            // to its compare endpoint. The ref read and current-commit read
            // are still authoritative, so classify conservatively and force
            // an explicit reconciliation instead of hiding the rewrite.
            if (error instanceof GitHubAppAdapterError && error.errorCode === "github_app.http_404") {
              kind = "force-push";
              comparisonReceipt = "comparison=not-found; classification=force-push; provider-limit-not-claimed";
            } else {
              throw error;
            }
          }
        }
        const commit = await this.api.getCommit({ repository: this.installation.repository, oid: after, ref: name, token: token.token });
        commits.push({ oid: commit.oid, ref: name, author: { ...commit.author }, disclosure: "public", ...(remote.originOperationId ? { originOperationId: remote.originOperationId } : {}), });
        updates.push({ remoteRef: name, ...(before ? { previousOid: before } : {}), currentOid: after, kind, receipt: `provider=github-app; ref=${name}; state=${kind}; ${comparisonReceipt}; credentialMaterialStored=false` });
      }
      const providerReceipt = safeReceipt(remote.receipt, "git.receipt");
      return { status: "succeeded", value: { generation: remote.generation, refs: filteredRefs, updates, commits, ...(remote.originOperationId ? { originOperationId: remote.originOperationId } : {}), receipt: `provider=github-app; operation=inspect; installation=${this.installation.installationId}; repository=${this.installation.repository}; git=${providerReceipt}; expiresAt=${token.expiresAt}; credentialMaterialStored=false` } };
    } catch (error) {
      return providerFailure(input.mirror, error, "inspect");
    }
  }

  async push(input: Parameters<MirrorRemoteAdapter["push"]>[0]): Promise<MirrorProviderResult<MirrorRemoteState>> {
    try {
      this.assertMirror(input.mirror);
      const token = await this.token("write");
      const desiredRefs = input.desiredRefs.filter((ref) => mappedRemoteRefs(input.mirror).has(ref.name)).map((ref) => ({ ...ref }));
      if (!refsEqual(desiredRefs, input.desiredRefs)) throw new GitHubAppAdapterError({ errorCode: "github_app.unmapped_ref", message: "The projection contains a ref outside the configured Mirror mapping.", retryable: false, recoveryAction: "project only the mapped public branch and resume the same outbound operation", receipt: `mirror=${input.mirror.id}; operation=${input.operationId}; refMapping=blocked; credentialMaterialStored=false` });
      const remote = await this.git.push({ repositoryUrl: this.installation.repositoryUrl, token: token.token, expectedRefs: input.expectedRefs, desiredRefs, refMappings: input.mirror.refMappings, operationId: input.operationId, idempotencyKey: input.idempotencyKey });
      let reinspection: GitHubSmartHttpRefs;
      let resultRefs: GitRef[] = [];
      let readAfterWriteAttempts = 0;
      while (true) {
        try {
          reinspection = await this.git.inspect({ repositoryUrl: this.installation.repositoryUrl, token: token.token, refs: [...mappedRemoteRefs(input.mirror)], knownGeneration: remote.generation });
        } catch (error) {
          const delay = this.readAfterWriteRetry.delaysMs[readAfterWriteAttempts];
          if (delay === undefined) throw error;
          readAfterWriteAttempts += 1;
          await this.readAfterWriteRetry.sleep(delay);
          continue;
        }
        resultRefs = reinspection.refs.filter((ref) => mappedRemoteRefs(input.mirror).has(ref.name)).map((ref) => ({ ...ref }));
        if (refsEqual(resultRefs, desiredRefs)) break;
        const delay = this.readAfterWriteRetry.delaysMs[readAfterWriteAttempts];
        if (delay === undefined) throw new GitHubAppAdapterError({ errorCode: "github_app.push_result_mismatch", message: "GitHub did not return the exact mapped refs requested by Anyam after the bounded read-after-write window.", retryable: false, recoveryAction: "inspect the GitHub ref state and resume the Mirror checkpoint without accepting the provider result", receipt: `mirror=${input.mirror.id}; operation=${input.operationId}; expectedRefs=${desiredRefs.length}; actualRefs=${resultRefs.length}; readAfterWriteAttempts=${readAfterWriteAttempts}; readAfterWriteRetry=${this.readAfterWriteRetry.sizingReceipt}; credentialMaterialStored=false` });
        readAfterWriteAttempts += 1;
        await this.readAfterWriteRetry.sleep(delay);
      }
      const providerReceipt = safeReceipt(remote.receipt, "git.receipt");
      const reinspectionReceipt = safeReceipt(reinspection.receipt, "git.reinspectionReceipt");
      return { status: "succeeded", value: { generation: reinspection.generation, refs: resultRefs, updates: resultRefs.map((ref) => ({ remoteRef: ref.name, currentOid: ref.oid, kind: "fast-forward" as const, originOperationId: input.operationId, receipt: `provider=github-app; ref=${ref.name}; operation=${input.operationId}; state=projected; credentialMaterialStored=false` })), commits: [], originOperationId: input.operationId, receipt: `provider=github-app; operation=push; installation=${this.installation.installationId}; repository=${this.installation.repository}; git=${providerReceipt}; reinspection=${reinspectionReceipt}; readAfterWriteAttempts=${readAfterWriteAttempts}; readAfterWriteRetry=${this.readAfterWriteRetry.sizingReceipt}; expiresAt=${token.expiresAt}; credentialMaterialStored=false` } };
    } catch (error) {
      return providerFailure(input.mirror, error, "push");
    }
  }

  async observePullRequest(input: { number: number }): Promise<MirrorProviderResult<GitHubPullRequestObservation>> {
    try {
      if (!Number.isInteger(input.number) || input.number <= 0) throw new GitHubAppAdapterError({ errorCode: "github_app.pull_request_invalid", message: "The pull request number is invalid.", retryable: false, recoveryAction: "observe a positive pull request number from the signed delivery hint", receipt: "proposal=invalid; credentialMaterialStored=false" });
      const token = await this.token("read");
      const observation = await this.api.getPullRequest({ repository: this.installation.repository, number: input.number, token: token.token });
      if (observation.repository !== this.installation.repository || observation.headCommit.trim().length === 0 || observation.baseCommit.trim().length === 0) throw new GitHubAppAdapterError({ errorCode: "github_app.pull_request_lineage_invalid", message: "The GitHub PR observation is not bound to the selected repository and exact base/head commits.", retryable: false, recoveryAction: "re-inspect the selected repository PR and return its exact base and head commits", receipt: `proposal=${input.number}; repository=${observation.repository}; lineage=invalid; credentialMaterialStored=false` });
      return { status: "succeeded", value: { ...observation }, };
    } catch (error) {
      const mirror = { remoteRepository: this.installation.repository } as RepositoryMirror;
      return providerFailure(mirror, error, "pull-request");
    }
  }

  /**
   * Re-inspect one exact remote commit through the selected GitHub
   * installation. This is the provider-side observation used by the signed
   * Mirror producer; it never creates an Anyam Change by itself.
   */
  async observeMirrorRepository(input: {
    mirror: RepositoryMirror;
    repositoryId: string;
    sourceSpaceId: string;
    projectViewId: string;
    proposalKey: string;
    deliveryId: string;
    symbolicRef: string;
    commitOid: string;
    baseCommitOid: string;
    baseRef?: string;
    headRef?: string;
  }): Promise<MirrorProviderResult<MirrorRepositoryObservation>> {
    try {
      this.assertMirror(input.mirror);
      const repositoryId = required(input.repositoryId, "repositoryId");
      const sourceSpaceId = required(input.sourceSpaceId, "sourceSpaceId");
      const projectViewId = required(input.projectViewId, "projectViewId");
      const proposalKey = required(input.proposalKey, "proposalKey");
      const deliveryId = required(input.deliveryId, "deliveryId");
      const symbolicRef = required(input.symbolicRef, "symbolicRef");
      const commitOid = required(input.commitOid, "commitOid");
      const baseCommitOid = required(input.baseCommitOid, "baseCommitOid");
      const token = await this.token("read");
      let providerReadRetryAttempts = 0;
      const retryNotFound = async <T>(read: () => Promise<T>): Promise<T> => {
        while (true) {
          try {
            return await read();
          } catch (error) {
            const delay = this.readAfterWriteRetry.delaysMs[providerReadRetryAttempts];
            if (!(error instanceof GitHubAppAdapterError) || error.errorCode !== "github_app.http_404" || delay === undefined) throw error;
            providerReadRetryAttempts += 1;
            await this.readAfterWriteRetry.sleep(delay);
          }
        }
      };
      const commit = await retryNotFound(() => this.api.getCommit({ repository: this.installation.repository, oid: commitOid, ref: symbolicRef, token: token.token }));
      if (commit.oid !== commitOid || !commit.treeOid) throw new GitHubAppAdapterError({ errorCode: "github_app.commit_observation_invalid", message: "GitHub did not return the exact commit tree required for Mirror provenance.", retryable: false, recoveryAction: "re-inspect the selected repository commit and return its exact tree identity", receipt: `provider=github-app; operation=observe-mirror-repository; commit=${commitOid}; tree=${commit.treeOid ?? "missing"}; credentialMaterialStored=false` });
      const comparison = await retryNotFound(() => this.api.compare({ repository: this.installation.repository, baseOid: baseCommitOid, headOid: commitOid, ...(input.baseRef ? { baseRef: input.baseRef } : {}), ...(input.headRef ? { headRef: input.headRef } : {}), token: token.token }));
      if (comparison.status !== "ahead" && comparison.status !== "identical") throw new GitHubAppAdapterError({ errorCode: "github_app.commit_ancestry_invalid", message: "The GitHub commit is not a descendant of the canonical Mirror base.", retryable: false, recoveryAction: "rebase or explicitly reconcile the remote proposal against the current canonical base before ingestion", receipt: `provider=github-app; operation=observe-mirror-repository; base=${baseCommitOid}; head=${commitOid}; comparison=${comparison.status}; credentialMaterialStored=false` });
      const claims = {
        protocol: "anyam.mirror-repository-observation/v1" as const,
        repositoryId,
        sourceSpaceId,
        mirrorId: input.mirror.id,
        proposalKey,
        deliveryId,
        provider: "github",
        remoteRepository: this.installation.repository,
        projectViewId,
        objectFormat: "sha1" as const,
        symbolicRef,
        commitOid,
        treeOid: commit.treeOid,
        baseCommitOid,
        ancestryVerified: true as const,
        observedAt: new Date().toISOString(),
        receipt: `provider=github-app; operation=observe-mirror-repository; installation=${this.installation.installationId}; repository=${this.installation.repository}; comparison=${comparison.status}; comparisonRefs=${input.baseRef ?? "sha"}...${input.headRef ?? "sha"}; compareReceipt=${safeReceipt(comparison.receipt, "compare.receipt")}; providerReadRetryAttempts=${providerReadRetryAttempts}; providerReadRetry=${this.readAfterWriteRetry.sizingReceipt}; expiresAt=${token.expiresAt}; credentialMaterialStored=false`,
      };
      return { status: "succeeded", value: { ...claims, manifestDigest: mirrorObservationDigest(claims) } };
    } catch (error) {
      return providerFailure(input.mirror, error, "observe-mirror-repository");
    }
  }

  externalProposal(observation: GitHubPullRequestObservation, input: { projectViewId: string; baseProjectRevisionId: string; disclosure: "public"; deliveryId: string; sourceSpaceSnapshots: Readonly<Record<string, string>> }): Record<string, unknown> {
    if (observation.repository !== this.installation.repository) throw new GitHubAppAdapterError({ errorCode: "github_app.pull_request_lineage_invalid", message: "The pull request is not bound to the selected repository.", retryable: false, recoveryAction: "observe the PR through the selected GitHub App installation", receipt: `proposal=${observation.number}; repository-mismatch; credentialMaterialStored=false` });
    return {
      provider: "github",
      installationId: this.installation.installationId,
      sourceIdentity: this.installation.installationId.startsWith("installation:") ? this.installation.installationId : `installation:${this.installation.installationId}`,
      remoteRepository: observation.repository,
      proposalKind: "pull-request",
      proposalKey: String(observation.number),
      remoteRef: `refs/pull/${observation.number}/head`,
      baseRef: `refs/heads/${observation.baseRef}`,
      baseCommit: observation.baseCommit,
      latestHeadCommit: observation.headCommit,
      baseProjectRevisionId: required(input.baseProjectRevisionId, "baseProjectRevisionId"),
      projectViewId: required(input.projectViewId, "projectViewId"),
      disclosure: input.disclosure,
      sourceSpaceSnapshots: { ...input.sourceSpaceSnapshots },
      status: observation.merged ? "merged" : observation.state === "closed" ? "closed" : "open",
      receipt: `provider=github-app; proposal=${observation.number}; delivery=${required(input.deliveryId, "deliveryId")}; credentialFree=true`,
    };
  }

  acceptWebhook(input: { body: string; event: string; action?: string; deliveryId: string; signature: string; secret: string; mirrorId: string; mappedRemoteRefs: readonly string[] }): GitHubWebhookReceipt {
    const deliveryId = required(input.deliveryId, "deliveryId");
    if (!verifyGitHubWebhookSignature(input)) return { status: "blocked", mirrorId: input.mirrorId, deliveryId, eventType: input.event, reinspectionRequired: false, credentialFree: true, receipt: `provider=github-app; webhook=signature-invalid; delivery=${deliveryId}; credentialMaterialStored=false`, recoveryAction: "verify the GitHub App webhook secret and signature before enqueueing the wake-up hint" };
    if (input.event !== "push" && input.event !== "pull_request") return { status: "ignored", mirrorId: input.mirrorId, deliveryId, eventType: input.event, reinspectionRequired: false, credentialFree: true, receipt: `provider=github-app; webhook=event-ignored; delivery=${deliveryId}; event=${input.event}; credentialMaterialStored=false` };
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(input.body);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object-required");
      payload = parsed as Record<string, unknown>;
    } catch {
      return { status: "blocked", mirrorId: input.mirrorId, deliveryId, eventType: input.event, reinspectionRequired: false, credentialFree: true, receipt: `provider=github-app; webhook=payload-invalid; delivery=${deliveryId}; credentialMaterialStored=false`, recoveryAction: "retain the signed delivery ID and request a fresh provider delivery" };
    }
    const payloadAction = typeof payload.action === "string" ? payload.action : undefined;
    const normalizedAction = input.event === "push" ? "push" : payloadAction;
    if (input.action !== undefined && input.action !== normalizedAction) return { status: "blocked", mirrorId: input.mirrorId, deliveryId, eventType: input.event, reinspectionRequired: false, credentialFree: true, receipt: `provider=github-app; webhook=action-mismatch; delivery=${deliveryId}; credentialMaterialStored=false`, recoveryAction: "use the action from the signed webhook payload; do not override it at the adapter boundary" };
    const pullRequestActions = new Set(["opened", "reopened", "synchronize", "closed"]);
    if (input.event === "pull_request" && (!normalizedAction || !pullRequestActions.has(normalizedAction))) return { status: "ignored", mirrorId: input.mirrorId, deliveryId, eventType: input.event, reinspectionRequired: false, credentialFree: true, receipt: `provider=github-app; webhook=action-ignored; delivery=${deliveryId}; action=${normalizedAction ?? "missing"}; credentialMaterialStored=false` };
    const repository = (payload.repository as Record<string, unknown> | undefined)?.full_name;
    const installationId = parseInstallationId((payload.installation as Record<string, unknown> | undefined)?.id);
    if (repository !== this.installation.repository || installationId !== this.installation.installationId) return { status: "ignored", mirrorId: input.mirrorId, deliveryId, eventType: input.event, reinspectionRequired: false, credentialFree: true, receipt: `provider=github-app; webhook=repository-or-installation-ignored; delivery=${deliveryId}; credentialMaterialStored=false` };
    let ref: string | undefined;
    let proposalKey: string | undefined;
    if (input.event === "push") ref = typeof payload.ref === "string" ? payload.ref : undefined;
    else {
      const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
      const base = pullRequest?.base as Record<string, unknown> | undefined;
      const number = pullRequest?.number;
      ref = typeof base?.ref === "string" ? `refs/heads/${base.ref}` : undefined;
      proposalKey = typeof number === "number" || typeof number === "string" ? String(number) : undefined;
    }
    if (!ref || !input.mappedRemoteRefs.includes(ref)) return { status: "ignored", mirrorId: input.mirrorId, deliveryId, eventType: input.event, reinspectionRequired: false, credentialFree: true, receipt: `provider=github-app; webhook=unmapped-ref-ignored; delivery=${deliveryId}; ref=${ref ?? "missing"}; credentialMaterialStored=false` };
    const queued = this.queue.enqueue({ mirrorId: input.mirrorId, deliveryId, eventType: input.event, ...(normalizedAction ? { action: normalizedAction } : {}), repository: this.installation.repository, installationId, ...(ref ? { ref } : {}), ...(proposalKey ? { proposalKey } : {}), bodyDigest: webhookBodyDigest(input.body), receipt: `provider=github-app; webhook=signed-hint; delivery=${deliveryId}; ref=${ref}; action=${normalizedAction ?? "missing"}; remoteState=not-yet-inspected; credentialMaterialStored=false` });
    return { status: queued.status, mirrorId: input.mirrorId, deliveryId, eventType: input.event, reinspectionRequired: queued.status === "accepted" || queued.status === "duplicate", credentialFree: true, receipt: queued.receipt, ...(queued.recoveryAction ? { recoveryAction: queued.recoveryAction } : {}) };
  }

  async drainReconciliation(input: { limit: number; reinspect: (task: GitHubReconciliationTask) => Promise<{ status: "succeeded" | "blocked"; receipt: string }> }): Promise<{ status: "succeeded" | "blocked"; value?: { processedDeliveryIds: readonly string[]; receipts: readonly string[] }; receipt: string; recoveryAction?: string }> {
    return this.queue.drain(input);
  }

}

export type GitHubMirrorIngestionResult = {
  status: "succeeded" | "blocked";
  receipt: string;
  recoveryAction?: string;
};

export type GitHubMirrorProducerOptions = {
  adapter: GitHubAppProjectionAdapter;
  mirror: RepositoryMirror;
  realmId: string;
  repositoryId: string;
  projectViewId: string;
  canonicalProjectRevisionId: string;
  canonicalRefs: readonly GitRef[];
  installationId: string;
  handoffKeyId: string;
  handoffSecret: string;
  ingest: (handoff: MirrorIngestionHandoff) => Promise<GitHubMirrorIngestionResult>;
  nowMilliseconds?: () => number;
  handoffMaxLifetimeMs?: number;
  handoffClockSkewMs?: number;
};

export type GitHubMirrorProducerResult = {
  status: "succeeded" | "blocked";
  webhook: GitHubWebhookReceipt;
  drained?: { processedDeliveryIds: readonly string[]; receipts: readonly string[] };
  receipt: string;
  recoveryAction?: string;
};

function installationSourceIdentity(installationId: string): string {
  return installationId.startsWith("installation:") ? installationId : `installation:${installationId}`;
}

function producerReceipt(input: { mirrorId: string; deliveryId: string; detail: string }): string {
  return `provider=github-app; producer=mirror-ingestion; mirror=${input.mirrorId}; delivery=${input.deliveryId}; ${input.detail}; credentialMaterialStored=false`;
}

/**
 * Compose GitHub webhook hints, provider reinspection, Mirror observations,
 * and the internal signed handoff. The producer owns provider credentials only
 * through the adapter; the Realm receives a signed command and never a token.
 */
export class GitHubMirrorProducer {
  private readonly adapter: GitHubAppProjectionAdapter;
  private readonly mirror: RepositoryMirror;
  private readonly realmId: string;
  private readonly repositoryId: string;
  private readonly projectViewId: string;
  private readonly canonicalProjectRevisionId: string;
  private readonly canonicalRefs: readonly GitRef[];
  private readonly installationId: string;
  private readonly handoffKeyId: string;
  private readonly handoffSecret: string;
  private readonly ingest: (handoff: MirrorIngestionHandoff) => Promise<GitHubMirrorIngestionResult>;
  private readonly nowMilliseconds: () => number;
  private readonly handoffMaxLifetimeMs: number;
  private readonly handoffClockSkewMs: number;

  constructor(input: GitHubMirrorProducerOptions) {
    this.adapter = input.adapter;
    this.mirror = { ...input.mirror, refMappings: input.mirror.refMappings.map((mapping) => ({ ...mapping })), canonicalRefs: input.mirror.canonicalRefs.map((ref) => ({ ...ref })), remoteRefs: input.mirror.remoteRefs.map((ref) => ({ ...ref })) };
    this.realmId = required(input.realmId, "realmId");
    this.repositoryId = required(input.repositoryId, "repositoryId");
    this.projectViewId = required(input.projectViewId, "projectViewId");
    this.canonicalProjectRevisionId = required(input.canonicalProjectRevisionId, "canonicalProjectRevisionId");
    this.canonicalRefs = input.canonicalRefs.map((ref) => ({ ...ref }));
    this.installationId = required(input.installationId, "installationId");
    this.handoffKeyId = required(input.handoffKeyId, "handoffKeyId");
    this.handoffSecret = required(input.handoffSecret, "handoffSecret");
    this.ingest = input.ingest;
    this.nowMilliseconds = input.nowMilliseconds ?? (() => Date.now());
    this.handoffMaxLifetimeMs = input.handoffMaxLifetimeMs ?? MIRROR_HANDOFF_TTL_MS;
    this.handoffClockSkewMs = input.handoffClockSkewMs ?? MIRROR_HANDOFF_CLOCK_SKEW_MS;
    if (!Number.isSafeInteger(this.handoffMaxLifetimeMs) || this.handoffMaxLifetimeMs <= 0 || !Number.isSafeInteger(this.handoffClockSkewMs) || this.handoffClockSkewMs < 0) throw new GitHubAppAdapterError({ errorCode: "github_app.mirror_handoff_configuration_invalid", message: "Mirror handoff lifetime and clock-skew tripwires are invalid.", retryable: false, recoveryAction: "configure measured handoff lifetime and clock-skew values before binding the producer", receipt: "producer=mirror-ingestion; handoffTripwires=invalid; credentialMaterialStored=false" });
    if (this.mirror.canonicalAuthority !== "anyam" || this.mirror.provider !== "github") throw new GitHubAppAdapterError({ errorCode: "github_app.producer_mirror_invalid", message: "The GitHub Mirror producer requires an Anyam-canonical GitHub Mirror.", retryable: false, recoveryAction: "configure a GitHub projection Mirror with Anyam as canonical authority", receipt: "producer=mirror-invalid; canonicalAuthority=anyam-required; provider=github-required; credentialMaterialStored=false" });
    if (this.canonicalProjectRevisionId !== this.mirror.canonicalProjectRevisionId || !refsEqual(this.canonicalRefs, this.mirror.canonicalRefs)) throw new GitHubAppAdapterError({ errorCode: "github_app.producer_canonical_stale", message: "The producer canonical state is stale relative to the configured Mirror.", retryable: false, recoveryAction: "read the current Anyam canonical Project Revision and recreate the producer with that exact ref set", receipt: `producer=canonical-stale; mirror=${this.mirror.id}; credentialMaterialStored=false` });
  }

  async processWebhook(input: Parameters<GitHubAppProjectionAdapter["acceptWebhook"]>[0]): Promise<GitHubMirrorProducerResult> {
    const webhook = this.adapter.acceptWebhook(input);
    if (webhook.status === "blocked") return { status: "blocked", webhook, receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: webhook.deliveryId, detail: "webhook=blocked" }), ...(webhook.recoveryAction ? { recoveryAction: webhook.recoveryAction } : {}) };
    if (webhook.status === "ignored") return { status: "succeeded", webhook, receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: webhook.deliveryId, detail: "webhook=ignored; providerReinspection=false" }) };
    const drained = await this.adapter.drainReconciliation({ limit: 1, reinspect: (task) => this.reinspect(task) });
    if (drained.status === "blocked") return { status: "blocked", webhook, ...(drained.value ? { drained: drained.value } : {}), receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: webhook.deliveryId, detail: `webhook=${webhook.status}; queue=blocked; queueReceipt=${safeReceipt(drained.receipt, "queue.receipt")}` }), ...(drained.recoveryAction ? { recoveryAction: drained.recoveryAction } : {}) };
    return { status: "succeeded", webhook, ...(drained.value ? { drained: drained.value } : {}), receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: webhook.deliveryId, detail: `webhook=${webhook.status}; queue=drained` }) };
  }

  private async reinspect(task: GitHubReconciliationTask): Promise<{ status: "succeeded" | "blocked"; receipt: string; recoveryAction?: string }> {
    if (task.mirrorId !== this.mirror.id || task.repository !== this.mirror.remoteRepository || task.installationId !== this.installationId) return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: "task=identity-mismatch; handoff=not-created" }), recoveryAction: "retain the signed delivery but configure the producer with the exact Mirror, installation, and repository identities" };
    const inspected = await this.adapter.inspect({ mirror: this.mirror, knownRefs: this.mirror.remoteRefs, knownGeneration: this.mirror.remoteGeneration });
    if (inspected.status !== "succeeded") return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: `reinspection=failed; error=${inspected.errorCode}` }), recoveryAction: inspected.recoveryAction };
    const remoteState = inspected.value;
    let externalProposal: Record<string, unknown> | undefined;
    let mirrorObservation: MirrorRepositoryObservation | undefined;
    if (task.eventType === "pull_request") {
      const proposalKey = task.proposalKey;
      const number = proposalKey ? Number(proposalKey) : NaN;
      if (!proposalKey || !Number.isSafeInteger(number) || number < 1) return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: "proposal=invalid; handoff=not-created" }), recoveryAction: "replay the signed pull_request delivery with its positive proposal number" };
      const observedPullRequest = await this.adapter.observePullRequest({ number });
      if (observedPullRequest.status !== "succeeded") return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: `proposal=reinspection-failed; error=${observedPullRequest.errorCode}` }), recoveryAction: observedPullRequest.recoveryAction };
      const proposal = this.adapter.externalProposal(observedPullRequest.value, { projectViewId: this.projectViewId, baseProjectRevisionId: this.canonicalProjectRevisionId, disclosure: "public", deliveryId: task.deliveryId, sourceSpaceSnapshots: { [this.mirror.sourceSpaceId]: observedPullRequest.value.headCommit } });
      externalProposal = proposal;
      const observed = await this.adapter.observeMirrorRepository({ mirror: this.mirror, repositoryId: this.repositoryId, sourceSpaceId: this.mirror.sourceSpaceId, projectViewId: this.projectViewId, proposalKey, deliveryId: task.deliveryId, symbolicRef: String(proposal.remoteRef), commitOid: observedPullRequest.value.headCommit, baseCommitOid: observedPullRequest.value.baseCommit, baseRef: observedPullRequest.value.baseRef, headRef: observedPullRequest.value.headRef });
      if (observed.status !== "succeeded") return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: `proposal=observation-failed; error=${observed.errorCode}` }), recoveryAction: observed.recoveryAction };
      mirrorObservation = observed.value;
    } else {
      const remoteRef = task.ref;
      const update = remoteRef ? remoteState.updates.find((candidate) => candidate.remoteRef === remoteRef) : undefined;
      if (!remoteRef || !update) return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: "ref=not-observed; handoff=not-created" }), recoveryAction: "reinspect the signed push delivery and return the exact mapped ref update" };
      if (update.kind === "force-push" || update.kind === "deleted") return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: `ref=${remoteRef}; update=${update.kind}; reconciliation=required` }), recoveryAction: "inspect the force-push or deletion and resume with an explicit Mirror reconciliation choice" };
      const remoteRefValue = remoteState.refs.find((ref) => ref.name === remoteRef);
      const commit = remoteState.commits.find((candidate) => candidate.ref === remoteRef && candidate.oid === remoteRefValue?.oid);
      const mapping = this.mirror.refMappings.find((candidate) => candidate.remoteRef === remoteRef);
      const canonicalRef = mapping ? this.canonicalRefs.find((ref) => ref.name === mapping.localRef) : undefined;
      if (!remoteRefValue || !commit || !mapping || !canonicalRef) return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: `ref=${remoteRef}; provenance=incomplete; handoff=not-created` }), recoveryAction: "reinspect the exact mapped ref, commit author, and canonical base before creating a provider handoff" };
      const proposalKey = task.proposalKey ?? `ref:${remoteRef}`;
      const observed = await this.adapter.observeMirrorRepository({ mirror: this.mirror, repositoryId: this.repositoryId, sourceSpaceId: this.mirror.sourceSpaceId, projectViewId: this.projectViewId, proposalKey, deliveryId: task.deliveryId, symbolicRef: remoteRef, commitOid: remoteRefValue.oid, baseCommitOid: canonicalRef.oid, headRef: remoteRef.replace(/^refs\/heads\//u, "") });
      if (observed.status !== "succeeded") return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: `ref=${remoteRef}; observation=failed; error=${observed.errorCode}` }), recoveryAction: observed.recoveryAction };
      mirrorObservation = observed.value;
      externalProposal = { provider: "github", installationId: this.installationId, sourceIdentity: installationSourceIdentity(this.installationId), remoteRepository: this.mirror.remoteRepository, proposalKind: "ref", proposalKey, remoteRef, baseRef: remoteRef, baseCommit: canonicalRef.oid, latestHeadCommit: remoteRefValue.oid, baseProjectRevisionId: this.canonicalProjectRevisionId, projectViewId: this.projectViewId, disclosure: this.mirror.disclosure, sourceSpaceSnapshots: { [this.mirror.sourceSpaceId]: remoteRefValue.oid }, status: "open", remoteAuthor: { ...commit.author }, receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: `proposal=${proposalKey}; head=${remoteRefValue.oid}; providerObservation=verified` }) };
    }
    if (!externalProposal || !mirrorObservation) return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: "proposal-observation=missing; handoff=not-created" }), recoveryAction: "reinspect the provider proposal and return one exact Mirror Repository observation" };
    const verified = verifyMirrorRepositoryObservation({ observation: mirrorObservation, repositoryId: this.repositoryId, sourceSpaceId: this.mirror.sourceSpaceId, mirrorId: this.mirror.id, proposalKey: String(externalProposal.proposalKey), deliveryId: task.deliveryId, provider: "github", remoteRepository: this.mirror.remoteRepository, projectViewId: this.projectViewId, expectedCommitOid: String(externalProposal.latestHeadCommit), expectedBaseCommitOid: String(externalProposal.baseCommit ?? this.canonicalRefs[0]?.oid ?? "") });
    if (!verified.valid) return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: "observation=binding-mismatch; handoff=not-created" }), recoveryAction: verified.recoveryAction };
    const operationId = `mirror-operation:github-app:${task.deliveryId}`;
    const checkpointId = `mirror-checkpoint:github-app:${task.deliveryId}`;
    const idempotencyKey = `mirror:github-app:${this.mirror.id}:${task.deliveryId}`;
    const delivery = { provider: "github", installationId: this.installationId, sourceIdentity: installationSourceIdentity(this.installationId), remoteRepository: this.mirror.remoteRepository, deliveryId: task.deliveryId, eventType: task.action ? `${task.eventType}.${task.action}` : task.eventType, proposalKey: String(externalProposal.proposalKey) };
    const command: MirrorIngestionCommand = { protocol: "anyam.authority-command/v1", command: "mirror.sync", idempotencyKey, payload: { mirrorId: this.mirror.id, canonicalProjectRevisionId: this.canonicalProjectRevisionId, canonicalRefs: this.canonicalRefs, expectedRemoteGeneration: this.mirror.remoteGeneration, remoteGeneration: remoteState.generation, remoteRefs: remoteState.refs, operationId, checkpointId, operationKind: "inbound", operationState: "succeeded", mirrorState: "lagging", inboundChangeIds: [], completedInboundChangeIds: [], pendingInboundChangeIds: this.mirror.pendingInboundChangeIds, delivery, externalProposal, mirrorRepositoryObservations: { [this.mirror.sourceSpaceId]: verified.observation }, receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: `reinspection=verified; remoteGeneration=${remoteState.generation}; observationDigest=${verified.observation.manifestDigest}` }) } };
    const now = this.nowMilliseconds();
    if (!Number.isSafeInteger(now)) return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: "clock=invalid; handoff=not-created" }), recoveryAction: "repair the producer clock and retry the same signed delivery" };
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + this.handoffMaxLifetimeMs).toISOString();
    const handoff = await signMirrorIngestionHandoff({ command, keyId: this.handoffKeyId, nonce: `nonce:github-app:${digest([this.mirror.id, task.deliveryId, task.bodyDigest])}`, realmId: this.realmId, installationId: this.installationId, issuer: `github-app:${this.installationId}`, provider: "github", remoteRepository: this.mirror.remoteRepository, mirrorId: this.mirror.id, deliveryId: task.deliveryId, proposalKey: String(externalProposal.proposalKey), issuedAt, expiresAt, secret: this.handoffSecret, now, maxLifetimeMs: this.handoffMaxLifetimeMs, clockSkewMs: this.handoffClockSkewMs });
    let ingested: GitHubMirrorIngestionResult;
    try {
      ingested = await this.ingest(handoff);
    } catch (error) {
      return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: `handoff=signed; ingestion=indeterminate; error=${error instanceof Error ? error.name : "unknown"}` }), recoveryAction: "inspect the internal Mirror ingestion checkpoint and retry the same signed delivery only after reconciling Authority state" };
    }
    if (ingested.status !== "succeeded") return { status: "blocked", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: `handoff=signed; ingestion=blocked; providerReceipt=${safeReceipt(ingested.receipt, "ingestion.receipt")}` }), recoveryAction: ingested.recoveryAction ?? "inspect the internal Mirror ingestion checkpoint and retry the same signed delivery" };
    return { status: "succeeded", receipt: producerReceipt({ mirrorId: this.mirror.id, deliveryId: task.deliveryId, detail: `handoff=signed; ingestion=succeeded; nonceDigest=${digest(handoff.nonce)}; ${MIRROR_HANDOFF_SIZING_RECEIPT}` }) };
  }
}

/** Create the customer-Realm HTTP transport used by a deployed producer. */
export function createGitHubMirrorIngestionHttpTransport(input: { baseUrl: string; fetchImpl?: typeof fetch }): (handoff: MirrorIngestionHandoff) => Promise<GitHubMirrorIngestionResult> {
  let baseUrl: URL;
  try {
    baseUrl = new URL(input.baseUrl);
  } catch {
    throw new GitHubAppAdapterError({ errorCode: "github_app.ingestion_url_invalid", message: "Mirror ingestion base URL is malformed.", retryable: false, recoveryAction: "configure the HTTPS customer Realm URL for internal Mirror ingestion", receipt: "producer=mirror-ingestion; baseUrl=invalid; credentialMaterialStored=false" });
  }
  if (baseUrl.protocol !== "https:") throw new GitHubAppAdapterError({ errorCode: "github_app.ingestion_url_invalid", message: "Mirror ingestion base URL must use HTTPS.", retryable: false, recoveryAction: "configure an HTTPS customer Realm URL for internal Mirror ingestion", receipt: `producer=mirror-ingestion; protocol=${baseUrl.protocol}; credentialMaterialStored=false` });
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = new URL("/internal/mirrors/ingest", baseUrl).toString();
  return async (handoff) => {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ handoff }) });
    } catch {
      return { status: "blocked", receipt: `provider=anyam-realm; ingestion=transport-unavailable; handoffNonceDigest=${digest(handoff.nonce)}; credentialMaterialStored=false`, recoveryAction: "retry the same signed Mirror handoff after the customer Realm internal route is reachable" };
    }
    const value: unknown = await response.json().catch(() => undefined);
    const body = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    let authorityReceipt: string | undefined;
    if (typeof body?.receipt === "string") {
      try { authorityReceipt = safeReceipt(body.receipt, "ingestion.authorityReceipt"); } catch { authorityReceipt = undefined; }
    }
    const authorityReceiptSuffix = authorityReceipt ? `; authorityReceipt=${authorityReceipt}` : "";
    const bodyStatus = body?.status === "succeeded" ? "succeeded" : "blocked";
    if (response.status >= 200 && response.status < 300 && bodyStatus === "succeeded") return { status: "succeeded", receipt: `provider=anyam-realm; ingestion=accepted; httpStatus=${response.status}; handoffNonceDigest=${digest(handoff.nonce)}${authorityReceiptSuffix}; credentialMaterialStored=false` };
    return { status: "blocked", receipt: `provider=anyam-realm; ingestion=rejected; httpStatus=${response.status}; handoffNonceDigest=${digest(handoff.nonce)}${authorityReceiptSuffix}; credentialMaterialStored=false`, recoveryAction: "inspect the customer Realm Mirror checkpoint and retry the same signed handoff only after reconciling its response" };
  };
}

type GitHubHttpClientOptions = {
  baseUrl: string;
  retry: { delaysMs: readonly number[]; sizingReceipt: string };
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class FetchGitHubAppHttpClient {
  private readonly options: Required<Pick<GitHubHttpClientOptions, "baseUrl" | "retry" | "fetchImpl" | "sleep">>;

  constructor(input: GitHubHttpClientOptions) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(input.baseUrl);
    } catch {
      throw new GitHubAppAdapterError({ errorCode: "github_app.api_url_invalid", message: "GitHub App API base URL is malformed.", retryable: false, recoveryAction: "configure https://api.github.com; use a separately qualified enterprise adapter for another host", receipt: "apiHost=invalid; transition=not-applied; credentialMaterialStored=false" });
    }
    if (baseUrl.protocol !== "https:" || baseUrl.hostname !== "api.github.com") throw new GitHubAppAdapterError({ errorCode: "github_app.api_url_invalid", message: "GitHub App API base URL must use the public GitHub HTTPS host.", retryable: false, recoveryAction: "configure https://api.github.com; use a separately qualified enterprise adapter for another host", receipt: `apiHost=${baseUrl.hostname}; transition=not-applied; credentialMaterialStored=false` });
    if (input.retry.delaysMs.some((delay) => !Number.isInteger(delay) || delay < 0) || input.retry.sizingReceipt.trim().length === 0) throw new GitHubAppAdapterError({ errorCode: "github_app.backoff_invalid", message: "GitHub retry policy requires measured non-negative delays and a sizing receipt.", retryable: false, recoveryAction: "configure the observed provider backoff policy with its measurement receipt", receipt: "backoff=invalid; transition=not-applied" });
    this.options = { baseUrl: input.baseUrl.replace(/\/$/, ""), retry: { delaysMs: [...input.retry.delaysMs], sizingReceipt: safeReceipt(input.retry.sizingReceipt, "retry.sizingReceipt") }, fetchImpl: input.fetchImpl ?? fetch, sleep: input.sleep ?? (async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))) };
  }

  async request(input: { method: "GET" | "POST" | "DELETE"; path: string; token: string; body?: unknown }): Promise<{ status: number; data: unknown; receipt: string }> {
    const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
    for (let attempt = 0; attempt <= this.options.retry.delaysMs.length; attempt += 1) {
      const response = await this.options.fetchImpl(`${this.options.baseUrl}${path}`, { method: input.method, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${input.token}`, "cache-control": "no-cache", pragma: "no-cache", ...(input.body === undefined ? {} : { "content-type": "application/json" }) }, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
      const text = await response.text();
      let data: unknown = undefined;
      try { data = text.length > 0 ? JSON.parse(text) as unknown : undefined; } catch { data = undefined; }
      const retryable = response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500;
      const receipt = `provider=github-app; http=${input.method} ${path}; status=${response.status}; attempt=${attempt + 1}; retryable=${retryable}; backoff=${this.options.retry.sizingReceipt}; credentialMaterialStored=false`;
      if (response.status >= 200 && response.status < 300) return { status: response.status, data, receipt };
      const delay = this.options.retry.delaysMs[attempt];
      if (retryable && delay !== undefined) {
        await this.options.sleep(delay);
        continue;
      }
      throw new GitHubAppAdapterError({ errorCode: `github_app.http_${response.status}`, message: `GitHub API ${input.method} ${path} returned a non-success response.`, retryable, recoveryAction: retryable ? "resume the same provider operation after the backoff receipt" : "inspect the GitHub App installation permission and repository selection", receipt });
    }
    throw new GitHubAppAdapterError({ errorCode: "github_app.retry_exhausted", message: "GitHub API retry policy was exhausted.", retryable: true, recoveryAction: "inspect the bounded backoff receipt and resume the same provider operation", receipt: `provider=github-app; http=${input.method} ${path}; retry=exhausted; backoff=${this.options.retry.sizingReceipt}; credentialMaterialStored=false` });
  }
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function signGitHubAppJwt(input: { appId: string; privateKey: string; lifetimeSeconds: number; clockSkewSeconds: number; nowSeconds: number }): string {
  const issuedAt = input.nowSeconds - input.clockSkewSeconds;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: issuedAt + input.lifetimeSeconds, iss: input.appId }));
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(input.privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

export class GitHubAppInstallationTokenIssuer implements GitHubAppTokenIssuer {
  private readonly http: FetchGitHubAppHttpClient;
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly lifetimeSeconds: number;
  private readonly clockSkewSeconds: number;
  private readonly now: () => number;

  constructor(input: { http: FetchGitHubAppHttpClient; appId: string; privateKey: string; jwtLifetimeSeconds: number; clockSkewSeconds: number; sizingReceipt: string; clockSkewSizingReceipt: string; nowSeconds?: () => number }) {
    this.http = input.http;
    this.appId = required(input.appId, "appId");
    this.privateKey = required(input.privateKey, "privateKey");
    if (!Number.isInteger(input.jwtLifetimeSeconds) || input.jwtLifetimeSeconds <= 0) throw new GitHubAppAdapterError({ errorCode: "github_app.jwt_lifetime_invalid", message: "GitHub App JWT lifetime must be a positive measured value.", retryable: false, recoveryAction: "configure the provider-allowed JWT lifetime with its sizing receipt", receipt: "jwtLifetime=invalid; transition=not-applied" });
    if (!Number.isInteger(input.clockSkewSeconds) || input.clockSkewSeconds < 0) throw new GitHubAppAdapterError({ errorCode: "github_app.clock_skew_invalid", message: "GitHub App JWT clock skew must be a non-negative measured value.", retryable: false, recoveryAction: "configure the observed provider clock skew with its sizing receipt", receipt: "clockSkew=invalid; transition=not-applied" });
    safeReceipt(input.sizingReceipt, "jwt.sizingReceipt");
    safeReceipt(input.clockSkewSizingReceipt, "jwt.clockSkewSizingReceipt");
    this.lifetimeSeconds = input.jwtLifetimeSeconds;
    this.clockSkewSeconds = input.clockSkewSeconds;
    this.now = input.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  async issue(input: { installationId: string; repository: string; permissions: readonly GitHubAppPermission[] }): Promise<{ token: string; expiresAt: string }> {
    const installationId = required(input.installationId, "installationId");
    const repository = required(input.repository, "repository");
    const permissions: Record<string, string> = {};
    for (const permission of input.permissions) {
      const separator = permission.lastIndexOf(":");
      if (separator <= 0) throw new GitHubAppAdapterError({ errorCode: "github_app.permission_invalid", message: "GitHub App permission is malformed.", retryable: false, recoveryAction: "request an installation token with named permission:access pairs", receipt: `permission=invalid; installation=${installationId}; credentialMaterialStored=false` });
      permissions[permission.slice(0, separator)] = permission.slice(separator + 1);
    }
    const jwt = signGitHubAppJwt({ appId: this.appId, privateKey: this.privateKey, lifetimeSeconds: this.lifetimeSeconds, clockSkewSeconds: this.clockSkewSeconds, nowSeconds: this.now() });
    const repositoryName = repository.split("/").at(-1);
    if (!repositoryName) throw new GitHubAppAdapterError({ errorCode: "github_app.repository_invalid", message: "The GitHub App installation repository must include a repository name.", retryable: false, recoveryAction: "configure the exact owner/name repository identity", receipt: "repositoryName=missing; transition=not-applied; credentialMaterialStored=false" });
    const response = await this.http.request({ method: "POST", path: `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, token: jwt, body: { repositories: [repositoryName], permissions } });
    const data = response.data as Record<string, unknown> | undefined;
    const token = typeof data?.token === "string" ? data.token : "";
    const expiresAt = typeof data?.expires_at === "string" ? data.expires_at : "";
    validateToken({ token, expiresAt });
    return { token, expiresAt };
  }
}

export class FetchGitHubRestClient implements GitHubRestClient {
  private readonly http: FetchGitHubAppHttpClient;

  constructor(http: FetchGitHubAppHttpClient) {
    this.http = http;
  }

  async getCommit(input: { repository: string; oid: string; ref: string; token: string }): Promise<GitHubCommitObservation> {
    const response = await this.http.request({ method: "GET", path: `/repos/${input.repository}/commits/${encodeURIComponent(input.oid)}`, token: input.token });
    const data = response.data as Record<string, unknown> | undefined;
    const commit = data?.commit as Record<string, unknown> | undefined;
    const author = commit?.author as Record<string, unknown> | undefined;
    const tree = commit?.tree as Record<string, unknown> | undefined;
    const name = typeof author?.name === "string" ? author.name : "GitHub contributor";
    const email = typeof author?.email === "string" ? author.email : undefined;
    const treeOid = typeof tree?.sha === "string" ? tree.sha : undefined;
    return { oid: input.oid, author: { name, ...(email ? { email } : {}) }, ...(treeOid ? { treeOid } : {}) };
  }

  async compare(input: { repository: string; baseOid: string; headOid: string; baseRef?: string; headRef?: string; token: string }): Promise<{ status: "identical" | "ahead" | "behind" | "diverged"; receipt: string }> {
    const base = input.baseRef ?? input.baseOid;
    const head = input.headRef ?? input.headOid;
    const response = await this.http.request({ method: "GET", path: `/repos/${input.repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, token: input.token });
    const status = (response.data as Record<string, unknown> | undefined)?.status;
    if (status !== "identical" && status !== "ahead" && status !== "behind" && status !== "diverged") throw new GitHubAppAdapterError({ errorCode: "github_app.compare_invalid", message: "GitHub compare returned an unrecognized status.", retryable: false, recoveryAction: "re-inspect the exact base and head commits before classifying the ref update", receipt: `provider=github-app; compare=status-invalid; credentialMaterialStored=false` });
    return { status, receipt: response.receipt };
  }

  async getPullRequest(input: { repository: string; number: number; token: string }): Promise<GitHubPullRequestObservation> {
    const response = await this.http.request({ method: "GET", path: `/repos/${input.repository}/pulls/${input.number}`, token: input.token });
    const data = response.data as Record<string, unknown> | undefined;
    const head = data?.head as Record<string, unknown> | undefined;
    const base = data?.base as Record<string, unknown> | undefined;
    const repository = typeof (data?.base as Record<string, unknown> | undefined)?.repo === "object" && (data?.base as Record<string, unknown>).repo !== null ? ((data?.base as Record<string, unknown>).repo as Record<string, unknown>).full_name : input.repository;
    return { number: input.number, repository: typeof repository === "string" ? repository : input.repository, state: data?.state === "closed" ? "closed" : "open", merged: data?.merged === true, headRef: typeof head?.ref === "string" ? head.ref : "", headCommit: typeof head?.sha === "string" ? head.sha : "", baseRef: typeof base?.ref === "string" ? base.ref : "", baseCommit: typeof base?.sha === "string" ? base.sha : "" };
  }

  async createPullRequest(input: { repository: string; head: string; base: string; title: string; token: string }): Promise<{ number: number; receipt: string }> {
    const response = await this.http.request({ method: "POST", path: `/repos/${input.repository}/pulls`, token: input.token, body: { head: input.head, base: input.base, title: input.title } });
    const number = (response.data as Record<string, unknown> | undefined)?.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new GitHubAppAdapterError({ errorCode: "github_app.pull_request_create_invalid", message: "GitHub did not return a valid pull request number.", retryable: false, recoveryAction: "inspect the disposable repository pull request state before retrying setup", receipt: `provider=github-app; operation=create-pull-request; number=invalid; credentialMaterialStored=false` });
    return { number, receipt: response.receipt };
  }

  async deleteRepository(input: { repository: string; token: string }): Promise<{ receipt: string }> {
    const response = await this.http.request({ method: "DELETE", path: `/repos/${input.repository}`, token: input.token });
    return { receipt: response.receipt };
  }
}

export class NodeGitSmartHttpTransport implements GitHubSmartHttpTransport {
  private readonly sourceDirectory: string;
  private readonly maxBufferBytes: number;
  private readonly sizingReceipt: string;
  private readonly inspectRetry: GitRetryPolicy;

  constructor(input: { sourceDirectory: string; maxBufferBytes: number; sizingReceipt: string; inspectRetry?: GitRetryPolicyInput }) {
    this.sourceDirectory = required(input.sourceDirectory, "sourceDirectory");
    if (!Number.isSafeInteger(input.maxBufferBytes) || input.maxBufferBytes < 1) throw new GitHubAppAdapterError({ errorCode: "github_app.git_buffer_invalid", message: "Git command output budget must be a positive measured value.", retryable: false, recoveryAction: "configure the observed Git output budget with its sizing receipt", receipt: "git.maxBuffer=invalid; transition=not-applied" });
    this.maxBufferBytes = input.maxBufferBytes;
    this.sizingReceipt = safeReceipt(input.sizingReceipt, "git.sizingReceipt");
    this.inspectRetry = retryPolicy(input.inspectRetry, "inspectRetry");
  }

  private authEnv(token: string): NodeJS.ProcessEnv {
    return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: gitInstallationAuthorizationHeader(token) };
  }

  async inspect(input: { repositoryUrl: string; token: string; refs: readonly string[]; knownGeneration: string }): Promise<GitHubSmartHttpRefs> {
    let repositoryUrl: URL;
    try {
      repositoryUrl = new URL(input.repositoryUrl);
    } catch {
      throw new GitHubAppAdapterError({ errorCode: "github_app.repository_url_invalid", message: "Git Smart HTTP repository URL is malformed.", retryable: false, recoveryAction: "configure a valid https://github.com owner/name repository URL", receipt: "repositoryUrl=invalid; transition=not-applied; credentialMaterialStored=false" });
    }
    if (repositoryUrl.protocol !== "https:" || repositoryUrl.hostname !== "github.com") throw new GitHubAppAdapterError({ errorCode: "github_app.repository_host_invalid", message: "Git Smart HTTP must use the public GitHub HTTPS host.", retryable: false, recoveryAction: "configure a github.com HTTPS repository URL", receipt: `repositoryHost=${repositoryUrl.hostname}; transition=not-applied; credentialMaterialStored=false` });
    let result: { stdout: string };
    let retryAttempts = 0;
    while (true) {
      try {
        result = await execFile("git", ["ls-remote", "--refs", input.repositoryUrl, ...input.refs], { cwd: this.sourceDirectory, env: this.authEnv(input.token), maxBuffer: this.maxBufferBytes });
        break;
      } catch (error) {
        const record = error as { stderr?: unknown };
        const stderr = typeof record.stderr === "string" ? record.stderr : "";
        const delay = this.inspectRetry.delaysMs[retryAttempts];
        if (delay === undefined || gitErrorClass(stderr) !== "provider-or-transport") throw gitTransportFailure(error, "inspect", retryAttempts, this.inspectRetry.sizingReceipt);
        retryAttempts += 1;
        await this.inspectRetry.sleep(delay);
      }
    }
    const refs = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => { const [oid, name] = line.split(/\s+/); return oid && name ? { oid, name } : undefined; }).filter((ref): ref is GitRef => ref !== undefined);
    return { generation: digest(refs), refs, receipt: `provider=github; transport=git-smart-http; refs=${refs.length}; previousGeneration=${input.knownGeneration}; inspectRetryAttempts=${retryAttempts}; inspectRetry=${this.inspectRetry.sizingReceipt}; credentialMaterialStored=false` };
  }

  async push(input: { repositoryUrl: string; token: string; expectedRefs: readonly GitRef[]; desiredRefs: readonly GitRef[]; refMappings: readonly { localRef: string; remoteRef: string }[]; operationId: string; idempotencyKey: string }): Promise<GitHubSmartHttpRefs> {
    const desired = refMap(input.desiredRefs);
    const args = gitPushArguments(input);
    let repositoryUrl: URL;
    try {
      repositoryUrl = new URL(input.repositoryUrl);
    } catch {
      throw new GitHubAppAdapterError({ errorCode: "github_app.repository_url_invalid", message: "Git Smart HTTP repository URL is malformed.", retryable: false, recoveryAction: "configure a valid https://github.com owner/name repository URL", receipt: "repositoryUrl=invalid; transition=not-applied; credentialMaterialStored=false" });
    }
    if (repositoryUrl.protocol !== "https:" || repositoryUrl.hostname !== "github.com") throw new GitHubAppAdapterError({ errorCode: "github_app.repository_host_invalid", message: "Git Smart HTTP must use the public GitHub HTTPS host.", retryable: false, recoveryAction: "configure a github.com HTTPS repository URL", receipt: `repositoryHost=${repositoryUrl.hostname}; transition=not-applied; credentialMaterialStored=false` });
    try {
      await execFile("git", args, { cwd: this.sourceDirectory, env: this.authEnv(input.token), maxBuffer: this.maxBufferBytes });
    } catch (error) {
      throw gitTransportFailure(error, "push");
    }
    const refs = input.refMappings.flatMap((mapping) => { const oid = desired.get(mapping.remoteRef); return oid ? [{ name: mapping.remoteRef, oid }] : []; });
    return { generation: digest(refs), refs, originOperationId: input.operationId, receipt: `provider=github; transport=git-smart-http; operation=${input.operationId}; idempotency=${digest(input.idempotencyKey)}; refs=${refs.length}; credentialMaterialStored=false` };
  }
}
