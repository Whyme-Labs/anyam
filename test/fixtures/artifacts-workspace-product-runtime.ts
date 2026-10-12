import { LocalDisclosureRealm } from "./authority-disclosure-runtime.ts";
import disclosureWorker from "./authority-disclosure-runtime.ts";
import { artifactsBindingFixture } from "./artifacts-binding.ts";
import type { ArtifactsCommit, ArtifactsRepositoryInfo } from "../../src/cloudflare/artifacts-workspace.ts";

type ProviderState = { infos: [string, ArtifactsRepositoryInfo][]; commits: [string, ArtifactsCommit | null][]; heads: [string, ArtifactsCommit[]][]; activeTokens: string[]; events: string[]; forkFails: boolean; revokeSucceeds: boolean };
/** Owned local provider state. Actual public edge and Coordinator are reused. */
export class LocalArtifactsWorkspaceRealm extends LocalDisclosureRealm {
  private readonly provider;
  private readonly providerReady;
  private readonly providerSave;
  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof LocalDisclosureRealm>[1]) {
    const fixture = artifactsBindingFixture();
    let loaded = false;
    const ready = async () => {
      if (loaded) return;
      const saved = await ctx.storage.get<ProviderState>("fixture-artifacts-provider");
      if (saved) {
        fixture.infos.clear(); for (const [key, value] of saved.infos) fixture.infos.set(key, value);
        fixture.commits.clear(); for (const [key, value] of saved.commits) fixture.commits.set(key, value);
        fixture.heads.clear(); for (const [key, value] of saved.heads) fixture.heads.set(key, value);
        fixture.activeTokens.clear(); for (const token of saved.activeTokens) fixture.activeTokens.add(token);
        fixture.events.splice(0, fixture.events.length, ...saved.events);
        fixture.forkFails = saved.forkFails; fixture.revokeSucceeds = saved.revokeSucceeds;
      }
      loaded = true;
    };
    const save = async () => ctx.storage.put("fixture-artifacts-provider", { infos: [...fixture.infos], commits: [...fixture.commits], heads: [...fixture.heads], activeTokens: [...fixture.activeTokens], events: fixture.events, forkFails: fixture.forkFails, revokeSucceeds: fixture.revokeSucceeds });
    const artifacts = { async get(name: string) {
      await ready();
      const repo = await fixture.binding.get(name);
      return { ...repo,
        async info() { try { return await repo.info(); } finally { await save(); } },
        async readCommit(hash: string) { try { return await repo.readCommit(hash); } finally { await save(); } },
        async log(options: { ref: string; limit: number }) { try { return await repo.log(options); } finally { await save(); } },
        async fork(target: string, options: { readOnly: boolean; defaultBranchOnly: boolean }) { try { return await repo.fork(target, options); } finally { await save(); } },
        async revokeToken(token: string) { try { return await repo.revokeToken(token); } finally { await save(); } },
      };
    } };
    super(ctx, { ...env, ANYAM_ARTIFACTS_ACCOUNT_ID: "account-a", ANYAM_ARTIFACTS_NAMESPACE: "private", ANYAM_ARTIFACTS: artifacts as unknown as Artifacts });
    this.provider = fixture; this.providerReady = ready; this.providerSave = save;
  }
  async inspectProvider() {
    await this.providerReady();
    const exists = this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='anyam_artifacts_workspaces'").toArray().length;
    return { events: this.provider.events, activeTokens: this.provider.activeTokens.size, custody: exists ? this.ctx.storage.sql.exec("SELECT payload FROM anyam_artifacts_workspaces ORDER BY row_key").toArray() : [] };
  }
  async providerFault(fault: string) {
    await this.providerReady();
    this.provider.forkFails = fault === "lost-fork";
    this.provider.revokeSucceeds = fault !== "retirement";
    if (fault === "recreated") this.provider.infos.set("workspace-a", { ...this.provider.infos.get("workspace-a")!, id: "uuid-recreated" });
    await this.providerSave();
    return { configured: true };
  }
}
export default { async fetch(request: Request, env: { REALM_COORDINATOR: DurableObjectNamespace<LocalArtifactsWorkspaceRealm> }) {
  const path = new URL(request.url).pathname;
  const stub = env.REALM_COORDINATOR.get(env.REALM_COORDINATOR.idFromName("realm:disclosure-local"));
  if (path === "/fixture/provider") return Response.json(await stub.inspectProvider());
  if (path === "/fixture/provider-fault") {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || !("fault" in value) || typeof value.fault !== "string") return new Response("fixture fault missing", { status: 400 });
    return Response.json(await stub.providerFault(value.fault));
  }
  return disclosureWorker.fetch(request, env);
} };
