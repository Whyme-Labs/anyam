import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORITY_COMMAND_PROTOCOL,
  AuthorityPlaneCoordinator,
  AuthorityPlaneError,
  emptyAuthorityPlaneSnapshot,
  type AuthorityCommandName,
  type AuthoritySession,
} from "../src/cloudflare/authority-plane.ts";

const session: AuthoritySession = {
  realmId: "realm:mirror-authority",
  principalId: "principal:owner",
  actorId: "actor:owner",
  sessionId: "session:owner",
  clientId: "client:owner",
  authorizationEpoch: 1,
};

function command(coordinator: AuthorityPlaneCoordinator, name: AuthorityCommandName, idempotencyKey: string, payload: Record<string, unknown>) {
  return coordinator.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: name, idempotencyKey, payload }, session);
}

function setup(): { coordinator: AuthorityPlaneCoordinator; projectRevisionId: string; projectViewId: string; mirrorId: string } {
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  const projectResult = command(coordinator, "project.create", "project:create", {
    projectId: "project:video-player",
    name: "Video Player",
    referenceType: "typescript",
    sourceSpaces: [{ id: "source:community", name: "Community", classification: "public", snapshotId: "commit:initial" }],
    projectRevisionId: "project-revision:initial",
  });
  assert.equal(projectResult.status, "succeeded");
  const workspaceResult = command(coordinator, "workspace.create", "workspace:create", {
    projectId: "project:video-player",
    projectRevisionId: "project-revision:initial",
    workspaceId: "workspace:proposal",
    sourceSpaceIds: ["source:community"],
    projectionId: "projection:community",
    classification: "public",
  });
  assert.equal(workspaceResult.status, "succeeded");
  const projectViewId = (workspaceResult.value.view as { id: string }).id;
  const mirrorResult = command(coordinator, "mirror.configure", "mirror:configure", {
    mirrorId: "mirror:github",
    projectId: "project:video-player",
    sourceSpaceId: "source:community",
    provider: "github",
    remoteRepository: "acme/video-player",
    refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
    disclosure: "public",
    canonicalProjectRevisionId: "project-revision:initial",
    canonicalRefs: [{ name: "refs/heads/main", oid: "commit:initial" }],
    remoteGeneration: "remote:g0",
    remoteRefs: [{ name: "refs/heads/main", oid: "commit:initial" }],
    receipt: "fixture=mirror-configured; credentialFree=true",
  });
  assert.equal(mirrorResult.status, "succeeded");
  return { coordinator, projectRevisionId: "project-revision:initial", projectViewId, mirrorId: "mirror:github" };
}

test("a private provider mirror remains explicitly Anyam-canonical", () => {
  const { coordinator } = setup();
  const mirror = coordinator.snapshot().mirrors["mirror:github"];
  assert.equal(mirror?.canonicalAuthority, "anyam");
  assert.match(coordinator.snapshot().audit.at(-1)?.receipt ?? "", /canonicalAuthority=anyam; providerRole=projection/);
});

test("Authority rejects a provider-authoritative mirror request", () => {
  const { coordinator } = setup();
  assert.throws(
    () => command(coordinator, "mirror.configure", "mirror:provider-authority", {
      mirrorId: "mirror:provider-authority",
      projectId: "project:video-player",
      sourceSpaceId: "source:community",
      provider: "github",
      remoteRepository: "acme/video-player",
      canonicalAuthority: "provider",
      refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
      disclosure: "public",
      canonicalProjectRevisionId: "project-revision:initial",
      canonicalRefs: [{ name: "refs/heads/main", oid: "commit:initial" }],
      remoteGeneration: "remote:g0",
      remoteRefs: [{ name: "refs/heads/main", oid: "commit:initial" }],
      receipt: "fixture=provider-authority; credentialFree=true",
    }),
    (error: unknown) => error instanceof AuthorityPlaneError
      && error.code === "invalid_request"
      && error.receipt.includes("canonicalAuthority=provider"),
  );
});

