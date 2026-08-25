import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORITY_COMMAND_PROTOCOL,
  AuthorityPlaneCoordinator,
  emptyAuthorityPlaneSnapshot,
  type AuthorityCommandName,
  type AuthoritySession,
} from "../src/cloudflare/authority-plane.ts";

const session: AuthoritySession = {
  realmId: "realm:intent-test",
  principalId: "principal:intent-owner",
  actorId: "actor:intent-owner",
  sessionId: "session:intent-owner",
  clientId: "client:anyam-cli",
  authorizationEpoch: 1,
};

function command(coordinator: AuthorityPlaneCoordinator, commandName: AuthorityCommandName, idempotencyKey: string, payload: Record<string, unknown>) {
  return coordinator.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: commandName, idempotencyKey, payload }, session);
}

function project(coordinator: AuthorityPlaneCoordinator): void {
  const result = command(coordinator, "project.create", "project:create", { projectId: "project:intent", name: "Intent project", referenceType: "typescript-library", sourceSpaces: [{ id: "source:intent", name: "Intent source", classification: "public", snapshotId: "commit:base" }], projectRevisionId: "project-revision:intent:base" });
  assert.equal(result.status, "succeeded");
}

test("Intent lifecycle creates stable identity, assignment, comments, close, reopen, and Change linkage", () => {
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  project(coordinator);

  const created = command(coordinator, "intent.create", "intent:create", { projectId: "project:intent", intentId: "intent:feature", title: "Add feature", description: "Track the feature work.", disclosure: "public", labels: ["feature"] });
  assert.equal(created.status, "succeeded");
  assert.equal((created.value.intent as { status: string }).status, "open");

  const assigned = command(coordinator, "intent.assign", "intent:assign", { projectId: "project:intent", intentId: "intent:feature", assigneePrincipalIds: ["principal:contributor"] });
  assert.deepEqual((assigned.value.intent as { assigneePrincipalIds: readonly string[] }).assigneePrincipalIds, ["principal:contributor"]);

  const commented = command(coordinator, "intent.comment", "intent:comment", { projectId: "project:intent", intentId: "intent:feature", commentId: "intent-comment:one", body: "Please review the acceptance criteria.", disclosure: "public" });
  assert.equal((commented.value.comment as { body: string }).body, "Please review the acceptance criteria.");

  const closed = command(coordinator, "intent.close", "intent:close", { projectId: "project:intent", intentId: "intent:feature" });
  assert.equal((closed.value.intent as { status: string }).status, "closed");
  const reopened = command(coordinator, "intent.reopen", "intent:reopen", { projectId: "project:intent", intentId: "intent:feature" });
  assert.equal((reopened.value.intent as { status: string }).status, "open");

  const change = command(coordinator, "change.create", "change:create-from-intent", { projectId: "project:intent", changeId: "change:feature", intentId: "intent:feature", baseProjectRevisionId: "project-revision:intent:base" });
  assert.equal(change.status, "succeeded");
  assert.equal((change.value.change as { intentId: string }).intentId, "intent:feature");

  const replay = command(coordinator, "intent.close", "intent:close", { projectId: "project:intent", intentId: "intent:feature" });
  assert.equal(replay.status, "succeeded");
  assert.equal((replay.value.intent as { status: string }).status, "closed");
  assert.equal(coordinator.snapshot().intentComments["intent-comment:one"]?.body, "Please review the acceptance criteria.");
});

test("Unknown Change intent IDs materialize a legacy Intent instead of leaving an opaque orphan", () => {
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  project(coordinator);
  const change = command(coordinator, "change.create", "change:legacy", { projectId: "project:intent", changeId: "change:legacy", intentId: "intent:legacy", baseProjectRevisionId: "project-revision:intent:base" });
  assert.equal(change.status, "succeeded");
  const intent = coordinator.snapshot().intents["intent:legacy"];
  assert.equal(intent?.receipt.includes("legacy-materialized"), true);
  assert.equal(intent?.projectId, "project:intent");
});
