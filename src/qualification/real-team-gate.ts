import {
  authorityExportDigest,
  authorityExportSigningMessage,
  externalAttestationSigningMessage,
  isRecord,
  realTeamGateBundleDigest,
  realTeamGateSigningMessage,
  REAL_TEAM_GATE_INTEGRITY_PROTOCOL,
  stableJson,
  verifyEd25519Signature,
  type RealTeamAuthorityExport,
  type RealTeamExternalAttestation,
  type RealTeamGateIntegrity,
  type RealTeamGateVerificationOptions,
  type RealTeamTerminalChange,
} from "./real-team-proof.ts";

export type {
  RealTeamAuthorityExport,
  RealTeamExternalAttestation,
  RealTeamGateIntegrity,
  RealTeamGateVerificationOptions,
  RealTeamTerminalChange,
} from "./real-team-proof.ts";

export const REAL_TEAM_GATE_PROTOCOL = "anyam.real-team-adoption-gate/v1" as const;

export type RealTeamReceipt = {
  status: "verified" | "not-verified" | "indeterminate";
  receipt: string;
  observedAt: string;
  owner: string;
  nextAction: string;
};

export type RealTeamProviderReceipt = RealTeamReceipt & {
  provider: string;
  targetId: string;
  releaseId: string;
  operationId: string;
  providerVersionId: string;
  deploymentId: string;
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
  integrity: RealTeamGateIntegrity;
  authorityExport: RealTeamAuthorityExport;
  terminalChanges: readonly RealTeamTerminalChange[];
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
    workerReleaseTarget: RealTeamProviderReceipt;
  };
  externalAttestations: readonly RealTeamExternalAttestation[];
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

export type RealTeamVerificationMode = "bundle-cryptographically-verified" | "authority-and-external-attestations-verified" | "manual-review-only" | "blocked";

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
    verification: RealTeamVerificationMode;
  };
  credentialValues: "not-printed";
  canonicalWrite: false;
  receipt: string;
};

const SCENARIO_KEYS = ["ordinaryGit", "concurrentWorkspaces", "intentLifecycle", "pullRequestLifecycle", "reviewAndLanding", "conflictAndRebase", "hybridProjection", "bidirectionalGitHub", "exportRestore", "noCanonicalWrite"] as const;
const OPERATION_KEYS = ["sustainedLoad", "queueRecovery", "durableObjectContention", "backupRestoreRpoRto", "authenticationThrottling", "keyRotation", "incidentAlerting", "independentSecurityReview"] as const;
type ObjectRecord = Record<string, unknown>;

function object(value: unknown): ObjectRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.map(string);
  return normalized.every((entry): entry is string => entry !== undefined) ? normalized : undefined;
}

function digest(value: unknown): string | undefined {
  const normalized = string(value);
  return normalized && /^sha256:[0-9a-f]{64}$/u.test(normalized) ? normalized : undefined;
}

function utcTimestamp(value: unknown, key: string, blockers: RealTeamGateBlocker[]): number | undefined {
  const normalized = string(value);
  if (!normalized || !normalized.endsWith("Z")) {
    blockers.push({ key, message: `${key} must be a valid UTC ISO timestamp ending in Z.`, nextAction: `record ${key} as a valid UTC ISO-8601 timestamp` });
    return undefined;
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    blockers.push({ key, message: `${key} is not a parseable UTC timestamp.`, nextAction: `replace ${key} with a parseable UTC ISO-8601 timestamp` });
    return undefined;
  }
  return parsed;
}