function syncPayload(input: { projectViewId: string; head: string; deliveryId: string; remoteGeneration: string; operationId: string; checkpointId: string; expectedRemoteGeneration?: string; operationState?: string }) {
  return {
    mirrorId: "mirror:github",
    canonicalProjectRevisionId: "project-revision:initial",
    canonicalRefs: [{ name: "refs/heads/main", oid: "commit:initial" }],
    expectedRemoteGeneration: input.expectedRemoteGeneration ?? "remote:g0",
    remoteGeneration: input.remoteGeneration,
    remoteRefs: [{ name: "refs/heads/main", oid: input.head }],
    operationId: input.operationId,
    checkpointId: input.checkpointId,
    operationState: input.operationState ?? "succeeded",
    mirrorState: "healthy",
    receipt: `fixture=provider-observation; operation=${input.operationId}`,
    delivery: {
      provider: "github",
      installationId: "installation:github-app",
      sourceIdentity: "installation:github-app",
      remoteRepository: "acme/video-player",
      deliveryId: input.deliveryId,
      eventType: "pull_request.synchronize",
      proposalKey: "42",
    },
    externalProposal: {
      provider: "github",
      installationId: "installation:github-app",
      sourceIdentity: "installation:github-app",
      remoteRepository: "acme/video-player",
      proposalKind: "pull-request",
      proposalKey: "42",
      latestHeadCommit: input.head,
      baseProjectRevisionId: "project-revision:initial",
      projectViewId: input.projectViewId,
      disclosure: "public",
      receipt: `fixture=proposal; head=${input.head}`,
    },
  };
}

test("Realm Authority persists mirror operations, maps one external proposal to one Change, and advances one Revision per head", () => {
  const { coordinator, projectViewId } = setup();
  const first = command(coordinator, "mirror.sync", "delivery:one", syncPayload({ projectViewId, head: "commit:one", deliveryId: "delivery:one", remoteGeneration: "remote:g1", operationId: "mirror-operation:one", checkpointId: "mirror-checkpoint:one" }));
  assert.equal(first.status, "succeeded");
  const firstSnapshot = coordinator.snapshot();
  assert.equal(Object.keys(firstSnapshot.changes).length, 1);
  assert.equal(Object.keys(firstSnapshot.changeRevisions).length, 1);
  assert.equal(Object.keys(firstSnapshot.externalProposals).length, 1);
  assert.equal(Object.keys(firstSnapshot.mirrorDeliveries).length, 1);
  assert.equal(firstSnapshot.canonicalByProject["project:video-player"], "project-revision:initial");
  assert.equal(JSON.stringify(first).includes("token"), false);

  const duplicate = command(coordinator, "mirror.sync", "delivery:one-retry", syncPayload({ projectViewId, head: "commit:one", deliveryId: "delivery:one", remoteGeneration: "remote:g1", operationId: "mirror-operation:duplicate", checkpointId: "mirror-checkpoint:duplicate" }));
  assert.equal(duplicate.status, "succeeded");
  assert.match(duplicate.receipt, /duplicate=true/);
  assert.equal(Object.keys(coordinator.snapshot().changeRevisions).length, 1);

  const second = command(coordinator, "mirror.sync", "delivery:two", syncPayload({ projectViewId, head: "commit:two", deliveryId: "delivery:two", remoteGeneration: "remote:g1", expectedRemoteGeneration: "remote:g1", operationId: "mirror-operation:two", checkpointId: "mirror-checkpoint:two" }));
  assert.equal(second.status, "succeeded");
  const closed = command(coordinator, "mirror.sync", "delivery:closed", {
    ...syncPayload({ projectViewId, head: "commit:two", deliveryId: "delivery:closed", remoteGeneration: "remote:g1", expectedRemoteGeneration: "remote:g1", operationId: "mirror-operation:closed", checkpointId: "mirror-checkpoint:closed" }),
    externalProposal: { ...syncPayload({ projectViewId, head: "commit:two", deliveryId: "delivery:closed", remoteGeneration: "remote:g1", expectedRemoteGeneration: "remote:g1", operationId: "mirror-operation:closed", checkpointId: "mirror-checkpoint:closed" }).externalProposal, status: "closed" },
  });
  assert.equal(closed.status, "succeeded");
  const persisted = new AuthorityPlaneCoordinator(coordinator.snapshot()).snapshot();
  assert.equal(Object.keys(persisted.changes).length, 1);
  assert.equal(Object.keys(persisted.changeRevisions).length, 2);
  const proposal = Object.values(persisted.externalProposals)[0]!;
  assert.equal(proposal.changeRevisionIds.length, 2);
  assert.deepEqual(proposal.observedHeadCommits, ["commit:one", "commit:two"]);
  assert.equal(proposal.status, "closed");
  const pullRequest = Object.values(persisted.pullRequests)[0];
  assert.equal(pullRequest?.changeId, proposal.changeId);
  assert.equal(pullRequest?.status, "closed");
  assert.equal(pullRequest?.revisionIds.length, 2);
  assert.equal(pullRequest?.externalKey, proposal.proposalKey);
  assert.equal(persisted.mirrors["mirror:github"]?.canonicalProjectRevisionId, "project-revision:initial");
});

