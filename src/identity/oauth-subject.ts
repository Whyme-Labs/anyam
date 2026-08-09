/**
 * Maps an Anyam principal identifier to the opaque OAuth subject accepted by
 * the provider. Anyam identifiers are intentionally colon-delimited, while
 * the provider's authorization-code envelope uses `:` as its field
 * delimiter. Encoding at this boundary keeps the canonical identity intact
 * without making the provider's wire format ambiguous.
 */
export function toOAuthSubject(principalId: string): string {
  const subject = encodeURIComponent(principalId);
  if (!subject || subject.includes(":")) throw new Error("oauth_subject_invalid");
  return subject;
}
