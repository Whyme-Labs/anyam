import { ArtifactsWorkspaceAdapter, ArtifactsWorkspaceError, immutableArtifactsWorkspaceSelection, type ArtifactsNamespace } from "../../../src/cloudflare/artifacts-workspace.ts";
import { SQLiteArtifactsWorkspaceStore } from "../../../src/cloudflare/artifacts-workspace-store.ts";
import type { AuthoritySqlHost } from "../../../src/cloudflare/authority-sqlite.ts";
import { RealmIdentityError } from "../../../src/identity/realm.ts";
import { scanCredentialMaterial } from "../../../src/security/credential-material.ts";
import { ArtifactsRealmAccessError, authorizeRealmArtifactsSelection, currentArtifactsRealmOwner, type ArtifactsRealmAccess } from "./artifacts-workspace-access.ts";
import { WORKSPACE_REPOSITORY_PROTOCOL, type WorkspaceRepositoryInput } from "./workspace-repository-contract.ts";

type Options = ArtifactsRealmAccess & { artifacts: ArtifactsNamespace; sql: AuthoritySqlHost; now?: () => number };
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
  private failure(code: "invalid_request" | "not_found" | "conflict" | "provider_unavailable", status: number) {
    return { status, body: { protocol: WORKSPACE_REPOSITORY_PROTOCOL, status: "blocked", code,
      recoveryAction: code === "not_found" ? "use an active owned Workspace, disclosed Artifacts Source and current Task/Grant permitting source.read and workspace.write" : code === "invalid_request" ? "send only credential-free documented fields" : "inspect the existing binding and named provider repository/token retirement; reconcile pending effects before repeating materialization",
      receipt: "workspaceRepository=not-released; providerEffect=inspect-custody; details=not-disclosed; canonicalWrite=false" } };
  }
}
