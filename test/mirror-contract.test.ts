import assert from "node:assert/strict";
import test from "node:test";

import { MirrorInputError, mirrorCommand, mirrorMutationValue, mirrorPath } from "../apps/realm-worker/src/mirror-contract.ts";

const configureBody = (): Record<string, unknown> => ({
  projectId: "project:contract-test",
  sourceSpaceId: "source:contract-test",
  provider: "external-git",
  remoteRepository: "org/project",
  refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
  disclosure: "public",
  canonicalProjectRevisionId: "project-revision:contract-test",
  canonicalRefs: [{ name: "refs/heads/main", oid: "git:canonical" }],
  remoteGeneration: "generation:0",
  remoteRefs: [{ name: "refs/heads/main", oid: "git:remote" }],
  pendingInboundChangeIds: [],
  receipt: "contract=test; credentialFree=true",
});

test("mirror paths distinguish collection, resource operations, and malformed routes", () => {
  assert.deepEqual(mirrorPath("/api/mirrors"), { matched: true, malformed: false });
  assert.deepEqual(mirrorPath("/api/mirrors/mirror%3Aone"), { matched: true, malformed: false, mirrorId: "mirror:one" });
  assert.deepEqual(mirrorPath("/api/mirrors/mirror%3Aone/sync"), { matched: true, malformed: false, mirrorId: "mirror:one", operation: "sync" });
  assert.deepEqual(mirrorPath("/api/mirrors/mirror%3Aone/reconcile"), { matched: true, malformed: false, mirrorId: "mirror:one", operation: "reconcile" });
  assert.equal(mirrorPath("/api/mirrors/mirror%3Aone/push").malformed, true);
  assert.equal(mirrorPath("/api/mirrors/a/b/c").malformed, true);
  assert.equal(mirrorPath("/api/projects").matched, false);
});

test("mirror configure whitelists provider observations and excludes credential material", () => {
  const command = mirrorCommand({
    operation: "configure",
    idempotencyKey: "idem:configure",
    body: {
      ...configureBody(),
      providerToken: "must-not-cross-authority-boundary",
      credential: { accessToken: "must-not-cross-authority-boundary" },
      arbitraryProviderPayload: { push: true },
    },
  });

  assert.equal(command.command, "mirror.configure");
  assert.equal(command.idempotencyKey, "idem:configure");
  assert.equal("providerToken" in command.payload, false);
  assert.equal("credential" in command.payload, false);
  assert.equal("arbitraryProviderPayload" in command.payload, false);
  assert.deepEqual(command.payload.refMappings, [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }]);
});

test("mirror sync parses delivery and external proposal identity into typed observations", () => {
  const command = mirrorCommand({
    operation: "sync",
    mirrorId: "mirror:contract-test",
    idempotencyKey: "idem:sync",
    body: {
      canonicalProjectRevisionId: "project-revision:contract-test",
      canonicalRefs: [{ name: "refs/heads/main", oid: "git:canonical" }],
      expectedRemoteGeneration: "generation:0",
      remoteGeneration: "generation:1",
      remoteRefs: [{ name: "refs/heads/main", oid: "git:remote-1" }],
      inboundChangeIds: [],
      completedInboundChangeIds: [],
      pendingInboundChangeIds: [],
      receipt: "provider=github; operation=sync; credentialFree=true",
      delivery: {
        provider: "github",
        installationId: "installation:one",
        sourceIdentity: "github:user:alice",
        remoteRepository: "org/project",
        deliveryId: "delivery:one",
        eventType: "pull_request",
        proposalKey: "pr:17",
        token: "must-not-cross-authority-boundary",
      },
      externalProposal: {
        provider: "github",
        installationId: "installation:one",
        sourceIdentity: "github:user:alice",
        remoteRepository: "org/project",
        proposalKind: "pull-request",
        proposalKey: "pr:17",
        latestHeadCommit: "git:head-1",
        baseProjectRevisionId: "project-revision:contract-test",
        projectViewId: "view:contract-test",
        disclosure: "public",
        receipt: "provider=github; signature=verified",
        sourceSpaceSnapshots: { "source:contract-test": "git:head-1" },
        declaredEffects: ["source.change"],
        token: "must-not-cross-authority-boundary",
      },
    },
  });

  assert.equal(command.command, "mirror.sync");
  const payload = command.payload as Record<string, unknown>;
  assert.deepEqual(payload.delivery, {
    provider: "github",
    installationId: "installation:one",
    sourceIdentity: "github:user:alice",
    remoteRepository: "org/project",
    deliveryId: "delivery:one",
    eventType: "pull_request",
    proposalKey: "pr:17",
  });
  assert.equal("token" in (payload.delivery as Record<string, unknown>), false);
  assert.equal("token" in (payload.externalProposal as Record<string, unknown>), false);
  assert.equal((payload.externalProposal as Record<string, unknown>).proposalKey, "pr:17");
});

test("mirror contract rejects transport/body idempotency mismatch with a visible receipt", () => {
  assert.throws(
    () => mirrorCommand({ operation: "configure", idempotencyKey: "idem:header", body: { ...configureBody(), idempotencyKey: "idem:body" } }),
    (error: unknown) => error instanceof MirrorInputError
      && error.receipt === "idempotencyKey=transport-mismatch; transition=not-applied"
      && error.recoveryAction.includes("one idempotency key"),
  );
});

test("mirror mutation responses carry the credential-free, non-canonical-write receipt", () => {
  const value = mirrorMutationValue({ status: "succeeded", receipt: "operation=accepted" } as never, "idem:response");
  assert.deepEqual(value, {
    status: "succeeded",
    receipt: "operation=accepted",
    idempotencyKey: "idem:response",
    credentialFree: true,
    canonicalWrite: false,
    providerCredential: "not-present",
  });
});
