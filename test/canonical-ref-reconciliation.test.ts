import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CanonicalRefReconciler, type FencedCanonicalRefProvider, type FencedRefRequest } from "../src/cloudflare/canonical-ref-reconciliation.ts";
import { SQLiteCohortLandingAuthority } from "../src/cloudflare/cohort-landing.ts";
import { createAuthorityRecoveryBundle, verifyAuthorityRecoveryBundle } from "../src/cloudflare/authority-recovery.ts";
import { cohortStore } from "./fixtures/cohort-sqlite.ts";
import { FencedGitProviderFixture } from "./fixtures/fenced-git-provider.ts";
import { prepareCohort, projectId, realGitSources, session } from "./fixtures/reconciliation-project.ts";

test("partial repair reopens, seals exact completion, permits a subsequent Cohort, and fences an old worker across OID ABA", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-reconciliation-"));
  const path = join(root, "authority.sqlite");
  let database = new DatabaseSync(path);
  try {
    let store = cohortStore(database);
    const source = realGitSources(root);
    const first = await prepareCohort(store, "first", source, source.revisions[1]!);
    const firstLanding = await new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: first.evaluate }).landCohort(first.request);
    const originalReceipt = structuredClone(store.load(session.realmId)!.idempotency["landing.cohort:cohort:first"]);
    const next = await prepareCohort(store, "second", source, source.revisions[0]!); // revisit an old OID through new source history
    const providerRoot = join(root, "provider-state");
    const interrupted = new FencedGitProviderFixture(providerRoot, source.directories, (operation) => { if (operation === "repair") throw new Error("lost provider reply after durable apply"); });
    const interruptedReconciler = new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider: interrupted });
    await assert.rejects(interruptedReconciler.reconcile(), /lost provider reply/);
    assert.equal(store.load(session.realmId)!.canonicalRefProjections[projectId]!.state, "pending");
    await assert.rejects(Promise.resolve().then(() => new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: next.evaluate, reconciliation: interruptedReconciler }).landCohort(next.request)), /reconciliation is incomplete/);
    const oldRequest = interrupted.events.find((event) => event.operation === "repair")!.request as FencedRefRequest;
    database.close();
    database = new DatabaseSync(path);
    store = cohortStore(database);
    const provider = new FencedGitProviderFixture(providerRoot, source.directories);
    const reconciler = new CanonicalRefReconciler({ store, session, projectId, bindings: [...source.bindings].reverse(), provider });
    const completion = await reconciler.reconcile();
    assert.equal(completion.state, "complete");
    assert.equal(completion.projectRevisionId, firstLanding.projectRevisionId);
    assert.equal(Object.keys(completion.sealed).length, 2);
    assert.ok(Object.values(completion.sealed).every((receipt) => receipt.sealed && receipt.projectRevisionId === firstLanding.projectRevisionId));
    const completedSnapshot = store.load(session.realmId)!;
    const recovery = await createAuthorityRecoveryBundle({ snapshot: completedSnapshot, bundleId: "bundle:projection-completion", recoveryKeyId: "key:offline-test", secret: "offline-test-recovery-secret" });
    const verifiedRecovery = await verifyAuthorityRecoveryBundle({ value: recovery, realmId: session.realmId, recoveryKeyId: "key:offline-test", secret: "offline-test-recovery-secret" });
    assert.equal(verifiedRecovery.valid, true);
    if (verifiedRecovery.valid) assert.deepEqual(verifiedRecovery.bundle.snapshot.canonicalRefProjections[projectId], completion);
    const tamperedRecovery = structuredClone(recovery);
    tamperedRecovery.snapshot.canonicalRefProjections[projectId]!.epoch += 1;
    assert.equal((await verifyAuthorityRecoveryBundle({ value: tamperedRecovery, realmId: session.realmId, recoveryKeyId: "key:offline-test", secret: "offline-test-recovery-secret" })).valid, false, "signed recovery binds projection completion to its original epoch");
    assert.deepEqual(await reconciler.reconcile(), completion);
    assert.deepEqual(store.load(session.realmId), completedSnapshot, "completion replay does not rewrite any Authority record");
    await assert.rejects(provider.externalMove(source.bindings[0]!, source.revisions[2]!["source:a"]!), /sealed_epoch/);
    const secondLanding = await new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: next.evaluate, reconciliation: reconciler }).landCohort(next.request);
    assert.notEqual(secondLanding.projectRevisionId, firstLanding.projectRevisionId);
    const secondPacket = store.load(session.realmId)!.idempotency["landing.cohort:cohort:second"]!.result.value.reviewPacket as { priorProjectionCompletion: { id: string } };
    assert.equal(secondPacket.priorProjectionCompletion.id, completion.id);
    const secondCompletion = await reconciler.reconcile();
    assert.ok(secondCompletion.epoch > completion.epoch);
    const current = await provider.observe({ ...source.bindings[0]!, challenge: "current-generation" });
    assert.equal(current.oid, oldRequest.expectedOid, "the ref revisited its original OID at a newer epoch");
    await assert.rejects(provider.repair({ ...oldRequest, expectedGeneration: current.generation, expectedOid: current.oid, challenge: "stale-worker-new-probe" }), /stale_or_reused_epoch/);
    assert.deepEqual(store.load(session.realmId)!.idempotency["landing.cohort:cohort:first"], originalReceipt);
    assert.equal(store.load(session.realmId)!.canonicalByProject[projectId], secondLanding.projectRevisionId);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("generation CAS rejects competing ABA and unknown external refs; incomplete, forged and unqualified observations cannot certify completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-reconciliation-boundary-"));
  const database = new DatabaseSync(join(root, "authority.sqlite"));
  try {
    const store = cohortStore(database);
    const source = realGitSources(root);
    const first = await prepareCohort(store, "first", source, source.revisions[1]!);
    await new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: first.evaluate }).landCohort(first.request);
    const provider = new FencedGitProviderFixture(join(root, "provider-state"), source.directories);
    const binding = source.bindings[0]!;
    const before = await provider.observe({ ...binding, challenge: "before" });
    await provider.externalMove(binding, source.revisions[2]!["source:a"]!);
    await provider.externalMove(binding, source.revisions[0]!["source:a"]!);
    await assert.rejects(provider.repair({ ...binding, baseOid: source.revisions[0]!["source:a"]!, desiredOid: source.revisions[1]!["source:a"]!, projectRevisionId: store.load(session.realmId)!.canonicalByProject[projectId]!, epoch: 1, expectedGeneration: before.generation, expectedOid: before.oid, challenge: "stale" }), /stale_generation/);
    await provider.externalMove(binding, source.revisions[2]!["source:a"]!);
    const reconciler = new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider });
    await assert.rejects(reconciler.reconcile(), /competing external ref change/);
    assert.equal(store.load(session.realmId)!.canonicalRefProjections[projectId]!.state, "pending");
    const incomplete = new CanonicalRefReconciler({ store, session, projectId, bindings: [binding], provider });
    await assert.rejects(incomplete.reconcile(), /complete unique Project repository coverage/);
    const forged: FencedCanonicalRefProvider = { id: provider.id, qualification: provider.qualification, observe: async (input) => ({ ...await provider.observe(input), challenge: "replayed-probe" }), repair: (input) => provider.repair(input), seal: (input) => provider.seal(input) };
    await assert.rejects(new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider: forged }).reconcile(), /observation identity, challenge/);
    const unqualified = { ...forged, qualification: { fencedPublication: "unverified" as const, receipt: "plain Git has no epoch fence" } };
    await assert.rejects(new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider: unqualified }).reconcile(), /provider fenced publication is unqualified/);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("fresh completion verification rejects ref drift and an intervening Authority write before subsequent selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-reconciliation-freshness-"));
  const database = new DatabaseSync(join(root, "authority.sqlite"));
  try {
    const store = cohortStore(database);
    const source = realGitSources(root);
    const first = await prepareCohort(store, "first", source, source.revisions[1]!);
    await new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: first.evaluate }).landCohort(first.request);
    const provider = new FencedGitProviderFixture(join(root, "provider-state"), source.directories);
    const reconciler = new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider });
    await reconciler.reconcile();
    const second = await prepareCohort(store, "second", source, source.revisions[2]!);
    const previous = store.load(session.realmId)!;
    let wrote = false;
    const competing: FencedCanonicalRefProvider = { id: provider.id, qualification: provider.qualification, repair: (input) => provider.repair(input), seal: (input) => provider.seal(input), observe: async (input) => {
      const observation = await provider.observe(input);
      if (!wrote) { wrote = true; const next = structuredClone(previous); next.version += 1; store.commit(previous, next); }
      return observation;
    } };
    const stale = new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider: competing });
    await assert.rejects(Promise.resolve().then(() => new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: second.evaluate, reconciliation: stale }).landCohort(second.request)), /authority_sqlite_stale_version/);
    assert.equal(Object.keys(store.load(session.realmId)!.landings).length, 1);
    // Deliberate bypass of the test provider models an unqualified external
    // writer. Fresh observation detects it; a stored receipt cannot open Landing.
    execFileSync("git", ["update-ref", source.bindings[0]!.ref, source.revisions[0]!["source:a"]!], { cwd: source.directories["repo:a"]!, encoding: "utf8" });
    await assert.rejects(Promise.resolve().then(() => new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: second.evaluate, reconciliation: reconciler }).landCohort(second.request)), /provider state does not bind/);
    assert.equal(Object.keys(store.load(session.realmId)!.landings).length, 1);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("wrong repository, ref, candidate and epoch responses cannot become completion artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-reconciliation-response-binding-"));
  const database = new DatabaseSync(join(root, "authority.sqlite"));
  try {
    const store = cohortStore(database);
    const source = realGitSources(root);
    const first = await prepareCohort(store, "first", source, source.revisions[1]!);
    await new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: first.evaluate }).landCohort(first.request);
    const provider = new FencedGitProviderFixture(join(root, "provider-state"), source.directories);
    for (const override of [{ providerId: "provider:other" }, { repositoryId: "repo:other" }, { ref: "refs/heads/other" }]) {
      const wrong: FencedCanonicalRefProvider = { id: provider.id, qualification: provider.qualification, observe: async (input) => ({ ...await provider.observe(input), ...override }), repair: (input) => provider.repair(input), seal: (input) => provider.seal(input) };
      await assert.rejects(new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider: wrong }).reconcile(), /provider observation identity/);
    }
    const wrongSeal: FencedCanonicalRefProvider = { id: provider.id, qualification: provider.qualification, observe: (input) => provider.observe(input), repair: (input) => provider.repair(input), seal: async (input) => ({ ...await provider.seal(input), projectRevisionId: "project-revision:other", candidateOid: source.revisions[2]![input.sourceSpaceId]!, epoch: input.epoch + 1 }) };
    await assert.rejects(new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider: wrongSeal }).reconcile(), /provider state does not bind/);
    assert.equal(store.load(session.realmId)!.canonicalRefProjections[projectId]!.state, "pending");
    const recovered = await new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider }).reconcile();
    assert.equal(recovered.state, "complete", "fresh actual provider read-back can recover from a forged lost seal response");
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a provider mutation between observation and repair loses generation CAS without certifying completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-reconciliation-provider-race-"));
  const database = new DatabaseSync(join(root, "authority.sqlite"));
  try {
    const store = cohortStore(database);
    const source = realGitSources(root);
    const first = await prepareCohort(store, "first", source, source.revisions[1]!);
    const landing = await new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: first.evaluate }).landCohort(first.request);
    const provider = new FencedGitProviderFixture(join(root, "provider-state"), source.directories);
    let changed = false;
    const racing: FencedCanonicalRefProvider = { id: provider.id, qualification: provider.qualification, repair: (input) => provider.repair(input), seal: (input) => provider.seal(input), observe: async (input) => {
      const before = await provider.observe(input);
      if (!changed) { changed = true; await provider.externalMove(input, source.revisions[2]![input.sourceSpaceId]!); }
      return before;
    } };
    const reconciler = new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider: racing });
    await assert.rejects(reconciler.reconcile(), /stale_generation/);
    const after = store.load(session.realmId)!;
    assert.equal(after.canonicalByProject[projectId], landing.projectRevisionId);
    assert.equal(after.canonicalRefProjections[projectId]!.state, "pending");
    assert.deepEqual(after.canonicalRefProjections[projectId]!.sealed, {});
    await assert.rejects(reconciler.reconcile(), /competing external ref change/);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("two subsequent Landings freshly verify the same completion and exactly one wins the canonical version fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-reconciliation-landing-race-"));
  const database = new DatabaseSync(join(root, "authority.sqlite"));
  try {
    const store = cohortStore(database);
    const source = realGitSources(root);
    const first = await prepareCohort(store, "first", source, source.revisions[1]!);
    await new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: first.evaluate }).landCohort(first.request);
    const provider = new FencedGitProviderFixture(join(root, "provider-state"), source.directories);
    const reconciler = new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider });
    await reconciler.reconcile();
    const left = await prepareCohort(store, "left", source, source.revisions[2]!);
    const right = await prepareCohort(store, "right", source, source.revisions[2]!);
    const authority = (cohort: typeof left) => new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: cohort.evaluate, reconciliation: reconciler });
    const outcomes = await Promise.allSettled([authority(left).landCohort(left.request), authority(right).landCohort(right.request)]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(rejected?.status === "rejected" && String(rejected.reason).includes("authority_sqlite_stale_version"));
    const after = store.load(session.realmId)!;
    assert.equal(Object.keys(after.landings).length, 2);
    assert.equal(Object.values(after.changes).filter((change) => change.status === "landed").length, 4);
    assert.equal(Object.values(after.changes).filter((change) => change.status === "submitted").length, 2);
    await reconciler.reconcile();
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("abrupt repair/seal/completion crashes reopen without false completion; lost-response completion replay is a no-op", async () => {
  for (const crashAt of ["after-repair", "after-seal", "completion-row", "after-complete"]) {
    const root = mkdtempSync(join(tmpdir(), "anyam-reconciliation-crash-"));
    const path = join(root, "authority.sqlite");
    let database = new DatabaseSync(path);
    try {
      let store = cohortStore(database);
      const source = realGitSources(root);
      const first = await prepareCohort(store, "first", source, source.revisions[1]!);
      const landing = await new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: first.evaluate }).landCohort(first.request);
      const landingReceipt = structuredClone(store.load(session.realmId)!.idempotency["landing.cohort:cohort:first"]);
      const providerRoot = join(root, "provider-state");
      const inputPath = join(root, "input.json");
      writeFileSync(inputPath, JSON.stringify({ providerRoot, bindings: source.bindings, directories: source.directories }));
      database.close();
      const child = spawnSync(process.execPath, ["--import", "tsx", "test/fixtures/reconciliation-crash.mts", path, inputPath, crashAt], { encoding: "utf8" });
      assert.equal(child.status, crashAt === "completion-row" ? 86 : crashAt === "after-complete" ? 87 : 85, child.stderr);
      database = new DatabaseSync(path);
      store = cohortStore(database);
      const restored = store.load(session.realmId)!;
      assert.equal(restored.canonicalByProject[projectId], landing.projectRevisionId);
      assert.equal(restored.canonicalRefProjections[projectId]!.state, crashAt === "after-complete" ? "complete" : "pending");
      assert.deepEqual(restored.idempotency["landing.cohort:cohort:first"], landingReceipt);
      const provider = new FencedGitProviderFixture(providerRoot, source.directories);
      const reconciler = new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider });
      const completed = await reconciler.reconcile();
      assert.equal(completed.state, "complete");
      const beforeReplay = store.load(session.realmId)!;
      assert.deepEqual(await reconciler.reconcile(), completed);
      assert.deepEqual(store.load(session.realmId), beforeReplay);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
