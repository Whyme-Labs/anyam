import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createReleaseAssetTarget,
  publishReleaseArtifact,
  ReleasePublicationCoordinator,
  type PublishedArtifact,
  type ReleaseTargetAdapter,
} from "../src/delivery/release-publication.ts";
import {
  normalizeProjectManifest,
  runLocalRelease,
  targetFromManifest,
  type LocalExecutionContext,
} from "../src/execution/local.ts";
import { sealVerifiedRelease, type DeliveryAdapterResult, type ImmutableRelease } from "../src/delivery/promotion.ts";
import { LocalGitRepositoryDriver } from "../src/portability/local-git.ts";
import { LocalProjectExporter, verifyProjectExportPackage } from "../src/portability/project-export.ts";

const fixtureRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));

const actor = {
  principalId: "principal:library-release-test",
  actorId: "actor:library-release-test",
  sessionId: "session:library-release-test",
  clientId: "client:library-release-test",
};

function context(directory: string): LocalExecutionContext {
  return {
    directory,
    projectRevisionId: "project-revision:typescript-library:v1",
    projectViewId: "project-view:typescript-library:project",
    sourceSpaceSnapshots: { "typescript-library-source": "snapshot:typescript-library:v1" },
    actor,
    runnerId: "runner:local",
    policyVersion: "policy:library-release:v1",
    authorizationEpoch: "epoch:library-release:v1",
    capabilityGrantId: "grant:library-release",
    dependencyDigest: "sha256:library-dependencies:v1",
    toolchainDigest: "sha256:library-toolchain:v1",
    environmentDigest: "sha256:library-environment:v1",
    disclosure: { projectionId: "project-view:typescript-library:project", classification: "project" },
    owner: "library release test",
    changeRevisionId: "change-revision:typescript-library:v1",
    workspaceId: "workspace:typescript-library:v1",
    targetId: "target:library",
    declaredEffects: ["artifact.create", "release.publish"],
  };
}

async function libraryRelease(name: string): Promise<{ release: ImmutableRelease; target: ReturnType<typeof createReleaseAssetTarget>; directory: string; manifest: unknown }> {
  const directory = await mkdtemp(join(tmpdir(), `anyam-library-release-${name}-`));
  await cp(join(fixtureRoot, "typescript-library"), directory, { recursive: true });
  const manifest = JSON.parse(await readFile(join(directory, "anyam.json"), "utf8")) as unknown;
  const normalized = normalizeProjectManifest(manifest);
  const target = createReleaseAssetTarget({
    target: targetFromManifest(normalized.targets[0]!, normalized.projectId),
    contractDigest: "sha256:generic-release-assets:v1",
  });
  const result = await runLocalRelease({
    manifest,
    context: context(directory),
    releaseName: name,
  });
  return {
    directory,
    manifest,
    target,
    release: sealVerifiedRelease({
      projectId: normalized.projectId,
      release: result.release,
      artifacts: result.artifacts,
      evidence: result.evidence,
      target,
    }),
  };
}

class ScriptedPackageAdapter implements ReleaseTargetAdapter {
  readonly protocol = "anyam.target-adapter/v1" as const;
  readonly id = "generic.release-assets";
  readonly contractDigest = "sha256:generic-release-assets-adapter:v1";
  readonly calls: Array<{ releaseDigest: string; artifactDigest: string }> = [];
  private failures: number;
  private sequence = 0;

  constructor(failures = 0) {
    this.failures = failures;
  }

