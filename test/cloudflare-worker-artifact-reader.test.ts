import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CloudflareWorkerArtifactError,
  createFilesystemWorkerArtifactReader,
} from "../src/cloudflare/worker-target.ts";
import { CONTRACT_VERSIONS, type Artifact } from "../src/kernel/contracts.ts";

const execFileAsync = promisify(execFile);

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifact(outputPath: string, bytes: Uint8Array): Artifact {
  return {
    protocol: CONTRACT_VERSIONS.artifact,
    id: `artifact:${outputPath}`,
    type: "worker.bundle",
    digest: digest(bytes),
    projectRevisionId: "project-revision:artifact-reader-test",
    outputPath,
  };
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "anyam-worker-artifact-reader-"));
}

function boundaryError(reason: string) {
  return (error: unknown): error is CloudflareWorkerArtifactError => {
    return error instanceof CloudflareWorkerArtifactError
      && error.code === "read-failed"
      && error.receipt.includes(`reason=${reason}`);
  };
}

test("filesystem Worker Artifact reader accepts a regular file below the real root", async () => {
  const root = await temporaryRoot();
  try {
    const bytes = new TextEncoder().encode("export default {};");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "worker.js"), bytes);
    const result = await createFilesystemWorkerArtifactReader(root).read(artifact("dist/worker.js", bytes));
    assert.deepEqual(result, bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem Worker Artifact reader rejects every .git path segment including root-relative metadata", async () => {
  const root = await temporaryRoot();
  try {
    const bytes = new TextEncoder().encode("not a Worker");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), bytes);
    const reader = createFilesystemWorkerArtifactReader(root);
    await assert.rejects(reader.read(artifact(".git/config", bytes)), boundaryError("git-metadata"));
    await assert.rejects(reader.read(artifact(".GIT/config", bytes)), boundaryError("git-metadata"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem Worker Artifact reader rejects a symlink even when it resolves inside the root", async () => {
  const root = await temporaryRoot();
  try {
    const bytes = new TextEncoder().encode("export default {};");
    await writeFile(join(root, "worker.js"), bytes);
    await symlink("worker.js", join(root, "link.js"));
    await assert.rejects(
      createFilesystemWorkerArtifactReader(root).read(artifact("link.js", bytes)),
      boundaryError("symlink"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem Worker Artifact reader rejects a symlink escape outside the root", async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();
  try {
    const bytes = new TextEncoder().encode("host secret");
    await writeFile(join(outside, "secret.js"), bytes);
    await symlink(join(outside, "secret.js"), join(root, "worker.js"));
    await assert.rejects(
      createFilesystemWorkerArtifactReader(root).read(artifact("worker.js", bytes)),
      boundaryError("symlink"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("filesystem Worker Artifact reader rejects directories", async () => {
  const root = await temporaryRoot();
  try {
    await mkdir(join(root, "dist"));
    await assert.rejects(
      createFilesystemWorkerArtifactReader(root).read(artifact("dist", new Uint8Array())),
      boundaryError("non-regular"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem Worker Artifact reader rejects FIFOs before opening them", { skip: process.platform === "win32" }, async () => {
  const root = await temporaryRoot();
  try {
    const fifo = join(root, "worker.pipe");
    await execFileAsync("mkfifo", [fifo]);
    await assert.rejects(
      createFilesystemWorkerArtifactReader(root).read(artifact("worker.pipe", new Uint8Array())),
      boundaryError("non-regular"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

