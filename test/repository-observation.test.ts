import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { LocalGitRepositoryDriver } from "../src/portability/local-git.ts";
import { LocalProjectExporter, verifyProjectExportPackage } from "../src/portability/project-export.ts";
import { InMemoryRepositoryDriver } from "../src/harness/adapters.ts";
import { AUTHORITY_COMMAND_PROTOCOL, AuthorityPlaneCoordinator, emptyAuthorityPlaneSnapshot, type AuthoritySession } from "../src/cloudflare/authority-plane.ts";
import { parseRepositoryObservation, repositoryObservationDigest, verifyRepositoryObservation } from "../src/portability/repository-observation.ts";

const execFile = promisify(execFileCallback);

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: directory });
  return result.stdout.trim();
}

test("LocalGitRepositoryDriver observes the exact commit, tree, object format, ref, and ancestry", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-repository-observation-"));
  try {
    const driver = new LocalGitRepositoryDriver(root);
    const created = await driver.createRepository({ sourceSpaceId: "source:app", directory: join(root, "workspace") });
    assert.equal(created.status, "succeeded");
    if (created.status !== "succeeded") return;
    const directory = join(root, "workspace");
    await git(directory, "config", "user.name", "Anyam Test");
    await git(directory, "config", "user.email", "anyam-test@example.invalid");
    await writeFile(join(directory, "README.md"), "base\n");
    const firstCommit = await git(directory, "add", "README.md").then(() => git(directory, "commit", "-m", "base")).then(() => git(directory, "rev-parse", "HEAD"));
    await writeFile(join(directory, "README.md"), "candidate\n");
    await git(directory, "add", "README.md");
    await git(directory, "commit", "-m", "candidate");
    const commitOid = await git(directory, "rev-parse", "HEAD");
    const treeOid = await git(directory, "rev-parse", "HEAD^{tree}");
    const inspected = await driver.inspectRepository({ repository: created.value });
    assert.equal(inspected.status, "succeeded");
    if (inspected.status !== "succeeded") return;
    const observed = await driver.observeRepository({
      repository: created.value,
      workspaceId: "workspace:app",
      projectViewId: "view:app",
      expectedCommitOid: commitOid,
      expectedTreeOid: treeOid,
      expectedBaseCommitOid: firstCommit,
      expectedObjectFormat: inspected.value.objectFormat,
    });
    assert.equal(observed.status, "succeeded");
    if (observed.status !== "succeeded") return;
    assert.equal(observed.value.repositoryId, created.value.repositoryId);
    assert.equal(observed.value.sourceSpaceId, created.value.sourceSpaceId);
    assert.equal(observed.value.workspaceId, "workspace:app");
    assert.equal(observed.value.projectViewId, "view:app");
    assert.equal(observed.value.commitOid, commitOid);
    assert.equal(observed.value.treeOid, treeOid);
    assert.equal(observed.value.baseCommitOid, firstCommit);
    assert.equal(observed.value.ancestryVerified, true);
    assert.match(observed.value.manifestDigest, /^sha256:[0-9a-f]{64}$/u);
    const { manifestDigest: _manifestDigest, ...claims } = observed.value;
    assert.equal(observed.value.manifestDigest, await repositoryObservationDigest(claims));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository observation fails closed when the expected Git object or ancestry differs", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-repository-observation-mismatch-"));
  try {
    const driver = new LocalGitRepositoryDriver(root);
    const created = await driver.createRepository({ sourceSpaceId: "source:app", directory: join(root, "workspace") });
    assert.equal(created.status, "succeeded");
    if (created.status !== "succeeded") return;
    const directory = join(root, "workspace");
    await writeFile(join(directory, "README.md"), "candidate\n");
    const committed = await driver.commitRepository({ repository: created.value, message: "candidate" });
    assert.equal(committed.status, "succeeded");
    if (committed.status !== "succeeded") return;
    const inspected = await driver.inspectRepository({ repository: created.value });
    assert.equal(inspected.status, "succeeded");
    if (inspected.status !== "succeeded") return;
    const treeOid = await git(directory, "rev-parse", "HEAD^{tree}");
    const wrongCommit = await driver.observeRepository({ repository: created.value, workspaceId: "workspace:app", projectViewId: "view:app", expectedCommitOid: "0000000000000000000000000000000000000000", expectedTreeOid: treeOid, expectedBaseCommitOid: committed.value.commitId, expectedObjectFormat: inspected.value.objectFormat });
    assert.equal(wrongCommit.status, "failed");
    if (wrongCommit.status === "failed") assert.equal(wrongCommit.errorCode, "repository.observation_commit_mismatch");
    const wrongBase = await driver.observeRepository({ repository: created.value, workspaceId: "workspace:app", projectViewId: "view:app", expectedCommitOid: committed.value.commitId, expectedTreeOid: treeOid, expectedBaseCommitOid: "0000000000000000000000000000000000000000", expectedObjectFormat: inspected.value.objectFormat });
    assert.equal(wrongBase.status, "failed");
    if (wrongBase.status === "failed") assert.equal(wrongBase.errorCode, "repository.observation_ancestry_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository observation parsing rejects malformed and forged digests", async () => {
  const malformed = parseRepositoryObservation({ protocol: "anyam.repository-observation/v1", repositoryId: "repo", sourceSpaceId: "source", workspaceId: "workspace", projectViewId: "view", objectFormat: "sha1", symbolicRef: "main", commitOid: "0".repeat(40), treeOid: "1".repeat(40), baseCommitOid: "2".repeat(40), ancestryVerified: true, manifestDigest: "sha256:not-a-digest", observedAt: new Date().toISOString(), receipt: "test" });
  assert.equal(malformed.valid, false);
  const claims = { protocol: "anyam.repository-observation/v1" as const, repositoryId: "repo", sourceSpaceId: "source", workspaceId: "workspace", projectViewId: "view", objectFormat: "sha1" as const, symbolicRef: "main", commitOid: "0".repeat(40), treeOid: "1".repeat(40), baseCommitOid: "2".repeat(40), ancestryVerified: true as const, observedAt: new Date().toISOString(), receipt: "test" };
  const observation = { ...claims, manifestDigest: await repositoryObservationDigest(claims) };
  const forged = await verifyRepositoryObservation({ observation: { ...observation, commitOid: "3".repeat(40) }, repositoryId: "repo", sourceSpaceId: "source", workspaceId: "workspace", projectViewId: "view", expectedCommitOid: claims.commitOid, expectedBaseCommitOid: claims.baseCommitOid });
  assert.equal(forged.valid, false);
});

test("Authority stores only observations bound to the Project, Workspace, View, Repository, and base", async () => {
  const session: AuthoritySession = { realmId: "realm:repository-observation", principalId: "principal:owner", actorId: "actor:owner", sessionId: "session:owner", clientId: "client:test", authorizationEpoch: 1 };
  const authority = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  const command = (name: "project.create" | "workspace.create" | "change.create" | "revision.publish" | "landing.apply", idempotencyKey: string, payload: Record<string, unknown>) => authority.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: name, idempotencyKey, payload }, session);
  command("project.create", "project:create", { projectId: "project:app", name: "App", referenceType: "git", sourceSpaces: [{ id: "source:app", name: "App source", classification: "restricted", repositoryId: "repo:app", snapshotId: "0".repeat(40) }], projectRevisionId: "revision:base" });
  const workspace = command("workspace.create", "workspace:create", { projectId: "project:app", workspaceId: "workspace:app", projectRevisionId: "revision:base", sourceSpaceIds: ["source:app"], mounts: ["source"], changeId: "change:app" });
  assert.equal(workspace.status, "succeeded");
  if (workspace.status !== "succeeded") return;
  command("change.create", "change:create", { projectId: "project:app", changeId: "change:app", intentId: "intent:app", baseProjectRevisionId: "revision:base", workspaceId: "workspace:app" });
  const viewId = typeof workspace.value.view === "object" && workspace.value.view !== null && "id" in workspace.value.view && typeof workspace.value.view.id === "string" ? workspace.value.view.id : "";
  assert.ok(viewId);
  const claims = { protocol: "anyam.repository-observation/v1" as const, repositoryId: "repo:app", sourceSpaceId: "source:app", workspaceId: "workspace:app", projectViewId: viewId, objectFormat: "sha1" as const, symbolicRef: "main", commitOid: "1".repeat(40), treeOid: "2".repeat(40), baseCommitOid: "0".repeat(40), ancestryVerified: true as const, observedAt: new Date().toISOString(), receipt: "provider=test; ancestry=verified" };
  const observation = { ...claims, manifestDigest: await repositoryObservationDigest(claims) };
  const published = command("revision.publish", "revision:publish", { projectId: "project:app", changeId: "change:app", revisionId: "change-revision:app", workspaceId: "workspace:app", projectViewId: viewId, projectRevisionId: "revision:candidate", sourceSpaceSnapshots: { "source:app": claims.commitOid }, sourceSpaceObservations: { "source:app": observation }, declaredEffects: ["source.modify"] });
  assert.equal(published.status, "succeeded");
  if (published.status !== "succeeded") return;
  if (published.value === null || typeof published.value !== "object") throw new Error("authority revision result missing");
  const publishedValue = Object.fromEntries(Object.entries(published.value));
  if (publishedValue.revision === null || typeof publishedValue.revision !== "object") throw new Error("authority revision projection missing");
  const publishedRevision = Object.fromEntries(Object.entries(publishedValue.revision));
  if (publishedRevision.sourceSpaceObservations === null || typeof publishedRevision.sourceSpaceObservations !== "object") throw new Error("repository observation was not stored");
  const publishedObservations = Object.fromEntries(Object.entries(publishedRevision.sourceSpaceObservations));
  if (publishedObservations["source:app"] === null || typeof publishedObservations["source:app"] !== "object") throw new Error("repository observation projection missing");
  assert.equal(Object.fromEntries(Object.entries(publishedObservations["source:app"])).manifestDigest, observation.manifestDigest);
  const landed = command("landing.apply", "landing:apply", { projectId: "project:app", changeId: "change:app", changeRevisionId: "change-revision:app", expectedCanonicalProjectRevisionId: "revision:base", projectRevisionId: "revision:landed" });
  assert.equal(landed.status, "succeeded");
  assert.equal(authority.snapshot().changeRevisions["change-revision:app"]?.sourceSpaceObservations?.["source:app"]?.manifestDigest, observation.manifestDigest);
  assert.throws(() => command("revision.publish", "revision:forged", { projectId: "project:app", changeId: "change:app", workspaceId: "workspace:app", projectViewId: viewId, projectRevisionId: "revision:forged", sourceSpaceSnapshots: { "source:app": claims.commitOid }, sourceSpaceObservations: { "source:app": { ...observation, repositoryId: "repo:other" } }, declaredEffects: ["source.modify"] }));
});

