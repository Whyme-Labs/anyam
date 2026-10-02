import {
  ArtifactsWorkspaceAdapter, assertArtifactsWorkspaceSelection, immutableArtifactsWorkspaceSelection,
  type ArtifactsNamespace, type ArtifactsRepository, type ArtifactsWorkspaceOptions, type ArtifactsWorkspaceSelection,
} from "./artifacts-workspace.ts";
import type { AuthoritySqlHost } from "./authority-sqlite.ts";
import type { ArtifactsWorkspaceStore } from "./artifacts-workspace-store.ts";
import type { RepositoryObservation } from "../kernel/contracts.ts";

type QualificationRepository = ArtifactsRepository & {
  listTokens(): Promise<{ tokens: readonly { id: string; state: "active" | "expired" | "revoked" }[]; total: number }>;
};
type QualificationNamespace = { get(name: string): Promise<QualificationRepository> };
export type ArtifactsQualificationInput = {
  runId: string;
  execution: "local-fixture" | "live-approved";
  selections: readonly ArtifactsWorkspaceSelection[];
  credentialExpiresAt: string;
};
type QualificationResource = {
  selection: ArtifactsWorkspaceSelection;
  repositoryId?: string;
  state: "reserved" | "fork-pending" | "owned" | "delete-pending" | "deleted";
  initialToken: "none" | "pending" | "retired";
  tokenIds: string[];
  retiredTokenIds: string[];
  mintPending: boolean;
  credentialGuardPending: boolean;
  observation?: RepositoryObservation;
  recovery?: string;
};
export type ArtifactsQualificationRun = {
  input: ArtifactsQualificationInput;
  accountId: string;
  namespace: string;
  qualification: "running" | "passed" | "blocked";
  cleanup: "pending" | "confirmed" | "required";
  operations: string[];
  resources: QualificationResource[];
  credentialFingerprints: { digest: string; length: number }[];
  failure?: string;
};

/** Codes originate here; provider exception text never enters a receipt. */
class QualificationFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
export type ArtifactsQualificationLedger = {
  reserve(run: ArtifactsQualificationRun): boolean;
  read(runId: string): ArtifactsQualificationRun | undefined;
  change(runId: string, update: (run: ArtifactsQualificationRun) => void): void;
};

/** Credential-free run custody; synchronous writes precede provider effects. */
export class SQLiteArtifactsQualificationLedger implements ArtifactsQualificationLedger {
  constructor(private readonly host: AuthoritySqlHost) {
    host.transactionSync(() => host.sql.exec("CREATE TABLE IF NOT EXISTS anyam_artifacts_qualification_runs (run_id TEXT PRIMARY KEY, payload TEXT NOT NULL)"));
  }
  reserve(run: ArtifactsQualificationRun): boolean {
    return this.host.transactionSync(() => this.host.sql.exec("INSERT INTO anyam_artifacts_qualification_runs (run_id, payload) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING run_id", run.input.runId, JSON.stringify(run)).toArray().length === 1);
  }
  read(runId: string): ArtifactsQualificationRun | undefined {
    const row = this.host.sql.exec<{ payload: string }>("SELECT payload FROM anyam_artifacts_qualification_runs WHERE run_id = ?", runId).toArray()[0];
    return row ? JSON.parse(row.payload) as ArtifactsQualificationRun : undefined;
  }
  change(runId: string, update: (run: ArtifactsQualificationRun) => void): void {
    this.host.transactionSync(() => {
      const run = this.read(runId);
      if (!run) throw new Error("qualification run is missing");
      update(run);
      this.host.sql.exec("UPDATE anyam_artifacts_qualification_runs SET payload = ? WHERE run_id = ?", JSON.stringify(run), runId);
    });
  }
}

export type ArtifactsQualificationOptions = {
  artifacts: QualificationNamespace;
  accountId: string;
  namespace: string;
  authorizeRun(input: Readonly<ArtifactsQualificationInput>): Promise<void>;
  authorize: ArtifactsWorkspaceOptions["authorize"];
  now?: () => number;
  store: ArtifactsWorkspaceStore;
  ledger: ArtifactsQualificationLedger;
  /** Separately qualified expected-UUID cleanup. Binding delete(name) alone is insufficient. */
  deleteOwned?: ((input: { accountId: string; namespace: string; name: string; expectedRepositoryId: string; runId: string }) => Promise<boolean>) | undefined;
};

