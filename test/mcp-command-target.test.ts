import assert from "node:assert/strict";
import test from "node:test";

import { AUTHORITY_COMMAND_PROTOCOL, AuthorityPlaneCoordinator, emptyAuthorityPlaneSnapshot, type AuthorityCommand, type AuthoritySession } from "../src/cloudflare/authority-plane.ts";
import { authorizeMcpCommandTarget } from "../src/cloudflare/mcp-command-target.ts";

const session: AuthoritySession = {
  realmId: "realm:mcp-target",
  principalId: "principal:agent",
  actorId: "actor:agent",
  sessionId: "session:agent",
  clientId: "client:agent",
  authorizationEpoch: 1,
  kind: "agent",
};

function command(commandName: AuthorityCommand["command"], payload: Record<string, unknown>): AuthorityCommand {
  return { protocol: AUTHORITY_COMMAND_PROTOCOL, command: commandName, idempotencyKey: `idempotency:${commandName}`, payload };
}

function snapshot() {
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  const createProject = (projectId: string, sourceSpaceId: string, classification: "public" | "restricted") => coordinator.execute({ ...command("project.create", { projectId, name: projectId, referenceType: "git", projectRevisionId: `${projectId}:base`, sourceSpaces: [{ id: sourceSpaceId, name: sourceSpaceId, classification, snapshotId: `${sourceSpaceId}:base` }] }), idempotencyKey: `idempotency:project.create:${projectId}` }, session);
  createProject("project:a", "source:a-public", "public");
  createProject("project:b", "source:b-public", "public");
  coordinator.execute({ ...command("workspace.create", { projectId: "project:a", projectRevisionId: "project:a:base", workspaceId: "workspace:a", sourceSpaceIds: ["source:a-public"], mounts: ["public"] }), idempotencyKey: "idempotency:workspace.create:workspace-a" }, session);
  coordinator.execute({ ...command("workspace.create", { projectId: "project:a", projectRevisionId: "project:a:base", workspaceId: "workspace:other", sourceSpaceIds: ["source:a-public"], mounts: ["public"] }), idempotencyKey: "idempotency:workspace.create:workspace-other" }, session);
  coordinator.execute({ ...command("change.create", { projectId: "project:a", changeId: "change:a", intentId: "intent:a", workspaceId: "workspace:a" }), idempotencyKey: "idempotency:change.create:change-a" }, session);
  coordinator.execute({ ...command("change.create", { projectId: "project:a", changeId: "change:b", intentId: "intent:b" }), idempotencyKey: "idempotency:change.create:change-b" }, session);
  coordinator.execute({ ...command("change.create", { projectId: "project:b", changeId: "change:project-b", intentId: "intent:project-b" }), idempotencyKey: "idempotency:change.create:project-b" }, session);
  coordinator.execute({ ...command("pullRequest.open", { projectId: "project:b", pullRequestId: "pull-request:b", changeId: "change:project-b", provider: "local", headRef: "refs/heads/feature", baseRef: "refs/heads/main", headCommit: "commit:b", baseCommit: "commit:base", title: "Project B" }), idempotencyKey: "idempotency:pull-request:project-b" }, session);
  return coordinator.snapshot();
}

function authorize(input: Partial<Parameters<typeof authorizeMcpCommandTarget>[0]> & { command: AuthorityCommand }) {
  const state = input.snapshot ?? snapshot();
  const viewId = Object.values(state.projectViews).find((view) => view.projectId === "project:a")?.id;
  const projectViewId = input.command.payload.projectViewId;
  const normalizedCommand = projectViewId === "view:a" || projectViewId === "workspace:a:view"
    ? { ...input.command, payload: { ...input.command.payload, ...(viewId ? { projectViewId: viewId } : {}) } }
    : input.command;
  return authorizeMcpCommandTarget({
    snapshot: state,
    grantId: "grant:a",
    grantResource: { realmId: session.realmId, projectId: "project:a", workspaceId: "workspace:a", changeId: "change:a" },
    grantSourceSpaceIds: ["source:a-public"],
    ...input,
    command: normalizedCommand,
  });
}

