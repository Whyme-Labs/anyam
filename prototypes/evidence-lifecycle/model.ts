/**
 * THROWAWAY LOGIC PROTOTYPE — not production Anyam code.
 *
 * Question: when source, policy, target, or disclosure context changes, can
 * Evidence and approvals become explicitly stale without losing provenance or
 * pretending that a cached result is still valid?
 */

export type EvidenceStatus = "valid" | "stale";
export type Audience = "maintainer" | "public-contributor";
export type Decision = "allow" | "deny" | "indeterminate";

export interface Effect {
  kind: "api" | "database" | "secret-use" | "infrastructure";
  subject: string;
}

export interface Provenance {
  principal: string;
  actor: string;
  session: string;
  task: string;
  model: string;
  runner: string;
  toolchain: string;
}

export interface Evidence {
  id: string;
  run: string;
  sourceRevision: string;
  verifierVersion: string;
  policyVersion: string;
  target: string;
  status: EvidenceStatus;
  invalidatedBy: string[];
  disclosure: "full" | "result-only";
  provenance: Provenance;
}

export interface Approval {
  id: string;
  status: "pending" | "approved" | "stale";
  sourceRevision: string;
  evidenceId: string;
  policyVersion: string;
  target: string;
  approver: string | null;
}

export interface PolicyExplanation {
  decision: Decision;
  blocker: string;
  remediation: string;
  policyVersion: string;
}

export interface EvidenceState {
  sourceRevision: string;
  policyVersion: string;
  target: string;
  verifierVersion: string;
  effects: Effect[];
  evidence: Evidence;
  approval: Approval;
  explanation: PolicyExplanation;
  projection: string;
  lastAction: string;
}

export type EvidenceAction =
  | { type: "source-changed"; revision: string }
  | { type: "policy-changed"; version: string }
  | { type: "target-changed"; target: string }
  | { type: "add-effect"; effect: Effect }
  | { type: "cache-check" }
  | { type: "rerun" }
  | { type: "approve"; approver: string }
  | { type: "disclose"; audience: Audience }
  | { type: "recompute" };

function cloneEvidence(evidence: Evidence): Evidence {
  return { ...evidence, invalidatedBy: [...evidence.invalidatedBy], provenance: { ...evidence.provenance } };
}

function staleEvidence(evidence: Evidence, reason: string): Evidence {
  const next = cloneEvidence(evidence);
  next.status = "stale";
  if (!next.invalidatedBy.includes(reason)) next.invalidatedBy.push(reason);
  return next;
}

function staleApproval(approval: Approval): Approval {
  return { ...approval, status: "stale", approver: null };
}

function explanation(state: EvidenceState): PolicyExplanation {
  const reasons: string[] = [];
  if (state.evidence.status !== "valid") reasons.push(`Evidence ${state.evidence.id} is stale (${state.evidence.invalidatedBy.join(", ")})`);
  if (state.approval.status !== "approved") reasons.push(`approval ${state.approval.id} is ${state.approval.status}`);
  if (state.effects.some((effect) => effect.kind === "database" || effect.kind === "infrastructure")) reasons.push("high-risk effect requires independent review");
  if (reasons.length) return { decision: "deny", blocker: reasons.join("; "), remediation: "rerun the affected Verifier, inspect Evidence, then obtain a fresh independent approval", policyVersion: state.policyVersion };
  return { decision: "allow", blocker: "none", remediation: "Promotion may proceed if the Target health check succeeds", policyVersion: state.policyVersion };
}

