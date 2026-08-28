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

const session: AuthoritySession = { realmId: "realm:lineage", principalId: "principal:owner", actorId: "actor:owner", sessionId: "session:owner", clientId: "client:test", authorizationEpoch: 1, kind: "human" };

function command(coordinator: AuthorityPlaneCoordinator, name: AuthorityCommandName, idempotencyKey: string, payload: Record<string, unknown>) {
  return coordinator.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: name, idempotencyKey, payload }, session);
}

function fixture(): { coordinator: AuthorityPlaneCoordinator; snapshot: ReturnType<AuthorityPlaneCoordinator["snapshot"]> } {
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  assert.equal(command(coordinator, "project.create", "lineage:project", { projectId: "project:lineage", name: "Lineage", referenceType: "git", sourceSpaces: [{ id: "source:lineage", name: "source", classification: "public", snapshotId: "commit:base" }], projectRevisionId: "revision:base" }).status, "succeeded");
  assert.equal(command(coordinator, "workspace.create", "lineage:workspace", { projectId: "project:lineage", workspaceId: "workspace:lineage", projectRevisionId: "revision:base", sourceSpaceIds: ["source:lineage"], mounts: ["source"] }).status, "succeeded");
  const snapshot = coordinator.snapshot();
  snapshot.projectRevisions["revision:other"] = { protocol: "anyam.kernel/v1", id: "revision:other", projectId: "project:lineage", sourceSpaceSnapshots: { "source:lineage": "commit:other" } };
  return { coordinator: new AuthorityPlaneCoordinator(snapshot), snapshot };
}

test("Workspace creation cannot accept a speculative Change binding", () => {
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  assert.equal(command(coordinator, "project.create", "lineage:workspace-project", { projectId: "project:workspace", name: "Workspace", referenceType: "git", sourceSpaces: [{ id: "source:workspace", name: "source", classification: "public", snapshotId: "commit:base" }], projectRevisionId: "revision:workspace-base" }).status, "succeeded");
  assert.throws(() => command(coordinator, "workspace.create", "lineage:speculative", { projectId: "project:workspace", workspaceId: "workspace:speculative", projectRevisionId: "revision:workspace-base", sourceSpaceIds: ["source:workspace"], changeId: "change:invented" }), (error: unknown) => error instanceof AuthorityPlaneError && error.code === "invalid_request" && error.receipt.includes("workspaceBinding=change-create-only"));
  assert.equal(Object.keys(coordinator.snapshot().workspaces).length, 0);
});

test("Authority Workspace creation enforces a complete cross-platform mount bijection", () => {
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  assert.equal(command(coordinator, "project.create", "mounts:project", {
    projectId: "project:mounts",
    name: "Mounts",
    referenceType: "git",
    sourceSpaces: [
      { id: "source:one", name: "One", classification: "public", snapshotId: "commit:one" },
      { id: "source:two", name: "Two", classification: "public", snapshotId: "commit:two" },
    ],
    projectRevisionId: "revision:mounts",
  }).status, "succeeded");

  assert.throws(
    () => command(coordinator, "workspace.create", "mounts:missing", { projectId: "project:mounts", projectRevisionId: "revision:mounts", sourceSpaceIds: ["source:one", "source:two"], mounts: ["one"] }),
    (error: unknown) => error instanceof AuthorityPlaneError && error.code === "invalid_request" && error.receipt.includes("mount-count-mismatch"),
  );
  assert.throws(
    () => command(coordinator, "workspace.create", "mounts:duplicate", { projectId: "project:mounts", projectRevisionId: "revision:mounts", sourceSpaceIds: ["source:one", "source:one"], mounts: ["one", "two"] }),
    (error: unknown) => error instanceof AuthorityPlaneError && error.code === "invalid_request" && error.receipt.includes("source-space-duplicate"),
  );
  assert.throws(
    () => command(coordinator, "workspace.create", "mounts:case", { projectId: "project:mounts", projectRevisionId: "revision:mounts", sourceSpaceIds: ["source:one", "source:two"], mounts: ["Public\\Web", "public/web"] }),
    (error: unknown) => error instanceof AuthorityPlaneError && error.code === "invalid_request" && error.receipt.includes("mount-path-duplicate"),
  );
  assert.equal(Object.keys(coordinator.snapshot().workspaces).length, 0);
});

