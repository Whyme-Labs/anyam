import { DurableObject } from "cloudflare:workers";
import { RealmArtifactsQualification } from "../../apps/realm-worker/src/artifacts-qualification.ts";
import { AnyamRealmCoordinator as RealmCoordinator } from "../../apps/realm-worker/src/index.ts";
import { AuthoritySQLiteStore } from "../../src/cloudflare/authority-sqlite.ts";
import { emptyAuthorityPlaneSnapshot, normalizeAuthorityPlaneSnapshot } from "../../src/cloudflare/authority-plane.ts";
import { RealmIdentityPolicy } from "../../src/identity/realm.ts";
import type { AuthoritySqlHost } from "../../src/cloudflare/authority-sqlite.ts";
import { artifactsBindingFixture, artifactsClock } from "./artifacts-binding.ts";

/** Test-only localhost entrypoint; production has no equivalent HTTP routes.
 * The provider below is fake, while ctx.storage.sql is real workerd SQLite. */
export class LocalArtifactsRealm extends DurableObject {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() as any : {};
    const sql = this.ctx.storage as unknown as AuthoritySqlHost;
    const authority = new AuthoritySQLiteStore(sql, { empty: emptyAuthorityPlaneSnapshot, normalize: normalizeAuthorityPlaneSnapshot });
    if (path === "/seed") {
      await this.ctx.storage.put("identity", body.identity);
      authority.replace(body.authority);
      return Response.json({ seeded: true });
    }
    if (path === "/revoke") {
      const snapshot = await this.ctx.storage.get<any>("identity");
      const identity = new RealmIdentityPolicy({ realmId: snapshot.realm.id, relyingPartyId: snapshot.realm.relyingPartyId, now: () => new Date(artifactsClock) });
      identity.restoreOperationalSnapshot(snapshot);
      identity.revokeSession(body.sessionId);
      await this.ctx.storage.put("identity", identity.getRecoverySnapshot());
      return Response.json({ revoked: true });
    }
    const fixture = artifactsBindingFixture();
    const saved = await this.ctx.storage.get<any>("fake-provider");
    if (saved) {
      for (const key of ["infos", "commits", "heads"] as const) {
        fixture[key].clear(); for (const [name, value] of saved[key]) fixture[key].set(name, value);
      }
      fixture.activeTokens.clear(); for (const id of saved.activeTokens) fixture.activeTokens.add(id);
      fixture.mintedCount = saved.mintedCount;
    }
    const owners = new Map<string, string>(saved?.owners ?? []);
    const persist = async () => this.ctx.storage.put("fake-provider", { infos: [...fixture.infos], commits: [...fixture.commits], heads: [...fixture.heads], activeTokens: [...fixture.activeTokens], mintedCount: fixture.mintedCount, owners: [...owners] });
    if (path === "/recreate") {
      fixture.infos.set(body.name, { ...fixture.infos.get(body.name)!, id: "uuid-recreated" });
      await persist(); return Response.json({ recreated: true });
    }
    const get = fixture.binding.get.bind(fixture.binding);
    const artifacts = { async get(name: string) {
      let repo;
      try { repo = await get(name); } catch { throw Object.assign(new Error("provider-secret"), { code: "NOT_FOUND" }); }
      return { ...repo,
        async fork(target: string, options: { readOnly: boolean; defaultBranchOnly: boolean }) { const reply = await repo.fork(target, options); await persist(); return reply; },
        async readCommit(oid: string) { const value = await repo.readCommit(oid); return value && { ...value, parents: [] }; },
        async createToken(scope: "read" | "write", ttl: number) { const value = await repo.createToken(scope, ttl); owners.set(value.id, name); await persist(); return value; },
        async revokeToken(id: string) { const result = await repo.revokeToken(id === `initial-id-${name}` ? `initial-secret-${name}` : id); await persist(); return result; },
        async listTokens() { const tokens = [...fixture.activeTokens].filter(id => owners.get(id) === name || id === `initial-secret-${name}`).map(id => ({ id: id === `initial-secret-${name}` ? `initial-id-${name}` : id, state: "active" as const })); return { tokens, total: tokens.length }; },
      };
    }, async delete(name: string) { fixture.events.push(`UNSAFE-delete:${name}`); fixture.infos.delete(name); await persist(); return true; } };
    let currentChecks = 0;
    const host = new RealmArtifactsQualification({ artifacts, accountId: "account-a", namespace: "private", sql, now: () => artifactsClock, current: async () => {
      const snapshot = await this.ctx.storage.get<any>("identity");
      const identity = new RealmIdentityPolicy({ realmId: snapshot.realm.id, relyingPartyId: snapshot.realm.relyingPartyId, now: () => new Date(artifactsClock) });
      identity.restoreOperationalSnapshot(snapshot);
      const state = authority.readExisting(identity.realm.id);
      if (!state) throw new Error("missing authority");
      return { identity, authority: state, active: typeof body.testDenyAfter !== "number" || ++currentChecks <= body.testDenyAfter };
    } });
    let result;
    if (path === "/run") result = await host.run(body);
    else if (path === "/cleanup") result = await host.cleanup(body);
    else if (path === "/inspect") {
      const rows = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray();
      result = { rows, runs: rows.some(row => row.name === "anyam_artifacts_qualification_runs") ? this.ctx.storage.sql.exec("SELECT payload FROM anyam_artifacts_qualification_runs ORDER BY run_id").toArray() : [], custody: rows.some(row => row.name === "anyam_artifacts_workspaces") ? this.ctx.storage.sql.exec("SELECT payload FROM anyam_artifacts_workspaces ORDER BY row_key").toArray() : [] };
    }
    else return new Response("test route missing", { status: 404 });
    return Response.json({ result, events: fixture.events, repositoryIds: [...fixture.infos].map(([name, info]) => [name, info.id]), activeTokens: fixture.activeTokens.size });
  }
}
/** Actual coordinator initialization/RPC with an intentionally absent Authority.
 * The fake binding records any unexpected provider access. */
export class LocalCoordinatorProbe extends RealmCoordinator {
  private readonly providerAccess: { calls: number };
  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof RealmCoordinator>[1]) {
    const access = { calls: 0 };
    super(ctx, { ...env, ANYAM_ARTIFACTS_ACCOUNT_ID: "account-a", ANYAM_ARTIFACTS_NAMESPACE: "private", ANYAM_ARTIFACTS: { get: async () => { access.calls++; throw new Error("unexpected fake provider access"); } } as unknown as Artifacts });
    this.providerAccess = access;
  }
  inspectArtifacts() {
    return { providerCalls: this.providerAccess.calls, tables: this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray() };
  }
}

export default { async fetch(request: Request, env: { LOCAL_REALM: DurableObjectNamespace; PRODUCTION_REALM: DurableObjectNamespace<LocalCoordinatorProbe> }) {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/production/")) {
    const realm = env.PRODUCTION_REALM.get(env.PRODUCTION_REALM.idFromName("owned-production-probe"));
    const body = await request.json();
    const result = path === "/production/run" ? await realm.qualifyArtifacts(body as Parameters<RealmCoordinator["qualifyArtifacts"]>[0]) : path === "/production/cleanup" ? await realm.cleanupArtifacts(body as Parameters<RealmCoordinator["cleanupArtifacts"]>[0]) : await realm.inspectArtifacts();
    return Response.json({ result });
  }
  return env.LOCAL_REALM.get(env.LOCAL_REALM.idFromName("owned-local-realm")).fetch(request);
} };
