import { createHash } from "node:crypto";

import type { GitObjectFormat, MirrorRepositoryObservation } from "../kernel/contracts.ts";
import { scanCredentialMaterial } from "../security/credential-material.ts";

export const MIRROR_REPOSITORY_OBSERVATION_PROTOCOL = "anyam.mirror-repository-observation/v1" as const;
export const MIRROR_INGESTION_PROTOCOL = "anyam.mirror-ingestion/v2" as const;
export const MIRROR_HANDOFF_AUDIENCE = "anyam-realm-mirror-ingestion" as const;
export const MIRROR_HANDOFF_TTL_MS = 5 * 60 * 1000;
export const MIRROR_HANDOFF_CLOCK_SKEW_MS = 30 * 1000;
export const MIRROR_HANDOFF_SIZING_RECEIPT = "handoffMaxLifetimeMs=300000; clockSkewMs=30000; sizing=qualification-tripwire; remeasure-before-production";

export type MirrorObservationClaims = Omit<MirrorRepositoryObservation, "manifestDigest">;

export type MirrorObservationBinding = {
  readonly observation: unknown;
  readonly repositoryId: string;
  readonly sourceSpaceId: string;
  readonly mirrorId: string;
  readonly proposalKey: string;
  readonly deliveryId: string;
  readonly provider: string;
  readonly remoteRepository: string;
  readonly projectViewId: string;
  readonly expectedCommitOid: string;
  readonly expectedBaseCommitOid: string;
  readonly expectedObjectFormat?: GitObjectFormat;
};

export type ParsedMirrorRepositoryObservation =
  | { valid: true; observation: MirrorRepositoryObservation }
  | { valid: false; code: string; recoveryAction: string; receipt: string };

export type MirrorIngestionCommand = {
  protocol: "anyam.authority-command/v1";
  command: "mirror.sync" | "mirror.reconcile";
  idempotencyKey: string;
  expectedVersion?: number;
  payload: Record<string, unknown>;
};

export type MirrorHandoffKey = {
  readonly id: string;
  readonly secret: string;
  readonly role?: "active" | "previous";
};

export type MirrorIngestionHandoffBinding = {
  readonly realmId: string;
  readonly installationId: string;
  readonly audience: typeof MIRROR_HANDOFF_AUDIENCE;
  /** Adapter identity, not a user identity. For GitHub this is github-app:<installationId>. */
  readonly issuer: string;
  readonly provider: string;
  readonly remoteRepository: string;
  readonly mirrorId: string;
  readonly deliveryId: string;
  readonly proposalKey: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
};

export type MirrorIngestionHandoff = {
  protocol: typeof MIRROR_INGESTION_PROTOCOL;
  keyId: string;
  nonce: string;
  command: MirrorIngestionCommand;
  signature: string;
} & MirrorIngestionHandoffBinding;

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function requiredString(value: unknown, field: string): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function validOid(value: string, objectFormat: GitObjectFormat): boolean {
  const expectedLength = objectFormat === "sha256" ? 64 : 40;
  return value.length === expectedLength && /^[0-9a-f]+$/u.test(value);
}

function manifest(input: MirrorObservationClaims): string {
  return stableJson(input);
}

export function mirrorObservationDigest(input: MirrorObservationClaims): string {
  return `sha256:${createHash("sha256").update(manifest(input)).digest("hex")}`;
}