function receipt(value: unknown, key: string, blockers: RealTeamGateBlocker[], allowedOwners?: ReadonlySet<string>): RealTeamReceipt | undefined {
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
  if (allowedOwners && !allowedOwners.has(owner)) blockers.push({ key: `${key}.owner`, message: `${key} owner ${owner} is not one of the named cohort participants.`, nextAction: `bind ${key}.owner to a named humanParticipantId in the cohort` });
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

function auditEventMatches(input: { snapshot: ObjectRecord; terminal: RealTeamTerminalChange; change: ObjectRecord; revision: ObjectRecord; startedTimestamp: number | undefined; endedTimestamp: number | undefined; blockers: RealTeamGateBlocker[] }): void {
  const { snapshot, terminal, change, revision, blockers } = input;
  const auditEntries = Array.isArray(snapshot.audit) ? snapshot.audit : [];
  const audit = auditEntries.find((value) => object(value)?.id === terminal.auditEventId);
  const auditRecord = object(audit);
  if (!auditRecord) {
    push(blockers, `terminalChanges.${terminal.changeId}.auditEventId`, `Authority export does not contain audit event ${terminal.auditEventId} for Change ${terminal.changeId}.`, "export a fresh signed Authority snapshot containing the terminal Change audit event");
    return;
  }
  const occurredAt = utcTimestamp(auditRecord.occurredAt, `terminalChanges.${terminal.changeId}.auditEventId.occurredAt`, blockers);
  if (occurredAt !== undefined && input.startedTimestamp !== undefined && input.endedTimestamp !== undefined && (occurredAt < input.startedTimestamp || occurredAt > input.endedTimestamp)) push(blockers, `terminalChanges.${terminal.changeId}.auditEventId.occurredAt.window`, `Audit event ${terminal.auditEventId} was recorded outside the completed trial window.`, "export the terminal Change audit event from inside the named trial window");
  if (auditRecord.command !== "landing.apply" && auditRecord.command !== "change.abandon") push(blockers, `terminalChanges.${terminal.changeId}.auditEventId.command`, `Audit event ${terminal.auditEventId} is not a terminal Change transition.`, "bind the terminal Change record to its Landing or abandonment audit event");
  if (terminal.terminalState === "landed") {
    const landings = object(snapshot.landings);
    const landing = Object.values(landings ?? {}).map(object).find((candidate) => candidate?.changeId === terminal.changeId && candidate.changeRevisionId === terminal.revisionId);
    if (!landing || !string(landing.id) || !string(auditRecord.receipt)?.includes(`landing=${landing.id}`)) push(blockers, `terminalChanges.${terminal.changeId}.landing`, `Landed Change ${terminal.changeId} is not bound to a matching Landing and audit receipt.`, "export the signed Authority snapshot with the exact Landing, Change Revision, and audit receipt");
  } else if (string(auditRecord.receipt) && !string(auditRecord.receipt)?.includes(terminal.changeId)) {
    push(blockers, `terminalChanges.${terminal.changeId}.auditEventId.binding`, `Abandoned Change ${terminal.changeId} is not named by its terminal audit receipt.`, "bind the abandonment audit event to the exact Change identity");
  }
  if (change.latestRevisionId !== terminal.revisionId) push(blockers, `terminalChanges.${terminal.changeId}.revisionId.latest`, `Terminal Change ${terminal.changeId} does not point to the supplied latest Revision ${terminal.revisionId}.`, "export the exact terminal Change Revision identity");
  if (revision.changeId !== terminal.changeId) push(blockers, `terminalChanges.${terminal.changeId}.revisionId.binding`, `Revision ${terminal.revisionId} belongs to a different Change.`, "bind each terminal Change to its own Change Revision");
}

function providerPromotionMatches(snapshot: ObjectRecord, provider: { targetId: string; releaseId: string; operationId: string; providerVersionId: string; deploymentId: string }, blockers: RealTeamGateBlocker[]): void {
  const promotions = object(snapshot.promotions);
  const match = Object.values(promotions ?? {}).map(object).find((promotion) => promotion?.targetId === provider.targetId && promotion.releaseId === provider.releaseId && (promotion.providerOperationId === provider.operationId || promotion.rollbackProviderOperationId === provider.operationId) && (promotion.deploymentId === provider.deploymentId || promotion.rollbackDeploymentId === provider.deploymentId));
  if (!match) push(blockers, "provider.workerReleaseTarget.authorityBinding", "The signed Authority export has no Promotion matching the customer provider operation, version, deployment, Target, and Release identities.", "export a fresh Authority snapshot after the verified provider operation and bind all provider identities to one Promotion");
  if (match && !stableJson(match).includes(provider.providerVersionId)) push(blockers, "provider.workerReleaseTarget.providerVersionId", `Provider version ${provider.providerVersionId} is not present in the matching signed Promotion receipt.`, "retain the exact provider version identity in the signed deployment receipt");
}

type ComponentVerification = {
  verified: boolean;
  trustMissing: boolean;
  cryptographicFailure: boolean;
};

type BundleIntegrityVerification = ComponentVerification & {
  present: boolean;
  malformed: boolean;
  bundleDigest?: string;
};

const INTEGRITY_FIELDS = ["protocol", "bundleDigest", "signingKeyId", "signedAt", "signature"] as const;

function hasOwn(value: ObjectRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function unknownFields(value: ObjectRecord, allowed: readonly string[]): readonly string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key)).sort();
}

