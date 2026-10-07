import fixtureWorker, { LocalDisclosureRealm } from "./authority-disclosure-runtime.ts";
import { handleAnyamRealmMcpRequest, type AnyamRealmMcpProps } from "../../apps/realm-worker/src/mcp-handler.ts";
import { RealmIdentityPolicy } from "../../src/identity/realm.ts";

export class LocalSelectorRealm extends LocalDisclosureRealm {
  private fixtureClock = "2026-10-02T12:00:00Z";
  override async seed(fixture: Parameters<LocalDisclosureRealm["seed"]>[0]) {
    await super.seed(fixture);
    this.fixtureClock = "2026-10-02T12:00:00Z";
    const identity = new RealmIdentityPolicy({ realmId: fixture.identity.realm.id, relyingPartyId: fixture.identity.realm.relyingPartyId, now: () => new Date(this.fixtureClock) });
    identity.restoreOperationalSnapshot(fixture.identity);
    Reflect.set(this, "identity", identity);
    return { seeded: true };
  }
  async expireAfterObservation() {
    const original: unknown = Reflect.get(this, "prepareHostedRevision");
    if (typeof original !== "function") throw new Error("missing actual observation boundary");
    Reflect.set(this, "prepareHostedRevision", async (...args: unknown[]) => {
      Reflect.set(this, "prepareHostedRevision", original);
      const command: unknown = await original.apply(this, args);
      this.fixtureClock = "2099-01-01T00:00:00Z";
      return command;
    });
    return { faultArmed: true };
  }
  async setBindings(bindings: Record<string, AnyamRealmMcpProps>) { await this.ctx.storage.put("fixture-selector-bindings", bindings); return { stored: true }; }
  async bindings() { return await this.ctx.storage.get<Record<string, AnyamRealmMcpProps>>("fixture-selector-bindings"); }
}
export default { async fetch(request: Request, bindings: { REALM_COORDINATOR: DurableObjectNamespace<LocalSelectorRealm> }) {
  const url = new URL(request.url);
  const realm = bindings.REALM_COORDINATOR.get(bindings.REALM_COORDINATOR.idFromName("realm:disclosure-local"));
  if (url.pathname === "/fixture/selector-bindings") return Response.json(await realm.setBindings(await request.json() as Record<string, AnyamRealmMcpProps>));
  if (url.pathname === "/fixture/expire-after-observation") return Response.json(await realm.expireAfterObservation());
  if (url.pathname === "/mcp") {
    const props = (await realm.bindings())?.[request.headers.get("x-fixture-agent") ?? ""];
    if (props) return handleAnyamRealmMcpRequest(request, { ANYAM_INSTALLATION_ID: "disclosure-local", REALM_COORDINATOR: bindings.REALM_COORDINATOR }, props);
  }
  return fixtureWorker.fetch(request, bindings as unknown as Parameters<typeof fixtureWorker.fetch>[1]);
} };
