import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  GITHUB_APP_ADAPTER_PROTOCOL,
  GitHubAppProjectionAdapter,
  GitHubMirrorProducer,
  createGitHubMirrorIngestionHttpTransport,
  cleanupGitHubAppDisposable,
  GitHubAppAdapterError,
  type GitHubAppInstallation,
  type GitHubReconciliationTask,
  type GitHubAppTokenIssuer,
  type GitHubCommitObservation,
  type GitHubPullRequestObservation,
  type GitHubRestClient,
  type GitHubSmartHttpRefs,
  type GitHubSmartHttpTransport,
  FetchGitHubAppHttpClient,
  FetchGitHubRestClient,
  gitInstallationAuthorizationHeader,
  gitPushArguments,
  gitTransportFailure,
} from "../src/portability/github-app.ts";
import { AUTHORITY_COMMAND_PROTOCOL, AuthorityPlaneCoordinator, emptyAuthorityPlaneSnapshot, type AuthorityCommand, type AuthoritySession } from "../src/cloudflare/authority-plane.ts";
import { verifyMirrorIngestionHandoff } from "../src/portability/mirror-observation.ts";
import type { GitRef, RepositoryMirror } from "../src/kernel/contracts.ts";

const installation: GitHubAppInstallation = {
  installationId: "installation:github-app",
  repository: "acme/video-player",
  repositoryUrl: "https://github.com/acme/video-player.git",
  disposableQualificationId: "qualification-1",
  selectedRepository: true,
  permissions: { contents: "write", metadata: "read", pullRequests: "read", administration: "write" },
  events: ["push", "pull_request"],
};

const refs = (entries: readonly [string, string][]): GitRef[] => entries.map(([name, oid]) => ({ name, oid }));

const PRODUCER_COMMIT_ONE = "1111111111111111111111111111111111111111";
const PRODUCER_COMMIT_TWO = "2222222222222222222222222222222222222222";
const PRODUCER_COMMIT_REWRITTEN = "4444444444444444444444444444444444444444";
const PRODUCER_TREE_TWO = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function fixtureDeliveryLedger() {
  return { recordIfAbsent: (_task: GitHubReconciliationTask) => "accepted" as const, listPending: (): readonly GitHubReconciliationTask[] => [], markProcessed: (_deliveryId: string) => undefined };
}

test("Git Smart HTTP binds an installation token as x-access-token Basic auth", () => {
  assert.equal(gitInstallationAuthorizationHeader("ghs_test-token"), "Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3Rlc3QtdG9rZW4=");
  assert.doesNotMatch(gitInstallationAuthorizationHeader("ghs_test-token"), /Bearer/u);
});

test("Git Smart HTTP transport failures expose a redacted diagnostic receipt", () => {
  const failure = gitTransportFailure({ code: 128, stderr: "remote: atomic push failed: permission denied\n" }, "push");
  assert.equal(failure.errorCode, "github_app.git_transport");
  assert.match(failure.receipt, /operation=push/u);
  assert.match(failure.receipt, /stderrClass=permission/u);
  assert.match(failure.receipt, /stderrDigest=sha256:/u);
  assert.doesNotMatch(failure.receipt, /permission denied/u);
});

test("Git Smart HTTP push places the repository before refspecs", () => {
  assert.deepEqual(gitPushArguments({ repositoryUrl: "https://github.com/acme/video-player.git", expectedRefs: [], refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }] }), ["push", "--atomic", "--force-with-lease=refs/heads/main:", "https://github.com/acme/video-player.git", "refs/heads/main:refs/heads/main"]);
});

class FakeTokenIssuer implements GitHubAppTokenIssuer {
  readonly calls: Array<{ installationId: string; repository: string; permissions: readonly string[] }> = [];
  expiresAt = "2099-01-01T00:00:00.000Z";

  async issue(input: Parameters<GitHubAppTokenIssuer["issue"]>[0]): Promise<{ token: string; expiresAt: string }> {
    this.calls.push({ installationId: input.installationId, repository: input.repository, permissions: [...input.permissions] });
    return { token: "installation-token-must-not-be-persisted", expiresAt: this.expiresAt };
  }
}

class FakeGit implements GitHubSmartHttpTransport {
  refs: GitHubSmartHttpRefs = {
    generation: "remote:g2",
    refs: refs([["refs/heads/main", "commit:two"]]),
    receipt: "git-smart-http=inspected; provider=github",
  };
  readonly pushCalls: Array<{ token: string; expectedRefs: readonly GitRef[]; desiredRefs: readonly GitRef[] }> = [];

  async inspect(): Promise<GitHubSmartHttpRefs> {
    return { ...this.refs, refs: this.refs.refs.map((ref) => ({ ...ref })) };
  }

  async push(input: Parameters<GitHubSmartHttpTransport["push"]>[0]): Promise<GitHubSmartHttpRefs> {
    this.pushCalls.push({ token: input.token, expectedRefs: input.expectedRefs, desiredRefs: input.desiredRefs });
    this.refs = {
      generation: "remote:g3",
      refs: input.desiredRefs.map((ref) => ({ ...ref })),
      originOperationId: input.operationId,
      receipt: "git-smart-http=pushed; provider=github; cas=verified",
    };
    return this.refs;
  }
}

