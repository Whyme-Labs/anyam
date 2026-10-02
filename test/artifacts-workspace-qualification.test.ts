import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import type { AuthoritySqlHost } from "../src/cloudflare/authority-sqlite.ts";
import { SQLiteArtifactsWorkspaceStore } from "../src/cloudflare/artifacts-workspace-store.ts";
import type { ArtifactsQualificationOptions } from "../src/cloudflare/artifacts-workspace-qualification.ts";
import { repositoryObservationDigest } from "../src/portability/repository-observation.ts";
import { artifactsBindingFixture, artifactsSelection } from "./fixtures/artifacts-binding.ts";

async function qualificationFixture(run: (input: Awaited<ReturnType<typeof openQualification>>) => Promise<void>) {
  const value = await openQualification();
  try { await run(value); } finally { await value.close(); }
}

async function openQualification() {
  const module = await import("../src/cloudflare/artifacts-workspace-qualification.ts");
  const directory = await mkdtemp(join(tmpdir(), "anyam-artifacts-invoker-"));
  const path = join(directory, "qualification.sqlite");
  let database = new DatabaseSync(path);
  let writeFailure: string | undefined;
  const host: AuthoritySqlHost = {
    sql: { exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
      const rows = database.prepare(query).all(...bindings as SQLInputValue[]) as unknown as readonly T[];
      if (writeFailure && query.includes(writeFailure)) { writeFailure = undefined; throw new Error("qualification database failure contains usable-secret"); }
      return { toArray: () => rows };
    } },
    transactionSync<T>(callback: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try { const result = callback(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
  const fixture = artifactsBindingFixture();
  const get = fixture.binding.get.bind(fixture.binding);
  const tokenOwners = new Map<string, string>();
  const artifacts = { async get(name: string) {
    let repo;
    try { repo = await get(name); }
    catch (error) {
      if (error instanceof Error && error.message === "NOT_FOUND") throw Object.assign(new Error("missing provider repository with usable-secret"), { code: "NOT_FOUND" });
      throw error;
    }
    return { ...repo,
      async readCommit(oid: string) { const commit = await repo.readCommit(oid); return commit && { ...commit, parents: [] }; },
      async createToken(scope: "read" | "write", ttl: number) {
        const previous = new Set(fixture.activeTokens);
        try { const token = await repo.createToken(scope, ttl); return { ...token, extra: "provider-extra-secret" }; }
        finally { for (const id of fixture.activeTokens) if (!previous.has(id)) tokenOwners.set(id, name); }
      },
      async revokeToken(value: string) { return repo.revokeToken(value === `initial-id-${name}` ? `initial-secret-${name}` : value); },
      async listTokens() {
        const tokens = [...fixture.activeTokens].filter(id => tokenOwners.get(id) === name || id === `initial-secret-${name}`).map(id => ({ id: id === `initial-secret-${name}` ? `initial-id-${name}` : id, state: "active" as const }));
        return { tokens, total: tokens.length };
      },
    };
  } };
  const deleted: string[] = [];
  async function deleteOwned(input: { name: string; expectedRepositoryId: string }) {
    if (fixture.infos.get(input.name)?.id !== input.expectedRepositoryId) return false;
    fixture.infos.delete(input.name);
    deleted.push(input.name);
    return true;
  }
  function control(overrides: Partial<ArtifactsQualificationOptions> = {}) {
    return new module.ArtifactsWorkspaceQualification({ artifacts, accountId: "account-a", namespace: "private", authorizeRun: async () => {}, authorize: fixture.authorize, now: () => fixture.now, store: new SQLiteArtifactsWorkspaceStore(host), ledger: new module.SQLiteArtifactsQualificationLedger(host), deleteOwned, ...overrides });
  }
  return { fixture, deleted, control, artifacts, failWriteOnce: (query: string) => { writeFailure = query; }, record: (runId: string) => new module.SQLiteArtifactsQualificationLedger(host).read(runId), metadata: () => JSON.stringify({ runs: database.prepare("SELECT payload FROM anyam_artifacts_qualification_runs").all(), custody: database.prepare("SELECT payload FROM anyam_artifacts_workspaces").all() }), reopen: () => { database.close(); database = new DatabaseSync(path); }, close: async () => { database.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("Artifacts one-shot qualification persists a redacted resource/token ledger and confirms owned cleanup", async () => {
  await qualificationFixture(async ({ fixture, control, deleted, metadata, reopen }) => {
    const input = { runId: "qualification:one", execution: "local-fixture" as const, selections: [artifactsSelection], credentialExpiresAt: new Date(fixture.now + 120_000).toISOString() };
    const result = await control().run(input);
    assert.equal(result.status, "succeeded");
    assert.equal(result.liveQualified, false);
    assert.equal(result.cleanup, "confirmed");
    assert.deepEqual(deleted, ["workspace-a"]);
    assert.equal(fixture.activeTokens.size, 0);
    assert.equal(fixture.infos.has("source"), true, "source repository must never be deleted");
    assert.match(metadata(), /uuid-workspace-a/);
    assert.doesNotMatch(metadata() + JSON.stringify(result), /usable-secret|initial-secret|provider-extra-secret/);
    const forkCount = fixture.events.filter(event => event.startsWith("fork:")).length;
    reopen();
    assert.equal((await control().run(input)).status, "blocked");
    assert.equal(fixture.events.filter(event => event.startsWith("fork:")).length, forkCount, "restart must not rerun the same invocation");
  });
});

test("Artifacts qualification rolls back failed ledger writes, preserves uncertain effects and records confirmed token retirements", async () => {
  const outcomes: string[] = [];
  for (const condition of ["reservation", "preflight-journal", "fork-reply", "mint-reply", "cleanup-journal", "retired-history"] as const) {
    await qualificationFixture(async ({ fixture, control, artifacts, deleted, metadata, record, reopen, failWriteOnce }) => {
      const get = artifacts.get.bind(artifacts);
      let listings = 0;
      const provider = { async get(name: string) {
        const repo = await get(name);
        return { ...repo, async listTokens() {
          const inventory = await repo.listTokens();
          if (condition === "cleanup-journal" && ++listings === 2) failWriteOnce("UPDATE anyam_artifacts_qualification_runs");
          return inventory;
        } };
      } };
      const runner = control({ artifacts: provider });
      if (condition === "reservation") failWriteOnce("INSERT INTO anyam_artifacts_qualification_runs");
      if (condition === "preflight-journal") failWriteOnce("UPDATE anyam_artifacts_qualification_runs");
      if (condition === "fork-reply") fixture.afterFork = () => failWriteOnce("UPDATE anyam_artifacts_qualification_runs");
      if (condition === "mint-reply") fixture.afterMint = () => failWriteOnce("UPDATE anyam_artifacts_qualification_runs");
      const runId = `qualification:storage-${condition}`;
      const result = await runner.run({ runId, execution: "local-fixture", selections: [artifactsSelection], credentialExpiresAt: new Date(fixture.now + 120_000).toISOString() });
      outcomes.push(`${condition}:${result.code}:${result.cleanup}:forks=${fixture.events.filter(event => event.startsWith("fork:")).length}:deletes=${deleted.length}:active=${fixture.activeTokens.size}`);
      assert.doesNotMatch(metadata() + JSON.stringify(result), /usable-secret|initial-secret|provider-extra-secret/);
      if (condition === "fork-reply") assert.equal(result.resources[0]?.recovery, "qualification.repository_identity_unknown");
      if (condition === "cleanup-journal") {
        assert.equal(result.resources[0]?.recovery, "qualification.ledger_unavailable");
        reopen();
        assert.equal(await control({ artifacts: provider }).cleanup(runId), "confirmed");
        assert.equal(deleted.length, 1);
      }
      if (condition === "retired-history") {
        assert.deepEqual(result.resources[0]?.retiredTokenIds, ["token-id-0", "token-id-1"]);
        reopen();
        assert.deepEqual(record(runId)?.resources[0]?.retiredTokenIds, ["token-id-0", "token-id-1"]);
      }
    });
  }
  assert.deepEqual(outcomes, ["reservation:qualification.ledger_unavailable:required:forks=0:deletes=0:active=0", "preflight-journal:qualification.ledger_unavailable:confirmed:forks=0:deletes=0:active=0", "fork-reply:qualification.ledger_unavailable:required:forks=1:deletes=0:active=1", "mint-reply:qualification.ledger_unavailable:confirmed:forks=1:deletes=1:active=0", "cleanup-journal:qualification.cleanup_required:required:forks=1:deletes=0:active=0", "retired-history:qualification.completed:confirmed:forks=1:deletes=1:active=0"]);
});

test("Artifacts qualification returns durable exact observation provenance and named resource recovery", async () => {
  await qualificationFixture(async ({ fixture, control, record, reopen, metadata }) => {
    const runId = "qualification:receipt";
    const result = await control().run({ runId, execution: "local-fixture", selections: [artifactsSelection], credentialExpiresAt: new Date(fixture.now + 120_000).toISOString() });
    assert.equal(result.code, "qualification.completed");
    assert.equal(result.execution, "local-fixture");
    assert.equal(result.accountId, "account-a");
    assert.equal(result.namespace, "private");
    assert.equal(result.gitScope, "not-run");
    assert.equal(result.expiryTiming, "not-run");
    assert.ok(result.operationIntents.includes("cleanup:listTokens"));
    const resource = result.resources[0]!;
    assert.equal(resource.repositoryId, "uuid-workspace-a");
    assert.equal(resource.state, "deleted");
    assert.equal(resource.recovery, "none");
    assert.equal(resource.observation?.commitOid, artifactsSelection.baseCommitOid);
    assert.equal(resource.observation?.treeOid, artifactsSelection.baseTreeOid);
    assert.equal(resource.observation?.projectViewId, artifactsSelection.projectViewId);
    assert.equal(resource.observation?.manifestDigest, await repositoryObservationDigest(resource.observation!));
    reopen();
    assert.deepEqual(record(runId)?.resources[0]?.observation, resource.observation);
    const repeated = await control().run({ runId, execution: "local-fixture", selections: [artifactsSelection], credentialExpiresAt: new Date(fixture.now + 120_000).toISOString() });
    assert.equal(repeated.code, "qualification.run_already_recorded");
    assert.deepEqual(repeated.resources, [], "a rejected invocation must not disclose or rewrite another invocation's ledger");
    assert.doesNotMatch(JSON.stringify(result) + metadata(), /usable-secret|initial-secret|provider-extra-secret/);
  });
  await qualificationFixture(async ({ fixture, control }) => {
    const result = await control({ deleteOwned: undefined }).run({ runId: "qualification:cleanup-receipt", execution: "local-fixture", selections: [artifactsSelection], credentialExpiresAt: new Date(fixture.now + 120_000).toISOString() });
    assert.equal(result.code, "qualification.cleanup_required");
    assert.equal(result.resources[0]?.recovery, "qualification.guarded_delete_unqualified");
    assert.equal(result.resources[0]?.initialToken, "retired");
    assert.deepEqual(result.resources[0]?.tokenIds, []);
  });
});

test("Artifacts qualification reconciles an initial-token lost reply and continues independent cleanup after one resource fails", async () => {
  const outcomes: string[] = [];
  for (const condition of ["lost-initial", "first-cleanup-fails", "cross-source-alias"] as const) {
    await qualificationFixture(async ({ fixture, control, artifacts, deleted, metadata }) => {
      const second = { ...artifactsSelection, targetName: "workspace-b", workspaceId: "workspace:b" };
      if (condition === "cross-source-alias") {
        const source = fixture.infos.get("source")!;
        fixture.infos.set("source-b", { ...source, id: "uuid-source-b", name: "source-b", remote: "https://account-a.artifacts.cloudflare.net/git/private/source-b.git" });
        fixture.commits.set("source-b", fixture.commits.get("source")!);
        fixture.heads.set("source-b", fixture.heads.get("source")!);
        second.sourceRepository = { ...artifactsSelection.sourceRepository, name: "source-b", repositoryId: "uuid-source-b" };
        second.sourceSpaceId = "source:docs";
        fixture.forkedRepositoryId = "uuid-source-b";
      }
      const get = artifacts.get.bind(artifacts);
      let initialReplyLost = false;
      const provider = { async get(name: string) {
        const repo = await get(name);
        return { ...repo,
          async createToken(scope: "read" | "write", ttl: number) {
            if (condition === "first-cleanup-fails" && name === "workspace-b") fixture.mintFails = true;
            return repo.createToken(scope, ttl);
          },
          async revokeToken(value: string) {
            if (condition === "lost-initial" && value.startsWith("initial-secret") && !initialReplyLost) { initialReplyLost = true; throw new Error("lost initial-token reply contains initial-secret"); }
            return repo.revokeToken(value);
          },
          async listTokens() {
            if (condition === "first-cleanup-fails" && name === "workspace-a") throw new Error("inventory unavailable contains usable-secret");
            return repo.listTokens();
          },
        };
      } };
      const selections = condition === "lost-initial" ? [artifactsSelection] : [artifactsSelection, second];
      const result = await control({ artifacts: provider }).run({ runId: `qualification:recovery-${condition}`, execution: "local-fixture", selections, credentialExpiresAt: new Date(fixture.now + 120_000).toISOString() });
      outcomes.push(`${condition}:${result.bindingContract}:${result.cleanup}:${deleted.join(",")}:active=${fixture.activeTokens.size}`);
      assert.doesNotMatch(metadata() + JSON.stringify(result), /usable-secret|initial-secret|provider-extra-secret/);
      assert.equal(fixture.infos.has("source"), true);
      if (condition === "cross-source-alias") assert.equal(fixture.infos.has("source-b"), true);
    });
  }
  assert.deepEqual(outcomes, ["lost-initial:blocked:confirmed:workspace-a:active=0", "first-cleanup-fails:blocked:required:workspace-b:active=0", "cross-source-alias:blocked:required::active=1"]);
});

test("Artifacts cleanup reconciles complete token inventory after lost mint replies and refuses uncertain inventory or identity", async () => {
  const outcomes: string[] = [];
  for (const condition of ["lost-mint", "incomplete", "malformed", "retirement-denied", "uuid-drift", "unknown-fork", "two-resources"] as const) {
    await qualificationFixture(async ({ fixture, control, artifacts, deleted, metadata, reopen }) => {
      if (condition === "unknown-fork") fixture.forkFails = true;
      if (condition !== "two-resources" && condition !== "unknown-fork") fixture.mintFails = true;
      if (condition === "retirement-denied") fixture.afterMint = () => { fixture.revokeSucceeds = false; };
      const get = artifacts.get.bind(artifacts);
      const provider = { async get(name: string) {
        const repo = await get(name);
        return { ...repo, async listTokens() {
          const inventory = await repo.listTokens();
          if (condition === "incomplete") return { ...inventory, total: inventory.total + 1 };
          if (condition === "malformed") return { tokens: [...inventory.tokens, { id: "invalid token id", state: "active" as const }], total: inventory.total + 1 };
          if (condition === "uuid-drift") fixture.infos.get(name)!.id = "recreated-uuid";
          return inventory;
        } };
      } };
      const selections = condition === "two-resources" ? [artifactsSelection, { ...artifactsSelection, targetName: "workspace-b", workspaceId: "workspace:b" }] : [artifactsSelection];
      const runId = `qualification:inventory-${condition}`;
      const result = await control({ artifacts: provider }).run({ runId, execution: "local-fixture", selections, credentialExpiresAt: new Date(fixture.now + 120_000).toISOString() });
      outcomes.push(`${condition}:${result.bindingContract}:${result.cleanup}:deletes=${deleted.length}:active=${fixture.activeTokens.size}`);
      assert.equal(fixture.infos.has("source"), true);
      assert.doesNotMatch(metadata() + JSON.stringify(result), /usable-secret|initial-secret|provider-extra-secret|invalid token id/);
      if (condition === "lost-mint") {
        reopen();
        assert.equal(await control({ artifacts: provider }).cleanup(runId), "confirmed");
        assert.equal(deleted.length, 1, "confirmed cleanup must not repeat deletion after restart");
      }
    });
  }
  assert.deepEqual(outcomes, ["lost-mint:blocked:confirmed:deletes=1:active=0", "incomplete:blocked:required:deletes=0:active=1", "malformed:blocked:required:deletes=0:active=1", "retirement-denied:blocked:required:deletes=0:active=1", "uuid-drift:blocked:required:deletes=0:active=1", "unknown-fork:blocked:required:deletes=0:active=0", "two-resources:passed:confirmed:deletes=2:active=0"]);
});

test("Artifacts qualification refuses denied, empty, duplicate or pre-existing scopes before mutations", async () => {
  const outcomes: string[] = [];
  const mutations: string[] = [];
  for (const condition of ["denied", "empty", "duplicate", "existing", "lookup-error", "caller-mutated"] as const) {
    await qualificationFixture(async ({ fixture, control, deleted }) => {
      const selections = [structuredClone(artifactsSelection)];
      if (condition === "empty") selections.length = 0;
      if (condition === "duplicate") selections.push({ ...artifactsSelection, workspaceId: "workspace:peer" });
      if (condition === "existing") fixture.infos.set("workspace-a", { id: "pre-existing-uuid", name: "workspace-a", defaultBranch: "main", remote: "https://account-a.artifacts.cloudflare.net/git/private/workspace-a.git", readOnly: false });
      if (condition === "lookup-error") fixture.unavailableName = "workspace-a";
      const result = await control({ async authorizeRun(input) {
        assert.equal(Object.isFrozen(input), true);
        if (condition === "denied") throw new Error("owner denial contains usable-secret");
        if (condition === "caller-mutated") selections[0]!.targetName = "unapproved-name";
      } }).run({ runId: `qualification:${condition}`, execution: "local-fixture", selections, credentialExpiresAt: new Date(fixture.now + 120_000).toISOString() });
      outcomes.push(`${condition}:${result.status}`);
      if (condition === "caller-mutated") assert.deepEqual(deleted, ["workspace-a"]);
      else mutations.push(`${condition}:${fixture.events.some(event => event.startsWith("fork:"))}:${deleted.length}`);
      assert.doesNotMatch(JSON.stringify(result), /usable-secret|initial-secret/);
    });
  }
  assert.deepEqual(outcomes, ["denied:blocked", "empty:blocked", "duplicate:blocked", "existing:blocked", "lookup-error:blocked", "caller-mutated:succeeded"]);
  assert.deepEqual(mutations, ["denied:false:0", "empty:false:0", "duplicate:false:0", "existing:false:0", "lookup-error:false:0"]);
});

test("Artifacts qualification validates every selection and redacts secret-alias provider identities at acquisition", async () => {
  const outcomes: string[] = [];
  const leaks: string[] = [];
  for (const condition of ["invalid-second", "fork-id-secret", "mint-id-secret", "canonical-alias"] as const) {
    await qualificationFixture(async ({ fixture, control, artifacts, metadata, deleted }) => {
      const selections = [structuredClone(artifactsSelection)];
      if (condition === "invalid-second") selections.push({ ...artifactsSelection, workspaceId: "workspace:b", targetName: "workspace-b", sourceRepository: { ...artifactsSelection.sourceRepository, accountId: "account-b" } });
      if (condition === "fork-id-secret") fixture.forkedRepositoryId = "initial-secret-workspace-a";
      if (condition === "canonical-alias") fixture.forkedRepositoryId = "uuid-source";
      const get = artifacts.get.bind(artifacts);
      const provider = { async get(name: string) {
        const repo = await get(name);
        return { ...repo, async createToken(scope: "read" | "write", ttl: number) { const reply = await repo.createToken(scope, ttl); return condition === "mint-id-secret" ? { ...reply, id: reply.plaintext } : reply; } };
      } };
      const result = await control({ artifacts: provider }).run({ runId: `qualification:${condition}`, execution: "local-fixture", selections, credentialExpiresAt: new Date(fixture.now + 120_000).toISOString() });
      outcomes.push(`${condition}:${result.status}`);
      if (/usable-secret|initial-secret|provider-extra-secret/u.test(metadata() + JSON.stringify(result))) leaks.push(condition);
      if (condition === "invalid-second") outcomes.push(`invalid-second:forks=${fixture.events.filter(event => event.startsWith("fork:")).length}`);
      if (condition === "canonical-alias") outcomes.push(`canonical-alias:deletes=${deleted.length}`);
    });
  }
  assert.deepEqual({ outcomes, leaks }, { outcomes: ["invalid-second:blocked", "invalid-second:forks=0", "fork-id-secret:blocked", "mint-id-secret:blocked", "canonical-alias:blocked", "canonical-alias:deletes=0"], leaks: [] });
});

test("Artifacts acquisition and cleanup never journal identities that alias previously returned plaintext", async () => {
  const leaks: string[] = [];
  const outcomes: string[] = [];
  for (const condition of ["prior-token-id", "inventory-secret-id"] as const) {
    await qualificationFixture(async ({ fixture, control, artifacts, metadata, deleted }) => {
      const get = artifacts.get.bind(artifacts);
      let previousPlaintext = "";
      const provider = { async get(name: string) {
        const repo = await get(name);
        return { ...repo,
          async createToken(scope: "read" | "write", ttl: number) {
            const reply = await repo.createToken(scope, ttl);
            if (scope === "read") previousPlaintext = reply.plaintext;
            return condition === "prior-token-id" && scope === "write" ? { ...reply, id: previousPlaintext } : reply;
          },
          async listTokens() {
            const inventory = await repo.listTokens();
            return condition === "inventory-secret-id" ? { tokens: [...inventory.tokens, { id: previousPlaintext, state: "active" as const }], total: inventory.total + 1 } : inventory;
          },
        };
      } };
      const result = await control({ artifacts: provider }).run({ runId: `qualification:plaintext-alias-${condition}`, execution: "local-fixture", selections: [artifactsSelection], credentialExpiresAt: new Date(fixture.now + 120_000).toISOString() });
      if (/usable-secret|initial-secret|provider-extra-secret/u.test(metadata() + JSON.stringify(result))) leaks.push(condition);
      outcomes.push(`${condition}:${result.status}:deletes=${deleted.length}`);
    });
  }
  assert.deepEqual({ leaks, outcomes }, { leaks: [], outcomes: ["prior-token-id:blocked:deletes=1", "inventory-secret-id:blocked:deletes=0"] });
});

test("Artifacts cleanup rechecks owner and account scope and never retries an uncertain delete", async () => {
  const outcomes: string[] = [];
  for (const condition of ["account", "namespace", "owner-denied", "lost-delete", "missing-delete"] as const) {
    await qualificationFixture(async ({ fixture, control, deleted, reopen, metadata }) => {
      let attempts = 0;
      const deleteOwned = async () => { attempts++; if (condition === "lost-delete") throw new Error("lost deletion reply contains usable-secret"); return false; };
      const runner = control({ deleteOwned: condition === "missing-delete" ? undefined : deleteOwned });
      const runId = `qualification:cleanup-${condition}`;
      const result = await runner.run({ runId, execution: "local-fixture", selections: [artifactsSelection], credentialExpiresAt: new Date(fixture.now + 120_000).toISOString() });
      assert.equal(result.status, "blocked");
      assert.equal(fixture.activeTokens.size, 0, "known tokens must be retired even when repository cleanup is unavailable");
      reopen();
      const overrides: Partial<ArtifactsQualificationOptions> = condition === "account" ? { accountId: "account-b" } : condition === "namespace" ? { namespace: "other" } : condition === "owner-denied" ? { authorizeRun: async () => { throw new Error("denied with usable-secret"); } } : { deleteOwned: condition === "missing-delete" ? undefined : deleteOwned };
      const events = fixture.events.length;
      const resumed = await control(overrides).cleanup(runId);
      outcomes.push(`${condition}:${resumed}:deletes=${deleted.length}`);
      if (["account", "namespace", "owner-denied"].includes(condition)) outcomes.push(`${condition}:providerCalls=${fixture.events.length - events}`);
      if (condition === "lost-delete") outcomes.push(`lost-delete:attempts=${attempts}`);
      assert.doesNotMatch(metadata(), /usable-secret|initial-secret/);
    });
  }
  assert.deepEqual(outcomes, ["account:required:deletes=0", "account:providerCalls=0", "namespace:required:deletes=0", "namespace:providerCalls=0", "owner-denied:required:deletes=0", "owner-denied:providerCalls=0", "lost-delete:required:deletes=0", "lost-delete:attempts=1", "missing-delete:required:deletes=0"]);
});