export function initialState(): EvidenceState {
  const provenance: Provenance = { principal: "wei", actor: "agent:codex", session: "sess-7", task: "CHG-24", model: "codex", runner: "sandbox/linux-amd64", toolchain: "node@22" };
  return {
    sourceRevision: "main@91bd",
    policyVersion: "policy@18",
    target: "production@rel-24",
    verifierVersion: "compatibility@3",
    effects: [{ kind: "api", subject: "selectCodec()" }],
    evidence: { id: "EV-9", run: "RUN-7", sourceRevision: "main@91bd", verifierVersion: "compatibility@3", policyVersion: "policy@18", target: "production@rel-24", status: "valid", invalidatedBy: [], disclosure: "full", provenance },
    approval: { id: "APR-2", status: "pending", sourceRevision: "main@91bd", evidenceId: "EV-9", policyVersion: "policy@18", target: "production@rel-24", approver: null },
    explanation: { decision: "deny", blocker: "approval APR-2 is pending", remediation: "obtain an independent approval", policyVersion: "policy@18" },
    projection: "maintainer view: full Evidence available",
    lastAction: "created Evidence bound to exact Run inputs",
  };
}

export function reduce(state: EvidenceState, action: EvidenceAction): EvidenceState {
  let next: EvidenceState = { ...state, effects: [...state.effects], evidence: cloneEvidence(state.evidence), approval: { ...state.approval }, explanation: { ...state.explanation } };
  if (action.type === "source-changed") {
    next.sourceRevision = action.revision;
    next.evidence = staleEvidence(next.evidence, `source changed to ${action.revision}`);
    next.approval = staleApproval(next.approval);
    next.lastAction = "changed source revision; invalidated Evidence and approval";
  } else if (action.type === "policy-changed") {
    next.policyVersion = action.version;
    next.evidence = staleEvidence(next.evidence, `policy changed to ${action.version}`);
    next.approval = staleApproval(next.approval);
    next.lastAction = "changed policy; invalidated Evidence and approval";
  } else if (action.type === "target-changed") {
    next.target = action.target;
    next.evidence = staleEvidence(next.evidence, `Target changed to ${action.target}`);
    next.approval = staleApproval(next.approval);
    next.lastAction = "changed Target; invalidated Target-bound Evidence and approval";
  } else if (action.type === "add-effect") {
    next.effects.push(action.effect);
    next.approval = staleApproval(next.approval);
    next.lastAction = `declared ${action.effect.kind} effect; approval must be reconsidered`;
  } else if (action.type === "cache-check") {
    const exact = next.evidence.status === "valid" && next.evidence.sourceRevision === next.sourceRevision && next.evidence.policyVersion === next.policyVersion && next.evidence.target === next.target && next.evidence.verifierVersion === next.verifierVersion;
    next.lastAction = exact ? "cache hit: exact Evidence key can be reused" : "cache miss: Evidence key differs or is stale; a fresh Run is required";
  } else if (action.type === "rerun") {
    const runNumber = Number(next.evidence.run.split("-")[1] ?? "7") + 1;
    const evidenceNumber = Number(next.evidence.id.split("-")[1] ?? "9") + 1;
    next.evidence = { ...next.evidence, id: `EV-${evidenceNumber}`, run: `RUN-${runNumber}`, sourceRevision: next.sourceRevision, policyVersion: next.policyVersion, target: next.target, status: "valid", invalidatedBy: [] };
    next.approval = { ...next.approval, status: "pending", evidenceId: next.evidence.id, sourceRevision: next.sourceRevision, policyVersion: next.policyVersion, target: next.target, approver: null };
    next.lastAction = `completed fresh ${next.evidence.run}; Evidence ${next.evidence.id} is valid`;
  } else if (action.type === "approve") {
    if (next.evidence.status === "valid" && next.approval.status === "pending") {
      next.approval = { ...next.approval, status: "approved", approver: action.approver };
      next.lastAction = `approved exact Evidence ${next.evidence.id} as ${action.approver}`;
    } else next.lastAction = "approval blocked: Evidence is not current or approval is not pending";
  } else if (action.type === "disclose") {
    next.projection = action.audience === "maintainer"
      ? "maintainer view: full Evidence, provenance, and finding detail"
      : "public-contributor view: result-only Evidence; private verifier, inputs, and provenance hidden";
    next.lastAction = `rendered ${action.audience} Disclosure Projection`;
  } else if (action.type === "recompute") {
    next.explanation = explanation(next);
    next.lastAction = `recomputed Policy Explanation: ${next.explanation.decision}`;
  }
  next.explanation = explanation(next);
  return next;
}

