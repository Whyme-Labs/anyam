import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { opaqueId, type GitObjectFormat, type GitRef, type LargeObjectRef, type RepositoryExport } from "../kernel/contracts.ts";
import type {
  RepositoryDriver,
  RepositoryDriverCapabilities,
  RepositoryDriverDescriptor,
  RepositoryDriverFailure,
  RepositoryDriverHealth,
  RepositoryDriverResult,
  RepositoryExportReceipt,
  RepositoryHandle,
  RepositoryIntegrityReport,
  RepositoryOperationReceipt,
  RepositoryRestoreReceipt,
  RepositoryState,
} from "./repository-driver.ts";

type LocalRepository = {
  handle: RepositoryHandle;
  directory: string;
};

type GitCommandResult = {
  stdout: string;
  stderr: string;
};

class GitCommandError extends Error {
  readonly operation: string;
  readonly stderr: string;

  constructor(operation: string, stderr: string) {
    super(`git ${operation} failed`);
    this.name = "GitCommandError";
    this.operation = operation;
    this.stderr = stderr;
  }
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function operationReceipt(repository: RepositoryHandle, operation: string, detail: string): RepositoryOperationReceipt {
  return {
    operationId: opaqueId(`repository-${operation}`),
    repositoryId: repository.repositoryId,
    sourceSpaceId: repository.sourceSpaceId,
    receipt: `${operation}; ${detail}`,
  };
}

function failure(
  errorCode: string,
  operation: string,
  affectedObject: string,
  retryable: boolean,
  detail = "retry the operation after inspecting the local Git repository",
): Omit<RepositoryDriverFailure, "status"> {
  return {
    errorCode,
    message: `Git ${operation} is blocked for ${affectedObject}; ${detail}.`,
    retryable,
    affectedObject,
    recoveryAction: detail,
    receipt: `operation=${operation}; object=${affectedObject}; provider=local-git`,
    budget: {
      name: "git-object-transfer",
      limit: "the complete requested repository operation",
      asked: affectedObject,
      receipt: `operation=${operation}; object=${affectedObject}; provider=local-git`,
    },
  };
}

async function runGit(directory: string | undefined, args: readonly string[]): Promise<GitCommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", [...args], {
      cwd: directory,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolveResult({ stdout, stderr });
      } else {
        reject(new GitCommandError(args[0] ?? "command", stderr));
      }
    });
  });
}

async function commandSucceeds(directory: string, args: readonly string[]): Promise<boolean> {
  try {
    await runGit(directory, args);
    return true;
  } catch {
    return false;
  }
}

async function hasGitRepository(directory: string): Promise<boolean> {
  const markers = [join(directory, ".git"), join(directory, "HEAD"), join(directory, "objects")];
  const present: boolean[] = [];
  for (const marker of markers) {
    try {
      await stat(marker);
      present.push(true);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") present.push(false);
      else throw error;
    }
  }
  return present[0] === true || (present[1] === true && present[2] === true);
}

async function bundleRefs(bundlePath: string): Promise<GitRef[]> {
  const result = await runGit(undefined, ["bundle", "list-heads", bundlePath]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [oid, name] = line.split(/\s+/, 2);
      return { name: name ?? "", oid: oid ?? "" };
    })
    .filter((ref) => ref.name.length > 0 && ref.oid.length > 0);
}

function objectFormatFrom(value: string): GitObjectFormat {
  return value.trim() === "sha256" ? "sha256" : "sha1";
}

