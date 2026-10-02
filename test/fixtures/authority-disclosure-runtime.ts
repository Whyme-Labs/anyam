import { AnyamRealmCoordinator } from "../../apps/realm-worker/src/index.ts";
import { handleAuthorityRequest } from "../../apps/realm-worker/src/authority-edge.ts";
import { handleAnyamRealmMcpRequest } from "../../apps/realm-worker/src/mcp-handler.ts";
import type { AnyamRealmOAuthEnv } from "../../apps/realm-worker/src/oauth-provider.ts";
import { AuthoritySQLiteStore, type AuthoritySqlHost } from "../../src/cloudflare/authority-sqlite.ts";
import { emptyAuthorityPlaneSnapshot, normalizeAuthorityPlaneSnapshot } from "../../src/cloudflare/authority-plane.ts";
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
  async members() { return await this.ctx.storage.get<Fixture["members"]>("fixture-members"); }
  async checkpoint() {
    const identity: unknown = Reflect.get(this, "identity");
    if (!(identity instanceof RealmIdentityPolicy)) throw new Error("missing current identity");
    const store = new AuthoritySQLiteStore(this.ctx.storage as unknown as AuthoritySqlHost, { empty: emptyAuthorityPlaneSnapshot, normalize: normalizeAuthorityPlaneSnapshot });
    return { identity: identity.getRecoverySnapshot(), authority: store.load(identity.realm.id), keys: Object.fromEntries(await this.ctx.storage.list()) };
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
export default { async fetch(request: Request, bindings: { REALM_COORDINATOR: DurableObjectNamespace<LocalDisclosureRealm> }) {
  const url = new URL(request.url);
  const realm = bindings.REALM_COORDINATOR.get(bindings.REALM_COORDINATOR.idFromName("realm:disclosure-local"));
  if (url.pathname === "/fixture/seed") return Response.json(await realm.seed(await request.json() as Fixture));
  if (url.pathname === "/fixture/revoke") return Response.json(await realm.revoke((await request.json() as { sessionId: string }).sessionId));
  if (url.pathname === "/fixture/checkpoint") return Response.json(await realm.checkpoint());
  if (url.pathname === "/fixture/fail-identity-write-once") return Response.json(await realm.failIdentityWriteOnce());
  if (url.pathname.startsWith("/authority/")) return realm.fetch(request);
  const name = request.headers.get("x-fixture-member") ?? "public";
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