async function verifyBundleIntegrity(input: {
  value: unknown;
  expectedDigest: string | undefined;
  cohortStarted: number | undefined;
  cohortEnded: number | undefined;
  now: number;
  options: RealTeamGateVerificationOptions;
  blockers: RealTeamGateBlocker[];
}): Promise<BundleIntegrityVerification> {
  const root = object(input.value);
  const present = root !== undefined && hasOwn(root, "integrity");
  if (!present) {
    push(input.blockers, "integrity.missing", "The evidence bundle is missing its full-bundle integrity envelope; component signatures alone are compatibility evidence, not readiness proof.", "compute the canonical bundle digest, bind it to every external attestation, and add the signed integrity envelope");
    return { present: false, malformed: false, verified: false, trustMissing: false, cryptographicFailure: false };
  }
  const integrity = object(root?.integrity);
  if (!integrity) {
    push(input.blockers, "integrity.shape", "The full-bundle integrity envelope must be an object.", "provide exactly protocol, bundleDigest, signingKeyId, signedAt, and signature in integrity");
    return { present: true, malformed: true, verified: false, trustMissing: false, cryptographicFailure: false };
  }
  const extras = unknownFields(integrity, INTEGRITY_FIELDS);
  if (extras.length > 0) {
    push(input.blockers, "integrity.unknownFields", `The full-bundle integrity envelope contains unsupported fields: ${extras.join(", ")}.`, "remove unknown integrity fields and sign the exact supported envelope");
  }
  const protocol = integrity.protocol;
  const bundleDigest = digest(integrity.bundleDigest);
  const signingKeyId = string(integrity.signingKeyId);
  const signedAt = string(integrity.signedAt);
  const signature = string(integrity.signature);
  let malformed = extras.length > 0;
  if (protocol !== REAL_TEAM_GATE_INTEGRITY_PROTOCOL || !bundleDigest || !signingKeyId || !signedAt || !signature) {
    malformed = true;
    push(input.blockers, "integrity.shape", "The full-bundle integrity envelope is incomplete or uses an unsupported protocol.", "provide protocol, bundleDigest, signingKeyId, signedAt, and signature with a sha256 bundle digest");
  }
  const signedTimestamp = utcTimestamp(signedAt, "integrity.signedAt", input.blockers);
  if (signedTimestamp !== undefined && input.cohortStarted !== undefined && input.cohortEnded !== undefined && (signedTimestamp < input.cohortStarted || signedTimestamp > input.cohortEnded)) push(input.blockers, "integrity.signedAt.window", "The full-bundle signature was created outside the completed trial window.", "sign the complete evidence bundle inside the named trial window");
  if (signedTimestamp !== undefined && signedTimestamp > input.now) push(input.blockers, "integrity.signedAt.future", "The full-bundle signature is dated in the future.", "record the actual bundle-signing time");
  if (bundleDigest && input.expectedDigest && bundleDigest !== input.expectedDigest) {
    malformed = true;
    push(input.blockers, "integrity.bundleDigest", "The full-bundle digest does not match the canonical evidence content.", "recompute the digest over the exact evidence bundle, bind attestations to it, and sign again");
  }
  if (protocol === REAL_TEAM_GATE_INTEGRITY_PROTOCOL && bundleDigest && signingKeyId && signedAt && signature && !malformed) {
    const trustedKey = input.options.authoritySigningKeys?.[signingKeyId];
    if (!trustedKey) {
      push(input.blockers, "integrity.signature.trust", `No trusted public key is configured for bundle signing key ${signingKeyId}; this result is manual-review-only.`, "configure the owner-controlled full-bundle public key and rerun cryptographic verification");
      return { present: true, malformed: false, verified: false, trustMissing: true, cryptographicFailure: false, bundleDigest };
    }
    if (!root) return { present: true, malformed: true, verified: false, trustMissing: false, cryptographicFailure: false, bundleDigest };
    const valid = await verifyEd25519Signature({ publicKey: trustedKey, message: realTeamGateSigningMessage(root), signature });
    if (!valid) {
      push(input.blockers, "integrity.signature", "The full-bundle signature is invalid for the trusted signing key.", "sign the unchanged canonical evidence bundle with the configured owner key");
      return { present: true, malformed: false, verified: false, trustMissing: false, cryptographicFailure: true, bundleDigest };
    }
    return { present: true, malformed: false, verified: true, trustMissing: false, cryptographicFailure: false, bundleDigest };
  }
  return { present: true, malformed, verified: false, trustMissing: false, cryptographicFailure: false, ...(bundleDigest ? { bundleDigest } : {}) };
}

