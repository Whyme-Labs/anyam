import assert from "node:assert/strict";
import test from "node:test";

import { AUTHORITY_COMMAND_PROTOCOL, AuthorityPlaneCoordinator, AuthorityPlaneError, emptyAuthorityPlaneSnapshot, type AuthorityCommandName, type AuthoritySession } from "../src/cloudflare/authority-plane.ts";

const session: AuthoritySession = {
  realmId: "realm:pull-request-test",
  principalId: "principal:owner",
  actorId: "actor:owner",
  sessionId: "session:owner",
  clientId: "client:test",
  authorizationEpoch: 1,
  kind: "human",
};

function command(coordinator: AuthorityPlaneCoordinator, name: AuthorityCommandName, idempotencyKey: string, payload: Record<string, unknown>) {
  return coordinator.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: name, idempotencyKey, payload }, session);
}

test("Pull Request compatibility preserves identity through branch updates, review, Landing, and merge", () => {
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  const project = command(coordinator, "project.create", "project:create", { projectId: "project:pull-request", name: "Pull Request Test", referenceType: "typescript-library", sourceSpaces: [{ id: "source:pull-request", name: "public", classification: "public", snapshotId: "commit:base" }], projectRevisionId: "project-revision:base" });
  assert.equal(project.status, "succeeded");
  const workspace = command(coordinator, "workspace.create", "workspace:create", { projectId: "project:pull-request", workspaceId: "workspace:pull-request", projectRevisionId: "project-revision:base", sourceSpaceIds: ["source:pull-request"], mounts: ["source"] });
  assert.equal(workspace.status, "succeeded");
  const projectViewId = (workspace.value.view as { id: string }).id;
  const change = command(coordinator, "change.create", "change:create", { projectId: "project:pull-request", changeId: "change:pull-request", intentId: "intent:pull-request", baseProjectRevisionId: "project-revision:base", workspaceId: "workspace:pull-request" });
  assert.equal(change.status, "succeeded");
  const revisionOne = command(coordinator, "revision.publish", "revision:one", { projectId: "project:pull-request", changeId: "change:pull-request", workspaceId: "workspace:pull-request", projectViewId, projectRevisionId: "project-revision:candidate-one", sourceSpaceSnapshots: { "source:pull-request": "commit:feature-one" }, declaredEffects: ["source.modify"] });
  assert.equal(revisionOne.status, "succeeded");
  const revisionOneId = (revisionOne.value.revision as { id: string }).id;
  const opened = command(coordinator, "pullRequest.open", "pull-request:open", { projectId: "project:pull-request", pullRequestId: "pr:pull-request", changeId: "change:pull-request", provider: "local", externalKey: "local:pull-request", headRef: "refs/heads/feature/agent-a", baseRef: "refs/heads/main", headCommit: "commit:feature-one", baseCommit: "commit:base", title: "Add the feature", description: "Compatibility projection over the stable Change.", disclosure: "public", revisionIds: [revisionOneId] });
  assert.equal(opened.status, "succeeded");
  assert.equal((opened.value.pullRequest as { id: string }).id, "pr:pull-request");
  assert.throws(() => command(coordinator, "pullRequest.merge", "pull-request:merge-before-landing", { projectId: "project:pull-request", pullRequestId: "pr:pull-request" }), (error: unknown) => error instanceof AuthorityPlaneError && error.code === "conflict" && error.receipt.includes("merge=not-accepted"));
  const revisionTwo = command(coordinator, "revision.publish", "revision:two", { projectId: "project:pull-request", changeId: "change:pull-request", workspaceId: "workspace:pull-request", projectViewId, projectRevisionId: "project-revision:candidate-two", sourceSpaceSnapshots: { "source:pull-request": "commit:feature-two" }, declaredEffects: ["source.modify", "rebase:resolved"], kind: "rebase" });
  assert.equal(revisionTwo.status, "succeeded");
  const revisionTwoId = (revisionTwo.value.revision as { id: string }).id;
  const updated = command(coordinator, "pullRequest.update", "pull-request:update", { projectId: "project:pull-request", pullRequestId: "pr:pull-request", headRef: "refs/heads/feature/agent-a-rebased", headCommit: "commit:feature-two", baseCommit: "commit:base", revisionId: revisionTwoId });
  assert.equal(updated.status, "succeeded");
  const updatedPullRequest = updated.value.pullRequest as { id: string; headCommit: string; revisionIds: readonly string[] };
  assert.equal(updatedPullRequest.id, "pr:pull-request");
  assert.equal(updatedPullRequest.headCommit, "commit:feature-two");
  assert.deepEqual(updatedPullRequest.revisionIds, [revisionOneId, revisionTwoId]);
  const changesRequested = command(coordinator, "pullRequest.review", "pull-request:review-request-changes", { projectId: "project:pull-request", pullRequestId: "pr:pull-request", reviewState: "changes-requested", reviewDigest: "sha256:review-finding" });
  assert.equal((changesRequested.value.pullRequest as { reviewState: string }).reviewState, "changes-requested");
  const blocked = command(coordinator, "pullRequest.block", "pull-request:block", { projectId: "project:pull-request", pullRequestId: "pr:pull-request" });
  assert.equal((blocked.value.pullRequest as { status: string }).status, "blocked");
  const reopened = command(coordinator, "pullRequest.reopen", "pull-request:reopen", { projectId: "project:pull-request", pullRequestId: "pr:pull-request" });
  assert.equal((reopened.value.pullRequest as { status: string }).status, "open");
  command(coordinator, "pullRequest.review", "pull-request:review-approved", { projectId: "project:pull-request", pullRequestId: "pr:pull-request", reviewState: "approved", reviewDigest: "sha256:review-approved" });
  const landing = command(coordinator, "landing.apply", "landing:apply", { projectId: "project:pull-request", changeId: "change:pull-request", changeRevisionId: revisionTwoId, expectedCanonicalProjectRevisionId: "project-revision:base", projectRevisionId: "project-revision:landed" });
  assert.equal(landing.status, "succeeded");
  const merged = command(coordinator, "pullRequest.merge", "pull-request:merge", { projectId: "project:pull-request", pullRequestId: "pr:pull-request" });
  assert.equal((merged.value.pullRequest as { status: string }).status, "merged");
  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.pullRequests["pr:pull-request"]?.changeId, "change:pull-request");
  assert.equal(snapshot.changes["change:pull-request"]?.status, "landed");
  assert.match(snapshot.pullRequests["pr:pull-request"]?.receipt ?? "", /canonicalWrite=false/);
});

