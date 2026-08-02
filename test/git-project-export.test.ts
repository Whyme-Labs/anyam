import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createProject, type Project, type RepositoryMirror, type SourceSpace } from "../src/kernel/contracts.ts";
import { LocalGitRepositoryDriver } from "../src/portability/local-git.ts";
import {
  LocalProjectExporter,
  projectExportManifestDigest,
  verifyProjectExportPackage,
} from "../src/portability/project-export.ts";
import type {
  RepositoryDriverResult,
  RepositoryHandle,
  RepositoryRestoreReceipt,
} from "../src/portability/repository-driver.ts";

const execFile = promisify(execFileCallback);

async function git(directory: string | undefined, args: readonly string[]): Promise<string> {
  const result = await execFile("git", [...args], { cwd: directory });
  return result.stdout.trim();
}

async function createBareRemote(root: string): Promise<string> {
  const remote = join(root, "remote.git");
  await git(undefined, ["init", "--bare", remote]);
  return remote;
}

const sourceSpace: SourceSpace = {
  protocol: "anyam.source-space/v1",
  id: "source:local",
  name: "local",
  classification: "public",
};

const project: Project = createProject({
  id: "project:round-trip",
  name: "Round Trip",
  referenceType: "typescript-library",
  sourceSpaceIds: [sourceSpace.id],
});

class FailOnceRestoreDriver extends LocalGitRepositoryDriver {
  private shouldFail = true;

