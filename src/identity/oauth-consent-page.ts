import { anyamBrandLockup, anyamBrandStyleTag } from "../brand.ts";
import { oauthConsentContentSecurityPolicy } from "./oauth-consent.ts";

export type OAuthConsentPageInput = {
  readonly consentId: string;
  readonly csrfToken: string;
  readonly clientName: string;
  readonly requestedScopes: readonly string[];
  readonly allowedScopes: readonly string[];
  readonly redirectUri: string;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function scriptNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function renderOAuthConsentPage(input: OAuthConsentPageInput): Response {
  const allowed = new Set(input.allowedScopes);
  const scopeRows = input.requestedScopes.map((scope) => `<li><code>${escapeHtml(scope)}</code>${allowed.has(scope) ? "" : " <em>(not available)</em>"}</li>`).join("");
  const nonce = scriptNonce();
  const contentSecurityPolicy = oauthConsentContentSecurityPolicy(input.redirectUri, nonce);
  const script = `
    const form = document.getElementById("oauth-consent-form");
    const status = document.getElementById("oauth-consent-status");
    form?.addEventListener("submit", () => {
      for (const button of form.querySelectorAll("button")) button.disabled = true;
      if (status) status.textContent = "Submitting authorization…";
    });
  `.replaceAll("</script>", "<\\/script>");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize ${escapeHtml(input.clientName)}</title>${anyamBrandStyleTag()}<style>
.oauth-card{max-width:42rem;margin:2rem auto}
.oauth-card h1{margin:.7rem 0 .5rem;font-size:clamp(1.7rem,4vw,2.4rem);letter-spacing:-.04em}
.oauth-card .scope-list{padding-left:1.2rem}
.oauth-card li{margin:.55rem 0}
.oauth-card code{border-radius:.35rem;background:var(--anyam-code-bg);padding:.1rem .3rem}
.oauth-card em{color:var(--anyam-muted)}
.oauth-card form{display:flex;flex-wrap:wrap;gap:.6rem;margin-top:1.5rem}
.oauth-card .oauth-deny{border:1px solid var(--anyam-border);border-radius:.65rem;background:transparent;color:var(--anyam-text);cursor:pointer;font:inherit;font-weight:650;padding:.72rem 1rem}
.oauth-card button:disabled{cursor:wait;opacity:.65}
</style></head><body class="anyam-page"><main class="anyam-card anyam-shell oauth-card"><div>${anyamBrandLockup()}</div><p class="anyam-eyebrow">Realm authorization</p><h1>Authorize ${escapeHtml(input.clientName)}</h1><p class="anyam-muted">This application is requesting access to your Anyam Realm. Review the scopes before continuing.</p><ul class="scope-list">${scopeRows}</ul><form id="oauth-consent-form" method="post" action="/authorize"><input type="hidden" name="consentId" value="${escapeHtml(input.consentId)}"><input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}"><button class="anyam-button" name="decision" value="approve" type="submit">Approve access</button><button class="oauth-deny" name="decision" value="deny" type="submit">Deny</button></form><p id="oauth-consent-status" class="anyam-muted" aria-live="polite"></p></main><script nonce="${nonce}">${script}</script></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": contentSecurityPolicy } });
}