async function verifyAuthorityExport(input: {
  value: unknown;
  cohortId: string | undefined;
  realmId: string | undefined;
  startedTimestamp: number | undefined;
  endedTimestamp: number | undefined;
  now: number;
  options: RealTeamGateVerificationOptions;
  blockers: RealTeamGateBlocker[];
}): Promise<{ snapshot?: ObjectRecord; verified: boolean; trustMissing: boolean; cryptographicFailure: boolean }> {
  const authority = object(input.value);
  let trustMissing = false;
  let cryptographicFailure = false;
  let verified = false;
  if (!authority) {
    push(input.blockers, "authorityExport", "A signed Authority export is required; checklist JSON is not readiness proof.", "export the exact customer Realm Authority snapshot and sign it with a trusted Realm export key");
    return { verified, trustMissing: true, cryptographicFailure: false };
  }
  const protocol = authority.protocol;
  const cohortId = string(authority.cohortId);
  const realmId = string(authority.realmId);
  const exportDigest = digest(authority.exportDigest);
  const signingKeyId = string(authority.signingKeyId);
  const exportedAt = string(authority.exportedAt);
  const signature = string(authority.signature);
  const snapshot = object(authority.snapshot);
  if (protocol !== "anyam.real-team-authority-export/v1" || !cohortId || !realmId || !exportDigest || !signingKeyId || !exportedAt || !signature || !snapshot) push(input.blockers, "authorityExport.shape", "The Authority export is missing its signed snapshot envelope fields.", "provide protocol, cohortId, realmId, exportDigest, signingKeyId, exportedAt, snapshot, and signature");
  if (input.cohortId && cohortId && cohortId !== input.cohortId) push(input.blockers, "authorityExport.cohortId", "The signed Authority export belongs to a different cohort.", "export the Authority snapshot for the exact named cohort");
  if (input.realmId && realmId && realmId !== input.realmId) push(input.blockers, "authorityExport.realmId", "The signed Authority export belongs to a different Realm.", "export the Authority snapshot from the named customer-operated Realm");
  if (input.realmId && snapshot && snapshot.realmId !== input.realmId) push(input.blockers, "authorityExport.snapshot.realmId", "The Authority snapshot Realm does not match the named cohort Realm.", "export an unmodified snapshot from the exact Realm");
  if (snapshot && (snapshot.protocol !== "anyam.authority-plane/v1" || !Number.isSafeInteger(snapshot.version) || !Array.isArray(snapshot.audit) || !object(snapshot.changes) || !object(snapshot.changeRevisions) || !object(snapshot.landings) || !object(snapshot.promotions))) push(input.blockers, "authorityExport.snapshot.shape", "The signed Authority export does not contain a complete Authority snapshot and terminal ledger.", "export the complete Authority snapshot including Changes, Change Revisions, Landings, Promotions, and audit events");
  const exportedTimestamp = utcTimestamp(exportedAt, "authorityExport.exportedAt", input.blockers);
  if (exportedTimestamp !== undefined && input.startedTimestamp !== undefined && input.endedTimestamp !== undefined && (exportedTimestamp < input.startedTimestamp || exportedTimestamp > input.endedTimestamp)) push(input.blockers, "authorityExport.exportedAt.window", "The signed Authority export was produced outside the completed trial window.", "export and sign the Authority snapshot inside the named trial window");
  if (exportedTimestamp !== undefined && exportedTimestamp > input.now) push(input.blockers, "authorityExport.exportedAt.future", "The signed Authority export is dated in the future.", "record the actual export time");
  if (snapshot && exportDigest) {
    const actualDigest = await authorityExportDigest(snapshot);
    if (actualDigest !== exportDigest) push(input.blockers, "authorityExport.exportDigest", "The signed Authority export digest does not match its snapshot bytes.", "export a fresh snapshot without modifying the signed contents");
  }
  if (protocol === "anyam.real-team-authority-export/v1" && cohortId && realmId && exportDigest && signingKeyId && exportedAt && signature && snapshot) {
    const trustedKey = input.options.authoritySigningKeys?.[signingKeyId];
    if (!trustedKey) {
      trustMissing = true;
      push(input.blockers, "authorityExport.signature.trust", `No trusted public key is configured for Authority export signing key ${signingKeyId}; this result is manual-review-only.`, "configure the trusted Realm Authority export public key and rerun cryptographic verification");
    } else {
      const unsigned: Omit<RealTeamAuthorityExport, "signature"> = { protocol, cohortId, realmId, exportDigest, signingKeyId, exportedAt, snapshot };
      const valid = await verifyEd25519Signature({ publicKey: trustedKey, message: authorityExportSigningMessage(unsigned), signature });
      if (!valid) {
        cryptographicFailure = true;
        push(input.blockers, "authorityExport.signature", "The Authority export signature is invalid for the trusted signing key.", "export and sign a new Authority snapshot through the Realm recovery/export ceremony");
      } else verified = true;
    }
  } else {
    trustMissing = true;
  }
  return { ...(snapshot ? { snapshot } : {}), verified, trustMissing, cryptographicFailure };
}

