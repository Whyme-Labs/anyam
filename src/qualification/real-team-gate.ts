export const REAL_TEAM_GATE_PROTOCOL = "anyam.real-team-adoption-gate/v1" as const;

export type RealTeamReceipt = {
  status: "verified" | "not-verified" | "indeterminate";
  receipt: string;
  observedAt: string;
  owner: string;
  nextAction: string;
};

export type RealTeamGateEvidence = {
  protocol: typeof REAL_TEAM_GATE_PROTOCOL;
  cohort: {
    id: string;
    realmId: string;
    hostingMode: "customer-operated";
    canonicalAuthority: "anyam";
    humanParticipantIds: readonly string[];
    agentProducts: readonly string[];
    startedAt: string;
    endedAt: string;
  };
  changes: {
    terminalCount: number;
    changeIds: readonly string[];
  };
  scenarios: {
    ordinaryGit: RealTeamReceipt;
    concurrentWorkspaces: RealTeamReceipt;
    intentLifecycle: RealTeamReceipt;
    pullRequestLifecycle: RealTeamReceipt;
    reviewAndLanding: RealTeamReceipt;
    conflictAndRebase: RealTeamReceipt;
    hybridProjection: RealTeamReceipt;
    bidirectionalGitHub: RealTeamReceipt;
    exportRestore: RealTeamReceipt;
    noCanonicalWrite: RealTeamReceipt;
  };
  provider: {
    workerReleaseTarget: RealTeamReceipt & { provider: string };
  };
  operations: {
    sustainedLoad: RealTeamReceipt;
    queueRecovery: RealTeamReceipt;
    durableObjectContention: RealTeamReceipt;
    backupRestoreRpoRto: RealTeamReceipt;
    authenticationThrottling: RealTeamReceipt;
    keyRotation: RealTeamReceipt;
    incidentAlerting: RealTeamReceipt;
    independentSecurityReview: RealTeamReceipt;
  };
  retentionDecision: {
    decision: "continue" | "conditional" | "stop";
    recordedAt: string;
    owner: string;
    receipt: string;
    nextAction: string;
  };
};

export type RealTeamGateBlocker = {
  key: string;
  message: string;
  nextAction: string;
};

export type RealTeamGateResult = {
  protocol: typeof REAL_TEAM_GATE_PROTOCOL;
  status: "ready" | "blocked";
  blockers: readonly RealTeamGateBlocker[];
  summary: {
    cohortId?: string;
    humanParticipantCount?: number;
    agentProductCount?: number;
    trialCalendarDays?: number;
    terminalChangeCount?: number;
    verifiedScenarioCount: number;
    requiredScenarioCount: number;
    providerReceipt: "verified" | "not-verified" | "indeterminate";
    verifiedOperationsCount: number;
    requiredOperationsCount: number;
    retentionDecision?: RealTeamGateEvidence["retentionDecision"]["decision"];
  };
  credentialValues: "not-printed";
  canonicalWrite: false;
  receipt: string;
};

const SCENARIO_KEYS = ["ordinaryGit", "concurrentWorkspaces", "intentLifecycle", "pullRequestLifecycle", "reviewAndLanding", "conflictAndRebase", "hybridProjection", "bidirectionalGitHub", "exportRestore", "noCanonicalWrite"] as const;
const OPERATION_KEYS = ["sustainedLoad", "queueRecovery", "durableObjectContention", "backupRestoreRpoRto", "authenticationThrottling", "keyRotation", "incidentAlerting", "independentSecurityReview"] as const;

type ObjectRecord = Record<string, unknown>;

function object(value: unknown): ObjectRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => string(entry) !== undefined) ? value.map((entry) => string(entry) as string) : undefined;
}

function receipt(value: unknown, key: string, blockers: RealTeamGateBlocker[]): RealTeamReceipt | undefined {
  const record = object(value);
  if (!record) {
    blockers.push({ key, message: `${key} must be a receipt object.`, nextAction: `record ${key} with status, receipt, observedAt, owner, and nextAction` });
    return undefined;
  }
  const status = record.status === "verified" || record.status === "not-verified" || record.status === "indeterminate" ? record.status : undefined;
  const receiptValue = string(record.receipt);
  const observedAt = string(record.observedAt);
  const owner = string(record.owner);
  const nextAction = string(record.nextAction);
  if (!status || !receiptValue || !observedAt || !owner || !nextAction) {
    blockers.push({ key, message: `${key} is incomplete.`, nextAction: `record status, receipt, observedAt, owner, and nextAction for ${key}` });
    return undefined;
  }
  if (/(?:token|secret|password|private[_-]?key|bearer\s+)/iu.test(receiptValue)) blockers.push({ key, message: `${key} receipt contains credential-like material.`, nextAction: `replace ${key} with a digest-only credential-free receipt` });
  if (status !== "verified") blockers.push({ key, message: `${key} is ${status}, not verified.`, nextAction });
  return { status, receipt: receiptValue, observedAt, owner, nextAction };
}

function calendarDays(start: string, end: string): number | undefined {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate.getTime() < startDate.getTime()) return undefined;
  const startUtc = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
  const endUtc = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  return Math.floor((endUtc - startUtc) / 86_400_000);
}

function push(blockers: RealTeamGateBlocker[], key: string, message: string, nextAction: string): void {
  blockers.push({ key, message, nextAction });
}