class FakeApi implements GitHubRestClient {
  readonly commits: GitHubCommitObservation = { oid: "commit:two", treeOid: "tree:two", author: { name: "Contributor", email: "contributor@example.test" } };
  readonly pullRequest: GitHubPullRequestObservation = {
    number: 42,
    repository: "acme/video-player",
    state: "open",
    merged: false,
    headRef: "feature/recovery",
    headCommit: "commit:two",
    baseRef: "main",
    baseCommit: "commit:one",
  };
  compareStatus: "identical" | "ahead" | "behind" | "diverged" = "ahead";
  compareError?: Error;
  deleted: string[] = [];

  async getCommit(): Promise<GitHubCommitObservation> {
    return this.commits;
  }

  async compare(): Promise<{ status: "identical" | "ahead" | "behind" | "diverged"; receipt: string }> {
    if (this.compareError) throw this.compareError;
    return { status: this.compareStatus, receipt: "github-rest=compare; providerReceipt=redacted" };
  }

  async getPullRequest(): Promise<GitHubPullRequestObservation> {
    return this.pullRequest;
  }

  async createPullRequest(): Promise<{ number: number; receipt: string }> {
    return { number: this.pullRequest.number, receipt: "github-rest=create-pull-request; providerReceipt=redacted" };
  }

  async deleteRepository(input: { repository: string; token: string }): Promise<{ receipt: string }> {
    this.deleted.push(input.repository);
    return { receipt: "github-rest=delete-repository; providerReceipt=redacted" };
  }
}

function adapter(input: { git?: FakeGit; api?: FakeApi; issuer?: FakeTokenIssuer } = {}) {
  const issuer = input.issuer ?? new FakeTokenIssuer();
  const git = input.git ?? new FakeGit();
  const api = input.api ?? new FakeApi();
  const value = new GitHubAppProjectionAdapter({ installation, issuer, git, api, queue: { maxPending: 2, sizingReceipt: "fixture=queue-capacity-measured", deliveryLedger: fixtureDeliveryLedger() } });
  return { value, issuer, git, api };
}

function producerMirror(overrides: Partial<RepositoryMirror> = {}): RepositoryMirror {
  return {
    protocol: "anyam.mirror/v1",
    id: "mirror:github-producer",
    projectId: "project:producer",
    sourceSpaceId: "source:producer",
    provider: "github",
    remoteRepository: "acme/video-player",
    direction: "bidirectional",
    canonicalAuthority: "anyam",
    refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
    disclosure: "public",
    state: "healthy",
    canonicalProjectRevisionId: "project-revision:producer:one",
    canonicalRefs: refs([["refs/heads/main", PRODUCER_COMMIT_ONE]]),
    remoteGeneration: "remote:g1",
    remoteRefs: refs([["refs/heads/main", PRODUCER_COMMIT_ONE]]),
    pendingInboundChangeIds: [],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    receipt: "fixture=producer-mirror; credentialFree=true",
    ...overrides,
  };
}

function producerAdapter() {
  const git = new FakeGit();
  git.refs = { generation: "remote:g2", refs: refs([["refs/heads/main", PRODUCER_COMMIT_TWO]]), receipt: "git-smart-http=inspected; provider=github" };
  const api = new FakeApi();
  api.commits.oid = PRODUCER_COMMIT_TWO;
  api.commits.treeOid = PRODUCER_TREE_TWO;
  api.pullRequest.headCommit = PRODUCER_COMMIT_TWO;
  api.pullRequest.baseCommit = PRODUCER_COMMIT_ONE;
  return { ...adapter({ git, api }), git, api };
}

function signed(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("GitHub App adapter uses selected-installation credentials for Smart HTTP refs and REST provenance", async () => {
  const { value, issuer } = adapter();
  const result = await value.inspect({
    mirror: {
      protocol: "anyam.mirror/v1",
      id: "mirror:github",
      projectId: "project:video-player",
      sourceSpaceId: "source:community",
      provider: "github",
      remoteRepository: "acme/video-player",
      direction: "bidirectional",
      canonicalAuthority: "anyam",
      refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
      disclosure: "public",
      state: "healthy",
      canonicalProjectRevisionId: "project-revision:one",
      canonicalRefs: refs([["refs/heads/main", "commit:one"]]),
      remoteGeneration: "remote:g1",
      remoteRefs: refs([["refs/heads/main", "commit:one"]]),
      pendingInboundChangeIds: [],
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      receipt: "fixture=mirror; credentialFree=true",
    },
    knownRefs: refs([["refs/heads/main", "commit:one"]]),
    knownGeneration: "remote:g1",
  });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.deepEqual(result.value.updates.map((update) => update.kind), ["fast-forward"]);
  assert.equal(result.value.commits[0]?.oid, "commit:two");
  assert.equal(result.value.commits[0]?.author.name, "Contributor");
  assert.equal(result.value.receipt.includes("installation-token-must-not"), false);
  assert.equal(issuer.calls[0]?.repository, "acme/video-player");
  assert.deepEqual(issuer.calls[0]?.permissions, ["contents:read", "metadata:read", "pull_requests:read"]);
});

test("GitHub App classifies a compare 404 after a rewrite as force-push", async () => {
  const api = new FakeApi();
  api.compareError = new GitHubAppAdapterError({ errorCode: "github_app.http_404", message: "compare missing", retryable: false, recoveryAction: "reconcile", receipt: "provider=github; compare=404; credentialMaterialStored=false" });
  const git = new FakeGit();
  git.refs = { generation: "remote:rewritten", refs: refs([["refs/heads/main", "commit:rewritten"]]), receipt: "git-smart-http=rewritten; provider=github" };
  const { value } = adapter({ api, git });
  const result = await value.inspect({
    mirror: { protocol: "anyam.mirror/v1", id: "mirror:github-rewrite", projectId: "project:video-player", sourceSpaceId: "source:community", provider: "github", remoteRepository: "acme/video-player", direction: "bidirectional", canonicalAuthority: "anyam", refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }], disclosure: "public", state: "healthy", canonicalProjectRevisionId: "project-revision:one", canonicalRefs: refs([["refs/heads/main", "commit:one"]]), remoteGeneration: "remote:old", remoteRefs: refs([["refs/heads/main", "commit:one"]]), pendingInboundChangeIds: [], createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", receipt: "fixture=mirror; credentialFree=true" },
    knownRefs: refs([["refs/heads/main", "commit:one"]]),
    knownGeneration: "remote:old",
  });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.value.updates[0]?.kind, "force-push");
  assert.match(result.value.updates[0]?.receipt ?? "", /comparison=not-found; classification=force-push/u);
});

