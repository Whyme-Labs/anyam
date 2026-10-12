import { LocalDisclosureRealm } from "./authority-disclosure-runtime.ts";
import disclosureWorker from "./authority-disclosure-runtime.ts";
import observer from "../../apps/repository-observer/src/index.ts";
import { parseRepositoryDriverSnapshotManifest, repositoryDriverSnapshotDigest, repositoryDriverSnapshotManifestKey, repositoryDriverSnapshotIndexKey, REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL } from "../../apps/repository-driver/src/index.ts";
import driver from "../../apps/repository-driver/src/index.ts";
import { artifactsBindingFixture } from "./artifacts-binding.ts";
import type { ArtifactsCommit, ArtifactsRepositoryInfo } from "../../src/cloudflare/artifacts-workspace.ts";

type ProviderState = { infos: [string, ArtifactsRepositoryInfo][]; commits: [string, ArtifactsCommit | null][]; heads: [string, ArtifactsCommit[]][]; activeTokens: string[]; events: string[]; forkFails: boolean; revokeSucceeds: boolean; graph?: [string, ArtifactsCommit][] };
/** Owned local provider state. Actual public edge and Coordinator are reused. */
export class LocalArtifactsWorkspaceRealm extends LocalDisclosureRealm {
  private readonly provider;
  private readonly providerReady;
  private readonly providerSave;
  private readonly providerGraph;
  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof LocalDisclosureRealm>[1]) {
    const fixture = artifactsBindingFixture();
    const graph = new Map<string, ArtifactsCommit>();
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
        if (saved.graph) for (const [key, value] of saved.graph) graph.set(key, value);
        fixture.forkFails = saved.forkFails; fixture.revokeSucceeds = saved.revokeSucceeds;
      }
      loaded = true;
    };
    const save = async () => ctx.storage.put("fixture-artifacts-provider", { infos: [...fixture.infos], commits: [...fixture.commits], heads: [...fixture.heads], activeTokens: [...fixture.activeTokens], events: fixture.events, forkFails: fixture.forkFails, revokeSucceeds: fixture.revokeSucceeds, graph: [...graph] });
    const artifacts = { async get(name: string) {
      await ready();
      const repo = await fixture.binding.get(name);
      return { ...repo,
        async info() { try { return await repo.info(); } finally { await save(); } },
        async readCommit(hash: string) { try { const value = graph.get(hash) ?? await repo.readCommit(hash); return value && { ...value, parents: value.parents ?? [] }; } finally { await save(); } },
        async log(options: { ref: string; limit: number }) { try { const info = await repo.info(); return options.ref === `refs/heads/${info.defaultBranch}` ? await repo.log(options) : []; } finally { await save(); } },
        async fork(target: string, options: { readOnly: boolean; defaultBranchOnly: boolean }) { try { return await repo.fork(target, options); } finally { await save(); } },
        async revokeToken(token: string) { try { return await repo.revokeToken(token); } finally { await save(); } },
      };
    } };
    const state = env.ANYAM_REPOSITORY_STATE;
    const repositoryState = state && new Proxy(state, { get(target, property) {
      if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        const result = await target.put(...args);
        const fault = await ctx.storage.get<string>("fixture-observation-fault");
        if (result && fault === "advance-index" && !args[0].endsWith("/index.json") && typeof args[1] === "string") {
          const value: unknown = JSON.parse(args[1]);
          const manifest = parseRepositoryDriverSnapshotManifest(value);
          if (!manifest) throw new Error("owned competing manifest malformed");
          const newer = { ...manifest, generation: manifest.generation + 1 };
          const key = repositoryDriverSnapshotManifestKey("repositories/", newer.repositoryId, newer.context, newer.generation);
          await target.put(key, JSON.stringify(newer));
          await target.put(repositoryDriverSnapshotIndexKey("repositories/", newer.repositoryId, newer.context), JSON.stringify({ protocol: REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL, repositoryId: newer.repositoryId, sourceSpaceId: newer.sourceSpaceId, context: newer.context, latestGeneration: newer.generation, previousGeneration: manifest.generation, latestManifestKey: key, latestManifestDigest: await repositoryDriverSnapshotDigest(newer), updatedAt: newer.observedAt, receipt: "provider=owned-competing-fixture; index=monotonic; credentialMaterialStored=false" }));
          await ctx.storage.delete("fixture-observation-fault");
        }
        if (result && ((fault === "manifest" && !args[0].endsWith("/index.json")) || (fault === "index" && args[0].endsWith("/index.json")))) {
          await ctx.storage.delete("fixture-observation-fault"); throw new Error("owned interruption after actual R2 commit");
        }
        if (result && fault === "expire-after-index" && args[0].endsWith("/index.json") && typeof args[1] === "string") {
          await ctx.storage.delete("fixture-observation-fault");
          const index: unknown = JSON.parse(args[1]);
          if (!index || typeof index !== "object" || !("latestManifestKey" in index) || typeof index.latestManifestKey !== "string") throw new Error("owned delayed index malformed");
          const value: unknown = await (await target.get(index.latestManifestKey))?.json();
          const manifest = parseRepositoryDriverSnapshotManifest(value);
          if (!manifest) throw new Error("owned delayed manifest missing");
          await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(manifest.expiresAt) - Date.now() + 50)));
        }
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const observerBinding = state && { fetch: (request: Request) => observer.fetch(request, {
      REPOSITORY_DRIVER: { fetch: (value: Request) => driver.fetch(value, { REPOSITORY_STATE: state, REPOSITORY_DRIVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_DRIVER_REQUEST_BYTES_RECEIPT: "receipt=existing-repository-driver-local-qualification" }) } as unknown as Fetcher,
      REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT: "receipt=existing-repository-observer-local-qualification", REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_MS: "1000", REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_RECEIPT: "receipt=existing-repository-observer-local-qualification"
    }) } as unknown as Fetcher;
    super(ctx, { ...env, ...(repositoryState ? { ANYAM_REPOSITORY_STATE: repositoryState } : {}), ...(observerBinding ? { ANYAM_REPOSITORY_OBSERVER: observerBinding } : {}), ANYAM_ARTIFACTS_ACCOUNT_ID: "account-a", ANYAM_ARTIFACTS_NAMESPACE: "private", ANYAM_ARTIFACTS: artifacts as unknown as Artifacts });
    this.provider = fixture; this.providerReady = ready; this.providerSave = save; this.providerGraph = graph;
  }
  async recoveryArtifactsRows() {
    const read = (table: string) => this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).toArray().length ? this.ctx.storage.sql.exec(`SELECT * FROM ${table} ORDER BY row_key`).toArray() : [];
    return { workspaces: read("anyam_artifacts_workspaces"), observations: read("anyam_artifacts_observations") };
  }
  async recoveryArtifactsFixture(operation: string) {
    if (operation === "drop") {
      this.ctx.storage.sql.exec("DROP TABLE IF EXISTS anyam_artifacts_observations"); this.ctx.storage.sql.exec("DROP TABLE IF EXISTS anyam_artifacts_workspaces");
    } else if (operation === "tamper-generation") {
      const row = this.ctx.storage.sql.exec<{ row_key: string; manifest: string }>("SELECT row_key, manifest FROM anyam_artifacts_observations ORDER BY row_key LIMIT 1").toArray()[0];
      if (!row) throw new Error("owned generation missing");
      const value: unknown = JSON.parse(row.manifest);
      if (!value || typeof value !== "object" || !("receipt" in value) || typeof value.receipt !== "string") throw new Error("owned generation malformed");
      Reflect.set(value, "receipt", value.receipt + "; fixtureChanged=true"); this.ctx.storage.sql.exec("UPDATE anyam_artifacts_observations SET manifest=? WHERE row_key=?", JSON.stringify(value), row.row_key);
    } else throw new Error("unknown owned recovery operation");
    return { changed: true };
  }
  async configureGraph(commits: ArtifactsCommit[], head: string, sourceBase?: string) {
    await this.providerReady();
    for (const commit of commits) this.providerGraph.set(commit.hash, commit);
    const selected = this.providerGraph.get(head);
    if (!selected) throw new Error("owned fixture head missing");
    this.provider.heads.set("workspace-a", [selected]);
    if (sourceBase) {
      const base = this.providerGraph.get(sourceBase);
      if (!base) throw new Error("owned fixture base missing");
      this.provider.commits.set("source", base); this.provider.heads.set("source", [base]);
    }
    await this.providerSave(); return { configured: true };
  }
  async observationFault(value: string) { await this.ctx.storage.put("fixture-observation-fault", value); return { configured: true }; }
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
export default { async fetch(request: Request, env: { REALM_COORDINATOR: DurableObjectNamespace<LocalArtifactsWorkspaceRealm>; ANYAM_REPOSITORY_STATE?: R2Bucket }) {
  const path = new URL(request.url).pathname;
  const stub = env.REALM_COORDINATOR.get(env.REALM_COORDINATOR.idFromName("realm:disclosure-local"));
  if (path === "/fixture/artifact-recovery-rows") return Response.json(await stub.recoveryArtifactsRows());
  if (path === "/fixture/artifact-recovery-mutate") { const value: unknown = await request.json(); if (!value || typeof value !== "object" || !("operation" in value) || typeof value.operation !== "string") return new Response("operation required", { status: 400 }); return Response.json(await stub.recoveryArtifactsFixture(value.operation)); }
  if (path === "/fixture/observation-state") {
    if (!env.ANYAM_REPOSITORY_STATE) return Response.json({ objects: [] });
    const listed = await env.ANYAM_REPOSITORY_STATE.list();
    const objects = await Promise.all(listed.objects.map(async item => ({ key: item.key, value: await (await env.ANYAM_REPOSITORY_STATE!.get(item.key))?.json() })));
    return Response.json({ objects });
  }
  if (path === "/fixture/provider-graph") {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || !("commits" in value) || !Array.isArray(value.commits) || !("head" in value) || typeof value.head !== "string") return new Response("fixture graph missing", { status: 400 });
    const commits: ArtifactsCommit[] = [];
    for (const item of value.commits) {
      if (!item || typeof item !== "object" || !("hash" in item) || typeof item.hash !== "string" || !("treeHash" in item) || typeof item.treeHash !== "string" || !("parents" in item) || !Array.isArray(item.parents) || item.parents.some((parent: unknown) => typeof parent !== "string")) return new Response("fixture commit malformed", { status: 400 });
      commits.push({ hash: item.hash, treeHash: item.treeHash, parents: item.parents.map((parent: unknown) => String(parent)) });
    }
    return Response.json(await stub.configureGraph(commits, value.head, "sourceBase" in value && typeof value.sourceBase === "string" ? value.sourceBase : undefined));
  }
  if (path === "/fixture/observation-fault") {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || !("fault" in value) || typeof value.fault !== "string") return new Response("fixture fault missing", { status: 400 });
    return Response.json(await stub.observationFault(value.fault));
  }
  if (path === "/fixture/provider") return Response.json(await stub.inspectProvider());
  if (path === "/fixture/provider-fault") {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || !("fault" in value) || typeof value.fault !== "string") return new Response("fixture fault missing", { status: 400 });
    return Response.json(await stub.providerFault(value.fault));
  }
  return disclosureWorker.fetch(request, env);
} };
