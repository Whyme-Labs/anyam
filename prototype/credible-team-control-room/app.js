const params = new URLSearchParams(window.location.search);
const variants = [
  { key: "A", name: "Change room" },
  { key: "B", name: "Operations board" },
  { key: "C", name: "Project graph" },
];

const state = {
  variant: variants.some((item) => item.key === params.get("variant")) ? params.get("variant") : "A",
  role: params.get("role") === "solo" ? "solo" : "team",
  tab: params.get("tab") ?? "overview",
  project: {
    name: "Atlas video player",
    slug: "acme/atlas-player",
    canonical: "prjrev:8a42c1",
    profile: params.get("role") === "solo" ? "Solo Profile" : "Team Profile",
  },
  change: {
    id: "CHG-142",
    title: "Add resumable playback",
    status: "Workspace active",
    revision: "rev:chg-142-r3",
    base: "prjrev:8a42c1",
    author: "Wei · human",
    workspace: "W-82",
    approvals: 0,
  },
  checks: [
    { name: "Typecheck and unit", status: "passed", detail: "42 tests · 18s" },
    { name: "Browser playback", status: "passed", detail: "12 scenarios · 46s" },
    { name: "Private codec verifier", status: "passed", detail: "sealed result · 31s" },
  ],
  release: { id: "rel:atlas-16", status: "verified", artifact: "sha256:7f14…a02b" },
  target: { name: "production", current: "rel:atlas-16", health: "healthy", url: "atlas.example.com" },
  mirror: { name: "github.com/acme/atlas-player", status: "in sync", generation: "gh:984" },
  spaces: [
    { name: "public-player", visibility: "public", access: "read / propose", note: "community projection" },
    { name: "private-codec", visibility: "restricted", access: "team only", note: "not in public View" },
  ],
  checkpoints: [
    ["Adoption start", "complete", "owner: Wei"],
    ["Workspace authority", "complete", "canonical write denied"],
    ["Checks and Evidence", "complete", "3 / 3 passed"],
    ["Independent review", "active", "Team Profile · 1 required"],
    ["Release and Target", "pending", "awaiting Landing"],
    ["Export / restore", "pending", "owner checkpoint"],
  ],
  agents: [
    { name: "Codex", actor: "agent:codex-184", state: "published r3", capability: "workspace.write · change.publish" },
    { name: "Claude Code", actor: "agent:claude-091", state: "reviewed r2", capability: "change.read · review.finding" },
  ],
  events: [
    ["09:41", "Anyam", "Materialized Workspace W-82 from prjrev:8a42c1."],
    ["09:44", "Codex", "Published rev:chg-142-r3 with declared API and codec effects."],
    ["09:46", "Anyam", "Private codec verifier returned sealed Evidence."],
  ],
  failure: null,
  export: { status: "not started", digest: "—" },
};

const app = document.querySelector("#app");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function badge(text, kind = "") { return `<span class="badge ${kind}">${escapeHtml(text)}</span>`; }
function statusKind(status) {
  if (["passed", "verified", "healthy", "complete", "in sync", "Landed", "ready"].includes(status)) return "good";
  if (["blocked", "unhealthy", "failed"].includes(status)) return "bad";
  return "warn";
}
function stateBadge(status) { return badge(status, statusKind(status)); }
function button(label, action, kind = "secondary", disabled = false) { return `<button class="${kind}-button" data-action="${action}"${disabled ? " disabled" : ""}>${escapeHtml(label)}</button>`; }
function time() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function addEvent(actor, text) { state.events.unshift([time(), actor, text]); }
function currentCheckCount() { return state.checks.filter((item) => item.status === "passed").length; }
function allChecksPassed() { return currentCheckCount() === state.checks.length; }

