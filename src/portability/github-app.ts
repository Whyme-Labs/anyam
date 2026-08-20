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
import type { GitRef, RepositoryMirror } from "../kernel/contracts.ts";

export const GITHUB_APP_ADAPTER_PROTOCOL = "anyam.github-app-adapter/v1" as const;
const execFile = promisify(execFileCallback);

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

export function gitTransportFailure(error: unknown, operation: "inspect" | "push"): GitHubAppAdapterError {
  const record = error as { code?: unknown; stderr?: unknown };
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const exitCode = typeof record.code === "number" || typeof record.code === "string" ? String(record.code) : "unknown";
  return new GitHubAppAdapterError({
    errorCode: "github_app.git_transport",
    message: `Git Smart HTTP ${operation} failed; provider stderr is redacted.`,
    retryable: false,
    recoveryAction: "inspect the redacted Git transport receipt, reconcile the selected App installation and repository state, then retry the same disposable qualification",
    receipt: `provider=github-app; transport=git-smart-http; operation=${operation}; exit=${exitCode}; stderrClass=${gitErrorClass(stderr)}; stderrDigest=${digest(stderr)}; credentialMaterialStored=false`,
  });
}

export type GitHubCommitObservation = {
  oid: string;
  author: { name: string; email?: string };
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
  compare(input: { repository: string; baseOid: string; headOid: string; token: string }): Promise<{ status: "identical" | "ahead" | "behind" | "diverged"; receipt: string }>;
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
  // Reject credential-shaped fields and bearer/PEM material, while allowing
  // harmless words such as `token` in a provider operation name or path.
  if (/(?:^|[;,{\s])(?:"|'?)(?:token|bearer|client[_ -]?secret|password|authorization|private[_ -]?key)(?:"|'?)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,;}\s]+)/i.test(receipt) || /\bBearer\s+\S+/i.test(receipt) || /-----BEGIN [^-]+ PRIVATE KEY-----/i.test(receipt)) {
    throw new GitHubAppAdapterError({ errorCode: "github_app.unsafe_receipt", message: `${field} contains credential-like material.`, retryable: false, recoveryAction: `return a digest-only ${field} receipt without credential material`, receipt: `field=${field}; credentialMaterialStored=false; transition=not-applied` });
  }
  return receipt;
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

  constructor(input: { installation: GitHubAppInstallation; issuer: GitHubAppTokenIssuer; git: GitHubSmartHttpTransport; api: GitHubRestClient; queue: GitHubReconciliationQueueOptions }) {
    validateInstallation(input.installation);
    this.installation = { ...input.installation, permissions: { ...input.installation.permissions }, events: [...input.installation.events] };
    this.issuer = input.issuer;
    this.git = input.git;
    this.api = input.api;
    this.queue = new GitHubReconciliationQueue(input.queue);
  }

  private assertMirror(mirror: RepositoryMirror): void {
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
        const kind = before === undefined ? "created" : (await this.api.compare({ repository: this.installation.repository, baseOid: before, headOid: after, token: token.token })).status === "ahead" ? "fast-forward" : "force-push";
        const commit = await this.api.getCommit({ repository: this.installation.repository, oid: after, ref: name, token: token.token });
        commits.push({ oid: commit.oid, ref: name, author: { ...commit.author }, disclosure: "public", ...(remote.originOperationId ? { originOperationId: remote.originOperationId } : {}), });
        updates.push({ remoteRef: name, ...(before ? { previousOid: before } : {}), currentOid: after, kind, receipt: `provider=github-app; ref=${name}; state=${kind}; credentialMaterialStored=false` });
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
      const reinspection = await this.git.inspect({ repositoryUrl: this.installation.repositoryUrl, token: token.token, refs: [...mappedRemoteRefs(input.mirror)], knownGeneration: remote.generation });
      const resultRefs = reinspection.refs.filter((ref) => mappedRemoteRefs(input.mirror).has(ref.name)).map((ref) => ({ ...ref }));
      if (!refsEqual(resultRefs, desiredRefs)) throw new GitHubAppAdapterError({ errorCode: "github_app.push_result_mismatch", message: "GitHub did not return the exact mapped refs requested by Anyam.", retryable: false, recoveryAction: "inspect the GitHub ref state and resume the Mirror checkpoint without accepting the provider result", receipt: `mirror=${input.mirror.id}; operation=${input.operationId}; expectedRefs=${desiredRefs.length}; actualRefs=${resultRefs.length}; credentialMaterialStored=false` });
      const providerReceipt = safeReceipt(remote.receipt, "git.receipt");
      const reinspectionReceipt = safeReceipt(reinspection.receipt, "git.reinspectionReceipt");
      return { status: "succeeded", value: { generation: reinspection.generation, refs: resultRefs, updates: resultRefs.map((ref) => ({ remoteRef: ref.name, currentOid: ref.oid, kind: "fast-forward" as const, originOperationId: input.operationId, receipt: `provider=github-app; ref=${ref.name}; operation=${input.operationId}; state=projected; credentialMaterialStored=false` })), commits: [], originOperationId: input.operationId, receipt: `provider=github-app; operation=push; installation=${this.installation.installationId}; repository=${this.installation.repository}; git=${providerReceipt}; reinspection=${reinspectionReceipt}; expiresAt=${token.expiresAt}; credentialMaterialStored=false` } };
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
      const response = await this.options.fetchImpl(`${this.options.baseUrl}${path}`, { method: input.method, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${input.token}`, ...(input.body === undefined ? {} : { "content-type": "application/json" }) }, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
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
    const name = typeof author?.name === "string" ? author.name : "GitHub contributor";
    const email = typeof author?.email === "string" ? author.email : undefined;
    return { oid: input.oid, author: { name, ...(email ? { email } : {}) } };
  }

  async compare(input: { repository: string; baseOid: string; headOid: string; token: string }): Promise<{ status: "identical" | "ahead" | "behind" | "diverged"; receipt: string }> {
    const response = await this.http.request({ method: "GET", path: `/repos/${input.repository}/compare/${encodeURIComponent(input.baseOid)}...${encodeURIComponent(input.headOid)}`, token: input.token });
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

  constructor(input: { sourceDirectory: string; maxBufferBytes: number; sizingReceipt: string }) {
    this.sourceDirectory = required(input.sourceDirectory, "sourceDirectory");
    if (!Number.isSafeInteger(input.maxBufferBytes) || input.maxBufferBytes < 1) throw new GitHubAppAdapterError({ errorCode: "github_app.git_buffer_invalid", message: "Git command output budget must be a positive measured value.", retryable: false, recoveryAction: "configure the observed Git output budget with its sizing receipt", receipt: "git.maxBuffer=invalid; transition=not-applied" });
    this.maxBufferBytes = input.maxBufferBytes;
    this.sizingReceipt = safeReceipt(input.sizingReceipt, "git.sizingReceipt");
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
    try {
      result = await execFile("git", ["ls-remote", "--refs", input.repositoryUrl, ...input.refs], { cwd: this.sourceDirectory, env: this.authEnv(input.token), maxBuffer: this.maxBufferBytes });
    } catch (error) {
      throw gitTransportFailure(error, "inspect");
    }
    const refs = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => { const [oid, name] = line.split(/\s+/); return oid && name ? { oid, name } : undefined; }).filter((ref): ref is GitRef => ref !== undefined);
    return { generation: digest(refs), refs, receipt: `provider=github; transport=git-smart-http; refs=${refs.length}; previousGeneration=${input.knownGeneration}; credentialMaterialStored=false` };
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
