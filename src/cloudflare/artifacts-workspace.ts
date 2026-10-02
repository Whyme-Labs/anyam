import type { SmartHttpRemoteRepositoryBinding } from "../portability/smart-http-driver.ts";
import type { SmartHttpCredential, SmartHttpCredentialIssuer } from "../portability/smart-http.ts";
import { SMART_HTTP_GIT_AUDIENCE } from "../portability/smart-http.ts";
import { MemoryArtifactsWorkspaceStore, type ArtifactsWorkspaceStore } from "./artifacts-workspace-store.ts";
import { repositoryObservationDigest, REPOSITORY_OBSERVATION_PROTOCOL } from "../portability/repository-observation.ts";
import type { RepositoryDriver, RepositoryDriverResult } from "../portability/repository-driver.ts";
import type { RepositoryObservation } from "../kernel/contracts.ts";

/** Structural subset checked against the pinned Workers Artifacts types. */
export type ArtifactsRepositoryInfo = { id: string; name: string; defaultBranch: string; remote: string; readOnly: boolean };
export type ArtifactsCommit = { hash: string; treeHash: string; parents?: readonly string[] };
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
  storage: ArtifactsWorkspaceStore["storage"];
  canonicalPublication: "unqualified";
};
export type ArtifactsWorkspaceOptions = {
  artifacts: ArtifactsNamespace;
  accountId: string;
  namespace: string;
  /** Trusted Realm caller rechecks its current grant and throws on denial. */
  authorize(selection: Readonly<ArtifactsWorkspaceSelection>): Promise<{ expiresAt: string }>;
  now?: () => number;
  store?: ArtifactsWorkspaceStore;
};

type ProviderEffect = "none" | "unknown" | "fork-created" | "token-created";

export class ArtifactsWorkspaceError extends Error {
  constructor(readonly code: string, readonly targetName: string, readonly providerEffect: ProviderEffect, detail: string) {
    super(`${code}: ${detail}; target=${targetName}; effect=${providerEffect}; reconcile the named repository and its tokens before retrying uncertain effects`);
    this.name = "ArtifactsWorkspaceError";
  }
}

function repositoryId(identity: ArtifactsRepositoryIdentity): string {
  return `repository:artifacts:${[identity.accountId, identity.namespace, identity.repositoryId].map(encodeURIComponent).join(":")}`;
}

function expectedRemote(identity: ArtifactsRepositoryIdentity): string {
  return `https://${identity.accountId}.artifacts.cloudflare.net/git/${identity.namespace}/${identity.name}.git`;
}

function immutableSelection(input: ArtifactsWorkspaceSelection): ArtifactsWorkspaceSelection {
  const source = input.sourceRepository;
  return Object.freeze({
    projectId: input.projectId, projectRevisionId: input.projectRevisionId, projectViewId: input.projectViewId,
    workspaceId: input.workspaceId, sourceSpaceId: input.sourceSpaceId, targetName: input.targetName,
    baseCommitOid: input.baseCommitOid, baseTreeOid: input.baseTreeOid,
    sourceRepository: Object.freeze({ accountId: source.accountId, namespace: source.namespace, repositoryId: source.repositoryId, name: source.name }),
  });
}

/** Internal, injected control adapter. The trusted caller owns Realm policy.
 * The default store is process-local. Injected SQLite custody is qualified
 * locally; hosted durability and live service conformance remain separate. */
export class ArtifactsWorkspaceAdapter implements SmartHttpCredentialIssuer {
  private readonly options: ArtifactsWorkspaceOptions;
  private readonly store: ArtifactsWorkspaceStore;
  private readonly now: () => number;

  constructor(options: ArtifactsWorkspaceOptions) {
    this.options = { ...options };
    this.store = options.store ?? new MemoryArtifactsWorkspaceStore();
    this.now = options.now ?? Date.now;
  }

