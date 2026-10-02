import { ArtifactsWorkspaceQualification, SQLiteArtifactsQualificationLedger, assertArtifactsQualificationInput, type ArtifactsQualificationInput, type ArtifactsQualificationOptions } from "../../../src/cloudflare/artifacts-workspace-qualification.ts";
import { assertArtifactsWorkspaceSelection, immutableArtifactsWorkspaceSelection, type ArtifactsWorkspaceSelection } from "../../../src/cloudflare/artifacts-workspace.ts";
import { SQLiteArtifactsWorkspaceStore } from "../../../src/cloudflare/artifacts-workspace-store.ts";
import type { AuthoritySqlHost } from "../../../src/cloudflare/authority-sqlite.ts";
import type { AuthorityPlaneSnapshot } from "../../../src/cloudflare/authority-plane.ts";
import type { RealmIdentityPolicy } from "../../../src/identity/realm.ts";

export type ArtifactsRealmBinding = { workspaceId: string; sourceSpaceId: string; taskId: string; grantId: string };
export type ArtifactsRealmAuthorization = { sessionId: string; bindings: readonly ArtifactsRealmBinding[] };
export type RealmArtifactsQualificationRequest = ArtifactsRealmAuthorization & { input: ArtifactsQualificationInput };
type Options = {
  artifacts: ArtifactsQualificationOptions["artifacts"];
  accountId: string;
  namespace: string;
  sql: AuthoritySqlHost;
  now?: () => number;
  current(): Promise<{ identity: RealmIdentityPolicy; authority: AuthorityPlaneSnapshot; active: boolean }>;
};

/** Trusted coordinator composition. No HTTP route or name-only deletion port.
 * Host/service behavior is qualified separately from this SQLite contract. */
export class RealmArtifactsQualification {
  constructor(private readonly options: Options) {}

  async run(request: RealmArtifactsQualificationRequest) {
    try {
      const authorization = this.authorization(request);
      const input = Object.freeze({ runId: request.input.runId, execution: request.input.execution, credentialExpiresAt: request.input.credentialExpiresAt, selections: Object.freeze(request.input.selections.map(immutableArtifactsWorkspaceSelection)) });
      await this.authorizeInput(authorization, input, true);
      const result = await this.invoker(authorization).run(input);
      return { ...result, deletion: "unsupported-name-only-binding" as const };
    } catch { return this.denied(); }
  }

  async cleanup(request: ArtifactsRealmAuthorization & { runId: string }) {
    try {
      const runId = request.runId;
      if (typeof runId !== "string" || !runId.trim()) return this.denied();
      const authorization = this.authorization(request);
      await this.authorizeOwner(authorization);
      const tables = new Set(this.options.sql.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(row => row.name));
      if (!tables.has("anyam_artifacts_qualification_runs")) return this.denied();
      const ledger = new SQLiteArtifactsQualificationLedger(this.options.sql);
      const run = ledger.read(runId);
      if (!run || run.input.runId !== runId || !run.inputDigest || run.accountId !== this.options.accountId || run.namespace !== this.options.namespace) return this.denied();
      await this.authorizeInput(authorization, run.input, false);
      const cleanup = await this.invoker(authorization).cleanup(runId);
      return { protocol: "anyam.realm-artifacts-qualification/v1", runId, inputDigest: run.inputDigest, cleanup, deletion: "unsupported-name-only-binding", liveQualified: false } as const;
    } catch { return this.denied(); }
  }

  private authorization(request: ArtifactsRealmAuthorization): ArtifactsRealmAuthorization {
    if (typeof request.sessionId !== "string" || !request.sessionId || !Array.isArray(request.bindings)) throw new Error("invalid authorization");
    const bindings = request.bindings.map(binding => {
      if ([binding.workspaceId, binding.sourceSpaceId, binding.taskId, binding.grantId].some(value => typeof value !== "string" || !value)) throw new Error("invalid binding");
      return Object.freeze({ workspaceId: binding.workspaceId, sourceSpaceId: binding.sourceSpaceId, taskId: binding.taskId, grantId: binding.grantId });
    });
    if (new Set(bindings.map(binding => JSON.stringify([binding.workspaceId, binding.sourceSpaceId]))).size !== bindings.length) throw new Error("duplicate binding");
    return Object.freeze({ sessionId: request.sessionId, bindings: Object.freeze(bindings) });
  }

  private async owner() {
    const state = await this.options.current();
    if (!state.active) throw new Error("recovery blocked");
    return state;
  }

  private async authorizeOwner(authorization: ArtifactsRealmAuthorization) {
    const state = await this.owner();
    const session = state.identity.validateSession(authorization.sessionId);
    const identity = state.identity.getRecoverySnapshot();
    if (state.authority.realmId !== identity.realm.id || identity.actors[session.actorId]?.kind !== "human" || !Object.values(identity.relationships).some(relationship => relationship.principalId === session.principalId && relationship.status === "active" && relationship.role === "owner" && relationship.resource.realmId === identity.realm.id && Object.keys(relationship.resource).every(key => key === "realmId"))) throw new Error("owner denied");
    return { ...state, session };
  }

