import type { CollaborationPolicyExplanation, LandingAuthority, ReviewApproval } from "../change-control/collaboration.ts";
import { CONTRACT_VERSIONS, createProjectRevision, opaqueId, type Landing } from "../kernel/contracts.ts";
import { AuthorityPlaneError, AUTHORITY_PLANE_PROTOCOL, type AuthorityCommandResult, type AuthorityPlaneSnapshot, type AuthoritySession } from "./authority-plane.ts";
import { AuthoritySQLiteStore } from "./authority-sqlite.ts";

type CohortRequest = Parameters<LandingAuthority["landCohort"]>[0];

export type CohortLandingReview = {
  explanation: CollaborationPolicyExplanation;
  /** Exact Evidence artifacts consumed by the trusted policy evaluation. */
  evidenceIds: readonly string[];
  /** Existing exact Review Approval artifacts, when supplied by the gate. */
  approvals?: readonly ReviewApproval[];
};

function blocked(code: "conflict" | "stale_state" | "indeterminate" | "not_found", detail: string): never {
  throw new AuthorityPlaneError({ code, message: `Cohort Landing was not accepted: ${detail}.`, recoveryAction: "refresh the canonical Project, exact members, review and Evidence; rebase and reverify when stale", receipt: `cohortLanding=not-applied; ${detail}` });
}

/** Internal, trusted adapter; deliberately absent from generic Authority/MCP
 * routes. The caller supplies the existing policy gate, evaluated synchronously
 * on freshly loaded state. This does not enroll or authorize a Landing actor. */
export class SQLiteCohortLandingAuthority implements LandingAuthority {
  constructor(private readonly input: {
    store: AuthoritySQLiteStore;
    session: AuthoritySession;
    projectId: string;
    evaluate: (snapshot: Readonly<AuthorityPlaneSnapshot>, request: Readonly<CohortRequest>) => CohortLandingReview;
  }) {}