  /** Trusted observer seam. Provider reads never rely on a local checkout. */
  async observeRepository(input: Parameters<RepositoryDriver["observeRepository"]>[0]): Promise<RepositoryDriverResult<RepositoryObservation>> {
    const request = { ...input, repository: { ...input.repository } };
    try {
      const context = this.custody("unenrolled", () => this.store.repository(request.repository.repositoryId)?.context);
      if (!context || context.repository.accountId !== this.options.accountId || context.repository.namespace !== this.options.namespace ||
          request.repository.sourceSpaceId !== context.selection.sourceSpaceId || request.workspaceId !== context.selection.workspaceId || request.projectViewId !== context.selection.projectViewId) {
        throw new ArtifactsWorkspaceError("artifacts.credential_context_denied", "unenrolled", "none", "observation requires the exact enrolled Workspace, Source Space and Project View");
      }
      const selection = context.selection;
      const symbolicRef = request.expectedSymbolicRef;
      const oid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
      if (!symbolicRef?.startsWith("refs/heads/") || symbolicRef.endsWith(".") || symbolicRef.includes("..") || symbolicRef.includes("@{") ||
          /[\x00-\x20\x7f~^:?*[\]\\]/u.test(symbolicRef) || symbolicRef.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock")) ||
          (request.expectedObjectFormat !== undefined && request.expectedObjectFormat !== "sha1") || !oid(request.expectedCommitOid) || !oid(request.expectedBaseCommitOid) ||
          (request.expectedTreeOid !== undefined && !oid(request.expectedTreeOid))) {
        throw this.error(selection, "artifacts.observation_request_invalid", "none", "select a full literal branch ref and exact SHA-1 commit, tree and base");
      }
      await this.authorize(selection, "none");
      using repo = await this.options.artifacts.get(selection.targetName);
      this.validateInfo(selection, await repo.info(), context.repository, "none");
      const heads = await repo.log({ ref: symbolicRef, limit: 1 });
      const head = { hash: heads[0]?.hash, treeHash: heads[0]?.treeHash };
      if (heads.length !== 1 || head.hash !== request.expectedCommitOid || !oid(head.treeHash) || (request.expectedTreeOid !== undefined && head.treeHash !== request.expectedTreeOid)) {
        throw this.error(selection, "artifacts.observation_candidate_mismatch", "none", "fresh branch head must match the exact expected commit and tree");
      }
      const commits = new Set<string>();
      const visiting = new Set<string>();
      const pending = [{ hash: head.hash, complete: false }];
      while (pending.length) {
        const item = pending.pop()!;
        if (item.complete) { visiting.delete(item.hash); commits.add(item.hash); continue; }
        if (commits.has(item.hash)) continue;
        if (visiting.has(item.hash)) throw this.error(selection, "artifacts.observation_graph_invalid", "none", "provider ancestry contains a cycle");
        const commit = await repo.readCommit(item.hash);
        if (commit?.hash !== item.hash || !oid(commit.treeHash) || !Array.isArray(commit.parents) || commit.parents.some(parent => !oid(parent)) ||
            (item.hash === head.hash && commit.treeHash !== head.treeHash)) {
          throw this.error(selection, "artifacts.observation_graph_invalid", "none", "every reachable commit must have its exact identity, tree and complete parent list");
        }
        visiting.add(item.hash);
        pending.push({ hash: item.hash, complete: true }, ...commit.parents.map(hash => ({ hash, complete: false })));
      }
      if (!commits.has(request.expectedBaseCommitOid)) throw this.error(selection, "artifacts.observation_ancestry_mismatch", "none", "the selected base must be reachable in the complete candidate graph");
      const claims = {
        protocol: REPOSITORY_OBSERVATION_PROTOCOL, repositoryId: request.repository.repositoryId,
        sourceSpaceId: selection.sourceSpaceId, workspaceId: selection.workspaceId, projectViewId: selection.projectViewId,
        objectFormat: "sha1" as const, symbolicRef, commitOid: head.hash, treeOid: head.treeHash,
        baseCommitOid: request.expectedBaseCommitOid, ancestryVerified: true as const,
        observedAt: new Date(this.now()).toISOString(),
        receipt: `provider=artifacts; repositoryUuid=${context.repository.repositoryId}; reachableCommits=${commits.size}; ancestry=all-parents; credentialMaterialStored=false; canonicalPublication=unqualified`,
      };
      const manifestDigest = await repositoryObservationDigest(claims);
      this.validateInfo(selection, await repo.info(), context.repository, "none");
      const currentHeads = await repo.log({ ref: symbolicRef, limit: 1 });
      if (currentHeads.length !== 1 || currentHeads[0]?.hash !== head.hash || currentHeads[0]?.treeHash !== head.treeHash) {
        throw this.error(selection, "artifacts.observation_candidate_mismatch", "none", "the selected branch moved during observation; publish a fresh exact candidate");
      }
      await this.authorize(selection, "none");
      return { status: "succeeded", value: { ...claims, manifestDigest } };
    } catch (error) {
      return { status: "failed", errorCode: error instanceof ArtifactsWorkspaceError ? error.code : "artifacts.observation_unqualified", message: "Fresh Workspace observation could not be qualified; inspect the exact named repository before retrying.", retryable: false };
    }
  }

