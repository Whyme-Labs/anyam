import { AUTHORITY_COMMAND_PROTOCOL, type AuthorityCommand, type AuthorityCommandName } from "../../../src/cloudflare/authority-plane.ts";

export const MIRROR_CONFIGURE_COMMAND = "mirror.configure" as const;
export const MIRROR_SYNC_COMMAND = "mirror.sync" as const;
export const MIRROR_RECONCILE_COMMAND = "mirror.reconcile" as const;

export type MirrorMutation = "configure" | "sync" | "reconcile";

export class MirrorInputError extends Error {
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(message: string, recoveryAction: string, receipt: string) {
    super(message);
    this.name = "MirrorInputError";
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new MirrorInputError(`${field} is required.`, `provide a non-empty ${field} and retry; no provider authority was accepted`, `${field}=required; transition=not-applied`);
  return value.trim();
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function oneOf<T extends string>(value: unknown, field: string, values: readonly T[], fallback?: T): T {
  const candidate = value === undefined && fallback !== undefined ? fallback : required(value, field);
  if (!values.includes(candidate as T)) throw new MirrorInputError(`${field} must be one of ${values.join(", ")}.`, `choose a supported ${field} and retry; no provider authority was accepted`, `${field}=unsupported; transition=not-applied`);
  return candidate as T;
}

function strings(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) throw new MirrorInputError(`${field} must be an array of non-empty strings.`, `provide a valid ${field} array and retry; no provider authority was accepted`, `${field}=string-array-required; transition=not-applied`);
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new MirrorInputError(`${field} must be a JSON object.`, `provide ${field} as a JSON object and retry; no provider authority was accepted`, `${field}=object-required; transition=not-applied`);
  return value as Record<string, unknown>;
}

function refs(value: unknown, field: string, allowEmpty = true): Array<{ name: string; oid: string }> {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new MirrorInputError(`${field} must be an array of Git refs.`, `provide ${field} as [{name, oid}] and retry; no provider authority was accepted`, `${field}=git-ref-array-required; transition=not-applied`);
  return value.map((entry, index) => {
    const ref = object(entry, `${field}[${index}]`);
    return { name: required(ref.name, `${field}[${index}].name`), oid: required(ref.oid, `${field}[${index}].oid`) };
  });
}

function sourceSnapshots(value: unknown, field: string): Record<string, string> {
  const entries = object(value, field);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(entries)) result[required(key, `${field}.sourceSpaceId`)] = required(item, `${field}.${key}`);
  return result;
}

function parseDelivery(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const delivery = object(value, "delivery");
  return {
    ...(optional(delivery.id) ? { id: optional(delivery.id) } : {}),
    ...(optional(delivery.provider) ? { provider: optional(delivery.provider) } : {}),
    ...(optional(delivery.installationId) ? { installationId: optional(delivery.installationId) } : {}),
    sourceIdentity: required(delivery.sourceIdentity, "delivery.sourceIdentity"),
    remoteRepository: required(delivery.remoteRepository, "delivery.remoteRepository"),
    deliveryId: required(delivery.deliveryId, "delivery.deliveryId"),
    eventType: required(delivery.eventType, "delivery.eventType"),
    ...(optional(delivery.proposalKey) ? { proposalKey: optional(delivery.proposalKey) } : {}),
  };
}

