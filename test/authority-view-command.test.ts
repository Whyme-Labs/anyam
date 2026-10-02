import assert from "node:assert/strict";
import test from "node:test";
import { AuthorityDisclosure } from "../apps/realm-worker/src/authority-disclosure.ts";
import { prepareDisclosedCommand, prepareRawSourceCommand, disclosedCommandResult } from "../apps/realm-worker/src/authority-view-command.ts";
import { AuthorityPlaneCoordinator, AuthorityPlaneError, type AuthoritySession } from "../src/cloudflare/authority-plane.ts";
import { RealmIdentityPolicy } from "../src/identity/realm.ts";
import { disclosureFixture, disclosureClock } from "./fixtures/authority-disclosure-state.ts";

type Fixture = ReturnType<typeof disclosureFixture>;
function context(f: Fixture) {
  const identity = new RealmIdentityPolicy({ realmId: f.state.realmId, relyingPartyId: f.identity.realm.relyingPartyId, now: () => new Date(disclosureClock) }); identity.restoreOperationalSnapshot(f.identity);
  const member = f.members.public!;
  const session: AuthoritySession = { realmId: f.state.realmId, principalId: member.principal.id, actorId: member.session.actorId, clientId: member.session.clientId, sessionId: member.session.id, authorizationEpoch: f.identity.realm.authorizationEpoch, kind: "human" };
  const disclosure = new AuthorityDisclosure(f.state, { capabilities: resource => identity.activeCapabilitiesForPrincipal({ principalId: session.principalId, resource }), sourceReadable: (projectId, sourceSpaceId, capability = "source.read") => identity.canReadSourceSpaceMetadata({ sessionId: session.sessionId, resource: { realmId: f.state.realmId, projectId, sourceSpaceId }, classification: f.state.sourceSpaces[sourceSpaceId]!.classification, capability }) });
  return { identity, session, disclosure };
}
function workspaceRequest(f: Fixture) {
  return { command: "workspace.create", idempotencyKey: "same-visible-intent", payload: { projectId: "project:fixture", projectViewRevisionId: context(f).disclosure.project("project:fixture")!.projectViewRevision.id, sourceSpaceIds: ["source:public"] } };
}
function prepare(f: Fixture, body: Record<string, unknown>) {
  const c = context(f); return prepareDisclosedCommand({ snapshot: f.state, disclosure: c.disclosure, body, session: c.session, actorPrincipal: id => f.identity.actors[id]?.principalId, allocateId: kind => `${kind}:new-visible` });
}
function accept(f: Fixture, body: Record<string, unknown>) {
  const prepared = prepare(f, body); const authority = new AuthorityPlaneCoordinator(f.state); const result = authority.execute(prepared.command, context(f).session);
  f.state = authority.snapshot(); return { prepared, response: disclosedCommandResult(context(f).disclosure, prepared, result) };
}
function error(code: string) { return (value: unknown) => value instanceof AuthorityPlaneError && value.code === code && !/PRIVATE-|canonical:|source:hidden/u.test(value.message + value.receipt); }

test("selector resolution chooses the current exact canonical base internally and emits only its disclosed Workspace", () => {
  const f = disclosureFixture(); const result = accept(f, workspaceRequest(f));
  assert.equal(result.prepared.command.payload.projectRevisionId, "canonical:base"); assert.deepEqual(result.prepared.sourceSpaceIds, ["source:public"]);
  assert.equal(f.state.workspaces["workspace:new-visible"]!.projectRevisionId, "canonical:base");
  assert.doesNotMatch(JSON.stringify(result.response), /PRIVATE-|canonical:|candidate:|source:hidden|projectRevisionId|projectViewId|"version"/u);
});

test("32 hidden-only canonical replacements preserve the public command identity and resulting observation", () => {
  const base = disclosureFixture(); const body = workspaceRequest(base); const expected = accept(structuredClone(base), body);
  for (let n = 0; n < 32; n++) {
    const f = structuredClone(base); const id = `PRIVATE-canonical-${n}`;
    f.state.version += n + 1; f.state.projectRevisions[id] = { ...f.state.projectRevisions["canonical:base"]!, id, sourceSpaceSnapshots: { ...f.state.projectRevisions["canonical:base"]!.sourceSpaceSnapshots, "source:hidden": `PRIVATE-snapshot-${n}` } };
    f.state.canonicalByProject["project:fixture"] = id; f.state.sourceSpaces["source:hidden"]!.name = `PRIVATE-name-${n}`;
    const result = accept(f, body); assert.equal(result.prepared.command.payload.projectRevisionId, id);
    assert.equal(result.prepared.command.idempotencyKey, expected.prepared.command.idempotencyKey); assert.deepEqual(result.response, expected.response);
  }
});