async function verifyExternalAttestations(input: {
  value: unknown;
  cohortId: string | undefined;
  realmId: string | undefined;
  humans: readonly string[] | undefined;
  expectedBundleDigest: string | undefined;
  expectedAuthorityExportDigest: string | undefined;
  requireBundleBinding: boolean;
  startedTimestamp: number | undefined;
  endedTimestamp: number | undefined;
  now: number;
  options: RealTeamGateVerificationOptions;
  independentReceipt: RealTeamReceipt | undefined;
  blockers: RealTeamGateBlocker[];
}): Promise<ComponentVerification & { attestationIds: readonly string[] }> {
  let trustMissing = false;
  let cryptographicFailure = false;
  let verified = true;
  const attestationIds: string[] = [];
  if (!Array.isArray(input.value) || input.value.length === 0) {
    push(input.blockers, "externalAttestations", "At least one signed external attestation is required; an in-cohort receipt cannot prove independence.", "obtain an independently signed security-review attestation from outside the trial cohort");
    return { verified: false, trustMissing: true, cryptographicFailure: false, attestationIds };
  }
  for (const [index, value] of input.value.entries()) {
    const key = `externalAttestations[${index}]`;
    const attestation = object(value);
    if (!attestation) {
      push(input.blockers, key, `${key} must be a signed attestation object.`, "record the complete external attestation envelope");
      trustMissing = true;
      verified = false;
      continue;
    }
    const protocol = attestation.protocol;
    const attestationId = string(attestation.attestationId);
    const cohortId = string(attestation.cohortId);
    const realmId = string(attestation.realmId);
    const kind = attestation.kind;
    const reviewerId = string(attestation.reviewerId);
    const reviewerOrganization = string(attestation.reviewerOrganization);
    const reportDigest = digest(attestation.reportDigest);
    const signingKeyId = string(attestation.signingKeyId);
    const signedAt = string(attestation.signedAt);
    const signature = string(attestation.signature);
    if (protocol !== "anyam.real-team-external-attestation/v1" || !attestationId || !cohortId || !realmId || kind !== "independent-security-review" || !reviewerId || !reportDigest || !signingKeyId || !signedAt || !signature) {
      push(input.blockers, `${key}.shape`, `${key} is incomplete or uses an unsupported protocol.`, "provide the exact signed independent-security-review envelope");
      trustMissing = true;
      verified = false;
      continue;
    }
    if (attestationIds.includes(attestationId)) push(input.blockers, `${key}.replay`, `Attestation ${attestationId} is repeated in the evidence bundle.`, "include each signed attestation identity exactly once");
    attestationIds.push(attestationId);
    if (input.cohortId && cohortId !== input.cohortId) push(input.blockers, `${key}.cohortId`, `Attestation ${attestationId} belongs to a different cohort.`, "sign the attestation for the exact named cohort");
    if (input.realmId && realmId !== input.realmId) push(input.blockers, `${key}.realmId`, `Attestation ${attestationId} belongs to a different Realm.`, "sign the attestation for the exact named Realm");
    if (input.humans?.includes(reviewerId)) push(input.blockers, `${key}.reviewerId.independence`, `Reviewer ${reviewerId} is a named trial participant and cannot provide an independent security review.`, "use a reviewer identity outside the trial cohort");
    const signedTimestamp = utcTimestamp(signedAt, `${key}.signedAt`, input.blockers);
    if (signedTimestamp !== undefined && input.startedTimestamp !== undefined && input.endedTimestamp !== undefined && (signedTimestamp < input.startedTimestamp || signedTimestamp > input.endedTimestamp)) push(input.blockers, `${key}.signedAt.window`, `Attestation ${attestationId} was signed outside the completed trial window.`, "obtain the external review during the named trial window");
    if (signedTimestamp !== undefined && signedTimestamp > input.now) push(input.blockers, `${key}.signedAt.future`, `Attestation ${attestationId} is dated in the future.`, "record the actual external signing time");
    if (input.independentReceipt && (!input.independentReceipt.receipt.includes(`attestationId=${attestationId}`) || !input.independentReceipt.receipt.includes(`reportDigest=${reportDigest}`) || !input.independentReceipt.receipt.includes(`reviewerId=${reviewerId}`))) push(input.blockers, `${key}.operationBinding`, `The independent-security-review operation receipt does not name attestation ${attestationId}, reviewer ${reviewerId}, and report ${reportDigest}.`, "record the exact external attestation identities in the operation receipt");
    const declaredBundleDigest = digest(attestation.bundleDigest);
    const declaredAuthorityExportDigest = digest(attestation.authorityExportDigest);
    if (input.requireBundleBinding && (!declaredBundleDigest || !declaredAuthorityExportDigest)) {
      push(input.blockers, `${key}.bundleBinding`, `The current attestation contract requires bundleDigest and authorityExportDigest for ${attestationId}.`, "bind the external attestation to the exact full-bundle and Authority export digests before signing it");
    }
    if (declaredBundleDigest && input.expectedBundleDigest && declaredBundleDigest !== input.expectedBundleDigest) push(input.blockers, `${key}.bundleDigest`, `Attestation ${attestationId} names a different readiness bundle digest.`, "sign the attestation for the exact canonical readiness bundle");
    if (declaredAuthorityExportDigest && input.expectedAuthorityExportDigest && declaredAuthorityExportDigest !== input.expectedAuthorityExportDigest) push(input.blockers, `${key}.authorityExportDigest`, `Attestation ${attestationId} names a different Authority export digest.`, "sign the attestation for the exact Authority export used by the readiness bundle");
    const trustedKey = input.options.attestationSigningKeys?.[signingKeyId];
    if (!trustedKey) {
      trustMissing = true;
      verified = false;
      push(input.blockers, `${key}.signature.trust`, `No trusted public key is configured for attestation signing key ${signingKeyId}; this result is manual-review-only.`, "configure the independent reviewer public key and rerun cryptographic verification");
      continue;
    }
    const unsigned: Omit<RealTeamExternalAttestation, "signature"> = { protocol, attestationId, cohortId, realmId, kind, reviewerId, ...(reviewerOrganization ? { reviewerOrganization } : {}), reportDigest, signingKeyId, signedAt, ...(declaredBundleDigest ? { bundleDigest: declaredBundleDigest } : {}), ...(declaredAuthorityExportDigest ? { authorityExportDigest: declaredAuthorityExportDigest } : {}) };
    const valid = await verifyEd25519Signature({ publicKey: trustedKey, message: externalAttestationSigningMessage(unsigned), signature });
    if (!valid) {
      cryptographicFailure = true;
      verified = false;
      push(input.blockers, `${key}.signature`, `Attestation ${attestationId} has an invalid signature.`, "obtain a fresh signature from the enrolled independent reviewer key");
    }
  }
  return { verified, trustMissing, cryptographicFailure, attestationIds };
}