function parseRefs(output: string): GitRef[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("\0");
      return separator < 0
        ? { name: line, oid: "" }
        : { name: line.slice(0, separator), oid: line.slice(separator + 1) };
    })
    .filter((ref) => ref.name.length > 0 && ref.oid.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function refMap(refs: readonly GitRef[]): Map<string, string> {
  return new Map(refs.map((ref) => [ref.name, ref.oid]));
}

function refsEqual(left: readonly GitRef[], right: readonly GitRef[]): boolean {
  if (left.length !== right.length) return false;
  const rightMap = refMap(right);
  return left.every((ref) => rightMap.get(ref.name) === ref.oid);
}

function portableRefs(refs: readonly GitRef[]): GitRef[] {
  return refs.filter((ref) => !ref.name.startsWith("refs/remotes/"));
}

function pointerFor(content: string): { oid: string; size: number } | undefined {
  if (!content.startsWith("version https://git-lfs.github.com/spec/v1")) return undefined;
  const oid = /^oid sha256:([a-f0-9]+)$/m.exec(content)?.[1];
  const sizeText = /^size ([0-9]+)$/m.exec(content)?.[1];
  if (!oid || !sizeText) return undefined;
  const size = Number(sizeText);
  return Number.isSafeInteger(size) && size >= 0 ? { oid, size } : undefined;
}

async function enumerateLfs(
  directory: string,
  exportDirectory: string,
): Promise<{ state: RepositoryExport["lfs"]["state"]; objects: LargeObjectRef[]; paths: Record<string, string> }> {
  let files: GitCommandResult;
  try {
    files = await runGit(directory, ["ls-files", "-z"]);
  } catch {
    return enumerateBareLfs(directory, exportDirectory);
  }
  const objects: LargeObjectRef[] = [];
  const paths: Record<string, string> = {};
  const trackedFiles = files.stdout.split("\0").filter((file) => file.length > 0);
  for (const trackedFile of trackedFiles) {
    let content: string;
    try {
      content = await readFile(join(directory, trackedFile), "utf8");
    } catch {
      continue;
    }
    const pointer = pointerFor(content);
    if (!pointer) continue;
    const first = pointer.oid.slice(0, 2);
    const second = pointer.oid.slice(2, 4);
    const remainder = pointer.oid.slice(4);
    const objectPath = join(directory, ".git", "lfs", "objects", first, second, remainder);
    const relativePath = join("lfs", pointer.oid);
    const exportPath = join(exportDirectory, relativePath);
    let digest: string | undefined;
    try {
      const bytes = await readFile(objectPath);
      await mkdir(dirname(exportPath), { recursive: true });
      await writeFile(exportPath, bytes);
      digest = digestBytes(bytes);
      paths[pointer.oid] = exportPath;
    } catch {
      // The pointer remains in the manifest so the export is explicitly incomplete.
    }
    objects.push({
      oid: `sha256:${pointer.oid}`,
      size: pointer.size,
      relativePath,
      ...(digest ? { digest } : {}),
    });
  }
  if (objects.length === 0) return { state: "empty", objects, paths };
  return {
    state: objects.every((object) => object.digest !== undefined) ? "complete" : "incomplete",
    objects,
    paths,
  };
}

async function enumerateBareLfs(
  directory: string,
  exportDirectory: string,
): Promise<{ state: RepositoryExport["lfs"]["state"]; objects: LargeObjectRef[]; paths: Record<string, string> }> {
  const objects: LargeObjectRef[] = [];
  const paths: Record<string, string> = {};
  const listed = await runGit(directory, ["rev-list", "--objects", "--all"]);
  for (const line of listed.stdout.split("\n").filter((entry) => entry.length > 0)) {
    const separator = line.indexOf(" ");
    if (separator < 0) continue;
    const blobId = line.slice(0, separator);
    let content: string;
    try {
      content = (await runGit(directory, ["cat-file", "blob", blobId])).stdout;
    } catch {
      continue;
    }
    const pointer = pointerFor(content);
    if (!pointer) continue;
    const relativePath = join("lfs", pointer.oid);
    const exportPath = join(exportDirectory, relativePath);
    const objectPath = [
      join(directory, "lfs", "objects", pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid.slice(4)),
      join(directory, ".git", "lfs", "objects", pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid.slice(4)),
    ];
    let digest: string | undefined;
    for (const candidate of objectPath) {
      try {
        const bytes = await readFile(candidate);
        await mkdir(dirname(exportPath), { recursive: true });
        await writeFile(exportPath, bytes);
        digest = digestBytes(bytes);
        paths[pointer.oid] = exportPath;
        break;
      } catch {
        // Keep the pointer and mark the object incomplete when the LFS payload is absent.
      }
    }
    if (objects.some((object) => object.oid === `sha256:${pointer.oid}`)) continue;
    objects.push({
      oid: `sha256:${pointer.oid}`,
      size: pointer.size,
      relativePath,
      ...(digest ? { digest } : {}),
    });
  }
  if (objects.length === 0) return { state: "empty", objects, paths };
  return {
    state: objects.every((object) => object.digest !== undefined) ? "complete" : "incomplete",
    objects,
    paths,
  };
}

async function readDefaultBranch(directory: string): Promise<string | null> {
  try {
    const result = await runGit(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readObjectFormat(directory: string): Promise<GitObjectFormat> {
  try {
    const result = await runGit(directory, ["rev-parse", "--show-object-format=storage"]);
    return objectFormatFrom(result.stdout);
  } catch {
    return "sha1";
  }
}

export class LocalGitRepositoryDriver implements RepositoryDriver {
  private readonly repositories = new Map<string, LocalRepository>();
  private readonly directoryToRepository = new Map<string, RepositoryHandle>();

  constructor(private readonly workspaceRoot: string) {}

  async describe(): Promise<RepositoryDriverResult<RepositoryDriverDescriptor>> {
    return {
      status: "succeeded",
      value: {
        protocol: "anyam.repository-driver/v1",
        id: "driver:local-git",
        name: "Local Git RepositoryDriver",
        version: "v1",
        capabilities: this.capabilities(),
      },
    };
  }

  async probe(): Promise<RepositoryDriverResult<RepositoryDriverHealth>> {
    try {
      const result = await runGit(undefined, ["--version"]);
      return { status: "succeeded", value: { state: "healthy", receipt: result.stdout.trim() } };
    } catch {
      return {
        status: "failed",
        ...failure("git.unavailable", "probe", "local-git", false, "install Git and rerun the probe"),
      };
    }
  }

  async createRepository(input: {
    sourceSpaceId: string;
    directory?: string;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryHandle>> {
    const directory = resolve(input.directory ?? join(this.workspaceRoot, safeName(opaqueId("repository"))));
    const existing = this.directoryToRepository.get(directory);
    if (existing) return { status: "succeeded", value: { ...existing } };
    try {
      await mkdir(directory, { recursive: true });
      if (!(await hasGitRepository(directory))) {
        await runGit(directory, ["init", "--quiet"]);
      }
      const handle = { repositoryId: opaqueId("repository"), sourceSpaceId: input.sourceSpaceId };
      this.register(handle, directory);
      return { status: "succeeded", value: { ...handle } };
    } catch (error) {
      return {
        status: "failed",
        ...failure("repository.create_failed", "create", input.sourceSpaceId, true, "inspect the checkpoint and retry repository creation"),
        receipt: `operation=create; object=${input.sourceSpaceId}; requested=${directory}; cause=${error instanceof Error ? error.name : "unknown"}`,
      };
    }
  }

  async inspectRepository(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<RepositoryState>> {
    const directory = this.directoryFor(input.repository);
    if (!directory) return { status: "failed", ...failure("repository.unknown", "inspect", input.repository.repositoryId, false, "restore or register the repository before inspecting it") };
    try {
      const refs = await this.listRefsOrThrow(directory);
      const objectFormat = await readObjectFormat(directory);
      const defaultBranch = await readDefaultBranch(directory);
      const generation = digestText(JSON.stringify({ objectFormat, defaultBranch, refs }));
      return {
        status: "succeeded",
        value: {
          repository: { ...input.repository },
          objectFormat,
          defaultBranch,
          refs,
          generation,
        },
      };
    } catch {
      return { status: "failed", ...failure("repository.inspect_failed", "inspect", input.repository.repositoryId, true, "verify the repository and retry inspection") };
    }
  }

  async deleteRepository(input: {
    repository: RepositoryHandle;
    expectedGeneration?: string;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    const directory = this.directoryFor(input.repository);
    if (!directory) return { status: "succeeded", value: operationReceipt(input.repository, "delete", "already absent") };
    if (input.expectedGeneration) {
      const inspection = await this.inspectRepository({ repository: input.repository });
      if (inspection.status === "succeeded" && inspection.value.generation !== input.expectedGeneration) {
        return { status: "failed", ...failure("repository.stale_generation", "delete", input.repository.repositoryId, false, "refresh the repository generation before deleting") };
      }
    }
    try {
      await rm(directory, { recursive: true, force: true });
      this.repositories.delete(input.repository.repositoryId);
      this.directoryToRepository.delete(directory);
      return { status: "succeeded", value: operationReceipt(input.repository, "delete", "repository removed") };
    } catch {
      return { status: "failed", ...failure("repository.delete_failed", "delete", input.repository.repositoryId, true, "retry deletion from the recorded checkpoint") };
    }
  }

  async cloneRepository(input: {
    sourceSpaceId: string;
    source: string;
    destination?: string;
    mirror?: boolean;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryHandle>> {
    const destination = resolve(input.destination ?? join(this.workspaceRoot, safeName(opaqueId("clone"))));
    const existing = this.directoryToRepository.get(destination);
    if (existing) return { status: "succeeded", value: { ...existing } };
    try {
      await mkdir(dirname(destination), { recursive: true });
      await runGit(undefined, ["clone", "--quiet", ...(input.mirror ? ["--mirror"] : []), input.source, destination]);
      const handle = { repositoryId: opaqueId("repository"), sourceSpaceId: input.sourceSpaceId };
      this.register(handle, destination);
      return { status: "succeeded", value: { ...handle } };
    } catch (error) {
      return {
        status: "failed",
        ...failure("repository.clone_failed", "clone", input.sourceSpaceId, true, "verify the source and retry from the clone checkpoint"),
        receipt: `operation=clone; object=${input.sourceSpaceId}; requested=${destination}; cause=${error instanceof Error ? error.name : "unknown"}`,
      };
    }
  }

  async fetchRepository(input: {
    repository: RepositoryHandle;
    remote?: string;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    const directory = this.directoryFor(input.repository);
    if (!directory) return { status: "failed", ...failure("repository.unknown", "fetch", input.repository.repositoryId, false, "restore or register the repository before fetching") };
    const remote = input.remote ?? "origin";
    try {
      await runGit(directory, ["fetch", "--prune", "--tags", remote]);
      return { status: "succeeded", value: operationReceipt(input.repository, "fetch", `remote=${remote}`) };
    } catch {
      return { status: "failed", ...failure("repository.fetch_failed", "fetch", input.repository.repositoryId, true, "inspect the remote and retry fetch") };
    }
  }

  async pushRepository(input: {
    repository: RepositoryHandle;
    remote?: string;
    refs?: readonly string[];
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    const directory = this.directoryFor(input.repository);
    if (!directory) return { status: "failed", ...failure("repository.unknown", "push", input.repository.repositoryId, false, "restore or register the repository before pushing") };
    const remote = input.remote ?? "origin";
    try {
      if (input.refs && input.refs.length > 0) {
        for (const ref of input.refs) await runGit(directory, ["push", remote, ref]);
      } else {
        await runGit(directory, ["push", "--all", remote]);
        await runGit(directory, ["push", "--tags", remote]);
      }
      return { status: "succeeded", value: operationReceipt(input.repository, "push", `remote=${remote}; refs=${input.refs?.join(",") ?? "all"}`) };
    } catch {
      return { status: "failed", ...failure("repository.push_failed", "push", input.repository.repositoryId, true, "inspect remote refs and retry without changing canonical authority") };
    }
  }

  async createBranch(input: {
    repository: RepositoryHandle;
    name: string;
    startPoint?: string;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    return this.runRepositoryCommand(input.repository, "branch", ["branch", input.name, ...(input.startPoint ? [input.startPoint] : [])]);
  }

  async createTag(input: {
    repository: RepositoryHandle;
    name: string;
    target?: string;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    return this.runRepositoryCommand(input.repository, "tag", ["tag", input.name, ...(input.target ? [input.target] : [])]);
  }

  async diffRepository(input: {
    repository: RepositoryHandle;
    base?: string;
    compare?: string;
  }): Promise<RepositoryDriverResult<{ text: string; digest: string }>> {
    const directory = this.directoryFor(input.repository);
    if (!directory) return { status: "failed", ...failure("repository.unknown", "diff", input.repository.repositoryId, false, "restore or register the repository before diffing") };
    try {
      const refs = ["--no-ext-diff", ...(input.base ? [input.base] : []), ...(input.compare ? [input.compare] : [])];
      const result = await runGit(directory, ["diff", ...refs]);
      return { status: "succeeded", value: { text: result.stdout, digest: digestText(result.stdout) } };
    } catch {
      return { status: "failed", ...failure("repository.diff_failed", "diff", input.repository.repositoryId, true, "verify the requested refs and retry diff") };
    }
  }

  async commitRepository(input: {
    repository: RepositoryHandle;
    message: string;
    paths?: readonly string[];
    author?: { name: string; email: string };
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<{ commitId: string; receipt: string }>> {
    const directory = this.directoryFor(input.repository);
    if (!directory) return { status: "failed", ...failure("repository.unknown", "commit", input.repository.repositoryId, false, "restore or register the repository before committing") };
    try {
      await runGit(directory, ["add", "--all", ...(input.paths ?? [])]);
      const author = input.author ?? { name: "Anyam Local", email: "anyam-local@localhost" };
      await runGit(directory, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", input.message]);
      const commitId = (await runGit(directory, ["rev-parse", "HEAD"])).stdout.trim();
      return { status: "succeeded", value: { commitId, receipt: `commit=${commitId}; repository=${input.repository.repositoryId}` } };
    } catch (error) {
      const noChanges = error instanceof GitCommandError && /nothing to commit|nothing added to commit/i.test(error.stderr);
      return {
        status: "failed",
        ...failure(noChanges ? "repository.nothing_to_commit" : "repository.commit_failed", "commit", input.repository.repositoryId, !noChanges, noChanges ? "modify a tracked file and retry the commit" : "inspect the worktree and retry the commit"),
      };
    }
  }

  async listRefs(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<readonly GitRef[]>> {
    const directory = this.directoryFor(input.repository);
    if (!directory) return { status: "failed", ...failure("repository.unknown", "list-refs", input.repository.repositoryId, false, "restore or register the repository before listing refs") };
    try {
      return { status: "succeeded", value: await this.listRefsOrThrow(directory) };
    } catch {
      return { status: "failed", ...failure("repository.refs_failed", "list-refs", input.repository.repositoryId, true, "verify repository integrity and retry listing refs") };
    }
  }

  async compareAndSwapRefs(input: {
    repository: RepositoryHandle;
    expected: Readonly<Record<string, string | null>>;
    desired: Readonly<Record<string, string | null>>;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    const directory = this.directoryFor(input.repository);
    if (!directory) return { status: "failed", ...failure("repository.unknown", "compare-and-swap", input.repository.repositoryId, false, "restore or register the repository before updating refs") };
    try {
      const current = refMap(await this.listRefsOrThrow(directory));
      for (const [ref, expected] of Object.entries(input.expected)) {
        const actual = current.get(ref) ?? null;
        if (actual !== expected) {
          return { status: "failed", ...failure("repository.stale_ref", "compare-and-swap", ref, false, `refresh the ref and retry with expected=${expected ?? "absent"}; actual=${actual ?? "absent"}`) };
        }
      }
      for (const [ref, desired] of Object.entries(input.desired)) {
        if (desired === null) await runGit(directory, ["update-ref", "-d", ref]);
        else await runGit(directory, ["update-ref", ref, desired]);
      }
      return { status: "succeeded", value: operationReceipt(input.repository, "compare-and-swap", `refs=${Object.keys(input.desired).join(",")}`) };
    } catch {
      return { status: "failed", ...failure("repository.ref_update_failed", "compare-and-swap", input.repository.repositoryId, true, "inspect ref state and retry from the expected generation") };
    }
  }

  async exportRepository(input: {
    repository: RepositoryHandle;
    destination: string;
    refs?: readonly string[];
    checkpointId?: string;
  }): Promise<RepositoryDriverResult<RepositoryExportReceipt>> {
    const directory = this.directoryFor(input.repository);
    if (!directory) return { status: "failed", ...failure("repository.unknown", "export", input.repository.repositoryId, false, "restore or register the repository before exporting") };
    const bundlePath = join(input.destination, "repository.bundle");
    try {
      await mkdir(input.destination, { recursive: true });
      const refs = await this.listRefsOrThrow(directory);
      const exportedRefs = portableRefs(refs);
      if (exportedRefs.length === 0) return { status: "failed", ...failure("repository.empty", "export", input.repository.repositoryId, false, "create an initial commit before exporting a Git repository") };
      const selectedRefs = input.refs && input.refs.length > 0
        ? exportedRefs.filter((ref) => input.refs?.includes(ref.name) === true)
        : exportedRefs;
      const bundleArgs = ["bundle", "create", bundlePath, ...selectedRefs.map((ref) => ref.name)];
      await runGit(directory, bundleArgs);
      await runGit(directory, ["bundle", "verify", bundlePath]);
      const bundleBytes = await readFile(bundlePath);
      const lfs = await enumerateLfs(directory, input.destination);
      const repository: RepositoryExport = {
        protocol: "anyam.repository-export/v1",
        repositoryId: input.repository.repositoryId,
        sourceSpaceId: input.repository.sourceSpaceId,
        objectFormat: await readObjectFormat(directory),
        defaultBranch: await readDefaultBranch(directory),
        refs: selectedRefs,
        bundle: {
          relativePath: "repository.bundle",
          digest: digestBytes(bundleBytes),
          bytes: bundleBytes.byteLength,
        },
        lfs: { state: lfs.state, objects: lfs.objects },
      };
      return {
        status: "succeeded",
        value: {
          repository,
          bundlePath,
          lfsObjectPaths: lfs.paths,
          receipt: `repository=${input.repository.repositoryId}; refs=${repository.refs.length}; bundleBytes=${repository.bundle.bytes}; bundleDigest=${repository.bundle.digest}; checkpoint=${input.checkpointId ?? "none"}`,
        },
      };
    } catch {
      return { status: "failed", ...failure("repository.export_failed", "export", input.repository.repositoryId, true, "resume from the named checkpoint after verifying the destination") };
    }
  }

  async restoreRepository(input: {
    sourceSpaceId: string;
    bundlePath: string;
    destination: string;
    expectedDigest?: string;
    lfsObjects?: readonly { oid: string; sourcePath: string; digest?: string }[];
    refs?: readonly GitRef[];
    defaultBranch?: string | null;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryRestoreReceipt>> {
    try {
      const bundle = await readFile(input.bundlePath);
      const digest = digestBytes(bundle);
      if (input.expectedDigest && digest !== input.expectedDigest) {
        return { status: "failed", ...failure("repository.bundle_digest_mismatch", "restore", input.sourceSpaceId, false, `replace the corrupt bundle and retry; expected=${input.expectedDigest}; actual=${digest}`) };
      }
      const destination = resolve(input.destination);
      let handle = this.directoryToRepository.get(destination);
      let alreadyPresent = handle !== undefined;
      if (!handle && await hasGitRepository(destination)) {
        const registered = await this.createRepository({ sourceSpaceId: input.sourceSpaceId, directory: destination, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) });
        if (registered.status !== "succeeded") return registered;
        handle = registered.value;
        alreadyPresent = true;
      }
      if (!handle) {
        await mkdir(dirname(destination), { recursive: true });
        await runGit(undefined, ["clone", "--quiet", input.bundlePath, destination]);
      }
      await commandSucceeds(destination, ["remote", "remove", "origin"]);
      const refs = input.refs ?? await bundleRefs(input.bundlePath);
      for (const ref of refs) await runGit(destination, ["update-ref", ref.name, ref.oid]);
      if (input.defaultBranch) await runGit(destination, ["symbolic-ref", "HEAD", `refs/heads/${input.defaultBranch}`]);
      for (const object of input.lfsObjects ?? []) {
        const oid = object.oid.replace(/^sha256:/, "");
        const bytes = await readFile(object.sourcePath);
        const actual = digestBytes(bytes);
        if (object.digest && actual !== object.digest) {
          return { status: "failed", ...failure("repository.lfs_digest_mismatch", "restore", input.sourceSpaceId, false, `replace the corrupt LFS object and retry; expected=${object.digest}; actual=${actual}`) };
        }
        const destinationPath = join(destination, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid.slice(4));
        await mkdir(dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, bytes);
      }
      if (!handle) {
        handle = { repositoryId: opaqueId("repository"), sourceSpaceId: input.sourceSpaceId };
        this.register(handle, destination);
      }
      const state = await this.inspectRepository({ repository: handle });
      if (state.status !== "succeeded") return state;
      return { status: "succeeded", value: { repository: { ...handle }, state: state.value, receipt: `repository=${handle.repositoryId}; restored=${alreadyPresent ? "already-present" : "verified"}; bundleDigest=${digest}` } };
    } catch (error) {
      const detail = error instanceof GitCommandError ? `resume from the recovery checkpoint after checking the destination; command=${error.operation}` : "resume from the recovery checkpoint after checking the destination";
      return { status: "failed", ...failure("repository.restore_failed", "restore", input.sourceSpaceId, true, detail) };
    }
  }

  async verifyRepository(input: {
    repository: RepositoryHandle;
    expected?: RepositoryExport;
    bundlePath?: string;
  }): Promise<RepositoryDriverResult<RepositoryIntegrityReport>> {
    const directory = this.directoryFor(input.repository);
    if (!directory) return { status: "failed", ...failure("repository.unknown", "verify", input.repository.repositoryId, false, "restore or register the repository before verifying") };
    try {
      const refs = portableRefs(await this.listRefsOrThrow(directory));
      const objectFormat = await readObjectFormat(directory);
      const fsckPassed = await commandSucceeds(directory, ["fsck", "--full"]);
      let bundleVerified = true;
      if (input.bundlePath) bundleVerified = await commandSucceeds(directory, ["bundle", "verify", input.bundlePath]);
      const refsMatch = input.expected ? refsEqual(refs, input.expected.refs) : true;
      const lfsComplete = input.expected
        ? input.expected.lfs.state === "empty"
          ? true
          : input.expected.lfs.state === "complete" && await this.lfsObjectsPresent(directory, input.expected.lfs.objects)
        : true;
      const report: RepositoryIntegrityReport = {
        repositoryId: input.repository.repositoryId,
        refsMatch,
        objectFormat,
        bundleVerified,
        fsckPassed,
        lfsComplete,
        receipt: `repository=${input.repository.repositoryId}; refsMatch=${refsMatch}; bundleVerified=${bundleVerified}; fsckPassed=${fsckPassed}; lfsComplete=${lfsComplete}`,
      };
      return { status: "succeeded", value: report };
    } catch {
      return { status: "failed", ...failure("repository.verify_failed", "verify", input.repository.repositoryId, true, "retry verification from the recovery checkpoint") };
    }
  }

  private capabilities(): RepositoryDriverCapabilities {
    return {
      git: {
        clone: true,
        fetch: true,
        push: true,
        branch: true,
        tag: true,
        diff: true,
        commit: true,
        objectFormats: ["sha1", "sha256"],
      },
      lifecycle: { create: true, import: true, export: true, restore: true, verify: true },
      lfs: { enumerate: true, export: true, restore: true },
    };
  }

  private register(handle: RepositoryHandle, directory: string): void {
    const normalized = resolve(directory);
    this.repositories.set(handle.repositoryId, { handle: { ...handle }, directory: normalized });
    this.directoryToRepository.set(normalized, { ...handle });
  }

  private directoryFor(handle: RepositoryHandle): string | undefined {
    return this.repositories.get(handle.repositoryId)?.directory;
  }

  private async listRefsOrThrow(directory: string): Promise<GitRef[]> {
    const result = await runGit(directory, ["for-each-ref", "--format=%(refname)%00%(objectname)"]);
    return parseRefs(result.stdout);
  }

  private async lfsObjectsPresent(directory: string, objects: readonly LargeObjectRef[]): Promise<boolean> {
    for (const object of objects) {
      const oid = object.oid.replace(/^sha256:/, "");
      const objectPath = join(directory, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid.slice(4));
      try {
        const bytes = await readFile(objectPath);
        if (object.digest && digestBytes(bytes) !== object.digest) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async runRepositoryCommand(
    handle: RepositoryHandle,
    operation: string,
    args: readonly string[],
  ): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    const directory = this.directoryFor(handle);
    if (!directory) return { status: "failed", ...failure("repository.unknown", operation, handle.repositoryId, false, "restore or register the repository before continuing") };
    try {
      await runGit(directory, args);
      return { status: "succeeded", value: operationReceipt(handle, operation, `command=${args[0]}`) };
    } catch {
      return { status: "failed", ...failure(`repository.${operation}_failed`, operation, handle.repositoryId, true, `inspect the repository and retry ${operation}`) };
    }
  }
}

export function localRepositoryDirectory(root: string, handle: RepositoryHandle): string {
  return join(resolve(root), safeName(handle.repositoryId));
}

export function isLocalRepositoryDriver(value: unknown): value is LocalGitRepositoryDriver {
  return value instanceof LocalGitRepositoryDriver;
}
