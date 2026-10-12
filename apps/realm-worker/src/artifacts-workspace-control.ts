import { ArtifactsWorkspaceAdapter, ArtifactsWorkspaceError, immutableArtifactsWorkspaceSelection, type ArtifactsNamespace } from "../../../src/cloudflare/artifacts-workspace.ts";
import { SQLiteArtifactsWorkspaceStore } from "../../../src/cloudflare/artifacts-workspace-store.ts";
import type { AuthoritySqlHost } from "../../../src/cloudflare/authority-sqlite.ts";
import { RealmIdentityError } from "../../../src/identity/realm.ts";
import { scanCredentialMaterial } from "../../../src/security/credential-material.ts";
import { ArtifactsRealmAccessError, authorizeRealmArtifactsSelection, currentArtifactsRealmOwner, type ArtifactsRealmAccess } from "./artifacts-workspace-access.ts";
import { WORKSPACE_REPOSITORY_PROTOCOL, type WorkspaceRepositoryInput, type WorkspaceObservationInput } from "./workspace-repository-contract.ts";

import { ArtifactsObservationPublisher, ArtifactsObservationPublicationError } from "./artifacts-observation-publisher.ts";
import { REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL } from "../../../src/portability/repository-snapshot.ts";
type Options = ArtifactsRealmAccess & { artifacts: ArtifactsNamespace; sql: AuthoritySqlHost; repositoryState?: R2Bucket; repositoryStatePrefix?: string; now?: () => number };
export type WorkspaceRepositoryResult = { status: number; body: Record<string, unknown> };
/** Ordinary owner lifecycle; existing Task/Grant required. Provider effects
 * use durable custody, never an Authority transaction that could erase them. */
