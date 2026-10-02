import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CollaborationCoordinator, type LandingAuthority } from "../src/change-control/collaboration.ts";
import { AuthorityPlaneCoordinator, AUTHORITY_COMMAND_PROTOCOL, emptyAuthorityPlaneSnapshot, type AuthorityCommandName, type AuthorityPlaneSnapshot, type AuthoritySession } from "../src/cloudflare/authority-plane.ts";
import { SQLiteCohortLandingAuthority, canonicalRefProjectionPlan, type CohortLandingReview } from "../src/cloudflare/cohort-landing.ts";
import { LocalGitRepositoryDriver } from "../src/portability/local-git.ts";
import type { RepositoryHandle } from "../src/portability/repository-driver.ts";
import { cohortStore } from "./fixtures/cohort-sqlite.ts";

const session: AuthoritySession = { realmId: "realm:cohort-fixture", principalId: "principal:landing", actorId: "actor:landing", sessionId: "session:landing", clientId: "client:offline-fixture", authorizationEpoch: 1 };
const projectId = "project:cohort-fixture";
const baseId = "project-revision:base";
type Request = Parameters<LandingAuthority["landCohort"]>[0];

function prepared(snapshots = { a: "snapshot:a:base", b: "snapshot:b:base" }, candidates = { a: "snapshot:a:next", b: "snapshot:b:next" }, composedView = false) {
  const control = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  const execute = (name: AuthorityCommandName, key: string, payload: Record<string, unknown>) => control.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: name, idempotencyKey: key, payload }, session);
  execute("project.create", "project", { projectId, name: "Offline cohort fixture", referenceType: "hybrid-public-private", projectRevisionId: baseId, sourceSpaces: [{ id: "source:a", name: "A", classification: "public", snapshotId: snapshots.a }, { id: "source:b", name: "B", classification: "internal", snapshotId: snapshots.b }, { id: "source:excluded", name: "Excluded", classification: "restricted", snapshotId: "snapshot:excluded" }] });
  for (const space of ["a", "b"] as const) {
    execute("workspace.create", `workspace:${space}`, { projectId, workspaceId: `workspace:${space}`, projectRevisionId: baseId, sourceSpaceIds: composedView ? ["source:a", "source:b"] : [`source:${space}`], mounts: composedView ? ["a", "b"] : [space] });
    execute("change.create", `change:${space}`, { projectId, changeId: `change:${space}`, workspaceId: `workspace:${space}`, intentId: `intent:${space}`, baseProjectRevisionId: baseId });
    execute("revision.publish", `revision:${space}`, { projectId, changeId: `change:${space}`, revisionId: `change-revision:${space}`, projectRevisionId: baseId, sourceSpaceSnapshots: { ...(composedView ? { "source:a": snapshots.a, "source:b": snapshots.b } : {}), [`source:${space}`]: candidates[space] }, declaredEffects: [`${space}.modify`] });
    const viewId = control.snapshot().workspaces[`workspace:${space}`]!.projectViewId;
    execute("run.record", `run:${space}`, { projectId, workspaceId: `workspace:${space}`, changeRevisionId: `change-revision:${space}`, projectRevisionId: baseId, projectViewId: viewId, runId: `run:${space}`, actionId: "action:compatibility", runnerId: "runner:synthetic", status: "succeeded", inputDigests: [candidates[space]], outputDigest: `sha256:output:${space}` });
    execute("evidence.record", `evidence:${space}`, { projectId, runId: `run:${space}`, evidenceId: `evidence:${space}`, actionId: "action:compatibility", runnerId: "runner:synthetic", key: "compatibility", criterion: "offline synthetic check", validityKey: `validity:${space}`, verifierId: "verifier:synthetic", toolchainDigest: "sha256:toolchain", dependencyDigest: "sha256:dependencies", environmentDigest: "sha256:environment", inputDigests: [candidates[space]], effectDigests: [`${space}.modify`], outputDigest: `sha256:output:${space}`, policyVersion: "policy:fixture", capabilityGrantId: "grant:fixture", disclosure: { projectionId: viewId, classification: "project" }, receipt: "synthetic=true; liveVerifier=false", invalidators: [], owner: "offline test" });
  }
  const snapshot = control.snapshot();
  const request: Request = { cohortId: "cohort:fixture", members: ["a", "b"].map((space) => ({ changeId: `change:${space}`, changeRevisionId: `change-revision:${space}` })), expectedCanonicalProjectRevisionId: baseId };
  return { snapshot, request };
}