function header() {
  const tabs = ["overview", "change", "release", "recovery"];
  return `<div class="prototype-ribbon">throwaway prototype</div>
    <header class="topbar">
      <div class="brand"><div class="brand-mark">A</div><div><div class="eyebrow">Anyam control room</div><div class="brand-name">${escapeHtml(state.project.slug)}</div></div></div>
      <div class="top-actions">
        <div class="role-toggle" aria-label="ceremony profile">
          <button data-role="solo" class="${state.role === "solo" ? "active" : ""}">Solo</button>
          <button data-role="team" class="${state.role === "team" ? "active" : ""}">Team</button>
        </div>
        ${stateBadge(state.target.health)}
      </div>
    </header>
    <nav class="tabs" aria-label="project navigation">${tabs.map((tab) => `<button class="tab ${state.tab === tab ? "active" : ""}" data-tab="${tab}">${tab[0].toUpperCase()}${tab.slice(1)}</button>`).join("")}</nav>`;
}

function hero(copy, kicker = "Project") {
  return `<section class="hero"><div><div class="eyebrow">${escapeHtml(kicker)} · ${escapeHtml(state.project.profile)}</div><h1>${copy}</h1><p>One canonical Project Revision, two governed Source Spaces, and a visible path from Change to verified Release. GitHub is a projection; Anyam Landing is the authority.</p></div><div class="hero-side">${stateBadge(`canonical ${state.project.canonical}`)}<span>Last receipt · ${escapeHtml(state.events[0]?.[0] ?? "—")}</span></div></section>`;
}

function stateStrip() {
  const cells = [
    ["Canonical", state.project.canonical, "Anyam Landing only"],
    ["Change", state.change.status, `${state.change.id} · ${state.change.revision}`],
    ["Checks", `${currentCheckCount()} / ${state.checks.length} passed`, "Evidence freshness: current"],
    ["Release", state.release.status, `${state.release.id} · ${state.release.artifact}`],
    ["Target", state.target.health, state.target.current],
  ];
  return `<div class="state-strip">${cells.map(([label, value, detail]) => `<div class="state-cell"><div class="eyebrow">${escapeHtml(label)}</div><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>`).join("")}</div>`;
}

function activeChangePanel() {
  return `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">${escapeHtml(state.change.id)} · ${escapeHtml(state.change.title)}</h2><p class="panel-subtitle">${escapeHtml(state.change.author)} · base <span class="mono">${escapeHtml(state.change.base)}</span> · ${escapeHtml(state.change.workspace)}</p></div>${stateBadge(state.change.status)}</div><div class="panel-body">
    <div class="button-row">
      ${button("Publish revision", "publish", "primary", state.change.status === "Landed")}
      ${button("Run checks", "checks", "secondary", state.change.status === "Landed")}
      ${button(state.change.approvals ? "Review recorded" : "Request review", "review", "secondary", state.change.status === "Landed")}
      ${button("Land Change", "land", "primary", !(allChecksPassed() && state.change.approvals > 0) || state.change.status === "Landed")}
    </div>
    <div class="timeline" style="margin-top:22px">
      ${[ ["Workspace", "Isolated write authority", "complete", "Workspace W-82 can publish revisions; canonical write is denied."], ["Checks", "Required Evidence", allChecksPassed() ? "good" : "warn", `${currentCheckCount()} of ${state.checks.length} checks are valid for ${state.change.revision}.`], ["Review", "Independent human approval", state.change.approvals > 0 ? "good" : "active", state.change.approvals > 0 ? "Wei approved this exact revision." : "Team Profile requires one independent human Reviewer."], ["Landing", "Canonical Project Revision", state.change.status === "Landed" ? "good" : "warn", state.change.status === "Landed" ? `Landed as ${state.project.canonical}.` : "Only the trusted Landing service may update canonical state."] ].map(([title, subtitle, kind, detail]) => `<div class="timeline-item"><div class="timeline-dot ${kind}"></div><div><h3>${subtitle} <span class="eyebrow">· ${title}</span></h3><p>${detail}</p></div></div>`).join("")}
    </div>
  </div></section>`;
}