export function parseMirrorRepositoryObservation(value: unknown): ParsedMirrorRepositoryObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { valid: false, code: "mirror_observation_malformed", recoveryAction: "return one complete credential-free mirror repository observation", receipt: "mirrorObservation=object-required; transition=not-applied" };
  const body = value as Record<string, unknown>;
  const protocol = requiredString(body.protocol, "protocol");
  const repositoryId = requiredString(body.repositoryId, "repositoryId");
  const sourceSpaceId = requiredString(body.sourceSpaceId, "sourceSpaceId");
  const mirrorId = requiredString(body.mirrorId, "mirrorId");
  const proposalKey = requiredString(body.proposalKey, "proposalKey");
  const deliveryId = requiredString(body.deliveryId, "deliveryId");
  const provider = requiredString(body.provider, "provider");
  const remoteRepository = requiredString(body.remoteRepository, "remoteRepository");
  const projectViewId = requiredString(body.projectViewId, "projectViewId");
  const objectFormat = body.objectFormat === "sha1" || body.objectFormat === "sha256" ? body.objectFormat : undefined;
  const symbolicRef = requiredString(body.symbolicRef, "symbolicRef");
  const commitOid = requiredString(body.commitOid, "commitOid");
  const treeOid = requiredString(body.treeOid, "treeOid");
  const baseCommitOid = requiredString(body.baseCommitOid, "baseCommitOid");
  const manifestDigest = requiredString(body.manifestDigest, "manifestDigest");
  const observedAt = requiredString(body.observedAt, "observedAt");
  const receipt = requiredString(body.receipt, "receipt");
  if (protocol !== MIRROR_REPOSITORY_OBSERVATION_PROTOCOL || !repositoryId || !sourceSpaceId || !mirrorId || !proposalKey || !deliveryId || !provider || !remoteRepository || !projectViewId || !objectFormat || !symbolicRef || !commitOid || !treeOid || !baseCommitOid || body.ancestryVerified !== true || !manifestDigest || !/^sha256:[0-9a-f]{64}$/u.test(manifestDigest) || !observedAt || !receipt || !validOid(commitOid, objectFormat) || !validOid(treeOid, objectFormat) || !validOid(baseCommitOid, objectFormat)) return { valid: false, code: "mirror_observation_complete_required", recoveryAction: "return the mirror, proposal, delivery, provider, Git object, ancestry, timestamp, and digest fields without credential material", receipt: "mirrorObservation=complete-v1-required; transition=not-applied" };
  return { valid: true, observation: { protocol, repositoryId, sourceSpaceId, mirrorId, proposalKey, deliveryId, provider, remoteRepository, projectViewId, objectFormat, symbolicRef, commitOid, treeOid, baseCommitOid, ancestryVerified: true, manifestDigest, observedAt, receipt } };
}

export function verifyMirrorRepositoryObservation(input: MirrorObservationBinding): ParsedMirrorRepositoryObservation {
  const parsed = parseMirrorRepositoryObservation(input.observation);
  if (!parsed.valid) return parsed;
  const observation = parsed.observation;
  const mismatches: string[] = [];
  if (observation.repositoryId !== input.repositoryId) mismatches.push("repositoryId");
  if (observation.sourceSpaceId !== input.sourceSpaceId) mismatches.push("sourceSpaceId");
  if (observation.mirrorId !== input.mirrorId) mismatches.push("mirrorId");
  if (observation.proposalKey !== input.proposalKey) mismatches.push("proposalKey");
  if (observation.deliveryId !== input.deliveryId) mismatches.push("deliveryId");
  if (observation.provider !== input.provider) mismatches.push("provider");
  if (observation.remoteRepository !== input.remoteRepository) mismatches.push("remoteRepository");
  if (observation.projectViewId !== input.projectViewId) mismatches.push("projectViewId");
  if (observation.commitOid !== input.expectedCommitOid) mismatches.push("commitOid");
  if (observation.baseCommitOid !== input.expectedBaseCommitOid) mismatches.push("baseCommitOid");
  if (input.expectedObjectFormat !== undefined && observation.objectFormat !== input.expectedObjectFormat) mismatches.push("objectFormat");
  const { manifestDigest: _manifestDigest, ...claims } = observation;
  if (observation.manifestDigest !== mirrorObservationDigest(claims)) mismatches.push("manifestDigest");
  if (mismatches.length > 0) return { valid: false, code: "mirror_observation_binding_mismatch", recoveryAction: "reinspect the exact mirror proposal through the trusted RepositoryDriver and return a fresh signed observation", receipt: `mirrorObservation=binding-mismatch; fields=${mismatches.join(",")}; transition=not-applied` };
  return parsed;
}

function handoffMessage(input: Omit<MirrorIngestionHandoff, "signature">): string {
  return stableJson(input);
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

async function handoffKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  if (!secret.trim()) throw new Error("mirror handoff secret is empty");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function handoffDates(input: { issuedAt: string; expiresAt: string; now: number; maxLifetimeMs: number; clockSkewMs: number }): void {
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) throw new Error("issuedAt and expiresAt must be ISO timestamps");
  if (expiresAt <= issuedAt) throw new Error("expiresAt must be after issuedAt");
  if (issuedAt > input.now + input.clockSkewMs) throw new Error("issuedAt is too far in the future");
  if (expiresAt <= input.now) throw new Error("expiresAt is not in the future");
  if (expiresAt - issuedAt > input.maxLifetimeMs) throw new Error("handoff lifetime exceeds configured maximum");
}