test("GitHub App adapter projects canonical refs through Smart HTTP CAS and rejects expired JIT credentials", async () => {
  const { value, git, issuer } = adapter();
  const pushed = await value.push({
    mirror: {
      protocol: "anyam.mirror/v1",
      id: "mirror:github",
      projectId: "project:video-player",
      sourceSpaceId: "source:community",
      provider: "github",
      remoteRepository: "acme/video-player",
      direction: "bidirectional",
      canonicalAuthority: "anyam",
      refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
      disclosure: "public",
      state: "healthy",
      canonicalProjectRevisionId: "project-revision:two",
      canonicalRefs: refs([["refs/heads/main", "commit:two"]]),
      remoteGeneration: "remote:g1",
      remoteRefs: refs([["refs/heads/main", "commit:one"]]),
      pendingInboundChangeIds: [],
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      receipt: "fixture=mirror; credentialFree=true",
    },
    expectedGeneration: "remote:g1",
    expectedRefs: refs([["refs/heads/main", "commit:one"]]),
    desiredRefs: refs([["refs/heads/main", "commit:two"]]),
    operationId: "mirror-operation:outbound",
    idempotencyKey: "delivery:outbound",
  });
  assert.equal(pushed.status, "succeeded");
  assert.equal(git.pushCalls.length, 1);
  assert.equal(git.pushCalls[0]?.token, "installation-token-must-not-be-persisted");
  assert.equal(JSON.stringify(pushed).includes("installation-token-must-not"), false);

  issuer.expiresAt = "2000-01-01T00:00:00.000Z";
  const expired = await value.inspect({
    mirror: {
      protocol: "anyam.mirror/v1", id: "mirror:github", projectId: "project:video-player", sourceSpaceId: "source:community", provider: "github", remoteRepository: "acme/video-player", direction: "bidirectional", canonicalAuthority: "anyam", refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }], disclosure: "public", state: "healthy", canonicalProjectRevisionId: "project-revision:two", canonicalRefs: refs([["refs/heads/main", "commit:two"]]), remoteGeneration: "remote:g3", remoteRefs: refs([["refs/heads/main", "commit:two"]]), pendingInboundChangeIds: [], createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", receipt: "fixture=mirror; credentialFree=true",
    },
    knownRefs: refs([["refs/heads/main", "commit:two"]]),
    knownGeneration: "remote:g3",
  });
  assert.equal(expired.status, "failed");
  if (expired.status === "failed") assert.equal(expired.errorCode, "github_app.credential_expired");
});

test("GitHub App PR observation maps to an external proposal without copying private PR metadata", async () => {
  const { value } = adapter();
  const observation = await value.observePullRequest({ number: 42 });
  assert.equal(observation.status, "succeeded");
  if (observation.status !== "succeeded") return;
  const proposal = value.externalProposal(observation.value, { projectViewId: "view:public", baseProjectRevisionId: "project-revision:one", disclosure: "public", deliveryId: "delivery:42", sourceSpaceSnapshots: { "source:community": "commit:two" } });
  assert.deepEqual(proposal, {
    provider: "github",
    installationId: "installation:github-app",
    sourceIdentity: "installation:github-app",
    remoteRepository: "acme/video-player",
    proposalKind: "pull-request",
    proposalKey: "42",
    remoteRef: "refs/pull/42/head",
    baseRef: "refs/heads/main",
    baseCommit: "commit:one",
    latestHeadCommit: "commit:two",
    baseProjectRevisionId: "project-revision:one",
    projectViewId: "view:public",
    disclosure: "public",
    sourceSpaceSnapshots: { "source:community": "commit:two" },
    status: "open",
    receipt: "provider=github-app; proposal=42; delivery=delivery:42; credentialFree=true",
  });
  assert.equal(JSON.stringify(proposal).includes("title"), false);
});