test("fresh Change requires a disclosed Intent and never infers private or missing Intent authority", () => {
  const f = disclosureFixture(); const workspace = accept(f, workspaceRequest(f));
  const body = { command: "change.create", idempotencyKey: "change-intent", payload: { projectId: "project:fixture", workspaceId: "workspace:new-visible", baseProjectViewRevisionId: (workspace.response.value as { workspace: { projectViewRevisionId: string } }).workspace.projectViewRevisionId } };
  assert.throws(() => prepare(f, body), error("invalid_request"));
  for (const intentId of ["intent:PRIVATE-absent", "intent:restricted"]) assert.throws(() => prepare(f, { ...body, payload: { ...body.payload, intentId } }), error("not_found"));
  const prepared = prepare(f, { ...body, payload: { ...body.payload, intentId: "intent:collaboration" } });
  assert.equal(prepared.command.payload.intentId, "intent:collaboration");
});

test("idempotent retry retains the first accepted exact resolution after hidden canonical activity", () => {
  const f = disclosureFixture(); const body = workspaceRequest(f); const first = accept(f, body);
  f.state.projectRevisions["PRIVATE-new-canonical"] = { ...f.state.projectRevisions["canonical:base"]!, id: "PRIVATE-new-canonical", sourceSpaceSnapshots: { ...f.state.projectRevisions["canonical:base"]!.sourceSpaceSnapshots, "source:hidden": "PRIVATE-next" } };
  f.state.canonicalByProject["project:fixture"] = "PRIVATE-new-canonical"; f.state.version += 1;
  const before = structuredClone(f.state); const second = accept(f, body);
  assert.equal(second.prepared.replay, true); assert.equal(second.prepared.command.payload.projectRevisionId, "canonical:base"); assert.deepEqual(second.response, first.response); assert.deepEqual(f.state, before);
});

test("fresh visible changes make the old selector stale without reporting canonical identity, version or scope counts", () => {
  const f = disclosureFixture(); const body = workspaceRequest(f); f.state.projectRevisions["canonical:base"]!.sourceSpaceSnapshots = { ...f.state.projectRevisions["canonical:base"]!.sourceSpaceSnapshots, "source:public": "visible-new" };
  assert.throws(() => prepare(f, body), error("conflict"));
});

test("unknown and inaccessible Source selectors receive the same unavailable projection", () => {
  const f = disclosureFixture(); const body = workspaceRequest(f);
  for (const id of ["source:hidden", "source:absent"]) assert.throws(() => prepare(f, { ...body, payload: { ...body.payload, sourceSpaceIds: [id] } }), error("not_found"));
});

test("canonical selectors, global versions, client creation IDs and prototype operation names are rejected", () => {
  const f = disclosureFixture(); const body = workspaceRequest(f);
  for (const key of ["projectRevisionId", "projectViewId", "workspaceId"]) assert.throws(() => prepare(f, { ...body, payload: { ...body.payload, [key]: "PRIVATE-forged" } }), error("invalid_request"));
  assert.throws(() => prepare(f, { ...body, expectedVersion: f.state.version }), error("invalid_request"));
  for (const command of ["constructor", "toString", "__proto__", "landing.apply"]) assert.throws(() => prepare(f, { ...body, command }), error("invalid_request"));
});

test("revocation gates a previously accepted request and a forged cached actor cannot confer access", () => {
  const f = disclosureFixture(); const body = workspaceRequest(f); const first = accept(f, body);
  const revoked = structuredClone(f); revoked.identity.sourceSpacePolicies["source:public"]!.readerPrincipalIds = [f.members.owner!.principal.id];
  assert.throws(() => prepare(revoked, body), error("not_found"));
  const key = first.prepared.command.idempotencyKey; const fingerprint = JSON.parse(f.state.idempotency[key]!.fingerprint) as typeof first.prepared.command;
  (fingerprint.payload.disclosedCommand as Record<string, unknown>).actorId = f.members.owner!.session.actorId;
  f.state.idempotency[key]!.fingerprint = JSON.stringify(fingerprint); assert.throws(() => prepare(f, body), error("not_found"));
});