test("MCP target authorization rejects a Project B payload under a Project A grant", () => {
  const result = authorize({ command: command("intent.create", { projectId: "project:b", intentId: "intent:b", title: "cross-project" }) });
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.match(result.receipt, /mismatch/);
});

test("MCP target authorization rejects a Change B payload under a Change A grant", () => {
  const result = authorize({ command: command("revision.publish", { projectId: "project:a", changeId: "change:b", projectViewId: "view:a", projectRevisionId: "candidate:b", sourceSpaceSnapshots: { "source:a-public": "git:b" }, declaredEffects: ["source.modify"] }) });
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.match(result.receipt, /change-target-mismatch/);
});

test("MCP target authorization rejects a restricted Source Space outside the grant", () => {
  const state = snapshot();
  state.sourceSpaces["source:a-private"] = { ...state.sourceSpaces["source:a-public"]!, id: "source:a-private", classification: "restricted" };
  state.projects["project:a"] = { ...state.projects["project:a"]!, sourceSpaceIds: ["source:a-public", "source:a-private"] };
  const result = authorize({ snapshot: state, command: command("revision.publish", { projectId: "project:a", changeId: "change:a", workspaceId: "workspace:a", projectViewId: "workspace:a:view", projectRevisionId: "candidate:a", sourceSpaceSnapshots: { "source:a-public": "git:a", "source:a-private": "git:private" }, declaredEffects: ["source.modify"] }) });
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.match(result.receipt, /source-space|project-view/);
});

test("MCP target authorization rejects a forged capability grant embedded in the payload", () => {
  const result = authorize({ command: command("run.request", { projectId: "project:a", projectRevisionId: "project:a:base", projectViewId: "workspace:a:view", actionId: "action:a", actionContractDigest: "sha256:action", inputDigests: [], outputDigests: [], policyVersion: "policy:a", authorizationEpoch: "1", capabilityGrantId: "grant:forged" }) });
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.match(result.receipt, /grant-id-mismatch/);
});

test("MCP target authorization rejects a Pull Request from another Project", () => {
  const result = authorize({ command: command("pullRequest.review", { pullRequestId: "pull-request:b", reviewState: "approved", reviewDigest: "sha256:review" }) });
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.match(result.receipt, /pull-request-project-mismatch|target-mismatch/);
});

test("MCP target authorization rejects a Workspace outside the delegated Change", () => {
  const result = authorize({ command: command("run.request", { projectId: "project:a", workspaceId: "workspace:other", projectRevisionId: "project:a:base", projectViewId: "workspace:a:view", actionId: "action:a", actionContractDigest: "sha256:action", inputDigests: [], outputDigests: [], policyVersion: "policy:a", authorizationEpoch: "1", capabilityGrantId: "grant:a" }) });
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.match(result.receipt, /workspace-target-mismatch|workspace-project-view-mismatch/);
});

test("MCP target authorization returns a sanitized command for an exact delegated target", () => {
  const result = authorize({ command: command("intent.create", { projectId: "project:a", intentId: "intent:valid", title: "valid" }) });
  assert.equal(result.allowed, true);
  if (result.allowed) {
    assert.equal(result.command.payload.projectId, "project:a");
    assert.deepEqual(result.sourceSpaceIds, ["source:a-public"]);
  }
});

test("MCP target authorization accepts an exact disclosed revision publication", () => {
  const state = snapshot();
  const projectViewId = Object.values(state.projectViews).find((view) => view.projectId === "project:a")?.id;
  assert.ok(projectViewId);
  const result = authorize({ snapshot: state, command: command("revision.publish", { projectId: "project:a", changeId: "change:a", workspaceId: "workspace:a", projectViewId, projectRevisionId: "candidate:a", sourceSpaceSnapshots: { "source:a-public": "git:a" }, declaredEffects: ["source.modify"] }) });
  assert.equal(result.allowed, true);
  if (result.allowed) assert.deepEqual(result.sourceSpaceIds, ["source:a-public"]);
});