/** Trusted one-shot binding-contract invocation, never an HTTP mutation route.
 * Git scope, expiry timing, native harnesses and live service qualification are
 * separate receipts; this invoker never upgrades its result to liveQualified. */
export class ArtifactsWorkspaceQualification {
  private readonly options: ArtifactsQualificationOptions;
  constructor(options: ArtifactsQualificationOptions) { this.options = { ...options }; }

  async run(input: ArtifactsQualificationInput) {
    const request = Object.freeze({ runId: input.runId, execution: input.execution, credentialExpiresAt: input.credentialExpiresAt, selections: Object.freeze(input.selections.map(immutableArtifactsWorkspaceSelection)) });
    const knownPlaintext = new Set<string>();
    const pendingPlaintext = new Map<string, string>();
    let reserved = false;
    let passed = false;
    let failure = "qualification.scope_invalid";
    try {
      const names = new Set(request.selections.map(selection => selection.targetName));
      const assignments = new Set(request.selections.map(selection => JSON.stringify([selection.workspaceId, selection.sourceSpaceId])));
      if (!request.runId.trim() || !["local-fixture", "live-approved"].includes(request.execution) || !request.selections.length ||
          names.size !== request.selections.length || assignments.size !== request.selections.length) throw new Error("qualification scope is invalid");
      for (const selection of request.selections) assertArtifactsWorkspaceSelection(selection, this.options.accountId, this.options.namespace);
      failure = "qualification.authorization_denied";
      await this.options.authorizeRun(request);
      failure = "qualification.ledger_unavailable";
      reserved = this.custody(() => this.options.ledger.reserve({ input: request, accountId: this.options.accountId, namespace: this.options.namespace, qualification: "running", cleanup: "pending", operations: [], credentialFingerprints: [], resources: request.selections.map(selection => ({ selection, state: "reserved", initialToken: "none", tokenIds: [], retiredTokenIds: [], mintPending: false, credentialGuardPending: false })) }));
      if (!reserved) return this.receipt(request, false, "required", "qualification.run_already_recorded", false);
      failure = "qualification.target_unavailable";
      for (const selection of request.selections) {
        this.operation(request.runId, "preflight:get");
        try {
          using existing = await this.options.artifacts.get(selection.targetName);
          throw new Error("qualification target already exists");
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "NOT_FOUND")) throw error;
        }
      }
      failure = "qualification.binding_failed";
      for (const selection of request.selections) {
        const namespace = this.trackedNamespace(request.runId, selection, knownPlaintext, pendingPlaintext, () => { failure = "qualification.ledger_unavailable"; });
        const control = new ArtifactsWorkspaceAdapter({ artifacts: namespace, accountId: this.options.accountId, namespace: this.options.namespace, authorize: this.options.authorize, store: this.options.store, ...(this.options.now ? { now: this.options.now } : {}) });
        const context = await control.forkWorkspace(selection);
        using target = await namespace.get(selection.targetName);
        const targetInfo = await target.info();
        const observation = await control.observeRepository({ repository: { repositoryId: context.binding.repositoryId, sourceSpaceId: selection.sourceSpaceId }, workspaceId: selection.workspaceId, projectViewId: selection.projectViewId, expectedSymbolicRef: `refs/heads/${targetInfo.defaultBranch}`, expectedCommitOid: selection.baseCommitOid, expectedTreeOid: selection.baseTreeOid, expectedBaseCommitOid: selection.baseCommitOid, expectedObjectFormat: "sha1" });
        if (observation.status !== "succeeded") throw new Error("qualification observation blocked");
        this.resource(request.runId, selection.targetName, resource => { resource.observation = observation.value; });
        for (const operation of ["read", "write"] as const) await control.issue({ repositoryId: context.binding.repositoryId, sourceSpaceId: selection.sourceSpaceId, workspaceId: selection.workspaceId, operation, expiresAt: request.credentialExpiresAt });
        await control.revokeWorkspace({ workspaceId: selection.workspaceId, sourceSpaceId: selection.sourceSpaceId });
      }
      this.custody(() => this.options.ledger.change(request.runId, run => { run.qualification = "passed"; }));
      passed = true;
    } catch (error) {
      if (error instanceof QualificationFailure) failure = error.code;
      if (reserved) { try { this.custody(() => this.options.ledger.change(request.runId, run => { run.qualification = "blocked"; run.failure = failure; })); } catch { /* The durable pending record remains the reconciliation boundary. */ } }
    }
    const cleanup = reserved ? await this.cleanupOwned(request.runId, knownPlaintext, pendingPlaintext) : "required";
    return this.receipt(request, passed, cleanup, passed ? cleanup === "confirmed" ? "qualification.completed" : "qualification.cleanup_required" : failure, reserved);
  }

  async cleanup(runId: string): Promise<"confirmed" | "required"> {
    return this.cleanupOwned(runId, new Set(), new Map());
  }

  private async cleanupOwned(runId: string, knownPlaintext: ReadonlySet<string>, pendingPlaintext: Map<string, string>): Promise<"confirmed" | "required"> {
    try {
      const run = this.custody(() => this.options.ledger.read(runId));
      if (!run || run.accountId !== this.options.accountId || run.namespace !== this.options.namespace) return "required";
      await this.options.authorizeRun(Object.freeze({ ...run.input, selections: Object.freeze(run.input.selections.map(immutableArtifactsWorkspaceSelection)) }));
      let confirmed = true;
      for (const resource of run.resources) {
        if (resource.state === "reserved" || resource.state === "deleted") continue;
        try {
          if (resource.state === "delete-pending") throw new QualificationFailure("qualification.deletion_outcome_unknown");
          if (!resource.repositoryId) throw new QualificationFailure("qualification.repository_identity_unknown");
          if (resource.credentialGuardPending) {
            const plaintext = pendingPlaintext.get(resource.selection.targetName);
            if (plaintext === undefined) throw new QualificationFailure("qualification.credential_redaction_pending");
            await this.rememberCredential(runId, resource.selection.targetName, plaintext);
            pendingPlaintext.delete(resource.selection.targetName);
          }
          this.operation(runId, "cleanup:get");
          using repo = await this.options.artifacts.get(resource.selection.targetName);
          this.operation(runId, "cleanup:info");
          const info = await repo.info();
          if (info.id !== resource.repositoryId) throw new QualificationFailure("qualification.repository_identity_changed");
          for (const id of resource.tokenIds) {
            this.operation(runId, "cleanup:revokeToken");
            if (await repo.revokeToken(id)) this.retiredToken(runId, resource.selection.targetName, id);
          }
          const inventory = await this.tokenInventory(runId, repo, resource.repositoryId, knownPlaintext);
          for (const token of inventory) {
            if (token.state !== "active") continue;
            this.resource(runId, resource.selection.targetName, entry => { if (!entry.tokenIds.includes(token.id)) entry.tokenIds.push(token.id); });
            this.operation(runId, "cleanup:revokeToken");
            if (!await repo.revokeToken(token.id)) throw new QualificationFailure("qualification.token_retirement_unconfirmed");
            this.retiredToken(runId, resource.selection.targetName, token.id);
          }
          if ((await this.tokenInventory(runId, repo, resource.repositoryId, knownPlaintext)).some(token => token.state === "active")) throw new QualificationFailure("qualification.active_tokens_remain");
          // A false/not-found revoke is insufficient alone. Only the fresh,
          // complete inactive inventory reconciles these originally known IDs.
          for (const id of resource.tokenIds) this.retiredToken(runId, resource.selection.targetName, id);
          this.resource(runId, resource.selection.targetName, entry => {
            if (entry.tokenIds.length || entry.mintPending !== resource.mintPending) throw new QualificationFailure("qualification.token_inventory_changed");
            entry.initialToken = "retired"; entry.mintPending = false;
          });
          if (!this.options.deleteOwned) throw new QualificationFailure("qualification.guarded_delete_unqualified");
          this.resource(runId, resource.selection.targetName, entry => {
            if (entry.state !== "owned") throw new QualificationFailure("qualification.deletion_outcome_unknown");
            entry.state = "delete-pending";
          });
          this.operation(runId, "cleanup:deleteOwned");
          if (!await this.options.deleteOwned({ accountId: run.accountId, namespace: run.namespace, name: resource.selection.targetName, expectedRepositoryId: resource.repositoryId, runId })) throw new QualificationFailure("qualification.deletion_outcome_unknown");
          this.resource(runId, resource.selection.targetName, entry => { entry.state = "deleted"; delete entry.recovery; });
        } catch (error) {
          confirmed = false;
          this.resource(runId, resource.selection.targetName, entry => { entry.recovery = error instanceof QualificationFailure ? error.code : "qualification.cleanup_unconfirmed"; });
        }
      }
      const cleanup = confirmed ? "confirmed" : "required";
      this.custody(() => this.options.ledger.change(runId, entry => { entry.cleanup = cleanup; }));
      return cleanup;
    } catch {
      try { this.custody(() => this.options.ledger.change(runId, entry => { entry.cleanup = "required"; })); } catch { /* Retain the previous durable pending state. */ }
      return "required";
    }
  }

  private async tokenInventory(runId: string, repo: QualificationRepository, repositoryId: string, knownPlaintext: ReadonlySet<string>) {
    this.operation(runId, "cleanup:info");
    if ((await repo.info()).id !== repositoryId) throw new QualificationFailure("qualification.repository_identity_changed");
    this.operation(runId, "cleanup:listTokens");
    const inventory = await repo.listTokens();
    if (!Number.isSafeInteger(inventory.total) || inventory.total < 0 || !Array.isArray(inventory.tokens) || inventory.tokens.length !== inventory.total ||
        inventory.tokens.some(token => !this.metadataId(token.id, undefined, knownPlaintext) || !["active", "expired", "revoked"].includes(token.state)) || new Set(inventory.tokens.map(token => token.id)).size !== inventory.total) throw new QualificationFailure("qualification.token_inventory_unqualified");
    const tokens = inventory.tokens.map(token => ({ id: token.id, state: token.state }));
    await this.assertMetadata(runId, tokens.map(token => token.id), knownPlaintext);
    this.operation(runId, "cleanup:info");
    if ((await repo.info()).id !== repositoryId) throw new QualificationFailure("qualification.repository_identity_changed");
    return tokens;
  }

  private receipt(request: Readonly<ArtifactsQualificationInput>, passed: boolean, cleanup: "confirmed" | "required", code: string, reserved: boolean) {
    let run: ArtifactsQualificationRun | undefined;
    if (reserved) {
      try { run = this.custody(() => this.options.ledger.read(request.runId)); }
      catch { code = "qualification.ledger_unavailable"; }
    }
    return {
      protocol: "anyam.artifacts-workspace-qualification/v1", runId: request.runId, execution: request.execution,
      accountId: this.options.accountId, namespace: this.options.namespace, code,
      status: passed && cleanup === "confirmed" && run ? "succeeded" : "blocked", bindingContract: passed ? "passed" : "blocked", cleanup,
      operationIntents: [...(run?.operations ?? [])], ledgerAvailable: Boolean(run),
      resources: (run?.resources ?? []).map(resource => ({
        targetName: resource.selection.targetName, workspaceId: resource.selection.workspaceId, sourceSpaceId: resource.selection.sourceSpaceId,
        state: resource.state, repositoryId: resource.repositoryId, initialToken: resource.initialToken, tokenIds: [...resource.tokenIds], retiredTokenIds: [...resource.retiredTokenIds], mintPending: resource.mintPending, credentialGuardPending: resource.credentialGuardPending,
        observation: resource.observation && { ...resource.observation },
        recovery: resource.state === "reserved" || resource.state === "deleted" ? "none" : resource.recovery ?? "qualification.cleanup_required",
      })),
      liveQualified: false, gitScope: "not-run", expiryTiming: "not-run", nativeHarnesses: "not-run", credentialMaterialStored: false,
    } as const;
  }

  private resource(runId: string, name: string, update: (resource: QualificationResource) => void): void {
    this.custody(() => this.options.ledger.change(runId, run => {
      const resource = run.resources.find(entry => entry.selection.targetName === name);
      if (!resource) throw new Error("resource is outside the qualification scope");
      update(resource);
    }));
  }

  private retiredToken(runId: string, name: string, id: string): void {
    this.resource(runId, name, resource => {
      resource.tokenIds = resource.tokenIds.filter(candidate => candidate !== id);
      if (!resource.retiredTokenIds.includes(id)) resource.retiredTokenIds.push(id);
    });
  }

  private custody<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) {
      if (error instanceof QualificationFailure) throw error;
      throw new QualificationFailure("qualification.ledger_unavailable");
    }
  }

  private operation(runId: string, name: string): void {
    this.custody(() => this.options.ledger.change(runId, run => { run.operations.push(name); }));
  }

  private trackedNamespace(runId: string, selection: ArtifactsWorkspaceSelection, knownPlaintext: Set<string>, pendingPlaintext: Map<string, string>, onLedgerFailure: () => void): ArtifactsNamespace {
    let initialToken: string | undefined;
    const capture = <T>(readOrWrite: () => T): T => {
      try { return readOrWrite(); }
      catch (error) { if (error instanceof QualificationFailure && error.code === "qualification.ledger_unavailable") onLedgerFailure(); throw error; }
    };
    const operation = (name: string) => capture(() => this.operation(runId, name));
    const change = (name: string, update: (resource: QualificationResource) => void) => capture(() => this.resource(runId, name, update));
    const remember = async (name: string, plaintext: string) => {
      try { await this.rememberCredential(runId, name, plaintext); pendingPlaintext.delete(name); }
      catch (error) { if (error instanceof QualificationFailure && error.code === "qualification.ledger_unavailable") onLedgerFailure(); throw error; }
    };
    return { get: async name => {
      operation("get");
      const repo = await this.options.artifacts.get(name);
      return {
        [Symbol.dispose]() { repo[Symbol.dispose](); },
        info: async () => {
          operation("info");
          const reply = await repo.info();
          const info = { id: reply.id, name: reply.name, remote: reply.remote, defaultBranch: reply.defaultBranch, readOnly: reply.readOnly };
          await this.assertMetadata(runId, [info.id, info.name, info.remote, info.defaultBranch], knownPlaintext);
          return info;
        },
        log: async input => {
          operation("log");
          const commits = (await repo.log(input)).map(commit => ({ hash: commit.hash, treeHash: commit.treeHash, ...(Array.isArray(commit.parents) ? { parents: [...commit.parents] } : {}) }));
          await this.assertMetadata(runId, commits.flatMap(commit => [commit.hash, commit.treeHash, ...commit.parents ?? []]), knownPlaintext);
          return commits;
        },
        readCommit: async oid => {
          operation("readCommit");
          const reply = await repo.readCommit(oid);
          if (!reply) return null;
          const commit = { hash: reply.hash, treeHash: reply.treeHash, ...(Array.isArray(reply.parents) ? { parents: [...reply.parents] } : {}) };
          await this.assertMetadata(runId, [commit.hash, commit.treeHash, ...commit.parents ?? []], knownPlaintext);
          return commit;
        },
        fork: async (target, options) => {
          change(target, resource => { resource.state = "fork-pending"; resource.credentialGuardPending = true; });
          operation("fork");
          const raw = await repo.fork(target, options);
          const reply = { id: raw.id, name: raw.name, remote: raw.remote, defaultBranch: raw.defaultBranch, token: raw.token };
          if (typeof reply.token === "string") knownPlaintext.add(reply.token);
          pendingPlaintext.set(target, reply.token);
          this.assertCurrentMetadata([reply.id, reply.name, reply.remote, reply.defaultBranch], knownPlaintext);
          const resources = capture(() => this.custody(() => this.options.ledger.read(runId)?.resources));
          if (!resources || !this.metadataId(reply.id, reply.token, knownPlaintext) || resources.some(resource => resource.selection.sourceRepository.repositoryId === reply.id || resource.repositoryId === reply.id) || reply.name !== target ||
              reply.remote !== `https://${this.options.accountId}.artifacts.cloudflare.net/git/${this.options.namespace}/${target}.git`) throw new Error("fork identity reply is unqualified");
          change(target, resource => { resource.repositoryId = reply.id; resource.state = "owned"; resource.initialToken = "pending"; });
          await remember(target, reply.token);
          initialToken = reply.token;
          return { id: reply.id, name: reply.name, remote: reply.remote, defaultBranch: reply.defaultBranch, token: reply.token };
        },
        createToken: async (scope, ttl) => {
          change(selection.targetName, resource => { resource.mintPending = true; resource.credentialGuardPending = true; });
          operation("createToken");
          let raw: Awaited<ReturnType<ArtifactsRepository["createToken"]>>;
          try { raw = await repo.createToken(scope, ttl); }
          catch (error) { change(selection.targetName, resource => { resource.credentialGuardPending = false; }); throw error; }
          const reply = { id: raw.id, plaintext: raw.plaintext, scope: raw.scope, expiresAt: raw.expiresAt };
          if (typeof reply.plaintext === "string") knownPlaintext.add(reply.plaintext);
          pendingPlaintext.set(selection.targetName, reply.plaintext);
          this.assertCurrentMetadata([reply.id, reply.scope, reply.expiresAt], knownPlaintext);
          if (!this.metadataId(reply.id, reply.plaintext, knownPlaintext)) throw new Error("token identity reply is unqualified");
          change(selection.targetName, resource => { resource.tokenIds.push(reply.id); resource.mintPending = false; });
          await remember(selection.targetName, reply.plaintext);
          return { id: reply.id, plaintext: reply.plaintext, scope: reply.scope, expiresAt: reply.expiresAt };
        },
        revokeToken: async tokenOrId => {
          operation("revokeToken");
          const retired = await repo.revokeToken(tokenOrId);
          if (retired) {
            if (tokenOrId === initialToken) {
              change(selection.targetName, resource => { resource.initialToken = "retired"; });
              initialToken = undefined;
            } else capture(() => this.retiredToken(runId, selection.targetName, tokenOrId));
          }
          return retired;
        },
      };
    } };
  }

  private metadataId(value: unknown, plaintext: unknown, knownPlaintext: ReadonlySet<string>): value is string {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value) && value !== plaintext && ![...knownPlaintext].some(secret => secret && value.includes(secret));
  }

  private assertCurrentMetadata(values: readonly unknown[], knownPlaintext: ReadonlySet<string>): void {
    if (values.some(value => typeof value === "string" && [...knownPlaintext].some(secret => secret && value.includes(secret)))) throw new QualificationFailure("qualification.metadata_contains_credential");
  }

  private async fingerprint(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private async rememberCredential(runId: string, name: string, plaintext: string): Promise<void> {
    const digest = await this.fingerprint(plaintext);
    this.custody(() => this.options.ledger.change(runId, run => {
      const resource = run.resources.find(entry => entry.selection.targetName === name);
      if (!resource) throw new QualificationFailure("qualification.scope_invalid");
      if (plaintext.length && !run.credentialFingerprints.some(entry => entry.digest === digest)) run.credentialFingerprints.push({ digest, length: plaintext.length });
      resource.credentialGuardPending = false;
    }));
  }

  private async assertMetadata(runId: string, values: readonly unknown[], knownPlaintext: ReadonlySet<string>): Promise<void> {
    this.assertCurrentMetadata(values, knownPlaintext);
    const fingerprints = this.custody(() => this.options.ledger.read(runId)?.credentialFingerprints);
    if (!fingerprints) throw new QualificationFailure("qualification.credential_redaction_pending");
    for (const value of new Set(values)) {
      if (typeof value !== "string") continue;
      for (const credential of fingerprints) {
        for (let offset = 0; offset + credential.length <= value.length; offset++) {
          if (await this.fingerprint(value.slice(offset, offset + credential.length)) === credential.digest) throw new QualificationFailure("qualification.metadata_contains_credential");
        }
      }
    }
  }
}