  async issue(input: Parameters<SmartHttpCredentialIssuer["issue"]>[0]): Promise<SmartHttpCredential> {
    const request = { ...input };
    const context = this.custody("unenrolled", () => this.store.repository(request.repositoryId)?.context);
    if (!context || context.repository.accountId !== this.options.accountId || context.repository.namespace !== this.options.namespace || request.sourceSpaceId !== context.selection.sourceSpaceId ||
        (request.workspaceId !== undefined && request.workspaceId !== context.selection.workspaceId) ||
        (request.operation === "write" && request.workspaceId !== context.selection.workspaceId)) {
      throw new ArtifactsWorkspaceError("artifacts.credential_context_denied", "unenrolled", "none", "tokens are available only for the exact enrolled Workspace repository and Source Space");
    }
    try {
      await this.authorize(context.selection, "none");
      if (this.store.read(context.selection)!.pendingOperation !== "none") throw this.error(context.selection, "artifacts.workspace_operation_pending", "unknown", "a prior provider operation remains pending; reconcile its effect before issuing another credential");
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
    let tokenRecorded = false;
    try {
      await this.authorize(selection, effect);
      this.validateInfo(selection, await repo.info(), context.repository, effect);
      const grantDeadline = await this.authorize(selection, effect);
      const deadline = Math.min(requestedDeadline, grantDeadline);
      // Documented Workers Artifacts bounds, not Anyam capacity limits:
      // workers-types 5.20261001.1 createToken TTL min=60, max=31536000 seconds.
      const ttl = Math.min(31_536_000, Math.floor((deadline - this.now()) / 1000));
      if (!Number.isFinite(deadline) || ttl < 60) throw this.error(selection, "artifacts.token_ttl_denied", effect, `provider token ttl_min=60s; requested remaining=${ttl}s; request expiry must fit the current Workspace grant`);
      this.store.change(selection, record => {
        if (record.blocked) throw this.error(selection, "artifacts.authorization_denied", "none", "Workspace issuance has been revoked");
        if (record.pendingOperation !== "none") throw this.error(selection, "artifacts.workspace_operation_pending", "unknown", "a prior mint remains pending; reconcile its effect before retrying");
        record.pendingOperation = "mint";
      });
      effect = "unknown";
      minted = await repo.createToken(request.operation, ttl);
      effect = "token-created";
      if (minted.id) { this.store.change(selection, record => { record.tokenIds.push(minted!.id); }); tokenRecorded = true; }
      this.validateInfo(selection, await repo.info(), context.repository, effect);
      const expiresAt = Date.parse(minted.expiresAt);
      if (!minted.id || !minted.plaintext || minted.scope !== request.operation || !Number.isFinite(expiresAt) || expiresAt <= this.now() || expiresAt > deadline) throw this.error(selection, "artifacts.token_result_mismatch", effect, "provider token scope and expiry must fit the exact requested authority");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(minted.plaintext));
      const finalDeadline = await this.authorize(selection, effect);
      if (expiresAt > finalDeadline || expiresAt <= this.now()) throw this.error(selection, "artifacts.token_result_mismatch", effect, "the minted token exceeds the current grant or has expired");
      const tokenDigest = `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
      this.store.change(selection, record => {
        if (record.blocked) throw this.error(selection, "artifacts.authorization_denied", effect, "Workspace issuance has been revoked");
        record.pendingOperation = "none";
      });
      return {
        id: minted.id, audience: SMART_HTTP_GIT_AUDIENCE, repositoryId: request.repositoryId, sourceSpaceId: selection.sourceSpaceId, workspaceId: selection.workspaceId,
        operations: request.operation === "write" ? ["read", "write"] : ["read"], canonicalWrite: false,
        tokenDigest, expiresAt: minted.expiresAt, status: "active", token: minted.plaintext,
      };
    } catch (error) {
      if (minted) {
        try {
          const alreadyRetired = tokenRecorded && !this.store.read(selection)!.tokenIds.includes(minted.id);
          if (!alreadyRetired && !await repo.revokeToken(minted.id || minted.plaintext)) throw new Error("retirement unconfirmed");
          this.store.change(selection, record => { record.tokenIds = record.tokenIds.filter(id => id !== minted!.id); record.pendingOperation = "none"; });
        } catch {
          this.store.change(selection, record => {
            record.blocked = true;
            record.pendingOperation = "none";
            if (minted!.id && !record.tokenIds.includes(minted!.id)) record.tokenIds.push(minted!.id);
            if (!minted!.id) record.unknownTokenInventory = true;
          });
          throw this.error(selection, "artifacts.rejected_token_unretired", effect, "rejected token retirement was not confirmed; no credential is released");
        }
      }
      if (!minted && effect === "unknown") {
        this.store.change(selection, record => { record.blocked = true; record.unknownTokenInventory = true; });
      }
      if (error instanceof ArtifactsWorkspaceError) throw error;
      throw this.error(selection, "artifacts.provider_effect_unqualified", effect, "token provider operation failed; reconcile token metadata before retrying an unknown mint");
    }
  }

  /** Trusted caller only. Stop issuance before awaiting provider retirement. */
  async revokeWorkspace(input: { workspaceId: string; sourceSpaceId: string }): Promise<void> {
    const selectionKey = { workspaceId: input.workspaceId, sourceSpaceId: input.sourceSpaceId, sourceRepository: { accountId: this.options.accountId, namespace: this.options.namespace } };
    const reserved = this.custody("unenrolled", () => this.store.read(selectionKey));
    if (!reserved) throw new ArtifactsWorkspaceError("artifacts.workspace_unknown", "unenrolled", "none", "resolve the exact registered Workspace and Source Space before revocation");
    const { selection, context } = reserved;
    this.custody(selection.targetName, () => this.store.change(selection, record => { record.blocked = true; }));
    if (!context) {
      if (reserved.pendingOperation !== "none" || reserved.unknownTokenInventory) throw this.error(selection, "artifacts.workspace_token_inventory_unknown", "unknown", "Workspace issuance is blocked before enrollment; reconcile the pending provider operation and its token inventory");
      return;
    }
    try {
      using repo = await this.options.artifacts.get(selection.targetName);
      this.validateInfo(selection, await repo.info(), context.repository, "unknown");
      const ids = this.store.read(selection)!.tokenIds;
      for (const id of ids) {
        if (!await repo.revokeToken(id)) throw this.error(selection, "artifacts.workspace_token_unretired", "unknown", "Workspace issuance is blocked but provider token retirement was not confirmed");
        this.store.change(selection, record => { record.tokenIds = record.tokenIds.filter(candidate => candidate !== id); });
      }
      const current = this.store.read(selection)!;
      if (current.unknownTokenInventory || current.pendingOperation !== "none") throw this.error(selection, "artifacts.workspace_token_inventory_unknown", "unknown", "a pending or lost mint reply left an unknown token inventory; reconcile provider token metadata rather than claiming complete revocation");
    } catch (error) {
      if (error instanceof ArtifactsWorkspaceError) throw error;
      throw this.error(selection, "artifacts.workspace_token_unretired", "unknown", "Workspace issuance is blocked; reconcile its token metadata and retirement");
    }
  }

  private error(selection: ArtifactsWorkspaceSelection, code: string, effect: ProviderEffect, detail: string): ArtifactsWorkspaceError {
    return new ArtifactsWorkspaceError(code, selection.targetName, effect, detail);
  }

  private custody<T>(targetName: string, operation: () => T): T {
    try { return operation(); }
    catch { throw new ArtifactsWorkspaceError("artifacts.custody_unavailable", targetName, "none", "Workspace custody could not be read or committed; no provider operation was started; inspect the trusted store before retrying"); }
  }

  private async authorize(selection: ArtifactsWorkspaceSelection, effect: ProviderEffect): Promise<number> {
    try {
      const grant = await this.options.authorize(immutableSelection(selection));
      const deadline = Date.parse(grant.expiresAt);
      if (this.store.read(selection)?.blocked || !Number.isFinite(deadline) || deadline <= this.now()) throw new Error("grant is revoked or expired");
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
    const selection = immutableSelection(input);
    this.validateSelection(selection);
    const reserved = this.custody(selection.targetName, () => this.store.reserve(selection));
    if (!reserved) throw this.error(selection, "artifacts.workspace_already_bound", "none", "this Workspace/Source Space or target name is already assigned or requires reconciliation");
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
      this.store.change(selection, record => {
        if (record.blocked) throw this.error(selection, "artifacts.authorization_denied", effect, "Workspace issuance has been revoked");
        record.pendingOperation = "fork";
      });
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
        storage: this.store.storage, canonicalPublication: "unqualified",
      });
      this.store.change(selection, record => {
        if (record.blocked) throw this.error(selection, "artifacts.authorization_denied", effect, "Workspace issuance has been revoked");
        record.context = context;
        record.pendingOperation = "none";
      });
      return context;
    } catch (error) {
      if (effect === "none") this.store.release(selection);
      if (error instanceof ArtifactsWorkspaceError) throw error;
      throw this.error(selection, "artifacts.provider_effect_unqualified", effect, "provider operation failed; its response is withheld from credential-free errors");
    }
  }
}