function authorityPanel() {
  return `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Authority and disclosure</h2><p class="panel-subtitle">The control room explains what each actor may do.</p></div>${badge("fail closed")}</div><div class="panel-body">
    <div class="statline"><span>Canonical write</span><strong>${badge("Landing service only", "good")}</strong></div>
    <div class="statline"><span>Current actor</span><strong>Wei · human</strong></div>
    <div class="statline"><span>Agent grants</span><strong>${state.agents.length} task sessions</strong></div>
    <div class="statline"><span>Public View</span><strong>public-player only</strong></div>
    <div class="statline"><span>Private codec</span><strong>team-only / sealed verifier</strong></div>
    <div class="callout" style="margin-top:14px">A direct push to canonical <span class="mono">main</span> is denied with a policy receipt. The agent can publish a Change Revision, never Landing or production Promotion.</div>
  </div></section>`;
}

function checksPanel() {
  return `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Runs and Evidence</h2><p class="panel-subtitle">Every result stays bound to the exact revision and policy.</p></div>${stateBadge(allChecksPassed() ? "all passed" : "running")}</div><div class="panel-body"><ul class="list">${state.checks.map((item) => `<li class="list-item"><div class="main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.detail)}</small></div>${stateBadge(item.status)}</li>`).join("")}</ul></div></section>`;
}

function activityPanel() {
  return `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Activity and receipts</h2><p class="panel-subtitle">In-memory prototype state; nothing is persisted or deployed.</p></div>${badge("observable state")}</div><div class="panel-body activity">${state.events.map(([at, actor, text]) => `<div class="activity-row"><div class="activity-time">${escapeHtml(at)}</div><div class="activity-text"><strong>${escapeHtml(actor)}</strong> · ${escapeHtml(text)}</div></div>`).join("")}</div></section>`;
}

function releasePanel() {
  return `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Release and Target</h2><p class="panel-subtitle">Promote an existing verified Release; never rebuild source at the Target.</p></div>${stateBadge(state.target.health)}</div><div class="panel-body"><div class="statline"><span>Release</span><strong>${escapeHtml(state.release.id)}</strong></div><div class="statline"><span>Artifact</span><strong class="mono">${escapeHtml(state.release.artifact)}</strong></div><div class="statline"><span>Current Target</span><strong>${escapeHtml(state.target.current)}</strong></div><div class="statline"><span>Health</span><strong>${stateBadge(state.target.health)}</strong></div><div class="button-row" style="margin-top:14px">${button("Build verified Release", "build", "secondary", state.change.status !== "Landed")}${button("Promote to production", "promote", "primary", state.release.status !== "verified" || state.change.status !== "Landed")}${button("Simulate failed promotion", "fail", "danger", state.change.status !== "Landed")}${button("Rollback known-good", "rollback", "secondary", !state.failure)}</div>${state.failure ? `<div class="callout bad" style="margin-top:14px">${escapeHtml(state.failure)} Rollback is available and does not rewrite source history.</div>` : ""}</div></section>`;
}

function spacesPanel() {
  return `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Source Spaces and mirror</h2><p class="panel-subtitle">The Project View is composed without leaking inaccessible state.</p></div>${stateBadge(state.mirror.status)}</div><div class="panel-body"><div class="disclosure">${state.spaces.map((space) => `<div class="space-row"><div><strong>${escapeHtml(space.name)}</strong><small>${escapeHtml(space.note)}</small></div><div>${badge(space.visibility)} ${badge(space.access)}</div></div>`).join("")}</div><div class="statline" style="margin-top:12px"><span>GitHub projection</span><strong>${escapeHtml(state.mirror.name)}</strong></div><div class="statline"><span>Remote generation</span><strong class="mono">${escapeHtml(state.mirror.generation)}</strong></div><div class="callout" style="margin-top:12px">GitHub commits enter Anyam as proposed Changes. Divergence pauses the Mirror Operation; it never creates a second canonical authority.</div></div></section>`;
}

