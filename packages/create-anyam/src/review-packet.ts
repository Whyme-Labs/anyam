import type { LocalAgentSession, LocalProposedRevision, LocalReviewFinding, LocalRunObservation } from "./agent.js";

type ReviewPacketInput = {
  change: { id: string; title: string; baseProjectRevisionId: string };
  session: Pick<LocalAgentSession, "id" | "workspaceId" | "actorId" | "taskId" | "grantId">;
  revisions: readonly LocalProposedRevision[];
  runs: readonly LocalRunObservation[];
  findings: readonly LocalReviewFinding[];
  actions: readonly { id: string; contractDigest: string }[];
  verifiers: readonly { id: string; actionId: string; contractDigest: string }[];
};

/** A summary of recorded local observations; it never grants review or Landing authority. */
export function localReviewPacket(input: ReviewPacketInput) {
  const candidate = input.revisions.filter((revision) => revision.changeId === input.change.id
    && revision.workspaceId === input.session.workspaceId && revision.actorId === input.session.actorId).at(-1);
  const runs = input.runs.filter((run) => run.actorId === input.session.actorId
    && run.taskId === input.session.taskId && run.grantId === input.session.grantId);
  const checks = input.actions.map((action) => {
    const run = runs.filter((record) => record.actionId === action.id).at(-1);
    const verifier = run ? input.verifiers.find((record) => record.id === run.verifierId && record.actionId === action.id) : undefined;
    const sourceMismatch = candidate !== undefined && run !== undefined
      && (run.sourceRevision !== candidate.sourceRevision || run.sourceSnapshot !== candidate.sourceSnapshot);
    const contextMatches = candidate && run && !sourceMismatch && run.actionContractDigest === action.contractDigest
      && (input.verifiers.some((record) => record.actionId === action.id)
        ? verifier !== undefined && run.verifierContractDigest === verifier.contractDigest
        : run.verifierId === "verifier:missing" && run.verifierContractDigest === undefined);
    const status = !run ? "missing" : !candidate ? "unbound" : !contextMatches ? "stale" : run.status;
    return {
      actionId: action.id, status, sourceMismatch,
      ...(run ? { runId: run.id, evidenceId: run.evidenceId, evidenceDigest: run.evidenceDigest,
        testedSourceRevision: run.sourceRevision, testedSourceSnapshot: run.sourceSnapshot,
        changeRevisionBinding: "not-recorded",
        actionContractDigest: run.actionContractDigest, verifierId: run.verifierId,
        ...(run.verifierContractDigest ? { verifierContractDigest: run.verifierContractDigest } : {}),
        completedAt: run.completedAt, receipt: run.receipt } : {}),
    };
  });
  return {
    scope: "current-session" as const,
    session: { id: input.session.id, workspaceId: input.session.workspaceId, actorId: input.session.actorId,
      taskId: input.session.taskId, grantId: input.session.grantId },
    change: { id: input.change.id, title: input.change.title, baseProjectRevisionId: input.change.baseProjectRevisionId },
    candidate: candidate ? { id: candidate.id, workspaceId: candidate.workspaceId,
      sourceRepositoryId: candidate.sourceRepositoryId, sourceRevision: candidate.sourceRevision,
      sourceSnapshot: candidate.sourceSnapshot, treeDigest: candidate.treeDigest,
      declaredEffects: [...candidate.declaredEffects] } : null,
    rationale: { status: "unknown", reason: "Rationale is not recorded in local Change metadata." },
    behaviorExample: { status: "unknown", reason: "No behavior example artifact is recorded." },
    diff: { status: "not-recorded", baseProjectRevisionId: input.change.baseProjectRevisionId,
      candidateSourceRevision: candidate?.sourceRevision ?? null },
    checks,
    checkCoverage: "authorized declared Actions; not the full Landing policy",
    statusMeaning: "Local Run outcome matched to recorded source, Action, and Verifier; full Evidence validity is not evaluated.",
    evidenceLimits: "Local Runs record Git source identities, but no Change Revision or declared-effect binding.",
    findings: input.findings.filter((finding) => finding.actorId === input.session.actorId)
      .map((finding) => ({ id: finding.id, severity: finding.severity, summary: finding.summary, revisionBinding: "not-recorded" })),
    decisionsRequired: { status: "unknown", reason: "Local inspection does not evaluate authoritative review or Landing policy." },
    nextSteps: !candidate ? [{ tool: "change.publish_revision", reason: "No candidate is recorded for this session." }]
      : checks.filter((check) => check.status !== "passed").map((check) => check.sourceMismatch
        ? { actionId: check.actionId, reason: "Reconcile the intended source with the recorded candidate; publish if changed, then rerun this Action against that candidate." }
        : { tool: "run.start", actionId: check.actionId, reason: check.status }),
    recoveryLimits: ["Inspection does not perform Landing or recovery.", "Current working tree, full validity inputs, and provider state are not measured by this projection."],
    canonicalWrite: false as const,
  };
}
