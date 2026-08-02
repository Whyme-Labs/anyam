import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ChangeControlError,
  LocalChangeCoordinator,
  type WorkspaceSource,
} from "../src/change-control/local.ts";
import {
  createProject,
  createProjectRevision,
  deriveProjectView,
  type Project,
  type ProjectRevision,
  type SourceSpace,
} from "../src/kernel/contracts.ts";

const project: Project = createProject({
  id: "project:video-player",
  name: "Video Player",
  referenceType: "typescript-library",
  sourceSpaceIds: ["public-player", "private-codec"],
});

const sourceSpaces: readonly SourceSpace[] = [
  { protocol: "anyam.source-space/v1", id: "public-player", name: "Public Player", classification: "public" },
  { protocol: "anyam.source-space/v1", id: "private-codec", name: "Private Codec", classification: "restricted" },
];

const sources: readonly WorkspaceSource[] = [
  {
    sourceSpaceId: "public-player",
    snapshotId: "snapshot:public:v1",
    files: { "src/player.ts": "export const player = true;\n" },
  },
  {
    sourceSpaceId: "private-codec",
    snapshotId: "snapshot:private:v1",
    files: { "src/codec.ts": "export const codec = \"private\";\n" },
  },
];

function canonicalRevision(): ProjectRevision {
  return createProjectRevision({
    id: "project-revision:base",
    projectId: project.id,
    sourceSpaceSnapshots: {
      "public-player": "snapshot:public:v1",
      "private-codec": "snapshot:private:v1",
    },
  });
}

function viewFor(revision: ProjectRevision, classification: "public" | "project", ids: readonly string[]) {
  return deriveProjectView({
    project,
    revision,
    sourceSpaces,
    allowedSourceSpaceIds: ids,
    projectionId: `${classification}-video-player`,
    classification,
  });
}

async function temporaryDirectory(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `anyam-${name}-`));
}

function coordinator(): LocalChangeCoordinator {
  return new LocalChangeCoordinator({ project, sourceSpaces, canonicalRevision: canonicalRevision() });
}