test("GitHub App qualification setup creates a PR through the bounded REST client", async () => {
  let request: { url: string; method: string | undefined; body: string } | undefined;
  const http = new FetchGitHubAppHttpClient({
    baseUrl: "https://api.github.com",
    retry: { delaysMs: [], sizingReceipt: "fixture=rest-setup-retry-measured" },
    fetchImpl: async (input, init) => {
      request = { url: String(input), method: init?.method, body: String(init?.body ?? "") };
      return new Response(JSON.stringify({ number: 73 }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  const client = new FetchGitHubRestClient(http);
  const created = await client.createPullRequest({ repository: "acme/video-player", head: "qualification-pr", base: "main", title: "Disposable qualification", token: "opaque-setup-token" });
  assert.equal(created.number, 73);
  assert.deepEqual(request, { url: "https://api.github.com/repos/acme/video-player/pulls", method: "POST", body: JSON.stringify({ head: "qualification-pr", base: "main", title: "Disposable qualification" }) });
  assert.equal(created.receipt.includes("opaque-setup-token"), false);
});

test("GitHub App external proposals enter Authority as one stable Change with successive Revisions", async () => {
  const { value, api } = adapter();
  const observed = await value.observePullRequest({ number: 42 });
  assert.equal(observed.status, "succeeded");
  if (observed.status !== "succeeded") return;

  const session: AuthoritySession = { realmId: "realm:github-app-fixture", principalId: "principal:owner", actorId: "actor:owner", sessionId: "session:owner", clientId: "anyam-mirror-fixture", authorizationEpoch: 1, kind: "mirror" };
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  const command = (name: "project.create" | "workspace.create" | "mirror.configure" | "mirror.sync", idempotencyKey: string, payload: Record<string, unknown>) => coordinator.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: name, idempotencyKey, payload }, session);
  assert.equal(command("project.create", "github-app:project", { projectId: "project:video-player", name: "Video Player", referenceType: "typescript", sourceSpaces: [{ id: "source:community", name: "Community", classification: "public", snapshotId: "commit:one" }], projectRevisionId: "project-revision:one" }).status, "succeeded");
  const workspace = command("workspace.create", "github-app:workspace", { projectId: "project:video-player", projectRevisionId: "project-revision:one", workspaceId: "workspace:public", sourceSpaceIds: ["source:community"], projectionId: "projection:public", classification: "public" });
  assert.equal(workspace.status, "succeeded");
  if (workspace.status !== "succeeded") return;
  const projectViewId = String(workspace.value.view && (workspace.value.view as { id: string }).id);
  assert.equal(command("mirror.configure", "github-app:mirror", { mirrorId: "mirror:github", projectId: "project:video-player", sourceSpaceId: "source:community", provider: "github", remoteRepository: "acme/video-player", refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }], disclosure: "public", canonicalProjectRevisionId: "project-revision:one", canonicalRefs: [{ name: "refs/heads/main", oid: "commit:one" }], remoteGeneration: "remote:g0", remoteRefs: [{ name: "refs/heads/main", oid: "commit:one" }], receipt: "fixture=github-app-authority; credentialFree=true" }).status, "succeeded");

  const firstProposal = value.externalProposal(observed.value, { projectViewId, baseProjectRevisionId: "project-revision:one", disclosure: "public", deliveryId: "delivery:pr-opened", sourceSpaceSnapshots: { "source:community": observed.value.headCommit } });
  const sync = (head: string, deliveryId: string, operationId: string, checkpointId: string, proposal: Record<string, unknown>) => command("mirror.sync", deliveryId, { mirrorId: "mirror:github", canonicalProjectRevisionId: "project-revision:one", canonicalRefs: [{ name: "refs/heads/main", oid: "commit:one" }], expectedRemoteGeneration: head === "commit:two" ? "remote:g0" : "remote:g1", remoteGeneration: head === "commit:two" ? "remote:g1" : "remote:g2", remoteRefs: [{ name: "refs/heads/main", oid: head }], operationId, checkpointId, operationState: "succeeded", mirrorState: "healthy", receipt: `fixture=github-app-observation; head=${head}; credentialFree=true`, delivery: { provider: "github", installationId: "installation:github-app", sourceIdentity: "installation:github-app", remoteRepository: "acme/video-player", deliveryId, eventType: "pull_request.synchronize", proposalKey: "42" }, externalProposal: proposal });
  const first = sync("commit:two", "delivery:pr-opened", "mirror-operation:pr-one", "mirror-checkpoint:pr-one", firstProposal);
  assert.equal(first.status, "succeeded");
  assert.equal(Object.keys(coordinator.snapshot().changes).length, 1);
  assert.equal(Object.keys(coordinator.snapshot().changeRevisions).length, 1);

  api.pullRequest.headCommit = "commit:three";
  const secondObserved = await value.observePullRequest({ number: 42 });
  assert.equal(secondObserved.status, "succeeded");
  if (secondObserved.status !== "succeeded") return;
  const secondProposal = value.externalProposal(secondObserved.value, { projectViewId, baseProjectRevisionId: "project-revision:one", disclosure: "public", deliveryId: "delivery:pr-sync", sourceSpaceSnapshots: { "source:community": secondObserved.value.headCommit } });
  const second = sync("commit:three", "delivery:pr-sync", "mirror-operation:pr-two", "mirror-checkpoint:pr-two", secondProposal);
  assert.equal(second.status, "succeeded");
  const restored = new AuthorityPlaneCoordinator(coordinator.snapshot()).snapshot();
  assert.equal(Object.keys(restored.changes).length, 1);
  assert.equal(Object.keys(restored.changeRevisions).length, 2);
  const proposal = Object.values(restored.externalProposals)[0] as { changeRevisionIds: readonly string[]; observedHeadCommits: readonly string[] } | undefined;
  assert.equal(proposal?.changeRevisionIds.length, 2);
  assert.deepEqual(proposal?.observedHeadCommits, ["commit:two", "commit:three"]);
});

test("signed GitHub webhook is a wake-up hint, dedupes deliveries, ignores unmapped refs, and bounds reconciliation", async () => {
  const { value } = adapter();
  const body = JSON.stringify({
    ref: "refs/heads/main",
    before: "commit:one",
    after: "commit:two",
    forced: false,
    deleted: false,
    repository: { full_name: "acme/video-player" },
    installation: { id: "installation:github-app" },
  });
  const signature = `sha256=${createHmac("sha256", "fixture-webhook-secret").update(body).digest("hex")}`;
  const accepted = value.acceptWebhook({ body, event: "push", deliveryId: "delivery:one", signature, secret: "fixture-webhook-secret", mirrorId: "mirror:github", mappedRemoteRefs: ["refs/heads/main"] });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.reinspectionRequired, true);
  const duplicate = value.acceptWebhook({ body, event: "push", deliveryId: "delivery:one", signature, secret: "fixture-webhook-secret", mirrorId: "mirror:github", mappedRemoteRefs: ["refs/heads/main"] });
  assert.equal(duplicate.status, "duplicate");
  const ignored = value.acceptWebhook({ body: body.replace("refs/heads/main", "refs/heads/private"), event: "push", deliveryId: "delivery:private", signature: `sha256=${createHmac("sha256", "fixture-webhook-secret").update(body.replace("refs/heads/main", "refs/heads/private")).digest("hex")}`, secret: "fixture-webhook-secret", mirrorId: "mirror:github", mappedRemoteRefs: ["refs/heads/main"] });
  assert.equal(ignored.status, "ignored");

  const secondBody = body.replace("commit:two", "commit:three");
  const secondSignature = `sha256=${createHmac("sha256", "fixture-webhook-secret").update(secondBody).digest("hex")}`;
  const bounded = value.acceptWebhook({ body: secondBody, event: "push", deliveryId: "delivery:two", signature: secondSignature, secret: "fixture-webhook-secret", mirrorId: "mirror:github", mappedRemoteRefs: ["refs/heads/main"] });
  assert.equal(bounded.status, "accepted");
  const thirdBody = body.replace("commit:two", "commit:four");
  const thirdSignature = `sha256=${createHmac("sha256", "fixture-webhook-secret").update(thirdBody).digest("hex")}`;
  const full = value.acceptWebhook({ body: thirdBody, event: "push", deliveryId: "delivery:three", signature: thirdSignature, secret: "fixture-webhook-secret", mirrorId: "mirror:github", mappedRemoteRefs: ["refs/heads/main"] });
  assert.equal(full.status, "blocked");

  const drained = await value.drainReconciliation({ limit: 2, reinspect: async (task) => ({ status: "succeeded", receipt: `reinspected=${task.deliveryId}; remoteState=authoritative` }) });
  assert.equal(drained.status, "succeeded");
  if (drained.status === "succeeded" && drained.value) assert.equal(drained.value.processedDeliveryIds.length, 2);
});

