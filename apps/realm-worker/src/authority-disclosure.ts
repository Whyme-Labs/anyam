import { createHash } from "node:crypto";
import { summarizeIntentForAudience, summarizePullRequestForAudience } from "../../../src/disclosure/hybrid.ts";
import type { AuthorityPlaneSnapshot } from "../../../src/cloudflare/authority-plane.ts";
import type { Capability, SourceMetadataReadCapability } from "../../../src/identity/realm.ts";
import type { DisclosureClassification, Evidence, ResourceRef } from "../../../src/kernel/contracts.ts";

type ReadContext = {
  capabilities(resource: ResourceRef): readonly Capability[];
  sourceReadable(projectId: string, sourceSpaceId: string, capability?: SourceMetadataReadCapability): boolean;
  resourceReadable?: (resource: ResourceRef) => boolean;
  realmOwner?: () => boolean;
};
export type DisclosedProjectViewRevision = {
  protocol: "anyam.disclosed-project-view-revision/v1";
  id: string;
  projectId: string;
  sourceSpaceSnapshots: Readonly<Record<string, string>>;
};
const rank = (value: string) => value === "public" ? 0 : value === "internal" || value === "project" ? 1 : 2;
const sorted = <T extends { id: string }>(values: readonly T[]) => [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Read projections only. Canonical records and stored Views remain unchanged.
 * Stored lineage supplies scope; the fresh read context supplies authority. */
export class AuthorityDisclosure {
  constructor(private readonly state: AuthorityPlaneSnapshot, private readonly context: ReadContext) {}

  capable(projectId: string, capability: Capability, extra: Partial<ResourceRef> = {}) {
    return this.state.projects[projectId]?.id === projectId && this.context.capabilities({ realmId: this.state.realmId, projectId, ...extra }).includes(capability);
  }
  private scopedCapability(projectId: string, capability: SourceMetadataReadCapability, ids: readonly string[], extra: Partial<ResourceRef> = {}) {
    return this.capable(projectId, capability, extra)
      && ids.every(sourceSpaceId => this.capable(projectId, capability, { ...extra, sourceSpaceId }) && this.context.sourceReadable(projectId, sourceSpaceId, capability));
  }
  readableSources(projectId: string) {
    const project = this.state.projects[projectId];
    return project ? [...new Set(project.sourceSpaceIds)].filter(id => !!this.state.sourceSpaces[id] && this.context.sourceReadable(projectId, id, "project.inspect") && this.capable(projectId, "project.inspect", { sourceSpaceId: id })).sort() : [];
  }
  completeProject(projectId: string) {
    const project = this.state.projects[projectId];
    return !!project && new Set(project.sourceSpaceIds).size === project.sourceSpaceIds.length && this.readableSources(projectId).length === project.sourceSpaceIds.length;
  }
  completeRealm() {
    const projects = Object.values(this.state.projects);
    return projects.every(p => this.completeProject(p.id) && this.capable(p.id, "project.inspect"))
      && Object.keys(this.state.sourceSpaces).every(id => projects.some(p => p.sourceSpaceIds.includes(id)));
  }
  ownerDetails() { return this.context.realmOwner?.() === true && this.completeRealm(); }
  summary() {
    const projects = this.projects();
    const counts = Object.fromEntries(Object.keys(projects[0]?.counts ?? { workspaces: 0, intents: 0, intentComments: 0, pullRequests: 0, changes: 0, revisions: 0, runs: 0, evidence: 0, artifacts: 0, releases: 0, targets: 0, promotions: 0 }).map(key => [key, projects.reduce((n, p) => n + p.counts[key as keyof typeof p.counts], 0)]));
    return { realmId: this.state.realmId, projectCount: projects.length, sourceSpaceCount: projects.reduce((n, p) => n + p.sourceSpaces.length, 0), counts };
  }
  private projectDescriptor(projectId: string) {
    const p = this.state.projects[projectId];
    return p && { protocol: p.protocol, id: p.id, name: p.name, referenceType: p.referenceType };
  }
  private classification(projectId: string, value: DisclosureClassification, scope?: readonly string[]) {
    // Project collaboration is its own audience. Reading an unrelated private
    // Source never upgrades it to a restricted Intent/comment audience.
    if (value === "public" || value === "project") return this.capable(projectId, "project.inspect");
    return !!scope?.length && scope.every(id => this.sourceReadable(projectId, id))
      && scope.some(id => rank(this.state.sourceSpaces[id]!.classification) >= rank(value));
  }
  private sourceReadable(projectId: string, sourceSpaceId: string, extra: Partial<ResourceRef> = {}) {
    return this.state.sourceSpaces[sourceSpaceId]?.id === sourceSpaceId
      && !!this.state.projects[projectId]?.sourceSpaceIds.includes(sourceSpaceId)
      && this.context.sourceReadable(projectId, sourceSpaceId)
      && this.capable(projectId, "source.read", { ...extra, sourceSpaceId });
  }
  private disclosedRevision(projectId: string, snapshots: Readonly<Record<string, string>>, ids: readonly string[]): DisclosedProjectViewRevision | undefined {
    if (!this.scopedCapability(projectId, "project.inspect", ids) || new Set(ids).size !== ids.length
      || ids.some(id => !this.sourceReadable(projectId, id) || typeof snapshots[id] !== "string" || !snapshots[id])) return undefined;
    const scope = [...ids].sort();
    const sourceSpaceSnapshots = Object.fromEntries(scope.map(id => [id, snapshots[id]!]));
    const sourceSpaces = scope.map(id => {
      const s = this.state.sourceSpaces[id]!;
      return { id: s.id, name: s.name, classification: s.classification, ...(s.repositoryId ? { repositoryId: s.repositoryId } : {}) };
    });
    const envelope = { protocol: "anyam.disclosed-project-view-revision/v1" as const, projectId, sourceSpaceSnapshots, sourceSpaces };
    return { protocol: envelope.protocol, id: `project-view-revision:sha256:${createHash("sha256").update(JSON.stringify(envelope)).digest("hex")}`, projectId, sourceSpaceSnapshots };
  }
  private revision(revisionId: string, scope?: readonly string[]) {
    const r = this.state.projectRevisions[revisionId];
    return r?.id === revisionId && this.disclosedRevision(r.projectId, r.sourceSpaceSnapshots, scope ?? this.readableSources(r.projectId));
  }
  private view(viewId: string, projectId: string, revisionId?: string) {
    const view = this.state.projectViews[viewId];
    const revision = view && this.state.projectRevisions[view.projectRevisionId];
    if (!view || view.id !== viewId || !revision || revision.id !== view.projectRevisionId || view.projectId !== projectId || revision.projectId !== projectId
      || (revisionId && view.projectRevisionId !== revisionId)) return undefined;
    const ids = view.visibleSourceSpaceIds;
    if (!ids.length || new Set(ids).size !== ids.length || Object.keys(view.disclosedSourceSpaceSnapshots).length !== ids.length
      || ids.some(id => !this.sourceReadable(projectId, id) || view.disclosedSourceSpaceSnapshots[id] !== revision.sourceSpaceSnapshots[id] || !view.disclosedSourceSpaceSnapshots[id])
      || !this.classification(projectId, view.classification, ids)) return undefined;
    return view;
  }
  private viewReference(projectId: string, viewId: string) {
    const view = this.view(viewId, projectId);
    const disclosed = view && this.revision(view.projectRevisionId, view.visibleSourceSpaceIds);
    return disclosed && { projectViewRevisionId: disclosed.id };
  }
  private recordScope(revisionId: string, viewId: string, changeRevisionId?: string) {
    const stored = this.state.projectViews[viewId];
    const view = stored && this.view(viewId, stored.projectId);
    if (!view) return undefined;
    const changeRevision = changeRevisionId && this.state.changeRevisions[changeRevisionId];
    if (changeRevisionId) {
      if (!changeRevision || !this.revisionEligible(changeRevision.id)
        || changeRevision.projectRevisionId !== revisionId || changeRevision.projectViewId !== viewId
        || this.state.changes[changeRevision.changeId]?.projectId !== view.projectId) return undefined;
      const manifest = this.state.projectRevisions[revisionId];
      if (manifest && (manifest.id !== revisionId || manifest.projectId !== view.projectId
        || view.visibleSourceSpaceIds.some(source => manifest.sourceSpaceSnapshots[source] !== changeRevision.sourceSpaceSnapshots![source]))) return undefined;
      return { projectId: view.projectId, ids: view.visibleSourceSpaceIds, snapshots: changeRevision.sourceSpaceSnapshots!, changeId: changeRevision.changeId, changeRevisionId: changeRevision.id };
    }
    if (view.projectRevisionId !== revisionId) return undefined;
    return { projectId: view.projectId, ids: view.visibleSourceSpaceIds, snapshots: view.disclosedSourceSpaceSnapshots };
  }

  project(projectId: string) {
    if (!this.capable(projectId, "project.inspect")) return undefined;
    const p = this.state.projects[projectId]!;
    const canonicalId = this.state.canonicalByProject[projectId];
    const canonical = canonicalId && this.state.projectRevisions[canonicalId];
    const projection = canonical && this.revision(canonical.id);
    if (!canonical || !projection || canonical.projectId !== projectId) return undefined;
    const ids = this.readableSources(projectId);
    const counts = {
      workspaces: this.workspaces(projectId).length, intents: this.intents(projectId).length,
      intentComments: this.intents(projectId).reduce((n, item) => n + item.comments.length, 0),
      pullRequests: this.pullRequests(projectId).length, changes: this.changes(projectId).length,
      revisions: this.changes(projectId).reduce((n, item) => n + item.revisions.length, 0),
      runs: Object.values(this.state.runs).filter(run => this.state.projectViews[run.projectViewId]?.projectId === projectId && this.run(run.id)).length,
      evidence: Object.values(this.state.evidence).filter(item => this.state.projectViews[item.projectViewId]?.projectId === projectId && this.evidence(item.id)).length,
      artifacts: Object.values(this.state.artifacts).filter(item => this.artifactProject(item.id) === projectId && this.artifact(item.id)).length,
      releases: Object.values(this.state.releases).filter(item => this.release(item.id)?.projectId === projectId && this.release(item.id)).length,
      targets: Object.values(this.state.targets).filter(item => item.projectId === projectId && this.target(item.id)).length,
      promotions: Object.values(this.state.promotions).filter(item => item.projectId === projectId && this.promotion(item.id)).length,
    };
    return { project: { ...this.projectDescriptor(projectId)!, sourceSpaceIds: ids }, projectViewRevision: projection,
      sourceSpaces: ids.map(id => { const s = this.state.sourceSpaces[id]!; return { protocol: s.protocol, id: s.id, name: s.name, classification: s.classification, ...(s.repositoryId ? { repositoryId: s.repositoryId } : {}) }; }), counts };
  }
  projects() { return sorted(Object.values(this.state.projects)).flatMap(p => { const value = this.project(p.id); return value ? [value] : []; }); }

  private workspaceScope(id: string) {
    const w = this.state.workspaces[id];
    if (!w || w.id !== id) return undefined;
    const view = this.view(w.projectViewId, w.projectId, w.projectRevisionId);
    if (!view || w.mounts.length !== view.visibleSourceSpaceIds.length || new Set(w.mounts.map(m => m.sourceSpaceId)).size !== w.mounts.length
      || w.mounts.some(m => !this.sourceReadable(w.projectId, m.sourceSpaceId, { workspaceId: id, ...(w.changeId ? { changeId: w.changeId } : {}) })
        || !view.visibleSourceSpaceIds.includes(m.sourceSpaceId) || m.snapshotId !== view.disclosedSourceSpaceSnapshots[m.sourceSpaceId])) return undefined;
    return { workspace: w, view };
  }
  workspace(id: string) {
    const scope = this.workspaceScope(id);
    const w = scope?.workspace;
    if (!w || !this.scopedCapability(w.projectId, "workspace.inspect", scope!.view.visibleSourceSpaceIds, { workspaceId: id, ...(w.changeId ? { changeId: w.changeId } : {}) })) return undefined;
    const reference = this.viewReference(w.projectId, w.projectViewId);
    if (!reference) return undefined;
    return { workspace: { protocol: w.protocol, id, projectId: w.projectId, ...reference, state: w.state,
      ...(w.changeId && this.changeEligible(w.changeId) ? { changeId: w.changeId } : {}) }, project: this.projectDescriptor(w.projectId)!, mountCount: w.mounts.length };
  }
  workspaces(projectId?: string) { return sorted(Object.values(this.state.workspaces)).filter(w => !projectId || w.projectId === projectId).flatMap(w => { const value = this.workspace(w.id); return value ? [value] : []; }); }
  private revisionEligible(id: string) {
    const r = this.state.changeRevisions[id];
    const c = r && this.state.changes[r.changeId];
    if (!r || !c || !r.sourceSpaceSnapshots || !r.projectViewId) return false;
    const view = this.view(r.projectViewId, c.projectId, c.baseProjectRevisionId);
    if (!view || (r.baseProjectRevisionId && r.baseProjectRevisionId !== c.baseProjectRevisionId)) return false;
    const manifest = this.state.projectRevisions[r.projectRevisionId];
    if (manifest && (manifest.id !== r.projectRevisionId || manifest.projectId !== c.projectId
      || view.visibleSourceSpaceIds.some(source => manifest.sourceSpaceSnapshots[source] !== r.sourceSpaceSnapshots![source]))) return false;
    const ids = Object.keys(r.sourceSpaceSnapshots);
    const w = r.workspaceId && this.state.workspaces[r.workspaceId];
    const parent = r.parentRevisionId && this.state.changeRevisions[r.parentRevisionId];
    return ids.length === view.visibleSourceSpaceIds.length
      && ids.every(source => view.visibleSourceSpaceIds.includes(source) && this.sourceReadable(c.projectId, source, { changeId: c.id, ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}) }) && typeof r.sourceSpaceSnapshots![source] === "string" && !!r.sourceSpaceSnapshots![source])
      && (!c.workspaceId || c.workspaceId === r.workspaceId)
      && (!r.workspaceId || (!!w && !!this.workspaceScope(w.id) && w.projectId === c.projectId && w.changeId === c.id && w.projectViewId === r.projectViewId && w.projectRevisionId === c.baseProjectRevisionId))
      && (!r.parentRevisionId || (!!parent && parent.changeId === c.id && parent.sequence < r.sequence));
  }
  private changeEligible(id: string) {
    const c = this.state.changes[id];
    if (!c || !this.capable(c.projectId, "change.inspect", { changeId: id, ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}) })) return false;
    const revisions = Object.values(this.state.changeRevisions).filter(r => r.changeId === id);
    const workspace = c.workspaceId && this.workspaceScope(c.workspaceId);
    if (c.workspaceId && !workspace) return false;
    const ids = [...new Set([...revisions.flatMap(r => Object.keys(r.sourceSpaceSnapshots ?? {})), ...(workspace ? workspace.view.visibleSourceSpaceIds : [])])];
    if (!this.scopedCapability(c.projectId, "change.inspect", ids, { changeId: id, ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}) })) return false;
    if (revisions.length) return revisions.every(r => this.revisionEligible(r.id)) && revisions.some(r => r.id === c.latestRevisionId);
    if (c.latestRevisionId !== null) return false;
    const w = c.workspaceId && this.state.workspaces[c.workspaceId];
    return !!w && w.changeId === id && !!this.view(w.projectViewId, c.projectId, c.baseProjectRevisionId);
  }
  change(id: string) {
    const c = this.state.changes[id];
    if (!c || !this.changeEligible(id)) return undefined;
    const stored = Object.values(this.state.changeRevisions).filter(r => r.changeId === id).sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    const ids = [...new Set(stored.flatMap(r => Object.keys(r.sourceSpaceSnapshots!)))];
    const w = c.workspaceId && this.state.workspaces[c.workspaceId];
    const base = this.revision(c.baseProjectRevisionId, ids.length ? ids : w ? this.state.projectViews[w.projectViewId]!.visibleSourceSpaceIds : []);
    if (!base) return undefined;
    const revisions = stored.map(r => ({ protocol: r.protocol, id: r.id, changeId: r.changeId, sequence: r.sequence,
      projectViewRevisionId: this.disclosedRevision(c.projectId, r.sourceSpaceSnapshots!, Object.keys(r.sourceSpaceSnapshots!))!.id,
      ...(r.parentRevisionId ? { parentRevisionId: r.parentRevisionId } : {}), ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
      declaredEffects: [...r.declaredEffects], ...(r.kind ? { kind: r.kind } : {}) }));
    return { change: { protocol: c.protocol, id, projectId: c.projectId, ...(this.intent(c.intentId) ? { intentId: c.intentId } : {}),
      baseProjectViewRevisionId: base.id, status: c.status, latestRevisionId: c.latestRevisionId,
      ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
      ...(c.revertsChangeRevisionId && this.revisionEligible(c.revertsChangeRevisionId) ? { revertsChangeRevisionId: c.revertsChangeRevisionId } : {}) }, project: this.projectDescriptor(c.projectId)!, revisions };
  }
  changes(projectId?: string, workspaceId?: string) { return sorted(Object.values(this.state.changes)).filter(c => (!projectId || c.projectId === projectId) && (!workspaceId || c.workspaceId === workspaceId)).flatMap(c => { const value = this.change(c.id); return value ? [value] : []; }); }

  /** Record-local candidate review. Recorded outcomes are not signed proof. */
  revisionReview(id: string) {
    const record = this.state.changeRevisions[id];
    const selected = record?.id === id && this.change(record.changeId);
    const revision = selected && selected.revisions.find(value => value.id === id);
    if (!record || !selected || !revision || !record.sourceSpaceSnapshots) return undefined;
    const resource = { realmId: this.state.realmId, projectId: selected.change.projectId, changeId: selected.change.id,
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}) };
    if (Object.keys(record.sourceSpaceSnapshots).some(sourceSpaceId => this.context.resourceReadable?.({ ...resource, sourceSpaceId }) === false)) return undefined;
    const projectViewRevision = this.disclosedRevision(selected.change.projectId, record.sourceSpaceSnapshots, Object.keys(record.sourceSpaceSnapshots));
    if (!projectViewRevision) return undefined;
    const runs = sorted(Object.values(this.state.runs).filter(run => run.changeRevisionId === id)).flatMap(run => {
      const visible = this.run(run.id);
      const evidence: { id: string; outcome: Evidence["outcome"] }[] = [];
      return visible ? [{ ...visible, evidence }] : [];
    });
    const byRun = new Map(runs.map(run => [run.id, run]));
    for (const record of sorted(Object.values(this.state.evidence).filter(record => record.changeRevisionId === id && byRun.has(record.runId)))) {
      const run = byRun.get(record.runId);
      if (!run) continue;
      const visible = this.evidence(record.id);
      if (visible) run.evidence.push(visible);
    }
    return { change: selected.change, revision: { ...revision, isLatestForChange: selected.change.latestRevisionId === id }, projectViewRevision, runs };
  }

  intent(id: string) {
    const i = this.state.intents[id];
    if (!i || !this.capable(i.projectId, "intent.inspect") || !this.classification(i.projectId, i.disclosure)) return undefined;
    const visible = sorted(Object.values(this.state.intentComments)).filter(c => c.intentId === id && c.projectId === i.projectId && this.classification(i.projectId, c.disclosure));
    const summary = summarizeIntentForAudience({ project: this.state.projects[i.projectId]!, intent: i, comments: visible, audience: "project" });
    if (!summary) return undefined;
    return { intent: { protocol: i.protocol, id, projectId: i.projectId, title: summary.title, description: summary.description,
      status: summary.status, labels: summary.labels, disclosure: i.disclosure },
      comments: summary.comments, project: this.projectDescriptor(i.projectId)! };
  }
  intents(projectId?: string) { return sorted(Object.values(this.state.intents)).filter(i => !projectId || i.projectId === projectId).flatMap(i => { const value = this.intent(i.id); return value ? [value] : []; }); }
  pullRequest(id: string) {
    const p = this.state.pullRequests[id];
    const c = p && this.change(p.changeId);
    if (!p || !c || c.change.projectId !== p.projectId || !this.capable(p.projectId, "pullRequest.inspect", { pullRequestId: p.id, changeId: p.changeId })) return undefined;
    const revisions = Object.values(this.state.changeRevisions).filter(r => r.changeId === p.changeId);
    const workspace = c.change.workspaceId && this.workspaceScope(c.change.workspaceId);
    const ids = [...new Set([...revisions.flatMap(r => Object.keys(r.sourceSpaceSnapshots!)), ...(workspace ? workspace.view.visibleSourceSpaceIds : [])])];
    const resource = { pullRequestId: id, changeId: p.changeId, ...(c.change.workspaceId ? { workspaceId: c.change.workspaceId } : {}) };
    if (!ids.length || !this.scopedCapability(p.projectId, "pullRequest.inspect", ids, resource) || !ids.every(source => this.sourceReadable(p.projectId, source, resource))
      || !this.classification(p.projectId, p.disclosure, ids)
      || (p.sourceSpaceId && (!ids.includes(p.sourceSpaceId) || !this.sourceReadable(p.projectId, p.sourceSpaceId, resource)))
      || !p.revisionIds.every(r => this.state.changeRevisions[r]?.changeId === p.changeId && this.revisionEligible(r))) return undefined;
    const summary = summarizePullRequestForAudience({ project: this.state.projects[p.projectId]!, pullRequest: p, audience: p.disclosure === "restricted" ? "restricted" : "project" });
    if (!summary) return undefined;
    return { pullRequest: { protocol: p.protocol, id, projectId: p.projectId, changeId: p.changeId,
      title: summary.title, description: summary.description, status: summary.status, reviewState: summary.reviewState,
      headRef: summary.headRef, baseRef: summary.baseRef, revisionIds: [...p.revisionIds], disclosure: p.disclosure },
      change: c.change, project: c.project, revisions: c.revisions.filter(r => p.revisionIds.includes(r.id)) };
  }
  pullRequests(projectId?: string) { return sorted(Object.values(this.state.pullRequests)).filter(p => !projectId || p.projectId === projectId).flatMap(p => { const value = this.pullRequest(p.id); return value ? [value] : []; }); }

  run(id: string) {
    const r = this.state.runs[id];
    const scope = r && this.recordScope(r.projectRevisionId, r.projectViewId, r.changeRevisionId);
    if (!r || !scope || !this.scopedCapability(scope.projectId, "evidence.read", scope.ids, { runId: id,
      ...(scope.changeId ? { changeId: scope.changeId } : {}), ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}) })) return undefined;
    if (!scope.ids.every(sourceId => this.sourceReadable(scope.projectId, sourceId, { runId: id, ...(scope.changeId ? { changeId: scope.changeId } : {}), ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}) }))) return undefined;
    const w = r.workspaceId && this.state.workspaces[r.workspaceId];
    if (r.workspaceId && (!w || w.projectId !== scope.projectId || w.projectViewId !== r.projectViewId
      || (scope.changeId && w.changeId !== scope.changeId) || !this.workspaceScope(w.id))) return undefined;
    const revision = this.disclosedRevision(scope.projectId, scope.snapshots, scope.ids);
    if (!revision) return undefined;
    // Stored Runs are not signed job/input/output disclosure proof. Only the
    // wholly readable record-local execution identity and status are exposed.
    return { protocol: r.protocol, id, projectViewRevisionId: revision.id, status: r.status,
      ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}), ...(r.changeRevisionId ? { changeRevisionId: r.changeRevisionId } : {}) };
  }
  private disclosureMatches(viewId: string, projectionId: string) {
    const view = this.state.projectViews[viewId];
    return !!view && (view.id === projectionId || view.projectionId === projectionId);
  }
  evidence(id: string) {
    const e = this.state.evidence[id];
    const scope = e && this.recordScope(e.projectRevisionId, e.projectViewId, e.changeRevisionId);
    const r = e && this.state.runs[e.runId];
    if (!e || !scope || !r || !this.run(r.id) || r.projectRevisionId !== e.projectRevisionId || r.projectViewId !== e.projectViewId
      || r.changeRevisionId !== e.changeRevisionId || !this.disclosureMatches(e.projectViewId, e.disclosure.projectionId)
      || !this.classification(scope.projectId, e.disclosure.classification, scope.ids)) return undefined;
    return { id, outcome: e.outcome };
  }
  private artifactScope(id: string) {
    const a = this.state.artifacts[id];
    if (!a?.disclosure) return undefined;
    const r = a.runId ? this.state.runs[a.runId] : undefined;
    const change = a.changeRevisionId ? this.state.changeRevisions[a.changeRevisionId] : undefined;
    const viewId = r?.projectViewId ?? change?.projectViewId;
    // Artifact disclosure requires its own producer binding. Unrelated Views
    // sharing a projection label cannot supply or revoke that authority.
    if (!viewId || !this.disclosureMatches(viewId, a.disclosure.projectionId)) return undefined;
    const scope = this.recordScope(a.projectRevisionId, viewId, a.changeRevisionId);
    if (!scope || !this.scopedCapability(scope.projectId, "evidence.read", scope.ids, { ...(scope.changeId ? { changeId: scope.changeId } : {}) })
      || !this.classification(scope.projectId, a.disclosure.classification, scope.ids)
      || (a.runId && (!r || !this.run(r.id) || r.projectRevisionId !== a.projectRevisionId || r.projectViewId !== viewId || r.changeRevisionId !== a.changeRevisionId))) return undefined;
    return scope;
  }
  private artifactProject(id: string) { return this.artifactScope(id)?.projectId; }
  artifact(id: string) { return this.artifactScope(id) ? { id } : undefined; }
  release(id: string, extra: Partial<ResourceRef> = {}) {
    const r = this.state.releases[id];
    if (!r) return undefined;
    const scopes = [
      ...r.evidenceIds.map(e => { const value = this.state.evidence[e]; return value && this.evidence(e) && value.projectRevisionId === r.projectRevisionId ? this.recordScope(value.projectRevisionId, value.projectViewId, value.changeRevisionId) : undefined; }),
      ...[...new Set([...r.artifactIds, ...(r.migrationPlan?.migrationArtifactIds ?? [])])].map(a => { const value = this.state.artifacts[a]; return value && value.projectRevisionId === r.projectRevisionId ? this.artifactScope(a) : undefined; }),
    ];
    if (scopes.some(s => !s || (r.changeRevisionId && s.changeRevisionId !== r.changeRevisionId))) return undefined;
    const canonical = this.state.projectRevisions[r.projectRevisionId];
    const change = r.changeRevisionId ? this.state.changeRevisions[r.changeRevisionId] : undefined;
    const projectId = scopes[0]?.projectId ?? canonical?.projectId ?? (change && this.state.changes[change.changeId]?.projectId);
    if (!projectId || scopes.some(s => s!.projectId !== projectId) || !this.capable(projectId, "target.read", { ...extra, releaseId: id })) return undefined;
    const consistent = new Map<string, string>();
    for (const scope of scopes) for (const source of scope!.ids) {
      const snapshot = scope!.snapshots[source]!;
      if (consistent.has(source) && consistent.get(source) !== snapshot) return undefined;
      consistent.set(source, snapshot);
    }
    const snapshots = scopes.length ? Object.assign({}, ...scopes.map(s => s!.snapshots)) as Record<string, string> : canonical?.sourceSpaceSnapshots ?? change?.sourceSpaceSnapshots;
    if (!snapshots) return undefined;
    const ids = scopes.length ? [...new Set(scopes.flatMap(s => s!.ids))] : Object.keys(snapshots);
    const resource = { ...extra, releaseId: id, ...(change ? { changeId: change.changeId } : {}) };
    if (!this.scopedCapability(projectId, "target.read", ids, resource) || !ids.every(source => this.sourceReadable(projectId, source, resource))) return undefined;
    const revision = this.disclosedRevision(projectId, snapshots, ids);
    return revision && { protocol: r.protocol, id, projectId, projectViewRevisionId: revision.id, status: r.status };
  }
  private promotionClosure(id: string) {
    const p = this.state.promotions[id];
    return !!p && this.release(p.releaseId, { targetId: p.targetId })?.projectId === p.projectId
      && (!p.previousReleaseId || this.release(p.previousReleaseId, { targetId: p.targetId })?.projectId === p.projectId)
      && (!p.expectedCurrentReleaseId || this.release(p.expectedCurrentReleaseId, { targetId: p.targetId })?.projectId === p.projectId);
  }
  target(id: string) {
    const t = this.state.targets[id];
    if (!t || !this.capable(t.projectId, "target.read", { targetId: id })
      || (t.currentReleaseId && this.release(t.currentReleaseId, { targetId: id })?.projectId !== t.projectId)
      || !(t.releaseHistory ?? []).every(r => this.release(r, { targetId: id })?.projectId === t.projectId)
      || (t.lastPromotionId && (!this.promotionClosure(t.lastPromotionId) || this.state.promotions[t.lastPromotionId]?.targetId !== id))) return undefined;
    return { protocol: t.protocol, id, projectId: t.projectId, name: t.name, adapterId: t.adapterId, state: t.state,
      currentReleaseId: t.currentReleaseId ?? null, releaseHistory: [...(t.releaseHistory ?? [])] };
  }
  promotion(id: string) {
    const p = this.state.promotions[id];
    if (!p || !this.promotionClosure(id) || this.target(p.targetId)?.projectId !== p.projectId) return undefined;
    return { protocol: p.protocol, id, projectId: p.projectId, targetId: p.targetId, releaseId: p.releaseId,
      previousReleaseId: p.previousReleaseId, expectedCurrentReleaseId: p.expectedCurrentReleaseId,
      state: p.state, attempt: p.attempt, kind: p.kind };
  }
  mirror(id: string) {
    const m = this.state.mirrors[id];
    if (!m || !this.capable(m.projectId, "project.inspect") || !this.sourceReadable(m.projectId, m.sourceSpaceId)
      || !this.classification(m.projectId, m.disclosure, [m.sourceSpaceId])) return undefined;
    const revision = this.revision(m.canonicalProjectRevisionId, [m.sourceSpaceId]);
    if (!revision || revision.projectId !== m.projectId) return undefined;
    return { protocol: m.protocol, id, projectId: m.projectId, sourceSpaceId: m.sourceSpaceId, provider: m.provider,
      remoteRepository: m.remoteRepository, direction: m.direction, canonicalAuthority: m.canonicalAuthority,
      refMappings: m.refMappings.map(r => ({ localRef: r.localRef, remoteRef: r.remoteRef })), disclosure: m.disclosure,
      state: m.state, projectViewRevisionId: revision.id,
      canonicalRefs: m.canonicalRefs.map(r => ({ name: r.name, oid: r.oid })), remoteRefs: m.remoteRefs.map(r => ({ name: r.name, oid: r.oid })),
      pendingInboundChangeIds: m.pendingInboundChangeIds.filter(c => this.change(c)) };
  }
  mirrors(projectId?: string) { return sorted(Object.values(this.state.mirrors)).filter(m => !projectId || m.projectId === projectId).flatMap(m => { const value = this.mirror(m.id); return value ? [value] : []; }); }
}