test("Change creation requires matching active Workspace/View lineage and cannot steal a Workspace", () => {
  const { coordinator } = fixture();
  assert.throws(() => command(coordinator, "change.create", "lineage:mismatch", { projectId: "project:lineage", changeId: "change:mismatch", intentId: "intent:mismatch", baseProjectRevisionId: "revision:other", workspaceId: "workspace:lineage" }), (error: unknown) => error instanceof AuthorityPlaneError && error.code === "conflict" && error.receipt.includes("workspaceBase=revision:base") && error.receipt.includes("changeBase=revision:other"));
  assert.equal(command(coordinator, "change.create", "lineage:valid", { projectId: "project:lineage", changeId: "change:valid", intentId: "intent:valid", baseProjectRevisionId: "revision:base", workspaceId: "workspace:lineage" }).status, "succeeded");
  assert.throws(() => command(coordinator, "change.create", "lineage:steal", { projectId: "project:lineage", changeId: "change:steal", intentId: "intent:steal", baseProjectRevisionId: "revision:base", workspaceId: "workspace:lineage" }), (error: unknown) => error instanceof AuthorityPlaneError && error.code === "conflict" && error.receipt.includes("workspaceChange=change:valid"));
  assert.equal(coordinator.snapshot().workspaces["workspace:lineage"]?.changeId, "change:valid");
});

test("Change creation rejects inactive Workspaces and replays without duplicating the binding", () => {
  const { snapshot } = fixture();
  const inactiveSnapshot = { ...snapshot, workspaces: { ...snapshot.workspaces, "workspace:lineage": { ...snapshot.workspaces["workspace:lineage"]!, state: "closed" as const } } };
  const inactive = new AuthorityPlaneCoordinator(inactiveSnapshot);
  assert.throws(() => command(inactive, "change.create", "lineage:inactive", { projectId: "project:lineage", changeId: "change:inactive", intentId: "intent:inactive", baseProjectRevisionId: "revision:base", workspaceId: "workspace:lineage" }), (error: unknown) => error instanceof AuthorityPlaneError && error.code === "conflict" && error.receipt.includes("workspaceState=closed"));

  const { coordinator } = fixture();
  const created = command(coordinator, "change.create", "lineage:replay", { projectId: "project:lineage", changeId: "change:replay", intentId: "intent:replay", baseProjectRevisionId: "revision:base", workspaceId: "workspace:lineage" });
  const replayed = command(coordinator, "change.create", "lineage:replay", { projectId: "project:lineage", changeId: "change:replay", intentId: "intent:replay", baseProjectRevisionId: "revision:base", workspaceId: "workspace:lineage" });
  assert.deepEqual(replayed, created);
  assert.deepEqual(Object.keys(coordinator.snapshot().changes), ["change:replay"]);
});

test("serialized Change creation lets only one concurrent claimant bind a Workspace", async () => {
  const { coordinator } = fixture();
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => command(coordinator, "change.create", "lineage:concurrent-a", { projectId: "project:lineage", changeId: "change:concurrent-a", intentId: "intent:concurrent-a", baseProjectRevisionId: "revision:base", workspaceId: "workspace:lineage" })),
    Promise.resolve().then(() => command(coordinator, "change.create", "lineage:concurrent-b", { projectId: "project:lineage", changeId: "change:concurrent-b", intentId: "intent:concurrent-b", baseProjectRevisionId: "revision:base", workspaceId: "workspace:lineage" })),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  const snapshot = coordinator.snapshot();
  const boundChange = snapshot.workspaces["workspace:lineage"]?.changeId;
  assert.ok(boundChange === "change:concurrent-a" || boundChange === "change:concurrent-b");
  assert.deepEqual(Object.keys(snapshot.changes), [boundChange]);
});

test("Authority restore rejects a Workspace/View/Change lineage mismatch", () => {
  const { coordinator } = fixture();
  assert.equal(command(coordinator, "change.create", "lineage:restore-change", { projectId: "project:lineage", changeId: "change:restore", intentId: "intent:restore", baseProjectRevisionId: "revision:base", workspaceId: "workspace:lineage" }).status, "succeeded");
  const malformed = coordinator.snapshot();
  malformed.workspaces["workspace:lineage"] = { ...malformed.workspaces["workspace:lineage"]!, projectRevisionId: "revision:other" };
  assert.throws(() => new AuthorityPlaneCoordinator(malformed), (error: unknown) => error instanceof AuthorityPlaneError && error.code === "indeterminate" && error.receipt.includes("restore=blocked"));

  const malformedChange = coordinator.snapshot();
  malformedChange.changes["change:restore"] = { ...malformedChange.changes["change:restore"]!, baseProjectRevisionId: "revision:missing" };
  assert.throws(() => new AuthorityPlaneCoordinator(malformedChange), (error: unknown) => error instanceof AuthorityPlaneError && error.code === "indeterminate" && error.receipt.includes("change=change:restore"));
});

test("Authority restore rejects non-canonical or stale Workspace mounts", () => {
  const { snapshot } = fixture();
  const workspace = snapshot.workspaces["workspace:lineage"]!;
  const malformed = {
    ...snapshot,
    workspaces: {
      ...snapshot.workspaces,
      "workspace:lineage": {
        ...workspace,
        mounts: [{ ...workspace.mounts[0]!, mountPath: "source\\nested" }],
      },
    },
  };
  assert.throws(
    () => new AuthorityPlaneCoordinator(malformed),
    (error: unknown) => error instanceof AuthorityPlaneError && error.code === "indeterminate" && error.receipt.includes("mount=stale-or-noncanonical"),
  );
});
