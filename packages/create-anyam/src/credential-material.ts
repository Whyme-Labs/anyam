/**
 * One credential-material scanner for every provider and persistence boundary.
 *
 * The scanner reports only a safe path and category. It never includes the
 * matched value in an error, receipt, or returned object.
 */

export const CREDENTIAL_MATERIAL_SCANNER_PROTOCOL = "anyam.credential-material-scanner/v1" as const;

export type CredentialMaterialFindingKind =
  | "sensitive-key"
  | "bearer-header"
  | "basic-header"
  | "jwt"
  | "private-key"
  | "cloud-token"
  | "userinfo-url"
  | "encoded-credential";

export type CredentialMaterialFinding = {
  path: string;
  kind: CredentialMaterialFindingKind;
};

const SAFE_MARKERS = new Set([
  "not-printed",
  "not-issued",
  "not-returned",
  "not-stored",
  "not-present",
  "redacted",
  "redacted-only",
  "credential-free",
  "credentials-none",
  "none",
  "missing",
]);

const SENSITIVE_KEYS = new Set([
  "token",
  "tokens",
  "accesstoken",
  "accesstokens",
  "refreshtoken",
  "refreshtokens",
  "providertoken",
  "providertokens",
  "githubtoken",
  "githubtokens",
  "secret",
  "secrets",
  "clientsecret",
  "clientsecrets",
  "apikey",
  "apikeys",
  "password",
  "passwords",
  "authorization",
  "privatekey",
  "privatekeys",
  "webhooksecret",
  "webhooksecrets",
  "credential",
  "credentials",
  "jwt",
  "jwts",
  "bearer",
]);

const ASSIGNMENT_PATTERN = /(?:^|[\s,{;])["']?(?:access[ _-]?token|refresh[ _-]?token|provider[ _-]?token|github[ _-]?token|client[ _-]?secret|api[ _-]?key|private[ _-]?key|webhook[ _-]?secret|token|secret|password|authorization)["']?\s*[:=]\s*(?!["']?not[-_ ]?(?:printed|issued|returned|stored)|["']?redacted(?:[-_ ]only)?|["']?none\b|["']?missing\b)["']?[^\s,;}"']+["']?/iu;
const AUTHORIZATION_PATTERN = /\bauthorization["']?\s*[:=]\s*(?!["']?not[-_ ]?(?:printed|issued|returned|stored)|["']?redacted(?:[-_ ]only)?|["']?none\b|["']?missing\b)["']?[^\s,;}"']+["']?/iu;
const BEARER_PATTERN = /\bbearer[\t ]+(?!not[-_ ]?(?:printed|issued|returned|stored)|redacted(?:[-_ ]only)?|none\b|missing\b)["']?[^\s,;}"']+["']?/iu;
const BASIC_PATTERN = /\bbasic[\t ]+(?!not[-_ ]?(?:printed|issued|returned|stored)|redacted(?:[-_ ]only)?|none\b|missing\b)[A-Za-z0-9+/=_-]{8,}/iu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/u;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [^-]+)? PRIVATE KEY-----/iu;
const CLOUD_TOKEN_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bcfat_[A-Za-z0-9]{16,}\b/u;
const USERINFO_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;
const BASE64_CANDIDATE_PATTERN = /^[A-Za-z0-9+/_-]{16,}={0,2}$/u;

function normalizedKey(key: string): string {
  return key.normalize("NFKC").replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

function safeMarker(value: string): boolean {
  return SAFE_MARKERS.has(value.trim().toLowerCase());
}

function decodedBase64(value: string): string | undefined {
  if (!BASE64_CANDIDATE_PATTERN.test(value)) return undefined;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    return atob(normalized);
  } catch {
    return undefined;
  }
}