test("materializes only the authorized Project View without private metadata", async () => {
  const target = await temporaryDirectory("public-parent");
  const directory = join(target, "workspace");
  try {
    const control = coordinator();
    const result = await control.createWorkspace({
      view: viewFor(canonicalRevision(), "public", ["public-player"]),
      sources,
      mounts: [{ sourceSpaceId: "public-player", mountPath: "source" }],
      directory,
      actorId: "actor:public-agent",
    });

    assert.deepEqual(result.workspace.mounts, [{
      sourceSpaceId: "public-player",
      snapshotId: "snapshot:public:v1",
      mountPath: "source",
    }]);
    assert.equal(JSON.stringify(result.workspace).includes("private-codec"), false);
    assert.equal(JSON.stringify(await readdir(directory, { recursive: true })).includes("private-codec"), false);
    assert.equal(await readFile(join(directory, "source/src/player.ts"), "utf8"), "export const player = true;\n");
    await assert.rejects(
      readFile(join(directory, "private-codec/src/codec.ts"), "utf8"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    );
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("does not turn an unauthorized mount request into a Source Space metadata oracle", async () => {
  const target = await temporaryDirectory("unauthorized-parent");
  const directory = join(target, "workspace");
  try {
    const control = coordinator();
    await assert.rejects(
      control.createWorkspace({
        view: viewFor(canonicalRevision(), "public", ["public-player"]),
        sources,
        mounts: [
          { sourceSpaceId: "public-player", mountPath: "source" },
          { sourceSpaceId: "private-codec", mountPath: "private" },
        ],
        directory,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ChangeControlError);
        assert.equal(error.code, "workspace-source-not-authorized");
        assert.equal(JSON.stringify(error).includes("private-codec"), false);
        return true;
      },
    );
    await assert.rejects(
      readdir(directory),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    );
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("rejects traversal in Source Space mounts before writing files", async () => {
  const target = await temporaryDirectory("traversal-parent");
  const directory = join(target, "workspace");
  try {
    const control = coordinator();
    await assert.rejects(
      control.createWorkspace({
        view: viewFor(canonicalRevision(), "public", ["public-player"]),
        sources,
        mounts: [{ sourceSpaceId: "public-player", mountPath: "safe/../escape" }],
        directory,
      }),
      (error: unknown) => error instanceof ChangeControlError && error.code === "workspace-mount-invalid",
    );
    await assert.rejects(
      readdir(directory),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    );
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("rejects overlapping mounts before touching the Workspace target", async () => {
  const target = await temporaryDirectory("collision-parent");
  const directory = join(target, "workspace");
  const control = coordinator();
  await assert.rejects(
    control.createWorkspace({
      view: viewFor(canonicalRevision(), "project", ["public-player", "private-codec"]),
      sources,
      mounts: [
        { sourceSpaceId: "public-player", mountPath: "source" },
        { sourceSpaceId: "private-codec", mountPath: "source/private" },
      ],
      directory,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ChangeControlError);
      assert.equal(error.code, "workspace-mount-collision");
      assert.match(error.recoveryAction, /non-overlapping/);
      assert.match(error.receipt, /mount-a=source/);
      return true;
    },
  );
  await assert.rejects(
    readdir(directory),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
  await rm(target, { recursive: true, force: true });
});

test("keeps one stable Change identity through revisions, conflict resolution, handoff, and rebase", async () => {
  const root = await temporaryDirectory("stable-change");
  try {
    const control = coordinator();
    const baseView = viewFor(canonicalRevision(), "project", ["public-player", "private-codec"]);
    const firstWorkspace = await control.createWorkspace({
      view: baseView,
      sources,
      mounts: [
        { sourceSpaceId: "public-player", mountPath: "public" },
        { sourceSpaceId: "private-codec", mountPath: "private" },
      ],
      directory: join(root, "workspace-one"),
      actorId: "actor:codex",
    });
    const change = control.createChange({ intentId: "intent:add-codec", workspaceId: firstWorkspace.workspace.id });
    const first = control.publishRevision({ changeId: change.id, declaredEffects: ["source.modify"] });
    assert.equal(first.sequence, 1);

    const conflict = control.registerConflict({
      changeId: change.id,
      workspaceId: firstWorkspace.workspace.id,
      kind: "structural",
      sourceSpaceIds: ["public-player", "private-codec"],
      paths: ["public/src/player.ts", "private/src/codec.ts"],
      description: "Both spaces changed the same exported player contract.",
    });
    await assert.rejects(
      Promise.resolve().then(() => control.publishRevision({ changeId: change.id, declaredEffects: ["source.modify"] })),
      (error: unknown) => error instanceof ChangeControlError && error.code === "conflict-open",
    );
    const resolved = control.resolveConflict({ conflictId: conflict.id, resolutionNote: "Reconciled public contract." });
    assert.equal(resolved.state, "resolved");
    const second = control.publishRevision({
      changeId: change.id,
      declaredEffects: ["source.modify", "contract.modify"],
      kind: "conflict-resolution",
    });
    assert.equal(second.changeId, change.id);
    assert.equal(second.sequence, 2);
    assert.equal(second.parentRevisionId, first.id);
    assert.equal(control.getChange(change.id)?.id, change.id);
    assert.equal(control.handoffChange({ changeId: change.id, actorId: "actor:claude" }).actorId, "actor:claude");

    const rebased = await control.rebaseChange({
      changeId: change.id,
      view: baseView,
      sources,
      mounts: [
        { sourceSpaceId: "public-player", mountPath: "public" },
        { sourceSpaceId: "private-codec", mountPath: "private" },
      ],
      directory: join(root, "workspace-rebased"),
      actorId: "actor:claude",
      declaredEffects: ["source.modify"],
    });
    assert.equal(rebased.revision.changeId, change.id);
    assert.equal(rebased.revision.sequence, 3);
    assert.equal(rebased.revision.kind, "rebase");
    assert.equal(control.getChange(change.id)?.latestRevisionId, rebased.revision.id);
    assert.equal(control.getRevision(first.id)?.id, first.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lands through compare-and-swap and preserves canonical lineage while rejecting stale state", async () => {
  const root = await temporaryDirectory("landing");
  try {
    const control = coordinator();
    const baseRevision = canonicalRevision();
    const view = viewFor(baseRevision, "project", ["public-player", "private-codec"]);
    const workspace = await control.createWorkspace({
      view,
      sources,
      mounts: [
        { sourceSpaceId: "public-player", mountPath: "public" },
        { sourceSpaceId: "private-codec", mountPath: "private" },
      ],
      directory: join(root, "workspace-land"),
    });
    const change = control.createChange({ intentId: "intent:land", workspaceId: workspace.workspace.id });
    const revision = control.publishRevision({ changeId: change.id, declaredEffects: ["source.modify"] });
    const landing = control.landChange({
      changeId: change.id,
      changeRevisionId: revision.id,
      expectedCanonicalProjectRevisionId: baseRevision.id,
    });
    assert.equal(landing.previousProjectRevisionId, baseRevision.id);
    assert.equal(control.canonicalRevision.parentProjectRevisionId, baseRevision.id);
    assert.equal(control.canonicalRevision.landedChangeRevisionId, revision.id);
    assert.equal(control.getChange(change.id)?.status, "landed");

    const staleWorkspace = await control.createWorkspace({
      view,
      sources,
      mounts: [
        { sourceSpaceId: "public-player", mountPath: "public" },
        { sourceSpaceId: "private-codec", mountPath: "private" },
      ],
      directory: join(root, "workspace-stale"),
    });
    const staleChange = control.createChange({ intentId: "intent:stale", workspaceId: staleWorkspace.workspace.id });
    const staleRevision = control.publishRevision({ changeId: staleChange.id, declaredEffects: ["source.modify"] });
    const currentBefore = control.canonicalRevision.id;
    await assert.rejects(
      Promise.resolve().then(() => control.landChange({
        changeId: staleChange.id,
        changeRevisionId: staleRevision.id,
        expectedCanonicalProjectRevisionId: baseRevision.id,
      })),
      (error: unknown) => {
        assert.ok(error instanceof ChangeControlError);
        assert.equal(error.code, "stale-canonical-revision");
        assert.match(error.recoveryAction, /rebase/);
        return true;
      },
    );
    assert.equal(control.canonicalRevision.id, currentBefore);
    assert.equal(control.getChange(staleChange.id)?.status, "submitted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("makes disclosure conflicts explicit and records a new Change for reverts", async () => {
  const root = await temporaryDirectory("disclosure");
  try {
    const control = coordinator();
    const view = viewFor(canonicalRevision(), "project", ["public-player", "private-codec"]);
    const workspace = await control.createWorkspace({
      view,
      sources,
      mounts: [
        { sourceSpaceId: "public-player", mountPath: "public" },
        { sourceSpaceId: "private-codec", mountPath: "private" },
      ],
      directory: join(root, "workspace"),
    });
    const change = control.createChange({ intentId: "intent:publish", workspaceId: workspace.workspace.id });
    const disclosure = control.registerConflict({
      changeId: change.id,
      workspaceId: workspace.workspace.id,
      kind: "disclosure",
      sourceSpaceIds: ["private-codec"],
      paths: ["private/src/codec.ts"],
      description: "A proposed public projection would disclose restricted codec code.",
    });
    assert.equal(disclosure.kind, "disclosure");
    await assert.rejects(
      Promise.resolve().then(() => control.publishRevision({ changeId: change.id, declaredEffects: ["source.modify"] })),
      (error: unknown) => error instanceof ChangeControlError && error.code === "conflict-open",
    );
    control.resolveConflict({ conflictId: disclosure.id });
    const revision = control.publishRevision({ changeId: change.id, declaredEffects: ["source.modify"] });
    const landing = control.landChange({
      changeId: change.id,
      changeRevisionId: revision.id,
      expectedCanonicalProjectRevisionId: control.canonicalRevision.id,
    });
    const reverted = control.revertChange({ landedChangeRevisionId: revision.id, intentId: "intent:revert" });
    assert.notEqual(reverted.id, change.id);
    assert.equal(reverted.status, "active");
    assert.equal(reverted.baseProjectRevisionId, landing.projectRevisionId);
    assert.equal(reverted.revertsChangeRevisionId, revision.id);
    assert.equal(control.getChange(change.id)?.status, "landed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