export function validateRealTeamGate(value: unknown): RealTeamGateResult {
  const blockers: RealTeamGateBlocker[] = [];
  const root = object(value);
  if (!root || root.protocol !== REAL_TEAM_GATE_PROTOCOL) push(blockers, "protocol", "The evidence bundle is not anyam.real-team-adoption-gate/v1.", "export the exact real-team evidence bundle with the supported protocol");
  const cohort = object(root?.cohort);
  const cohortId = string(cohort?.id);
  const realmId = string(cohort?.realmId);
  const humans = strings(cohort?.humanParticipantIds);
  const agents = strings(cohort?.agentProducts);
  const startedAt = string(cohort?.startedAt);
  const endedAt = string(cohort?.endedAt);
  if (!cohortId || !realmId || cohort?.hostingMode !== "customer-operated" || cohort?.canonicalAuthority !== "anyam") push(blockers, "cohort.identity", "The gate requires a named customer-operated Realm with Anyam as canonical authority.", "record the customer Realm identity and canonical-authority receipt");
  if (!humans || humans.length < 3 || humans.length > 10) push(blockers, "cohort.humanParticipantIds", `The named cohort must contain 3–10 human participants; observed ${humans?.length ?? 0}.`, "name 3–10 human participants and retain their consent/usage receipts");
  if (!agents || new Set(agents).size < 2) push(blockers, "cohort.agentProducts", `The cohort must use at least two coding-agent products; observed ${agents?.length ?? 0}.`, "record two distinct coding-agent products used on the canonical Anyam path");
  const trialCalendarDays = startedAt && endedAt ? calendarDays(startedAt, endedAt) : undefined;
  if (trialCalendarDays === undefined || trialCalendarDays < 30) push(blockers, "cohort.trialWindow", `The trial must span at least 30 calendar days; observed ${trialCalendarDays ?? "unknown"}.`, "run the named cohort for 30 calendar days and record start/end timestamps");

  const changes = object(root?.changes);
  const terminalCount = typeof changes?.terminalCount === "number" && Number.isSafeInteger(changes.terminalCount) ? changes.terminalCount : undefined;
  const changeIds = strings(changes?.changeIds);
  if (terminalCount === undefined || terminalCount < 25 || !changeIds || changeIds.length < 25) push(blockers, "changes.terminalCount", `The trial requires at least 25 terminal Changes; observed ${terminalCount ?? "unknown"}.`, "record every terminal Change identity and reach at least 25 real Changes");

  const scenarios = object(root?.scenarios);
  let verifiedScenarioCount = 0;
  for (const key of SCENARIO_KEYS) {
    const record = receipt(scenarios?.[key], `scenarios.${key}`, blockers);
    if (record?.status === "verified") verifiedScenarioCount += 1;
  }
  const provider = object(root?.provider);
  const providerReceipt = receipt(provider?.workerReleaseTarget, "provider.workerReleaseTarget", blockers);
  if (providerReceipt && !string(object(provider?.workerReleaseTarget)?.provider)) push(blockers, "provider.workerReleaseTarget.provider", "The Worker Release/Target receipt must name its provider.", "record the customer-owned Cloudflare provider identity without credential material");

  const operations = object(root?.operations);
  let verifiedOperationsCount = 0;
  for (const key of OPERATION_KEYS) {
    const record = receipt(operations?.[key], `operations.${key}`, blockers);
    if (record?.status === "verified") verifiedOperationsCount += 1;
  }
  const retention = object(root?.retentionDecision);
  const retentionDecision = retention?.decision === "continue" ? "continue" as const : retention?.decision === "conditional" ? "conditional" as const : retention?.decision === "stop" ? "stop" as const : undefined;
  if (!retentionDecision || !string(retention?.recordedAt) || !string(retention?.owner) || !string(retention?.receipt) || !string(retention?.nextAction)) push(blockers, "retentionDecision", "The team retention decision is missing or incomplete.", "record the named team's continue, conditional, or stop decision with owner, timestamp, receipt, and next action");
  if (retentionDecision !== "continue") push(blockers, "retentionDecision.decision", `The team retention decision is ${retentionDecision ?? "missing"}; the adoption gate is not ready.`, "obtain an explicit continue decision from the named cohort");

  const summary = { ...(cohortId ? { cohortId } : {}), ...(humans ? { humanParticipantCount: humans.length } : {}), ...(agents ? { agentProductCount: new Set(agents).size } : {}), ...(trialCalendarDays === undefined ? {} : { trialCalendarDays }), ...(terminalCount === undefined ? {} : { terminalChangeCount: terminalCount }), verifiedScenarioCount, requiredScenarioCount: SCENARIO_KEYS.length, providerReceipt: providerReceipt?.status ?? "indeterminate" as const, verifiedOperationsCount, requiredOperationsCount: OPERATION_KEYS.length, ...(retentionDecision ? { retentionDecision } : {}) };
  return { protocol: REAL_TEAM_GATE_PROTOCOL, status: blockers.length === 0 ? "ready" : "blocked", blockers, summary, credentialValues: "not-printed", canonicalWrite: false, receipt: `cohort=${cohortId ?? "missing"}; realm=${realmId ?? "missing"}; humans=${humans?.length ?? "unknown"}; agents=${agents?.length ?? "unknown"}; trialDays=${trialCalendarDays ?? "unknown"}; terminalChanges=${terminalCount ?? "unknown"}; scenarios=${verifiedScenarioCount}/${SCENARIO_KEYS.length}; operations=${verifiedOperationsCount}/${OPERATION_KEYS.length}; provider=${providerReceipt?.status ?? "indeterminate"}; retention=${retentionDecision ?? "missing"}; blockers=${blockers.length}; credentialValues=not-printed; canonicalWrite=false` };
}
