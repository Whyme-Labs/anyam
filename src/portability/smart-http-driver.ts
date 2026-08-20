import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

import { opaqueId } from "../kernel/contracts.ts";
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
import { LocalGitRepositoryDriver } from "./local-git.ts";
import type { SmartHttpCredential, SmartHttpCredentialIssuer } from "./smart-http.ts";

type GitCommandResult = { stdout: string; stderr: string };

type GitCommandError = Error & { operation?: string; stderr?: string };

type RemoteBinding = {
  local: RepositoryHandle;
  repositoryId: string;
  sourceSpaceId: string;
  sourceUrl: string;
  directory: string;
  workspaceId?: string;
};

export type SmartHttpRepositoryDriverOptions = {
  workspaceRoot: string;
  credentials: SmartHttpCredentialIssuer;
  credentialExpiresAt: () => string;
  workspaceIdForRepository?: (repositoryId: string) => string | undefined;
  allowInsecureHttp?: boolean;
  /** Qualification-only TLS trust bypass for a local self-signed fixture. */
  allowInsecureTlsForQualification?: boolean;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function operationId(operation: string, repositoryId: string, idempotencyKey?: string): string {
  return `repository-smart-http:${digest(`${operation}:${repositoryId}:${idempotencyKey ?? "none"}`)}`;
}

function failure(
  input: {
    errorCode: string;
    operation: string;
    affectedObject: string;
    retryable: boolean;
    recoveryAction: string;
    idempotencyKey?: string | undefined;
    detail?: string | undefined;
  },
): RepositoryDriverFailure {
  const checkpointId = `repository-checkpoint:${digest(`${input.operation}:${input.affectedObject}:${input.idempotencyKey ?? "none"}`)}`;
  return {
    status: "failed",
    errorCode: input.errorCode,
    message: `Smart HTTP ${input.operation} is blocked for ${input.affectedObject}; ${input.detail ?? input.recoveryAction}.`,
    retryable: input.retryable,
    affectedObject: input.affectedObject,
    checkpointId,
    recoveryAction: input.recoveryAction,
    receipt: `provider=smart-http; operation=${input.operation}; object=${input.affectedObject}; checkpoint=${checkpointId}; credentialMaterialStored=false`,
    budget: {
      name: "git-smart-http-operation",
      limit: "the complete requested Git operation",
      asked: input.affectedObject,
      receipt: `provider=smart-http; operation=${input.operation}; checkpoint=${checkpointId}; providerFactsAreNotAnyamLimits=true`,
    },
  };
}

function success(repository: RepositoryHandle, operation: string, detail: string, idempotencyKey?: string): RepositoryOperationReceipt {
  return {
    operationId: operationId(operation, repository.repositoryId, idempotencyKey),
    repositoryId: repository.repositoryId,
    sourceSpaceId: repository.sourceSpaceId,
    receipt: `provider=smart-http; operation=${operation}; ${detail}; credentialMaterialStored=false`,
  };
}

function parseRepositoryId(source: string): string | undefined {
  try {
    const url = new URL(source);
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    const gitSegment = [...segments].reverse().find((segment) => segment.endsWith(".git"));
    if (!gitSegment) return undefined;
    const id = decodeURIComponent(gitSegment.slice(0, -4));
    return id.length > 0 && !id.includes("..") && !id.includes("/") ? id : undefined;
  } catch {
    return undefined;
  }
}

function remoteProtocol(source: string): "https:" | "http:" | undefined {
  try {
    const protocol = new URL(source).protocol;
    return protocol === "https:" || protocol === "http:" ? protocol : undefined;
  } catch {
    return undefined;
  }
}

function authEnvironment(credential: SmartHttpCredential, allowInsecureTlsForQualification: boolean): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential.token}`,
    ...(allowInsecureTlsForQualification ? { GIT_SSL_NO_VERIFY: "1" } : {}),
  };
}

function runGit(directory: string | undefined, args: readonly string[], credential?: SmartHttpCredential, allowInsecureTlsForQualification = false): Promise<GitCommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", [...args], {
      cwd: directory,
      windowsHide: true,
      env: { ...process.env, ...(credential ? authEnvironment(credential, allowInsecureTlsForQualification) : { GIT_TERMINAL_PROMPT: "0" }) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveResult({ stdout, stderr });
      else {
        const error = new Error(`git ${args[0] ?? "command"} failed`) as GitCommandError;
        error.operation = args[0] ?? "command";
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function expectCredential(credential: SmartHttpCredential, input: { repositoryId: string; sourceSpaceId: string; operation: "read" | "write"; workspaceId?: string }): RepositoryDriverFailure | undefined {
  if (credential.audience !== "aud:anyam:git") return failure({ errorCode: "credential.audience_mismatch", operation: input.operation, affectedObject: input.repositoryId, retryable: false, recoveryAction: "request an audience-bound Anyam Git credential", detail: `expected=aud:anyam:git; actual=${credential.audience}` });
  if (credential.repositoryId !== input.repositoryId || credential.sourceSpaceId !== input.sourceSpaceId) return failure({ errorCode: "credential.resource_mismatch", operation: input.operation, affectedObject: input.repositoryId, retryable: false, recoveryAction: "request a credential for the exact repository and Source Space", detail: "resource-bound=false" });
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) return failure({ errorCode: "credential.expired", operation: input.operation, affectedObject: input.repositoryId, retryable: false, recoveryAction: "reauthenticate and issue a fresh short-lived Git credential", detail: `expiresAt=${credential.expiresAt}` });
  if (!credential.operations.includes(input.operation)) return failure({ errorCode: "credential.operation_denied", operation: input.operation, affectedObject: input.repositoryId, retryable: false, recoveryAction: input.operation === "write" ? "push only through an explicitly provisioned Workspace" : "request Git read authority", detail: `allowed=${credential.operations.join(",")}; canonicalWrite=${credential.canonicalWrite}` });
  if (input.operation === "write" && (!input.workspaceId || credential.workspaceId !== input.workspaceId || credential.canonicalWrite)) return failure({ errorCode: "canonical_write_denied", operation: input.operation, affectedObject: input.repositoryId, retryable: false, recoveryAction: "push to the exact Workspace repository and request Landing for canonical mutation", detail: `workspace=${input.workspaceId ?? "missing"}; credentialWorkspace=${credential.workspaceId ?? "none"}; canonicalWrite=${credential.canonicalWrite}` });
  return undefined;
}

/**
 * Git Smart HTTP RepositoryDriver. Git moves source objects over HTTPS while
 * the portable RepositoryDriver keeps handles credential-free. Workspace
 * pushes use `--force-with-lease` for CAS operations; canonical pushes are
 * rejected before Git is invoked.
 */
export class SmartHttpRepositoryDriver implements RepositoryDriver {
  private readonly local: LocalGitRepositoryDriver;
  private readonly remotes = new Map<string, RemoteBinding>();
  private readonly options: SmartHttpRepositoryDriverOptions;

  constructor(options: SmartHttpRepositoryDriverOptions) {
    this.options = options;
    this.local = new LocalGitRepositoryDriver(options.workspaceRoot);
  }

  async describe(): Promise<RepositoryDriverResult<RepositoryDriverDescriptor>> {
    return {
      status: "succeeded",
      value: {
        protocol: "anyam.repository-driver/v1",
        id: "driver:smart-http",
        name: "Anyam Git Smart HTTP RepositoryDriver",
        version: "v1",
        capabilities: this.capabilities(),
      },
    };
  }

  async probe(): Promise<RepositoryDriverResult<RepositoryDriverHealth>> {
    return {
      status: "succeeded",
      value: {
        state: "healthy",
        receipt: "provider=smart-http; transport=Git Smart HTTP; credentialBroker=required; providerContact=deferred-to-repository-operation; credentialMaterialStored=false",
      },
    };
  }

  async createRepository(input: { sourceSpaceId: string; directory?: string; idempotencyKey?: string }): Promise<RepositoryDriverResult<RepositoryHandle>> {
    return failure({ errorCode: "repository.create_unsupported", operation: "create", affectedObject: input.sourceSpaceId, retryable: false, recoveryAction: "create the customer repository through the provider control adapter, then clone it through Smart HTTP", idempotencyKey: input.idempotencyKey, detail: "Git Smart HTTP has no repository-creation operation" });
  }

  async inspectRepository(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<RepositoryState>> {
    return this.local.inspectRepository(input);
  }

  async deleteRepository(input: { repository: RepositoryHandle; expectedGeneration?: string; idempotencyKey?: string }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    const binding = this.binding(input.repository);
    if (!binding) return failure({ errorCode: "repository.unknown", operation: "delete", affectedObject: input.repository.repositoryId, retryable: false, recoveryAction: "restore or register the Smart HTTP checkout before deleting it", idempotencyKey: input.idempotencyKey });
    if (binding.workspaceId === undefined) return failure({ errorCode: "canonical_delete_denied", operation: "delete", affectedObject: binding.repositoryId, retryable: false, recoveryAction: "delete only disposable Workspace checkouts; canonical repository lifecycle belongs to the control adapter", idempotencyKey: input.idempotencyKey, detail: "canonicalRepository=true" });
    const result = await this.local.deleteRepository(input);
    if (result.status === "succeeded") this.remotes.delete(input.repository.repositoryId);
    return result.status === "succeeded" ? { status: "succeeded", value: success(input.repository, "delete", "workspaceCheckout=removed", input.idempotencyKey) } : result;
  }

  async cloneRepository(input: { sourceSpaceId: string; source: string; destination?: string; mirror?: boolean; idempotencyKey?: string }): Promise<RepositoryDriverResult<RepositoryHandle>> {
    const protocol = remoteProtocol(input.source);
    if (!protocol || (protocol === "http:" && this.options.allowInsecureHttp !== true)) return failure({ errorCode: "repository.transport_denied", operation: "clone", affectedObject: input.sourceSpaceId, retryable: false, recoveryAction: "use an HTTPS Smart HTTP endpoint; allow insecure HTTP only in a qualification harness", idempotencyKey: input.idempotencyKey, detail: `protocol=${protocol ?? "invalid"}` });
    const repositoryId = parseRepositoryId(input.source);
    if (!repositoryId) return failure({ errorCode: "repository.url_invalid", operation: "clone", affectedObject: input.sourceSpaceId, retryable: false, recoveryAction: "use a Git gateway URL shaped as /git/<repositoryId>.git", idempotencyKey: input.idempotencyKey });
    let credential: SmartHttpCredential;
    try {
      credential = await this.options.credentials.issue({ repositoryId, sourceSpaceId: input.sourceSpaceId, operation: "read", expiresAt: this.options.credentialExpiresAt() });
    } catch (error) {
      return failure({ errorCode: "credential.issue_failed", operation: "clone", affectedObject: repositoryId, retryable: true, recoveryAction: "restore the Realm credential broker and retry the same clone checkpoint", idempotencyKey: input.idempotencyKey, detail: error instanceof Error ? error.message : "credential broker rejected" });
    }
    const credentialFailure = expectCredential(credential, { repositoryId, sourceSpaceId: input.sourceSpaceId, operation: "read" });
    if (credentialFailure) return credentialFailure;
    const destination = resolve(input.destination ?? `${this.options.workspaceRoot}/${safeName(repositoryId)}-${safeName(opaqueId("clone"))}`);
    try {
      await mkdir(dirname(destination), { recursive: true });
      await runGit(undefined, ["clone", "--quiet", ...(input.mirror ? ["--mirror"] : []), input.source, destination], credential, this.options.allowInsecureTlsForQualification === true);
      const local = await this.local.createRepository({ sourceSpaceId: input.sourceSpaceId, directory: destination });
      if (local.status !== "succeeded") return local;
      const workspaceId = this.options.workspaceIdForRepository?.(repositoryId);
      this.remotes.set(local.value.repositoryId, { local: local.value, repositoryId, sourceSpaceId: input.sourceSpaceId, sourceUrl: input.source, directory: destination, ...(workspaceId ? { workspaceId } : {}) });
      return local;
    } catch (error) {
      return failure({ errorCode: "repository.clone_failed", operation: "clone", affectedObject: repositoryId, retryable: true, recoveryAction: "inspect the Smart HTTP checkpoint and retry the same clone operation", idempotencyKey: input.idempotencyKey, detail: this.gitDetail(error) });
    }
  }

  async fetchRepository(input: { repository: RepositoryHandle; remote?: string; idempotencyKey?: string }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    const binding = this.binding(input.repository);
    if (!binding) return failure({ errorCode: "repository.unknown", operation: "fetch", affectedObject: input.repository.repositoryId, retryable: false, recoveryAction: "restore or register the Smart HTTP checkout before fetching", idempotencyKey: input.idempotencyKey });
    const credentialResult = await this.issue(binding, "read", input.idempotencyKey);
    if (credentialResult.status !== "succeeded") return credentialResult;
    try {
      await runGit(this.localDirectory(binding), ["fetch", "--prune", "--tags", input.remote ?? "origin"], credentialResult.value, this.options.allowInsecureTlsForQualification === true);
      return { status: "succeeded", value: success(input.repository, "fetch", `remote=${input.remote ?? "origin"}; repository=${binding.repositoryId}`, input.idempotencyKey) };
    } catch (error) {
      return failure({ errorCode: "repository.fetch_failed", operation: "fetch", affectedObject: binding.repositoryId, retryable: true, recoveryAction: "inspect the provider checkpoint and retry fetch with a fresh short-lived Git credential", idempotencyKey: input.idempotencyKey, detail: this.gitDetail(error) });
    }
  }

  async pushRepository(input: { repository: RepositoryHandle; remote?: string; refs?: readonly string[]; idempotencyKey?: string }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    const binding = this.binding(input.repository);
    if (!binding) return failure({ errorCode: "repository.unknown", operation: "push", affectedObject: input.repository.repositoryId, retryable: false, recoveryAction: "restore or register the Smart HTTP checkout before pushing", idempotencyKey: input.idempotencyKey });
    if (!binding.workspaceId) return failure({ errorCode: "canonical_write_denied", operation: "push", affectedObject: binding.repositoryId, retryable: false, recoveryAction: "push to a disposable Workspace repository and request Landing for canonical mutation", idempotencyKey: input.idempotencyKey, detail: "canonicalWrite=false; workspace=missing" });
    const credentialResult = await this.issue(binding, "write", input.idempotencyKey);
    if (credentialResult.status !== "succeeded") return credentialResult;
    try {
      const remote = input.remote ?? "origin";
      if (input.refs && input.refs.length > 0) {
        for (const ref of input.refs) await runGit(this.localDirectory(binding), ["push", remote, ref], credentialResult.value, this.options.allowInsecureTlsForQualification === true);
      } else {
        await runGit(this.localDirectory(binding), ["push", "--all", remote], credentialResult.value, this.options.allowInsecureTlsForQualification === true);
        await runGit(this.localDirectory(binding), ["push", "--tags", remote], credentialResult.value, this.options.allowInsecureTlsForQualification === true);
      }
      return { status: "succeeded", value: success(input.repository, "push", `remote=${remote}; refs=${input.refs?.join(",") ?? "all"}; workspace=${binding.workspaceId}; canonicalWrite=false`, input.idempotencyKey) };
    } catch (error) {
      return failure({ errorCode: "repository.push_failed", operation: "push", affectedObject: binding.repositoryId, retryable: true, recoveryAction: "inspect the provider checkpoint and retry the same Workspace push without widening authority", idempotencyKey: input.idempotencyKey, detail: this.gitDetail(error) });
    }
  }

  async createBranch(input: { repository: RepositoryHandle; name: string; startPoint?: string; idempotencyKey?: string }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    return this.local.createBranch(input);
  }

  async createTag(input: { repository: RepositoryHandle; name: string; target?: string; idempotencyKey?: string }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    return this.local.createTag(input);
  }

  async diffRepository(input: { repository: RepositoryHandle; base?: string; compare?: string }): Promise<RepositoryDriverResult<{ text: string; digest: string }>> {
    return this.local.diffRepository(input);
  }

  async commitRepository(input: { repository: RepositoryHandle; message: string; paths?: readonly string[]; author?: { name: string; email: string }; idempotencyKey?: string }): Promise<RepositoryDriverResult<{ commitId: string; receipt: string }>> {
    return this.local.commitRepository(input);
  }

  async listRefs(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<readonly import("../kernel/contracts.ts").GitRef[]>> {
    return this.local.listRefs(input);
  }

  async compareAndSwapRefs(input: { repository: RepositoryHandle; expected: Readonly<Record<string, string | null>>; desired: Readonly<Record<string, string | null>>; idempotencyKey?: string }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    const binding = this.binding(input.repository);
    if (!binding) return failure({ errorCode: "repository.unknown", operation: "compare-and-swap", affectedObject: input.repository.repositoryId, retryable: false, recoveryAction: "restore or register the Smart HTTP checkout before a CAS push", idempotencyKey: input.idempotencyKey });
    if (!binding.workspaceId) return failure({ errorCode: "canonical_write_denied", operation: "compare-and-swap", affectedObject: binding.repositoryId, retryable: false, recoveryAction: "request Landing through the Authority Plane; canonical refs are not directly writable", idempotencyKey: input.idempotencyKey, detail: "canonicalWrite=false" });
    const credentialResult = await this.issue(binding, "write", input.idempotencyKey);
    if (credentialResult.status !== "succeeded") return credentialResult;
    const args = ["push", "origin"];
    for (const [ref, expected] of Object.entries(input.expected)) args.push(`--force-with-lease=${ref}:${expected ?? ""}`);
    for (const [ref, desired] of Object.entries(input.desired)) args.push(desired === null ? `:${ref}` : `${desired}:${ref}`);
    try {
      await runGit(this.localDirectory(binding), args, credentialResult.value, this.options.allowInsecureTlsForQualification === true);
      return { status: "succeeded", value: success(input.repository, "compare-and-swap", `refs=${Object.keys(input.desired).join(",")}; lease=force-with-lease; workspace=${binding.workspaceId}; canonicalWrite=false`, input.idempotencyKey) };
    } catch (error) {
      const detail = this.gitDetail(error);
      return failure({ errorCode: /stale|lease|rejected|non-fast-forward/i.test(detail) ? "repository.stale_ref" : "repository.ref_update_failed", operation: "compare-and-swap", affectedObject: binding.repositoryId, retryable: false, recoveryAction: "inspect the current remote ref and publish a new Change Revision from the current Project Revision", idempotencyKey: input.idempotencyKey, detail });
    }
  }

  async exportRepository(input: { repository: RepositoryHandle; destination: string; refs?: readonly string[]; checkpointId?: string }): Promise<RepositoryDriverResult<RepositoryExportReceipt>> {
    const result = await this.local.exportRepository(input);
    return result.status === "succeeded" ? { status: "succeeded", value: { ...result.value, receipt: `${result.value.receipt}; provider=smart-http; export=portable-local-bundle; credentialMaterialStored=false` } } : result;
  }

  async restoreRepository(input: Parameters<RepositoryDriver["restoreRepository"]>[0]): Promise<RepositoryDriverResult<RepositoryRestoreReceipt>> {
    const result = await this.local.restoreRepository(input);
    return result.status === "succeeded" ? { status: "succeeded", value: { ...result.value, receipt: `${result.value.receipt}; provider=smart-http; restore=portable-local-bundle; credentialMaterialStored=false` } } : result;
  }

  async verifyRepository(input: Parameters<RepositoryDriver["verifyRepository"]>[0]): Promise<RepositoryDriverResult<RepositoryIntegrityReport>> {
    return this.local.verifyRepository(input);
  }

  private capabilities(): RepositoryDriverCapabilities {
    return {
      git: { clone: true, fetch: true, push: true, branch: true, tag: true, diff: true, commit: true, objectFormats: ["sha1", "sha256"] },
      lifecycle: { create: false, import: true, export: true, restore: true, verify: true },
      lfs: { enumerate: true, export: true, restore: true },
      consistency: {
        durableBeforeAcknowledgement: "unverified",
        linearizableRefPublication: "unverified",
        readAfterWrite: "unverified",
        replayAfterCacheLoss: "unsupported",
        exactExportRestore: "observed",
        receipt: "provider=smart-http; consistency=provider-conformance-required; durableBeforeAcknowledgement=unverified; linearizableRefPublication=unverified; readAfterWrite=unverified; replayAfterCacheLoss=unsupported; exactExportRestore=observed; providerFactsAreNotAnyamLimits=true",
      },
    };
  }

  private binding(repository: RepositoryHandle): RemoteBinding | undefined {
    return this.remotes.get(repository.repositoryId);
  }

  private localDirectory(binding: RemoteBinding): string {
    return binding.directory;
  }

  private async issue(binding: RemoteBinding, operation: "read" | "write", idempotencyKey?: string): Promise<RepositoryDriverResult<SmartHttpCredential>> {
    try {
      const credential = await this.options.credentials.issue({ repositoryId: binding.repositoryId, sourceSpaceId: binding.sourceSpaceId, ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}), operation, expiresAt: this.options.credentialExpiresAt() });
      const invalid = expectCredential(credential, { repositoryId: binding.repositoryId, sourceSpaceId: binding.sourceSpaceId, operation, ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}) });
      return invalid ?? { status: "succeeded", value: credential };
    } catch (error) {
      return failure({ errorCode: "credential.issue_failed", operation, affectedObject: binding.repositoryId, retryable: true, recoveryAction: "restore the Realm credential broker and retry the same Git checkpoint", idempotencyKey, detail: error instanceof Error ? error.message : "credential broker rejected" });
    }
  }

  private gitDetail(error: unknown): string {
    const detail = error as GitCommandError;
    const stderr = detail.stderr?.trim().replace(/\s+/g, " ");
    return stderr ? `command=${detail.operation ?? "git"}; providerMessage=${stderr.slice(0, 300)}` : `command=${detail.operation ?? "git"}; providerMessage=unavailable`;
  }
}