function checkpointPanel() {
  return `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Operator checkpoints</h2><p class="panel-subtitle">Each checkpoint is resumable and never implies overall success.</p></div>${badge("owner-visible")}</div><div class="panel-body"><table class="table"><thead><tr><th>Checkpoint</th><th>Receipt</th><th>State</th></tr></thead><tbody>${state.checkpoints.map(([name, status, detail]) => `<tr><td>${escapeHtml(name)}</td><td class="mono">${escapeHtml(detail)}</td><td>${stateBadge(status)}</td></tr>`).join("")}</tbody></table></div></section>`;
}

function agentsPanel() {
  return `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Agents and actors</h2><p class="panel-subtitle">Different coding agents, one Anyam capability contract.</p></div>${badge("task-scoped")}</div><div class="panel-body"><ul class="list">${state.agents.map((agent) => `<li class="list-item"><div class="main"><strong>${escapeHtml(agent.name)} <span class="eyebrow">${escapeHtml(agent.actor)}</span></strong><small>${escapeHtml(agent.capability)}</small></div>${badge(agent.state, "good")}</li>`).join("")}</ul></div></section>`;
}

function exportPanel() {
  return `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Recovery and export</h2><p class="panel-subtitle">A customer-verifiable round trip, not a metadata-only backup.</p></div>${stateBadge(state.export.status)}</div><div class="panel-body"><div class="statline"><span>Package</span><strong>Project Export v1</strong></div><div class="statline"><span>Contents</span><strong>Git + Changes + Evidence + Releases + policy</strong></div><div class="statline"><span>Digest</span><strong class="mono">${escapeHtml(state.export.digest)}</strong></div><div class="button-row" style="margin-top:14px">${button("Create export receipt", "export", "secondary")}${button("Open recovery plan", "recovery", "primary")}</div></div></section>`;
}

function variantA() {
  return `${hero("Make the next Change obvious.", "Change room")}${stateStrip()}<div class="grid two" style="margin-top:14px">${activeChangePanel()}${authorityPanel()}</div><div class="grid two" style="margin-top:14px">${checksPanel()}${releasePanel()}</div><div class="grid two" style="margin-top:14px">${spacesPanel()}${agentsPanel()}</div><div class="grid two" style="margin-top:14px">${checkpointPanel()}${activityPanel()}</div>`;
}

function variantB() {
  return `${hero("See the whole delivery system at a glance.", "Operations board")}<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Promotion pipeline</h2><p class="panel-subtitle">A dense team view for people who want state before narrative.</p></div>${stateBadge(state.change.status)}</div><div class="panel-body"><div class="flow"><div class="flow-node good"><div class="eyebrow">01 · Source</div><h3>${escapeHtml(state.project.canonical)}</h3><p>Anyam canonical Project Revision. GitHub is projection only.</p></div><div class="flow-node active"><div class="eyebrow">02 · Change</div><h3>${escapeHtml(state.change.id)}</h3><p>${escapeHtml(state.change.revision)} · Workspace W-82</p></div><div class="flow-node ${allChecksPassed() ? "good" : "warn"}"><div class="eyebrow">03 · Evidence</div><h3>${currentCheckCount()} / ${state.checks.length} passed</h3><p>Unit, browser, sealed codec verifier.</p></div><div class="flow-node ${state.release.status === "verified" ? "good" : "warn"}"><div class="eyebrow">04 · Release</div><h3>${escapeHtml(state.release.id)}</h3><p>${escapeHtml(state.release.artifact)}</p></div><div class="flow-node ${state.target.health === "healthy" ? "good" : "bad"}"><div class="eyebrow">05 · Target</div><h3>${escapeHtml(state.target.health)}</h3><p>${escapeHtml(state.target.url)} · ${escapeHtml(state.target.current)}</p></div></div></div></section><div class="grid three" style="margin-top:14px">${checkpointPanel()}${releasePanel()}${authorityPanel()}</div><div class="grid two" style="margin-top:14px">${checksPanel()}${spacesPanel()}</div><div class="grid two" style="margin-top:14px">${agentsPanel()}${activityPanel()}</div>`;
}