function validateTerminalChanges(input: {
  value: unknown;
  changeIds: readonly string[] | undefined;
  snapshot: ObjectRecord | undefined;
  startedTimestamp: number | undefined;
  endedTimestamp: number | undefined;
  blockers: RealTeamGateBlocker[];
}): void {
  if (!Array.isArray(input.value)) {
    push(input.blockers, "terminalChanges", "A signed terminal Change list is required; a terminal count alone is not evidence.", "record one audit- and revision-bound terminal Change entry for every named Change");
    return;
  }
  const seen = new Set<string>();
  for (const [index, value] of input.value.entries()) {
    const key = `terminalChanges[${index}]`;
    const record = object(value);
    const changeId = string(record?.changeId);
    const terminalState = record?.terminalState === "landed" || record?.terminalState === "abandoned" ? record.terminalState : undefined;
    const auditEventId = string(record?.auditEventId);
    const revisionId = string(record?.revisionId);
    if (!changeId || !terminalState || !auditEventId || !revisionId) {
      push(input.blockers, `${key}.shape`, `${key} must name changeId, landed/abandoned terminalState, auditEventId, and revisionId.`, "export the exact terminal Change identity, terminal audit event, and latest Revision");
      continue;
    }
    if (seen.has(changeId)) push(input.blockers, `${key}.duplicate`, `Terminal Change ${changeId} is repeated.`, "include each terminal Change exactly once");
    seen.add(changeId);
    const terminal: RealTeamTerminalChange = { changeId, terminalState, auditEventId, revisionId };
    if (!input.snapshot) continue;
    const changes = object(input.snapshot.changes);
    const change = object(changes?.[changeId]);
    const revisions = object(input.snapshot.changeRevisions);
    const revision = object(revisions?.[revisionId]);
    if (!change) {
      push(input.blockers, `${key}.changeId`, `Signed Authority export does not contain terminal Change ${changeId}.`, "export a fresh signed Authority snapshot containing every named terminal Change");
      continue;
    }
    if (change.status !== terminalState) push(input.blockers, `${key}.terminalState`, `Change ${changeId} is ${String(change.status)} in the signed export, not ${terminalState}.`, "bind terminalState to the exported Change status");
    if (!revision) {
      push(input.blockers, `${key}.revisionId`, `Signed Authority export does not contain Revision ${revisionId} for Change ${changeId}.`, "export the exact Change Revision referenced by the terminal Change");
      continue;
    }
    auditEventMatches({ snapshot: input.snapshot, terminal, change, revision, startedTimestamp: input.startedTimestamp, endedTimestamp: input.endedTimestamp, blockers: input.blockers });
  }
  if (input.changeIds) {
    const expected = new Set(input.changeIds);
    for (const changeId of expected) if (!seen.has(changeId)) push(input.blockers, "terminalChanges.missing", `Named terminal Change ${changeId} has no signed terminal Change entry.`, "record the audit and Revision identities for every named terminal Change");
    for (const changeId of seen) if (!expected.has(changeId)) push(input.blockers, "terminalChanges.extra", `Terminal Change ${changeId} is not present in changes.changeIds.`, "keep the named Change list and signed terminal Change list identical");
  }
}

