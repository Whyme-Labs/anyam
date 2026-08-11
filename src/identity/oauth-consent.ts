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

export function isOAuthConsentDecision(value: string | null): value is "approve" | "deny" {
  return value === "approve" || value === "deny";
}