  private async authorizeSelection(authorization: ArtifactsRealmAuthorization, selection: ArtifactsWorkspaceSelection, receiptMetadata?: string) {
    assertArtifactsWorkspaceSelection(selection, this.options.accountId, this.options.namespace);
    const { identity, authority, session } = await this.authorizeOwner(authorization);
    const project = authority.projects[selection.projectId];
    const workspace = authority.workspaces[selection.workspaceId];
    const revision = authority.projectRevisions[selection.projectRevisionId];
    const view = authority.projectViews[selection.projectViewId];
    const source = authority.sourceSpaces[selection.sourceSpaceId];
    const binding = authorization.bindings.find(entry => entry.workspaceId === selection.workspaceId && entry.sourceSpaceId === selection.sourceSpaceId);
    const identitySnapshot = identity.getRecoverySnapshot();
    const policy = identitySnapshot.sourceSpacePolicies[selection.sourceSpaceId];
    const creator = identitySnapshot.actors[workspace?.actorId ?? ""];
    if (receiptMetadata !== undefined && Object.keys(identitySnapshot.sessions).some(handle => receiptMetadata.includes(handle))) throw new Error("session metadata denied");
    if (!binding || !project || !workspace || !revision || !view || !source || !policy || !creator || creator.kind !== "human" || creator.realmId !== identity.realm.id || creator.principalId !== session.principalId || source.classification !== policy.classification ||
      workspace.state !== "active" || workspace.projectId !== project.id || workspace.projectRevisionId !== revision.id || workspace.projectViewId !== view.id ||
      revision.projectId !== project.id || view.projectId !== project.id || view.projectRevisionId !== revision.id || !project.sourceSpaceIds.includes(source.id) || !view.visibleSourceSpaceIds.includes(source.id) ||
      revision.sourceSpaceSnapshots[source.id] !== selection.baseCommitOid || view.disclosedSourceSpaceSnapshots[source.id] !== selection.baseCommitOid || !workspace.mounts.some(mount => mount.sourceSpaceId === source.id && mount.snapshotId === selection.baseCommitOid) ||
      source.repositoryId !== `repository:artifacts:${selection.sourceRepository.accountId}:${selection.sourceRepository.namespace}:${selection.sourceRepository.repositoryId}`) throw new Error("scope denied");
    const resource = { realmId: identity.realm.id, projectId: project.id, workspaceId: workspace.id, sourceSpaceId: source.id };
    for (const capability of ["source.read", "workspace.write"] as const) {
      const chain = { principalId: session.principalId, actorId: session.actorId, clientId: session.clientId, sessionId: session.id, taskId: binding.taskId, grantId: binding.grantId, resource };
      const validation = identity.validateTaskGrant({ ...chain, action: capability, sourceSpaceIds: [source.id], effects: [capability] });
      if (!validation.valid) throw new Error("task grant denied");
      identity.authorize({ ...chain, operation: capability, capability, sourceSpaceId: source.id });
    }
    const grant = identity.getGrant(binding.grantId);
    if (!grant) throw new Error("grant missing");
    return { expiresAt: new Date(Math.min(Date.parse(session.expiresAt), Date.parse(grant.expiresAt))).toISOString() };
  }

  private async authorizeInput(authorization: ArtifactsRealmAuthorization, input: ArtifactsQualificationInput, checkExpiry: boolean) {
    assertArtifactsQualificationInput(input, this.options.accountId, this.options.namespace);
    if (authorization.bindings.length !== input.selections.length) throw new Error("scope denied");
    const receiptMetadata = JSON.stringify(input);
    for (const selection of input.selections) {
      const grant = await this.authorizeSelection(authorization, selection, receiptMetadata);
      const expiry = Date.parse(input.credentialExpiresAt);
      if (checkExpiry && (!Number.isFinite(expiry) || expiry <= (this.options.now ?? Date.now)() || expiry > Date.parse(grant.expiresAt))) throw new Error("expiry denied");
    }
  }

  private invoker(authorization: ArtifactsRealmAuthorization) {
    return new ArtifactsWorkspaceQualification({ artifacts: this.options.artifacts, accountId: this.options.accountId, namespace: this.options.namespace, store: new SQLiteArtifactsWorkspaceStore(this.options.sql), ledger: new SQLiteArtifactsQualificationLedger(this.options.sql), authorizeRun: input => this.authorizeInput(authorization, input, false), authorize: selection => this.authorizeSelection(authorization, selection), ...(this.options.now ? { now: this.options.now } : {}) });
  }

  private denied() { return { protocol: "anyam.realm-artifacts-qualification/v1", status: "blocked", code: "artifacts.realm_authorization_denied", cleanup: "required", liveQualified: false } as const; }
}