function variantC() {
  return `${hero("Trace authority from source to live Target.", "Project graph")}<div class="graph"><aside class="graph-rail"><div class="graph-node selected"><div class="eyebrow">Project</div><h3>${escapeHtml(state.project.name)}</h3><p>${escapeHtml(state.project.canonical)} · ${escapeHtml(state.project.profile)}</p></div><div class="graph-node"><div class="eyebrow">Mirror</div><h3>${escapeHtml(state.mirror.status)}</h3><p>${escapeHtml(state.mirror.name)}</p></div><div class="graph-node"><div class="eyebrow">View boundary</div><h3>Public projection</h3><p>public-player is visible; private-codec is absent.</p></div>${agentsPanel()}</aside><section class="graph-canvas"><div class="graph-center"><div class="graph-stack"><div class="graph-card"><div class="eyebrow">Source state</div><h3>${escapeHtml(state.project.canonical)}</h3><p>Project Revision composes the public player and restricted codec snapshots without exposing private identifiers to the public View.</p></div><div class="graph-arrow">↓</div><div class="graph-card"><div class="eyebrow">Proposed state</div><h3>${escapeHtml(state.change.id)} · ${escapeHtml(state.change.status)}</h3><p>${escapeHtml(state.change.revision)} · ${escapeHtml(state.change.workspace)} · author ${escapeHtml(state.change.author)}</p><div class="button-row" style="margin-top:12px">${button("Run checks", "checks", "secondary")}${button("Review", "review", "secondary")}${button("Land", "land", "primary", !(allChecksPassed() && state.change.approvals > 0))}</div></div><div class="graph-arrow">↓</div><div class="graph-card"><div class="eyebrow">Verified delivery</div><h3>${escapeHtml(state.release.id)} → ${escapeHtml(state.target.name)}</h3><p>${escapeHtml(state.release.status)} Release · ${escapeHtml(state.target.health)} Target · promotion never rebuilds source.</p><div class="button-row" style="margin-top:12px">${button("Build Release", "build", "secondary", state.change.status !== "Landed")}${button("Promote", "promote", "primary", state.release.status !== "verified" || state.change.status !== "Landed")}</div></div></div></div></section><aside class="graph-rail">${spacesPanel()}${checkpointPanel()}${activityPanel()}</aside></div>`;
}

function tabContent() {
  if (state.tab === "change") return `${hero("Work in the bounded Change, not a shared branch.", "Change")}${activeChangePanel()}<div class="grid two" style="margin-top:14px">${checksPanel()}${authorityPanel()}</div><div style="margin-top:14px">${activityPanel()}</div>`;
  if (state.tab === "release") return `${hero("Promote verified output, never an unreviewed branch.", "Release")}${releasePanel()}<div class="grid two" style="margin-top:14px">${checkpointPanel()}${spacesPanel()}</div><div style="margin-top:14px">${activityPanel()}</div>`;
  if (state.tab === "recovery") return `${hero("Recover from a checkpoint without rewriting history.", "Recovery")}${exportPanel()}<div class="grid two" style="margin-top:14px">${checkpointPanel()}${authorityPanel()}</div><div style="margin-top:14px">${activityPanel()}</div>`;
  if (state.variant === "B") return variantB();
  if (state.variant === "C") return variantC();
  return variantA();
}

function switcher() {
  const index = variants.findIndex((item) => item.key === state.variant);
  const current = variants[index];
  return `<div class="switcher" role="group" aria-label="prototype variants"><button data-variant="prev" aria-label="previous variant">←</button><div class="switcher-label"><strong>${current.key}</strong> · ${current.name}</div><button data-variant="next" aria-label="next variant">→</button></div>`;
}

function render() {
  app.innerHTML = `<div class="shell">${header()}${tabContent()}<div class="footer-note">Prototype question: which control-room shape helps a technical team move from Project creation to a verified Release without hiding authority, disclosure, or recovery state? Variant changes and actions are local-only and disappear on reload.</div></div>${switcher()}`;
}