test("mirror disclosure and canonical-base checks fail closed without creating a Change", () => {
  const { coordinator, projectViewId } = setup();
  assert.throws(
    () => command(coordinator, "mirror.sync", "proposal:private-view", {
      ...syncPayload({ projectViewId, head: "commit:private", deliveryId: "delivery:private", remoteGeneration: "remote:g1", operationId: "mirror-operation:private", checkpointId: "mirror-checkpoint:private" }),
      externalProposal: { ...syncPayload({ projectViewId, head: "commit:private", deliveryId: "delivery:private", remoteGeneration: "remote:g1", operationId: "mirror-operation:private", checkpointId: "mirror-checkpoint:private" }).externalProposal, disclosure: "project" },
    }),
    (error: unknown) => error instanceof AuthorityPlaneError && error.code === "conflict" && error.receipt.includes("proposal=blocked"),
  );
  assert.throws(
    () => command(coordinator, "mirror.sync", "proposal:stale", {
      ...syncPayload({ projectViewId, head: "commit:stale", deliveryId: "delivery:stale", remoteGeneration: "remote:g1", operationId: "mirror-operation:stale", checkpointId: "mirror-checkpoint:stale" }),
      externalProposal: { ...syncPayload({ projectViewId, head: "commit:stale", deliveryId: "delivery:stale", remoteGeneration: "remote:g1", operationId: "mirror-operation:stale", checkpointId: "mirror-checkpoint:stale" }).externalProposal, baseProjectRevisionId: "project-revision:old" },
    }),
    (error: unknown) => error instanceof AuthorityPlaneError && error.code === "stale_state" && error.receipt.includes("proposal=blocked"),
  );
  assert.equal(Object.keys(coordinator.snapshot().changes).length, 0);
});