test("GitHub Mirror producer re-inspects a push, signs the exact handoff, and deduplicates delivery replay", async () => {
  const { value } = producerAdapter();
  const authority = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot("realm:github-producer"));
  const ownerSession: AuthoritySession = { realmId: "realm:github-producer", principalId: "principal:owner", actorId: "actor:owner", sessionId: "session:owner", clientId: "anyam-producer-fixture", authorizationEpoch: 1 };
  const mirrorSession: AuthoritySession = { realmId: "realm:github-producer", principalId: "mirror-provider:github", actorId: "mirror:github-producer", sessionId: "session:mirror", clientId: "anyam-mirror-coordinator", authorizationEpoch: 1, kind: "mirror" };
  const execute = (command: AuthorityCommand, session: AuthoritySession): ReturnType<AuthorityPlaneCoordinator["execute"]> => authority.execute(command, session);
  assert.equal(execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "project.create", idempotencyKey: "producer:project", payload: { projectId: "project:producer", name: "Producer", referenceType: "git", sourceSpaces: [{ id: "source:producer", name: "Public", classification: "public", snapshotId: PRODUCER_COMMIT_ONE, repositoryId: "repository:producer" }], projectRevisionId: "project-revision:producer:one" } }, ownerSession).status, "succeeded");
  const workspace = execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "workspace.create", idempotencyKey: "producer:workspace", payload: { projectId: "project:producer", projectRevisionId: "project-revision:producer:one", workspaceId: "workspace:producer", sourceSpaceIds: ["source:producer"], projectionId: "projection:producer", classification: "public" } }, ownerSession);
  assert.equal(workspace.status, "succeeded");
  if (workspace.status !== "succeeded") return;
  const projectViewId = String((workspace.value as { view: { id: string } }).view.id);
  assert.equal(execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "mirror.configure", idempotencyKey: "producer:mirror", payload: { ...producerMirror(), mirrorId: "mirror:github-producer", projectId: "project:producer", sourceSpaceId: "source:producer", canonicalRefs: refs([["refs/heads/main", PRODUCER_COMMIT_ONE]]), remoteRefs: refs([["refs/heads/main", PRODUCER_COMMIT_ONE]]) } }, ownerSession).status, "succeeded");
  let captured: Awaited<ReturnType<typeof verifyMirrorIngestionHandoff>> | undefined;
  let handoffCount = 0;
  const producer = new GitHubMirrorProducer({
    adapter: value,
    mirror: producerMirror(),
    repositoryId: "repository:producer",
    projectViewId,
    canonicalProjectRevisionId: "project-revision:producer:one",
    canonicalRefs: refs([["refs/heads/main", PRODUCER_COMMIT_ONE]]),
    installationId: "installation:github-app",
    handoffKeyId: "mirror-key-v1",
    handoffSecret: "fixture-mirror-secret",
    ingest: async (handoff) => {
      handoffCount += 1;
      captured = await verifyMirrorIngestionHandoff({ value: handoff, keyId: "mirror-key-v1", secret: "fixture-mirror-secret", now: Date.parse("2026-08-27T01:00:00.000Z") });
      if (!captured.valid) return { status: "blocked", receipt: captured.receipt, recoveryAction: captured.recoveryAction };
      const authorityResult = execute(captured.handoff.command, mirrorSession);
      return { status: authorityResult.status === "succeeded" ? "succeeded" : "blocked", receipt: authorityResult.receipt, ...(authorityResult.recoveryAction ? { recoveryAction: authorityResult.recoveryAction } : {}) };
    },
    nowMilliseconds: () => Date.parse("2026-08-27T01:00:00.000Z"),
  });
  const body = JSON.stringify({ ref: "refs/heads/main", before: PRODUCER_COMMIT_ONE, after: PRODUCER_COMMIT_TWO, forced: false, deleted: false, repository: { full_name: "acme/video-player" }, installation: { id: "installation:github-app" } });
  const input = { body, event: "push", deliveryId: "delivery:producer-push", signature: signed(body, "fixture-webhook-secret"), secret: "fixture-webhook-secret", mirrorId: "mirror:github-producer", mappedRemoteRefs: ["refs/heads/main"] } as const;
  const result = await producer.processWebhook(input);
  assert.equal(result.status, "succeeded");
  assert.equal(result.webhook.status, "accepted");
  assert.equal(handoffCount, 1);
  assert.equal(captured?.valid, true);
  if (captured?.valid) {
    assert.equal(captured.handoff.command.command, "mirror.sync");
    assert.equal(captured.handoff.command.payload.mirrorId, "mirror:github-producer");
    assert.equal((captured.handoff.command.payload.externalProposal as Record<string, unknown>).latestHeadCommit, PRODUCER_COMMIT_TWO);
    assert.equal((captured.handoff.command.payload.mirrorRepositoryObservations as Record<string, unknown>)["source:producer"] !== undefined, true);
    assert.equal(JSON.stringify(captured.handoff).includes("installation-token-must-not"), false);
  }
  const authoritySnapshot = authority.snapshot();
  const proposal = Object.values(authoritySnapshot.externalProposals)[0];
  assert.equal(proposal?.mirrorId, "mirror:github-producer");
  assert.equal(proposal?.changeRevisionIds.length, 1);
  assert.equal(authoritySnapshot.mirrors["mirror:github-producer"]?.remoteGeneration, "remote:g2");
  const duplicate = await producer.processWebhook(input);
  assert.equal(duplicate.status, "succeeded");
  assert.equal(duplicate.webhook.status, "duplicate");
  assert.equal(handoffCount, 1);
});