export class RealmArtifactsWorkspaceControl {
  constructor(private readonly options: Options) {}
  async materialize(sessionId: string, input: WorkspaceRepositoryInput) {
    try {
      const request = Object.freeze({ ...input });
      const { identity, authority } = await currentArtifactsRealmOwner(this.options, sessionId);
      if (scanCredentialMaterial(request) || identity.containsKnownCredentialMaterial(request)) return this.failure("invalid_request", 422);
      const workspace = authority.workspaces[request.workspaceId];
      const source = authority.sourceSpaces[request.sourceSpaceId];
      const revision = workspace && authority.projectRevisions[workspace.projectRevisionId];
      const baseCommitOid = revision?.sourceSpaceSnapshots[request.sourceSpaceId];
      const prefix = `repository:artifacts:${this.options.accountId}:${this.options.namespace}:`;
      if (!workspace || !source?.repositoryId?.startsWith(prefix) || !baseCommitOid) return this.failure("not_found", 404);
      const selection = immutableArtifactsWorkspaceSelection({ projectId: workspace.projectId, projectRevisionId: workspace.projectRevisionId, projectViewId: workspace.projectViewId, workspaceId: workspace.id, sourceSpaceId: source.id,
        sourceRepository: { accountId: this.options.accountId, namespace: this.options.namespace, repositoryId: source.repositoryId.slice(prefix.length), name: request.sourceRepositoryName }, targetName: request.targetName, baseCommitOid, baseTreeOid: request.baseTreeOid });
      const authorization = Object.freeze({ sessionId, bindings: Object.freeze([{ workspaceId: workspace.id, sourceSpaceId: source.id, taskId: request.taskId, grantId: request.grantId }]) });
      const authorize = (selected: typeof selection) => authorizeRealmArtifactsSelection(this.options, authorization, selected, JSON.stringify(selected));
      await authorize(selection);
      const adapter = new ArtifactsWorkspaceAdapter({ artifacts: this.options.artifacts, accountId: this.options.accountId, namespace: this.options.namespace, store: new SQLiteArtifactsWorkspaceStore(this.options.sql), authorize, ...(this.options.now ? { now: this.options.now } : {}) });
      const context = await adapter.materializeWorkspace(selection);
      return { status: 200, body: { protocol: WORKSPACE_REPOSITORY_PROTOCOL, status: "materialized", workspaceId: workspace.id, sourceSpaceId: source.id,
        repository: { id: context.binding.repositoryId, name: context.repository.name, remote: context.repository.remote }, baseCommitOid, baseTreeOid: selection.baseTreeOid,
        receipt: "workspaceRepository=materialized; base=provider-verified; initialToken=retired; credentialFree=true; canonicalWrite=false" } };
    } catch (error) {
      if (error instanceof RealmIdentityError || error instanceof ArtifactsRealmAccessError && error.code === "denied" || error instanceof ArtifactsWorkspaceError && error.code === "artifacts.authorization_denied") return this.failure("not_found", 404);
      if (error instanceof ArtifactsWorkspaceError && ["artifacts.workspace_already_bound", "artifacts.workspace_operation_pending", "artifacts.repository_identity_mismatch", "artifacts.fork_metadata_mismatch", "artifacts.base_mismatch"].includes(error.code)) return this.failure("conflict", 409);
      return this.failure("provider_unavailable", 503);
    }
  }
  async observe(sessionId: string, input: WorkspaceObservationInput): Promise<WorkspaceRepositoryResult> {
    try {
      const bucket = this.options.repositoryState;
      if (!bucket) return this.failure("provider_unavailable", 503, "observe");
      const request = Object.freeze({ ...input });
      const { identity, authority } = await currentArtifactsRealmOwner(this.options, sessionId);
      if (scanCredentialMaterial(request) || identity.containsKnownCredentialMaterial(request)) return this.failure("invalid_request", 422, "observe");
      const store = new SQLiteArtifactsWorkspaceStore(this.options.sql);
      const record = store.read({ workspaceId: request.workspaceId, sourceSpaceId: request.sourceSpaceId, sourceRepository: { accountId: this.options.accountId, namespace: this.options.namespace } });
      const selection = record?.context?.selection;
      const repositoryId = authority.sourceSpaces[request.sourceSpaceId]?.repositoryId;
      if (!record?.context || !selection || !repositoryId || record.pendingOperation !== "none" || record.blocked || record.unknownTokenInventory) return this.failure("not_found", 404, "observe");
      const authorization = { sessionId, bindings: [{ workspaceId: request.workspaceId, sourceSpaceId: request.sourceSpaceId, taskId: request.taskId, grantId: request.grantId }] };
      const authorize = (selected: typeof selection) => authorizeRealmArtifactsSelection(this.options, authorization, selected, JSON.stringify({ selection: selected, request }));
      const deadline = await authorize(selection);
      const adapter = new ArtifactsWorkspaceAdapter({ artifacts: this.options.artifacts, accountId: this.options.accountId, namespace: this.options.namespace, store, authorize, ...(this.options.now ? { now: this.options.now } : {}) });
      const read = async () => {
        const result = await adapter.observeWorkspaceSnapshot({ repository: { repositoryId: record.context!.binding.repositoryId, sourceSpaceId: selection.sourceSpaceId }, workspaceId: selection.workspaceId, projectViewId: selection.projectViewId,
          expectedSymbolicRef: request.expectedSymbolicRef, expectedCommitOid: request.expectedCommitOid, ...(request.expectedTreeOid ? { expectedTreeOid: request.expectedTreeOid } : {}), expectedBaseCommitOid: selection.baseCommitOid, expectedObjectFormat: "sha1" });
        if (result.status !== "succeeded") {
          if (result.errorCode === "artifacts.authorization_denied") throw new ArtifactsRealmAccessError("denied", "current observation grant denied");
          throw new ArtifactsObservationPublicationError(result.errorCode === "artifacts.observation_unqualified" ? "unavailable" : "conflict");
        }
        return result.value;
      };
      const fresh = await read();
      const value = fresh.observation;
      const manifest = { protocol: REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL, repositoryId, sourceSpaceId: selection.sourceSpaceId, context: { kind: "workspace" as const, workspaceId: selection.workspaceId, projectViewId: selection.projectViewId, workspaceRef: value.symbolicRef },
        objectFormat: value.objectFormat, symbolicRef: value.symbolicRef, commitOid: value.commitOid, treeOid: value.treeOid, baseCommitOid: value.baseCommitOid, ancestorCommitOids: fresh.ancestorCommitOids, generation: request.generation, state: "active" as const,
        observedAt: value.observedAt, expiresAt: deadline.expiresAt, receipt: `${value.receipt}; sourceRepository=${repositoryId}; workspaceRepository=${record.context.binding.repositoryId}; producer=authenticated-artifacts` };
      if (identity.containsKnownCredentialMaterial(manifest)) return this.failure("invalid_request", 422, "observe");
      const result = await new ArtifactsObservationPublisher({ sql: this.options.sql, bucket, prefix: this.options.repositoryStatePrefix?.trim() || "repositories/", ...(this.options.now ? { now: this.options.now } : {}) }).publish(manifest, async () => {
        const current = await authorize(selection);
        if (Date.parse(current.expiresAt) < Date.parse(manifest.expiresAt)) throw new ArtifactsObservationPublicationError("conflict");
        const checked = await read();
        if (checked.observation.treeOid !== value.treeOid || JSON.stringify(checked.ancestorCommitOids) !== JSON.stringify(fresh.ancestorCommitOids)) throw new ArtifactsObservationPublicationError("conflict");
      });
      return { status: 200, body: { protocol: WORKSPACE_REPOSITORY_PROTOCOL, status: "observation-published", workspaceId: selection.workspaceId, sourceSpaceId: selection.sourceSpaceId, repositoryId, generation: request.generation,
        commitOid: result.manifest.commitOid, treeOid: result.manifest.treeOid, baseCommitOid: result.manifest.baseCommitOid, manifestDigest: result.manifestDigest, expiresAt: result.manifest.expiresAt,
        receipt: "workspaceObservation=provider-read; snapshot=immutable; index=conditional-monotonic; credentialFree=true; canonicalWrite=false" } };
    } catch (error) {
      if (error instanceof RealmIdentityError || error instanceof ArtifactsRealmAccessError && error.code === "denied") return this.failure("not_found", 404, "observe");
      if (error instanceof ArtifactsObservationPublicationError && error.code === "conflict") return this.failure("conflict", 409, "observe");
      return this.failure("provider_unavailable", 503, "observe");
    }
  }
  private failure(code: "invalid_request" | "not_found" | "conflict" | "provider_unavailable", status: number, operation: "materialize" | "observe" = "materialize") {
    return { status, body: { protocol: WORKSPACE_REPOSITORY_PROTOCOL, status: "blocked", code,
      recoveryAction: code === "not_found" ? "use an active owned Workspace, disclosed Artifacts Source and current Task/Grant permitting source.read and workspace.write" : code === "invalid_request" ? "send only credential-free documented fields" : operation === "observe" ? "inspect the exact generation, latest index and current Git candidate; reconcile incomplete snapshot publication and current Task/Grant before retrying" : "inspect the existing binding and named provider repository/token retirement; reconcile pending effects before repeating materialization",
      receipt: operation === "observe" ? "workspaceObservation=not-qualified; providerEffect=inspect-snapshot-custody; details=not-disclosed; canonicalWrite=false" : "workspaceRepository=not-released; providerEffect=inspect-custody; details=not-disclosed; canonicalWrite=false" } };
  }
}
