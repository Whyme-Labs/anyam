import {
  CONTRACT_VERSIONS,
  opaqueId,
  type Evidence as EvidenceContract,
  type EvidenceOutcome as EvidenceOutcomeContract,
} from "./contracts.ts";

type EvidenceOutcome = EvidenceOutcomeContract;
export type EvidenceRecord = EvidenceContract;

export type EvidenceAppendInput = Omit<EvidenceRecord, "id" | "protocol" | "version" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};

export type EvidenceRequirement = {
  key: string;
  currentValidityKey: string;
  expectedProjectRevisionId?: string;
  expectedProjectViewId?: string;
  expectedChangeRevisionId?: string;
  expectedTargetId?: string;
  expectedDisclosureClassification?: "public" | "project" | "restricted";
};

export type ResidualRisk = {
  id: string;
  description: string;
  owner: string;
  mitigation: string;
  status: "accepted" | "open";
};

export type GateBlocker = {
  stageGate: string;
  evidenceKey: string;
  kind: "missing" | "risk" | EvidenceOutcome;
  message: string;
};

export type StageGateDecision = {
  stageGate: string;
  status: "ready" | "blocked";
  blockers: readonly GateBlocker[];
};

export type RiskSpikeReceipt = {
  id: string;
  question: string;
  receipt: string;
  owner: string;
  decision: "retired" | "fallback" | "accepted";
};

export class EvidenceLedger {
  private readonly records: EvidenceRecord[] = [];

  append(input: EvidenceAppendInput): EvidenceRecord {
    const record: EvidenceRecord = {
      protocol: CONTRACT_VERSIONS.evidence,
      version: "v1",
      ...input,
      id: input.id ?? opaqueId("evidence"),
      createdAt: input.createdAt ?? new Date().toISOString(),
      actor: { ...input.actor },
      disclosure: { ...input.disclosure },
      invalidators: [...input.invalidators],
      inputDigests: [...input.inputDigests],
      effectDigests: [...input.effectDigests],
      producer: { ...input.producer },
    };
    this.records.push(record);
    return this.clone(record);
  }

  list(): readonly EvidenceRecord[] {
    return this.records.map((record) => this.clone(record));
  }

  private clone(record: EvidenceRecord): EvidenceRecord {
    return {
      ...record,
      actor: { ...record.actor },
      disclosure: { ...record.disclosure },
      invalidators: [...record.invalidators],
      inputDigests: [...record.inputDigests],
      effectDigests: [...record.effectDigests],
      producer: { ...record.producer },
      ...(record.sourceSpaceSnapshots ? { sourceSpaceSnapshots: { ...record.sourceSpaceSnapshots } } : {}),
    };
  }
}

export function evaluateStageGate(input: {
  gateId: string;
  requiredEvidence: readonly EvidenceRequirement[];
  evidence: readonly EvidenceRecord[];
  residualRisks?: readonly ResidualRisk[];
}): StageGateDecision {
  const blockers: GateBlocker[] = [];

  for (const requirement of input.requiredEvidence) {
    const record = [...input.evidence].reverse().find((candidate) => candidate.key === requirement.key);
    if (!record) {
      blockers.push({
        stageGate: input.gateId,
        evidenceKey: requirement.key,
        kind: "missing",
        message: `Evidence ${requirement.key} is missing for Stage Gate ${input.gateId}.`,
      });
      continue;
    }

    const contextMismatch = (requirement.expectedProjectRevisionId !== undefined
      && record.projectRevisionId !== requirement.expectedProjectRevisionId)
      || (requirement.expectedProjectViewId !== undefined && record.projectViewId !== requirement.expectedProjectViewId)
      || (requirement.expectedChangeRevisionId !== undefined && record.changeRevisionId !== requirement.expectedChangeRevisionId)
      || (requirement.expectedTargetId !== undefined && record.targetId !== requirement.expectedTargetId)
      || (requirement.expectedDisclosureClassification !== undefined
        && record.disclosure.classification !== requirement.expectedDisclosureClassification);
    const outcome = record.outcome === "passed"
      && (record.validityKey !== requirement.currentValidityKey || contextMismatch)
      ? "stale"
      : record.outcome;
    const normalizedOutcome = outcome === "passed" && (record.receipt.trim().length === 0 || record.owner.trim().length === 0)
      ? "indeterminate"
      : outcome;
    if (normalizedOutcome !== "passed") {
      blockers.push({
        stageGate: input.gateId,
        evidenceKey: requirement.key,
        kind: normalizedOutcome,
        message: `Evidence ${requirement.key} is ${normalizedOutcome} for Stage Gate ${input.gateId}.`,
      });
    }
  }

  for (const risk of input.residualRisks ?? []) {
    if (risk.status === "open" || risk.owner.trim().length === 0) {
      blockers.push({
        stageGate: input.gateId,
        evidenceKey: risk.id,
        kind: "risk",
        message: `Residual Risk ${risk.id} is not accepted by Stage Gate ${input.gateId}; owner and mitigation must be explicit.`,
      });
    }
  }

  return {
    stageGate: input.gateId,
    status: blockers.length === 0 ? "ready" : "blocked",
    blockers,
  };
}