test("GitHub Mirror producer maps pull-request deliveries and keeps failed ingestion pending", async () => {
  const { value, git } = producerAdapter();
  let attempts = 0;
  const producer = new GitHubMirrorProducer({
    adapter: value,
    mirror: producerMirror(),
    repositoryId: "repository:producer",
    projectViewId: "project-view:producer",
    canonicalProjectRevisionId: "project-revision:producer:one",
    canonicalRefs: refs([["refs/heads/main", PRODUCER_COMMIT_ONE]]),
    installationId: "installation:github-app",
    handoffKeyId: "mirror-key-v1",
    handoffSecret: "fixture-mirror-secret",
    ingest: async () => {
      attempts += 1;
      return attempts === 1 ? { status: "blocked", receipt: "authority=fixture; state=temporarily-unavailable; credentialMaterialStored=false", recoveryAction: "retry the same signed handoff" } : { status: "succeeded", receipt: "authority=fixture; mirror-handoff=accepted; credentialMaterialStored=false" };
    },
    nowMilliseconds: () => Date.parse("2026-08-27T01:00:00.000Z"),
  });
  const body = JSON.stringify({ action: "opened", pull_request: { number: 42, base: { ref: "main" } }, repository: { full_name: "acme/video-player" }, installation: { id: "installation:github-app" } });
  const input = { body, event: "pull_request", deliveryId: "delivery:producer-pr", signature: signed(body, "fixture-webhook-secret"), secret: "fixture-webhook-secret", mirrorId: "mirror:github-producer", mappedRemoteRefs: ["refs/heads/main"] } as const;
  const first = await producer.processWebhook(input);
  assert.equal(first.status, "blocked");
  assert.equal(attempts, 1);
  const second = await producer.processWebhook(input);
  assert.equal(second.status, "succeeded");
  assert.equal(second.webhook.status, "duplicate");
  assert.equal(attempts, 2);
  assert.equal(git.refs.refs[0]?.oid, PRODUCER_COMMIT_TWO);
});