function readyPullRequestForTransitionTest(): AuthorityPlaneCoordinator {
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  assert.equal(command(coordinator, "project.create", "transition:project", { projectId: "project:transition", name: "Transition Test", referenceType: "git", sourceSpaces: [{ id: "source:transition", name: "source", classification: "public", snapshotId: "commit:base" }], projectRevisionId: "project-revision:transition:base" }).status, "succeeded");
  const workspace = command(coordinator, "workspace.create", "transition:workspace", { projectId: "project:transition", workspaceId: "workspace:transition", projectRevisionId: "project-revision:transition:base", sourceSpaceIds: ["source:transition"], mounts: ["source"] });
  assert.equal(workspace.status, "succeeded");
  const projectViewId = (workspace.value.view as { id: string }).id;
  assert.equal(command(coordinator, "change.create", "transition:change", { projectId: "project:transition", changeId: "change:transition", intentId: "intent:transition", baseProjectRevisionId: "project-revision:transition:base", workspaceId: "workspace:transition" }).status, "succeeded");
  const revision = command(coordinator, "revision.publish", "transition:revision", { projectId: "project:transition", changeId: "change:transition", workspaceId: "workspace:transition", projectViewId, projectRevisionId: "project-revision:transition:candidate", sourceSpaceSnapshots: { "source:transition": "commit:feature" }, declaredEffects: ["source.modify"] });
  assert.equal(revision.status, "succeeded");
  const revisionId = (revision.value.revision as { id: string }).id;
  assert.equal(command(coordinator, "pullRequest.open", "transition:open", { projectId: "project:transition", pullRequestId: "pr:transition", changeId: "change:transition", provider: "local", headRef: "refs/heads/feature", baseRef: "refs/heads/main", headCommit: "commit:feature", baseCommit: "commit:base", title: "Transition", disclosure: "public", revisionIds: [revisionId] }).status, "succeeded");
  assert.equal(command(coordinator, "pullRequest.review", "transition:review", { projectId: "project:transition", pullRequestId: "pr:transition", reviewState: "approved", reviewDigest: "sha256:transition" }).status, "succeeded");
  assert.equal(command(coordinator, "landing.apply", "transition:landing", { projectId: "project:transition", changeId: "change:transition", changeRevisionId: revisionId, expectedCanonicalProjectRevisionId: "project-revision:transition:base", projectRevisionId: "project-revision:transition:landed" }).status, "succeeded");
  return coordinator;
}