  landCohort(request: CohortRequest): Landing {
    const { store, session, projectId } = this.input;
    const previous = store.load(session.realmId);
    if (!previous) blocked("not_found", "Authority snapshot missing");
    if (!request.cohortId.trim() || !request.members.length || new Set(request.members.map((member) => member.changeId)).size !== request.members.length || new Set(request.members.map((member) => member.changeRevisionId)).size !== request.members.length) blocked("conflict", "nonempty unique exact members required");
    const key = `landing.cohort:${request.cohortId}`;
    const fingerprint = JSON.stringify({ projectId, cohortId: request.cohortId, members: request.members, expectedCanonicalProjectRevisionId: request.expectedCanonicalProjectRevisionId });
    const replay = previous.idempotency[key];
    if (replay) {
      if (replay.fingerprint !== fingerprint) blocked("conflict", "cohort identity reused with different selection");
      // A committed historical receipt is returned before evaluating today's
      // policy. Replay cannot create another canonical transition.
      return structuredClone(replay.result.value.landing as Landing);
    }
    const actual = previous.canonicalByProject[projectId];
    if (actual !== request.expectedCanonicalProjectRevisionId) blocked("stale_state", "canonical Project Revision advanced");
    const canonical = previous.projectRevisions[actual];
    const project = previous.projects[projectId];
    if (!project || !canonical || canonical.projectId !== projectId) blocked("indeterminate", "canonical Project lineage incomplete");
    const snapshots = { ...canonical.sourceSpaceSnapshots };
    const updates = new Map<string, string>();
    for (const member of request.members) {
      const change = previous.changes[member.changeId];
      const revision = previous.changeRevisions[member.changeRevisionId];
      if (!change || change.projectId !== projectId || !revision || revision.changeId !== change.id) blocked("not_found", "member Project or Change lineage unavailable");
      if (change.status !== "submitted" || change.latestRevisionId !== revision.id || change.baseProjectRevisionId !== actual || (revision.baseProjectRevisionId ?? revision.projectRevisionId) !== actual) blocked("conflict", "member is not submitted at its latest canonical-base revision");
      if (revision.conflictIds?.length) blocked("conflict", "explicit Conflict resolution is not qualified by this adapter");
      const workspace = change.workspaceId ? previous.workspaces[change.workspaceId] : undefined;
      const view = workspace ? previous.projectViews[workspace.projectViewId] : undefined;
      if (!workspace || !view || workspace.state !== "active" || workspace.changeId !== change.id || revision.workspaceId !== workspace.id || revision.projectViewId !== view.id || workspace.projectRevisionId !== actual || view.projectRevisionId !== actual) blocked("conflict", "member Workspace/View lineage is not ready");
      const entries = Object.entries(revision.sourceSpaceSnapshots ?? {});
      if (!entries.length || entries.length !== view.visibleSourceSpaceIds.length || entries.some(([space, snapshot]) => !project.sourceSpaceIds.includes(space) || !view.visibleSourceSpaceIds.includes(space) || typeof snapshot !== "string" || !snapshot.trim())) blocked("conflict", "member snapshots must exactly match its disclosed View");
      for (const [space, snapshot] of entries) {
        // A member's unchanged View baseline is not an update and must not
        // overwrite another member's changed snapshot during composition.
        if (snapshot === canonical.sourceSpaceSnapshots[space]) continue;
        if (updates.has(space) && updates.get(space) !== snapshot) blocked("conflict", "members propose incompatible snapshots for one Source Space");
        updates.set(space, snapshot);
        snapshots[space] = snapshot;
      }
    }
    // Both arguments are copies: a policy adapter cannot mutate the selection
    // being committed. SQLite's version fence rejects intervening state writes.
    const review = structuredClone(this.input.evaluate(structuredClone(previous), structuredClone(request)));
    const decision = review.explanation;
    if (decision.decision !== "allow" || decision.blockers.length || decision.projectId !== projectId || decision.cohortId !== request.cohortId || decision.baseProjectRevisionId !== actual || decision.currentCanonicalProjectRevisionId !== actual || !decision.id || !decision.policyVersion) blocked("conflict", "fresh exact policy decision required");
    const evidence = review.evidenceIds.map((id) => {
      const record = previous.evidence[id];
      const revision = record?.changeRevisionId ? previous.changeRevisions[record.changeRevisionId] : undefined;
      if (!record || record.outcome !== "passed" || !revision || !request.members.some((member) => member.changeRevisionId === record.changeRevisionId) || record.projectRevisionId !== revision.projectRevisionId || record.projectViewId !== revision.projectViewId) blocked("conflict", "review Evidence artifact missing or bound to a different member");
      return structuredClone(record);
    });
    for (const approval of review.approvals ?? []) {
      if (approval.projectId !== projectId || approval.cohortId !== request.cohortId || approval.policyVersion !== decision.policyVersion || !request.members.some((member) => member.changeId === approval.changeId && member.changeRevisionId === approval.changeRevisionId) || approval.evidenceIds.some((id) => !review.evidenceIds.includes(id))) blocked("conflict", "Review Approval artifact is not bound to this selection and Evidence set");
    }
    const changeIds = request.members.map((member) => member.changeId);
    const revisionIds = request.members.map((member) => member.changeRevisionId);
    const nextRevision = createProjectRevision({ projectId, sourceSpaceSnapshots: snapshots, parentProjectRevisionId: actual, landedChangeRevisionId: revisionIds[0]!, landedChangeRevisionIds: revisionIds, landingCohortId: request.cohortId });
    const landing: Landing = { protocol: CONTRACT_VERSIONS.landing, id: opaqueId("landing"), projectId, changeId: changeIds[0]!, changeRevisionId: revisionIds[0]!, changeIds, changeRevisionIds: revisionIds, cohortId: request.cohortId, previousProjectRevisionId: actual, projectRevisionId: nextRevision.id, receipt: `cohortLanding=accepted; canonicalSelection=sqlite-transaction; gitRefs=derived-not-written; previous=${actual}; next=${nextRevision.id}` };
    const next = structuredClone(previous);
    next.projectRevisions[nextRevision.id] = nextRevision;
    next.canonicalByProject[projectId] = nextRevision.id;
    next.landings[landing.id] = landing;
    for (const id of changeIds) {
      const change = next.changes[id]!;
      next.changes[id] = { ...change, status: "landed" };
      next.workspaces[change.workspaceId!] = { ...next.workspaces[change.workspaceId!]!, state: "closed" };
    }
    next.version += 1;
    const result: AuthorityCommandResult = { protocol: AUTHORITY_PLANE_PROTOCOL, command: "landing.apply", status: "succeeded", version: next.version, value: { landing, canonicalRevision: nextRevision, reviewPacket: { cohortId: request.cohortId, members: structuredClone(request.members), explanation: decision, evidence, approvals: review.approvals ?? [], approvalArtifactCoverage: review.approvals === undefined ? "not-supplied" : "gate-supplied-artifacts", gitProjection: "requires-read-back-and-reconciliation", recoveryLimits: "SQLite selection is atomic; external repositories are repaired separately; provider epoch fencing is unqualified" } }, receipt: landing.receipt };
    next.idempotency[key] = { fingerprint, result };
    next.audit.push({ id: opaqueId("authority-audit"), command: "landing.apply", idempotencyKey: key, actor: { principalId: session.principalId, actorId: session.actorId, sessionId: session.sessionId, clientId: session.clientId }, outcome: "succeeded", stateVersion: next.version, occurredAt: new Date().toISOString(), ...(session.taskId ? { taskId: session.taskId } : {}), ...(session.capabilityGrantId ? { capabilityGrantId: session.capabilityGrantId } : {}), ...(session.delegatedBySessionId ? { delegatedBySessionId: session.delegatedBySessionId } : {}), ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}), receipt: landing.receipt });
    store.commit(previous, next);
    return structuredClone(landing);
  }
}

