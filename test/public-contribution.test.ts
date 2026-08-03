import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ChangeControlError,
  LocalChangeCoordinator,
  type WorkspaceSource,
} from "../src/change-control/local.ts";
import {
  CONTRACT_VERSIONS,
  EvidenceLedger,
  LocalGitRepositoryDriver,
  createProject,
  createProjectRevision,
  createPublicProjection,
  deriveProjectView,
  materializePublicProjection,
  runSealedVerifier,
  summarizeChangeForAudience,
  type Project,
  type ProjectRevision,
  type SourceSpace,
} from "../src/index.ts";
import {
  HybridDisclosureError,
} from "../src/disclosure/hybrid.ts";

const project: Project = createProject({
  id: "project:public-contribution-video-player",
  name: "Public Contribution Video Player",
  referenceType: "hybrid-public-private",
  sourceSpaceIds: ["public-player", "private-codec"],
});

const sourceSpaces: readonly SourceSpace[] = [
  { protocol: CONTRACT_VERSIONS.sourceSpace, id: "public-player", name: "Public Player", classification: "public" },
  { protocol: CONTRACT_VERSIONS.sourceSpace, id: "private-codec", name: "Private Codec", classification: "restricted" },
];

const basePublicFiles = {
  "src/player.ts": "export const player = true;\n",
  "README.md": "# Public video player\n",
};

const privateFiles = {
  "src/codec.ts": "export const codec = \"private\";\n",
};

const actor = {
  principalId: "principal:external-contributor",
  actorId: "actor:external-contributor",
  sessionId: "session:external-contributor",
  clientId: "client:public-git",
};

function canonicalRevision(): ProjectRevision {
  return createProjectRevision({
    id: "project-revision:public-contribution-base",
    projectId: project.id,
    sourceSpaceSnapshots: {
      "public-player": "snapshot:public:v1",
      "private-codec": "snapshot:private:v1",
    },
  });
}

function publicView(revision: ProjectRevision) {
  return deriveProjectView({
    project,
    revision,
    sourceSpaces,
    allowedSourceSpaceIds: ["public-player"],
    projectionId: "public-contributor-view",
    classification: "public",
  });
}

function publicProjection(revision: ProjectRevision, files: Readonly<Record<string, string>>) {
  return createPublicProjection({
    project,
    canonicalRevision: revision,
    sourceSpaces,
    publicSourceSpaceIds: ["public-player"],
    sources: [
      { sourceSpaceId: "public-player", snapshotId: revision.sourceSpaceSnapshots["public-player"]!, files },
    ],
  });
}

async function temporaryDirectory(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `anyam-public-contribution-${name}-`));
}

