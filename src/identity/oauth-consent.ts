/**
 * Provider-independent OAuth consent invariants shared by the Realm adapter
 * and its tests. The coordinator remains the authority for persistence and
 * one-time consumption; these functions only make the boundary explicit.
 */

export type OAuthConsentBinding = {
  readonly realmId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly csrfToken: string;
};

export function intersectOAuthScopes(requested: readonly string[], allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return [...new Set(requested.filter((scope) => allowedSet.has(scope)))];
}

export function oauthConsentBindingMatches(record: OAuthConsentBinding, input: { readonly realmId: string; readonly principalId: string; readonly sessionId: string; readonly csrfToken?: string }): boolean {
  return record.realmId === input.realmId
    && record.principalId === input.principalId
    && record.sessionId === input.sessionId
    && (input.csrfToken === undefined || record.csrfToken === input.csrfToken);
}

function oauthRedirectFormActionSource(redirectUri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error("oauth_redirect_uri_invalid");
  }
  if (parsed.username || parsed.password) throw new Error("oauth_redirect_uri_credentials_unsupported");
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
  if (["about:", "blob:", "data:", "file:", "javascript:"].includes(parsed.protocol)) throw new Error("oauth_redirect_uri_scheme_unsupported");
  if (parsed.host) throw new Error("oauth_redirect_uri_host_unsupported");
  return parsed.protocol;
}

export function oauthConsentContentSecurityPolicy(redirectUri: string, scriptNonce: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(scriptNonce)) throw new Error("oauth_consent_script_nonce_invalid");
  return `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; form-action 'self' ${oauthRedirectFormActionSource(redirectUri)}; base-uri 'none'`;
}

export function isOAuthConsentDecision(value: string | null): value is "approve" | "deny" {
  return value === "approve" || value === "deny";
}