function setUrl(values) {
  const next = new URL(window.location.href);
  Object.entries(values).forEach(([key, value]) => next.searchParams.set(key, value));
  window.history.replaceState({}, "", next);
}

function runChecks() {
  state.checks.forEach((item) => { item.status = "passed"; });
  state.change.status = state.change.status === "Workspace active" ? "Checks passed" : state.change.status;
  addEvent("Anyam", `Checks passed for ${state.change.revision}; Evidence keys are current.`);
}

function handleAction(action) {
  if (action === "publish") { state.change.status = "Revision published"; addEvent("Wei", `Published ${state.change.revision} to ${state.change.id}; canonical write remained denied.`); }
  if (action === "checks") { runChecks(); }
  if (action === "review") { state.change.approvals = 1; state.change.status = "Ready to land"; state.checkpoints[3][1] = "complete"; state.checkpoints[3][2] = "approval:rev-chg-142-r3"; addEvent("Wei", `Approved ${state.change.revision} as the independent Reviewer.`); }
  if (action === "land") { if (!allChecksPassed() || state.change.approvals === 0) return; state.change.status = "Landed"; state.project.canonical = "prjrev:chg-142-r3"; state.checkpoints[4][1] = "active"; state.checkpoints[4][2] = "release pending"; addEvent("Landing service", `Landed ${state.change.id} as ${state.project.canonical}; no agent received canonical write.`); }
  if (action === "build") { if (state.change.status !== "Landed") return; state.release = { id: "rel:atlas-17", status: "verified", artifact: "sha256:91bd…47ca" }; state.checkpoints[4][1] = "complete"; state.checkpoints[4][2] = "release:rel-atlas-17"; addEvent("Build", `Verified ${state.release.id} from ${state.project.canonical}.`); }
  if (action === "promote") { if (state.release.status !== "verified" || state.change.status !== "Landed") return; state.target = { ...state.target, current: state.release.id, health: "healthy" }; state.failure = null; addEvent("Promotion service", `Promoted ${state.release.id} to ${state.target.name}; health receipt is healthy.`); }
  if (action === "fail") { state.target.health = "unhealthy"; state.failure = "Promotion health check returned 503 for the candidate Target."; addEvent("Target", `Promotion of ${state.release.id} degraded; rollback is available.`); }
  if (action === "rollback") { state.target = { ...state.target, current: "rel:atlas-16", health: "healthy" }; state.failure = null; addEvent("Promotion service", "Rolled back to rel:atlas-16; source history was not rewritten."); }
  if (action === "export") { state.export = { status: "verified", digest: "sha256:export…b742" }; state.checkpoints[5][1] = "complete"; state.checkpoints[5][2] = "restore:verified"; addEvent("Anyam", "Export/restore round trip verified in a clean Realm (prototype receipt)." ); }
  if (action === "recovery") { state.failure = "No active failure. Recovery starts from the latest owner-visible checkpoint."; addEvent("Anyam", "Opened recovery plan; no authority or history was changed."); }
  render();
}

app.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.action) handleAction(target.dataset.action);
  if (target.dataset.role) { state.role = target.dataset.role; state.project.profile = state.role === "solo" ? "Solo Profile" : "Team Profile"; setUrl({ role: state.role }); render(); }
  if (target.dataset.tab) { state.tab = target.dataset.tab; setUrl({ tab: state.tab }); render(); }
  if (target.dataset.variant) {
    const index = variants.findIndex((item) => item.key === state.variant);
    const next = target.dataset.variant === "next" ? (index + 1) % variants.length : (index - 1 + variants.length) % variants.length;
    state.variant = variants[next].key; setUrl({ variant: state.variant }); render();
  }
});

window.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const element = document.activeElement;
  if (element && (element.matches("input, textarea, [contenteditable]"))) return;
  const index = variants.findIndex((item) => item.key === state.variant);
  const next = event.key === "ArrowRight" ? (index + 1) % variants.length : (index - 1 + variants.length) % variants.length;
  event.preventDefault(); state.variant = variants[next].key; setUrl({ variant: state.variant }); render();
});

render();
