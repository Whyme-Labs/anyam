import assert from "node:assert/strict";
import test from "node:test";
import { AuthorityDisclosure } from "../apps/realm-worker/src/authority-disclosure.ts";
import { AUTHORITY_COMMAND_PROTOCOL, AuthorityPlaneCoordinator } from "../src/cloudflare/authority-plane.ts";
import { RealmIdentityPolicy } from "../src/identity/realm.ts";
import { disclosureClock, disclosureFixture } from "./fixtures/authority-disclosure-state.ts";
import { delegatedSelectorContext } from "../apps/realm-worker/src/delegated-selector-context.ts";

type Fixture = ReturnType<typeof disclosureFixture>;
function read(f: Fixture, member = "public") {
  const identity = new RealmIdentityPolicy({ realmId: f.identity.realm.id, relyingPartyId: f.identity.realm.relyingPartyId, now: () => new Date(disclosureClock) });
  identity.restoreOperationalSnapshot(f.identity);
  const session = f.members[member]!.session;
  return new AuthorityDisclosure(f.state, {
    capabilities: resource => identity.activeCapabilitiesForPrincipal({ principalId: session.principalId, resource }),
    sourceReadable: (projectId, sourceSpaceId, capability = "source.read") => !!f.state.sourceSpaces[sourceSpaceId] && identity.canReadSourceSpaceMetadata({ sessionId: session.id, resource: { realmId: f.state.realmId, projectId, sourceSpaceId }, classification: f.state.sourceSpaces[sourceSpaceId]!.classification, capability }),
  });
}
function observation(d: AuthorityDisclosure) {
  return { projects: d.projects(), summary: d.summary(), workspaces: d.workspaces(), changes: d.changes(), intents: d.intents(), pullRequests: d.pullRequests(), mirrors: d.mirrors(), run: d.run("run:public"), release: d.release("release:public"), target: d.target("target:public"), promotion: d.promotion("promotion:public") };
}
test("selected Revision review recovers exact disclosed snapshots and recorded outcomes without proof metadata", () => {
  const f = disclosureFixture(); const before = structuredClone(f);
  const value = read(f).revisionReview("revision:public");
  assert.ok(value);
  assert.deepEqual(value.projectViewRevision.sourceSpaceSnapshots, { "source:public": "source:public:candidate" });
  assert.equal(value.revision.id, "revision:public");
  assert.equal(value.revision.isLatestForChange, true);
  assert.equal(value.change.id, "change:public");
  assert.deepEqual(value.runs.map(run => ({ id: run.id, status: run.status, evidence: run.evidence })), [
    { id: "run:public", status: "succeeded", evidence: [{ id: "evidence:public", outcome: "passed" }] },
  ]);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE-|canonical:|candidate:public|source:hidden|projectRevisionId|projectViewId|signature|verified|Digest|"version"/u);
  assert.deepEqual(f, before);
});
test("a Run-scoped native delegation cannot borrow that authority for a candidate-level Revision read", () => {
  const f = disclosureFixture();
  const identity = new RealmIdentityPolicy({ realmId: f.identity.realm.id, relyingPartyId: "fixture.local", now: () => new Date(disclosureClock) });
  identity.restoreOperationalSnapshot(f.identity);
  const owner = f.members.owner!.session;
  const resource = { realmId: identity.realm.id, projectId: "project:fixture", runId: "run:public" };
  const task = identity.createTask({ principalId: owner.principalId, actorId: owner.actorId, sessionId: owner.id, purpose: "Synthetic Run-only read" });
  const parent = identity.createCapabilityGrant({ principalId: owner.principalId, actorId: owner.actorId, clientId: owner.clientId, sessionId: owner.id, taskId: task.id, resource, sourceSpaceIds: ["source:public"], actions: ["source.read", "agent.delegate"], effects: [], allowedModelProviders: ["synthetic-local"], allowedCredentialClasses: ["mcp"] });
  identity.registerClient({ id: "client:review", kind: "mcp", allowedAudiences: ["mcp"], allowedOperations: ["source.read"] });
  const agent = identity.registerAgent({ principalId: owner.principalId, clientId: "client:review", name: "Synthetic reviewer", runtime: "synthetic", modelProvider: "synthetic-local", allowedCredentialClasses: ["mcp"] });
  const delegated = identity.delegateAgent({ humanSessionId: owner.id, parentGrantId: parent.id, agentId: agent.id, purpose: "Read only the selected Run", resource, sourceSpaceIds: ["source:public"], actions: ["source.read"], effects: [], allowedCredentialClasses: ["mcp"] });
  const body = { surface: "mcp", sessionId: delegated.session.id, agentId: agent.id, taskId: delegated.task.id, capabilityGrantId: delegated.grant.id, delegatedBySessionId: owner.id, resource, sourceSpaceIds: ["source:public"] };
  assert.ok(delegatedSelectorContext(identity, f.state, body).disclosure.run("run:public"));
  assert.equal(delegatedSelectorContext(identity, f.state, body).disclosure.revisionReview("revision:public"), undefined);
});
test("record-scoped native grants cannot supply broader metadata capabilities", () => {
  const f = disclosureFixture();
  const identity = new RealmIdentityPolicy({ realmId: f.identity.realm.id, relyingPartyId: "fixture.local", now: () => new Date(disclosureClock) });
  identity.restoreOperationalSnapshot(f.identity);
  const owner = f.members.owner!.session;
  identity.registerClient({ id: "client:scoped-metadata", kind: "mcp", allowedAudiences: ["mcp"], allowedOperations: ["source.read"] });
  const agent = identity.registerAgent({ principalId: owner.principalId, clientId: "client:scoped-metadata", name: "Synthetic scoped metadata reader", runtime: "synthetic", modelProvider: "synthetic-local", allowedCredentialClasses: ["mcp"] });
  for (const [coordinate, id] of [["runId", "run:public"], ["pullRequestId", "pr:public"], ["releaseId", "release:public"], ["targetId", "target:public"]] as const) {
    const resource = { realmId: identity.realm.id, projectId: "project:fixture", [coordinate]: id };
    const task = identity.createTask({ principalId: owner.principalId, actorId: owner.actorId, sessionId: owner.id, purpose: "Synthetic selected-record parent task" });
    const parent = identity.createCapabilityGrant({ principalId: owner.principalId, actorId: owner.actorId, clientId: owner.clientId, sessionId: owner.id, taskId: task.id, resource, sourceSpaceIds: ["source:public"], actions: ["source.read", "agent.delegate"], effects: [], allowedModelProviders: ["synthetic-local"], allowedCredentialClasses: ["mcp"] });
    const delegated = identity.delegateAgent({ humanSessionId: owner.id, parentGrantId: parent.id, agentId: agent.id, purpose: "Read only the selected record", resource, sourceSpaceIds: ["source:public"], actions: ["source.read"], effects: [], allowedCredentialClasses: ["mcp"] });
    const body = { surface: "mcp", sessionId: delegated.session.id, agentId: agent.id, taskId: delegated.task.id, capabilityGrantId: delegated.grant.id, delegatedBySessionId: owner.id, resource, sourceSpaceIds: ["source:public"] };
    const d = delegatedSelectorContext(identity, f.state, body).disclosure;
    assert.equal(d.change("change:public"), undefined, coordinate);
    assert.equal(d.workspace("workspace:public"), undefined, coordinate);
    assert.equal(d.intent("intent:collaboration"), undefined, coordinate);
    assert.equal(d.revisionReview("revision:public"), undefined, coordinate);
    assert.equal(d.mirror("mirror:public"), undefined, coordinate);
    assert.deepEqual(d.changes(), [], coordinate);
    if (coordinate === "runId") assert.ok(d.run("run:public"), "the exact authorized Run remains readable");
  }
});
test("Revision review preserves older candidate identity and distinguishes recorded failed or stale outcomes", () => {
  const f = disclosureFixture();
  const original = f.state.changeRevisions["revision:public"]!;
  const base = f.state.projectRevisions["canonical:base"]!;
  f.state.changeRevisions["revision:next"] = { ...original, id: "revision:next", sequence: 2, parentRevisionId: original.id,
    projectRevisionId: "candidate:next", sourceSpaceSnapshots: { "source:public": "source:public:next-candidate" } };
  f.state.projectRevisions["candidate:next"] = { ...base, id: "candidate:next",
    sourceSpaceSnapshots: { ...base.sourceSpaceSnapshots, "source:public": "source:public:next-candidate" } };
  f.state.changes["change:public"]!.latestRevisionId = "revision:next";
  f.state.runs["run:public"]!.status = "failed";
  for (const outcome of ["failed", "stale", "indeterminate"] as const) {
    f.state.evidence["evidence:public"]!.outcome = outcome;
    const older = read(f).revisionReview("revision:public")!;
    assert.equal(older.revision.isLatestForChange, false);
    assert.deepEqual(older.projectViewRevision.sourceSpaceSnapshots, { "source:public": "source:public:candidate" });
    assert.equal(older.runs[0]!.status, "failed");
    assert.equal(older.runs[0]!.evidence[0]!.outcome, outcome);
  }
  const latest = read(f).revisionReview("revision:next")!;
  assert.equal(latest.revision.isLatestForChange, true);
  assert.deepEqual(latest.projectViewRevision.sourceSpaceSnapshots, { "source:public": "source:public:next-candidate" });
  assert.deepEqual(latest.runs, []);
});
test("Revision review omits invisible or inconsistent Runs and Evidence and preserves hidden-state noninterference", () => {
  const f = disclosureFixture(); const expected = read(f).revisionReview("revision:public");
  for (const id of ["revision:hidden", "revision:mixed", "revision:absent"]) assert.equal(read(f).revisionReview(id), undefined);
  const hidden = structuredClone(f);
  hidden.state.version += 99;
  hidden.state.projectRevisions["canonical:base"]!.sourceSpaceSnapshots = {
    ...hidden.state.projectRevisions["canonical:base"]!.sourceSpaceSnapshots, "source:hidden": "PRIVATE-new-hidden-snapshot",
  };
  hidden.state.evidence["evidence:extra-hidden"] = { ...hidden.state.evidence["evidence:public"]!, id: "evidence:extra-hidden",
    disclosure: { ...hidden.state.evidence["evidence:public"]!.disclosure, classification: "restricted" } };
  hidden.state.evidence["evidence:wrong-view"] = { ...hidden.state.evidence["evidence:public"]!, id: "evidence:wrong-view", projectViewId: hidden.state.workspaces["workspace:hidden"]!.projectViewId };
  hidden.state.runs["run:wrong-revision"] = { ...hidden.state.runs["run:public"]!, id: "run:wrong-revision", projectRevisionId: "candidate:hidden" };
  assert.deepEqual(read(hidden).revisionReview("revision:public"), expected);
  const changedClosure = structuredClone(f);
  changedClosure.state.changeRevisions["revision:unreadable-sibling"] = {
    ...changedClosure.state.changeRevisions["revision:hidden"]!, id: "revision:unreadable-sibling", changeId: "change:public", sequence: 2,
  };
  changedClosure.state.changes["change:public"]!.latestRevisionId = "revision:unreadable-sibling";
  assert.equal(read(changedClosure).revisionReview("revision:public"), undefined, "current whole-Change eligibility still applies when a sibling changes its Source closure");
  f.identity.sourceSpacePolicies["source:public"]!.deniedCapabilities = ["source.read"];
  assert.equal(read(f).revisionReview("revision:public"), undefined);
});
test("partial reader retains public Workspace/Change/candidate Run while all private verifier details are withheld", () => {
  const f = disclosureFixture(); const d = read(f); const value = observation(d);
  assert.equal(d.project("project:fixture")?.counts.runs, 1);
  assert.equal(d.project("project:fixture")?.counts.evidence, 1);
  assert.equal(d.project("project:fixture")?.counts.artifacts, 1);
  assert.equal(d.workspaces().length, 1); assert.equal(d.changes().length, 1);
  assert.equal(d.pullRequests().length, 1); assert.equal(d.mirrors().length, 1);
  assert.equal(value.run?.status, "succeeded");
  assert.match(value.run!.projectViewRevisionId, /^project-view-revision:sha256:/u);
  assert.equal(value.release?.status, "ready"); assert.equal(value.promotion?.state, "proposed");
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE-|canonical:|candidate:|source:hidden|run:hidden|run:mixed|author|assignee|updatedAt|createdAt/u);
  const detail = d.intent("intent:collaboration")!;
  assert.equal(detail.comments.length, 1); assert.equal(detail.comments[0]!.body, "Visible comment");
  for (const kind of ["hidden", "mixed"]) {
    assert.equal(d.workspace(`workspace:${kind}`), undefined); assert.equal(d.change(`change:${kind}`), undefined);
    assert.equal(d.run(`run:${kind}`), undefined); assert.equal(d.pullRequest(`pr:${kind}`), undefined);
    assert.equal(d.release(`release:${kind}`), undefined); assert.equal(d.promotion(`promotion:${kind}`), undefined);
  }
});
test("private Source readers retain wholly readable private/mixed execution status without verifier input authority", () => {
  const d = read(disclosureFixture(), "private");
  assert.equal(d.workspaces().length, 3); assert.equal(d.changes().length, 3);
  assert.equal(d.run("run:hidden")?.status, "succeeded"); assert.equal(d.run("run:mixed")?.status, "succeeded");
  assert.equal(d.evidence("evidence:hidden")?.outcome, "passed"); assert.ok(d.release("release:mixed"));
  assert.equal(d.intent("intent:restricted"), undefined);
  assert.doesNotMatch(JSON.stringify(d.run("run:hidden")), /PRIVATE-|runnerId|verifierId|Digest|attemptId/u);
});
test("bounded noninterference: hidden-only additions and changes cannot alter ordinary readable observations", () => {
  const f = disclosureFixture(); const expected = observation(read(f));
  for (let n = 0; n < 32; n++) {
    const altered = structuredClone(f);
    altered.state.version += n + 1;
    altered.state.sourceSpaces["source:hidden"]!.name = `PRIVATE-changed-${n}`;
    altered.state.projectRevisions["canonical:base"]!.sourceSpaceSnapshots = { ...altered.state.projectRevisions["canonical:base"]!.sourceSpaceSnapshots, "source:hidden": `PRIVATE-changed-snapshot-${n}` };
    altered.state.intents["intent:collaboration"]!.updatedAt = `2099-${n}`;
    altered.state.intentComments["comment:hidden"]!.body = `PRIVATE-comment-${n}`;
    altered.state.runs[`PRIVATE-extra-run-${n}`] = { ...altered.state.runs["run:hidden"]!, id: `PRIVATE-extra-run-${n}` };
    altered.state.evidence[`PRIVATE-extra-evidence-${n}`] = { ...altered.state.evidence["evidence:hidden"]!, id: `PRIVATE-extra-evidence-${n}` };
    altered.state.pullRequests[`PRIVATE-extra-pr-${n}`] = { ...altered.state.pullRequests["pr:hidden"]!, id: `PRIVATE-extra-pr-${n}` };
    altered.state.promotions[`PRIVATE-extra-promotion-${n}`] = { ...altered.state.promotions["promotion:hidden"]!, id: `PRIVATE-extra-promotion-${n}` };
    assert.deepEqual(observation(read(altered)), expected, `hidden variation ${n}`);
  }
});
test("first hidden Source addition preserves disclosed identities and response shape", () => {
  const hybrid = disclosureFixture(); const publicOnly = structuredClone(hybrid);
  publicOnly.state.projects["project:fixture"]!.sourceSpaceIds = ["source:public"];
  delete publicOnly.state.sourceSpaces["source:hidden"];
  assert.deepEqual(observation(read(publicOnly)), observation(read(hybrid)));
});
test("current reader revocation, Source deny, missing/stale policy and relationship deny remove future access", () => {
  for (const mode of ["readers", "source-deny", "missing", "stale", "relationship-deny"] as const) {
    const f = disclosureFixture(); const p = f.identity.sourceSpacePolicies["source:public"]!;
    if (mode === "readers") p.readerPrincipalIds = [f.members.owner!.principal.id];
    if (mode === "source-deny") p.deniedCapabilities = ["source.read"];
    if (mode === "missing") delete f.identity.sourceSpacePolicies["source:public"];
    if (mode === "stale") p.policyVersion = "stale-policy";
    if (mode === "relationship-deny") Object.values(f.identity.relationships).find(r => r.principalId === f.members.public!.principal.id)!.deniedCapabilities = ["source.read"];
    const d = read(f); assert.equal(d.workspace("workspace:public"), undefined, mode);
    assert.equal(d.run("run:public"), undefined, mode); assert.equal(d.project("project:fixture")?.counts.runs, 0, mode);
    assert.equal(d.release("release:public"), undefined, mode);
  }
});
test("record-level Change, Run, PR and Intent denies remain effective", () => {
  const f = disclosureFixture();
  for (const [extra, denied] of [[{ changeId: "change:public" }, "evidence.read"], [{ runId: "run:public" }, "evidence.read"], [{ pullRequestId: "pr:public" }, "pullRequest.inspect"]] as const) {
    const identity = new RealmIdentityPolicy({ realmId: f.identity.realm.id, relyingPartyId: f.identity.realm.relyingPartyId, now: () => new Date(disclosureClock) });
    identity.restoreOperationalSnapshot(f.identity);
    identity.addRelationship({ principalId: f.members.public!.principal.id, subjectId: "denied", kind: "organization-member", role: "viewer", resource: { realmId: f.state.realmId, projectId: "project:fixture", ...extra }, deniedCapabilities: [denied] });
    const altered = { ...f, identity: identity.getRecoverySnapshot() }; const d = read(altered);
    if (denied === "evidence.read") { assert.equal(d.run("run:public"), undefined); assert.equal(d.evidence("evidence:public"), undefined); }
    else assert.equal(d.pullRequest("pr:public"), undefined);
  }
  const altered = structuredClone(f); Object.values(altered.identity.relationships).find(r => r.principalId === altered.members.public!.principal.id)!.deniedCapabilities = ["intent.inspect"];
  assert.equal(read(altered).intent("intent:collaboration"), undefined);
});
test("malformed or wrong-Project immutable bindings fail closed", () => {
  for (const mode of ["view-snapshot", "mount", "revision-parent", "revision-workspace", "run-revision", "evidence-projection", "artifact-projection", "pr-revision"] as const) {
    const f = disclosureFixture(); const w = f.state.workspaces["workspace:public"]!;
    if (mode === "view-snapshot") f.state.projectViews[w.projectViewId]!.disclosedSourceSpaceSnapshots = { "source:public": "stale" };
    if (mode === "mount") w.mounts = [{ ...w.mounts[0]!, snapshotId: "stale" }];
    if (mode === "revision-parent") f.state.changeRevisions["revision:public"]!.parentRevisionId = "revision:hidden";
    if (mode === "revision-workspace") f.state.changeRevisions["revision:public"]!.workspaceId = "workspace:hidden";
    if (mode === "run-revision") f.state.runs["run:public"]!.projectRevisionId = "candidate:hidden";
    if (mode === "evidence-projection") f.state.evidence["evidence:public"]!.disclosure.projectionId = "unknown";
    if (mode === "artifact-projection") f.state.artifacts["artifact:public"]!.disclosure!.projectionId = "unknown";
    if (mode === "pr-revision") f.state.pullRequests["pr:public"]!.revisionIds = ["revision:hidden"];
    const d = read(f);
    if (mode === "evidence-projection") assert.equal(d.evidence("evidence:public"), undefined);
    else if (mode === "artifact-projection") assert.equal(d.artifact("artifact:public"), undefined);
    else if (mode === "pr-revision") assert.equal(d.pullRequest("pr:public"), undefined);
    else assert.equal(d.run("run:public"), undefined, mode);
  }
});
test("unrelated Principals have no discoverable Project or child records; owner full snapshot gate requires all current Sources", () => {
  const f = disclosureFixture(); const unrelated = read(f, "unrelated"); assert.deepEqual(unrelated.projects(), []); assert.equal(unrelated.run("run:public"), undefined);
  assert.equal(read(f, "owner").completeRealm(), true); assert.equal(read(f).completeRealm(), false);
  f.identity.sourceSpacePolicies["source:hidden"]!.readerPrincipalIds = [];
  f.identity.sourceSpacePolicies["source:hidden"]!.discoverable = false;
  assert.equal(read(f, "owner").completeRealm(), false);
});
test("Source read denies scoped to a Workspace, Change, Run or PR narrow the matching projection", () => {
  for (const extra of [{ workspaceId: "workspace:public" }, { changeId: "change:public" }, { runId: "run:public" }, { pullRequestId: "pr:public" }]) {
    const f = disclosureFixture(); const identity = new RealmIdentityPolicy({ realmId: f.state.realmId, relyingPartyId: f.identity.realm.relyingPartyId, now: () => new Date(disclosureClock) });
    identity.restoreOperationalSnapshot(f.identity);
    identity.addRelationship({ principalId: f.members.public!.principal.id, subjectId: "denied-source", kind: "organization-member", role: "viewer", resource: { realmId: f.state.realmId, projectId: "project:fixture", sourceSpaceId: "source:public", ...extra }, deniedCapabilities: ["source.read"] });
    const d = read({ ...f, identity: identity.getRecoverySnapshot() });
    if ("pullRequestId" in extra) assert.equal(d.pullRequest("pr:public"), undefined);
    else assert.equal(d.run("run:public"), undefined);
  }
});
test("disclosure projection labels are resolved against the exact producing View", () => {
  const f = disclosureFixture(); const w = f.state.workspaces["workspace:public"]!;
  assert.ok(read(f).evidence("evidence:public")); assert.ok(read(f).artifact("artifact:public"));
  const view = f.state.projectViews[w.projectViewId]!;
  f.state.projectViews["ambiguous-view"] = { ...view, id: "ambiguous-view" };
  assert.ok(read(f).evidence("evidence:public")); assert.ok(read(f).artifact("artifact:public"));
});
test("Release migration, Change and Target operational history require readable consistent lineage", () => {
  const f = disclosureFixture();
  f.state.releases["release:public"]!.changeRevisionId = "revision:hidden";
  assert.equal(read(f).release("release:public"), undefined);
  const migration = disclosureFixture(); migration.state.releases["release:public"]!.migrationPlan = { protocol: "anyam.migration/v1", strategy: "manual", compatibility: "unknown", rollback: "blocked", migrationArtifactIds: ["artifact:hidden"], requiredEvidenceKeys: [], planDigest: "PRIVATE-migration-marker" };
  assert.equal(read(migration).release("release:public"), undefined);
  const history = disclosureFixture(); history.state.targets["target:public"]!.lastPromotionId = "promotion:hidden";
  assert.equal(read(history).target("target:public"), undefined);
  const legacy = disclosureFixture(); legacy.state.targets["target:public"]!.currentReleaseId = null; legacy.state.targets["target:public"]!.releaseHistory = [];
  assert.ok(read(legacy).target("target:public"), "legacy Target inspection does not require a profile");
});
test("Workspace structural/Source failures gate its Changes, including Changes with no Revision", () => {
  const malformed = disclosureFixture(); malformed.state.workspaces["workspace:public"]!.mounts = [{ sourceSpaceId: "source:hidden", snapshotId: "PRIVATE-hidden", mountPath: "hidden" }];
  assert.equal(read(malformed).workspace("workspace:public"), undefined); assert.equal(read(malformed).change("change:public"), undefined);
  const f = disclosureFixture(); delete f.state.changeRevisions["revision:public"]; f.state.changes["change:public"]!.latestRevisionId = null;
  const identity = new RealmIdentityPolicy({ realmId: f.state.realmId, relyingPartyId: f.identity.realm.relyingPartyId, now: () => new Date(disclosureClock) });
  identity.restoreOperationalSnapshot(f.identity); identity.addRelationship({ principalId: f.members.public!.principal.id, subjectId: "denied", kind: "organization-member", role: "viewer", resource: { realmId: f.state.realmId, projectId: "project:fixture", workspaceId: "workspace:public" }, deniedCapabilities: ["source.read"] });
  assert.equal(read({ ...f, identity: identity.getRecoverySnapshot() }).change("change:public"), undefined);
});
test("Source denials on contributing Release or Target scope gate status and counts", () => {
  for (const extra of [{ releaseId: "release:public" }, { targetId: "target:public" }]) {
    const f = disclosureFixture(); const identity = new RealmIdentityPolicy({ realmId: f.state.realmId, relyingPartyId: f.identity.realm.relyingPartyId, now: () => new Date(disclosureClock) });
    identity.restoreOperationalSnapshot(f.identity); identity.addRelationship({ principalId: f.members.public!.principal.id, subjectId: "denied", kind: "organization-member", role: "viewer", resource: { realmId: f.state.realmId, projectId: "project:fixture", ...extra }, deniedCapabilities: ["source.read"] });
    const d = read({ ...f, identity: identity.getRecoverySnapshot() });
    if ("releaseId" in extra) assert.equal(d.release("release:public"), undefined);
    assert.equal(d.target("target:public"), undefined); assert.equal(d.promotion("promotion:public"), undefined);
  }
});
test("bounded policy refinement: every metadata allow is a current kernel Source allow; explicit deny is monotonic across 256 states", () => {
  const f = disclosureFixture(); const seed = new RealmIdentityPolicy({ realmId: f.state.realmId, relyingPartyId: f.identity.realm.relyingPartyId, now: () => new Date(disclosureClock) });
  seed.restoreOperationalSnapshot(f.identity);
  const member = f.members.public!; const resource = { realmId: f.state.realmId, projectId: "project:fixture", sourceSpaceId: "source:public" };
  const grant = seed.createOwnerTaskGrant({ sessionId: member.session.id, purpose: "Synthetic bounded policy refinement", resource, sourceSpaceIds: ["source:public"], actions: ["source.read"], effects: ["source.read"] });
  const baseline = seed.getRecoverySnapshot(); let allows = 0;
  for (let mask = 0; mask < 256; mask++) {
    const state = structuredClone(baseline); const policy = state.sourceSpacePolicies["source:public"]!;
    policy.allowedCapabilities = mask & 1 ? ["source.read"] : [];
    policy.deniedCapabilities = mask & 2 ? ["source.read"] : [];
    policy.policyVersion = mask & 4 ? state.realm.policyVersion : "stale";
    policy.readerPrincipalIds = mask & 16 ? [] : mask & 8 ? [member.principal.id] : ["unrelated"];
    policy.discoverable = !!(mask & 32);
    const relationship = Object.values(state.relationships).find(r => r.principalId === member.principal.id)!;
    relationship.status = mask & 64 ? "active" : "revoked";
    relationship.deniedCapabilities = mask & 128 ? ["source.read"] : [];
    const identity = new RealmIdentityPolicy({ realmId: f.state.realmId, relyingPartyId: f.identity.realm.relyingPartyId, now: () => new Date(disclosureClock) }); identity.restoreOperationalSnapshot(state);
    const observation = identity.canReadSourceSpaceMetadata({ sessionId: member.session.id, resource, classification: "public" });
    const decision = identity.evaluate({ operation: "source.read", principalId: member.principal.id, actorId: member.session.actorId, clientId: member.session.clientId, sessionId: member.session.id, taskId: grant.task.id, grantId: grant.grant.id, resource, sourceSpaceId: "source:public", protected: true });
    if (observation) { allows++; assert.equal(decision.allowed, true, `observer must refine kernel authority at state ${mask}`); }
    policy.deniedCapabilities = ["source.read"]; identity.restoreOperationalSnapshot(state);
    assert.equal(identity.canReadSourceSpaceMetadata({ sessionId: member.session.id, resource, classification: "public" }), false, `deny monotonicity ${mask}`);
  }
  assert.ok(allows > 0, "bounded proof includes positive authority states");
});
test("optional Release Change binding remains optional; malformed Revision snapshots return no projection", () => {
  const f = disclosureFixture(); delete f.state.releases["release:public"]!.changeRevisionId;
  assert.ok(read(f).release("release:public"));
  Reflect.set(f.state.changeRevisions["revision:public"]!, "sourceSpaceSnapshots", { "source:public": 7 });
  assert.equal(read(f).change("change:public"), undefined);
});
test("empty Changes cannot reflect a foreign latest Revision; conflicting candidate manifests deny Run access", () => {
  const f = disclosureFixture(); delete f.state.changeRevisions["revision:public"]; f.state.changes["change:public"]!.latestRevisionId = "revision:hidden";
  assert.equal(read(f).change("change:public"), undefined);
  const candidate = disclosureFixture(); candidate.state.projectRevisions["candidate:public"] = { ...candidate.state.projectRevisions["canonical:base"]!, id: "candidate:public", projectId: "project:other" };
  assert.equal(read(candidate).run("run:public"), undefined);
  assert.equal(read(candidate).change("change:public"), undefined);
  candidate.state.projectRevisions["candidate:public"]!.projectId = "project:fixture";
  assert.equal(read(candidate).run("run:public"), undefined, "conflicting immutable snapshots");
  candidate.state.projectRevisions["candidate:public"]!.sourceSpaceSnapshots = { "source:public": "source:public:candidate" };
  assert.ok(read(candidate).run("run:public"), "matching authoritative candidate remains readable");
});
test("an accepted hidden-only Workspace reusing a public projection label cannot alter visible provenance or counts", () => {
  const f = disclosureFixture(); const expected = observation(read(f)); const authority = new AuthorityPlaneCoordinator(f.state);
  const owner = f.members.owner!; const view = f.state.projectViews[f.state.workspaces["workspace:public"]!.projectViewId]!;
  const result = authority.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "workspace.create", idempotencyKey: "hidden-projection-label-reuse", payload: { projectId: "project:fixture", workspaceId: "workspace:hidden-label-collision", projectRevisionId: "canonical:base", sourceSpaceIds: ["source:hidden"], projectionId: view.projectionId } }, { realmId: f.state.realmId, principalId: owner.principal.id, actorId: owner.session.actorId, sessionId: owner.session.id, clientId: owner.session.clientId, authorizationEpoch: f.identity.realm.authorizationEpoch, kind: "human" });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(observation(read({ ...f, state: authority.snapshot() })), expected);
});
test("accepted PRs with no revisionIds or Source selector still honor PR-scoped Source denials", () => {
  for (const sourceSpaceId of [undefined, "source:public"]) {
    const f = disclosureFixture(); const authority = new AuthorityPlaneCoordinator(f.state); const owner = f.members.owner!;
    const result = authority.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "pullRequest.open", idempotencyKey: "empty-pr", payload: { projectId: "project:fixture", pullRequestId: "pr:empty", changeId: "change:public", provider: "local", headRef: "refs/heads/public", baseRef: "refs/heads/main", headCommit: "a".repeat(40), baseCommit: "b".repeat(40), title: "Visible empty PR", disclosure: "public", ...(sourceSpaceId ? { sourceSpaceId } : {}) } }, { realmId: f.state.realmId, principalId: owner.principal.id, actorId: owner.session.actorId, sessionId: owner.session.id, clientId: owner.session.clientId, authorizationEpoch: f.identity.realm.authorizationEpoch, kind: "human" });
    assert.equal(result.status, "succeeded"); f.state = authority.snapshot(); assert.ok(read(f).pullRequest("pr:empty"));
    const identity = new RealmIdentityPolicy({ realmId: f.state.realmId, relyingPartyId: f.identity.realm.relyingPartyId, now: () => new Date(disclosureClock) }); identity.restoreOperationalSnapshot(f.identity);
    identity.addRelationship({ principalId: f.members.public!.principal.id, subjectId: "denied-empty-pr", kind: "organization-member", role: "viewer", resource: { realmId: f.state.realmId, projectId: "project:fixture", sourceSpaceId: "source:public", pullRequestId: "pr:empty" }, deniedCapabilities: ["source.read"] });
    const d = read({ ...f, identity: identity.getRecoverySnapshot() });
    assert.equal(d.pullRequest("pr:empty"), undefined); assert.equal(d.project("project:fixture")?.counts.pullRequests, 1);
    assert.ok(d.change("change:public"), "PR deny does not revoke independent Change scope");
  }
});
test("typed read denials are checked at every contributing Source with the complete resource binding", () => {
  const cases = [
    ["workspace.inspect", { sourceSpaceId: "source:public", workspaceId: "workspace:public" }, "workspace"],
    ["change.inspect", { sourceSpaceId: "source:public", changeId: "change:public" }, "change"],
    ["evidence.read", { sourceSpaceId: "source:public", runId: "run:public" }, "run"],
    ["pullRequest.inspect", { workspaceId: "workspace:public", pullRequestId: "pr:public" }, "pr"],
    ["pullRequest.inspect", { sourceSpaceId: "source:public", pullRequestId: "pr:public" }, "pr"],
    ["target.read", { sourceSpaceId: "source:public", releaseId: "release:public" }, "release"],
    ["target.read", { sourceSpaceId: "source:public", targetId: "target:public" }, "target"],
  ] as const;
  for (const [capability, extra, kind] of cases) {
    const f = disclosureFixture(); const identity = new RealmIdentityPolicy({ realmId: f.state.realmId, relyingPartyId: f.identity.realm.relyingPartyId, now: () => new Date(disclosureClock) }); identity.restoreOperationalSnapshot(f.identity);
    identity.addRelationship({ principalId: f.members.public!.principal.id, subjectId: "typed-read-denial", kind: "organization-member", role: "viewer", resource: { realmId: f.state.realmId, projectId: "project:fixture", ...extra }, deniedCapabilities: [capability] });
    const d = read({ ...f, identity: identity.getRecoverySnapshot() });
    const value = kind === "workspace" ? d.workspace("workspace:public") : kind === "change" ? d.change("change:public") : kind === "run" ? d.run("run:public") : kind === "pr" ? d.pullRequest("pr:public") : kind === "release" ? d.release("release:public") : d.target("target:public");
    assert.equal(value, undefined, `${capability} ${JSON.stringify(extra)}`);
  }
});
test("inconsistent base manifest identity invalidates every contributing read", () => {
  const f = disclosureFixture(); f.state.projectRevisions["canonical:base"]!.id = "PRIVATE-inconsistent-manifest"; const d = read(f);
  assert.equal(d.workspace("workspace:public"), undefined); assert.equal(d.change("change:public"), undefined);
  assert.equal(d.run("run:public"), undefined); assert.equal(d.evidence("evidence:public"), undefined);
  assert.equal(d.artifact("artifact:public"), undefined); assert.equal(d.release("release:public"), undefined);
});
test("Source policy typed metadata denies are effective without revoking Source.read", () => {
  const f = disclosureFixture(); f.identity.sourceSpacePolicies["source:public"]!.deniedCapabilities = ["workspace.inspect", "pullRequest.inspect", "target.read"];
  const d = read(f); assert.equal(d.workspace("workspace:public"), undefined); assert.equal(d.pullRequest("pr:public"), undefined); assert.equal(d.release("release:public"), undefined);
  assert.ok(d.run("run:public"), "independent Evidence read remains allowed");
});