  async publish(input: {
    publicationId: string;
    attempt: number;
    release: ImmutableRelease;
    artifact: { id: string; digest: string; type: string };
    target: { id: string };
  }): Promise<DeliveryAdapterResult<PublishedArtifact>> {
    this.calls.push({ releaseDigest: input.release.releaseDigest, artifactDigest: input.artifact.digest });
    if (this.failures > 0) {
      this.failures -= 1;
      return {
        status: "failed",
        outcome: "failed",
        errorCode: "scripted.publish_failed",
        message: "scripted package target rejected the publication",
        retryable: true,
        recoveryAction: "inspect the package target receipt and retry the same immutable Release",
        receipt: `provider=scripted; operation=publish; changedTarget=false; artifact=${input.artifact.id}`,
      };
    }
    return {
      status: "succeeded",
      value: {
        targetId: input.target.id,
        releaseId: input.release.release.id,
        artifactId: input.artifact.id,
        releaseDigest: input.release.releaseDigest,
        artifactDigest: input.artifact.digest,
        providerObjectId: `package-object:${++this.sequence}`,
        receipt: `provider=scripted; packageObject=package-object:${this.sequence}`,
      },
      receipt: `provider=scripted; operation=publish; sequence=${this.sequence}`,
    };
  }
}

test("TypeScript library fixture creates a non-web typed Release with reproducible provenance", async () => {
  const first = await libraryRelease("library-release-v1");
  const second = await libraryRelease("library-release-v1-repeat");
  try {
    const firstArtifact = first.release.artifacts[0];
    const secondArtifact = second.release.artifacts[0];
    assert.ok(firstArtifact);
    assert.ok(secondArtifact);
    assert.equal(first.release.release.status, "ready");
    assert.equal(first.release.release.projectRevisionId, "project-revision:typescript-library:v1");
    assert.equal(firstArtifact.type, "package.archive");
    assert.equal(firstArtifact.outputPath, "dist/library.archive");
    assert.match(firstArtifact.digest, /^sha256:/);
    assert.match(first.release.release.provenanceDigest ?? "", /^sha256:/);
    assert.deepEqual(first.release.release.configurationDigests.length > 0, true);
    assert.equal(first.release.release.policyVersion, "policy:library-release:v1");
    assert.equal(first.release.release.evidenceIds.length, first.release.evidence.length);
    assert.ok(first.release.evidence.every((record) => (
      record.outcome === "passed"
      && record.projectRevisionId === first.release.release.projectRevisionId
      && record.dependencyDigest === "sha256:library-dependencies:v1"
      && record.toolchainDigest === "sha256:library-toolchain:v1"
      && record.environmentDigest === "sha256:library-environment:v1"
    )));
    assert.equal(firstArtifact.digest, secondArtifact.digest);
    assert.equal(first.release.release.configurationDigests[0], second.release.release.configurationDigests[0]);
    assert.equal(first.release.release.provenanceDigest, second.release.release.provenanceDigest);
    assert.equal((first.manifest as { referenceType: string }).referenceType, "typescript-library");
    assert.equal((first.manifest as { targets: Array<{ adapter: string }> }).targets[0]?.adapter, "generic.release-assets");
  } finally {
    await rm(first.directory, { recursive: true, force: true });
    await rm(second.directory, { recursive: true, force: true });
  }
});