  override async restoreRepository(input: {
    sourceSpaceId: string;
    bundlePath: string;
    destination: string;
    expectedDigest?: string;
    lfsObjects?: readonly { oid: string; sourcePath: string; digest?: string }[];
    refs?: readonly { name: string; oid: string }[];
    defaultBranch?: string | null;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryRestoreReceipt>> {
    if (this.shouldFail) {
      this.shouldFail = false;
      return {
        status: "failed",
        errorCode: "test.injected_restore_failure",
        message: "Injected restore failure for recovery qualification.",
        retryable: true,
        affectedObject: input.sourceSpaceId,
        recoveryAction: "retry the same import idempotency key",
        receipt: `operation=restore; object=${input.sourceSpaceId}; injected=true`,
      };
    }
    return super.restoreRepository(input);
  }
}

class FailOnceCloneDriver extends LocalGitRepositoryDriver {
  private shouldFail = true;

  override async cloneRepository(input: {
    sourceSpaceId: string;
    source: string;
    destination?: string;
    mirror?: boolean;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryHandle>> {
    if (this.shouldFail) {
      this.shouldFail = false;
      return {
        status: "failed",
        errorCode: "test.injected_clone_failure",
        message: "Injected clone failure for recovery qualification.",
        retryable: true,
        affectedObject: input.sourceSpaceId,
        recoveryAction: "retry the same import idempotency key",
        receipt: `operation=clone; object=${input.sourceSpaceId}; injected=true`,
      };
    }
    return super.cloneRepository(input);
  }
}

test("LocalGitRepositoryDriver round-trips normal Git operations without provider authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-git-round-trip-"));
  try {
    const driver = new LocalGitRepositoryDriver(join(root, "driver"));
    const remote = await createBareRemote(root);
    const seedDirectory = join(root, "seed");
    const seed = await driver.createRepository({ sourceSpaceId: sourceSpace.id, directory: seedDirectory });
    assert.equal(seed.status, "succeeded");
    if (seed.status !== "succeeded") return;
    await writeFile(join(seedDirectory, "README.md"), "initial\n", "utf8");
    const initialCommit = await driver.commitRepository({ repository: seed.value, message: "Initial commit" });
    assert.equal(initialCommit.status, "succeeded");
    await git(seedDirectory, ["remote", "add", "origin", remote]);
    const pushedInitial = await driver.pushRepository({ repository: seed.value });
    assert.equal(pushedInitial.status, "succeeded");

    const firstClone = await driver.cloneRepository({ sourceSpaceId: sourceSpace.id, source: remote, destination: join(root, "first-clone") });
    assert.equal(firstClone.status, "succeeded");
    if (firstClone.status !== "succeeded") return;
    assert.equal(JSON.stringify(firstClone.value).includes(remote), false);
    await writeFile(join(root, "first-clone", "README.md"), "initial\nfirst change\n", "utf8");
    const branch = await driver.createBranch({ repository: firstClone.value, name: "feature/round-trip" });
    assert.equal(branch.status, "succeeded");
    await git(join(root, "first-clone"), ["switch", "feature/round-trip"]);
    const diff = await driver.diffRepository({ repository: firstClone.value, base: "HEAD" });
    assert.equal(diff.status, "succeeded");
    if (diff.status !== "succeeded") return;
    assert.match(diff.value.text, /first change/);
    assert.equal(diff.value.digest.length > 0, true);
    const featureCommit = await driver.commitRepository({ repository: firstClone.value, message: "Add round-trip feature" });
    assert.equal(featureCommit.status, "succeeded");
    if (featureCommit.status !== "succeeded") return;
    const tag = await driver.createTag({ repository: firstClone.value, name: "v0.1.0", target: featureCommit.value.commitId });
    assert.equal(tag.status, "succeeded");
    const pushedFeature = await driver.pushRepository({ repository: firstClone.value });
    assert.equal(pushedFeature.status, "succeeded");

    const secondClone = await driver.cloneRepository({ sourceSpaceId: sourceSpace.id, source: remote, destination: join(root, "second-clone") });
    assert.equal(secondClone.status, "succeeded");
    if (secondClone.status !== "succeeded") return;
    const fetched = await driver.fetchRepository({ repository: secondClone.value });
    assert.equal(fetched.status, "succeeded");
    const refs = await driver.listRefs({ repository: secondClone.value });
    assert.equal(refs.status, "succeeded");
    if (refs.status !== "succeeded") return;
    assert.ok(refs.value.some((ref) => ref.name === "refs/tags/v0.1.0"));
    assert.ok(refs.value.some((ref) => ref.name === "refs/remotes/origin/feature/round-trip"));
    const inspection = await driver.inspectRepository({ repository: secondClone.value });
    assert.equal(inspection.status, "succeeded");
    if (inspection.status !== "succeeded") return;
    const cas = await driver.compareAndSwapRefs({
      repository: secondClone.value,
      expected: { "refs/heads/feature/round-trip": refs.value.find((ref) => ref.name === "refs/heads/feature/round-trip")?.oid ?? null },
      desired: { "refs/heads/feature/round-trip": null },
    });
    assert.equal(cas.status, "succeeded");
    assert.equal(inspection.value.repository.sourceSpaceId, sourceSpace.id);
    assert.equal("providerUrl" in inspection.value.repository, false);
    assert.equal("token" in inspection.value.repository, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Project Export includes Git bundles, lineage, and recovery metadata and restores exact refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-project-export-"));
  try {
    const driver = new LocalGitRepositoryDriver(join(root, "driver"));
    const repositoryDirectory = join(root, "repository");
    const repository = await driver.createRepository({ sourceSpaceId: sourceSpace.id, directory: repositoryDirectory });
    assert.equal(repository.status, "succeeded");
    if (repository.status !== "succeeded") return;
    await writeFile(join(repositoryDirectory, "src.ts"), "export const answer = 42;\n", "utf8");
    const commit = await driver.commitRepository({ repository: repository.value, message: "Add source" });
    assert.equal(commit.status, "succeeded");
    const exporter = new LocalProjectExporter(driver);
    const destination = join(root, "export");
    const mirror: RepositoryMirror = {
      protocol: "anyam.mirror/v1",
      id: "mirror:github-round-trip",
      projectId: project.id,
      sourceSpaceId: sourceSpace.id,
      provider: "github",
      remoteRepository: "acme/round-trip",
      direction: "bidirectional",
      refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
      disclosure: "public",
      state: "healthy",
      canonicalProjectRevisionId: "project-revision:initial",
      canonicalRefs: [{ name: "refs/heads/main", oid: "initial" }],
      remoteGeneration: "remote:g1",
      remoteRefs: [{ name: "refs/heads/main", oid: "initial" }],
      pendingInboundChangeIds: [],
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
      receipt: "fixture=mirror-export",
    };
    const exported = await exporter.exportProject({
      project,
      sourceSpaces: [sourceSpace],
      repositories: [{ sourceSpaceId: sourceSpace.id, repository: repository.value }],
      destination,
      projectRevisions: [{ protocol: "anyam.kernel/v1", id: "project-revision:initial", projectId: project.id, sourceSpaceSnapshots: { [sourceSpace.id]: commit.status === "succeeded" ? commit.value.commitId : "unknown" } }],
      policies: ["policy:local"],
      auditEventIds: ["event:exported"],
      mirrors: [mirror],
      mirrorOperationIds: ["mirror-operation:one"],
      idempotencyKey: "export-round-trip",
    });
    assert.equal(exported.status, "succeeded");
    if (exported.status !== "succeeded") return;
    const manifest = exported.value.manifest;
    assert.equal(manifest.protocol, "anyam.export/v1");
    assert.equal(manifest.repositories.length, 1);
    assert.equal(manifest.repositories[0]?.sourceSpaceId, sourceSpace.id);
    assert.equal(manifest.lineage[0]?.projectRevisionId, "project-revision:initial");
    assert.equal(manifest.recovery.state, "verified");
    assert.equal(manifest.mirrors?.[0]?.id, mirror.id);
    assert.deepEqual(manifest.mirrorOperationIds, ["mirror-operation:one"]);
    assert.equal(manifest.integrity.credentialFree, true);
    assert.equal(manifest.integrity.manifestDigest, projectExportManifestDigest(manifest));
    const serialized = JSON.stringify(manifest);
    assert.equal(serialized.includes("providerUrl"), false);
    assert.equal(serialized.includes("token"), false);
    assert.equal((await verifyProjectExportPackage(destination)).status, "succeeded");

    const restore = await driver.restoreRepository({
      sourceSpaceId: sourceSpace.id,
      bundlePath: join(destination, "repositories", "source-local", "repository.bundle"),
      destination: join(root, "restored-repository"),
      expectedDigest: manifest.repositories[0]!.bundle.digest,
    });
    assert.equal(restore.status, "succeeded");
    if (restore.status !== "succeeded") return;
    const originalRefs = await driver.listRefs({ repository: repository.value });
    const restoredRefs = await driver.listRefs({ repository: restore.value.repository });
    assert.deepEqual(restoredRefs, originalRefs);
    const integrity = await driver.verifyRepository({
      repository: restore.value.repository,
      expected: manifest.repositories[0],
      bundlePath: join(destination, "repositories", "source-local", "repository.bundle"),
    });
    assert.equal(integrity.status, "succeeded");
    if (integrity.status === "succeeded") {
      assert.equal(integrity.value.refsMatch, true);
      assert.equal(integrity.value.bundleVerified, true);
      assert.equal(integrity.value.fsckPassed, true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Project Export import quarantines, reports a receipt, and resumes idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-import-recovery-"));
  try {
    const driver = new LocalGitRepositoryDriver(join(root, "source-driver"));
    const repositoryDirectory = join(root, "source-repository");
    const repository = await driver.createRepository({ sourceSpaceId: sourceSpace.id, directory: repositoryDirectory });
    assert.equal(repository.status, "succeeded");
    if (repository.status !== "succeeded") return;
    await writeFile(join(repositoryDirectory, "README.md"), "recoverable\n", "utf8");
    assert.equal((await driver.commitRepository({ repository: repository.value, message: "Create recoverable source" })).status, "succeeded");
    const exporter = new LocalProjectExporter(driver);
    const packageDirectory = join(root, "export");
    const exported = await exporter.exportProject({
      project,
      sourceSpaces: [sourceSpace],
      repositories: [{ sourceSpaceId: sourceSpace.id, repository: repository.value }],
      destination: packageDirectory,
      idempotencyKey: "export-for-import-recovery",
    });
    assert.equal(exported.status, "succeeded");

    const destination = join(root, "destination");
    const flaky = new FailOnceRestoreDriver(join(root, "flaky-driver"));
    const first = await new LocalProjectExporter(flaky).importProject({
      packageDirectory,
      destination,
      idempotencyKey: "import-recovery",
    });
    assert.equal(first.status, "failed");
    if (first.status !== "failed") return;
    assert.equal(first.errorCode, "test.injected_restore_failure");
    assert.equal(first.affectedObject, sourceSpace.id);
    assert.match(first.message, /budget=.*limit=.*asked=.*receipt=.*fix=/);
    assert.equal(first.checkpointId.length > 0, true);
    const second = await new LocalProjectExporter(flaky).importProject({
      packageDirectory,
      destination,
      idempotencyKey: "import-recovery",
    });
    assert.equal(second.status, "succeeded");
    if (second.status !== "succeeded") return;
    assert.equal(second.value.checkpoint.state, "activated");
    assert.equal(second.value.manifest.project.id, project.id);
    assert.equal(await readFile(join(destination, "project-export.json"), "utf8").then((value) => value.length > 0), true);
    const replay = await new LocalProjectExporter(flaky).importProject({
      packageDirectory,
      destination,
      idempotencyKey: "import-recovery",
    });
    assert.equal(replay.status, "succeeded");
    if (replay.status === "succeeded") assert.equal(replay.value.checkpoint.state, "activated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing Git import quarantines the source, verifies a bundle, and resumes from a visible checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-git-import-"));
  try {
    const sourceDriver = new LocalGitRepositoryDriver(join(root, "source-driver"));
    const remote = await createBareRemote(root);
    const sourceDirectory = join(root, "source-repository");
    const source = await sourceDriver.createRepository({ sourceSpaceId: sourceSpace.id, directory: sourceDirectory });
    assert.equal(source.status, "succeeded");
    if (source.status !== "succeeded") return;
    await writeFile(join(sourceDirectory, "README.md"), "existing Git source\n", "utf8");
    assert.equal((await sourceDriver.commitRepository({ repository: source.value, message: "Importable source" })).status, "succeeded");
    await git(sourceDirectory, ["remote", "add", "origin", remote]);
    assert.equal((await sourceDriver.pushRepository({ repository: source.value })).status, "succeeded");
    assert.equal((await sourceDriver.createBranch({ repository: source.value, name: "feature/imported" })).status, "succeeded");
    await git(sourceDirectory, ["switch", "feature/imported"]);
    await writeFile(join(sourceDirectory, "feature.txt"), "preserve every branch\n", "utf8");
    assert.equal((await sourceDriver.commitRepository({ repository: source.value, message: "Add import branch" })).status, "succeeded");
    assert.equal((await sourceDriver.pushRepository({ repository: source.value })).status, "succeeded");

    const importDriver = new FailOnceCloneDriver(join(root, "import-driver"));
    const exporter = new LocalProjectExporter(importDriver);
    const destination = join(root, "destination");
    const first = await exporter.importGitRepository({
      project,
      sourceSpace,
      source: remote,
      destination,
      idempotencyKey: "existing-git-import",
    });
    assert.equal(first.status, "failed");
    if (first.status !== "failed") return;
    assert.equal(first.errorCode, "test.injected_clone_failure");
    assert.equal(first.affectedObject, sourceSpace.id);
    assert.match(first.message, /budget=.*limit=.*asked=.*receipt=.*fix=/);
    assert.equal(first.checkpointId.length > 0, true);

    const second = await exporter.importGitRepository({
      project,
      sourceSpace,
      source: remote,
      destination,
      idempotencyKey: "existing-git-import",
    });
    assert.equal(second.status, "succeeded");
    if (second.status !== "succeeded") return;
    assert.equal(second.value.checkpoint.state, "activated");
    assert.equal(second.value.manifest.repositories.length, 1);
    assert.equal(second.value.manifest.repositories[0]?.sourceSpaceId, sourceSpace.id);
    assert.ok(second.value.manifest.repositories[0]?.refs.some((ref) => ref.name === "refs/heads/feature/imported"));
    assert.equal(await readFile(join(destination, "project-export.json")).then((value) => value.length > 0), true);
    const restoredRefs = await importDriver.listRefs({ repository: second.value.repositories[sourceSpace.id]! });
    assert.equal(restoredRefs.status, "succeeded");
    if (restoredRefs.status === "succeeded") {
      const defaultBranch = second.value.manifest.repositories[0]?.defaultBranch;
      assert.ok(defaultBranch);
      assert.ok(restoredRefs.value.some((ref) => ref.name === `refs/heads/${defaultBranch}`));
    }

    const replay = await exporter.importGitRepository({
      project,
      sourceSpace,
      source: remote,
      destination,
      idempotencyKey: "existing-git-import",
    });
    assert.equal(replay.status, "succeeded");
    if (replay.status === "succeeded") assert.equal(replay.value.checkpoint.state, "activated");
    const importKeyDigest = createHash("sha256").update("existing-git-import").digest("hex");
    const operation = JSON.parse(await readFile(join(destination, ".anyam", "imports", importKeyDigest, "git-operation.json"), "utf8")) as { state: string; checkpoint: { state: string } };
    assert.equal(operation.state, "activated");
    assert.equal(operation.checkpoint.state, "activated");
    assert.equal(JSON.stringify(second.value.manifest).includes(remote), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt Project Export objects fail with an owner-visible recovery receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-export-corrupt-"));
  try {
    const driver = new LocalGitRepositoryDriver(join(root, "driver"));
    const repositoryDirectory = join(root, "repository");
    const repository = await driver.createRepository({ sourceSpaceId: sourceSpace.id, directory: repositoryDirectory });
    assert.equal(repository.status, "succeeded");
    if (repository.status !== "succeeded") return;
    await writeFile(join(repositoryDirectory, "file.txt"), "portable\n", "utf8");
    assert.equal((await driver.commitRepository({ repository: repository.value, message: "Create portable source" })).status, "succeeded");
    const packageDirectory = join(root, "export");
    const exported = await new LocalProjectExporter(driver).exportProject({
      project,
      sourceSpaces: [sourceSpace],
      repositories: [{ sourceSpaceId: sourceSpace.id, repository: repository.value }],
      destination: packageDirectory,
      idempotencyKey: "corrupt-export",
    });
    assert.equal(exported.status, "succeeded");
    if (exported.status !== "succeeded") return;
    const bundlePath = join(packageDirectory, "repositories", "source-local", "repository.bundle");
    const original = await readFile(bundlePath);
    await writeFile(bundlePath, Buffer.concat([original, Buffer.from("corrupt")]));
    const verification = await verifyProjectExportPackage(packageDirectory);
    assert.equal(verification.status, "failed");
    if (verification.status === "failed") {
      assert.equal(verification.errorCode, "export.bundle_digest_mismatch");
      assert.equal(verification.affectedObject, sourceSpace.id);
      assert.match(verification.message, /budget=.*limit=.*asked=.*receipt=.*fix=/);
      assert.equal(verification.checkpointId.length > 0, true);
      assert.match(verification.recoveryAction, /replace|repair/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
