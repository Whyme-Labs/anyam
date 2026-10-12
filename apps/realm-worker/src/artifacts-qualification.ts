import { ArtifactsWorkspaceQualification, SQLiteArtifactsQualificationLedger, assertArtifactsQualificationInput, type ArtifactsQualificationInput, type ArtifactsQualificationOptions } from "../../../src/cloudflare/artifacts-workspace-qualification.ts";
import { immutableArtifactsWorkspaceSelection, type ArtifactsWorkspaceSelection } from "../../../src/cloudflare/artifacts-workspace.ts";
import { SQLiteArtifactsWorkspaceStore } from "../../../src/cloudflare/artifacts-workspace-store.ts";
import type { AuthoritySqlHost } from "../../../src/cloudflare/authority-sqlite.ts";
import type { AuthorityPlaneSnapshot } from "../../../src/cloudflare/authority-plane.ts";
import type { RealmIdentityPolicy } from "../../../src/identity/realm.ts";

import { currentArtifactsRealmOwner, authorizeRealmArtifactsSelection, type ArtifactsRealmAuthorization } from "./artifacts-workspace-access.ts";
export type { ArtifactsRealmBinding, ArtifactsRealmAuthorization } from "./artifacts-workspace-access.ts";
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

  private async authorizeOwner(authorization: ArtifactsRealmAuthorization) {
    return currentArtifactsRealmOwner(this.options, authorization.sessionId);
  }

  private async authorizeSelection(authorization: ArtifactsRealmAuthorization, selection: ArtifactsWorkspaceSelection, receiptMetadata?: string) {
    return authorizeRealmArtifactsSelection(this.options, authorization, selection, receiptMetadata);
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