test("GitHub Mirror producer refuses force-push/deletion without signed ingestion", async () => {
  const { value, git, api } = producerAdapter();
  git.refs = { generation: "remote:rewritten", refs: refs([["refs/heads/main", PRODUCER_COMMIT_REWRITTEN]]), receipt: "git-smart-http=rewritten; provider=github" };
  api.commits.oid = PRODUCER_COMMIT_REWRITTEN;
  api.compareStatus = "diverged";
  let ingested = false;
  const producer = new GitHubMirrorProducer({ adapter: value, mirror: producerMirror(), repositoryId: "repository:producer", projectViewId: "project-view:producer", canonicalProjectRevisionId: "project-revision:producer:one", canonicalRefs: refs([["refs/heads/main", PRODUCER_COMMIT_ONE]]), installationId: "installation:github-app", handoffKeyId: "mirror-key-v1", handoffSecret: "fixture-mirror-secret", ingest: async () => { ingested = true; return { status: "succeeded", receipt: "unexpected" }; } });
  const body = JSON.stringify({ ref: "refs/heads/main", before: PRODUCER_COMMIT_ONE, after: PRODUCER_COMMIT_REWRITTEN, forced: true, deleted: false, repository: { full_name: "acme/video-player" }, installation: { id: "installation:github-app" } });
  const result = await producer.processWebhook({ body, event: "push", deliveryId: "delivery:producer-force", signature: signed(body, "fixture-webhook-secret"), secret: "fixture-webhook-secret", mirrorId: "mirror:github-producer", mappedRemoteRefs: ["refs/heads/main"] });
  assert.equal(result.status, "blocked");
  assert.equal(result.webhook.status, "accepted");
  assert.equal(ingested, false);
  assert.match(result.recoveryAction ?? "", /re-inspect|reconcil/iu);
});

test("GitHub Mirror ingestion HTTP transport accepts only a successful internal response", async () => {
  let requestBody = "";
  const transport = createGitHubMirrorIngestionHttpTransport({
    baseUrl: "https://realm.example/",
    fetchImpl: async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ status: "succeeded" }), { status: 200 });
    },
  });
  const handoff = { protocol: "anyam.mirror-ingestion/v1", keyId: "mirror-key-v1", nonce: "nonce:test", expiresAt: "2026-08-27T01:05:00.000Z", command: { protocol: "anyam.authority-command/v1", command: "mirror.sync", idempotencyKey: "idempotency:test", payload: {} }, signature: "opaque" } as const;
  const result = await transport(handoff);
  assert.equal(result.status, "succeeded");
  assert.match(requestBody, /anyam\.mirror-ingestion\/v1/u);
  const rejected = createGitHubMirrorIngestionHttpTransport({ baseUrl: "https://realm.example", fetchImpl: async () => new Response(JSON.stringify({ status: "blocked" }), { status: 409 }) });
  const rejectedResult = await rejected(handoff);
  assert.equal(rejectedResult.status, "blocked");
});