function commandForHandoff(command: MirrorIngestionCommand, binding: MirrorIngestionHandoffBinding): MirrorIngestionCommand {
  if (command.protocol !== "anyam.authority-command/v1" || (command.command !== "mirror.sync" && command.command !== "mirror.reconcile") || !nonEmpty(command.idempotencyKey, "command.idempotencyKey")) throw new Error("command must be a typed mirror.sync or mirror.reconcile Authority command");
  if (command.payload === null || typeof command.payload !== "object" || Array.isArray(command.payload)) throw new Error("command.payload must be an object");
  if (command.payload.mirrorId !== binding.mirrorId) throw new Error("command.payload.mirrorId must match handoff mirrorId");
  const delivery = command.payload.delivery;
  if (delivery === null || typeof delivery !== "object" || Array.isArray(delivery) || (delivery as Record<string, unknown>).deliveryId !== binding.deliveryId || (delivery as Record<string, unknown>).proposalKey !== binding.proposalKey || (delivery as Record<string, unknown>).provider !== binding.provider || (delivery as Record<string, unknown>).installationId !== binding.installationId || (delivery as Record<string, unknown>).remoteRepository !== binding.remoteRepository) throw new Error("command.payload.delivery must match the handoff provider identity");
  const proposal = command.payload.externalProposal;
  if (proposal === null || typeof proposal !== "object" || Array.isArray(proposal) || (proposal as Record<string, unknown>).proposalKey !== binding.proposalKey || (proposal as Record<string, unknown>).provider !== binding.provider || (proposal as Record<string, unknown>).installationId !== binding.installationId || (proposal as Record<string, unknown>).remoteRepository !== binding.remoteRepository) throw new Error("command.payload.externalProposal must match the handoff proposal identity");
  return command;
}

export async function signMirrorIngestionHandoff(input: {
  command: MirrorIngestionCommand;
  keyId: string;
  secret: string;
  nonce: string;
  realmId: string;
  installationId: string;
  issuer: string;
  provider: string;
  remoteRepository: string;
  mirrorId: string;
  deliveryId: string;
  proposalKey: string;
  issuedAt: string;
  expiresAt: string;
  audience?: typeof MIRROR_HANDOFF_AUDIENCE;
  now?: number;
  maxLifetimeMs?: number;
  clockSkewMs?: number;
}): Promise<MirrorIngestionHandoff> {
  const maxLifetimeMs = input.maxLifetimeMs ?? MIRROR_HANDOFF_TTL_MS;
  const clockSkewMs = input.clockSkewMs ?? MIRROR_HANDOFF_CLOCK_SKEW_MS;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0 || !Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0) throw new Error("handoff lifetime and clock skew must be configured safe integers");
  const binding: MirrorIngestionHandoffBinding = { realmId: nonEmpty(input.realmId, "realmId"), installationId: nonEmpty(input.installationId, "installationId"), audience: input.audience ?? MIRROR_HANDOFF_AUDIENCE, issuer: nonEmpty(input.issuer, "issuer"), provider: nonEmpty(input.provider, "provider"), remoteRepository: nonEmpty(input.remoteRepository, "remoteRepository"), mirrorId: nonEmpty(input.mirrorId, "mirrorId"), deliveryId: nonEmpty(input.deliveryId, "deliveryId"), proposalKey: nonEmpty(input.proposalKey, "proposalKey"), issuedAt: nonEmpty(input.issuedAt, "issuedAt"), expiresAt: nonEmpty(input.expiresAt, "expiresAt") };
  if (binding.audience !== MIRROR_HANDOFF_AUDIENCE) throw new Error("handoff audience is unsupported");
  handoffDates({ issuedAt: binding.issuedAt, expiresAt: binding.expiresAt, now: input.now ?? Date.now(), maxLifetimeMs, clockSkewMs });
  const command = commandForHandoff(input.command, binding);
  const unsigned = { protocol: MIRROR_INGESTION_PROTOCOL, keyId: nonEmpty(input.keyId, "keyId"), nonce: nonEmpty(input.nonce, "nonce"), ...binding, command } as const;
  const finding = scanCredentialMaterial(unsigned, "mirrorHandoff");
  if (finding) throw new Error(`handoff contains credential material at ${finding.path}`);
  const key = await handoffKey(input.secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(handoffMessage(unsigned)));
  return { ...unsigned, signature: base64Url(new Uint8Array(signature)) };
}

function invalid(code: string, recoveryAction: string, receipt: string) {
  return { valid: false as const, code, recoveryAction, receipt };
}

function mismatch(field: string, _expected: string, _actual: string) {
  return invalid("mirror_handoff_binding_mismatch", `reissue the handoff for the configured ${field}`, `mirrorHandoff=binding-mismatch; field=${field}; expected=configuration; observed=not-matched; transition=not-applied`);
}

