import { AnyamRealmCoordinator } from "../../apps/realm-worker/src/index.ts";
import { handleAuthorityRequest } from "../../apps/realm-worker/src/authority-edge.ts";
import { handleAnyamRealmMcpRequest } from "../../apps/realm-worker/src/mcp-handler.ts";
import type { AnyamRealmOAuthEnv } from "../../apps/realm-worker/src/oauth-provider.ts";
import { AuthoritySQLiteStore, type AuthoritySqlHost } from "../../src/cloudflare/authority-sqlite.ts";
import { emptyAuthorityPlaneSnapshot, normalizeAuthorityPlaneSnapshot, type AuthorityPlaneSnapshot } from "../../src/cloudflare/authority-plane.ts";
import { RealmIdentityPolicy } from "../../src/identity/realm.ts";
import { disclosureClock, type disclosureFixture } from "./authority-disclosure-state.ts";

type Fixture = ReturnType<typeof disclosureFixture>;
/** Owned localhost fixture only. Seed/revoke RPCs are absent from production.
 * Production Coordinator reads and SQLite execute unchanged. The clock and
 * host-cookie/OAuth context are synthetic; no auth ceremony is qualified. */
export class LocalDisclosureRealm extends AnyamRealmCoordinator {
  async seed(fixture: Fixture) {
    const initialized: unknown = Reflect.get(this, "initialized");
    if (!(initialized instanceof Promise)) throw new Error("missing actual Coordinator initialization");
    await initialized;
    const identity = new RealmIdentityPolicy({ realmId: fixture.identity.realm.id, relyingPartyId: fixture.identity.realm.relyingPartyId, now: () => new Date(disclosureClock) });
    identity.restoreOperationalSnapshot(fixture.identity);
    Reflect.set(this, "identity", identity);
    const store = new AuthoritySQLiteStore(this.ctx.storage as unknown as AuthoritySqlHost, { empty: emptyAuthorityPlaneSnapshot, normalize: normalizeAuthorityPlaneSnapshot });
    store.replace(fixture.state);
    await this.ctx.storage.put("fixture-members", fixture.members);
    return { seeded: true };
  }
  async replaceAuthority(state: AuthorityPlaneSnapshot) {
    const store = new AuthoritySQLiteStore(this.ctx.storage as unknown as AuthoritySqlHost, { empty: emptyAuthorityPlaneSnapshot, normalize: normalizeAuthorityPlaneSnapshot });
    store.replace(state);
    return { replaced: true };
  }
  async removeAuthorityMeta(legacy: AuthorityPlaneSnapshot) {
    this.ctx.storage.sql.exec("DELETE FROM anyam_authority_meta");
    await this.ctx.storage.put("anyam/realm-authority/snapshot/v1", legacy);
    return { metaRemoved: true };
  }
  async pauseLegacyDigestOnce() {
    await this.ctx.storage.put("anyam/realm-authority/recovery-status/v1", "active");
    const control: unknown = Reflect.get(this.env, "FIXTURE_RECOVERY_CONTROL");
    if (!control || typeof Reflect.get(control, "fetch") !== "function") throw new Error("missing owned recovery barrier");
    const originalGate = this.ctx.blockConcurrencyWhile;
    let gateActive = false;
    Reflect.set(this.ctx, "blockConcurrencyWhile", <T>(callback: () => Promise<T>) => originalGate.call(this.ctx, async () => {
      gateActive = true;
      try { return await callback(); } finally { gateActive = false; }
    }));
    const originalDigest = crypto.subtle.digest;
    Reflect.set(crypto.subtle, "digest", async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const text = new TextDecoder().decode(data);
      // The original legacy signature has no additive maps. Pause only the
      // normalized-state SHA, after real signature verification has completed.
      if (text.startsWith("{") && text.includes('"protocol":"anyam.authority-plane/v1"') && text.includes('"projection:retained"') && !text.includes('"bundleDigest"')) {
        Reflect.set(crypto.subtle, "digest", originalDigest);
        try {
          await (control as Fetcher).fetch(`http://fixture-control/legacy-digest?gateActive=${gateActive}`);
        } finally { Reflect.set(this.ctx, "blockConcurrencyWhile", originalGate); }
      }
      return originalDigest.call(crypto.subtle, algorithm, data);
    });
    return { digestPauseArmed: true };
  }
  async members() { return await this.ctx.storage.get<Fixture["members"]>("fixture-members"); }
  async checkpoint() {
    const identity: unknown = Reflect.get(this, "identity");
    if (!(identity instanceof RealmIdentityPolicy)) throw new Error("missing current identity");
    const store = new AuthoritySQLiteStore(this.ctx.storage as unknown as AuthoritySqlHost, { empty: emptyAuthorityPlaneSnapshot, normalize: normalizeAuthorityPlaneSnapshot });
    const sqlRows = Object.fromEntries(["meta", "entities", "audit_events", "idempotency", "migrations"].map(name => [name, this.ctx.storage.sql.exec(`SELECT * FROM anyam_authority_${name} ORDER BY 1, 2`).toArray()]));
    return { identity: identity.getRecoverySnapshot(), operationalCredentialRecords: identity.snapshot().credentials, authority: store.readExisting(identity.realm.id), keys: Object.fromEntries(await this.ctx.storage.list()), sqlRows };
  }
  async issueSyntheticCredential() {
    const identity: unknown = Reflect.get(this, "identity");
    if (!(identity instanceof RealmIdentityPolicy)) throw new Error("missing current identity");
    const member = (await this.members())!.owner!; const session = member.session;
    const resource = { realmId: identity.realm.id, projectId: "project:fixture", sourceSpaceId: "source:public" };
    const task = identity.createTask({ principalId: session.principalId, actorId: session.actorId, sessionId: session.id, purpose: "synthetic unrelated credential regression" });
    const grant = identity.createCapabilityGrant({ principalId: session.principalId, actorId: session.actorId, clientId: session.clientId, sessionId: session.id, taskId: task.id, resource, sourceSpaceIds: ["source:public"], actions: ["source.read"], effects: [], allowedCredentialClasses: ["realm-api"] });
    return identity.issueCredential({ class: "realm-api", principalId: session.principalId, actorId: session.actorId, clientId: session.clientId, sessionId: session.id, taskId: task.id, grantId: grant.id, resource });
  }
  async validateSyntheticCredential(token: string) {
    const identity: unknown = Reflect.get(this, "identity");
    if (!(identity instanceof RealmIdentityPolicy)) throw new Error("missing current identity");
    return { valid: identity.validateCredential(token, { class: "realm-api" }).valid };
  }
  async failIdentityWriteOnce() {
    const original: unknown = Reflect.get(this, "persistIdentity");
    if (typeof original !== "function") throw new Error("missing actual identity persistence");
    Reflect.set(this, "persistIdentity", async () => {
      Reflect.set(this, "persistIdentity", original);
      await original.call(this);
      throw new Error("synthetic failure after actual SQL and identity KV writes");
    });
    return { faultArmed: true };
  }
  async revoke(sessionId: string) {
    const identity: unknown = Reflect.get(this, "identity");
    if (!(identity instanceof RealmIdentityPolicy)) throw new Error("missing current identity");
    identity.revokeSession(sessionId);
    return { revoked: true };
  }
}
export default { async fetch(request: Request, bindings: { REALM_COORDINATOR: DurableObjectNamespace<LocalDisclosureRealm>; FIXTURE_RECOVERY_CONTROL?: Fetcher }) {
  const url = new URL(request.url);
  const realm = bindings.REALM_COORDINATOR.get(bindings.REALM_COORDINATOR.idFromName("realm:disclosure-local"));
  if (url.pathname === "/fixture/seed") return Response.json(await realm.seed(await request.json() as Fixture));
  if (url.pathname === "/fixture/replace-authority") return Response.json(await realm.replaceAuthority(await request.json() as AuthorityPlaneSnapshot));
  if (url.pathname === "/fixture/remove-authority-meta") return Response.json(await realm.removeAuthorityMeta(await request.json() as AuthorityPlaneSnapshot));
  if (url.pathname === "/fixture/pause-legacy-digest-once") return Response.json(await realm.pauseLegacyDigestOnce());
  if (url.pathname === "/fixture/competing-authority-command") {
    const forwarded = new Request("http://localhost/authority/command/internal", request);
    const pending = realm.fetch(forwarded);
    await bindings.FIXTURE_RECOVERY_CONTROL!.fetch("http://fixture-control/competing-dispatched");
    return pending;
  }
  if (url.pathname === "/fixture/revoke") return Response.json(await realm.revoke((await request.json() as { sessionId: string }).sessionId));
  if (url.pathname === "/fixture/checkpoint") return Response.json(await realm.checkpoint());
  if (url.pathname === "/fixture/fail-identity-write-once") return Response.json(await realm.failIdentityWriteOnce());
  if (url.pathname === "/fixture/issue-synthetic-credential") return Response.json(await realm.issueSyntheticCredential());
  if (url.pathname === "/fixture/validate-synthetic-credential") return Response.json(await realm.validateSyntheticCredential((await request.json() as { token: string }).token));
  if (url.pathname.startsWith("/authority/")) return realm.fetch(request);
  const cookieMember = request.headers.get("cookie")?.match(/(?:^|;\s*)anyam_owner_session=synthetic-([A-Za-z]+)(?:;|$)/u)?.[1];
  const name = request.headers.get("x-fixture-member") ?? cookieMember ?? "public";
  const member = (await realm.members())?.[name];
  if (!member) return Response.json({ code: "fixture-member-missing" }, { status: 401 });
  const env = { ANYAM_HOSTING_MODE: "customer-operated", ANYAM_INSTALLATION_ID: "disclosure-local", ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1", ANYAM_REALM_RP_ID: "fixture.local", REALM_COORDINATOR: bindings.REALM_COORDINATOR,
    OAUTH_KV: { async get(key: string) {
      if (key !== `anyam:passkey:session:synthetic-${name}`) return null;
      return { protocol: "anyam.passkey-owner/v1", sessionId: `synthetic-${name}`, realmId: "realm:disclosure-local", userId: member.principal.id,
        displayName: "Synthetic authenticated member", credentialId: `synthetic-${name}-passkey`, kernelSessionId: member.session.id,
        actorId: member.session.actorId, expiresAt: "2099-01-01T00:00:00Z", createdAt: "2026-10-02T12:00:00Z" };
    } }, ANYAM_METADATA_DB: {}, ANYAM_EXPORTS: {}, ANYAM_EVENTS: {}, ANYAM_WORKFLOW: {} } as unknown as AnyamRealmOAuthEnv;
  if (url.pathname === "/mcp") return handleAnyamRealmMcpRequest(request, env, { scopes: ["project.read", "workspace.inspect", "change.inspect", "intent.inspect", "pullRequest.inspect", "run.invoke"], realmId: "realm:disclosure-local", kernelSessionId: member.session.id });
  const headers = new Headers(request.headers); headers.set("cookie", `anyam_owner_session=synthetic-${name}`);
  const result = await handleAuthorityRequest(new Request(request, { headers }), env);
  return result ?? new Response("fixture route missing", { status: 404 });
} };