test("persisted delivery identity survives adapter restart and PR action normalization ignores unrelated actions", () => {
  const ledger = new Map<string, { task: GitHubReconciliationTask; processed: boolean }>();
  const deliveryLedger = { recordIfAbsent: (task: GitHubReconciliationTask) => { const existing = ledger.get(task.deliveryId); if (existing) return JSON.stringify(existing.task) === JSON.stringify(task) ? "duplicate" as const : "conflict" as const; ledger.set(task.deliveryId, { task, processed: false }); return "accepted" as const; }, listPending: (): readonly GitHubReconciliationTask[] => [...ledger.values()].filter((entry) => !entry.processed).map((entry) => entry.task), markProcessed: (deliveryId: string) => { const entry = ledger.get(deliveryId); if (entry) entry.processed = true; } };
  const first = new GitHubAppProjectionAdapter({ installation, issuer: new FakeTokenIssuer(), git: new FakeGit(), api: new FakeApi(), queue: { maxPending: 2, sizingReceipt: "fixture=queue-capacity-measured", deliveryLedger } });
  const body = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "acme/video-player" }, installation: { id: "installation:github-app" } });
  const signature = `sha256=${createHmac("sha256", "fixture-webhook-secret").update(body).digest("hex")}`;
  const accepted = first.acceptWebhook({ body, event: "push", deliveryId: "delivery:persisted", signature, secret: "fixture-webhook-secret", mirrorId: "mirror:github", mappedRemoteRefs: ["refs/heads/main"] });
  assert.equal(accepted.status, "accepted");
  const restarted = new GitHubAppProjectionAdapter({ installation, issuer: new FakeTokenIssuer(), git: new FakeGit(), api: new FakeApi(), queue: { maxPending: 2, sizingReceipt: "fixture=queue-capacity-measured", deliveryLedger } });
  const duplicate = restarted.acceptWebhook({ body, event: "push", deliveryId: "delivery:persisted", signature, secret: "fixture-webhook-secret", mirrorId: "mirror:github", mappedRemoteRefs: ["refs/heads/main"] });
  assert.equal(duplicate.status, "duplicate");
  const ignoredBody = JSON.stringify({ action: "labeled", pull_request: { base: { ref: "main" }, number: 42 }, repository: { full_name: "acme/video-player" }, installation: { id: "installation:github-app" } });
  const ignoredAction = restarted.acceptWebhook({ body: ignoredBody, event: "pull_request", deliveryId: "delivery:action", signature: `sha256=${createHmac("sha256", "fixture-webhook-secret").update(ignoredBody).digest("hex")}`, secret: "fixture-webhook-secret", mirrorId: "mirror:github", mappedRemoteRefs: ["refs/heads/main"] });
  assert.equal(ignoredAction.status, "ignored");
  const acceptedBody = ignoredBody.replace('"labeled"', '"opened"');
  const acceptedAction = restarted.acceptWebhook({ body: acceptedBody, event: "pull_request", deliveryId: "delivery:action-opened", signature: `sha256=${createHmac("sha256", "fixture-webhook-secret").update(acceptedBody).digest("hex")}`, secret: "fixture-webhook-secret", mirrorId: "mirror:github", mappedRemoteRefs: ["refs/heads/main"] });
  assert.equal(acceptedAction.status, "accepted");
  const spoofed = restarted.acceptWebhook({ body: ignoredBody, event: "pull_request", action: "opened", deliveryId: "delivery:action-spoofed", signature: `sha256=${createHmac("sha256", "fixture-webhook-secret").update(ignoredBody).digest("hex")}`, secret: "fixture-webhook-secret", mirrorId: "mirror:github", mappedRemoteRefs: ["refs/heads/main"] });
  assert.equal(spoofed.status, "blocked");
  const changedDelivery = restarted.acceptWebhook({ body: acceptedBody.replace('"opened"', '"synchronize"'), event: "pull_request", deliveryId: "delivery:action-opened", signature: `sha256=${createHmac("sha256", "fixture-webhook-secret").update(acceptedBody.replace('"opened"', '"synchronize"')).digest("hex")}`, secret: "fixture-webhook-secret", mirrorId: "mirror:github", mappedRemoteRefs: ["refs/heads/main"] });
  assert.equal(changedDelivery.status, "blocked");
});

test("GitHub App cleanup only deletes an explicitly disposable selected repository", async () => {
  const { value, api, issuer } = adapter();
  const cleanup = await cleanupGitHubAppDisposable({ installation, issuer, api, repositoryPrefix: "acme/video-player", qualificationId: "qualification-1" });
  assert.equal(cleanup.status, "blocked");
  assert.equal(api.deleted.length, 0);

  const safe = await cleanupGitHubAppDisposable({ installation, issuer, api, repositoryPrefix: "acme/video-player", qualificationId: "qualification-1", disposableRepository: "acme/video-player" });
  assert.equal(safe.status, "succeeded");
  assert.deepEqual(api.deleted, ["acme/video-player"]);
  assert.equal(JSON.stringify(safe).includes("installation-token-must-not"), false);
  assert.equal(issuer.calls.at(-1)?.permissions.includes("administration:write"), true);
});

test("GitHub App refuses repository URL drift and credential-shaped JSON receipts", () => {
  assert.throws(
    () => new GitHubAppProjectionAdapter({ installation: { ...installation, repositoryUrl: "https://github.com/other/video-player.git" }, issuer: new FakeTokenIssuer(), git: new FakeGit(), api: new FakeApi(), queue: { maxPending: 2, sizingReceipt: "fixture=queue-capacity-measured", deliveryLedger: fixtureDeliveryLedger() } }),
    (error: unknown) => error instanceof GitHubAppAdapterError && error.errorCode === "github_app.repository_url_mismatch",
  );
  assert.throws(
    () => new GitHubAppProjectionAdapter({ installation, issuer: new FakeTokenIssuer(), git: new FakeGit(), api: new FakeApi(), queue: { maxPending: 2, sizingReceipt: '{"token":"secret"}', deliveryLedger: fixtureDeliveryLedger() } }),
    (error: unknown) => error instanceof GitHubAppAdapterError && error.errorCode === "github_app.unsafe_receipt",
  );
});

assert.equal(GITHUB_APP_ADAPTER_PROTOCOL, "anyam.github-app-adapter/v1");
