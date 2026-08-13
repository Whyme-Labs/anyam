import { createHash, createHmac } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  GitHubAppInstallationTokenIssuer,
  GitHubAppProjectionAdapter,
  cleanupGitHubAppDisposable,
  FetchGitHubAppHttpClient,
  FetchGitHubRestClient,
  NodeGitSmartHttpTransport,
  type GitHubAppInstallation,
  type GitHubReconciliationTask,
  type GitHubAppTokenIssuer,
  type GitHubPullRequestObservation,
} from "../src/portability/github-app.ts";
import { MirrorCoordinator, type MirrorChangeSink } from "../src/portability/mirror.ts";
import { CONTRACT_VERSIONS, type Change, type GitRef, type RepositoryMirror } from "../src/kernel/contracts.ts";

const protocol = "anyam.github-app-qualification/v1" as const;
const execFile = promisify(execFileCallback);
type Json = Record<string, unknown>;
type CleanupReceipt = { status: "succeeded" | "blocked" | "not-run"; receipt: string; recoveryAction?: string };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; set it in the same terminal that runs this qualification`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function positiveInteger(name: string): number {
  const raw = required(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer; received ${JSON.stringify(raw)}`);
  return value;
}

function commaSeparatedIntegers(name: string): number[] {
  const values = required(name).split(",").map((value) => Number(value.trim()));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error(`${name} must contain non-negative integer milliseconds`);
  return values;
}