/** Read-only internal repair plan. It grants no Git credential or write
 * authority. Never interpret this plan as a distributed transaction or fence. */
export function canonicalRefProjectionPlan(input: {
  snapshot: AuthorityPlaneSnapshot;
  projectId: string;
  bindings: readonly { sourceSpaceId: string; repositoryId: string; ref: string; observedOid: string | null }[];
}) {
  const revisionId = input.snapshot.canonicalByProject[input.projectId];
  const revision = revisionId ? input.snapshot.projectRevisions[revisionId] : undefined;
  if (!revision || revision.projectId !== input.projectId) blocked("indeterminate", "canonical projection lineage missing");
  const seen = new Set<string>();
  const refs = input.bindings.map((binding) => {
    const desiredOid = revision.sourceSpaceSnapshots[binding.sourceSpaceId];
    const source = input.snapshot.sourceSpaces[binding.sourceSpaceId];
    if (!desiredOid || !source?.repositoryId || source.repositoryId !== binding.repositoryId || !binding.ref.startsWith("refs/") || /\s/u.test(binding.ref) || seen.has(binding.sourceSpaceId)) blocked("conflict", "projection binding must name one enrolled Project Source Space repository and ref");
    seen.add(binding.sourceSpaceId);
    let ancestor = revision;
    const visited = new Set<string>();
    let known = binding.observedOid === null;
    while (ancestor) {
      if (visited.has(ancestor.id)) blocked("indeterminate", "canonical projection lineage contains a cycle");
      visited.add(ancestor.id);
      if (ancestor.sourceSpaceSnapshots[binding.sourceSpaceId] === binding.observedOid) known = true;
      const parent = ancestor.parentProjectRevisionId;
      if (!parent) break;
      const previous = input.snapshot.projectRevisions[parent];
      if (!previous || previous.projectId !== input.projectId) blocked("indeterminate", "canonical projection ancestor missing");
      ancestor = previous;
    }
    return { ...binding, desiredOid, status: binding.observedOid === desiredOid ? "current" : known ? "pending" : "blocked", expected: { [binding.ref]: binding.observedOid }, desired: { [binding.ref]: desiredOid } };
  });
  return { projectId: input.projectId, projectRevisionId: revision.id, authorityVersion: input.snapshot.version, refs, canonicalWrite: false, externalWrite: false, coverage: "explicit bindings only; undisclosed or unobserved repositories are not qualified", recoveryLimits: "refresh canonical selection before repair and after read-back; CAS is per repository; no monotonic provider epoch fence or distributed Git atomicity" };
}