export async function verifyMirrorIngestionHandoff(input: {
  value: unknown;
  keyId?: string;
  secret?: string;
  keys?: readonly MirrorHandoffKey[];
  expectedRealmId?: string;
  expectedInstallationId?: string;
  expectedAudience?: string;
  expectedIssuer?: string;
  expectedProvider?: string;
  expectedRemoteRepository?: string;
  expectedMirrorId?: string;
  expectedDeliveryId?: string;
  expectedProposalKey?: string;
  maxLifetimeMs?: number;
  clockSkewMs?: number;
  now?: number;
}): Promise<{ valid: true; handoff: MirrorIngestionHandoff; keyRole: "active" | "previous" | "unspecified" } | { valid: false; code: string; recoveryAction: string; receipt: string }> {
  if (input.value === null || typeof input.value !== "object" || Array.isArray(input.value)) return invalid("mirror_handoff_malformed", "submit one signed mirror ingestion handoff object", "mirrorHandoff=object-required; transition=not-applied");
  const value = input.value as Record<string, unknown>;
  const protocol = requiredString(value.protocol, "protocol");
  const keyId = requiredString(value.keyId, "keyId");
  const nonce = requiredString(value.nonce, "nonce");
  const realmId = requiredString(value.realmId, "realmId");
  const installationId = requiredString(value.installationId, "installationId");
  const audience = requiredString(value.audience, "audience");
  const issuer = requiredString(value.issuer, "issuer");
  const provider = requiredString(value.provider, "provider");
  const remoteRepository = requiredString(value.remoteRepository, "remoteRepository");
  const mirrorId = requiredString(value.mirrorId, "mirrorId");
  const deliveryId = requiredString(value.deliveryId, "deliveryId");
  const proposalKey = requiredString(value.proposalKey, "proposalKey");
  const issuedAt = requiredString(value.issuedAt, "issuedAt");
  const expiresAt = requiredString(value.expiresAt, "expiresAt");
  const signature = requiredString(value.signature, "signature");
  const command = value.command;
  if (protocol !== MIRROR_INGESTION_PROTOCOL || !keyId || !nonce || !realmId || !installationId || !audience || !issuer || !provider || !remoteRepository || !mirrorId || !deliveryId || !proposalKey || !issuedAt || !expiresAt || !signature || command === null || typeof command !== "object" || Array.isArray(command)) return invalid("mirror_handoff_malformed", "return protocol, Realm, installation, audience, issuer, provider, Mirror, delivery, proposal, time, command, and signature from the trusted mirror adapter", "mirrorHandoff=complete-v2-required; transition=not-applied");
  const maxLifetimeMs = input.maxLifetimeMs ?? MIRROR_HANDOFF_TTL_MS;
  const clockSkewMs = input.clockSkewMs ?? MIRROR_HANDOFF_CLOCK_SKEW_MS;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0 || !Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0) return invalid("mirror_handoff_configuration_invalid", "configure positive lifetime and non-negative clock-skew tripwires with receipts before accepting Mirror handoffs", "mirrorHandoff=configuration-invalid; transition=not-applied");
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now)) return invalid("mirror_handoff_clock_invalid", "repair the Realm clock before accepting a signed Mirror handoff", "mirrorHandoff=clock-invalid; transition=not-applied");
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return invalid("mirror_handoff_time_invalid", "issue the handoff with ISO issuedAt and expiresAt timestamps", "mirrorHandoff=time-invalid; transition=not-applied");
  if (expires <= issued) return invalid("mirror_handoff_time_reversed", "issue a handoff whose expiresAt is after issuedAt", "mirrorHandoff=time-reversed; transition=not-applied");
  if (issued > now + clockSkewMs) return invalid("mirror_handoff_issued_in_future", "synchronize the producer clock and issue a fresh handoff", `mirrorHandoff=issuedAt-future; clockSkewMs=${clockSkewMs}; transition=not-applied`);
  if (expires <= now) return invalid("mirror_handoff_expired", "request a fresh signed mirror handoff before the expiry timestamp", `mirrorHandoff=expired; expiresAt=${expiresAt}; transition=not-applied`);
  if (expires - issued > maxLifetimeMs) return invalid("mirror_handoff_lifetime_exceeded", "issue a handoff within the configured maximum lifetime", `mirrorHandoff=lifetime-exceeded; lifetimeMs=${expires - issued}; maxLifetimeMs=${maxLifetimeMs}; transition=not-applied`);
  if (input.expectedRealmId !== undefined && realmId !== input.expectedRealmId) return mismatch("realmId", input.expectedRealmId, realmId);
  if (input.expectedInstallationId !== undefined && installationId !== input.expectedInstallationId) return mismatch("installationId", input.expectedInstallationId, installationId);
  if (input.expectedAudience !== undefined && audience !== input.expectedAudience) return mismatch("audience", input.expectedAudience, audience);
  if (input.expectedIssuer !== undefined && issuer !== input.expectedIssuer) return mismatch("issuer", input.expectedIssuer, issuer);
  if (input.expectedProvider !== undefined && provider !== input.expectedProvider) return mismatch("provider", input.expectedProvider, provider);
  if (input.expectedRemoteRepository !== undefined && remoteRepository !== input.expectedRemoteRepository) return mismatch("remoteRepository", input.expectedRemoteRepository, remoteRepository);
  if (input.expectedMirrorId !== undefined && mirrorId !== input.expectedMirrorId) return mismatch("mirrorId", input.expectedMirrorId, mirrorId);
  if (input.expectedDeliveryId !== undefined && deliveryId !== input.expectedDeliveryId) return mismatch("deliveryId", input.expectedDeliveryId, deliveryId);
  if (input.expectedProposalKey !== undefined && proposalKey !== input.expectedProposalKey) return mismatch("proposalKey", input.expectedProposalKey, proposalKey);
  const configuredKeys = input.keys ?? (input.keyId !== undefined && input.secret !== undefined ? [{ id: input.keyId, secret: input.secret, role: "active" as const }] : []);
  if (configuredKeys.length === 0 || configuredKeys.some((candidate) => !candidate.id.trim() || !candidate.secret.trim()) || new Set(configuredKeys.map((candidate) => candidate.id)).size !== configuredKeys.length) return invalid("mirror_handoff_configuration_invalid", "configure one active key and, optionally, one distinct previous key for the rotation overlap", "mirrorHandoff=key-configuration-invalid; transition=not-applied");
  const key = configuredKeys.find((candidate) => candidate.id === keyId);
  if (!key) return invalid("mirror_handoff_key_unknown", "sign the handoff with an enrolled active or rotation-overlap Mirror key ID", `mirrorHandoff=key-unknown; keyId=${keyId}; transition=not-applied`);
  const commandRecord = command as Record<string, unknown>;
  let typedCommand: MirrorIngestionCommand;
  try {
    typedCommand = commandForHandoff(commandRecord as unknown as MirrorIngestionCommand, { realmId, installationId, audience: audience as typeof MIRROR_HANDOFF_AUDIENCE, issuer, provider, remoteRepository, mirrorId, deliveryId, proposalKey, issuedAt, expiresAt });
  } catch {
    return invalid("mirror_handoff_command_invalid", "sign only a typed mirror.sync or mirror.reconcile Authority command with matching delivery and proposal identities", "mirrorHandoff=command-invalid; transition=not-applied");
  }
  const unsigned = { protocol: MIRROR_INGESTION_PROTOCOL, keyId, nonce, realmId, installationId, audience: audience as typeof MIRROR_HANDOFF_AUDIENCE, issuer, provider, remoteRepository, mirrorId, deliveryId, proposalKey, issuedAt, expiresAt, command: typedCommand } as const;
  if (unsigned.audience !== MIRROR_HANDOFF_AUDIENCE) return invalid("mirror_handoff_audience_invalid", "sign the handoff for the anyam-realm-mirror-ingestion audience", `mirrorHandoff=audience-invalid; audience=${audience}; transition=not-applied`);
  const finding = scanCredentialMaterial(unsigned, "mirrorHandoff");
  if (finding) return invalid("mirror_handoff_credential_material", "remove provider credentials from the signed envelope; use only identities, digests, and receipts", `mirrorHandoff=credential-material; field=${finding.path}; transition=not-applied`);
  try {
    const cryptoKey = await handoffKey(key.secret, ["verify"]);
    const signatureBytes = decodeBase64Url(signature);
    const valid = await crypto.subtle.verify("HMAC", cryptoKey, signatureBytes.buffer as ArrayBuffer, new TextEncoder().encode(handoffMessage(unsigned)));
    if (!valid) return invalid("mirror_handoff_signature_invalid", "submit the exact command envelope signed by the enrolled mirror adapter", "mirrorHandoff=signature-invalid; transition=not-applied");
  } catch {
    return invalid("mirror_handoff_signature_invalid", "submit a valid base64url HMAC signature from the configured mirror adapter", "mirrorHandoff=signature-invalid; transition=not-applied");
  }
  return { valid: true, handoff: { ...unsigned, command: unsigned.command as MirrorIngestionCommand, protocol, signature }, keyRole: key.role ?? "unspecified" };
}
