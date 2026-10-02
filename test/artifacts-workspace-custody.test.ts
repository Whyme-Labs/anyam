import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { ArtifactsWorkspaceAdapter } from "../src/cloudflare/artifacts-workspace.ts";
import type { ArtifactsWorkspaceOptions } from "../src/cloudflare/artifacts-workspace.ts";
import type { AuthoritySqlHost } from "../src/cloudflare/authority-sqlite.ts";
import { SQLiteArtifactsWorkspaceStore } from "../src/cloudflare/artifacts-workspace-store.ts";
import { artifactsBindingFixture, artifactsSelection } from "./fixtures/artifacts-binding.ts";

async function withCustody(run: (input: { fixture: ReturnType<typeof artifactsBindingFixture>; control: (options?: Partial<ArtifactsWorkspaceOptions>) => ArtifactsWorkspaceAdapter; reopen: () => void; metadata: () => string; failWriteOnce: (pattern: string) => void }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "anyam-artifacts-custody-"));
  const path = join(directory, "custody.sqlite");
  const fixture = artifactsBindingFixture();
  let database = new DatabaseSync(path);
  let writeFailure: string | undefined;
  function control(options: Partial<ArtifactsWorkspaceOptions> = {}) {
    const host: AuthoritySqlHost = {
      sql: { exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
        const rows = database.prepare(query).all(...bindings as SQLInputValue[]) as unknown as readonly T[];
        if (writeFailure && query.includes(writeFailure)) { writeFailure = undefined; throw new Error("fixture database write failed with usable-secret"); }
        return { toArray: () => rows };
      } },
      transactionSync<T>(closure: () => T): T {
        database.exec("BEGIN IMMEDIATE");
        try { const result = closure(); database.exec("COMMIT"); return result; }
        catch (error) { database.exec("ROLLBACK"); throw error; }
      },
    };
    return new ArtifactsWorkspaceAdapter({ artifacts: fixture.binding, accountId: "account-a", namespace: "private", authorize: fixture.authorize, now: () => fixture.now, ...options, store: new SQLiteArtifactsWorkspaceStore(host) });
  }
  try { await run({ fixture, control, reopen: () => { database.close(); database = new DatabaseSync(path); }, metadata: () => JSON.stringify(database.prepare("SELECT payload FROM anyam_artifacts_workspaces").all()), failWriteOnce: pattern => { writeFailure = pattern; } }); }
  finally { database.close(); await rm(directory, { recursive: true, force: true }); }
}

test("Artifacts durable assignment rejects a duplicate fork after database and adapter replacement", async () => {
  await withCustody(async ({ fixture, control, reopen }) => {
    await control().forkWorkspace(artifactsSelection);
    reopen();
    await assert.rejects(control().forkWorkspace(artifactsSelection), { code: "artifacts.workspace_already_bound" });
    assert.equal(fixture.events.filter(event => event.startsWith("fork:")).length, 1);
  });
});