test("Pull Request transition table rejects direct merge from closed and blocked states", () => {
  const blocked = readyPullRequestForTransitionTest();
  assert.equal(command(blocked, "pullRequest.block", "transition:blocked", { projectId: "project:transition", pullRequestId: "pr:transition" }).status, "succeeded");
  assert.throws(() => command(blocked, "pullRequest.merge", "transition:blocked-merge", { projectId: "project:transition", pullRequestId: "pr:transition" }), (error: unknown) => error instanceof AuthorityPlaneError && error.code === "conflict" && error.receipt.includes("status=blocked") && error.receipt.includes("transition=not-applied"));
  assert.equal(blocked.snapshot().pullRequests["pr:transition"]?.status, "blocked");

  const closed = readyPullRequestForTransitionTest();
  assert.equal(command(closed, "pullRequest.close", "transition:closed", { projectId: "project:transition", pullRequestId: "pr:transition" }).status, "succeeded");
  assert.throws(() => command(closed, "pullRequest.merge", "transition:closed-merge", { projectId: "project:transition", pullRequestId: "pr:transition" }), (error: unknown) => error instanceof AuthorityPlaneError && error.code === "conflict" && error.receipt.includes("status=closed") && error.receipt.includes("transition=not-applied"));
  assert.equal(closed.snapshot().pullRequests["pr:transition"]?.status, "closed");
});

test("Pull Request compatibility rejects cross-Change revisions and preserves a blocked status", () => {
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  const project = command(coordinator, "project.create", "project:create:blocked", { projectId: "project:pull-request-blocked", name: "Blocked PR", referenceType: "git", sourceSpaces: [{ id: "source:blocked", name: "source", classification: "public", snapshotId: "commit:base" }], projectRevisionId: "project-revision:blocked" });
  assert.equal(project.status, "succeeded");
  assert.throws(() => command(coordinator, "pullRequest.open", "pull-request:missing-change", { projectId: "project:pull-request-blocked", pullRequestId: "pr:missing-change", changeId: "change:missing", provider: "local", headRef: "refs/heads/feature", baseRef: "refs/heads/main", headCommit: "commit:head", baseCommit: "commit:base", title: "Missing Change", disclosure: "public" }), (error: unknown) => error instanceof AuthorityPlaneError && error.code === "not_found" && error.receipt.includes("pullRequest=not-created"));
});