async function gate(snapshot: AuthorityPlaneSnapshot, request: Request) {
  const policy = { version: "policy:fixture", requiredEvidence: [], requiredEvidenceByEffect: Object.fromEntries(["a", "b"].map((space) => [`${space}.modify`, [{ key: "compatibility", currentValidityKey: `validity:${space}`, expectedProjectRevisionId: baseId, expectedProjectViewId: snapshot.workspaces[`workspace:${space}`]!.projectViewId }]])) };
  const reviewer = { principalId: "principal:reviewer", actorId: "actor:reviewer", sessionId: "session:reviewer", clientId: "client:reviewer" };
  const coordinator = new CollaborationCoordinator({ projectId, canonicalRevision: snapshot.projectRevisions[baseId]!, policy, ownershipRules: ["a", "b"].map((space) => ({ id: `ownership:${space}`, scopeKind: "source-space", scopeId: `source:${space}`, requiredReviewerPrincipalIds: [reviewer.principalId], requiredReviewerTeamIds: [], disclosure: "project", label: `Fixture ${space} owner` })), reviewerDirectory: [{ principalId: reviewer.principalId, teamIds: [] }] });
  await coordinator.createCohort({ id: request.cohortId, members: request.members.map((member) => ({ change: snapshot.changes[member.changeId]!, revision: snapshot.changeRevisions[member.changeRevisionId]! })), actor: { principalId: session.principalId, actorId: session.actorId, sessionId: session.sessionId, clientId: session.clientId } });
  for (const requirement of coordinator.listReviewRequirements(request.cohortId)) coordinator.approve({ cohortId: request.cohortId, requirementId: requirement.id, reviewer, evidenceIds: ["evidence:a", "evidence:b"] });
  const evaluate = (fresh: Readonly<AuthorityPlaneSnapshot>): CohortLandingReview => {
    coordinator.setCanonicalProjectRevision(fresh.projectRevisions[fresh.canonicalByProject[projectId]!]!);
    return { explanation: coordinator.evaluateLanding({ cohortId: request.cohortId, evidence: Object.values(fresh.evidence) }), evidenceIds: ["evidence:a", "evidence:b"], approvals: coordinator.listApprovals(request.cohortId) };
  };
  return Object.assign(evaluate, { coordinator, policy });
}

