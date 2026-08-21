import type { AuthorityPlaneSnapshot } from "./authority-plane.ts";

export const AUTHORITY_RECOVERY_PROTOCOL = "anyam.authority-recovery/v1" as const;

export type AuthorityRecoveryBundle = {
  protocol: typeof AUTHORITY_RECOVERY_PROTOCOL;
  bundleId: string;
  realmId: string;
  expectedVersion: number;
  snapshotDigest: string;
  auditChainDigest: string;
  recoveryKeyId: string;
  issuedAt: string;
  snapshot: AuthorityPlaneSnapshot;
  bundleDigest: string;
  signature: string;
};

export type AuthorityRecoveryVerification =
  | { valid: true; bundle: AuthorityRecoveryBundle }
  | { valid: false; code: string; recoveryAction: string; receipt: string };

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  if (secret.trim().length === 0) throw new Error("authority recovery secret is empty");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function authorityRecoverySnapshotDigest(snapshot: AuthorityPlaneSnapshot): Promise<string> {
  return sha256(stableJson(snapshot));
}

export async function authorityRecoveryAuditChainDigest(snapshot: AuthorityPlaneSnapshot): Promise<string> {
  let previous = "genesis:authority-audit/v1";
  for (const event of snapshot.audit) previous = await sha256(stableJson({ previous, event }));
  return previous;
}

function signedMessage(bundle: Omit<AuthorityRecoveryBundle, "signature">): string {
  const { bundleDigest: _bundleDigest, ...unsigned } = bundle;
  return stableJson(unsigned);
}

