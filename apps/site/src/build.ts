import { ANYAM_BRAND } from "../../../src/brand.js";
import { documentationBody } from "./docs.js";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const siteDirectory = resolve(sourceDirectory, "..");
const outputDirectory = resolve(siteDirectory, "dist");
const repositoryDirectory = resolve(siteDirectory, "../..");
const siteOrigin = "https://anyam.whymelabs.com";

type Page = {
  title: string;
  description: string;
  current: "home" | "docs" | "examples";
  body: string;
  dark?: boolean;
  path?: string;
};

const navigation = [
  ["Why Anyam", "/", "home"],
  ["Docs", "/docs/", "docs"],
  ["Examples", "/examples/", "examples"],
] as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function codeBlock(value: string, label = "Shell"): string {
  return `<div class="code-block"><div class="code-label">${label}</div><pre><code>${escapeHtml(value)}</code></pre></div>`;
}

function button(value: string, label = "Copy command"): string {
  return `<button class="copy-button" type="button" data-copy="${escapeHtml(value)}"><span>${label}</span><span class="copy-state" aria-live="polite">Copy</span></button>`;
}

function layout(page: Page): string {
  const links = navigation.map(([label, href, key]) => `<a class="nav-link${page.current === key ? " is-active" : ""}" href="${href}"${page.current === key ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  const themeClass = page.dark ? " page-dark" : "";
  const canonicalPath = page.path ?? "/";
  const canonicalUrl = `${siteOrigin}${canonicalPath}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="${ANYAM_BRAND.colors.ink}">
  <title>${escapeHtml(page.title)} · Anyam</title>
  <meta name="description" content="${escapeHtml(page.description)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Anyam">
  <meta property="og:title" content="${escapeHtml(page.title)} · Anyam">
  <meta property="og:description" content="${escapeHtml(page.description)}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:image" content="${siteOrigin}/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(page.title)} · Anyam">
  <meta name="twitter:description" content="${escapeHtml(page.description)}">
  <meta name="twitter:image" content="${siteOrigin}/og.png">
  <link rel="canonical" href="${canonicalUrl}">
  <link rel="icon" href="/assets/anyam-mark-black.png" type="image/png">
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body class="${themeClass}">
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="site-header">
    <a class="brand-lockup" href="/" aria-label="Anyam home">
      <img src="/assets/anyam-mark-black.png" alt="" width="36" height="36">
      <span>Anyam</span>
    </a>
    <nav class="site-nav" aria-label="Primary navigation">${links}</nav>
    <a class="header-cta" href="/docs/quickstart/">Start building <span aria-hidden="true">↗</span></a>
  </header>
  <main id="main-content">${page.body}</main>
  <footer class="site-footer">
    <div class="footer-brand"><img src="/assets/anyam-mark-black.png" alt="" width="28" height="28"><span>Anyam</span></div>
    <p>Project control for humans and agents.</p>
    <div class="footer-links">
      <a href="/docs/">Docs</a>
      <a href="/examples/">Examples</a>
      <a href="https://github.com/Whyme-Labs/anyam">GitHub</a>
    </div>
  </footer>
  <script src="/assets/site.js" defer></script>
</body>
</html>
`;
}

const landingBody = `
<section class="hero hero-dark">
  <div class="hero-copy">
    <p class="eyebrow">Open project control</p>
    <h1>Ship software from a single, honest change.</h1>
    <p class="hero-lede">Anyam keeps Git familiar while giving people and coding agents a clear path from source to a verified Release.</p>
    <div class="hero-actions">
      ${button("npm create anyam demo", "Start with Anyam")}
    <a class="text-link light-link" href="/docs/product/philosophy/">Read the design <span aria-hidden="true">↗</span></a>
    </div>
    <p class="hero-note">Customer-operated on Cloudflare. Use Codex, Claude Code, Cursor, or your own agent.</p>
  </div>
  <div class="hero-visual" aria-label="Anyam delivery path">
    <div class="visual-topline"><span>PROJECT / ATLAS</span><span class="status-dot">READY</span></div>
    <div class="delivery-rail">
      <div class="rail-node node-source"><span class="node-kicker">01</span><strong>Source</strong><small>Git objects</small></div>
      <div class="rail-line"></div>
      <div class="rail-node node-change"><span class="node-kicker">02</span><strong>Change</strong><small>exact revision</small></div>
      <div class="rail-line"></div>
      <div class="rail-node node-evidence"><span class="node-kicker">03</span><strong>Evidence</strong><small>checks + receipt</small></div>
      <div class="rail-line"></div>
      <div class="rail-node node-release"><span class="node-kicker">04</span><strong>Release</strong><small>immutable artifact</small></div>
    </div>
    <div class="visual-bottomline"><span>Target / staging</span><span>promotion gated</span></div>
  </div>
</section>

<section class="section section-intro">
  <div class="section-kicker">The difference</div>
  <div class="intro-grid">
    <h2>Git is the source language. Anyam is the delivery contract.</h2>
    <p>Repositories, commits, branches, and merges stay recognizable. Anyam adds the parts Git does not own: public and private Source Spaces, stable Changes, Evidence, Releases, Targets, and Promotion.</p>
  </div>
</section>

<section class="section section-dark">
  <div class="section-heading"><p class="eyebrow">One Project, several trust boundaries</p><h2>Keep the code together without making authority vague.</h2></div>
  <div class="feature-grid">
    <article class="feature-card"><span class="feature-number">01</span><h3>Public and private by structure</h3><p>Production disclosure uses separate Source Spaces and public Git lineage. The local hybrid example demonstrates a selected entry-point projection only.</p><a href="/examples/hybrid-video-player/">See the hybrid example <span aria-hidden="true">↗</span></a></article>
    <article class="feature-card"><span class="feature-number">02</span><h3>Agents work in their own space</h3><p>Codex, Claude Code, Cursor, and custom agents receive a bounded Workspace and a task-scoped capability. They never get canonical write authority.</p><a href="/docs/quickstart/">Connect an agent <span aria-hidden="true">↗</span></a></article>
    <article class="feature-card"><span class="feature-number">03</span><h3>Release once, promote with proof</h3><p>Build an immutable Artifact, close it into a Release, then move the same digest through Targets with health and rollback evidence.</p><a href="/docs/design/architecture/">Read the architecture <span aria-hidden="true">↗</span></a></article>
  </div>
</section>

<section class="section command-section">
  <div class="section-heading"><p class="eyebrow">A familiar first step</p><h2>Start local. Connect when the Project needs a team.</h2></div>
  <div class="command-layout">
    <div>${codeBlock("npm create anyam demo\ncd demo\nnpm install\nnpx create-anyam doctor\nnpm run typecheck\nnpm test\nnpm run build", "Your terminal")}<p class="caption">The scaffold is local-only. It does not create a Realm, provision Cloudflare resources, or store credentials.</p></div>
    <div class="command-aside"><p>Use standard Git for source edits. Use Anyam for the semantic steps that need shared authority.</p><div class="mini-flow"><span>edit</span><b>→</b><span>change</span><b>→</b><span>verify</span><b>→</b><span>ship</span></div><a class="text-link" href="/docs/quickstart/">Follow the Quickstart <span aria-hidden="true">↗</span></a></div>
  </div>
</section>

<section class="section section-blue">
  <div class="blue-panel"><div><p class="eyebrow">Source and portability</p><h2>Inspect the first-party source.</h2><p>Anyam’s source is available for review. A distribution license remains to be selected. Run a Realm in your own Cloudflare account, keep Project history portable, and choose the coding agent that fits the work.</p></div><a class="button button-light" href="/docs/product/philosophy/">Read the philosophy <span aria-hidden="true">↗</span></a></div>
</section>

<section class="section final-cta"><p class="eyebrow">Make the next Change legible</p><h2>Build with any agent.<br>Ship with confidence.</h2><div class="final-actions"><a class="button button-dark" href="/docs/quickstart/">Read the Quickstart <span aria-hidden="true">↗</span></a><a class="text-link" href="https://github.com/Whyme-Labs/anyam">View the source <span aria-hidden="true">↗</span></a></div></section>
`;

const docsBody = `
<section class="page-hero">
  <p class="eyebrow">Documentation</p>
  <h1>Understand what happens next.</h1>
  <p>Start with a local Project, then follow the source, authority, Evidence, and delivery boundaries as your work grows.</p>
</section>
<section class="section docs-grid-section">
  <div class="docs-grid">
    <a class="doc-card doc-card-primary" href="/docs/quickstart/"><span class="card-kicker">Start here</span><h2>Build and check a local Project</h2><p>Create a TypeScript Worker, run the checks, and start a Change in a few minutes.</p><span class="card-arrow">Read Quickstart ↗</span></a>
    <a class="doc-card" href="/docs/guides/customer-realm/"><span class="card-kicker">How-to</span><h2>Operate a customer-owned Realm</h2><p>Plan, install, inspect, upgrade, export, and recover a Realm in your Cloudflare account.</p><span class="card-arrow">Open the guide ↗</span></a>
    <a class="doc-card" href="/docs/product/philosophy/"><span class="card-kicker">Explanation</span><h2>Anyam design philosophy</h2><p>Why Git stays familiar, why disclosure is structural, and why Evidence and authority stay separate.</p><span class="card-arrow">Read the principles ↗</span></a>
    <a class="doc-card" href="/docs/design/architecture/"><span class="card-kicker">Reference</span><h2>Architecture</h2><p>Trace the Project path from Git objects to a health-checked Target and recovery checkpoint.</p><span class="card-arrow">See the design ↗</span></a>
    <a class="doc-card" href="/docs/examples/"><span class="card-kicker">Practice</span><h2>Examples</h2><p>Run a Worker, TypeScript CLI, or hybrid public/private Project locally.</p><span class="card-arrow">Browse examples ↗</span></a>
    <a class="doc-card" href="https://github.com/Whyme-Labs/anyam/tree/main/docs/adr/"><span class="card-kicker">Decisions</span><h2>Architecture decision records</h2><p>Read the accepted decisions behind the contracts, adapters, and qualification boundaries.</p><span class="card-arrow">Open the ADRs ↗</span></a>
  </div>
</section>
<section class="section reading-section"><div class="section-heading"><p class="eyebrow">A useful order</p><h2>Read the part that matches the work.</h2></div><ol class="reading-list"><li><span>01</span><div><strong>Start here</strong><p>Run the local Quickstart and learn the command loop.</p></div></li><li><span>02</span><div><strong>Understand the why</strong><p>Read the design philosophy before changing a boundary.</p></div></li><li><span>03</span><div><strong>Trace the system</strong><p>Use the architecture reference and the linked ADRs.</p></div></li><li><span>04</span><div><strong>Run a sample</strong><p>Use an example Project before you qualify a provider path.</p></div></li></ol></section>
`;

const quickstartBody = await documentationBody(repositoryDirectory, "docs/guides/quickstart.md");

const customerRealmBody = await documentationBody(repositoryDirectory, "docs/guides/customer-realm.md");

const philosophyBody = await documentationBody(repositoryDirectory, "docs/product/design-philosophy.md");

const architectureBody = await documentationBody(repositoryDirectory, "docs/design/architecture.md");

const examplesBody = `
<section class="page-hero"><p class="eyebrow">Runnable examples</p><h1>See the Project path in code.</h1><p>Each example is small enough to read and complete enough to run. The examples prove local behavior. They do not claim a live Cloudflare deployment.</p></section>
<section class="section examples-grid-section"><div class="example-grid"><a class="example-card example-worker" href="/examples/worker-app/"><div class="example-meta"><span>01</span><span>Cloudflare Worker</span></div><h2>Worker app</h2><p>A TypeScript Worker with a health route, test, build, and Cloudflare Target manifest.</p><code>npm run check</code><span class="card-arrow">Open example ↗</span></a><a class="example-card example-cli" href="/examples/typescript-cli/"><div class="example-meta"><span>02</span><span>Non-web Project</span></div><h2>TypeScript CLI</h2><p>A compiled command-line tool with local build/test checks and a planned generic release-assets Target.</p><code>npm run check</code><span class="card-arrow">Open example ↗</span></a><a class="example-card example-hybrid" href="/examples/hybrid-video-player/"><div class="example-meta"><span>03</span><span>Two Source Spaces</span></div><h2>Hybrid video player</h2><p>A local projection fixture with two marker checks. It does not establish general private-content exclusion.</p><code>npm run check</code><span class="card-arrow">Open example ↗</span></a></div></section>
<section class="section fixture-section"><div class="section-heading"><p class="eyebrow">Qualification inputs</p><h2>Fixtures are not examples.</h2><p>The <code>fixtures/</code> directory feeds deterministic contract and provider qualification. The golden Worker fixture requires customer-owned resources and is not a clone-and-run sample.</p></div><div class="fixture-list"><a href="https://github.com/Whyme-Labs/anyam/tree/main/fixtures/worker">Worker contract fixture ↗</a><a href="https://github.com/Whyme-Labs/anyam/tree/main/fixtures/typescript-library">TypeScript library fixture ↗</a><a href="https://github.com/Whyme-Labs/anyam/tree/main/fixtures/hybrid">Hybrid disclosure fixture ↗</a><a href="https://github.com/Whyme-Labs/anyam/tree/main/fixtures/worker-golden">Golden Worker provider fixture ↗</a></div></section>
<section class="section section-dark simulation-section"><div><p class="eyebrow">Team simulation</p><h2>Run the local multi-actor path.</h2><p>The simulation covers Worker and CLI Projects, conflicts and rebases, reviews, Landing, hybrid disclosure, bidirectional mirror proposals, Intent and Pull Request lifecycle, and export/restore.</p></div>${codeBlock("npm run qualification:team-simulation", "Repository root")}</section>
`;

const workerExampleBody = await documentationBody(repositoryDirectory, "examples/worker-app/README.md");

const cliExampleBody = await documentationBody(repositoryDirectory, "examples/typescript-cli/README.md");

const hybridExampleBody = await documentationBody(repositoryDirectory, "examples/hybrid-video-player/README.md");

const css = `
:root {
  --ink: ${ANYAM_BRAND.colors.ink};
  --ink-soft: color-mix(in srgb, var(--ink) 95%, var(--white));
  --slate: ${ANYAM_BRAND.colors.slate};
  --slate-light: color-mix(in srgb, var(--slate) 65%, var(--white));
  --mist: ${ANYAM_BRAND.colors.mist};
  --white: ${ANYAM_BRAND.colors.white};
  --blue: ${ANYAM_BRAND.colors.accentBlue};
  --blue-dark: color-mix(in srgb, var(--blue) 80%, var(--ink));
  --line: color-mix(in srgb, var(--slate) 25%, var(--white));
  --line-dark: color-mix(in srgb, var(--slate) 35%, var(--ink));
  --sans: ${ANYAM_BRAND.typography.sans};
  --mono: ${ANYAM_BRAND.typography.mono};
  --max: 1180px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--mist); color: var(--ink); font-family: var(--sans); line-height: 1.55; }
body.page-dark { background: var(--ink); color: var(--mist); }
a { color: inherit; text-decoration: none; }
a:hover { color: var(--blue); }
a:focus-visible, button:focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; }
.skip-link { position: fixed; top: 12px; left: 12px; z-index: 10; padding: 8px 12px; background: var(--blue); color: var(--white); transform: translateY(-150%); transition: transform .15s ease; }
.skip-link:focus { transform: translateY(0); color: var(--white); }
code, pre { font-family: var(--mono); }
code { font-size: .88em; }
.site-header { width: min(calc(100% - 48px), var(--max)); margin: 0 auto; min-height: 84px; display: flex; align-items: center; gap: 34px; }
.brand-lockup, .footer-brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: -.04em; }
.page-dark .brand-lockup img, .page-dark .footer-brand img { filter: invert(1); }
.brand-lockup { font-size: 1.32rem; }
.brand-lockup img, .footer-brand img { object-fit: contain; }
.site-nav { display: flex; align-items: center; gap: 24px; margin-left: auto; }
.nav-link { color: var(--slate); font-size: .9rem; }
.nav-link.is-active, .nav-link:hover { color: var(--ink); }
.page-dark .nav-link.is-active, .page-dark .nav-link:hover { color: var(--white); }
.header-cta { background: var(--blue); color: var(--white); padding: 10px 15px; border-radius: 999px; font-size: .86rem; font-weight: 650; }
.header-cta:hover { color: var(--white); background: var(--blue-dark); }
.hero { width: 100%; }
.hero-dark { background: var(--ink); color: var(--mist); display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(360px, .9fr); gap: 72px; min-height: 665px; padding: 108px max(24px, calc((100vw - var(--max)) / 2)) 92px; position: relative; overflow: hidden; }
.hero-dark::after { content: ""; position: absolute; width: 420px; height: 420px; border: 1px solid color-mix(in srgb, var(--white) 19%, var(--ink)); border-radius: 50%; right: -160px; bottom: -210px; box-shadow: 0 0 0 44px color-mix(in srgb, var(--white) 8%, var(--ink)), 0 0 0 45px color-mix(in srgb, var(--white) 19%, var(--ink)), 0 0 0 90px color-mix(in srgb, var(--white) 8%, var(--ink)), 0 0 0 91px color-mix(in srgb, var(--white) 19%, var(--ink)); opacity: .7; }
.hero-copy { max-width: 700px; position: relative; z-index: 1; }
.eyebrow, .section-kicker, .card-kicker, .code-label, .node-kicker, .visual-topline, .visual-bottomline, .feature-number, .example-meta, .space-label { font-family: var(--mono); text-transform: uppercase; letter-spacing: .12em; font-size: .68rem; font-weight: 700; }
.eyebrow { color: var(--slate); margin: 0 0 22px; }
.hero-dark .eyebrow, .section-dark .eyebrow, .simulation-section .eyebrow { color: color-mix(in srgb, var(--blue) 59%, var(--white)); }
h1, h2, h3, p { margin-top: 0; }
h1 { letter-spacing: -.065em; line-height: .98; font-size: clamp(3.3rem, 7vw, 6.45rem); max-width: 760px; margin-bottom: 28px; }
h2 { letter-spacing: -.05em; line-height: 1.05; font-size: clamp(2rem, 4.2vw, 4rem); margin-bottom: 18px; }
h3 { letter-spacing: -.035em; line-height: 1.1; font-size: 1.38rem; }
.hero-lede { color: color-mix(in srgb, var(--white) 76%, var(--ink)); font-size: 1.2rem; max-width: 580px; margin-bottom: 34px; }
.hero-actions, .final-actions { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.copy-button { border: 0; border-radius: 999px; padding: 13px 17px 13px 20px; display: inline-flex; gap: 18px; align-items: center; background: var(--blue); color: var(--white); font: inherit; font-weight: 700; cursor: pointer; }
.copy-button:hover { background: color-mix(in srgb, var(--blue) 89%, var(--white)); }
.copy-state { font-family: var(--mono); text-transform: uppercase; font-size: .63rem; letter-spacing: .1em; opacity: .74; }
.light-link { color: var(--mist); }
.light-link:hover { color: color-mix(in srgb, var(--blue) 52%, var(--white)); }
.text-link { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; font-size: .92rem; }
.hero-note { color: color-mix(in srgb, var(--blue) 59%, var(--white)); font-size: .78rem; max-width: 480px; margin-top: 54px; }
.hero-visual { align-self: center; border: 1px solid color-mix(in srgb, var(--white) 22%, var(--ink)); background: color-mix(in srgb, var(--white) 8%, var(--ink)); border-radius: 2px; padding: 24px; min-height: 310px; position: relative; z-index: 1; box-shadow: 14px 14px 0 color-mix(in srgb, var(--white) 12%, var(--ink)); }
.visual-topline, .visual-bottomline { display: flex; justify-content: space-between; color: color-mix(in srgb, var(--blue) 67%, var(--white)); }
.status-dot { color: #72c491; }
.status-dot::before { content: ""; width: 6px; height: 6px; display: inline-block; background: #72c491; border-radius: 50%; margin: 0 8px 1px 0; }
.delivery-rail { min-height: 230px; display: flex; flex-direction: column; justify-content: center; }
.rail-node { display: grid; grid-template-columns: 36px 1fr auto; align-items: baseline; gap: 12px; padding: 11px 12px; border: 1px solid color-mix(in srgb, var(--white) 20%, var(--ink)); background: color-mix(in srgb, var(--white) 10%, var(--ink)); }
.rail-node strong { font-size: 1.08rem; }
.rail-node small { color: color-mix(in srgb, var(--blue) 59%, var(--white)); font-family: var(--mono); font-size: .68rem; }
.node-kicker { color: color-mix(in srgb, var(--blue) 67%, var(--white)); }
.node-change { border-color: color-mix(in srgb, var(--blue) 91%, var(--white)); background: color-mix(in srgb, var(--white) 15%, var(--ink)); }
.node-evidence { border-color: #3e6c53; }
.rail-line { height: 17px; width: 1px; background: color-mix(in srgb, var(--white) 27%, var(--ink)); margin-left: 28px; }
.section { padding: 110px max(24px, calc((100vw - var(--max)) / 2)); }
.section-intro { background: var(--white); color: var(--ink); }
.section-kicker { color: var(--blue); margin-bottom: 30px; }
.intro-grid { display: grid; grid-template-columns: 1.1fr .9fr; gap: 80px; align-items: start; }
.intro-grid h2 { max-width: 650px; }
.intro-grid p { color: var(--slate); font-size: 1.1rem; max-width: 500px; }
.section-dark, .simulation-section { background: var(--ink); color: var(--mist); }
.section-heading { max-width: 720px; margin-bottom: 54px; }
.section-heading h2 { margin-bottom: 0; }
.feature-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line-dark); border: 1px solid var(--line-dark); }
.feature-card { background: var(--ink); padding: 28px; min-height: 300px; display: flex; flex-direction: column; }
.feature-card .feature-number { color: color-mix(in srgb, var(--blue) 79%, var(--white)); margin-bottom: auto; }
.feature-card h3 { max-width: 260px; margin: 28px 0 12px; }
.feature-card p { color: color-mix(in srgb, var(--white) 68%, var(--ink)); font-size: .95rem; max-width: 290px; }
.feature-card a { color: color-mix(in srgb, var(--blue) 52%, var(--white)); font-size: .82rem; font-weight: 700; margin-top: auto; }
.feature-card a:hover { color: var(--white); }
.command-section { background: var(--mist); color: var(--ink); }
.command-layout { display: grid; grid-template-columns: 1.1fr .9fr; gap: 80px; align-items: start; }
.code-block { border: 1px solid var(--line); background: color-mix(in srgb, var(--white) 93%, var(--ink)); overflow: hidden; }
.code-label { padding: 11px 16px; color: var(--slate); border-bottom: 1px solid var(--line); }
.code-block pre { margin: 0; padding: 20px; overflow-x: auto; color: var(--ink); font-size: .85rem; line-height: 1.75; white-space: pre-wrap; }
.hero-dark .code-block { border-color: color-mix(in srgb, var(--white) 22%, var(--ink)); background: color-mix(in srgb, var(--white) 8%, var(--ink)); }
.hero-dark .code-label { border-color: color-mix(in srgb, var(--white) 22%, var(--ink)); color: color-mix(in srgb, var(--blue) 59%, var(--white)); }
.hero-dark .code-block pre { color: var(--mist); }
.caption { color: var(--slate); font-size: .82rem; margin-top: 15px; max-width: 540px; }
.command-aside { padding-top: 15px; max-width: 400px; }
.command-aside p { color: var(--slate); font-size: 1.1rem; }
.mini-flow { display: flex; align-items: center; gap: 11px; color: var(--ink); font-family: var(--mono); font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; margin: 32px 0; flex-wrap: wrap; }
.mini-flow b { color: var(--blue); }
.section-blue { background: var(--mist); padding-top: 0; }
.blue-panel { background: var(--blue); color: var(--white); padding: 54px; display: flex; justify-content: space-between; gap: 40px; align-items: end; }
.blue-panel .eyebrow { color: color-mix(in srgb, var(--blue) 26%, var(--white)); }
.blue-panel h2 { max-width: 630px; }
.blue-panel p:not(.eyebrow) { color: color-mix(in srgb, var(--blue) 17%, var(--white)); max-width: 560px; margin-bottom: 0; }
.button { border-radius: 999px; padding: 12px 17px; display: inline-flex; align-items: center; gap: 9px; font-weight: 700; font-size: .9rem; }
.button-light { color: var(--blue); background: var(--white); white-space: nowrap; }
.button-light:hover { color: var(--blue-dark); background: color-mix(in srgb, var(--white) 96%, var(--ink)); }
.button-dark { color: var(--white); background: var(--blue); }
.button-dark:hover { color: var(--white); background: var(--blue-dark); }
.final-cta { color: var(--ink); background: var(--white); padding-top: 130px; padding-bottom: 140px; }
.final-cta h2 { max-width: 850px; }
.final-cta .eyebrow { color: var(--blue); }
.site-footer { width: min(calc(100% - 48px), var(--max)); margin: 0 auto; min-height: 118px; display: flex; align-items: center; gap: 26px; border-top: 1px solid var(--line); color: var(--slate); font-size: .82rem; }
.page-dark .site-footer { border-color: var(--line-dark); }
.footer-brand { color: var(--ink); font-size: 1rem; }
.page-dark .footer-brand { color: var(--mist); }
.footer-links { display: flex; gap: 20px; margin-left: auto; }
.footer-links a:hover { color: var(--blue); }
.page-hero, .article-hero { width: min(calc(100% - 48px), 900px); margin: 0 auto; padding: 90px 0 70px; }
.page-hero { text-align: center; }
.page-hero h1, .article-hero h1 { font-size: clamp(3rem, 7vw, 5.6rem); max-width: 850px; margin-left: auto; margin-right: auto; }
.page-hero p:not(.eyebrow), .article-hero p:not(.eyebrow) { color: var(--slate); font-size: 1.14rem; max-width: 660px; margin-left: auto; margin-right: auto; }
.docs-grid-section, .examples-grid-section { padding-top: 10px; }
.docs-grid, .example-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.doc-card, .example-card { background: var(--white); border: 1px solid var(--line); padding: 28px; min-height: 260px; display: flex; flex-direction: column; transition: transform .2s ease, border-color .2s ease, box-shadow .2s ease; }
.doc-card:hover, .example-card:hover { color: var(--ink); border-color: var(--blue); transform: translateY(-4px); box-shadow: 6px 6px 0 color-mix(in srgb, var(--blue) 24%, var(--white)); }
.doc-card-primary { background: var(--ink); color: var(--mist); border-color: var(--ink); grid-column: span 2; }
.doc-card-primary:hover { color: var(--mist); border-color: var(--blue); }
.card-kicker { color: var(--blue); }
.doc-card-primary .card-kicker { color: color-mix(in srgb, var(--blue) 52%, var(--white)); }
.doc-card h2, .example-card h2 { font-size: 1.55rem; margin: 22px 0 10px; }
.doc-card p, .example-card p { color: var(--slate); font-size: .92rem; max-width: 300px; }
.doc-card-primary p { color: color-mix(in srgb, var(--white) 68%, var(--ink)); }
.card-arrow { margin-top: auto; color: var(--blue); font-size: .8rem; font-weight: 750; }
.doc-card-primary .card-arrow { color: color-mix(in srgb, var(--blue) 44%, var(--white)); }
.reading-section { background: var(--white); }
.reading-list { max-width: 780px; list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--line); }
.reading-list li { display: grid; grid-template-columns: 70px 1fr; gap: 22px; padding: 23px 0; border-bottom: 1px solid var(--line); }
.reading-list li > span { color: var(--blue); font-family: var(--mono); font-size: .78rem; }
.reading-list strong { display: block; font-size: 1.1rem; margin-bottom: 4px; }
.reading-list p { color: var(--slate); margin: 0; }
.article { width: min(calc(100% - 48px), 820px); margin: 0 auto; padding: 15px 0 100px; }
.article-step, .principle { display: grid; grid-template-columns: 58px 1fr; gap: 25px; padding: 42px 0; border-top: 1px solid var(--line); }
.article-step > span, .principle > span { color: var(--blue); font-family: var(--mono); font-size: .8rem; font-weight: 700; }
.article h2 { font-size: 2rem; margin-bottom: 15px; }
.article p, .article li { color: color-mix(in srgb, var(--white) 29%, var(--ink)); font-size: 1rem; }
.article code { color: var(--blue-dark); }
.article .code-block { margin: 22px 0; }
.callout { border-left: 3px solid var(--blue); background: color-mix(in srgb, var(--white) 94%, var(--ink)); padding: 18px 20px; margin: 26px 0; }
.callout strong { display: block; margin-bottom: 4px; }
.callout p { margin: 0; font-size: .9rem; }
.article-next { display: flex; flex-wrap: wrap; gap: 18px 28px; align-items: center; border-top: 1px solid var(--line); padding-top: 24px; margin-top: 30px; }
.article-next span { color: var(--slate); font-family: var(--mono); text-transform: uppercase; font-size: .68rem; letter-spacing: .1em; margin-right: auto; }
.article-next a { color: var(--blue); font-weight: 700; font-size: .86rem; }
.philosophy-article .principle h2 { margin-top: -5px; }
.architecture-article > section { padding: 38px 0; border-top: 1px solid var(--line); }
.architecture-article > section h2 { font-size: 1.8rem; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { border-bottom: 1px solid var(--line); padding: 13px 10px; text-align: left; vertical-align: top; }
th { color: var(--slate); font-family: var(--mono); text-transform: uppercase; letter-spacing: .08em; font-size: .66rem; }
.example-card { min-height: 310px; }
.example-card code { display: inline-block; background: var(--mist); color: var(--ink); padding: 7px 9px; width: fit-content; margin-top: 10px; }
.example-meta { color: var(--slate); display: flex; justify-content: space-between; }
.example-worker { border-top: 4px solid var(--blue); }
.example-cli { border-top: 4px solid var(--ink); }
.example-hybrid { border-top: 4px solid color-mix(in srgb, var(--white) 42%, var(--ink)); }
.fixture-section { background: var(--white); }
.fixture-section .section-heading p:not(.eyebrow) { color: var(--slate); max-width: 650px; }
.fixture-list { display: grid; grid-template-columns: repeat(2, 1fr); border-top: 1px solid var(--line); }
.fixture-list a { padding: 17px 0; border-bottom: 1px solid var(--line); color: var(--blue); font-weight: 700; font-size: .9rem; }
.simulation-section { display: grid; grid-template-columns: 1fr 1fr; gap: 70px; align-items: end; }
.simulation-section p:not(.eyebrow) { color: color-mix(in srgb, var(--white) 68%, var(--ink)); max-width: 540px; }
.simulation-section .code-block { background: color-mix(in srgb, var(--white) 10%, var(--ink)); border-color: color-mix(in srgb, var(--white) 22%, var(--ink)); }
.simulation-section .code-label { border-color: color-mix(in srgb, var(--white) 22%, var(--ink)); color: color-mix(in srgb, var(--blue) 59%, var(--white)); }
.simulation-section .code-block pre { color: var(--mist); }
.check-list { padding-left: 22px; }
.check-list li { margin-bottom: 10px; }
.space-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 25px 0; }
.space-pair > div { border: 1px solid var(--line); padding: 18px; display: flex; flex-direction: column; gap: 10px; }
.public-label { color: var(--blue); }
.private-label { color: color-mix(in srgb, var(--white) 42%, var(--ink)); }
.space-pair p { font-size: .85rem; margin: 0; }
@media (max-width: 900px) {
  .hero-dark { grid-template-columns: 1fr; gap: 44px; padding-top: 80px; }
  .hero-visual { max-width: 600px; width: 100%; }
  .intro-grid, .command-layout, .simulation-section { grid-template-columns: 1fr; gap: 35px; }
  .feature-grid, .docs-grid, .example-grid { grid-template-columns: repeat(2, 1fr); }
  .doc-card-primary { grid-column: span 2; }
  .blue-panel { align-items: start; flex-direction: column; }
}
@media (max-width: 620px) {
  .site-header { width: min(calc(100% - 32px), var(--max)); min-height: 72px; gap: 15px; flex-wrap: wrap; padding: 13px 0; }
  .site-nav { order: 3; width: 100%; justify-content: space-between; gap: 10px; }
  .header-cta { margin-left: auto; padding: 8px 12px; font-size: .78rem; }
  .hero-dark { padding: 65px 20px 70px; min-height: auto; }
  h1 { font-size: clamp(2.9rem, 15vw, 4.5rem); }
  h2 { font-size: 2.25rem; }
  .hero-lede { font-size: 1.05rem; }
  .hero-visual { padding: 16px; box-shadow: 7px 7px 0 color-mix(in srgb, var(--white) 12%, var(--ink)); }
  .rail-node { grid-template-columns: 28px 1fr; }
  .rail-node small { grid-column: 2; }
  .section { padding: 75px 20px; }
  .feature-grid, .docs-grid, .example-grid, .fixture-list, .space-pair { grid-template-columns: 1fr; }
  .doc-card-primary { grid-column: auto; }
  .blue-panel { padding: 30px 24px; }
  .site-footer { width: min(calc(100% - 32px), var(--max)); flex-wrap: wrap; padding: 25px 0; gap: 12px 20px; }
  .site-footer p { width: 100%; order: 3; }
  .footer-links { margin-left: 0; }
  .page-hero, .article-hero, .article { width: min(calc(100% - 40px), 820px); }
  .page-hero, .article-hero { padding-top: 60px; }
  .article-step, .principle { grid-template-columns: 35px 1fr; gap: 12px; }
  .article h2 { font-size: 1.7rem; }
}
`;

const javascript = `
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("[data-copy]");
  if (!(button instanceof HTMLButtonElement)) return;
  const value = button.dataset.copy;
  const state = button.querySelector(".copy-state");
  if (!value || !state) return;
  if (!navigator.clipboard) { state.textContent = "Select command"; return; }
  navigator.clipboard.writeText(value).then(() => {
    state.textContent = "Copied";
    window.setTimeout(() => { state.textContent = "Copy"; }, 1600);
  }).catch(() => { state.textContent = "Select command"; });
});
`;

async function writePage(path: string, page: Page): Promise<void> {
  const destination = resolve(outputDirectory, path, "index.html");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, layout({ ...page, path: path ? `/${path}/` : "/" }), "utf8");
}

async function main(): Promise<void> {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(resolve(outputDirectory, "assets"), { recursive: true });
  await writeFile(resolve(outputDirectory, "assets/site.css"), css, "utf8");
  await writeFile(resolve(outputDirectory, "assets/site.js"), javascript, "utf8");
  await copyFile(resolve(repositoryDirectory, "docs/brand/assets/anyam-mark-black.png"), resolve(outputDirectory, "assets/anyam-mark-black.png"));
  await copyFile(resolve(repositoryDirectory, "docs/brand/assets/anyam-brand-board.png"), resolve(outputDirectory, "og.png"));
  await writeFile(resolve(outputDirectory, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${siteOrigin}/sitemap.xml\n`, "utf8");
  await writeFile(resolve(outputDirectory, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${siteOrigin}/</loc></url>
  <url><loc>${siteOrigin}/docs/</loc></url>
  <url><loc>${siteOrigin}/docs/quickstart/</loc></url>
  <url><loc>${siteOrigin}/docs/guides/customer-realm/</loc></url>
  <url><loc>${siteOrigin}/docs/product/philosophy/</loc></url>
  <url><loc>${siteOrigin}/docs/design/architecture/</loc></url>
  <url><loc>${siteOrigin}/examples/</loc></url>
  <url><loc>${siteOrigin}/examples/worker-app/</loc></url>
  <url><loc>${siteOrigin}/examples/typescript-cli/</loc></url>
  <url><loc>${siteOrigin}/examples/hybrid-video-player/</loc></url>
</urlset>
`, "utf8");
  await writeFile(resolve(outputDirectory, "404.html"), layout({ title: "Page not found", description: "The requested Anyam page does not exist.", current: "home", body: `<section class="page-hero"><p class="eyebrow">404</p><h1>That page is not here.</h1><p><a class="text-link" href="/">Return to Anyam <span aria-hidden="true">↗</span></a></p></section>` }), "utf8");
  await writePage("", { title: "Open project control", description: "Open source project control for humans and coding agents.", current: "home", body: landingBody, dark: true });
  await writePage("docs", { title: "Documentation", description: "Guides and design references for Anyam Projects, agents, and customer-owned Realms.", current: "docs", body: docsBody });
  await writePage("docs/quickstart", { title: "Build and check a local Project", description: "Create a local TypeScript Project, run the checks, and start a Change.", current: "docs", body: quickstartBody });
  await writePage("docs/guides/customer-realm", { title: "Operate a customer-owned Realm", description: "Plan, install, inspect, upgrade, export, and recover an Anyam Realm in your Cloudflare account.", current: "docs", body: customerRealmBody });
  await writePage("docs/product/philosophy", { title: "Anyam design philosophy", description: "The principles behind Anyam's Git-compatible Project, Source Space, Evidence, and delivery model.", current: "docs", body: philosophyBody });
  await writePage("docs/design/architecture", { title: "Anyam architecture", description: "Trace Anyam from Git objects through Changes, Evidence, Releases, Targets, and recovery.", current: "docs", body: architectureBody });
  await writePage("docs/examples", { title: "Anyam examples", description: "Runnable Worker, TypeScript CLI, and hybrid public/private Project examples.", current: "examples", body: examplesBody });
  await writePage("examples", { title: "Runnable examples", description: "Run Anyam Projects that demonstrate Workers, CLIs, and hybrid public/private source.", current: "examples", body: examplesBody });
  await writePage("examples/worker-app", { title: "Example Worker app", description: "A runnable TypeScript Worker Project with a test, build, and Target manifest.", current: "examples", body: workerExampleBody });
  await writePage("examples/typescript-cli", { title: "Example TypeScript CLI", description: "A runnable non-web TypeScript Project with a compiled release asset.", current: "examples", body: cliExampleBody });
  await writePage("examples/hybrid-video-player", { title: "Example hybrid video player", description: "A public player Source Space with a private codec Source Space.", current: "examples", body: hybridExampleBody });
  console.log(JSON.stringify({ protocol: "anyam.site-build/v1", status: "succeeded", outputDirectory, pages: 11, assets: ["assets/site.css", "assets/site.js", "assets/anyam-mark-black.png", "og.png", "robots.txt", "sitemap.xml"], receipt: "static=generated; brand=source-assets; seo=robots-sitemap; provider=not-run" }, null, 2));
}

await main();