function privateKey(): string {
  const file = optional("ANYAM_GITHUB_APP_PRIVATE_KEY_FILE");
  const value = file ? readFileSync(file, "utf8") : required("ANYAM_GITHUB_APP_PRIVATE_KEY");
  return value.replaceAll("\\n", "\n");
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

function refs(entries: readonly [string, string][]): GitRef[] {
  return entries.map(([name, oid]) => ({ name, oid }));
}

function runGit(directory: string, args: readonly string[], maxBufferBytes: number): Promise<string> {
  return execFile("git", [...args], { cwd: directory, maxBuffer: maxBufferBytes }).then(({ stdout }) => stdout.trim());
}

async function seedRepository(maxBufferBytes: number): Promise<{ directory: string; initialOid: string; secondOid: string; divergentOid: string; proposalBranch: string; proposalInitialOid: string; proposalSecondOid: string; bundlePath: string; bundleDigest: string }> {
  const directory = mkdtempSync(join(tmpdir(), "anyam-github-app-qualification-"));
  await runGit(directory, ["init", "-b", "main"], maxBufferBytes);
  await runGit(directory, ["config", "user.name", "Anyam GitHub App qualification"], maxBufferBytes);
  await runGit(directory, ["config", "user.email", "qualification@anyam.dev"], maxBufferBytes);
  writeFileSync(join(directory, "README.md"), "Anyam GitHub App qualification\n");
  await runGit(directory, ["add", "README.md"], maxBufferBytes);
  await runGit(directory, ["commit", "-m", "Seed public Source Space"], maxBufferBytes);
  const initialOid = await runGit(directory, ["rev-parse", "HEAD"], maxBufferBytes);
  const bundlePath = join(directory, "qualification-initial.bundle");
  await runGit(directory, ["bundle", "create", bundlePath, "refs/heads/main"], maxBufferBytes);
  await runGit(directory, ["bundle", "verify", bundlePath], maxBufferBytes);
  const bundleDigest = digest(readFileSync(bundlePath));

  const proposalBranch = "qualification-pr";
  await runGit(directory, ["checkout", "-b", proposalBranch], maxBufferBytes);
  writeFileSync(join(directory, "README.md"), "Anyam GitHub App qualification\nPull request initial revision\n");
  await runGit(directory, ["commit", "-am", "Create disposable pull request"], maxBufferBytes);
  const proposalInitialOid = await runGit(directory, ["rev-parse", "HEAD"], maxBufferBytes);
  writeFileSync(join(directory, "README.md"), "Anyam GitHub App qualification\nPull request successive revision\n");
  await runGit(directory, ["commit", "-am", "Advance disposable pull request"], maxBufferBytes);
  const proposalSecondOid = await runGit(directory, ["rev-parse", "HEAD"], maxBufferBytes);

  await runGit(directory, ["checkout", "main"], maxBufferBytes);
  writeFileSync(join(directory, "README.md"), "Anyam GitHub App qualification\nInbound proposal revision\n");
  await runGit(directory, ["commit", "-am", "Record inbound proposal revision"], maxBufferBytes);
  const secondOid = await runGit(directory, ["rev-parse", "HEAD"], maxBufferBytes);

  await runGit(directory, ["checkout", "--orphan", "divergent"], maxBufferBytes);
  writeFileSync(join(directory, "README.md"), "Anyam divergent qualification state\n");
  await runGit(directory, ["add", "README.md"], maxBufferBytes);
  await runGit(directory, ["commit", "-m", "Create explicit force-push divergence"], maxBufferBytes);
  const divergentOid = await runGit(directory, ["rev-parse", "HEAD"], maxBufferBytes);
  await runGit(directory, ["update-ref", "refs/heads/main", initialOid], maxBufferBytes);
  return { directory, initialOid, secondOid, divergentOid, proposalBranch, proposalInitialOid, proposalSecondOid, bundlePath, bundleDigest };
}

function mirror(input: { repository: string; initialGeneration: string; initialOid?: string }): RepositoryMirror {
  const initialRefs = input.initialOid ? refs([["refs/heads/main", input.initialOid]]) : [];
  return {
    protocol: CONTRACT_VERSIONS.mirror,
    id: "mirror:github-app-qualification",
    projectId: "project:github-app-qualification",
    sourceSpaceId: "source:github-app-qualification-public",
    provider: "github",
    remoteRepository: input.repository,
    direction: "bidirectional",
    refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
    disclosure: "public",
    state: "healthy",
    canonicalProjectRevisionId: "project-revision:github-app-qualification:initial",
    canonicalRefs: initialRefs,
    remoteGeneration: input.initialGeneration,
    remoteRefs: initialRefs,
    pendingInboundChangeIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    receipt: "qualification=github-app; sourceSpace=public; canonicalWrite=false",
  };
}

function changeSink(changes: Change[]): MirrorChangeSink {
  return {
    async createChange(input) {
      const change: Change = {
        protocol: CONTRACT_VERSIONS.change,
        id: `change:github-app-qualification:${input.remoteCommit.oid}`,
        projectId: input.projectId,
        intentId: input.intentId,
        baseProjectRevisionId: input.baseProjectRevisionId,
        status: "submitted",
        latestRevisionId: null,
        origin: { ...input.origin },
      };
      changes.push(change);
      return { status: "succeeded", value: change };
    },
  };
}

function signed(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function proposalRevision(observation: GitHubPullRequestObservation): { changeKey: string; revisionKey: string } {
  return {
    changeKey: digest([observation.repository, observation.number, observation.baseCommit]),
    revisionKey: digest([observation.repository, observation.number, observation.baseCommit, observation.headCommit]),
  };
}

async function waitForSecondProposalRevision(input: { adapter: GitHubAppProjectionAdapter; first: GitHubPullRequestObservation; number: number; waitMs: number; pollMs: number }): Promise<{ first: { changeKey: string; revisionKey: string }; second?: { changeKey: string; revisionKey: string }; attempts: number }> {
  const first = proposalRevision(input.first);
  const started = Date.now();
  let attempts = 1;
  while (Date.now() - started < input.waitMs) {
    await new Promise((resolve) => setTimeout(resolve, input.pollMs));
    attempts += 1;
    const next = await input.adapter.observePullRequest({ number: input.number });
    if (next.status === "succeeded" && next.value.headCommit !== input.first.headCommit) return { first, second: proposalRevision(next.value), attempts };
  }
  return { first, attempts };
}

async function main(): Promise<void> {
  const apiBaseUrl = optional("ANYAM_GITHUB_APP_API_BASE_URL") ?? "https://api.github.com";
  const appId = required("ANYAM_GITHUB_APP_ID");
  const installationId = required("ANYAM_GITHUB_APP_INSTALLATION_ID");
  const repository = required("ANYAM_GITHUB_APP_REPOSITORY");
  const repositoryUrl = optional("ANYAM_GITHUB_APP_REPOSITORY_URL") ?? `https://github.com/${repository}.git`;
  const webhookSecret = required("ANYAM_GITHUB_APP_WEBHOOK_SECRET");
  const qualificationId = required("ANYAM_GITHUB_APP_QUALIFICATION_ID");
  const disposableRepository = required("ANYAM_GITHUB_APP_DISPOSABLE_REPOSITORY");
  if (disposableRepository !== repository) throw new Error("ANYAM_GITHUB_APP_DISPOSABLE_REPOSITORY must exactly equal ANYAM_GITHUB_APP_REPOSITORY; cleanup target must be explicit");
  const jwtLifetimeSeconds = positiveInteger("ANYAM_GITHUB_APP_JWT_LIFETIME_SECONDS");
  const jwtSizingReceipt = required("ANYAM_GITHUB_APP_JWT_SIZING_RECEIPT");
  const clockSkewSeconds = positiveInteger("ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SECONDS");
  const clockSkewSizingReceipt = required("ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SIZING_RECEIPT");
  const gitMaxBufferBytes = positiveInteger("ANYAM_GITHUB_APP_GIT_MAX_BUFFER_BYTES");
  const gitSizingReceipt = required("ANYAM_GITHUB_APP_GIT_SIZING_RECEIPT");
  const retryDelaysMs = commaSeparatedIntegers("ANYAM_GITHUB_APP_RETRY_DELAYS_MS");
  const retrySizingReceipt = required("ANYAM_GITHUB_APP_RETRY_SIZING_RECEIPT");
  const queueMaxPending = positiveInteger("ANYAM_GITHUB_APP_QUEUE_MAX_PENDING");
  const queueSizingReceipt = required("ANYAM_GITHUB_APP_QUEUE_SIZING_RECEIPT");
  const proposalWaitMs = positiveInteger("ANYAM_GITHUB_APP_PR_REVISION_WAIT_MS");
  const proposalPollMs = positiveInteger("ANYAM_GITHUB_APP_PR_REVISION_POLL_MS");
  if (proposalPollMs > proposalWaitMs) throw new Error("ANYAM_GITHUB_APP_PR_REVISION_POLL_MS must not exceed ANYAM_GITHUB_APP_PR_REVISION_WAIT_MS");

  const seeded = await seedRepository(gitMaxBufferBytes);
  let cleanup: CleanupReceipt | undefined;
  let adapter: GitHubAppProjectionAdapter | undefined;
  const deliveryRecords = new Map<string, { task: GitHubReconciliationTask; processed: boolean }>();
  const deliveryLedger = {
    recordIfAbsent: (task: GitHubReconciliationTask) => { const existing = deliveryRecords.get(task.deliveryId); if (existing) return JSON.stringify(existing.task) === JSON.stringify(task) ? "duplicate" as const : "conflict" as const; deliveryRecords.set(task.deliveryId, { task, processed: false }); return "accepted" as const; },
    listPending: (): readonly GitHubReconciliationTask[] => [...deliveryRecords.values()].filter((entry) => !entry.processed).map((entry) => entry.task),
    markProcessed: (deliveryId: string) => { const entry = deliveryRecords.get(deliveryId); if (entry) entry.processed = true; },
  };
  const installation: GitHubAppInstallation = {
    installationId,
    repository,
    repositoryUrl,
    disposableQualificationId: qualificationId,
    selectedRepository: true,
    permissions: { contents: "write", metadata: "read", pullRequests: "write", administration: "write" },
    events: ["push", "pull_request"],
  };
  let http: FetchGitHubAppHttpClient | undefined;
  let issuer: GitHubAppInstallationTokenIssuer | undefined;
  let api: FetchGitHubRestClient | undefined;
  try {
    http = new FetchGitHubAppHttpClient({ baseUrl: apiBaseUrl, retry: { delaysMs: retryDelaysMs, sizingReceipt: retrySizingReceipt } });
    issuer = new GitHubAppInstallationTokenIssuer({ http, appId, privateKey: privateKey(), jwtLifetimeSeconds, clockSkewSeconds, sizingReceipt: jwtSizingReceipt, clockSkewSizingReceipt });
    api = new FetchGitHubRestClient(http);
    adapter = new GitHubAppProjectionAdapter({ installation, issuer, git: new NodeGitSmartHttpTransport({ sourceDirectory: seeded.directory, maxBufferBytes: gitMaxBufferBytes, sizingReceipt: gitSizingReceipt }), api, queue: { maxPending: queueMaxPending, sizingReceipt: queueSizingReceipt, deliveryLedger } });
    const emptyMirror = mirror({ repository, initialGeneration: "qualification:empty" });
    const initialInspection = await adapter.inspect({ mirror: emptyMirror, knownRefs: [], knownGeneration: "qualification:empty" });
    if (initialInspection.status !== "succeeded") throw new Error(`initial GitHub ref inspection failed: ${initialInspection.errorCode}; ${initialInspection.recoveryAction}`);
    if (initialInspection.value.refs.length !== 0) throw new Error(`disposable repository is not empty; observed ${initialInspection.value.refs.length} mapped refs`);

    const changes: Change[] = [];
    const service = new MirrorCoordinator({ mirror: emptyMirror, remote: adapter, changeSink: changeSink(changes), sourceSpaceClassification: "public" });
    const actor = { principalId: "principal:github-app-qualification", actorId: "actor:github-app-qualification", sessionId: "session:github-app-qualification", clientId: "client:github-app-qualification" };
    const outbound = await service.sync({ canonical: { projectRevisionId: "project-revision:github-app-qualification:one", sourceSpaceId: emptyMirror.sourceSpaceId, sourceSpaceClassification: "public", disclosure: "public", verified: true, verificationReceipt: "qualification=source-verified", refs: refs([["refs/heads/main", seeded.initialOid]]) }, idempotencyKey: "qualification:outbound", actor });
    if (outbound.status !== "succeeded") throw new Error(`outbound projection failed: ${outbound.errorCode}; ${outbound.recoveryAction}`);

    const setupToken = await issuer.issue({ installationId, repository, permissions: ["contents:write", "metadata:read", "pull_requests:write"] });
    if (!setupToken.token.trim() || !Number.isFinite(Date.parse(setupToken.expiresAt)) || Date.parse(setupToken.expiresAt) <= Date.now()) throw new Error("GitHub App qualification setup credential was missing or expired");
    const setupGit = new NodeGitSmartHttpTransport({ sourceDirectory: seeded.directory, maxBufferBytes: gitMaxBufferBytes, sizingReceipt: gitSizingReceipt });
    await runGit(seeded.directory, ["update-ref", `refs/heads/${seeded.proposalBranch}`, seeded.proposalInitialOid], gitMaxBufferBytes);
    const proposalBranchPush = await setupGit.push({ repositoryUrl, token: setupToken.token, expectedRefs: [], desiredRefs: [{ name: `refs/heads/${seeded.proposalBranch}`, oid: seeded.proposalInitialOid }], refMappings: [{ localRef: `refs/heads/${seeded.proposalBranch}`, remoteRef: `refs/heads/${seeded.proposalBranch}` }], operationId: "github:qualification:pr-branch", idempotencyKey: "github:qualification:pr-branch" });
    const pullRequest = await api.createPullRequest({ repository, head: seeded.proposalBranch, base: "main", title: "Anyam disposable projection qualification", token: setupToken.token });
    const pullRequestNumber = pullRequest.number;

    await runGit(seeded.directory, ["update-ref", "refs/heads/main", seeded.secondOid], gitMaxBufferBytes);
    const externalPush = await adapter.push({ mirror: service.repositoryMirror, expectedGeneration: service.repositoryMirror.remoteGeneration, expectedRefs: refs([["refs/heads/main", seeded.initialOid]]), desiredRefs: refs([["refs/heads/main", seeded.secondOid]]), operationId: "github:qualification:external-push", idempotencyKey: "github:qualification:external-push" });
    if (externalPush.status !== "succeeded") throw new Error(`inbound push seed failed: ${externalPush.errorCode}; ${externalPush.recoveryAction}`);
    const inbound = await service.sync({ canonical: { projectRevisionId: "project-revision:github-app-qualification:one", sourceSpaceId: emptyMirror.sourceSpaceId, sourceSpaceClassification: "public", disclosure: "public", verified: true, verificationReceipt: "qualification=source-verified", refs: refs([["refs/heads/main", seeded.initialOid]]) }, idempotencyKey: "qualification:inbound", actor });
    if (inbound.status !== "succeeded" || inbound.value.inboundChanges.length !== 1) throw new Error(`inbound push did not become one pending Change; state=${inbound.status}`);

    // Move only the disposable qualification worktree's local main ref to the
    // orphaned commit before the CAS force-push. The adapter still enforces the
    // remote expected OID; this makes the provider perform the real rewrite.
    await runGit(seeded.directory, ["update-ref", "refs/heads/main", seeded.divergentOid], gitMaxBufferBytes);
    const forcePush = await adapter.push({ mirror: service.repositoryMirror, expectedGeneration: externalPush.value.generation, expectedRefs: refs([["refs/heads/main", seeded.secondOid]]), desiredRefs: refs([["refs/heads/main", seeded.divergentOid]]), operationId: "github:qualification:force-push", idempotencyKey: "github:qualification:force-push" });
    if (forcePush.status !== "succeeded") throw new Error(`force-push seed failed: ${forcePush.errorCode}; ${forcePush.recoveryAction}`);
    const forceInspection = await adapter.inspect({ mirror: service.repositoryMirror, knownRefs: refs([["refs/heads/main", seeded.secondOid]]), knownGeneration: forcePush.value.generation });
    if (forceInspection.status !== "succeeded" || forceInspection.value.updates[0]?.kind !== "force-push") throw new Error(`force-push was not classified explicitly; state=${forceInspection.status}`);
    const blockedReconciliation = await service.sync({ canonical: { projectRevisionId: "project-revision:github-app-qualification:one", sourceSpaceId: emptyMirror.sourceSpaceId, sourceSpaceClassification: "public", disclosure: "public", verified: true, verificationReceipt: "qualification=source-verified", refs: refs([["refs/heads/main", seeded.initialOid]]) }, idempotencyKey: "qualification:force-push-blocked", actor });
    if (blockedReconciliation.status !== "failed" || blockedReconciliation.errorCode !== "mirror.force_push_detected") throw new Error(`force-push did not require explicit reconciliation: state=${blockedReconciliation.status}`);
    await runGit(seeded.directory, ["update-ref", "refs/heads/main", seeded.initialOid], gitMaxBufferBytes);
    const reconciled = await service.sync({ canonical: { projectRevisionId: "project-revision:github-app-qualification:one", sourceSpaceId: emptyMirror.sourceSpaceId, sourceSpaceClassification: "public", disclosure: "public", verified: true, verificationReceipt: "qualification=source-verified", refs: refs([["refs/heads/main", seeded.initialOid]]) }, idempotencyKey: "qualification:force-push-canonical-wins", reconciliation: "canonical-wins", resumeCheckpointId: blockedReconciliation.checkpoint.id, actor });
    if (reconciled.status !== "succeeded" || reconciled.value.mirror.state !== "healthy") throw new Error(`explicit canonical-wins reconciliation did not restore a healthy Mirror: state=${reconciled.status}`);

    class ResumeIssuer implements GitHubAppTokenIssuer {
      calls = 0;
      constructor(private readonly delegate: GitHubAppTokenIssuer) {}
      async issue(input: Parameters<GitHubAppTokenIssuer["issue"]>[0]): Promise<{ token: string; expiresAt: string }> {
        this.calls += 1;
        const issued = await this.delegate.issue(input);
        return this.calls === 2 ? { ...issued, expiresAt: "2000-01-01T00:00:00.000Z" } : issued;
      }
    }
    const resumeIssuer = new ResumeIssuer(issuer);
    const resumeAdapter = new GitHubAppProjectionAdapter({ installation, issuer: resumeIssuer, git: new NodeGitSmartHttpTransport({ sourceDirectory: seeded.directory, maxBufferBytes: gitMaxBufferBytes, sizingReceipt: gitSizingReceipt }), api, queue: { maxPending: queueMaxPending, sizingReceipt: queueSizingReceipt, deliveryLedger } });
    const resumedFirst = await resumeAdapter.inspect({ mirror: service.repositoryMirror, knownRefs: refs([["refs/heads/main", seeded.divergentOid]]), knownGeneration: forcePush.value.generation });
    if (resumedFirst.status !== "succeeded") throw new Error(`credential resume first inspection failed: ${resumedFirst.errorCode}`);
    const resumedExpired = await resumeAdapter.inspect({ mirror: service.repositoryMirror, knownRefs: refs([["refs/heads/main", seeded.divergentOid]]), knownGeneration: forcePush.value.generation });
    if (resumedExpired.status !== "failed" || resumedExpired.errorCode !== "github_app.credential_expired") throw new Error("expired JIT credential was not rejected");
    const resumed = await resumeAdapter.inspect({ mirror: service.repositoryMirror, knownRefs: refs([["refs/heads/main", seeded.divergentOid]]), knownGeneration: forcePush.value.generation });
    if (resumed.status !== "succeeded") throw new Error("credential expiry did not resume with a fresh installation credential");

    const webhookBody = JSON.stringify({ ref: "refs/heads/main", before: seeded.secondOid, after: seeded.divergentOid, forced: true, deleted: false, repository: { full_name: repository }, installation: { id: installationId } });
    const webhook = resumeAdapter.acceptWebhook({ body: webhookBody, event: "push", deliveryId: "delivery:github-app:one", signature: signed(webhookBody, webhookSecret), secret: webhookSecret, mirrorId: service.repositoryMirror.id, mappedRemoteRefs: ["refs/heads/main"] });
    const duplicate = resumeAdapter.acceptWebhook({ body: webhookBody, event: "push", deliveryId: "delivery:github-app:one", signature: signed(webhookBody, webhookSecret), secret: webhookSecret, mirrorId: service.repositoryMirror.id, mappedRemoteRefs: ["refs/heads/main"] });
    if (webhook.status !== "accepted" || duplicate.status !== "duplicate") throw new Error(`webhook dedupe failed: first=${webhook.status}; duplicate=${duplicate.status}`);
    const drained = await resumeAdapter.drainReconciliation({ limit: 1, reinspect: async (task) => ({ status: "succeeded", receipt: `qualification=reinspected; delivery=${task.deliveryId}; remoteState=authoritative; credentialMaterialStored=false` }) });
    if (drained.status !== "succeeded") throw new Error(`webhook reconciliation did not drain: ${drained.recoveryAction ?? drained.receipt}`);

    const observedPr = await adapter.observePullRequest({ number: pullRequestNumber });
    if (observedPr.status !== "succeeded") throw new Error(`pull-request observation failed: ${observedPr.errorCode}; ${observedPr.recoveryAction}`);
    const proposal = adapter.externalProposal(observedPr.value, { projectViewId: "project-view:github-app-qualification-public", baseProjectRevisionId: "project-revision:github-app-qualification:one", disclosure: "public", deliveryId: "delivery:github-app:pr", sourceSpaceSnapshots: { [emptyMirror.sourceSpaceId]: observedPr.value.headCommit } });
    if (proposal.proposalKey !== String(pullRequestNumber) || proposal.remoteRepository !== repository || JSON.stringify(proposal).includes("title")) throw new Error("pull-request proposal was not stable and metadata-minimal");
    await runGit(seeded.directory, ["update-ref", `refs/heads/${seeded.proposalBranch}`, seeded.proposalSecondOid], gitMaxBufferBytes);
    const proposalRevisionPush = await setupGit.push({ repositoryUrl, token: setupToken.token, expectedRefs: refs([[`refs/heads/${seeded.proposalBranch}`, seeded.proposalInitialOid]]), desiredRefs: [{ name: `refs/heads/${seeded.proposalBranch}`, oid: seeded.proposalSecondOid }], refMappings: [{ localRef: `refs/heads/${seeded.proposalBranch}`, remoteRef: `refs/heads/${seeded.proposalBranch}` }], operationId: "github:qualification:pr-revision", idempotencyKey: "github:qualification:pr-revision" });
    const secondProposal = await waitForSecondProposalRevision({ adapter, first: observedPr.value, number: pullRequestNumber, waitMs: proposalWaitMs, pollMs: proposalPollMs });
    if (!secondProposal.second) throw new Error(`pull-request ${pullRequestNumber} did not publish a successive head revision within the measured wait window; attempts=${secondProposal.attempts}; waitMs=${proposalWaitMs}; pollMs=${proposalPollMs}`);
    if (secondProposal.first.changeKey !== secondProposal.second.changeKey || secondProposal.first.revisionKey === secondProposal.second.revisionKey) throw new Error("pull-request revisions did not preserve stable Change identity while advancing the Revision");

    const restoredDirectory = mkdtempSync(join(tmpdir(), "anyam-github-app-restore-"));
    try {
      await runGit(restoredDirectory, ["init"], gitMaxBufferBytes);
      await runGit(restoredDirectory, ["fetch", `file://${seeded.bundlePath}`, "refs/heads/main:refs/heads/main"], gitMaxBufferBytes);
      const restoredOid = await runGit(restoredDirectory, ["rev-parse", "refs/heads/main"], gitMaxBufferBytes);
      if (restoredOid !== seeded.initialOid) throw new Error(`export/restore returned ${restoredOid}, expected ${seeded.initialOid}`);
    } finally {
      rmSync(restoredDirectory, { recursive: true, force: true });
    }

    cleanup = await cleanupGitHubAppDisposable({ installation, issuer, api, repositoryPrefix: repository, qualificationId, disposableRepository });
    if (cleanup.status !== "succeeded") throw new Error(`provider cleanup failed: ${cleanup.recoveryAction ?? cleanup.receipt}`);
    console.log(JSON.stringify({ protocol, status: "succeeded", qualificationScope: "provider-adapter-only", acceptance: "partial; customer Realm/Authority qualification remains required", qualificationId, repository, mappedRef: "refs/heads/main", outbound: "projected", inbound: { changeCount: changes.length }, forcePush: "classified", credentialExpiry: "rejected-and-resumed", webhook: "signed-deduplicated-and-reconciled", pullRequestSetup: { branch: seeded.proposalBranch, created: true, branchPush: proposalBranchPush.receipt, successiveRevisionPush: proposalRevisionPush.receipt }, pullRequestObservation: { proposalKey: String(pullRequestNumber), stableObservationIdentity: true, successiveHeadObserved: true, authorityChangeLedger: "not-run" }, gitBundleExportRestore: { bundleDigest: seeded.bundleDigest, restored: true, authorityExportRestore: "not-run" }, credentialValues: "not-printed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true, cleanup }, null, 2));
  } catch (error) {
    if (!cleanup) {
      try {
        const cleanupHttp = http ?? new FetchGitHubAppHttpClient({ baseUrl: apiBaseUrl, retry: { delaysMs: retryDelaysMs, sizingReceipt: retrySizingReceipt } });
        const cleanupIssuer = issuer ?? new GitHubAppInstallationTokenIssuer({ http: cleanupHttp, appId, privateKey: privateKey(), jwtLifetimeSeconds, clockSkewSeconds, sizingReceipt: jwtSizingReceipt, clockSkewSizingReceipt });
        const cleanupApi = api ?? new FetchGitHubRestClient(cleanupHttp);
        cleanup = await cleanupGitHubAppDisposable({ installation, issuer: cleanupIssuer, api: cleanupApi, repositoryPrefix: repository, qualificationId, disposableRepository });
      } catch (cleanupError) {
        cleanup = { status: "blocked", receipt: `cleanup=blocked; repository=${repository}; exception=${cleanupError instanceof Error ? cleanupError.name : "unknown"}; credentialMaterialStored=false`, recoveryAction: "restore the GitHub App credential authority, then retry exact disposable-repository cleanup" };
      }
    }
    throw new Error(`${error instanceof Error ? error.message : "GitHub App qualification failed"}; cleanup=${cleanup?.receipt ?? "cleanup=not-run; adapter-not-qualified"}`);
  } finally {
    rmSync(seeded.directory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? error.message : "GitHub App qualification failed", credentialValues: "not-printed", canonicalWrite: false, recoveryAction: "inspect the named GitHub App operation, retain the same disposable repository, and retry only after reconciling provider state" }, null, 2));
  process.exitCode = 2;
}