function parseProposal(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const proposal = object(value, "externalProposal");
  const remoteAuthor = proposal.remoteAuthor === undefined ? undefined : object(proposal.remoteAuthor, "externalProposal.remoteAuthor");
  return {
    ...(optional(proposal.provider) ? { provider: optional(proposal.provider) } : {}),
    ...(optional(proposal.installationId) ? { installationId: optional(proposal.installationId) } : {}),
    sourceIdentity: required(proposal.sourceIdentity, "externalProposal.sourceIdentity"),
    remoteRepository: required(proposal.remoteRepository, "externalProposal.remoteRepository"),
    proposalKind: oneOf(proposal.proposalKind, "externalProposal.proposalKind", ["pull-request", "ref", "commit"] as const),
    proposalKey: required(proposal.proposalKey, "externalProposal.proposalKey"),
    latestHeadCommit: required(proposal.latestHeadCommit ?? proposal.headCommit, "externalProposal.latestHeadCommit"),
    baseProjectRevisionId: required(proposal.baseProjectRevisionId, "externalProposal.baseProjectRevisionId"),
    projectViewId: required(proposal.projectViewId, "externalProposal.projectViewId"),
    disclosure: oneOf(proposal.disclosure, "externalProposal.disclosure", ["public", "project", "restricted"] as const),
    receipt: required(proposal.receipt, "externalProposal.receipt"),
    ...(optional(proposal.id) ? { id: optional(proposal.id) } : {}),
    ...(optional(proposal.remoteRef) ? { remoteRef: optional(proposal.remoteRef) } : {}),
    ...(optional(proposal.baseRef) ? { baseRef: optional(proposal.baseRef) } : {}),
    ...(optional(proposal.baseCommit) ? { baseCommit: optional(proposal.baseCommit) } : {}),
    ...(optional(proposal.intentId) ? { intentId: optional(proposal.intentId) } : {}),
    ...(optional(proposal.changeId) ? { changeId: optional(proposal.changeId) } : {}),
    ...(optional(proposal.projectRevisionId) ? { projectRevisionId: optional(proposal.projectRevisionId) } : {}),
    ...(proposal.sourceSpaceSnapshots === undefined ? {} : { sourceSpaceSnapshots: sourceSnapshots(proposal.sourceSpaceSnapshots, "externalProposal.sourceSpaceSnapshots") }),
    ...(proposal.declaredEffects === undefined ? {} : { declaredEffects: strings(proposal.declaredEffects, "externalProposal.declaredEffects", true) }),
    ...(optional(proposal.status) ? { status: oneOf(proposal.status, "externalProposal.status", ["open", "closed", "merged", "blocked"] as const) } : {}),
    ...(optional(proposal.title) ? { title: optional(proposal.title) } : {}),
    ...(proposal.description === undefined ? {} : { description: required(proposal.description, "externalProposal.description") }),
    ...(remoteAuthor ? { remoteAuthor: { name: required(remoteAuthor.name, "externalProposal.remoteAuthor.name"), ...(optional(remoteAuthor.email) ? { email: optional(remoteAuthor.email) } : {}) } } : {}),
  };
}

export function mirrorPath(pathname: string): { matched: boolean; malformed: boolean; mirrorId?: string; operation?: MirrorMutation } {
  const segments = pathname.split("/");
  if (segments[1] !== "api" || segments[2] !== "mirrors") return { matched: false, malformed: false };
  if (segments.length === 3) return { matched: true, malformed: false };
  if (segments.length !== 4 && segments.length !== 5) return { matched: true, malformed: true };
  try {
    const mirrorId = decodeURIComponent(segments[3] ?? "");
    if (!mirrorId || mirrorId.includes("/") || mirrorId.includes("\\") || mirrorId === "." || mirrorId === "..") return { matched: true, malformed: true };
    if (segments.length === 4) return { matched: true, malformed: false, mirrorId };
    const operation = segments[4] as MirrorMutation;
    if (operation !== "sync" && operation !== "reconcile") return { matched: true, malformed: true };
    return { matched: true, malformed: false, mirrorId, operation };
  } catch {
    return { matched: true, malformed: true };
  }
}

