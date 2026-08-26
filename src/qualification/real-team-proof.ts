import { verifyRunnerResultSignature } from "../execution/runner-proof.ts";

export const REAL_TEAM_AUTHORITY_EXPORT_PROTOCOL = "anyam.real-team-authority-export/v1" as const;
export const REAL_TEAM_EXTERNAL_ATTESTATION_PROTOCOL = "anyam.real-team-external-attestation/v1" as const;

export type RealTeamAuthorityExport = {
  protocol: typeof REAL_TEAM_AUTHORITY_EXPORT_PROTOCOL;
  cohortId: string;
  realmId: string;
  exportDigest: string;
  signingKeyId: string;
  exportedAt: string;
  snapshot: Record<string, unknown>;
  signature: string;
};

export type RealTeamTerminalChange = {
  changeId: string;
  terminalState: "landed" | "abandoned";
  auditEventId: string;
  revisionId: string;
};

export type RealTeamExternalAttestation = {
  protocol: typeof REAL_TEAM_EXTERNAL_ATTESTATION_PROTOCOL;
  attestationId: string;
  cohortId: string;
  realmId: string;
  kind: "independent-security-review";
  reviewerId: string;
  reviewerOrganization?: string;
  reportDigest: string;
  signingKeyId: string;
  signedAt: string;
  signature: string;
};

export type RealTeamGateVerificationOptions = {
  authoritySigningKeys?: Readonly<Record<string, string>>;
  attestationSigningKeys?: Readonly<Record<string, string>>;
  now?: () => number;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return "null";
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export async function sha256Digest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function authorityExportDigest(snapshot: Record<string, unknown>): Promise<string> {
  return sha256Digest(stableJson(snapshot));
}

export function authorityExportSigningMessage(value: Omit<RealTeamAuthorityExport, "signature">): string {
  return `${REAL_TEAM_AUTHORITY_EXPORT_PROTOCOL}|${stableJson(value)}`;
}

export function externalAttestationSigningMessage(value: Omit<RealTeamExternalAttestation, "signature">): string {
  return `${REAL_TEAM_EXTERNAL_ATTESTATION_PROTOCOL}|${stableJson(value)}`;
}

export async function verifyEd25519Signature(input: { publicKey: string; message: string; signature: string }): Promise<boolean> {
  return verifyRunnerResultSignature(input);
}
