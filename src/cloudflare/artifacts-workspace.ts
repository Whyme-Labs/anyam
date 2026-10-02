import type { SmartHttpRemoteRepositoryBinding } from "../portability/smart-http-driver.ts";
import type { SmartHttpCredential, SmartHttpCredentialIssuer } from "../portability/smart-http.ts";
import { SMART_HTTP_GIT_AUDIENCE } from "../portability/smart-http.ts";

/** Structural subset checked against the pinned Workers Artifacts types. */
export type ArtifactsRepositoryInfo = { id: string; name: string; defaultBranch: string; remote: string; readOnly: boolean };
export type ArtifactsCommit = { hash: string; treeHash: string };
export type ArtifactsRepository = {
  [Symbol.dispose](): void;
  info(): Promise<ArtifactsRepositoryInfo>;
  fork(name: string, options: { readOnly: boolean; defaultBranchOnly: boolean }): Promise<Omit<ArtifactsRepositoryInfo, "readOnly"> & { token: string }>;
  log(options: { ref: string; limit: number }): Promise<ArtifactsCommit[]>;
  readCommit(hash: string): Promise<ArtifactsCommit | null>;
  createToken(scope: "read" | "write", ttl: number): Promise<{ id: string; plaintext: string; scope: "read" | "write"; expiresAt: string }>;
  revokeToken(tokenOrId: string): Promise<boolean>;
};
export type ArtifactsNamespace = { get(name: string): Promise<ArtifactsRepository> };
export type ArtifactsRepositoryIdentity = { accountId: string; namespace: string; repositoryId: string; name: string };
export type ArtifactsWorkspaceSelection = {
  projectId: string;
  projectRevisionId: string;
  projectViewId: string;
  workspaceId: string;
  sourceSpaceId: string;
  sourceRepository: ArtifactsRepositoryIdentity;
  targetName: string;
  baseCommitOid: string;
  baseTreeOid: string;
};
export type ArtifactsWorkspaceContext = {
  selection: ArtifactsWorkspaceSelection;
  repository: ArtifactsRepositoryIdentity & { remote: string };
  binding: SmartHttpRemoteRepositoryBinding;
  storage: "process-local-contract";
  canonicalPublication: "unqualified";
};
export type ArtifactsWorkspaceOptions = {
  artifacts: ArtifactsNamespace;
  accountId: string;
  namespace: string;
  /** Trusted Realm caller rechecks its current grant and throws on denial. */
  authorize(selection: Readonly<ArtifactsWorkspaceSelection>): Promise<{ expiresAt: string }>;
  now?: () => number;
};

type ProviderEffect = "none" | "unknown" | "fork-created" | "token-created";

export class ArtifactsWorkspaceError extends Error {
  constructor(readonly code: string, readonly targetName: string, readonly providerEffect: ProviderEffect, detail: string) {
    super(`${code}: ${detail}; target=${targetName}; effect=${providerEffect}; reconcile the named repository and its tokens before retrying uncertain effects`);
    this.name = "ArtifactsWorkspaceError";
  }
}

function workspaceKey(selection: ArtifactsWorkspaceSelection): string {
  return JSON.stringify([selection.workspaceId, selection.sourceSpaceId]);
}

function repositoryId(identity: ArtifactsRepositoryIdentity): string {
  return `repository:artifacts:${[identity.accountId, identity.namespace, identity.repositoryId].map(encodeURIComponent).join(":")}`;
}

function expectedRemote(identity: ArtifactsRepositoryIdentity): string {
  return `https://${identity.accountId}.artifacts.cloudflare.net/git/${identity.namespace}/${identity.name}.git`;
}

/** Internal, injected control adapter. The trusted caller owns Realm policy.
 * Assignments and token custody are process-local; hosted durability and live
 * service conformance must be qualified before exposing this to agents. */
export class ArtifactsWorkspaceAdapter implements SmartHttpCredentialIssuer {
  private readonly options: ArtifactsWorkspaceOptions;
  private readonly reservedWorkspaces = new Set<string>();
  private readonly reservedNames = new Set<string>();
  private readonly contexts = new Map<string, ArtifactsWorkspaceContext>();
  private readonly tokenIds = new Map<string, Set<string>>();
  private readonly revokedWorkspaces = new Set<string>();
  private readonly unknownTokenInventories = new Set<string>();
  private readonly now: () => number;

