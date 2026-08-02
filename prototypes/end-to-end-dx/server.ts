/**
 * THROWAWAY UI PROTOTYPE — not production Anyam code.
 *
 * Question:
 * What should the end-to-end Project experience feel like for solo developers,
 * teams, public contributors, maintainers, reviewers, and operations owners?
 *
 * Three radically different information architectures are available at
 * /prototype/end-to-end-dx?variant=A|B|C.
 */

import { createServer } from "node:http";

const page = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Anyam — end-to-end developer experience prototype</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0e13;
      --panel: #121721;
      --panel-2: #171e2a;
      --line: #273244;
      --muted: #8f9bad;
      --text: #eef3fb;
      --accent: #88d8b0;
      --accent-2: #f4c66b;
      --danger: #ff8c8c;
      --blue: #8ab9ff;
      --shadow: 0 24px 70px rgba(0, 0, 0, .36);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; background: var(--bg); color: var(--text); }
    button, select { font: inherit; }
    button { color: inherit; cursor: pointer; }
    .app { min-height: 100vh; padding: 26px 28px 112px; }
    .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin: 0 auto 26px; max-width: 1440px; }
    .eyebrow { color: var(--accent); font-size: 11px; letter-spacing: .15em; text-transform: uppercase; }
    h1, h2, h3, p { margin: 0; }
    h1 { margin-top: 8px; font-size: clamp(24px, 4vw, 42px); letter-spacing: -.05em; line-height: 1; }
    h2 { font-size: 18px; letter-spacing: -.03em; }
    h3 { font-size: 13px; }
    .lede { margin-top: 10px; max-width: 690px; color: var(--muted); line-height: 1.55; font-size: 13px; }
    .role-box { display: grid; gap: 7px; min-width: 220px; }
    .role-box label, .label { color: var(--muted); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; }
    select { appearance: none; border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 7px; padding: 10px 32px 10px 12px; }
    .muted { color: var(--muted); }
    .green { color: var(--accent); }
    .yellow { color: var(--accent-2); }
    .blue { color: var(--blue); }
    .red { color: var(--danger); }
    .panel { border: 1px solid var(--line); background: linear-gradient(145deg, rgba(23,30,42,.98), rgba(15,20,29,.98)); box-shadow: var(--shadow); border-radius: 14px; }
    .panel-inner { padding: 20px; }
    .section-title { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 16px; }
    .section-title span { color: var(--muted); font-size: 11px; }
    .tag { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); font-size: 10px; white-space: nowrap; }
    .tag.live { border-color: rgba(136,216,176,.45); color: var(--accent); }
    .tag.warn { border-color: rgba(244,198,107,.5); color: var(--accent-2); }
    .tag.private { border-color: rgba(255,140,140,.45); color: var(--danger); }
    .btn { border: 1px solid var(--line); background: var(--panel-2); border-radius: 7px; padding: 10px 13px; }
    .btn.primary { background: var(--accent); color: #08120e; border-color: var(--accent); font-weight: 700; }
    .btn.ghost { color: var(--muted); }
    .btn:hover { filter: brightness(1.08); }
    .meta { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
    .metric { border-top: 1px solid var(--line); padding-top: 12px; }
    .metric strong { display: block; font-size: 18px; margin-top: 4px; }
    .bar { height: 7px; border-radius: 99px; background: #202938; overflow: hidden; }
    .bar i { display: block; width: 72%; height: 100%; background: var(--accent); border-radius: inherit; }
    .list { display: grid; gap: 10px; }
    .row { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 11px 0; border-top: 1px solid var(--line); }
    .row:first-child { border-top: 0; padding-top: 0; }
    .row:last-child { padding-bottom: 0; }
    .row-main { min-width: 0; }
    .row-main strong { display: block; font-size: 12px; }
    .row-main span { display: block; color: var(--muted); font-size: 11px; margin-top: 4px; line-height: 1.4; }
    .advanced { margin: 18px auto 0; max-width: 1440px; }
    .advanced summary { cursor: pointer; color: var(--muted); font-size: 12px; }
    .advanced-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
    .advanced-card { padding: 15px; border: 1px solid var(--line); border-radius: 10px; background: rgba(18,23,33,.72); }
    .advanced-card h3 { margin-bottom: 8px; }
    .advanced-card p { color: var(--muted); font-size: 11px; line-height: 1.5; }
    .switcher { position: fixed; z-index: 4; left: 50%; bottom: 22px; transform: translateX(-50%); display: flex; gap: 8px; align-items: center; padding: 7px 9px; border: 1px solid #4c5e78; background: rgba(9,12,17,.94); border-radius: 999px; box-shadow: 0 14px 34px rgba(0,0,0,.45); }
    .switcher button { width: 31px; height: 31px; border: 0; border-radius: 50%; background: #1d2737; }
    .switcher button:hover { background: #2a3a51; }
    .switcher .current { min-width: 185px; text-align: center; color: var(--accent); font-size: 11px; }
    .switcher .current small { color: var(--muted); margin-left: 6px; }
    .variant-note { max-width: 1440px; margin: 0 auto 17px; color: var(--muted); font-size: 11px; }

    /* Variant A: control room */
    .a-grid { display: grid; grid-template-columns: 190px minmax(0, 1fr) 300px; gap: 14px; max-width: 1440px; margin: 0 auto; }
    .a-rail { padding: 16px 12px; }
    .a-rail .rail-title { color: var(--accent); font-size: 13px; padding: 0 8px 16px; }
    .a-rail nav { display: grid; gap: 5px; }
    .a-rail nav div { color: var(--muted); padding: 9px 8px; border-radius: 6px; font-size: 11px; }
    .a-rail nav div.active { color: var(--text); background: #203126; }
    .a-center { display: grid; gap: 14px; }
    .a-hero { padding: 22px; }
    .a-hero .hero-line { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .a-hero h2 { font-size: 22px; margin-bottom: 9px; }
    .a-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 20px; }
    .a-progress { display: grid; grid-template-columns: repeat(5, 1fr); gap: 7px; margin-top: 20px; }
    .a-step { border-top: 2px solid var(--line); padding-top: 8px; color: var(--muted); font-size: 10px; }
    .a-step.done { border-color: var(--accent); color: var(--accent); }
    .a-step.current { border-color: var(--accent-2); color: var(--accent-2); }
    .a-two { display: grid; grid-template-columns: 1.1fr .9fr; gap: 14px; }
    .a-right { display: grid; gap: 14px; align-content: start; }
    .status-orb { display: flex; align-items: center; gap: 10px; }
    .orb { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 5px rgba(136,216,176,.14); }

    /* Variant B: lifecycle timeline */
    .b-shell { max-width: 1020px; margin: 0 auto; }
    .b-banner { display: grid; grid-template-columns: 1fr auto; gap: 24px; padding: 24px; align-items: end; }
    .b-banner h2 { font-size: 28px; margin-top: 9px; }
    .b-banner .actions { display: flex; gap: 8px; }
    .timeline { position: relative; display: grid; gap: 0; padding: 17px 0 0 42px; }
    .timeline::before { position: absolute; content: ""; left: 17px; top: 35px; bottom: 28px; width: 1px; background: var(--line); }
    .t-item { position: relative; padding: 0 0 24px 23px; }
    .t-dot { position: absolute; left: -31px; top: 2px; width: 15px; height: 15px; border-radius: 50%; border: 3px solid var(--bg); background: var(--line); box-shadow: 0 0 0 1px var(--line); }
    .t-item.done .t-dot { background: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .t-item.current .t-dot { background: var(--accent-2); box-shadow: 0 0 0 1px var(--accent-2); }
    .t-item h3 { margin-bottom: 7px; }
    .t-card { border: 1px solid var(--line); background: var(--panel); border-radius: 11px; padding: 15px; }
    .t-card p { color: var(--muted); font-size: 11px; line-height: 1.55; }
    .t-card .meta { margin-top: 12px; }
    .b-footer { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 15px 0 0 42px; }
    .b-footer .mini { padding: 13px; border: 1px solid var(--line); background: var(--panel); border-radius: 9px; }
    .b-footer .mini strong { display: block; margin-top: 8px; font-size: 14px; }

    /* Variant C: terminal-first */
    .c-shell { max-width: 1260px; margin: 0 auto; }
    .c-grid { display: grid; grid-template-columns: 1.05fr .95fr; gap: 14px; }
    .terminal { min-height: 560px; padding: 20px; background: #080b0f; border-color: #26352f; }
    .terminal-head { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid #213127; }
    .terminal-title { color: var(--accent); font-size: 12px; }
    .prompt-line { margin-top: 20px; color: var(--muted); font-size: 12px; }
    .prompt-line b { color: var(--accent); }
    .prompt-line .cmd { color: var(--text); }
    .log { display: grid; gap: 14px; margin-top: 22px; }
    .log-line { display: grid; grid-template-columns: 18px 1fr; gap: 10px; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .log-line .mark { color: var(--accent); }
    .log-line.warn .mark { color: var(--accent-2); }
    .log-line strong { color: var(--text); font-weight: 500; }
    .c-side { display: grid; gap: 14px; align-content: start; }
    .c-release { padding: 22px; }
    .c-release h2 { font-size: 24px; margin: 7px 0 12px; }
    .c-release .release-box { padding: 13px; border: 1px solid #315445; background: #102019; border-radius: 8px; margin-top: 17px; }
    .c-release .release-box strong { display: block; color: var(--accent); margin-bottom: 7px; }
    .c-matrix { display: grid; gap: 8px; }
    .c-matrix .matrix-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
    .c-matrix .matrix-row:first-child { border-top: 0; }

    @media (max-width: 980px) {
      .a-grid, .c-grid { grid-template-columns: 1fr; }
      .a-rail { display: none; }
      .a-right { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 680px) {
      .app { padding: 18px 14px 104px; }
      .topbar, .b-banner { grid-template-columns: 1fr; display: grid; gap: 16px; }
      .topbar { display: grid; }
      .a-two, .advanced-grid, .b-footer, .a-right { grid-template-columns: 1fr; }
      .a-progress { gap: 4px; }
      .a-step { font-size: 9px; }
      .switcher .current { min-width: 150px; }
    }
  </style>
</head>
<body>
  <main id="app"></main>
  <script>
    (function () {
      var variants = [
        { key: "A", name: "Control room" },
        { key: "B", name: "Lifecycle timeline" },
        { key: "C", name: "Terminal-first" }
      ];
      var roles = {
        solo: { label: "Solo developer", primary: "Ship to production", ceremony: "Direct path", detail: "One person can move from Change to Promotion without team ceremony when policy classifies the work low-risk." },
        team: { label: "Team developer", primary: "Submit for review", ceremony: "Two approvals pending", detail: "The same Change gains reviewers, ownership, and an Integration Cohort without a separate product mode." },
        contributor: { label: "Public contributor", primary: "Open a Change", ceremony: "Public View only", detail: "Private codec source remains undiscoverable; sealed compatibility Evidence is returned as a safe projection." },
        maintainer: { label: "Maintainer", primary: "Review and land", ceremony: "Landing authority", detail: "Maintainers see the composed Project Revision and can land approved Change Revisions." },
        reviewer: { label: "Reviewer", primary: "Review evidence", ceremony: "One finding open", detail: "Review focuses on intent, semantic effects, Evidence, and preview behavior rather than only a text diff." },
        operations: { label: "Operations owner", primary: "Promote release", ceremony: "Production guarded", detail: "Operations sees immutable Releases, health, resource state, and rollback compatibility." }
      };
      var currentVariant = new URLSearchParams(location.search).get("variant") || "A";
      if (!["A", "B", "C"].includes(currentVariant)) currentVariant = "A";
      var currentRole = new URLSearchParams(location.search).get("role") || "team";
      if (!roles[currentRole]) currentRole = "team";
      var advancedOpen = false;

      function roleSelect() {
        var html = '<div class="role-box"><label for="role">View the Project as</label><select id="role">';
        Object.keys(roles).forEach(function (key) {
          html += '<option value="' + key + '"' + (key === currentRole ? ' selected' : '') + '>' + roles[key].label + '</option>';
        });
        html += '</select></div>';
        return html;
      }
      function header(copy) {
        return '<header class="topbar"><div><div class="eyebrow">Anyam / Project control room</div><h1>Video Player</h1><p class="lede">' + copy + '</p></div>' + roleSelect() + '</header>';
      }
      function tags() {
        return '<div class="meta"><span class="tag live">● preview healthy</span><span class="tag">public/community</span><span class="tag private">private/codec</span><span class="tag">Change CHG-24</span></div>';
      }
      function advanced() {
        return '<details class="advanced"' + (advancedOpen ? ' open' : '') + '><summary>Advanced surfaces — Source Spaces, grants, Evidence, and policy</summary><div class="advanced-grid"><div class="advanced-card"><h3>Source Spaces</h3><p>community · public read<br>codec · private read for maintainers<br>sealed-tests · result-only</p></div><div class="advanced-card"><h3>Current grant</h3><p>agent:claude · Workspace write<br>MCP tools: checks, publish revision<br>canonical write: denied</p></div><div class="advanced-card"><h3>Evidence freshness</h3><p>12 checks bound to rev-7<br>one reviewer finding remains<br>policy v18 · base main@91bd</p></div></div></details>';
      }
      function buttons(role) {
        return '<div class="a-actions"><button class="btn primary">' + role.primary + '</button><button class="btn ghost">Open Change</button><button class="btn ghost">Ask agent</button></div>';
      }
      function variantA() {
        var role = roles[currentRole];
        return '<div class="app">' + header('A command centre for the current Project state: active work, a live candidate, and the next safe state transition.') + '<div class="variant-note">Variant A · dense control room · primary action stays beside the current Change.</div><section class="a-grid"><aside class="panel a-rail"><div class="rail-title">VIDEO PLAYER</div><nav><div class="active">Overview</div><div>Code</div><div>Changes <span class="muted">(4)</span></div><div>Releases</div><div>Targets</div><div>Agents</div><div>Settings</div></nav></aside><div class="a-center"><section class="panel a-hero"><div class="hero-line"><div><div class="eyebrow">Active Change</div><h2>Replace codec fallback</h2><p class="muted">' + role.detail + '</p></div><span class="tag warn">' + role.ceremony + '</span></div>' + tags() + buttons(role) + '<div class="a-progress"><div class="a-step done">1 · Intent</div><div class="a-step done">2 · Workspace</div><div class="a-step done">3 · Checks</div><div class="a-step current">4 · Review</div><div class="a-step">5 · Promote</div></div></section><div class="a-two"><section class="panel panel-inner"><div class="section-title"><h2>What changed</h2><span>rev-7</span></div><div class="list"><div class="row"><div class="row-main"><strong>Public API</strong><span>Added selectCodec() contract</span></div><span class="tag">+2 files</span></div><div class="row"><div class="row-main"><strong>Private effect</strong><span>Codec implementation stays hidden from public View</span></div><span class="tag private">restricted</span></div><div class="row"><div class="row-main"><strong>Runtime candidate</strong><span>Preview request traces and playback sample</span></div><span class="tag live">ready</span></div></div></section><section class="panel panel-inner"><div class="section-title"><h2>Checks</h2><span>7 / 8</span></div><div class="bar"><i></i></div><div class="list" style="margin-top:16px"><div class="row"><div class="row-main"><strong>Public build</strong><span>community Project View</span></div><span class="green">pass</span></div><div class="row"><div class="row-main"><strong>Sealed compatibility</strong><span>private codec suite</span></div><span class="green">pass</span></div><div class="row"><div class="row-main"><strong>Maintainer review</strong><span>one finding to resolve</span></div><span class="yellow">open</span></div></div></section></div></div><aside class="a-right"><section class="panel panel-inner"><div class="section-title"><h2>Production</h2><span>Target</span></div><div class="status-orb"><span class="orb"></span><div><strong>v0.8.3 · healthy</strong><div class="muted" style="font-size:11px;margin-top:4px">main@91bd · 18 min ago</div></div></div><div class="metric" style="margin-top:20px"><span class="label">Next release</span><strong>rel-24</strong><span class="muted" style="font-size:11px">preview ready · promotion guarded</span></div><button class="btn" style="width:100%;margin-top:16px">View deployment</button></section><section class="panel panel-inner"><div class="section-title"><h2>Attention</h2><span>3 items</span></div><div class="list"><div class="row"><div class="row-main"><strong>Reviewer finding</strong><span>Fallback telemetry is too noisy</span></div><span class="yellow">open</span></div><div class="row"><div class="row-main"><strong>Agent session</strong><span>Claude · Workspace active</span></div><span class="green">live</span></div><div class="row"><div class="row-main"><strong>Private source</strong><span>no public disclosure detected</span></div><span class="green">safe</span></div></div></section></aside></section>' + advanced() + switcher() + '</div>';
      }
      function variantB() {
        var role = roles[currentRole];
        return '<div class="app"><div class="b-shell">' + header('A calm sequence from intent to release. The Project is understood as a lifecycle, not a collection of repository pages.') + '<div class="variant-note">Variant B · lifecycle timeline · the next state transition is the primary navigation.</div><section class="panel b-banner"><div><div class="eyebrow">Project lifecycle</div><h2>Replace codec fallback</h2><p class="muted" style="margin-top:10px">' + role.detail + '</p></div><div class="actions">' + buttons(role).replace('class="a-actions"', 'class="actions"') + '</div></section><section class="panel" style="margin-top:14px"><div class="panel-inner"><div class="timeline"><div class="t-item done"><span class="t-dot"></span><h3>Intent · Why this exists</h3><div class="t-card"><p>Improve playback resilience without exposing the proprietary codec. Public contributors work against the community View; maintainers compose the private implementation.</p><div class="meta"><span class="tag">INT-42</span><span class="tag">owner: media team</span></div></div></div><div class="t-item done"><span class="t-dot"></span><h3>Workspace · Where work happens</h3><div class="t-card"><p>Claude is working in an isolated Workspace from <span class="blue">main@91bd</span>. The public and private Source Spaces are mounted only for the current grant.</p><div class="meta"><span class="tag live">agent active</span><span class="tag">Workspace W-24</span><span class="tag private">codec hidden from public View</span></div></div></div><div class="t-item current"><span class="t-dot"></span><h3>Candidate · What can be inspected now</h3><div class="t-card"><p>Preview is healthy. Seven checks pass. One reviewer finding remains before the Change can move to Landing.</p><div class="meta"><button class="btn primary">' + role.primary + '</button><span class="tag warn">' + role.ceremony + '</span></div></div></div><div class="t-item"><span class="t-dot"></span><h3>Release · What becomes immutable</h3><div class="t-card"><p>rel-24 will bind the public SDK, private codec artifact, configuration digest, and Evidence bundle without rebuilding at Promotion.</p><div class="meta"><span class="tag">not created</span><span class="tag">policy v18</span></div></div></div><div class="t-item"><span class="t-dot"></span><h3>Target · Where it goes</h3><div class="t-card"><p>Production is currently on v0.8.3. Promotion is separate from Landing and can be rolled back to the previous immutable Release.</p><div class="meta"><span class="tag">production</span><span class="tag">rollback available</span></div></div></div></div><div class="b-footer"><div class="mini"><span class="label">Current source</span><strong>main@91bd</strong></div><div class="mini"><span class="label">Preview</span><strong class="green">healthy</strong></div><div class="mini"><span class="label">Production</span><strong>v0.8.3</strong></div></div></div></section>' + advanced() + switcher() + '</div></div>';
      }
      function variantC() {
        var role = roles[currentRole];
        return '<div class="app"><div class="c-shell">' + header('A terminal-first workspace for technical users: the command history is visible, while release impact and governance stay beside it.') + '<div class="variant-note">Variant C · terminal-first · source-control fluency is the default, with delivery state always visible.</div><div class="c-grid"><section class="panel terminal"><div class="terminal-head"><div class="terminal-title">anyam / acme / video-player</div><span class="tag live">Workspace W-24</span></div><div class="prompt-line"><b>anyam@video-player</b> <span class="cmd">$ anyam change status</span></div><div class="log"><div class="log-line"><span class="mark">✓</span><div><strong>Intent</strong><br>Replace codec fallback · INT-42</div></div><div class="log-line"><span class="mark">✓</span><div><strong>Workspace</strong><br>community + private/codec mounted for agent:claude</div></div><div class="log-line"><span class="mark">✓</span><div><strong>Revision</strong><br>rev-7 published from main@91bd · canonical write denied</div></div><div class="log-line"><span class="mark">✓</span><div><strong>Preview</strong><br>https://chg-24.preview.video-player.example · healthy</div></div><div class="log-line warn"><span class="mark">!</span><div><strong>Review</strong><br>one finding: fallback telemetry is too noisy</div></div></div><div class="prompt-line"><b>anyam@video-player</b> <span class="cmd">$ anyam change publish</span></div><div class="log-line warn" style="margin-top:14px"><span class="mark">→</span><div>Waiting for <strong>' + role.ceremony + '</strong> · suggested action: <strong>' + role.primary + '</strong></div></div><div class="a-actions" style="margin-top:28px"><button class="btn primary">' + role.primary + '</button><button class="btn ghost">Open preview</button><button class="btn ghost">Ask agent</button></div></section><aside class="c-side"><section class="panel c-release"><div class="eyebrow">Delivery state</div><h2>rel-24</h2><p class="muted">A release is a durable, inspectable object—not a side effect of git push.</p><div class="release-box"><strong>Production v0.8.3</strong><span class="muted" style="font-size:11px">healthy · source main@91bd · rollback ready</span></div><div class="c-matrix" style="margin-top:20px"><div class="matrix-row"><span>public SDK</span><span class="green">verified</span></div><div class="matrix-row"><span>private codec</span><span class="green">attested</span></div><div class="matrix-row"><span>sealed checks</span><span class="green">7 / 7</span></div><div class="matrix-row"><span>production promotion</span><span class="yellow">guarded</span></div></div></section><section class="panel panel-inner"><div class="section-title"><h2>Shortcuts</h2><span>technical view</span></div><div class="list"><div class="row"><div class="row-main"><strong>Source</strong><span>Unified status across Source Spaces</span></div><span class="blue">open</span></div><div class="row"><div class="row-main"><strong>Evidence</strong><span>Inputs, toolchain, verifier, freshness</span></div><span class="blue">inspect</span></div><div class="row"><div class="row-main"><strong>Agents</strong><span>Claude active · grant task-scoped</span></div><span class="blue">manage</span></div></div></section></aside></div>' + advanced() + switcher() + '</div></div>';
      }
      function switcher() {
        var index = variants.findIndex(function (variant) { return variant.key === currentVariant; });
        var variant = variants[index];
        return '<div class="switcher" aria-label="Prototype variant switcher"><button id="prev" aria-label="Previous variant">←</button><div class="current">' + variant.key + ' — ' + variant.name + '<small>←/→</small></div><button id="next" aria-label="Next variant">→</button></div>';
      }
      function render() {
        var app = document.getElementById("app");
        app.innerHTML = currentVariant === "A" ? variantA() : currentVariant === "B" ? variantB() : variantC();
        var select = document.getElementById("role");
        if (select) select.addEventListener("change", function (event) {
          currentRole = event.target.value;
          var url = new URL(location.href); url.searchParams.set("role", currentRole); history.replaceState({}, "", url); render();
        });
        var summary = document.querySelector(".advanced summary");
        if (summary) summary.addEventListener("click", function () { advancedOpen = !advancedOpen; });
        document.getElementById("prev").addEventListener("click", function () { changeVariant(-1); });
        document.getElementById("next").addEventListener("click", function () { changeVariant(1); });
      }
      function changeVariant(delta) {
        var index = variants.findIndex(function (variant) { return variant.key === currentVariant; });
        currentVariant = variants[(index + delta + variants.length) % variants.length].key;
        var url = new URL(location.href); url.searchParams.set("variant", currentVariant); url.searchParams.set("role", currentRole); history.replaceState({}, "", url); render();
      }
      document.addEventListener("keydown", function (event) {
        var target = event.target;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
        if (event.key === "ArrowLeft") changeVariant(-1);
        if (event.key === "ArrowRight") changeVariant(1);
      });
      render();
    })();
  </script>
</body>
</html>`;

const port = Number(process.env.ANYAM_PROTOTYPE_PORT ?? "4321");
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Anyam end-to-end DX prototype: http://127.0.0.1:${port}/prototype/end-to-end-dx?variant=A&role=team`);
  console.log("Variants: A control room · B lifecycle timeline · C terminal-first");
});
