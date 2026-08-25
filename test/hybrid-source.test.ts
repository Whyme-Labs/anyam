import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTRACT_VERSIONS,
  EvidenceLedger,
  LocalGitRepositoryDriver,
  appealSealedVerification,
  approvePublicationChange,
  createProject,
  createProjectRevision,
  createPublicProjection,
  createPublicationChange,
  landPublicationChange,
  materializePublicProjection,
  previewPublicationChange,
  revokePublicationChange,
  runSealedVerifier,
  summarizeChangeForAudience,
  summarizeIntentForAudience,
  summarizePullRequestForAudience,
  type ChangeRevision,
  type Intent,
  type IntentComment,
  type PullRequest,
  type Project,
  type ProjectRevision,
  type SourceSpace,
} from "../src/index.ts";

const project: Project = createProject({
  id: "project:hybrid-video-player",
  name: "Hybrid Video Player",
  referenceType: "hybrid-public-private",
  sourceSpaceIds: ["public-player", "private-codec"],
});

const sourceSpaces: readonly SourceSpace[] = [
  { protocol: CONTRACT_VERSIONS.sourceSpace, id: "public-player", name: "Public Player", classification: "public" },
  { protocol: CONTRACT_VERSIONS.sourceSpace, id: "private-codec", name: "Private Codec", classification: "restricted" },
];

const publicFiles = {
  "src/player.ts": "export const player = true;\n",
  "README.md": "# Public video player\n",
};

function revision(id: string, privateSnapshot: string): ProjectRevision {
  return createProjectRevision({
    id,
    projectId: project.id,
    sourceSpaceSnapshots: {
      "public-player": "snapshot:public:v1",
      "private-codec": privateSnapshot,
    },
  });
}

function projection(canonicalRevision: ProjectRevision) {
  return createPublicProjection({
    project,
    canonicalRevision,
    sourceSpaces,
    publicSourceSpaceIds: ["public-player"],
    sources: [
      { sourceSpaceId: "public-player", snapshotId: "snapshot:public:v1", files: publicFiles },
      { sourceSpaceId: "private-codec", snapshotId: canonicalRevision.sourceSpaceSnapshots["private-codec"] ?? "", files: { "src/codec.ts": "secret codec" } },
    ],
  });
}

function changeRevision(): ChangeRevision {
  return {
    protocol: CONTRACT_VERSIONS.change,
    id: "change-revision:hybrid-1",
    changeId: "change:hybrid-1",
    projectRevisionId: "project-revision:base",
    projectViewId: "project-view:internal",
    sequence: 1,
    parentRevisionId: undefined,
    declaredEffects: ["public.contract", "private.codec"],
    affectedSourceSpaceIds: ["public-player", "private-codec"],
  };
}

async function temporaryDirectory(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `anyam-hybrid-${name}-`));
}

test("public projection has an independent lineage and no private metadata", () => {
  const first = projection(revision("project-revision:one", "snapshot:private:one"));
  const second = projection(revision("project-revision:two", "snapshot:private:two"));

  assert.equal(first.projectionRevisionId, second.projectionRevisionId);
  assert.equal(first.publicSnapshotId, second.publicSnapshotId);
  assert.notEqual(first.lineageId, "project-revision:one");
  assert.equal(first.sourceSpaceIds.includes("private-codec"), false);
  assert.equal(Object.keys(first.sourceSpaceSnapshots).includes("private-codec"), false);
  assert.equal(JSON.stringify(first).includes("project-revision:one"), false);
  assert.equal(JSON.stringify(first).includes("private-codec"), false);
  assert.equal(JSON.stringify(first).includes("src/codec.ts"), false);
  assert.deepEqual(first.filePaths, ["README.md", "src/player.ts"]);
});