test("Pull Request approvals are bound to the exact head and merged Pull Requests are terminal", () => {
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  assert.equal(command(coordinator, "project.create", "integrity:project", { projectId: "project:integrity", name: "Review integrity", referenceType: "git", sourceSpaces: [{ id: "source:integrity", name: "source", classification: "public", snapshotId: "commit:base" }], projectRevisionId: "revision:integrity:base" }).status, "succeeded");
  const workspace = command(coordinator, "workspace.create", "integrity:workspace", { projectId: "project:integrity", workspaceId: "workspace:integrity", projectRevisionId: "revision:integrity:base", sourceSpaceIds: ["source:integrity"], mounts: ["source"] });
  assert.equal(workspace.status, "succeeded");
  if (workspace.status !== "succeeded") return;
  const projectViewId = (workspace.value.view as { id: string }).id;
  assert.equal(command(coordinator, "change.create", "integrity:change", { projectId: "project:integrity", changeId: "change:integrity", intentId: "intent:integrity", baseProjectRevisionId: "revision:integrity:base", workspaceId: "workspace:integrity" }).status, "succeeded");
  const revision = command(coordinator, "revision.publish", "integrity:revision", { projectId: "project:integrity", changeId: "change:integrity", workspaceId: "workspace:integrity", projectViewId, projectRevisionId: "revision:integrity:candidate", sourceSpaceSnapshots: { "source:integrity": "commit:head-one" }, declaredEffects: ["source.modify"] });
  assert.equal(revision.status, "succeeded");
  if (revision.status !== "succeeded") return;
  const revisionId = (revision.value.revision as { id: string }).id;
  assert.equal(command(coordinator, "pullRequest.open", "integrity:open", { projectId: "project:integrity", pullRequestId: "pr:integrity", changeId: "change:integrity", provider: "local", headRef: "refs/heads/feature", baseRef: "refs/heads/main", headCommit: "commit:head-one", baseCommit: "commit:base", title: "Integrity", disclosure: "public", revisionIds: [revisionId] }).status, "succeeded");
  const approved = command(coordinator, "pullRequest.review", "integrity:approve-one", { projectId: "project:integrity", pullRequestId: "pr:integrity", reviewState: "approved", reviewDigest: "sha256:review-one" });
  assert.equal(approved.status, "succeeded");
  if (approved.status !== "succeeded") return;
  const approvedPullRequest = approved.value.pullRequest as Record<string, unknown>;
  assert.equal(approvedPullRequest.reviewState, "approved");
  assert.equal(Array.isArray(approvedPullRequest.reviews), true);
  const reviews = approvedPullRequest.reviews as Array<Record<string, unknown>>;
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]?.headCommit, "commit:head-one");
  assert.equal(typeof reviews[0]?.revisionSetDigest, "string");
  const updated = command(coordinator, "pullRequest.update", "integrity:update-head", { projectId: "project:integrity", pullRequestId: "pr:integrity", headCommit: "commit:head-two" });
  assert.equal(updated.status, "succeeded");
  if (updated.status !== "succeeded") return;
  const stalePullRequest = updated.value.pullRequest as Record<string, unknown>;
  assert.equal(stalePullRequest.reviewState, "pending");
  assert.equal(stalePullRequest.reviewDigest, undefined);
  assert.equal((stalePullRequest.reviews as Array<Record<string, unknown>>).length, 1);
  assert.equal(command(coordinator, "landing.apply", "integrity:landing", { projectId: "project:integrity", changeId: "change:integrity", changeRevisionId: revisionId, expectedCanonicalProjectRevisionId: "revision:integrity:base", projectRevisionId: "revision:integrity:landed" }).status, "succeeded");
  assert.throws(() => command(coordinator, "pullRequest.merge", "integrity:merge-stale", { projectId: "project:integrity", pullRequestId: "pr:integrity" }), (error: unknown) => error instanceof AuthorityPlaneError && error.code === "conflict" && error.receipt.includes("approval"));
  assert.equal(command(coordinator, "pullRequest.review", "integrity:approve-two", { projectId: "project:integrity", pullRequestId: "pr:integrity", reviewState: "approved", reviewDigest: "sha256:review-two" }).status, "succeeded");
  assert.equal(command(coordinator, "pullRequest.merge", "integrity:merge", { projectId: "project:integrity", pullRequestId: "pr:integrity" }).status, "succeeded");
  for (const [operation, key, payload] of [
    ["pullRequest.update", "integrity:terminal-update", { headCommit: "commit:head-three" }],
    ["pullRequest.review", "integrity:terminal-review", { reviewState: "changes-requested", reviewDigest: "sha256:review-three" }],
    ["pullRequest.close", "integrity:terminal-close", {}],
    ["pullRequest.reopen", "integrity:terminal-reopen", {}],
    ["pullRequest.block", "integrity:terminal-block", {}],
    ["pullRequest.merge", "integrity:terminal-merge", {}],
  ] as const) {
    assert.throws(() => command(coordinator, operation, key, { projectId: "project:integrity", pullRequestId: "pr:integrity", ...payload }), (error: unknown) => error instanceof AuthorityPlaneError && error.code === "conflict" && error.receipt.includes("terminal"));
  }
});