test("durable cohort rejects stale Evidence/members and commits exact members with a historical review packet", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-cohort-"));
  const database = new DatabaseSync(join(root, "authority.sqlite"));
  try {
    const { snapshot, request } = prepared();
    const store = cohortStore(database);
    store.replace(snapshot);
    const evaluate = await gate(snapshot, request);
    const authority = new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate });
    const stale = structuredClone(snapshot);
    stale.evidence["evidence:b"]!.validityKey = "stale";
    store.replace(stale);
    assert.throws(() => authority.landCohort(request), /fresh exact policy decision/);
    assert.deepEqual(store.load(session.realmId), stale);
    const newer = structuredClone(snapshot);
    newer.changes["change:b"]!.latestRevisionId = "change-revision:newer";
    store.replace(newer);
    assert.throws(() => authority.landCohort(request), /latest canonical-base revision/);
    assert.deepEqual(store.load(session.realmId), newer);
    store.replace(snapshot);
    evaluate.coordinator.activatePolicy({ ...evaluate.policy, version: "policy:changed" });
    assert.throws(() => authority.landCohort(request), /fresh exact policy decision/);
    assert.deepEqual(store.load(session.realmId), snapshot, "policy change makes prior exact approvals stale");
    evaluate.coordinator.activatePolicy(evaluate.policy);
    const landing = authority.landCohort(request);
    const after = store.load(session.realmId)!;
    assert.deepEqual(after.projectRevisions[landing.projectRevisionId]!.sourceSpaceSnapshots, { "source:a": "snapshot:a:next", "source:b": "snapshot:b:next", "source:excluded": "snapshot:excluded" });
    assert.deepEqual(after.projectRevisions[landing.projectRevisionId]!.landedChangeRevisionIds, request.members.map((member) => member.changeRevisionId));
    assert.equal(after.changes["change:a"]!.status, "landed");
    assert.equal(after.changes["change:b"]!.status, "landed");
    assert.equal(after.workspaces["workspace:a"]!.state, "closed");
    const packet = after.idempotency[`landing.cohort:${request.cohortId}`]!.result.value.reviewPacket as { explanation: { decision: string }; evidence: { id: string; changeRevisionId: string }[]; approvals: { id: string; changeRevisionId: string; policyVersion: string }[] };
    assert.equal(packet.explanation.decision, "allow");
    assert.deepEqual(packet.evidence.map((record) => [record.id, record.changeRevisionId]), [["evidence:a", "change-revision:a"], ["evidence:b", "change-revision:b"]]);
    assert.equal(packet.approvals.length, 2);
    assert.ok(packet.approvals.every((approval) => approval.id && approval.policyVersion === "policy:fixture"));
    assert.deepEqual(after.audit.at(-1)!.collaboration!.map((event) => [event.projectId, event.cohortId, event.changeRevisionId, event.role, event.policyVersion, event.disclosure]), request.members.map((member) => [projectId, request.cohortId, member.changeRevisionId, "landing", "policy:fixture", "project"]));
    assert.deepEqual(authority.landCohort(request), landing);
    assert.deepEqual(store.load(session.realmId), after);
    assert.throws(() => authority.landCohort({ ...request, members: [request.members[0]!] }), /cohort identity reused/);
    assert.throws(() => authority.landCohort({ ...request, cohortId: "cohort:later", expectedCanonicalProjectRevisionId: landing.projectRevisionId }), /later Landing requires qualified canonical-ref reconciliation/);
    assert.deepEqual(store.load(session.realmId), after, "later Landing cannot bypass the reconciliation boundary");
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("composed Views preserve another member's changed snapshots regardless of selection order", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-cohort-composition-"));
  const database = new DatabaseSync(join(root, "authority.sqlite"));
  try {
    const { snapshot, request } = prepared(undefined, undefined, true);
    const store = cohortStore(database);
    for (const members of [request.members, [...request.members].reverse()]) {
      const selected = { ...request, members };
      store.replace(snapshot);
      const evaluate = await gate(snapshot, selected);
      const landing = new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate }).landCohort(selected);
      assert.deepEqual(store.load(session.realmId)!.projectRevisions[landing.projectRevisionId]!.sourceSpaceSnapshots, { "source:a": "snapshot:a:next", "source:b": "snapshot:b:next", "source:excluded": "snapshot:excluded" });
    }
    const conflict = structuredClone(snapshot);
    conflict.changeRevisions["change-revision:b"]!.sourceSpaceSnapshots = { "source:a": "snapshot:a:conflicting", "source:b": "snapshot:b:next" };
    store.replace(conflict);
    const evaluate = await gate(conflict, request);
    assert.throws(() => new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate }).landCohort(request), /incompatible snapshots/);
    assert.deepEqual(store.load(session.realmId), conflict);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("abrupt process exit inside SQLite cohort selection rolls back on reopen; committed lost-response replay is a no-op", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-cohort-crash-"));
  const path = join(root, "authority.sqlite");
  let database = new DatabaseSync(path);
  try {
    const { snapshot, request } = prepared();
    let store = cohortStore(database);
    store.replace(snapshot);
    const evaluate = await gate(snapshot, request);
    const inputPath = join(root, "input.json");
    writeFileSync(inputPath, JSON.stringify({ projectId, session, request, review: evaluate(snapshot) }));
    database.close();
    for (const point of ["projectRevisions", "canonicalByProject"]) {
      const child = spawnSync(process.execPath, ["--import", "tsx", "test/fixtures/cohort-crash.mts", path, inputPath, point], { encoding: "utf8" });
      assert.equal(child.status, 73, child.stderr);
      database = new DatabaseSync(path);
      store = cohortStore(database);
      assert.deepEqual(store.load(session.realmId), snapshot, `all member/source/audit/idempotency changes rolled back after ${point}`);
      database.close();
    }
    const committedChild = spawnSync(process.execPath, ["--import", "tsx", "test/fixtures/cohort-crash.mts", path, inputPath, "after-commit"], { encoding: "utf8" });
    assert.equal(committedChild.status, 74, committedChild.stderr);
    database = new DatabaseSync(path);
    store = cohortStore(database);
    const committed = store.load(session.realmId)!;
    const replay = new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: () => { throw new Error("historical replay must not authorize new work"); } });
    assert.equal(replay.landCohort(request).projectRevisionId, committed.canonicalByProject[projectId]);
    assert.deepEqual(store.load(session.realmId), committed);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an intervening Landing fences a second cohort transaction before any partial write", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-cohort-race-"));
  const database = new DatabaseSync(join(root, "authority.sqlite"));
  try {
    const { snapshot, request } = prepared();
    const store = cohortStore(database);
    store.replace(snapshot);
    const evaluate = await gate(snapshot, request);
    const winner = new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate });
    const loserRequest = { ...request, cohortId: "cohort:loser" };
    const evaluateLoser = await gate(snapshot, loserRequest);
    const losing = new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: (fresh) => { winner.landCohort(request); return evaluateLoser(fresh); } });
    assert.throws(() => losing.landCohort(loserRequest), /authority_sqlite_stale_version/);
    const after = store.load(session.realmId)!;
    assert.equal(Object.keys(after.landings).length, 1);
    assert.ok(after.idempotency["landing.cohort:cohort:fixture"]);
    assert.equal(after.idempotency["landing.cohort:cohort:loser"], undefined);
    assert.throws(() => winner.landCohort({ ...request, cohortId: "cohort:stale" }), /canonical Project Revision advanced/);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("committed cohort projects to real Git refs after partial repair, with read-back replay and stale per-repository CAS", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-cohort-git-"));
  const database = new DatabaseSync(join(root, "authority.sqlite"));
  try {
    const driver = new LocalGitRepositoryDriver(root);
    const bases = { a: "", b: "" };
    const candidates = { a: "", b: "" };
    const repositories: { space: "a" | "b"; handle: RepositoryHandle; directory: string }[] = [];
    for (const space of ["a", "b"] as const) {
      const directory = join(root, space);
      const created = await driver.createRepository({ sourceSpaceId: `source:${space}`, directory });
      if (created.status !== "succeeded") throw new Error(created.message);
      const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
      writeFileSync(join(directory, "source.txt"), `${space} base\n`);
      git("add", "source.txt");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base");
      bases[space] = git("rev-parse", "HEAD");
      writeFileSync(join(directory, "source.txt"), `${space} candidate\n`);
      git("add", "source.txt");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "candidate");
      candidates[space] = git("rev-parse", "HEAD");
      git("update-ref", "refs/heads/canonical", bases[space]);
      repositories.push({ space, handle: created.value, directory });
    }
    const { snapshot, request } = prepared(bases, candidates);
    for (const repository of repositories) snapshot.sourceSpaces[repository.handle.sourceSpaceId]!.repositoryId = repository.handle.repositoryId;
    const store = cohortStore(database);
    store.replace(snapshot);
    const evaluate = await gate(snapshot, request);
    const landing = new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate }).landCohort(request);
    const observe = async () => Promise.all(repositories.map(async (repository) => {
      const refs = await driver.listRefs({ repository: repository.handle });
      if (refs.status !== "succeeded") throw new Error(refs.message);
      return { sourceSpaceId: repository.handle.sourceSpaceId, repositoryId: repository.handle.repositoryId, ref: "refs/heads/canonical", observedOid: refs.value.find((ref) => ref.name === "refs/heads/canonical")?.oid ?? null };
    }));
    const firstPlan = canonicalRefProjectionPlan({ snapshot: store.load(session.realmId)!, projectId, bindings: await observe() });
    assert.deepEqual(firstPlan.refs.map((ref) => ref.status), ["pending", "pending"]);
    const first = firstPlan.refs[0]!;
    assert.equal((await driver.compareAndSwapRefs({ repository: repositories[0]!.handle, expected: first.expected, desired: first.desired })).status, "succeeded");
    // The repair worker stops after repository A. Canonical selection and both
    // Changes remain committed while repository B visibly lags.
    const reopened = new DatabaseSync(join(root, "authority.sqlite"));
    const restored = cohortStore(reopened).load(session.realmId)!;
    reopened.close();
    const recovery = canonicalRefProjectionPlan({ snapshot: restored, projectId, bindings: await observe() });
    assert.equal(recovery.projectRevisionId, landing.projectRevisionId);
    assert.deepEqual(recovery.refs.map((ref) => ref.status), ["current", "pending"]);
    const second = recovery.refs[1]!;
    assert.equal((await driver.compareAndSwapRefs({ repository: repositories[1]!.handle, expected: second.expected, desired: second.desired })).status, "succeeded");
    const complete = canonicalRefProjectionPlan({ snapshot: store.load(session.realmId)!, projectId, bindings: await observe() });
    assert.deepEqual(complete.refs.map((ref) => ref.status), ["current", "current"]);
    assert.equal((await driver.compareAndSwapRefs({ repository: repositories[0]!.handle, expected: first.expected, desired: { [first.ref]: bases.a } })).status, "failed", "stale worker cannot replace the advanced ref");
    assert.equal(canonicalRefProjectionPlan({ snapshot: restored, projectId, bindings: [{ ...first, observedOid: "f".repeat(40) }] }).refs[0]!.status, "blocked", "unknown external ref needs explicit reconciliation");
    assert.equal(complete.externalWrite, false);
    assert.equal(store.load(session.realmId)!.canonicalByProject[projectId], landing.projectRevisionId);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});
