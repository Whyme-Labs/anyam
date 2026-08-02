/**
 * PROTOTYPE — Phased delivery program state model.
 *
 * Question: can Anyam move through dependency-ordered stages using explicit
 * evidence and retired risk spikes, without relying on calendar promises?
 *
 * This module is intentionally small and pure. The terminal shell in
 * `index.ts` is disposable; this reducer and its gate calculations are the
 * part worth carrying into the real planning tooling.
 */

export type StageId = "K0" | "alpha" | "beta" | "expansion";
export type StageStatus = "pending" | "active" | "complete";
export type EvidenceState = "missing" | "accepted";
export type RiskState = "open" | "retired";

export type EvidenceItem = { id: string; label: string };
export type RiskSpike = { id: string; question: string };

export type DeliveryStage = {
  id: StageId;
  title: string;
  dependsOn: StageId[];
  owner: string;
  staffing: string;
  workstreams: string[];
  integrations: string[];
  evidence: EvidenceItem[];
  risks: RiskSpike[];
};

export type PlanState = {
  stages: Record<StageId, StageStatus>;
  evidence: Record<string, EvidenceState>;
  risks: Record<string, RiskState>;
  message: string;
};

export type Action =
  | { type: "start"; stage: StageId }
  | { type: "acceptEvidence"; key: string }
  | { type: "retireRisk"; key: string }
  | { type: "promote"; stage: StageId }
  | { type: "reset" };

export const stageOrder: StageId[] = ["K0", "alpha", "beta", "expansion"];

export const deliveryStages: DeliveryStage[] = [
  {
    id: "K0",
    title: "Open-source TypeScript kernel",
    dependsOn: [],
    owner: "kernel lead",
    staffing: "1–2 engineers; part-time design and security review",
    workstreams: ["project/change model", "CLI + scaffold", "Git/driver boundary", "local evidence"],
    integrations: ["TypeScript toolchain", "generic Git remote"],
    evidence: [
      { id: "local-loop", label: "scaffold → init → check → Change works locally" },
      { id: "git-roundtrip", label: "clone/fetch/push round-trip preserves Git objects" },
      { id: "agent-loop", label: "local MCP/agent session publishes a non-canonical revision" },
    ],
    risks: [
      { id: "r-kernel-model", question: "Does the Project/Change model stay smaller than a GitHub clone?" },
      { id: "r-provider-boundary", question: "Can the kernel run without assuming Cloudflare Artifacts?" },
    ],
  },
  {
    id: "alpha",
    title: "Customer-operated Cloudflare private alpha",
    dependsOn: ["K0"],
    owner: "platform lead",
    staffing: "2–3 engineers; explicit operator for recovery drills",
    workstreams: ["Realm + auth", "Cloudflare control plane", "Worker/CLI fixtures", "Evidence + Landing"],
    integrations: ["Workers/DO/D1/R2", "Queues/Workflows", "Sandbox or bounded runner"],
    evidence: [
      { id: "worker-release", label: "Worker fixture reaches preview → Release → Promotion" },
      { id: "cli-release", label: "TypeScript CLI/library produces a typed release artifact" },
      { id: "hybrid-source", label: "public projection hides private codec Source Space" },
      { id: "import-recovery", label: "failed import resumes from a Recovery Checkpoint" },
      { id: "rollback", label: "promotion health failure keeps prior Release live" },
    ],
    risks: [
      { id: "r-artifacts", question: "Is the chosen repository driver qualified, or can restore use a fallback?" },
      { id: "r-canonical-write", question: "Can no agent or user bypass Landing for canonical mutation?" },
      { id: "r-source-disclosure", question: "Does a public projection leak private graph metadata?" },
    ],
  },
  {
    id: "beta",
    title: "Public beta with team adoption",
    dependsOn: ["alpha"],
    owner: "product lead",
    staffing: "3–5 engineers; support and documentation capacity",
    workstreams: ["multi-Realm tenancy", "team review/policy", "bidirectional mirrors", "runner/target adapters"],
    integrations: ["GitHub mirror", "one external Runner", "npm + generic release target"],
    evidence: [
      { id: "team-review", label: "two Actors complete a Change with policy-aware review" },
      { id: "mirror-roundtrip", label: "GitHub two-way mirror conflict is explicit and recoverable" },
      { id: "external-runner", label: "external Runner executes an immutable, scoped job" },
      { id: "customer-install", label: "new customer-operated Realm restores without Anyam service access" },
    ],
    risks: [
      { id: "r-mirror-authority", question: "Can two-way mirrors preserve one explicit canonical authority?" },
      { id: "r-tenant-isolation", question: "Are Realm and Source Space boundaries observable under concurrency?" },
    ],
  },
  {
    id: "expansion",
    title: "Open ecosystem and governance expansion",
    dependsOn: ["beta"],
    owner: "ecosystem lead",
    staffing: "Dedicated maintainers added only after beta receipts",
    workstreams: ["extension ecosystem", "Governance Profiles", "project-type adapters", "federation/discovery"],
    integrations: ["SAML/SCIM", "specialized Runners", "package/model/device Targets"],
    evidence: [
      { id: "extension-trust", label: "third-party adapter cannot gain authority beyond its grant" },
      { id: "governance-portable", label: "Governance Profile exports and replays on customer Realm" },
      { id: "project-adapter", label: "one non-web adapter completes source → artifact → Target" },
    ],
    risks: [
      { id: "r-ecosystem-drift", question: "Can extensions evolve without fragmenting the kernel contracts?" },
      { id: "r-governance-claims", question: "Can Anyam prove controls without making certification claims?" },
    ],
  },
];