export async function validateRealTeamGate(value: unknown, options: RealTeamGateVerificationOptions = {}): Promise<RealTeamGateResult> {
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
  if (humans && new Set(humans).size !== humans.length) push(blockers, "cohort.humanParticipantIds.unique", "The named cohort contains duplicate human participant identities.", "record each human participant exactly once with a stable identity");
  if (!agents || new Set(agents).size < 2) push(blockers, "cohort.agentProducts", `The cohort must use at least two coding-agent products; observed ${agents?.length ?? 0}.`, "record two distinct coding-agent products used on the canonical Anyam path");
  const allowedOwners = humans && humans.length > 0 ? new Set(humans) : undefined;
  const startedTimestamp = startedAt ? utcTimestamp(startedAt, "cohort.startedAt", blockers) : undefined;
  const endedTimestamp = endedAt ? utcTimestamp(endedAt, "cohort.endedAt", blockers) : undefined;
  const trialCalendarDays = startedAt && endedAt ? calendarDays(startedAt, endedAt) : undefined;
  if (trialCalendarDays === undefined || trialCalendarDays < 30) push(blockers, "cohort.trialWindow", `The trial must span at least 30 calendar days; observed ${trialCalendarDays ?? "unknown"}.`, "run the named cohort for 30 calendar days and record start/end timestamps");
  const now = options.now?.() ?? Date.now();
  if (startedTimestamp !== undefined && startedTimestamp > now) push(blockers, "cohort.startedAt.future", "The trial start is in the future.", "record the actual UTC trial start time after the trial begins");
  if (endedTimestamp !== undefined && endedTimestamp > now) push(blockers, "cohort.endedAt.future", "The trial end is in the future, so the adoption gate cannot be complete.", "run the trial to completion and record an endedAt timestamp no later than the current time");

  const expectedBundleDigest = root ? await realTeamGateBundleDigest(root) : undefined;
  const bundleIntegrity = await verifyBundleIntegrity({ value: root, expectedDigest: expectedBundleDigest, cohortStarted: startedTimestamp, cohortEnded: endedTimestamp, now, options, blockers });

  const changes = object(root?.changes);
  const terminalCount = typeof changes?.terminalCount === "number" && Number.isSafeInteger(changes.terminalCount) ? changes.terminalCount : undefined;
  const changeIds = strings(changes?.changeIds);
  if (terminalCount === undefined || terminalCount < 25 || !changeIds || changeIds.length < 25) push(blockers, "changes.terminalCount", `The trial requires at least 25 terminal Changes; observed ${terminalCount ?? "unknown"}.`, "record every terminal Change identity and reach at least 25 real Changes");
  if (changeIds && new Set(changeIds).size !== changeIds.length) push(blockers, "changes.changeIds.unique", "The terminal Change list contains duplicate identities.", "record each terminal Change ID exactly once");
  if (terminalCount !== undefined && changeIds && terminalCount !== changeIds.length) push(blockers, "changes.terminalCount.consistency", `terminalCount=${terminalCount} does not equal the number of named Change IDs=${changeIds.length}.`, "make terminalCount equal the exact number of unique named terminal Change IDs");

  const authority = await verifyAuthorityExport({ value: root?.authorityExport, cohortId, realmId, startedTimestamp, endedTimestamp, now, options, blockers });
  validateTerminalChanges({ value: root?.terminalChanges, changeIds, snapshot: authority.snapshot, startedTimestamp, endedTimestamp, blockers });

  const scenarios = object(root?.scenarios);
  let verifiedScenarioCount = 0;
  for (const key of SCENARIO_KEYS) {
    const scenarioReceipt = receipt(scenarios?.[key], `scenarios.${key}`, blockers, allowedOwners);
    if (scenarioReceipt?.status === "verified") verifiedScenarioCount += 1;
    if (scenarioReceipt && startedTimestamp !== undefined && endedTimestamp !== undefined) {
      const observedAt = utcTimestamp(scenarioReceipt.observedAt, `scenarios.${key}.observedAt`, blockers);
      if (observedAt !== undefined && (observedAt < startedTimestamp || observedAt > endedTimestamp)) push(blockers, `scenarios.${key}.observedAt.window`, `${key} was observed outside the completed trial window.`, `record ${key}.observedAt between cohort.startedAt and cohort.endedAt`);
    }
  }
  const provider = object(root?.provider);
  const providerRecord = object(provider?.workerReleaseTarget);
  const providerReceipt = receipt(providerRecord, "provider.workerReleaseTarget", blockers, allowedOwners);
  const providerName = string(providerRecord?.provider);
  const targetId = string(providerRecord?.targetId);
  const releaseId = string(providerRecord?.releaseId);
  const operationId = string(providerRecord?.operationId);
  const providerVersionId = string(providerRecord?.providerVersionId);
  const deploymentId = string(providerRecord?.deploymentId);
  if (!targetId || !releaseId || !operationId || !providerVersionId || !deploymentId) push(blockers, "provider.workerReleaseTarget.identity", "The Worker provider receipt must name Target, Release, provider operation, provider version, and deployment identities.", "retain all provider identities in the customer-owned Worker qualification receipt");
  if (providerReceipt && providerName !== "cloudflare-workers") push(blockers, "provider.workerReleaseTarget.provider", `The Worker Release/Target receipt provider must be cloudflare-workers; observed ${providerName ?? "missing"}.`, "record the customer-operated Cloudflare Worker provider receipt without credential material");
  if (providerReceipt && targetId && releaseId && operationId && providerVersionId && deploymentId) {
    const identityFields: readonly [string, string][] = [["targetId", targetId], ["releaseId", releaseId], ["operationId", operationId], ["providerVersionId", providerVersionId], ["deploymentId", deploymentId]];
    for (const [field, identity] of identityFields) if (!providerReceipt.receipt.includes(`${field}=${identity}`)) push(blockers, `provider.workerReleaseTarget.receipt.${field}`, `The provider receipt does not repeat its declared ${field} identity.`, `record ${field}=${identity} in the credential-free provider receipt`);
    if (authority.snapshot) providerPromotionMatches(authority.snapshot, { targetId, releaseId, operationId, providerVersionId, deploymentId }, blockers);
    else push(blockers, "provider.workerReleaseTarget.authorityExport", "Provider identity closure cannot be checked without the signed Authority export.", "provide the signed Authority export alongside the provider receipt");
  }
  if (providerReceipt && startedTimestamp !== undefined && endedTimestamp !== undefined) {
    const observedAt = utcTimestamp(providerReceipt.observedAt, "provider.workerReleaseTarget.observedAt", blockers);
    if (observedAt !== undefined && (observedAt < startedTimestamp || observedAt > endedTimestamp)) push(blockers, "provider.workerReleaseTarget.observedAt.window", "The Worker Release/Target receipt was observed outside the completed trial window.", "record the provider observation inside the named trial window");
  }

  const operations = object(root?.operations);
  let verifiedOperationsCount = 0;
  const operationReceipts: Partial<Record<(typeof OPERATION_KEYS)[number], RealTeamReceipt>> = {};
  for (const key of OPERATION_KEYS) {
    const operationReceipt = receipt(operations?.[key], `operations.${key}`, blockers, allowedOwners);
    if (operationReceipt?.status === "verified") verifiedOperationsCount += 1;
    if (operationReceipt) operationReceipts[key] = operationReceipt;
    if (operationReceipt && startedTimestamp !== undefined && endedTimestamp !== undefined) {
      const observedAt = utcTimestamp(operationReceipt.observedAt, `operations.${key}.observedAt`, blockers);
      if (observedAt !== undefined && (observedAt < startedTimestamp || observedAt > endedTimestamp)) push(blockers, `operations.${key}.observedAt.window`, `${key} was observed outside the completed trial window.`, `record ${key} between cohort.startedAt and cohort.endedAt`);
    }
  }
  const authorityExportValue = object(root?.authorityExport);
  const expectedAuthorityExportDigest = digest(authorityExportValue?.exportDigest);
  const attestationVerification = await verifyExternalAttestations({ value: root?.externalAttestations, cohortId, realmId, humans, expectedBundleDigest, expectedAuthorityExportDigest, requireBundleBinding: bundleIntegrity.present, startedTimestamp, endedTimestamp, now, options, independentReceipt: operationReceipts.independentSecurityReview, blockers });
  const retention = object(root?.retentionDecision);
  const retentionDecision = retention?.decision === "continue" ? "continue" as const : retention?.decision === "conditional" ? "conditional" as const : retention?.decision === "stop" ? "stop" as const : undefined;
  if (!retentionDecision || !string(retention?.recordedAt) || !string(retention?.owner) || !string(retention?.receipt) || !string(retention?.nextAction)) push(blockers, "retentionDecision", "The team retention decision is missing or incomplete.", "record the named team's continue, conditional, or stop decision with owner, timestamp, receipt, and next action");
  const retentionOwner = string(retention?.owner);
  if (allowedOwners && retentionOwner && !allowedOwners.has(retentionOwner)) push(blockers, "retentionDecision.owner", `The retention decision owner ${retentionOwner} is not a named cohort participant.`, "bind retentionDecision.owner to a named humanParticipantId in the cohort");
  const retentionRecordedAt = retention?.recordedAt ? utcTimestamp(retention.recordedAt, "retentionDecision.recordedAt", blockers) : undefined;
  if (retentionRecordedAt !== undefined && endedTimestamp !== undefined && retentionRecordedAt < endedTimestamp) push(blockers, "retentionDecision.recordedAt.window", "The retention decision was recorded before the trial ended.", "record the retention decision after the completed trial window");
  if (retentionRecordedAt !== undefined && retentionRecordedAt > now) push(blockers, "retentionDecision.recordedAt.future", "The retention decision is in the future.", "record the retention decision at or before the current UTC time");
  if (/(?:token|secret|password|private[_-]?key|bearer\s+)/iu.test(string(retention?.receipt) ?? "")) push(blockers, "retentionDecision.receipt", "The retention receipt contains credential-like material.", "replace the retention receipt with a credential-free digest-only receipt");
  if (retentionDecision !== "continue") push(blockers, "retentionDecision.decision", `The team retention decision is ${retentionDecision ?? "missing"}; the adoption gate is not ready.`, "obtain an explicit continue decision from the named cohort");

  const cryptographicFailure = authority.cryptographicFailure || attestationVerification.cryptographicFailure || bundleIntegrity.cryptographicFailure;
  const trustMissing = authority.trustMissing || attestationVerification.trustMissing || bundleIntegrity.trustMissing;
  const componentSignaturesVerified = authority.verified && attestationVerification.verified;
  const verification: RealTeamVerificationMode = cryptographicFailure || bundleIntegrity.malformed ? "blocked" : bundleIntegrity.verified ? "bundle-cryptographically-verified" : componentSignaturesVerified ? "authority-and-external-attestations-verified" : trustMissing ? "manual-review-only" : "blocked";
  const summary = { ...(cohortId ? { cohortId } : {}), ...(humans ? { humanParticipantCount: humans.length } : {}), ...(agents ? { agentProductCount: new Set(agents).size } : {}), ...(trialCalendarDays === undefined ? {} : { trialCalendarDays }), ...(terminalCount === undefined ? {} : { terminalChangeCount: terminalCount }), verifiedScenarioCount, requiredScenarioCount: SCENARIO_KEYS.length, providerReceipt: providerReceipt?.status ?? "indeterminate" as const, verifiedOperationsCount, requiredOperationsCount: OPERATION_KEYS.length, ...(retentionDecision ? { retentionDecision } : {}), verification };
  return { protocol: REAL_TEAM_GATE_PROTOCOL, status: blockers.length === 0 && verification === "bundle-cryptographically-verified" ? "ready" : "blocked", blockers, summary, credentialValues: "not-printed", canonicalWrite: false, receipt: `cohort=${cohortId ?? "missing"}; realm=${realmId ?? "missing"}; humans=${humans?.length ?? "unknown"}; agents=${agents?.length ?? "unknown"}; trialDays=${trialCalendarDays ?? "unknown"}; terminalChanges=${terminalCount ?? "unknown"}; scenarios=${verifiedScenarioCount}/${SCENARIO_KEYS.length}; operations=${verifiedOperationsCount}/${OPERATION_KEYS.length}; provider=${providerReceipt?.status ?? "indeterminate"}; retention=${retentionDecision ?? "missing"}; verification=${verification}; bundleDigest=${bundleIntegrity.bundleDigest ?? "missing"}; externalAttestations=${attestationVerification.attestationIds.length}; blockers=${blockers.length}; credentialValues=not-printed; canonicalWrite=false` };
}