test("public projection rejects restricted Source Spaces without creating a metadata oracle", () => {
  assert.throws(
    () => createPublicProjection({
      project,
      canonicalRevision: revision("project-revision:blocked", "snapshot:private:one"),
      sourceSpaces,
      publicSourceSpaceIds: ["private-codec"],
      sources: [{ sourceSpaceId: "private-codec", snapshotId: "snapshot:private:one", files: { "src/codec.ts": "secret" } }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "HybridDisclosureError");
      assert.equal(JSON.stringify(error).includes("private-codec"), false);
      return true;
    },
  );
});

test("materialized public Git clone contains only the authorized projection", async () => {
  const root = await temporaryDirectory("git");
  try {
    const driver = new LocalGitRepositoryDriver(root);
    const published = await materializePublicProjection({
      projection: projection(revision("project-revision:publish", "snapshot:private:one")),
      driver,
      destination: join(root, "public-repository"),
    });
    const clone = await driver.cloneRepository({
      sourceSpaceId: "public-player",
      source: join(root, "public-repository"),
      destination: join(root, "public-clone"),
    });
    assert.equal(clone.status, "succeeded");
    if (clone.status !== "succeeded") return;
    assert.equal(await readFile(join(root, "public-clone", "src/player.ts"), "utf8"), publicFiles["src/player.ts"]);
    assert.equal(await readFile(join(root, "public-clone", "README.md"), "utf8"), publicFiles["README.md"]);
    await assert.rejects(readFile(join(root, "public-clone", "src/codec.ts")));
    assert.equal(JSON.stringify(published).includes("project-revision:publish"), false);
    assert.equal(JSON.stringify(published.projection).includes("private-codec"), false);
    assert.equal(published.commitId.length > 0, true);
    assert.deepEqual(await readdir(join(root, "public-clone", "src")), ["player.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-space Change summaries disclose only the audience's Source Spaces", () => {
  const publicProjection = projection(revision("project-revision:summary", "snapshot:private:one"));
  const change = changeRevision();
  const publicSummary = summarizeChangeForAudience({
    project,
    changeRevision: change,
    sourceSpaces,
    audience: "public",
    publicProjection,
    publicSummary: "Adds a resumable player contract.",
    internalSummary: "Adds the codec implementation and compatibility checks.",
    effects: [
      { sourceSpaceId: "public-player", publicLabel: "public player contract" },
      { sourceSpaceId: "private-codec", publicLabel: "private implementation changed", internalLabel: "private codec scheduler changed" },
    ],
  });
  const maintainerSummary = summarizeChangeForAudience({
    project,
    changeRevision: change,
    sourceSpaces,
    audience: "project",
    publicProjection,
    publicSummary: "Adds a resumable player contract.",
    internalSummary: "Adds the codec implementation and compatibility checks.",
    effects: [
      { sourceSpaceId: "public-player", publicLabel: "public player contract" },
      { sourceSpaceId: "private-codec", publicLabel: "private implementation changed", internalLabel: "private codec scheduler changed" },
    ],
  });
  assert.equal(publicSummary.affectedSourceSpaceIds.includes("private-codec"), false);
  assert.equal(publicSummary.declaredEffects.includes("private codec scheduler changed"), false);
  assert.equal(JSON.stringify(publicSummary).includes("private-codec"), false);
  assert.equal(maintainerSummary.affectedSourceSpaceIds.includes("private-codec"), true);
  assert.equal(maintainerSummary.declaredEffects.includes("private codec scheduler changed"), true);
  assert.notEqual(publicSummary.changeId, change.changeId);
});

test("sealed private verification returns approved safe Evidence only", async () => {
  const publicProjection = projection(revision("project-revision:sealed", "snapshot:private:one"));
  const ledger = new EvidenceLedger();
  const result = await runSealedVerifier({
    projectId: project.id,
    publicProjection,
    changeRevision: changeRevision(),
    contract: {
      protocol: CONTRACT_VERSIONS.sealedVerifier,
      version: "v1",
      id: "verifier:compatibility",
      name: "Compatibility verifier",
      actionId: "action:compatibility",
      actionContractDigest: "sha256:action-contract",
      contractDigest: "sha256:verifier-contract",
      acceptedInput: "public-change-revision",
      privateSourceSpaceIds: ["private-codec"],
      allowedAudiences: ["public"],
      disclosure: "safe-summary",
      sideChannelPolicy: "coarse",
      appealPolicy: "maintainer-review",
    },
    audience: "public",
    privateInput: {
      sourceSpaceIds: ["private-codec"],
      files: { "src/codec.ts": "private codec implementation" },
      inputDigests: ["sha256:private-fixture"],
    },
    execute: (context) => {
      assert.equal(context.privateInput.files["src/codec.ts"], "private codec implementation");
      return {
        status: "passed",
        safeSummary: "The public contract is compatible with the owner-selected implementation.",
        outputDigest: "sha256:compatibility-output",
        privateReceipt: "private-test-receipt:codec-compatibility",
      };
    },
    ledger,
    actor: { principalId: "principal:owner", actorId: "actor:verifier", sessionId: "session:verifier", clientId: "client:test" },
    runnerId: "runner:local",
    policyVersion: "policy:v1",
    authorizationEpoch: "epoch:v1",
    capabilityGrantId: "grant:sealed",
    owner: "team:video-player",
  });
  assert.equal(result.status, "passed");
  assert.equal(result.summary, "The public contract is compatible with the owner-selected implementation.");
  assert.equal(JSON.stringify(result).includes("src/codec.ts"), false);
  assert.equal(JSON.stringify(result).includes("private-test-receipt"), false);
  assert.equal(JSON.stringify(result).includes("private-fixture"), false);
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.list()[0]?.receipt, "private-test-receipt:codec-compatibility");
  const appeal = appealSealedVerification({ result, reason: "Please review the exact Change Revision." });
  assert.equal(appeal.runId, result.runId);
  assert.equal(appeal.projectViewId, publicProjection.projectionRevisionId);
});

test("restricted Intent metadata is omitted from public projections while public Intent history remains safe", () => {
  const author = { principalId: "principal:owner", actorId: "actor:owner", sessionId: "session:owner", clientId: "client:test" };
  const restricted: Intent = {
    protocol: CONTRACT_VERSIONS.intent,
    id: "intent:private-codec",
    projectId: project.id,
    title: "Replace private codec implementation",
    description: "Internal codec details must never enter the public projection.",
    status: "open",
    author,
    assigneePrincipalIds: ["principal:maintainer"],
    labels: ["private"],
    disclosure: "restricted",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    receipt: "intent=fixture; disclosure=restricted",
  };
  const publicIntent: Intent = {
    ...restricted,
    id: "intent:public-player",
    title: "Improve playback controls",
    description: "Make playback controls easier to use.",
    labels: ["enhancement"],
    disclosure: "public",
  };
  const comments: IntentComment[] = [{ protocol: CONTRACT_VERSIONS.intentComment, id: "intent-comment:private", intentId: restricted.id, projectId: project.id, author, body: "Private comment that must never be projected.", disclosure: "restricted", createdAt: "2026-08-03T00:01:00.000Z", receipt: "comment=fixture; disclosure=restricted" }];
  assert.equal(summarizeIntentForAudience({ project, intent: restricted, comments, audience: "public" }), undefined);
  const safe = summarizeIntentForAudience({ project, intent: publicIntent, comments: [], audience: "public" });
  assert.equal(safe?.intentId, publicIntent.id);
  assert.equal(safe?.title, publicIntent.title);
  assert.equal(JSON.stringify(safe).includes("principal:maintainer"), false);
  assert.equal(JSON.stringify(safe).includes("Private codec"), false);
});

test("restricted Pull Request provider identity and Change IDs stay out of public projections", () => {
  const restricted: PullRequest = { protocol: CONTRACT_VERSIONS.pullRequest, id: "pr:private", projectId: project.id, changeId: "change:private", provider: "github", externalKey: "17", remoteRepository: "acme/private", headRef: "refs/heads/private", baseRef: "refs/heads/main", headCommit: "commit:private", baseCommit: "commit:base", title: "Private codec change", description: "Private review details", status: "open", reviewState: "changes-requested", reviewDigest: "sha256:private-review", revisionIds: ["revision:private"], disclosure: "restricted", createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z", receipt: "pullRequest=fixture; disclosure=restricted" };
  assert.equal(summarizePullRequestForAudience({ project, pullRequest: restricted, audience: "public" }), undefined);
  const publicPullRequest = summarizePullRequestForAudience({ project, pullRequest: { ...restricted, id: "pr:public", changeId: "change:public", title: "Public playback change", description: "Improve playback", disclosure: "public", provider: "local" }, audience: "public" });
  assert.equal(publicPullRequest?.pullRequestId, "pr:public");
  assert.equal(publicPullRequest?.changeId, undefined);
  assert.equal(JSON.stringify(publicPullRequest).includes("acme/private"), false);
  assert.equal(JSON.stringify(publicPullRequest).includes("commit:private"), false);
});

test("Publication Change creates independent lineage and revokes only future distribution", () => {
  const publicProjection = projection(revision("project-revision:publication", "snapshot:private:one"));
  const draft = createPublicationChange({
    id: "publication-change:video-player",
    projectId: project.id,
    publicProjection,
  });
  const preview = previewPublicationChange(draft);
  assert.equal(preview.change.state, "previewed");
  assert.match(preview.warnings[0] ?? "", /no universal claim/i);
  const landed = landPublicationChange(approvePublicationChange(preview.change), "2026-08-03T00:00:00.000Z");
  const revoked = revokePublicationChange(landed, "2026-08-03T01:00:00.000Z");
  assert.equal(revoked.state, "revoked");
  assert.equal(revoked.publicProjection.projectionRevisionId, publicProjection.projectionRevisionId);
  assert.equal(revoked.publicProjection.lineageId, publicProjection.lineageId);
  assert.equal(revoked.publicProjection.files["src/player.ts"], publicFiles["src/player.ts"]);
  assert.match(revoked.receipt, /lineage-retained=true/);
  assert.equal(JSON.stringify(revoked).includes("project-revision:publication"), false);
});