  constructor(options: ArtifactsWorkspaceOptions) {
    this.options = { ...options };
    this.now = options.now ?? Date.now;
  }

  async issue(input: Parameters<SmartHttpCredentialIssuer["issue"]>[0]): Promise<SmartHttpCredential> {
    const request = { ...input };
    const context = this.contexts.get(request.repositoryId);
    if (!context || request.sourceSpaceId !== context.selection.sourceSpaceId ||
        (request.workspaceId !== undefined && request.workspaceId !== context.selection.workspaceId) ||
        (request.operation === "write" && request.workspaceId !== context.selection.workspaceId)) {
      throw new ArtifactsWorkspaceError("artifacts.credential_context_denied", "unenrolled", "none", "tokens are available only for the exact enrolled Workspace repository and Source Space");
    }
    try {
      await this.authorize(context.selection, "none");
      using repo = await this.options.artifacts.get(context.selection.targetName);
      return await this.issueInRepository(request, context, repo);
    } catch (error) {
      if (error instanceof ArtifactsWorkspaceError) throw error;
      throw this.error(context.selection, "artifacts.provider_effect_unqualified", "unknown", "credential-provider lookup or disposal failed; reconcile the named repository token metadata");
    }
  }

  private async issueInRepository(request: Parameters<SmartHttpCredentialIssuer["issue"]>[0], context: ArtifactsWorkspaceContext, repo: ArtifactsRepository): Promise<SmartHttpCredential> {
    const selection = context.selection;
    const requestedDeadline = Date.parse(request.expiresAt);
    let effect: ProviderEffect = "none";
    let minted: Awaited<ReturnType<ArtifactsRepository["createToken"]>> | undefined;
    try {
      await this.authorize(selection, effect);
      this.validateInfo(selection, await repo.info(), context.repository, effect);
      const grantDeadline = await this.authorize(selection, effect);
      const deadline = Math.min(requestedDeadline, grantDeadline);
      // Documented Workers Artifacts bounds, not Anyam capacity limits:
      // workers-types 5.20261001.1 createToken TTL min=60, max=31536000 seconds.
      const ttl = Math.min(31_536_000, Math.floor((deadline - this.now()) / 1000));
      if (!Number.isFinite(deadline) || ttl < 60) throw this.error(selection, "artifacts.token_ttl_denied", effect, `provider token ttl_min=60s; requested remaining=${ttl}s; request expiry must fit the current Workspace grant`);
      effect = "unknown";
      minted = await repo.createToken(request.operation, ttl);
      effect = "token-created";
      const expiresAt = Date.parse(minted.expiresAt);
      if (!minted.id || !minted.plaintext || minted.scope !== request.operation || !Number.isFinite(expiresAt) || expiresAt <= this.now() || expiresAt > deadline) throw this.error(selection, "artifacts.token_result_mismatch", effect, "provider token scope and expiry must fit the exact requested authority");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(minted.plaintext));
      const finalDeadline = await this.authorize(selection, effect);
      if (expiresAt > finalDeadline || expiresAt <= this.now()) throw this.error(selection, "artifacts.token_result_mismatch", effect, "the minted token exceeds the current grant or has expired");
      const tokenDigest = `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
      this.tokenIds.get(request.repositoryId)!.add(minted.id);
      return {
        id: minted.id, audience: SMART_HTTP_GIT_AUDIENCE, repositoryId: request.repositoryId, sourceSpaceId: selection.sourceSpaceId, workspaceId: selection.workspaceId,
        operations: request.operation === "write" ? ["read", "write"] : ["read"], canonicalWrite: false,
        tokenDigest, expiresAt: minted.expiresAt, status: "active", token: minted.plaintext,
      };
    } catch (error) {
      if (minted) {
        try {
          if (!await repo.revokeToken(minted.id || minted.plaintext)) throw new Error("retirement unconfirmed");
        } catch {
          this.revokedWorkspaces.add(workspaceKey(selection));
          if (minted.id) this.tokenIds.get(context.binding.repositoryId)!.add(minted.id);
          else this.unknownTokenInventories.add(workspaceKey(selection));
          throw this.error(selection, "artifacts.rejected_token_unretired", effect, "rejected token retirement was not confirmed; no credential is released");
        }
      }
      if (!minted && effect === "unknown") {
        this.revokedWorkspaces.add(workspaceKey(selection));
        this.unknownTokenInventories.add(workspaceKey(selection));
      }
      if (error instanceof ArtifactsWorkspaceError) throw error;
      throw this.error(selection, "artifacts.provider_effect_unqualified", effect, "token provider operation failed; reconcile token metadata before retrying an unknown mint");
    }
  }

  /** Trusted caller only. Stop issuance before awaiting provider retirement. */
  async revokeWorkspace(input: { workspaceId: string; sourceSpaceId: string }): Promise<void> {
    const context = [...this.contexts.values()].find(candidate => candidate.selection.workspaceId === input.workspaceId && candidate.selection.sourceSpaceId === input.sourceSpaceId);
    if (!context) throw new ArtifactsWorkspaceError("artifacts.workspace_unknown", "unenrolled", "none", "resolve the exact registered Workspace and Source Space before revocation");
    const selection = context.selection;
    this.revokedWorkspaces.add(workspaceKey(selection));
    try {
      using repo = await this.options.artifacts.get(selection.targetName);
      this.validateInfo(selection, await repo.info(), context.repository, "unknown");
      const ids = this.tokenIds.get(context.binding.repositoryId)!;
      for (const id of ids) {
        if (!await repo.revokeToken(id)) throw this.error(selection, "artifacts.workspace_token_unretired", "unknown", "Workspace issuance is blocked but provider token retirement was not confirmed");
        ids.delete(id);
      }
      if (this.unknownTokenInventories.has(workspaceKey(selection))) throw this.error(selection, "artifacts.workspace_token_inventory_unknown", "unknown", "a lost mint reply left an unknown token inventory; reconcile provider token metadata rather than claiming complete revocation");
    } catch (error) {
      if (error instanceof ArtifactsWorkspaceError) throw error;
      throw this.error(selection, "artifacts.workspace_token_unretired", "unknown", "Workspace issuance is blocked; reconcile its token metadata and retirement");
    }
  }

  private error(selection: ArtifactsWorkspaceSelection, code: string, effect: ProviderEffect, detail: string): ArtifactsWorkspaceError {
    return new ArtifactsWorkspaceError(code, selection.targetName, effect, detail);
  }

  private async authorize(selection: ArtifactsWorkspaceSelection, effect: ProviderEffect): Promise<number> {
    try {
      const grant = await this.options.authorize(selection);
      const deadline = Date.parse(grant.expiresAt);
      if (this.revokedWorkspaces.has(workspaceKey(selection)) || !Number.isFinite(deadline) || deadline <= this.now()) throw new Error("grant is revoked or expired");
      return deadline;
    } catch {
      throw this.error(selection, "artifacts.authorization_denied", effect, "current Workspace grant is unavailable, denied or expired");
    }
  }

  private validateSelection(selection: ArtifactsWorkspaceSelection): void {
    const source = selection.sourceRepository;
    const segments = [source.accountId, source.namespace, source.name, selection.targetName];
    if (segments.some(value => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(value) || value.includes("..")) ||
        [selection.projectId, selection.projectRevisionId, selection.projectViewId, selection.workspaceId, selection.sourceSpaceId, source.repositoryId].some(value => !value.trim()) ||
        !/^[0-9a-f]{40}$/u.test(selection.baseCommitOid) || !/^[0-9a-f]{40}$/u.test(selection.baseTreeOid) ||
        source.accountId !== this.options.accountId || source.namespace !== this.options.namespace || source.name === selection.targetName) {
      throw this.error(selection, "artifacts.selection_invalid", "none", "select an exact SHA-1 base and distinct Workspace repository inside the enrolled account and namespace");
    }
  }

  private validateInfo(selection: ArtifactsWorkspaceSelection, info: ArtifactsRepositoryInfo, identity: ArtifactsRepositoryIdentity, effect: ProviderEffect): void {
    if (!identity.repositoryId || info.id !== identity.repositoryId || info.name !== identity.name || info.remote !== expectedRemote(identity) || !info.defaultBranch) {
      throw this.error(selection, "artifacts.repository_identity_mismatch", effect, "provider UUID, name or credential-free account/namespace remote differs from enrollment");
    }
  }

  private async validateBase(selection: ArtifactsWorkspaceSelection, repo: ArtifactsRepository, branch: string, effect: ProviderEffect): Promise<void> {
    const head = await repo.log({ ref: `refs/heads/${branch}`, limit: 1 });
    const commit = await repo.readCommit(selection.baseCommitOid);
    if (head.length !== 1 || head[0]?.hash !== selection.baseCommitOid || head[0].treeHash !== selection.baseTreeOid || commit?.hash !== selection.baseCommitOid || commit.treeHash !== selection.baseTreeOid) {
      throw this.error(selection, "artifacts.base_mismatch", effect, "fresh default-branch head and commit/tree readback must match the selected base exactly");
    }
  }

  async forkWorkspace(input: ArtifactsWorkspaceSelection): Promise<ArtifactsWorkspaceContext> {
    const selection = Object.freeze({ ...input, sourceRepository: Object.freeze({ ...input.sourceRepository }) });
    this.validateSelection(selection);
    const key = workspaceKey(selection);
    if (this.reservedWorkspaces.has(key) || this.reservedNames.has(selection.targetName)) throw this.error(selection, "artifacts.workspace_already_bound", "none", "this Workspace/Source Space or target name is already assigned or requires reconciliation");
    this.reservedWorkspaces.add(key);
    this.reservedNames.add(selection.targetName);
    let effect: ProviderEffect = "none";
    try {
      await this.authorize(selection, effect);
      using source = await this.options.artifacts.get(selection.sourceRepository.name);
      const sourceInfo = await source.info();
      this.validateInfo(selection, sourceInfo, selection.sourceRepository, effect);
      await this.validateBase(selection, source, sourceInfo.defaultBranch, effect);
      await this.authorize(selection, effect);
      // The documented fork API has no pinned-commit argument. Check its
      // actual result instead of assuming that it copied a stable snapshot.
      effect = "unknown";
      const forked = await source.fork(selection.targetName, { readOnly: false, defaultBranchOnly: false });
      effect = "fork-created";
      using target = await this.options.artifacts.get(selection.targetName);
      if (!forked.token || !await target.revokeToken(forked.token)) throw this.error(selection, "artifacts.initial_token_unretired", effect, "initial fork token retirement was not confirmed");
      const identity = { accountId: this.options.accountId, namespace: this.options.namespace, repositoryId: forked.id, name: selection.targetName };
      const targetInfo = await target.info();
      this.validateInfo(selection, targetInfo, identity, effect);
      if (forked.id === sourceInfo.id || forked.name !== targetInfo.name || forked.remote !== targetInfo.remote || forked.defaultBranch !== sourceInfo.defaultBranch || targetInfo.defaultBranch !== sourceInfo.defaultBranch || targetInfo.readOnly) throw this.error(selection, "artifacts.fork_metadata_mismatch", effect, "returned fork must be the independent writable repository at the selected default branch");
      await this.validateBase(selection, target, targetInfo.defaultBranch, effect);
      await this.authorize(selection, effect);
      const context: ArtifactsWorkspaceContext = Object.freeze({
        selection,
        repository: Object.freeze({ ...identity, remote: targetInfo.remote }),
        binding: Object.freeze({ source: targetInfo.remote, repositoryId: repositoryId(identity), sourceSpaceId: selection.sourceSpaceId, workspaceId: selection.workspaceId }),
        storage: "process-local-contract", canonicalPublication: "unqualified",
      });
      this.contexts.set(context.binding.repositoryId, context);
      this.tokenIds.set(context.binding.repositoryId, new Set());
      return context;
    } catch (error) {
      if (effect === "none") { this.reservedWorkspaces.delete(key); this.reservedNames.delete(selection.targetName); }
      if (error instanceof ArtifactsWorkspaceError) throw error;
      throw this.error(selection, "artifacts.provider_effect_unqualified", effect, "provider operation failed; its response is withheld from credential-free errors");
    }
  }
}
