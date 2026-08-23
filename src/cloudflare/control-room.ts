import type { CustomerRealmOperatorCheck, CustomerRealmOperatorStatus } from "./realm-operator.ts";
import type { ProductionOperationsReadiness } from "../operations/production-operations.ts";

export type CustomerRealmControlRoomInput = {
  readonly status: CustomerRealmOperatorStatus;
  readonly operations: ProductionOperationsReadiness;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function stateLabel(state: string): string {
  return state.replaceAll("-", " ");
}

function checkFor(status: CustomerRealmOperatorStatus, id: string): CustomerRealmOperatorCheck | undefined {
  return status.checks.find((check) => check.id === id);
}

function section(input: { readonly title: string; readonly state: string; readonly detail: string }): string {
  return `<section class="state state-${escapeHtml(input.state)}"><div class="state-heading"><h2>${escapeHtml(input.title)}</h2><span>${escapeHtml(stateLabel(input.state))}</span></div><p>${escapeHtml(input.detail)}</p></section>`;
}

function checkDetail(check: CustomerRealmOperatorCheck | undefined, fallback: string): { readonly state: string; readonly detail: string } {
  return check
    ? { state: check.state, detail: `${check.receipt} Recovery: ${check.recoveryAction}` }
    : { state: "not-observed", detail: fallback };
}

function list(items: readonly string[], empty: string): string {
  if (items.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

export function renderCustomerRealmControlRoom(input: CustomerRealmControlRoomInput): string {
  const { status, operations } = input;
  const release = checkFor(status, "release");
  const migration = checkFor(status, "schema-migration");
  const policy = checkFor(status, "domain-residency-policy");
  const provider = checkFor(status, "binding-provider-reconciliation");
  const exportCheckpoint = checkFor(status, "export-checkpoint");
  const landing = checkFor(status, "pending-operations");
  const deployment = checkFor(status, "account-authentication");
  const health = checkFor(status, "configuration");
  const operationsBlockers = [...operations.failedKinds.map((kind) => `${kind}: failed`), ...operations.indeterminateKinds.map((kind) => `${kind}: indeterminate`), ...operations.missingKinds.map((kind) => `${kind}: missing`)];
  const identity = status.installation.installationId ?? "installation not observed";
  const releaseDigest = status.digests.release ?? "release digest not observed";
  const generatedAt = new Date().toISOString();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anyam control room</title><style>:root{color-scheme:light dark}body{font:15px system-ui,sans-serif;max-width:68rem;margin:2rem auto;padding:0 1.2rem;background:#0f1419;color:#e5e7eb}header,section,aside{border:1px solid #374151;border-radius:10px;padding:1rem 1.2rem;margin:0 0 .8rem;background:#151c24}header{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start}h1,h2{margin:.1rem 0 .5rem}h1{font-size:1.5rem}h2{font-size:1rem}.muted,.empty{color:#9ca3af}.state-heading{display:flex;align-items:center;justify-content:space-between;gap:1rem}.state-heading span{border:1px solid #6b7280;border-radius:99px;padding:.2rem .55rem;font-size:.8rem;text-transform:capitalize}.state-healthy{border-color:#166534}.state-blocked{border-color:#991b1b}.state-degraded{border-color:#a16207}.state-indeterminate{border-color:#4b5563}ul{margin:.4rem 0;padding-left:1.2rem}code{color:#c4b5fd;overflow-wrap:anywhere}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:.8rem}.receipt{font-family:ui-monospace,monospace;font-size:.78rem;overflow-wrap:anywhere;color:#cbd5e1}</style></head><body><header><div><p class="muted">Anyam state-first control room</p><h1>${escapeHtml(identity)}</h1><p class="muted">Status: <strong>${escapeHtml(stateLabel(status.status))}</strong> · generated ${escapeHtml(generatedAt)}</p></div><div><p class="muted">release</p><code>${escapeHtml(releaseDigest)}</code></div></header><div class="grid">${section({ title: "Change", ...checkDetail(migration, "No Change/migration evidence is currently observed.") })}${section({ title: "Evidence", ...checkDetail(health, "Configuration evidence is not observed.") })}${section({ title: "Landing", ...checkDetail(landing, "No pending-operation receipt is currently observed.") })}${section({ title: "Release", ...checkDetail(release, "Release state is not observed.") })}${section({ title: "Target", ...checkDetail(provider, "Target/provider reconciliation is not observed.") })}${section({ title: "Deployment", ...checkDetail(deployment, "Provider account authorization is not observed.") })}${section({ title: "Health", ...checkDetail(policy, "Domain and residency policy state is not observed.") })}</div><section><div class="state-heading"><h2>Production operations</h2><span>${escapeHtml(stateLabel(operations.status))}</span></div><p>${escapeHtml(operations.receipt)}</p>${list(operationsBlockers, "All required operational drills are verified.")}</section><aside><h2>Next actions</h2>${list(status.nextActions, "No recovery action is currently required.")}<p class="muted">This view is read-only. credential-free=true · canonicalWrite=false · targetPromotion=not-performed</p><p class="receipt">${escapeHtml(status.receipt)}</p></aside></body></html>`;
  return html;
}

export function customerRealmControlRoomResponse(input: CustomerRealmControlRoomInput): Response {
  return new Response(renderCustomerRealmControlRoom(input), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
    },
  });
}
