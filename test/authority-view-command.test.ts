import assert from "node:assert/strict";
import test from "node:test";
import { AuthorityDisclosure } from "../apps/realm-worker/src/authority-disclosure.ts";
import { prepareDisclosedCommand, disclosedCommandResult } from "../apps/realm-worker/src/authority-view-command.ts";
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