test("Project Export carries the Change Revision observation digest through recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-repository-observation-export-"));
  try {
    const project = { protocol: "anyam.project/v1" as const, id: "project:export", name: "Export", referenceType: "git", sourceSpaceIds: ["source:export"] };
    const sourceSpace = { protocol: "anyam.source-space/v1" as const, id: "source:export", name: "Export source", classification: "restricted" as const, repositoryId: "repo:export" };
    const claims = { protocol: "anyam.repository-observation/v1" as const, repositoryId: "repo:export", sourceSpaceId: "source:export", workspaceId: "workspace:export", projectViewId: "view:export", objectFormat: "sha1" as const, symbolicRef: "main", commitOid: "4".repeat(40), treeOid: "5".repeat(40), baseCommitOid: "6".repeat(40), ancestryVerified: true as const, observedAt: new Date().toISOString(), receipt: "provider=test; ancestry=verified" };
    const observation = { ...claims, manifestDigest: await repositoryObservationDigest(claims) };
    const changeRevision = { protocol: "anyam.change/v1" as const, id: "change-revision:export", changeId: "change:export", projectRevisionId: "revision:export", projectViewId: "view:export", sequence: 1, parentRevisionId: undefined, declaredEffects: ["source.modify"], baseProjectRevisionId: "revision:base", workspaceId: "workspace:export", sourceSpaceSnapshots: { "source:export": claims.commitOid }, sourceSpaceObservations: { "source:export": observation }, affectedSourceSpaceIds: ["source:export"] };
    const exported = await new LocalProjectExporter(new InMemoryRepositoryDriver()).exportProject({ project, sourceSpaces: [sourceSpace], repositories: [], destination: root, changeRevisions: [changeRevision] });
    assert.equal(exported.status, "succeeded");
    if (exported.status !== "succeeded") return;
    const verified = await verifyProjectExportPackage(root);
    assert.equal(verified.status, "succeeded");
    if (verified.status !== "succeeded") return;
    assert.equal(verified.value.changeRevisions[0]?.sourceSpaceObservations?.["source:export"]?.manifestDigest, observation.manifestDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