const stageById = Object.fromEntries(deliveryStages.map((stage) => [stage.id, stage])) as Record<StageId, DeliveryStage>;

export function evidenceKey(stage: StageId, item: EvidenceItem): string {
  return `${stage}:${item.id}`;
}

export function riskKey(stage: StageId, risk: RiskSpike): string {
  return `${stage}:${risk.id}`;
}

export function initialState(): PlanState {
  const evidence: Record<string, EvidenceState> = {};
  const risks: Record<string, RiskState> = {};
  for (const current of deliveryStages) {
    for (const item of current.evidence) evidence[evidenceKey(current.id, item)] = "missing";
    for (const risk of current.risks) risks[riskKey(current.id, risk)] = "open";
  }
  return {
    stages: { K0: "pending", alpha: "pending", beta: "pending", expansion: "pending" },
    evidence,
    risks,
    message: "No stage is active. Start K0, then retire risks and collect evidence.",
  };
}

function prerequisitesComplete(state: PlanState, current: DeliveryStage): boolean {
  return current.dependsOn.every((id) => state.stages[id] === "complete");
}

export function gateBlockers(state: PlanState, stageId: StageId): string[] {
  const current = stageById[stageId];
  const blockers: string[] = [];
  for (const dependency of current.dependsOn) {
    if (state.stages[dependency] !== "complete") blockers.push(`dependency ${dependency} is ${state.stages[dependency]}`);
  }
  for (const item of current.evidence) {
    if (state.evidence[evidenceKey(stageId, item)] !== "accepted") blockers.push(`evidence missing: ${item.id}`);
  }
  for (const risk of current.risks) {
    if (state.risks[riskKey(stageId, risk)] !== "retired") blockers.push(`risk open: ${risk.id}`);
  }
  return blockers;
}

export function criticalPath(state: PlanState): StageId[] {
  return stageOrder.filter((stageId) => state.stages[stageId] !== "complete");
}

export function reduce(state: PlanState, action: Action): PlanState {
  if (action.type === "reset") return initialState();
  const next: PlanState = {
    stages: { ...state.stages },
    evidence: { ...state.evidence },
    risks: { ...state.risks },
    message: state.message,
  };

  if (action.type === "start") {
    const current = stageById[action.stage];
    if (!prerequisitesComplete(state, current)) {
      next.message = `Cannot start ${action.stage}: ${gateBlockers(state, action.stage).filter((item) => item.startsWith("dependency")).join(", ")}.`;
      return next;
    }
    next.stages[action.stage] = "active";
    next.message = `${action.stage} is active. Collect evidence and retire its risk spikes.`;
    return next;
  }

  if (action.type === "acceptEvidence") {
    if (!(action.key in next.evidence)) {
      next.message = `Unknown evidence key ${action.key}. Use stage:item from the list.`;
      return next;
    }
    next.evidence[action.key] = "accepted";
    next.message = `Accepted ${action.key}. The receipt is now part of the gate state.`;
    return next;
  }

  if (action.type === "retireRisk") {
    if (!(action.key in next.risks)) {
      next.message = `Unknown risk key ${action.key}. Use stage:risk from the list.`;
      return next;
    }
    next.risks[action.key] = "retired";
    next.message = `Retired ${action.key}. Record the actual spike receipt in the durable plan.`;
    return next;
  }

  if (action.type === "promote") {
    if (state.stages[action.stage] !== "active") {
      next.message = `Cannot promote ${action.stage}: stage must be active first.`;
      return next;
    }
    const blockers = gateBlockers(state, action.stage);
    if (blockers.length > 0) {
      next.message = `Gate blocked for ${action.stage}: ${blockers.join("; ")}.`;
      return next;
    }
    next.stages[action.stage] = "complete";
    const nextStage = stageOrder[stageOrder.indexOf(action.stage) + 1];
    next.message = nextStage
      ? `${action.stage} complete. Critical path now points to ${nextStage}.`
      : `${action.stage} complete. The current program has no remaining stage.`;
    return next;
  }

  return next;
}

export function resolveKey(input: string): { kind: "evidence" | "risk"; key: string } | null {
  const [stage, id] = input.split(":");
  if (!stage || !id || !stageOrder.includes(stage as StageId)) return null;
  const current = stageById[stage as StageId];
  if (current.evidence.some((item) => item.id === id)) return { kind: "evidence", key: input };
  if (current.risks.some((risk) => risk.id === id)) return { kind: "risk", key: input };
  return null;
}

export function stage(id: StageId): DeliveryStage {
  return stageById[id];
}