test("Artifacts SQLite rollback withholds provider effects and credentials on storage failure", async () => {
  await withCustody(async ({ fixture, control, metadata, failWriteOnce }) => {
    const first = control();
    failWriteOnce("INSERT INTO anyam_artifacts_workspaces");
    await assert.rejects(first.forkWorkspace(artifactsSelection), (error: unknown) => {
      assert.equal((error as { code: string }).code, "artifacts.custody_unavailable");
      assert.doesNotMatch(String(error), /usable-secret/);
      return true;
    });
    assert.equal(fixture.events.length, 0);
    assert.equal(metadata(), "[]", "the failed reservation must roll back");
    const context = await control().forkWorkspace(artifactsSelection);
    const request = { repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", operation: "read" as const, expiresAt: new Date(fixture.now + 120_000).toISOString() };
    failWriteOnce("UPDATE anyam_artifacts_workspaces");
    await assert.rejects(control().issue(request), (error: unknown) => {
      assert.equal((error as { providerEffect: string }).providerEffect, "none");
      assert.doesNotMatch(String(error), /usable-secret/);
      return true;
    });
    assert.equal(fixture.mintedCount, 0, "a failed mint journal must precede the provider effect");
    fixture.afterMint = () => { failWriteOnce("UPDATE anyam_artifacts_workspaces"); };
    await assert.rejects(control().issue(request));
    assert.equal(fixture.activeTokens.size, 0, "a token whose inventory write fails must be retired rather than released");
    assert.doesNotMatch(metadata(), /usable-secret|initial-secret/);
    fixture.afterMint = undefined;
    await control().issue(request);
    await control().revokeWorkspace({ workspaceId: "workspace:a", sourceSpaceId: "source:app" });
    assert.equal(fixture.activeTokens.size, 0);
  });
});

test("Artifacts custody read and revoke-write failures remain credential-free before provider access", async () => {
  await withCustody(async ({ fixture, control, failWriteOnce }) => {
    const context = await control().forkWorkspace(artifactsSelection);
    const request = { repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", operation: "read" as const, expiresAt: new Date(fixture.now + 120_000).toISOString() };
    for (const operation of ["issue-read", "revoke-read", "revoke-write"] as const) {
      const restored = control();
      const count = fixture.events.length;
      failWriteOnce(operation === "revoke-write" ? "UPDATE anyam_artifacts_workspaces" : "SELECT payload");
      await assert.rejects(operation === "issue-read" ? restored.issue(request) : restored.revokeWorkspace({ workspaceId: "workspace:a", sourceSpaceId: "source:app" }), (error: unknown) => {
        assert.equal((error as { code: string }).code, "artifacts.custody_unavailable");
        assert.doesNotMatch(String(error), /usable-secret/);
        return true;
      });
      assert.equal(fixture.events.length, count, "failed custody lookup or revocation commit cannot call the provider");
    }
  });
});

test("Artifacts restored custody cannot be used by a different account or namespace adapter", async () => {
  await withCustody(async ({ fixture, control, reopen }) => {
    const context = await control().forkWorkspace(artifactsSelection);
    reopen();
    const request = { repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", operation: "read" as const, expiresAt: new Date(fixture.now + 120_000).toISOString() };
    for (const options of [{ accountId: "account-b" }, { namespace: "other" }]) {
      const count = fixture.events.length;
      await assert.rejects(control(options).issue(request), { code: "artifacts.credential_context_denied" });
      assert.equal(fixture.events.length, count, "cross-scope restore must fail before authorization or provider lookup");
    }
    assert.equal(fixture.mintedCount, 0);
  });
});

test("Artifacts restores immutable selection and persists only its declared metadata", async () => {
  await withCustody(async ({ fixture, control, reopen, metadata }) => {
    let mutableAuthorizationInput = false;
    const options: Partial<ArtifactsWorkspaceOptions> = { async authorize(selection) {
      mutableAuthorizationInput ||= !Object.isFrozen(selection) || !Object.isFrozen(selection.sourceRepository);
      return fixture.authorize();
    } };
    const input = { ...artifactsSelection, token: "caller-secret", sourceRepository: { ...artifactsSelection.sourceRepository, token: "nested-caller-secret" } };
    const context = await control(options).forkWorkspace(input);
    assert.doesNotMatch(JSON.stringify(context), /caller-secret/);
    assert.doesNotMatch(metadata(), /caller-secret/);
    reopen();
    await control(options).issue({ repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", operation: "read", expiresAt: new Date(fixture.now + 120_000).toISOString() });
    assert.equal(mutableAuthorizationInput, false, "rehydrated selections must retain the immutable exact enrollment seen by current authority");
  });
});

test("Artifacts token custody and revocation survive SQLite and adapter replacement without plaintext", async () => {
  await withCustody(async ({ fixture, control, reopen, metadata }) => {
    const first = control();
    const context = await first.forkWorkspace(artifactsSelection);
    const request = { repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", workspaceId: "workspace:a", operation: "write" as const, expiresAt: new Date(fixture.now + 120_000).toISOString() };
    await first.issue(request);
    await first.issue({ ...request, operation: "read" });
    assert.equal(fixture.activeTokens.size, 2);
    assert.match(metadata(), /token-id-0/);
    assert.match(metadata(), /token-id-1/);
    assert.doesNotMatch(metadata(), /usable-secret|initial-secret/);
    reopen();
    await control().revokeWorkspace({ workspaceId: "workspace:a", sourceSpaceId: "source:app" });
    assert.equal(fixture.activeTokens.size, 0);
    reopen();
    await assert.rejects(control().issue(request), { code: "artifacts.authorization_denied" });
    assert.equal(fixture.events.filter(event => event.startsWith("mint:")).length, 2);
    assert.doesNotMatch(metadata(), /usable-secret|initial-secret/);
  });
});

test("Artifacts pending mint blocks another adapter and cannot certify complete revocation", async () => {
  await withCustody(async ({ fixture, control, metadata }) => {
    const first = control();
    const context = await first.forkWorkspace(artifactsSelection);
    const request = { repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", operation: "read" as const, expiresAt: new Date(fixture.now + 120_000).toISOString() };
    let started!: () => void;
    const mintStarted = new Promise<void>(resolve => { started = resolve; });
    let loseReply!: () => void;
    const reply = new Promise<never>((_resolve, reject) => { loseReply = () => reject(new Error("lost mint reply")); });
    const get = fixture.binding.get.bind(fixture.binding);
    let hold = true;
    fixture.binding.get = async name => {
      const repo = await get(name);
      return { ...repo, async createToken(scope, ttl) {
        const result = await repo.createToken(scope, ttl);
        if (hold) { hold = false; started(); return reply; }
        return result;
      } };
    };
    const pending = first.issue(request);
    const outcome = pending.catch(error => error);
    await mintStarted;
    try {
      await assert.rejects(control().issue(request), { code: "artifacts.workspace_operation_pending" });
      assert.match(metadata(), /pendingOperation.*mint/);
      await assert.rejects(control().revokeWorkspace({ workspaceId: "workspace:a", sourceSpaceId: "source:app" }), { code: "artifacts.workspace_token_inventory_unknown" });
      assert.equal(fixture.mintedCount, 1);
    } finally { loseReply(); await outcome; }
    await assert.rejects(control().issue(request), { code: "artifacts.authorization_denied" });
    assert.doesNotMatch(metadata(), /usable-secret|initial-secret/);
  });
});

test("Artifacts journals a fork before its provider effect and retains uncertain reservations across restart", async () => {
  await withCustody(async ({ fixture, control, reopen, metadata }) => {
    let beforeEffect = "";
    fixture.afterFork = () => { beforeEffect = metadata(); };
    fixture.revokeSucceeds = false;
    await assert.rejects(control().forkWorkspace(artifactsSelection), { code: "artifacts.initial_token_unretired" });
    assert.match(beforeEffect, /pendingOperation.*fork/, "the reservation must record the provider operation before the fork can complete");
    reopen();
    await assert.rejects(control().forkWorkspace(artifactsSelection), { code: "artifacts.workspace_already_bound" });
    await assert.rejects(control().forkWorkspace({ ...artifactsSelection, workspaceId: "workspace:peer" }), { code: "artifacts.workspace_already_bound" });
    assert.equal(fixture.events.filter(event => event.startsWith("fork:")).length, 1);
    assert.doesNotMatch(metadata(), /usable-secret|initial-secret/);
  });
});

test("Artifacts SQLite reservations serialize concurrent adapters for the same assignment or name", async () => {
  for (const peer of [artifactsSelection, { ...artifactsSelection, workspaceId: "workspace:peer" }]) {
    await withCustody(async ({ fixture, control }) => {
      const results = await Promise.allSettled([control().forkWorkspace(artifactsSelection), control().forkWorkspace(peer)]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const rejected = results.find(result => result.status === "rejected");
      assert.equal(rejected?.status === "rejected" && rejected.reason.code, "artifacts.workspace_already_bound");
      assert.equal(fixture.events.filter(event => event.startsWith("fork:")).length, 1);
      assert.equal(fixture.activeTokens.size, 0);
    });
  }
});

test("Artifacts restored enrollment rechecks current grant, expiry and provider UUID before minting", async () => {
  for (const condition of ["grant", "expiry", "uuid"] as const) {
    await withCustody(async ({ fixture, control, reopen }) => {
      const context = await control().forkWorkspace(artifactsSelection);
      reopen();
      if (condition === "grant") fixture.granted = false;
      if (condition === "expiry") fixture.now += 600_000;
      if (condition === "uuid") fixture.infos.get("workspace-a")!.id = "replacement-uuid";
      await assert.rejects(control().issue({ repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", operation: "read", expiresAt: new Date(fixture.now + 120_000).toISOString() }));
      assert.equal(fixture.mintedCount, 0, condition);
    });
  }
});

test("Artifacts unknown inventory and unconfirmed retirement survive SQLite restart", async () => {
  for (const condition of ["lost-reply", "unretired"] as const) {
    await withCustody(async ({ fixture, control, reopen, metadata }) => {
      const context = await control().forkWorkspace(artifactsSelection);
      const request = { repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", operation: "read" as const, expiresAt: new Date(fixture.now + 120_000).toISOString() };
      if (condition === "lost-reply") fixture.mintFails = true;
      else { fixture.returnedScope = "write"; fixture.revokeSucceeds = false; }
      await assert.rejects(control().issue(request));
      reopen();
      fixture.mintFails = false;
      await assert.rejects(control().issue(request), { code: "artifacts.authorization_denied" });
      assert.equal(fixture.mintedCount, 1);
      if (condition === "lost-reply") await assert.rejects(control().revokeWorkspace({ workspaceId: "workspace:a", sourceSpaceId: "source:app" }), { code: "artifacts.workspace_token_inventory_unknown" });
      else {
        assert.match(metadata(), /token-id-0/);
        fixture.revokeSucceeds = true;
        await control().revokeWorkspace({ workspaceId: "workspace:a", sourceSpaceId: "source:app" });
        assert.equal(fixture.activeTokens.size, 0);
      }
      assert.doesNotMatch(metadata(), /usable-secret|initial-secret/);
    });
  }
});