function textKind(value: string, allowDecode: boolean): CredentialMaterialFindingKind | undefined {
  const normalized = value.trim();
  if (safeMarker(normalized)) return undefined;
  if (PRIVATE_KEY_PATTERN.test(normalized)) return "private-key";
  if (CLOUD_TOKEN_PATTERN.test(normalized)) return "cloud-token";
  if (JWT_PATTERN.test(normalized)) return "jwt";
  if (USERINFO_URL_PATTERN.test(normalized)) return "userinfo-url";
  if (BASIC_PATTERN.test(normalized)) return "basic-header";
  if (BEARER_PATTERN.test(normalized) || AUTHORIZATION_PATTERN.test(normalized)) return "bearer-header";
  if (ASSIGNMENT_PATTERN.test(normalized)) return "sensitive-key";
  if (allowDecode) {
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded !== normalized && textKind(decoded, false)) return "encoded-credential";
    } catch {
      // An invalid percent-encoding is not credential material by itself.
    }
    const decoded = decodedBase64(normalized);
    if (decoded && textKind(decoded, false)) return "encoded-credential";
  }
  return undefined;
}

function keyKind(key: string, value: unknown): CredentialMaterialFindingKind | undefined {
  const normalized = normalizedKey(key);
  if (!SENSITIVE_KEYS.has(normalized)) return undefined;
  if (typeof value === "string" && safeMarker(value)) return undefined;
  return "sensitive-key";
}

function scan(value: unknown, path: string, seen: WeakSet<object>): CredentialMaterialFinding | undefined {
  if (typeof value === "string") {
    const kind = textKind(value, true);
    return kind ? { path, kind } : undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const finding = scan(item, `${path}[${index}]`, seen);
      if (finding) return finding;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    const currentPath = `${path}.${key}`;
    const kind = keyKind(key, item);
    if (kind) return { path: currentPath, kind };
    const finding = scan(item, currentPath, seen);
    if (finding) return finding;
  }
  return undefined;
}

export function scanCredentialMaterial(value: unknown, rootPath = "value"): CredentialMaterialFinding | undefined {
  return scan(value, rootPath, new WeakSet<object>());
}

/** Match known material without returning it. Visit JSON strings and keys,
 * plus one URI or Base64 decoding layer. A Base64 substring can begin at any
 * of its four character alignments inside a larger alphabet run. */
export function containsKnownTextMaterial(value: unknown, matchesText: (text: string) => boolean): boolean {
  const matches = (text: string): boolean => {
    if (matchesText(text)) return true;
    // Decode valid byte spans independently. Unrelated malformed escapes or
    // invalid UTF-8 must not suppress an embedded known ASCII credential.
    const uriDecoded = text.replace(/(?:%[0-9a-f]{2})+/giu, encoded => new TextDecoder().decode(Uint8Array.from(
      [...encoded.matchAll(/%([0-9a-f]{2})/giu)], match => Number.parseInt(match[1]!, 16))));
    if (uriDecoded !== text && matchesText(uriDecoded)) return true;
    // Native Base64 permits ASCII whitespace between encoded characters.
    const base64Text = text.replace(/[\t\n\f\r ]/gu, "");
    for (const match of base64Text.matchAll(/[A-Za-z0-9+/_-]+={0,2}/gu)) {
      const candidate = match[0].replace(/=+$/u, "").replaceAll("-", "+").replaceAll("_", "/");
      for (let alignment = 0; alignment < 4 && alignment < candidate.length; alignment++) {
        const substring = candidate.slice(alignment);
        // A surrounding suffix can leave an invalid final one-character
        // quantum. Discard only that quantum; complete preceding bytes still
        // contain any embedded encoding.
        const aligned = substring.length % 4 === 1 ? substring.slice(0, -1) : substring;
        try {
          const binary = atob(aligned + "=".repeat((4 - aligned.length % 4) % 4));
          const decoded = new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
          if (matchesText(decoded)) return true;
        } catch { /* malformed Base64 text */ }
      }
    }
    return false;
  };
  const seen = new WeakSet<object>();
  const contains = (entry: unknown): boolean => {
    if (typeof entry === "string") return matches(entry);
    if (!entry || typeof entry !== "object" || seen.has(entry)) return false;
    seen.add(entry);
    return Object.entries(entry).some(([key, nested]) => matches(key) || contains(nested));
  };
  return contains(value);
}

export function isCredentialFree(value: unknown): boolean {
  return scanCredentialMaterial(value) === undefined;
}

export function credentialMaterialReceipt(finding: CredentialMaterialFinding | undefined, recoveryAction: string): string {
  return finding
    ? `scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; status=blocked; field=${finding.path}; kind=${finding.kind}; credentialMaterialStored=false; recoveryAction=${recoveryAction}`
    : `scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; status=safe; credentialMaterialStored=false`;
}
