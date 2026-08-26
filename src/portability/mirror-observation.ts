import { createHash } from "node:crypto";

import type { GitObjectFormat, MirrorRepositoryObservation } from "../kernel/contracts.ts";

export const MIRROR_REPOSITORY_OBSERVATION_PROTOCOL = "anyam.mirror-repository-observation/v1" as const;
export const MIRROR_INGESTION_PROTOCOL = "anyam.mirror-ingestion/v1" as const;
export const MIRROR_HANDOFF_TTL_MS = 5 * 60 * 1000;
export const MIRROR_HANDOFF_SIZING_RECEIPT = "handoffTtl=300000ms; sizing=qualification-tripwire; remeasure-before-production";

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

export type MirrorIngestionHandoff = {
  protocol: typeof MIRROR_INGESTION_PROTOCOL;
  keyId: string;
  nonce: string;
  expiresAt: string;
  command: MirrorIngestionCommand;
  signature: string;
};

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

function handoffMessage(input: Pick<MirrorIngestionHandoff, "protocol" | "keyId" | "nonce" | "expiresAt" | "command">): string {
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

export async function signMirrorIngestionHandoff(input: { command: MirrorIngestionCommand; keyId: string; nonce: string; expiresAt: string; secret: string }): Promise<MirrorIngestionHandoff> {
  const unsigned = { protocol: MIRROR_INGESTION_PROTOCOL, keyId: input.keyId, nonce: input.nonce, expiresAt: input.expiresAt, command: input.command } as const;
  const key = await handoffKey(input.secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(handoffMessage(unsigned)));
  return { ...unsigned, signature: base64Url(new Uint8Array(signature)) };
}

export async function verifyMirrorIngestionHandoff(input: { value: unknown; keyId: string; secret: string; now?: number }): Promise<{ valid: true; handoff: MirrorIngestionHandoff } | { valid: false; code: string; recoveryAction: string; receipt: string }> {
  if (input.value === null || typeof input.value !== "object" || Array.isArray(input.value)) return { valid: false, code: "mirror_handoff_malformed", recoveryAction: "submit one signed mirror ingestion handoff object", receipt: "mirrorHandoff=object-required; transition=not-applied" };
  const value = input.value as Record<string, unknown>;
  const protocol = requiredString(value.protocol, "protocol");
  const keyId = requiredString(value.keyId, "keyId");
  const nonce = requiredString(value.nonce, "nonce");
  const expiresAt = requiredString(value.expiresAt, "expiresAt");
  const signature = requiredString(value.signature, "signature");
  const command = value.command;
  if (protocol !== MIRROR_INGESTION_PROTOCOL || !keyId || !nonce || !expiresAt || !signature || command === null || typeof command !== "object" || Array.isArray(command)) return { valid: false, code: "mirror_handoff_malformed", recoveryAction: "return protocol, key ID, nonce, expiry, command, and signature from the trusted mirror adapter", receipt: "mirrorHandoff=complete-v1-required; transition=not-applied" };
  if (keyId !== input.keyId) return { valid: false, code: "mirror_handoff_key_unknown", recoveryAction: "sign the handoff with the configured active mirror key ID", receipt: `mirrorHandoff=key-mismatch; expected=${input.keyId}; transition=not-applied` };
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires) || expires <= (input.now ?? Date.now())) return { valid: false, code: "mirror_handoff_expired", recoveryAction: "request a fresh signed mirror handoff before the expiry timestamp", receipt: "mirrorHandoff=expired; transition=not-applied" };
  const commandRecord = command as Record<string, unknown>;
  if (commandRecord.protocol !== "anyam.authority-command/v1" || (commandRecord.command !== "mirror.sync" && commandRecord.command !== "mirror.reconcile") || typeof commandRecord.idempotencyKey !== "string" || commandRecord.payload === null || typeof commandRecord.payload !== "object" || Array.isArray(commandRecord.payload)) return { valid: false, code: "mirror_handoff_command_invalid", recoveryAction: "sign only a typed mirror.sync or mirror.reconcile Authority command", receipt: "mirrorHandoff=command-invalid; transition=not-applied" };
  const typedCommand = commandRecord as unknown as MirrorIngestionCommand;
  try {
    const key = await handoffKey(input.secret, ["verify"]);
    const signatureBytes = decodeBase64Url(signature);
    const valid = await crypto.subtle.verify("HMAC", key, signatureBytes.buffer as ArrayBuffer, new TextEncoder().encode(handoffMessage({ protocol: MIRROR_INGESTION_PROTOCOL, keyId, nonce, expiresAt, command: typedCommand })));
    if (!valid) return { valid: false, code: "mirror_handoff_signature_invalid", recoveryAction: "submit the exact command envelope signed by the enrolled mirror adapter", receipt: "mirrorHandoff=signature-invalid; transition=not-applied" };
  } catch {
    return { valid: false, code: "mirror_handoff_signature_invalid", recoveryAction: "submit a valid base64url HMAC signature from the configured mirror adapter", receipt: "mirrorHandoff=signature-invalid; transition=not-applied" };
  }
  return { valid: true, handoff: { protocol, keyId, nonce, expiresAt, command: typedCommand, signature } };
}