test("retained Source commands derive Workspace and Change scope from published records", () => {
  const f = disclosureFixture(); const c = context(f);
  const revision = f.state.changeRevisions["revision:public"]!;
  const run = prepareRawSourceCommand({ snapshot: f.state, command: { protocol: "anyam.authority-command/v1", command: "run.request", idempotencyKey: "raw-derived", payload: { projectId: "project:fixture", changeRevisionId: revision.id, projectRevisionId: revision.projectRevisionId, projectViewId: revision.projectViewId, actionId: "action:test" } }, session: c.session, actorPrincipal: id => f.identity.actors[id]?.principalId, allocateId: kind => `${kind}:derived` });
  assert.deepEqual(run.resource, { realmId: f.state.realmId, projectId: "project:fixture", workspaceId: "workspace:public", changeId: "change:public", runId: "run:derived" });
  const publish = prepareRawSourceCommand({ snapshot: f.state, command: { protocol: "anyam.authority-command/v1", command: "revision.publish", idempotencyKey: "raw-publish", payload: { projectId: "project:fixture", changeId: "change:public", sourceSpaceSnapshots: { "source:public": "b".repeat(40) } } }, session: c.session, actorPrincipal: id => f.identity.actors[id]?.principalId });
  assert.equal(publish.resource.workspaceId, "workspace:public"); assert.equal(publish.resource.changeId, "change:public");
  assert.equal(publish.command.payload.projectViewId, revision.projectViewId);
});

test("retained replay uses first accepted scope before reporting changed input", () => {
  const f = disclosureFixture(); const c = context(f);
  const request = { protocol: "anyam.authority-command/v1" as const, command: "workspace.create" as const, idempotencyKey: "raw-replay", payload: { projectId: "project:fixture", projectRevisionId: "canonical:base", sourceSpaceIds: ["source:public"] } };
  const options = { snapshot: f.state, session: c.session, actorPrincipal: (id: string) => f.identity.actors[id]?.principalId, allocateId: (kind: string) => `${kind}:raw-replay` };
  const prepared = prepareRawSourceCommand({ ...options, command: request });
  const coordinator = new AuthorityPlaneCoordinator(f.state); coordinator.execute(prepared.command, c.session); f.state = coordinator.snapshot();
  const replay = prepareRawSourceCommand({ ...options, snapshot: f.state, command: { ...request, payload: { ...request.payload, sourceSpaceIds: ["source:hidden"] } } });
  assert.equal(replay.replay, true); assert.equal(replay.requestConflict, true); assert.deepEqual(replay.sourceSpaceIds, ["source:public"]);
  assert.equal(replay.resource.workspaceId, "workspace:raw-replay");
});

test("old exact fingerprints with server-generated Workspace, Change and Run IDs retain replay compatibility", () => {
  const f = disclosureFixture(); const c = context(f); const coordinator = new AuthorityPlaneCoordinator(f.state);
  const replay = (command: Parameters<typeof coordinator.execute>[0], kind: "workspace" | "change" | "run") => {
    const accepted = coordinator.execute(command, c.session); f.state = coordinator.snapshot();
    const value = accepted.value as Record<string, { id: string }>;
    const prepared = prepareRawSourceCommand({ snapshot: f.state, command, session: c.session, actorPrincipal: id => f.identity.actors[id]?.principalId });
    assert.equal(prepared.replay, true); assert.equal(prepared.requestConflict, false); assert.deepEqual(prepared.command, command);
    assert.equal(prepared.resource[`${kind}Id`], value[kind]!.id);
    assert.deepEqual(coordinator.execute(prepared.command, c.session), accepted);
    return value[kind]!.id;
  };
  const workspaceId = replay({ protocol: "anyam.authority-command/v1", command: "workspace.create", idempotencyKey: "old-generated-workspace", payload: { projectId: "project:fixture", projectRevisionId: "canonical:base", sourceSpaceIds: ["source:public"] } }, "workspace");
  replay({ protocol: "anyam.authority-command/v1", command: "change.create", idempotencyKey: "old-generated-change", payload: { projectId: "project:fixture", workspaceId, baseProjectRevisionId: "canonical:base", intentId: "intent:collaboration" } }, "change");
  const revision = f.state.changeRevisions["revision:public"]!;
  replay({ protocol: "anyam.authority-command/v1", command: "run.request", idempotencyKey: "old-generated-run", payload: { projectId: "project:fixture", changeRevisionId: revision.id, projectRevisionId: revision.projectRevisionId, projectViewId: revision.projectViewId, actionId: "action:test", policyVersion: f.identity.realm.policyVersion, capabilityGrantId: "grant:synthetic-legacy" } }, "run");
});
