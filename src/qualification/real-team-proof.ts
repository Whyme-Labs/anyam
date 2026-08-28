import { verifyRunnerResultSignature } from "../execution/runner-proof.ts";

export const REAL_TEAM_AUTHORITY_EXPORT_PROTOCOL = "anyam.real-team-authority-export/v1" as const;
export const REAL_TEAM_EXTERNAL_ATTESTATION_PROTOCOL = "anyam.real-team-external-attestation/v1" as const;
export const REAL_TEAM_GATE_INTEGRITY_PROTOCOL = "anyam.real-team-adoption-gate-integrity/v1" as const;

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
  /** Required for the current full-bundle contract; absent in legacy v1 attestations. */
  bundleDigest?: string;
  /** Required for the current full-bundle contract; absent in legacy v1 attestations. */
  authorityExportDigest?: string;
  signature: string;
};

export type RealTeamGateIntegrity = {
  protocol: typeof REAL_TEAM_GATE_INTEGRITY_PROTOCOL;
  bundleDigest: string;
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

/**
 * Parse JSON while rejecting duplicate object keys before JSON.parse can discard
 * them. The gate uses this at the file boundary so integrity fields cannot be
 * shadowed by a later duplicate key.
 */
export function parseJsonWithUniqueObjectKeys(text: string): unknown {
  let index = 0;

  function skipWhitespace(): void {
    while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
  }

  function expect(character: string): void {
    if (text[index] !== character) throw new Error(`invalid JSON: expected ${character} at offset ${index}`);
    index += 1;
  }

  function parseString(): string {
    const start = index;
    expect('"');
    let escaped = false;
    while (index < text.length) {
      const character = text[index];
      index += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        const parsed: unknown = JSON.parse(text.slice(start, index));
        if (typeof parsed !== "string") throw new Error(`invalid JSON string at offset ${start}`);
        return parsed;
      }
      if (character !== undefined && character < " ") throw new Error(`invalid JSON control character at offset ${index - 1}`);
    }
    throw new Error(`invalid JSON: unterminated string at offset ${start}`);
  }

  function parseNumber(): void {
    const match = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) throw new Error(`invalid JSON number at offset ${index}`);
    index += match[0].length;
  }

  function parseLiteral(literal: string): void {
    if (text.slice(index, index + literal.length) !== literal) throw new Error(`invalid JSON literal at offset ${index}`);
    index += literal.length;
  }

  function parseValue(): void {
    skipWhitespace();
    const character = text[index];
    if (character === "{") {
      parseObject();
      return;
    }
    if (character === "[") {
      parseArray();
      return;
    }
    if (character === '"') {
      parseString();
      return;
    }
    if (character === "t") {
      parseLiteral("true");
      return;
    }
    if (character === "f") {
      parseLiteral("false");
      return;
    }
    if (character === "n") {
      parseLiteral("null");
      return;
    }
    if (character === "-" || (character !== undefined && /[0-9]/u.test(character))) {
      parseNumber();
      return;
    }
    throw new Error(`invalid JSON value at offset ${index}`);
  }

  function parseArray(): void {
    expect("[");
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (true) {
      parseValue();
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      expect(",");
      skipWhitespace();
      if (text[index] === "]") throw new Error(`invalid JSON: trailing array comma at offset ${index}`);
    }
  }

  function parseObject(): void {
    expect("{");
    const keys = new Set<string>();
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (true) {
      skipWhitespace();
      if (text[index] !== '"') throw new Error(`invalid JSON: object key required at offset ${index}`);
      const key = parseString();
      if (keys.has(key)) throw new Error(`duplicate JSON object key: ${key}`);
      keys.add(key);
      skipWhitespace();
      expect(":");
      parseValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      expect(",");
      skipWhitespace();
      if (text[index] === "}") throw new Error(`invalid JSON: trailing object comma at offset ${index}`);
    }
  }

  parseValue();
  skipWhitespace();
  if (index !== text.length) throw new Error(`invalid JSON: trailing input at offset ${index}`);
  const parsed: unknown = JSON.parse(text);
  return parsed;
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

function unsignedExternalAttestation(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { signature: _signature, bundleDigest: _bundleDigest, ...unsigned } = value;
  return unsigned;
}

/** Remove the integrity envelope from the canonical bundle content. */
export function realTeamGateUnsignedValue(value: Record<string, unknown>): Record<string, unknown> {
  const { integrity: _integrity, ...unsigned } = value;
  return unsigned;
}

/**
 * Return the canonical digest input for the complete readiness claim.
 *
 * External attestation signatures and their bundle back-references are omitted
 * from this digest to avoid a circular dependency: the bundle signature still
 * covers the complete evidence, including those fields.
 */
export function realTeamGateBundleDigestInput(value: Record<string, unknown>): Record<string, unknown> {
  const unsigned = realTeamGateUnsignedValue(value);
  const attestations = unsigned.externalAttestations;
  if (!Array.isArray(attestations)) return unsigned;
  return { ...unsigned, externalAttestations: attestations.map(unsignedExternalAttestation) };
}

export async function realTeamGateBundleDigest(value: Record<string, unknown>): Promise<string> {
  return sha256Digest(stableJson(realTeamGateBundleDigestInput(value)));
}

export function realTeamGateSigningMessage(value: Record<string, unknown>): string {
  const integrity = value.integrity;
  if (!isRecord(integrity)) return `${REAL_TEAM_GATE_INTEGRITY_PROTOCOL}|${stableJson(realTeamGateUnsignedValue(value))}`;
  const { signature: _signature, ...unsignedIntegrity } = integrity;
  return `${REAL_TEAM_GATE_INTEGRITY_PROTOCOL}|${stableJson({ ...value, integrity: unsignedIntegrity })}`;
}

export async function verifyEd25519Signature(input: { publicKey: string; message: string; signature: string }): Promise<boolean> {
  return verifyRunnerResultSignature(input);
}