test("generation mismatch creates an owner-visible blocked checkpoint and explicit reconciliation resumes it", () => {
  const { coordinator, projectViewId } = setup();
  const blocked = command(coordinator, "mirror.sync", "mirror:blocked", {
    ...syncPayload({ projectViewId, head: "commit:remote", deliveryId: "delivery:blocked", remoteGeneration: "remote:g2", operationId: "mirror-operation:blocked", checkpointId: "mirror-checkpoint:blocked" }),
      expectedRemoteGeneration: "remote:g0",
    operationState: "blocked",
    externalProposal: undefined,
    delivery: undefined,
    recoveryAction: "inspect remote generation remote:g2 before resuming",
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(coordinator.snapshot().mirrors["mirror:github"]?.state, "blocked");
  assert.equal(coordinator.snapshot().mirrors["mirror:github"]?.remoteGeneration, "remote:g0");
  assert.deepEqual(coordinator.snapshot().mirrors["mirror:github"]?.remoteRefs, [{ name: "refs/heads/main", oid: "commit:initial" }]);
  assert.equal(coordinator.snapshot().mirrorCheckpoints["mirror-checkpoint:blocked"]?.state, "blocked");
  const reconciled = command(coordinator, "mirror.reconcile", "mirror:reconcile", {
    ...syncPayload({ projectViewId, head: "commit:remote", deliveryId: "delivery:reconciled", remoteGeneration: "remote:g2", operationId: "mirror-operation:reconciled", checkpointId: "mirror-checkpoint:reconciled" }),
    expectedRemoteGeneration: "remote:g0",
    reconciliation: "canonical-wins",
    remoteRefs: [{ name: "refs/heads/main", oid: "commit:initial" }],
    externalProposal: undefined,
    delivery: undefined,
    resumeCheckpointId: "mirror-checkpoint:blocked",
  });
  assert.equal(reconciled.status, "succeeded");
  assert.equal(coordinator.snapshot().mirrors["mirror:github"]?.state, "healthy");
  assert.equal(coordinator.snapshot().mirrorCheckpoints["mirror-checkpoint:reconciled"]?.state, "completed");
  assert.equal(coordinator.snapshot().canonicalByProject["project:video-player"], "project-revision:initial");
});

test("mirror sync binds delivery identity and Project View disclosure before importing an external proposal", () => {
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  const projectResult = command(coordinator, "project.create", "project:disclosure:create", {
    projectId: "project:disclosure",
    name: "Disclosure Fixture",
    referenceType: "git",
    sourceSpaces: [
      { id: "source:public", name: "Public", classification: "public", snapshotId: "commit:public" },
      { id: "source:private", name: "Private", classification: "restricted", snapshotId: "commit:private" },
    ],
    projectRevisionId: "project-revision:disclosure",
  });
  assert.equal(projectResult.status, "succeeded");
  const workspaceResult = command(coordinator, "workspace.create", "workspace:disclosure:create", {
    projectId: "project:disclosure",
    projectRevisionId: "project-revision:disclosure",
    workspaceId: "workspace:disclosure",
    sourceSpaceIds: ["source:public"],
    projectionId: "projection:disclosure",
    classification: "public",
  });
  const projectViewId = (workspaceResult.value.view as { id: string }).id;
  const mirrorResult = command(coordinator, "mirror.configure", "mirror:disclosure:configure", {
    mirrorId: "mirror:disclosure",
    projectId: "project:disclosure",
    sourceSpaceId: "source:public",
    provider: "github",
    remoteRepository: "acme/disclosure",
    refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
    disclosure: "public",
    canonicalProjectRevisionId: "project-revision:disclosure",
    canonicalRefs: [{ name: "refs/heads/main", oid: "commit:public" }],
    remoteGeneration: "remote:g0",
    remoteRefs: [{ name: "refs/heads/main", oid: "commit:public" }],
    receipt: "fixture=disclosure-mirror; credentialFree=true",
  });
  assert.equal(mirrorResult.status, "succeeded");
  const base = {
    mirrorId: "mirror:disclosure",
    canonicalProjectRevisionId: "project-revision:disclosure",
    canonicalRefs: [{ name: "refs/heads/main", oid: "commit:public" }],
    expectedRemoteGeneration: "remote:g0",
    remoteGeneration: "remote:g1",
    remoteRefs: [{ name: "refs/heads/main", oid: "commit:proposal" }],
    operationId: "mirror-operation:disclosure",
    checkpointId: "mirror-checkpoint:disclosure",
    operationState: "succeeded",
    mirrorState: "healthy",
    receipt: "fixture=disclosure-sync; credentialFree=true",
  };
  const proposal = {
    provider: "github",
    installationId: "installation:github-app",
    sourceIdentity: "installation:github-app",
    remoteRepository: "acme/disclosure",
    proposalKind: "pull-request",
    proposalKey: "17",
    latestHeadCommit: "commit:proposal",
    baseProjectRevisionId: "project-revision:disclosure",
    projectViewId,
    disclosure: "public",
    receipt: "fixture=proposal; signature=verified",
  };
  assert.throws(
    () => command(coordinator, "mirror.sync", "mirror:disclosure:private", {
      ...base,
      delivery: { provider: "github", installationId: "installation:github-app", sourceIdentity: "installation:github-app", remoteRepository: "acme/disclosure", deliveryId: "delivery:private", eventType: "pull_request", proposalKey: "17" },
      externalProposal: { ...proposal, sourceSpaceSnapshots: { "source:public": "commit:proposal", "source:private": "commit:private" } },
    }),
    (error: unknown) => error instanceof AuthorityPlaneError && error.code === "conflict" && error.receipt.includes("disclosure=blocked"),
  );
  assert.throws(
    () => command(coordinator, "mirror.sync", "mirror:disclosure:identity", {
      ...base,
      operationId: "mirror-operation:identity",
      checkpointId: "mirror-checkpoint:identity",
      delivery: { provider: "github", installationId: "installation:github-app", sourceIdentity: "installation:github-app", remoteRepository: "acme/disclosure", deliveryId: "delivery:identity", eventType: "pull_request", proposalKey: "17" },
      externalProposal: { ...proposal, proposalKey: "18" },
    }),
    (error: unknown) => error instanceof AuthorityPlaneError && error.code === "conflict" && error.receipt.includes("proposal-delivery-mismatch"),
  );
  assert.equal(Object.keys(coordinator.snapshot().changes).length, 0);
});

test("mirror receipts reject credential-like material before it can enter Authority state", () => {
  const { coordinator, projectViewId } = setup();
  assert.throws(
    () => command(coordinator, "mirror.sync", "mirror:receipt-secret", {
      ...syncPayload({ projectViewId, head: "commit:secret", deliveryId: "delivery:secret", remoteGeneration: "remote:g1", operationId: "mirror-operation:secret", checkpointId: "mirror-checkpoint:secret" }),
      receipt: "providerToken=should-not-persist",
    }),
    (error: unknown) => error instanceof AuthorityPlaneError && error.code === "invalid_request" && error.receipt.includes("credential-material-rejected"),
  );
  assert.equal(Object.keys(coordinator.snapshot().mirrorOperations).length, 0);
});