export async function createAuthorityRecoveryBundle(input: {
  snapshot: AuthorityPlaneSnapshot;
  bundleId: string;
  recoveryKeyId: string;
  issuedAt?: string;
  secret: string;
}): Promise<AuthorityRecoveryBundle> {
  const bundleId = input.bundleId.trim();
  const recoveryKeyId = input.recoveryKeyId.trim();
  if (!bundleId || !recoveryKeyId) throw new Error("authority recovery bundle identity is required");
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const snapshotDigest = await authorityRecoverySnapshotDigest(input.snapshot);
  const auditChainDigest = await authorityRecoveryAuditChainDigest(input.snapshot);
  const unsignedWithoutDigest = { protocol: AUTHORITY_RECOVERY_PROTOCOL, bundleId, realmId: input.snapshot.realmId, expectedVersion: input.snapshot.version, snapshotDigest, auditChainDigest, recoveryKeyId, issuedAt, snapshot: input.snapshot };
  const bundleDigest = await sha256(stableJson(unsignedWithoutDigest));
  const unsigned: Omit<AuthorityRecoveryBundle, "signature"> = { ...unsignedWithoutDigest, bundleDigest };
  const key = await hmacKey(input.secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedMessage(unsigned)));
  return { ...unsigned, signature: base64Url(new Uint8Array(signature)) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function verifyAuthorityRecoveryBundle(input: {
  value: unknown;
  realmId: string;
  recoveryKeyId: string;
  secret: string;
}): Promise<AuthorityRecoveryVerification> {
  if (!isRecord(input.value)) return { valid: false, code: "bundle_invalid", recoveryAction: "submit the exact signed recovery bundle returned by Authority export", receipt: "authorityRecovery=bundle-object-required; restore=not-applied" };
  const value = input.value;
  const snapshot = value.snapshot;
  if (!isRecord(snapshot) || snapshot.protocol !== "anyam.authority-plane/v1" || snapshot.realmId !== input.realmId || !Number.isSafeInteger(snapshot.version) || !Array.isArray(snapshot.audit)) return { valid: false, code: "bundle_invalid", recoveryAction: "export a fresh complete Authority recovery bundle for this Realm", receipt: "authorityRecovery=bundle-snapshot-invalid; restore=not-applied" };
  const requiredStrings = ["bundleId", "realmId", "snapshotDigest", "auditChainDigest", "recoveryKeyId", "issuedAt", "bundleDigest", "signature"];
  const missing = requiredStrings.find((field) => typeof value[field] !== "string" || String(value[field]).trim().length === 0);
  if (missing || typeof value.expectedVersion !== "number" || !Number.isSafeInteger(value.expectedVersion)) return { valid: false, code: "bundle_invalid", recoveryAction: "export a fresh complete Authority recovery bundle and submit it unchanged", receipt: `authorityRecovery=bundle-field-invalid; field=${missing ?? "expectedVersion"}; restore=not-applied` };
  const bundleId = value.bundleId;
  const realmId = value.realmId;
  const snapshotDigestValue = value.snapshotDigest;
  const auditChainDigestValue = value.auditChainDigest;
  const recoveryKeyId = value.recoveryKeyId;
  const issuedAt = value.issuedAt;
  const bundleDigestValue = value.bundleDigest;
  const signatureValue = value.signature;
  const expectedVersion = value.expectedVersion;
  if (typeof bundleId !== "string" || typeof realmId !== "string" || typeof snapshotDigestValue !== "string" || typeof auditChainDigestValue !== "string" || typeof recoveryKeyId !== "string" || typeof issuedAt !== "string" || typeof bundleDigestValue !== "string" || typeof signatureValue !== "string" || typeof expectedVersion !== "number") return { valid: false, code: "bundle_invalid", recoveryAction: "export a fresh complete Authority recovery bundle and submit it unchanged", receipt: "authorityRecovery=bundle-field-narrowing-failed; restore=not-applied" };
  if (realmId !== input.realmId) return { valid: false, code: "realm_mismatch", recoveryAction: "restore only a bundle exported by this Realm", receipt: `authorityRecovery=realm-mismatch; restore=not-applied` };
  if (recoveryKeyId !== input.recoveryKeyId) return { valid: false, code: "recovery_key_mismatch", recoveryAction: "use the active customer recovery key ID for this Realm", receipt: `authorityRecovery=recovery-key-mismatch; restore=not-applied` };
  const typedSnapshot = snapshot as unknown as AuthorityPlaneSnapshot;
  const snapshotDigest = await authorityRecoverySnapshotDigest(typedSnapshot);
  const auditChainDigest = await authorityRecoveryAuditChainDigest(typedSnapshot);
  if (snapshotDigestValue !== snapshotDigest || auditChainDigestValue !== auditChainDigest) return { valid: false, code: "bundle_digest_mismatch", recoveryAction: "do not edit the exported snapshot; export a fresh bundle and retry", receipt: `authorityRecovery=digest-mismatch; snapshotDigest=${snapshotDigestValue === snapshotDigest ? "matched" : "mismatched"}; auditChain=${auditChainDigestValue === auditChainDigest ? "matched" : "mismatched"}; restore=not-applied` };
  const unsignedWithoutDigest = { protocol: AUTHORITY_RECOVERY_PROTOCOL, bundleId, realmId, expectedVersion, snapshotDigest: snapshotDigestValue, auditChainDigest: auditChainDigestValue, recoveryKeyId, issuedAt, snapshot: typedSnapshot };
  const bundleDigest = await sha256(stableJson(unsignedWithoutDigest));
  if (bundleDigestValue !== bundleDigest) return { valid: false, code: "bundle_digest_mismatch", recoveryAction: "export a fresh bundle; the supplied bundle digest does not match its contents", receipt: "authorityRecovery=bundle-digest-mismatch; restore=not-applied" };
  try {
    const key = await hmacKey(input.secret, ["verify"]);
    const signature = decodeBase64Url(signatureValue);
    const valid = await crypto.subtle.verify("HMAC", key, signature.buffer as ArrayBuffer, new TextEncoder().encode(signedMessage({ ...unsignedWithoutDigest, bundleDigest })));
    if (!valid) return { valid: false, code: "signature_invalid", recoveryAction: "export a fresh bundle through the configured Authority recovery key; no restore was applied", receipt: `authorityRecovery=signature-invalid; keyId=${input.recoveryKeyId}; restore=not-applied` };
  } catch {
    return { valid: false, code: "signature_invalid", recoveryAction: "export a fresh bundle through the configured Authority recovery key; no restore was applied", receipt: `authorityRecovery=signature-invalid; keyId=${input.recoveryKeyId}; restore=not-applied` };
  }
  return { valid: true, bundle: value as unknown as AuthorityRecoveryBundle };
}