export function mirrorCommand(input: { operation: MirrorMutation; body: Record<string, unknown>; idempotencyKey?: string; mirrorId?: string }): AuthorityCommand {
  const idempotencyKey = required(input.idempotencyKey, "Idempotency-Key");
  if (input.body.idempotencyKey !== undefined && input.body.idempotencyKey !== idempotencyKey) throw new MirrorInputError("The body idempotencyKey does not match the Idempotency-Key header.", "send one idempotency key through both transport layers or omit the body field", "idempotencyKey=transport-mismatch; transition=not-applied");
  const body = input.body;
  const command: AuthorityCommandName = input.operation === "configure" ? MIRROR_CONFIGURE_COMMAND : input.operation === "sync" ? MIRROR_SYNC_COMMAND : MIRROR_RECONCILE_COMMAND;
  if (input.operation === "configure") {
    if (body.canonicalAuthority !== undefined && body.canonicalAuthority !== "anyam") throw new MirrorInputError("Repository Mirrors must keep Anyam as the canonical authority.", "configure the external repository as an Anyam projection; provider-authoritative canonical refs are not supported", `canonicalAuthority=${typeof body.canonicalAuthority === "string" ? body.canonicalAuthority : "invalid"}; providerRole=projection; transition=not-applied`);
    return {
      protocol: AUTHORITY_COMMAND_PROTOCOL,
      command,
      idempotencyKey,
      ...(typeof body.expectedVersion === "number" ? { expectedVersion: body.expectedVersion } : {}),
      payload: {
        ...(optional(body.mirrorId) ? { mirrorId: optional(body.mirrorId) } : {}),
        projectId: required(body.projectId, "projectId"),
        sourceSpaceId: required(body.sourceSpaceId, "sourceSpaceId"),
        provider: required(body.provider, "provider"),
        remoteRepository: required(body.remoteRepository, "remoteRepository"),
        canonicalAuthority: "anyam",
        refMappings: (() => { if (!Array.isArray(body.refMappings) || body.refMappings.length === 0) throw new MirrorInputError("refMappings must contain at least one mapping.", "declare the exact local and remote refs this Mirror may project", "refMappings=non-empty-required; transition=not-applied"); return body.refMappings.map((entry, index) => { const mapping = object(entry, `refMappings[${index}]`); return { localRef: required(mapping.localRef, `refMappings[${index}].localRef`), remoteRef: required(mapping.remoteRef, `refMappings[${index}].remoteRef`) }; }); })(),
        disclosure: oneOf(body.disclosure, "disclosure", ["public", "project", "restricted"] as const),
        ...(optional(body.state) ? { state: oneOf(body.state, "state", ["healthy", "lagging", "divergent", "force-pushed", "blocked", "credential-failed", "disabled"] as const) } : {}),
        canonicalProjectRevisionId: required(body.canonicalProjectRevisionId, "canonicalProjectRevisionId"),
        canonicalRefs: refs(body.canonicalRefs, "canonicalRefs"),
        remoteGeneration: required(body.remoteGeneration, "remoteGeneration"),
        remoteRefs: refs(body.remoteRefs, "remoteRefs"),
        pendingInboundChangeIds: strings(body.pendingInboundChangeIds ?? [], "pendingInboundChangeIds", true),
        receipt: required(body.receipt, "receipt"),
      },
    };
  }
  const payload: Record<string, unknown> = {
    ...(input.mirrorId ? { mirrorId: input.mirrorId } : { mirrorId: required(body.mirrorId, "mirrorId") }),
    canonicalProjectRevisionId: required(body.canonicalProjectRevisionId, "canonicalProjectRevisionId"),
    canonicalRefs: refs(body.canonicalRefs, "canonicalRefs"),
    expectedRemoteGeneration: required(body.expectedRemoteGeneration, "expectedRemoteGeneration"),
    remoteGeneration: required(body.remoteGeneration, "remoteGeneration"),
    remoteRefs: refs(body.remoteRefs, "remoteRefs"),
    ...(optional(body.operationId) ? { operationId: optional(body.operationId) } : {}),
    ...(optional(body.checkpointId) ? { checkpointId: optional(body.checkpointId) } : {}),
    ...(optional(body.resumeCheckpointId) ? { resumeCheckpointId: optional(body.resumeCheckpointId) } : {}),
    ...(optional(body.operationKind) ? { operationKind: oneOf(body.operationKind, "operationKind", ["sync", "outbound", "inbound", "reconcile"] as const) } : {}),
    ...(optional(body.operationState) ? { operationState: oneOf(body.operationState, "operationState", ["started", "succeeded", "failed", "blocked", "degraded"] as const) } : {}),
    ...(optional(body.mirrorState) ? { mirrorState: oneOf(body.mirrorState, "mirrorState", ["healthy", "lagging", "divergent", "force-pushed", "blocked", "credential-failed", "disabled"] as const) } : {}),
    ...(optional(body.errorCode) ? { errorCode: optional(body.errorCode) } : {}),
    ...(optional(body.recoveryAction) ? { recoveryAction: optional(body.recoveryAction) } : {}),
    ...(optional(body.originOperationId) ? { originOperationId: optional(body.originOperationId) } : {}),
    inboundChangeIds: strings(body.inboundChangeIds ?? [], "inboundChangeIds", true),
    completedInboundChangeIds: strings(body.completedInboundChangeIds ?? [], "completedInboundChangeIds", true),
    pendingInboundChangeIds: strings(body.pendingInboundChangeIds ?? [], "pendingInboundChangeIds", true),
    ...(parseDelivery(body.delivery) ? { delivery: parseDelivery(body.delivery) } : {}),
    ...(parseProposal(body.externalProposal) ? { externalProposal: parseProposal(body.externalProposal) } : {}),
    receipt: required(body.receipt, "receipt"),
  };
  if (input.operation === "reconcile") payload.reconciliation = oneOf(body.reconciliation, "reconciliation", ["remote-as-proposal", "canonical-wins"] as const);
  return { protocol: AUTHORITY_COMMAND_PROTOCOL, command, idempotencyKey, ...(typeof body.expectedVersion === "number" ? { expectedVersion: body.expectedVersion } : {}), payload };
}

export function mirrorMutationValue(result: Record<string, unknown>, idempotencyKey: string): Record<string, unknown> {
  return { ...result, idempotencyKey, credentialFree: true, canonicalWrite: false, providerCredential: "not-present" };
}