test("generic package Target publication preserves Release lineage across failure, retry, and idempotency", async () => {
  const built = await libraryRelease("library-publication");
  try {
    const artifact = built.release.artifacts[0];
    assert.ok(artifact);
    const adapter = new ScriptedPackageAdapter(1);
    const coordinator = new ReleasePublicationCoordinator({ projectId: "project:typescript-library", target: built.target, adapter });
    coordinator.registerRelease(built.release);
    const [first, concurrentDuplicate] = await Promise.all([
      publishReleaseArtifact({ coordinator, releaseId: built.release.release.id, artifactId: artifact.id, idempotencyKey: "publish:library:v1", actor }),
      publishReleaseArtifact({ coordinator, releaseId: built.release.release.id, artifactId: artifact.id, idempotencyKey: "publish:library:v1", actor }),
    ]);
    const duplicate = await publishReleaseArtifact({ coordinator, releaseId: built.release.release.id, artifactId: artifact.id, idempotencyKey: "publish:library:v1", actor });
    const retried = await coordinator.retry({ publicationId: first.id, idempotencyKey: "publish:library:v2", actor });
    const retryDuplicate = await coordinator.retry({ publicationId: first.id, idempotencyKey: "publish:library:v2", actor });

    assert.equal(first.state, "failed");
    assert.equal(first.releaseDigest, built.release.releaseDigest);
    assert.equal(first.artifactDigest, artifact.digest);
    assert.match(first.recoveryAction ?? "", /retry/);
    assert.equal(concurrentDuplicate.id, first.id);
    assert.equal(duplicate.id, first.id);
    assert.equal(retried.state, "published");
    assert.equal(retried.attempt, 1);
    assert.equal(retried.releaseDigest, first.releaseDigest);
    assert.equal(retried.artifactDigest, first.artifactDigest);
    assert.equal(retryDuplicate.id, retried.id);
    assert.equal(adapter.calls.length, 2);
    assert.equal(new Set(adapter.calls.map((call) => `${call.releaseDigest}:${call.artifactDigest}`)).size, 1);
    assert.equal(coordinator.getTarget().currentReleaseId, built.release.release.id);
    assert.equal(coordinator.getTarget().currentArtifactId, artifact.id);
    assert.equal(coordinator.getTarget().publicationState, "published");
    assert.deepEqual(coordinator.listEvents().map((event) => event.to), ["proposed", "publishing", "failed", "proposed", "publishing", "published"]);
  } finally {
    await rm(built.directory, { recursive: true, force: true });
  }
});

test("TypeScript library Release, Artifact, Evidence, and Target remain in the portable Project Export", async () => {
  const built = await libraryRelease("library-export");
  const root = await mkdtemp(join(tmpdir(), "anyam-library-export-"));
  try {
    const sourceSpace = {
      protocol: "anyam.source-space/v1" as const,
      id: "typescript-library-source",
      name: "typescript-library-source",
      classification: "public" as const,
    };
    const project = {
      protocol: "anyam.project/v1" as const,
      id: "project:typescript-library",
      name: "Anyam TypeScript Library Reference",
      referenceType: "typescript-library",
      sourceSpaceIds: [sourceSpace.id],
    };
    const driver = new LocalGitRepositoryDriver(join(root, "driver"));
    const repositoryDirectory = join(root, "repository");
    const repository = await driver.createRepository({ sourceSpaceId: sourceSpace.id, directory: repositoryDirectory });
    assert.equal(repository.status, "succeeded");
    if (repository.status !== "succeeded") return;
    await writeFile(join(repositoryDirectory, "README.md"), "library release\n", "utf8");
    const commit = await driver.commitRepository({ repository: repository.value, message: "Add library source" });
    assert.equal(commit.status, "succeeded");
    if (commit.status !== "succeeded") return;
    const exported = await new LocalProjectExporter(driver).exportProject({
      project,
      sourceSpaces: [sourceSpace],
      repositories: [{ sourceSpaceId: sourceSpace.id, repository: repository.value }],
      destination: join(root, "export"),
      projectRevisions: [{ protocol: "anyam.kernel/v1", id: built.release.release.projectRevisionId, projectId: project.id, sourceSpaceSnapshots: { [sourceSpace.id]: commit.value.commitId } }],
      evidence: built.release.evidence,
      artifacts: built.release.artifacts,
      releases: [built.release.release],
      targets: [built.target],
      idempotencyKey: "export:library-release:v1",
    });
    assert.equal(exported.status, "succeeded");
    if (exported.status !== "succeeded") return;
    assert.equal(exported.value.manifest.artifacts[0]?.id, built.release.artifacts[0]?.id);
    assert.equal(exported.value.manifest.releases[0]?.id, built.release.release.id);
    assert.equal(exported.value.manifest.targets[0]?.id, built.target.id);
    assert.equal(exported.value.manifest.integrity.credentialFree, true);
    assert.equal((await verifyProjectExportPackage(exported.value.directory)).status, "succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(built.directory, { recursive: true, force: true });
  }
});