test("external contributor clones only the public projection, proposes a Change, receives safe Evidence, and cannot cross the private boundary", async () => {
  const root = await temporaryDirectory("journey");
  try {
    const baseRevision = canonicalRevision();
    const baseProjection = publicProjection(baseRevision, basePublicFiles);
    const driver = new LocalGitRepositoryDriver(root);
    const published = await materializePublicProjection({
      projection: baseProjection,
      driver,
      destination: join(root, "public-source"),
      author: { name: "Anyam Public Projection", email: "public@anyam.local" },
    });
    const externalDirectory = join(root, "external-contributor");
    const cloned = await driver.cloneRepository({
      sourceSpaceId: "public-player",
      source: join(root, "public-source"),
      destination: externalDirectory,
    });
    assert.equal(cloned.status, "succeeded");
    if (cloned.status !== "succeeded") return;
    assert.deepEqual((await readdir(externalDirectory, { recursive: true })).filter((path) => !String(path).startsWith(".git")), ["README.md", "src", "src/player.ts"]);
    await assert.rejects(readFile(join(externalDirectory, "src/codec.ts")));
    await writeFile(join(externalDirectory, "src/player.ts"), "export const player = true;\nexport const captions = true;\n", "utf8");
    const contributionCommit = await driver.commitRepository({
      repository: cloned.value,
      message: "Add captions to the public player",
      author: { name: "External Contributor", email: "contributor@example.invalid" },
    });
    assert.equal(contributionCommit.status, "succeeded");
    if (contributionCommit.status !== "succeeded") return;

    const control = new LocalChangeCoordinator({ project, sourceSpaces, canonicalRevision: baseRevision });
    const workspace = await control.createWorkspace({
      view: publicView(baseRevision),
      sources: [{ sourceSpaceId: "public-player", snapshotId: "snapshot:public:v1", files: basePublicFiles } satisfies WorkspaceSource],
      mounts: [{ sourceSpaceId: "public-player", mountPath: "source" }],
      directory: join(root, "anyam-workspace"),
      actorId: actor.actorId,
    });
    const change = control.createChange({
      intentId: "intent:public-captions",
      workspaceId: workspace.workspace.id,
      author: actor,
      origin: {
        kind: "mirror",
        source: "public-projection",
        remoteRepository: "external-contributor",
        remoteRef: "refs/heads/contribution",
        remoteCommit: contributionCommit.value.commitId,
        disclosure: "public",
        receipt: `public-contribution=anonymous-read; commit=${contributionCommit.value.commitId}; private-content=not-materialized`,
      },
    });
    const contributedSnapshot = `snapshot:public:commit:${contributionCommit.value.commitId}`;
    const changeRevision = control.publishRevision({
      changeId: change.id,
      declaredEffects: ["public.player.modify"],
      sourceSpaceSnapshots: { "public-player": contributedSnapshot },
      actor,
    });
    assert.deepEqual(changeRevision.sourceSpaceSnapshots, { "public-player": contributedSnapshot });
    assert.equal(JSON.stringify(changeRevision).includes("private-codec"), false);
    assert.equal(control.getChange(change.id)?.origin?.disclosure, "public");

    const contributedFiles = {
      ...basePublicFiles,
      "src/player.ts": "export const player = true;\nexport const captions = true;\n",
    };
    const candidateRevision = createProjectRevision({
      id: "project-revision:public-contribution-candidate",
      projectId: project.id,
      sourceSpaceSnapshots: {
        "public-player": contributedSnapshot,
        "private-codec": baseRevision.sourceSpaceSnapshots["private-codec"]!,
      },
    });
    const candidateProjection = publicProjection(candidateRevision, contributedFiles);
    const publicSummary = summarizeChangeForAudience({
      project,
      changeRevision,
      sourceSpaces,
      audience: "public",
      publicProjection: candidateProjection,
      publicSummary: "Adds captions to the public player.",
      internalSummary: "The private codec remains unchanged.",
      effects: [
        { sourceSpaceId: "public-player", publicLabel: "public player behavior" },
        { sourceSpaceId: "private-codec", publicLabel: "private implementation changed", internalLabel: "private codec implementation" },
      ],
    });
    assert.deepEqual(publicSummary.affectedSourceSpaceIds, ["public-player"]);
    assert.deepEqual(publicSummary.declaredEffects, ["public player behavior"]);
    assert.equal(JSON.stringify(publicSummary).includes("private-codec"), false);
    assert.equal(JSON.stringify(publicSummary).includes("private codec"), false);

    const ledger = new EvidenceLedger();
    const sealed = await runSealedVerifier({
      projectId: project.id,
      publicProjection: candidateProjection,
      changeRevision,
      contract: {
        protocol: CONTRACT_VERSIONS.sealedVerifier,
        version: "v1",
        id: "verifier:private-codec-compatibility",
        name: "Private codec compatibility",
        actionId: "action:private-codec-compatibility",
        actionContractDigest: "sha256:private-action-contract",
        contractDigest: "sha256:private-verifier-contract",
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
        files: privateFiles,
        inputDigests: ["sha256:private-compatibility-fixture"],
      },
      execute: () => ({
        status: "passed",
        safeSummary: "The public contribution passed the private compatibility verifier.",
        outputDigest: "sha256:public-safe-compatibility-result",
        privateReceipt: "private-receipt:codec-compatibility-run-1",
      }),
      ledger,
      actor,
      runnerId: "runner:private-verifier",
      policyVersion: "policy:public-contribution:v1",
      authorizationEpoch: "epoch:public-contribution:v1",
      capabilityGrantId: "grant:sealed-verifier",
      owner: "team:video-player",
    });
    assert.equal(sealed.status, "passed");
    assert.equal(sealed.summary, "The public contribution passed the private compatibility verifier.");
    assert.equal(JSON.stringify(sealed).includes("private-codec"), false);
    assert.equal(JSON.stringify(sealed).includes("private-receipt"), false);
    const publicEvidenceSummary = summarizeChangeForAudience({
      project,
      changeRevision,
      sourceSpaces,
      audience: "public",
      publicProjection: candidateProjection,
      publicSummary: "Adds captions to the public player.",
      evidence: ledger.list(),
    });
    assert.equal(publicEvidenceSummary.evidence.length, 1);
    assert.equal(publicEvidenceSummary.evidence[0]?.outcome, "passed");
    assert.equal(JSON.stringify(publicEvidenceSummary).includes("private-receipt"), false);

    const landing = control.landChange({
      changeId: change.id,
      changeRevisionId: changeRevision.id,
      expectedCanonicalProjectRevisionId: baseRevision.id,
    });
    assert.equal(landing.previousProjectRevisionId, baseRevision.id);
    assert.equal(control.canonicalRevision.sourceSpaceSnapshots["public-player"], contributedSnapshot);
    assert.equal(control.canonicalRevision.sourceSpaceSnapshots["private-codec"], baseRevision.sourceSpaceSnapshots["private-codec"]);
    assert.match(landing.receipt, /compare-and-swap=true/);

    await assert.rejects(
      Promise.resolve().then(() => createPublicProjection({
        project,
        canonicalRevision: baseRevision,
        sourceSpaces,
        publicSourceSpaceIds: ["private-codec"],
        sources: [{ sourceSpaceId: "private-codec", snapshotId: "snapshot:private:v1", files: privateFiles }],
      })),
      (error: unknown) => {
        assert.ok(error instanceof HybridDisclosureError);
        assert.equal(error.code, "public-source-space-required");
        assert.equal(JSON.stringify(error).includes("private-codec"), false);
        return true;
      },
    );
    await assert.rejects(
      control.createWorkspace({
        view: publicView(baseRevision),
        sources: [
          { sourceSpaceId: "public-player", snapshotId: "snapshot:public:v1", files: basePublicFiles },
          { sourceSpaceId: "private-codec", snapshotId: "snapshot:private:v1", files: privateFiles },
        ],
        mounts: [
          { sourceSpaceId: "public-player", mountPath: "source" },
          { sourceSpaceId: "private-codec", mountPath: "private" },
        ],
        directory: join(root, "crossing-workspace"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ChangeControlError);
        assert.equal(error.code, "workspace-source-not-authorized");
        assert.equal(JSON.stringify(error).includes("private-codec"), false);
        return true;
      },
    );
    await assert.rejects(
      Promise.resolve().then(() => control.publishRevision({
        changeId: change.id,
        declaredEffects: ["public.player.modify"],
        sourceSpaceSnapshots: {
          "public-player": contributedSnapshot,
          "private-codec": "snapshot:private:unauthorized",
        },
      })),
      (error: unknown) => {
        assert.ok(error instanceof ChangeControlError);
        assert.equal(error.code, "workspace-source-not-authorized");
        assert.equal(JSON.stringify(error).includes("private-codec"), false);
        return true;
      },
    );

    assert.equal(published.projection.sourceSpaceIds.includes("private-codec"), false);
    console.log("protocol=anyam.public-contribution-qualification/v1");
    console.log("status=passed-with-bounded-public-projection");
    console.log("publicRead=anonymous-projection-clone; privateContent=not-materialized");
    console.log(`externalCommit=${contributionCommit.value.commitId}; change=${change.id}; revision=${changeRevision.id}`);
    console.log(`landing=${landing.projectRevisionId}; canonicalPrivateSnapshotPreserved=true; publicEvidence=${sealed.status}`);
    console.log("boundaryRejection=private-projection-request, private-workspace-mount, and private-revision-snapshot all rejected");
    console.log("universalBuildClaim=false; preview=disclosure-integrity-only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
