import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = resolve("apps/site/dist");
const pages = [
  "index.html",
  "docs/index.html",
  "docs/quickstart/index.html",
  "docs/guides/customer-realm/index.html",
  "docs/product/philosophy/index.html",
  "docs/design/architecture/index.html",
  "docs/examples/index.html",
  "examples/index.html",
  "examples/worker-app/index.html",
  "examples/typescript-cli/index.html",
  "examples/hybrid-video-player/index.html",
  "404.html",
];
const assets = ["assets/site.css", "assets/site.js", "assets/anyam-mark-black.png", "og.png", "robots.txt", "sitemap.xml"];

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

for (const relative of [...pages, ...assets]) {
  if (!(await exists(resolve(root, relative)))) throw new Error(`site artifact missing: ${relative}`);
}

const robots = await readFile(resolve(root, "robots.txt"), "utf8");
if (!robots.includes("Sitemap: https://anyam.whymelabs.com/sitemap.xml")) throw new Error("robots.txt does not point to the canonical sitemap");
const sitemap = await readFile(resolve(root, "sitemap.xml"), "utf8");
if (!sitemap.includes("https://anyam.whymelabs.com/docs/quickstart/")) throw new Error("sitemap omits the Quickstart");

const parityChecks = [
  { source: "docs/guides/customer-realm.md", page: "docs/guides/customer-realm/index.html", phrases: ["provider-pending"] },
  { source: "examples/worker-app/README.md", page: "examples/worker-app/index.html", phrases: [] },
  { source: "examples/typescript-cli/README.md", page: "examples/typescript-cli/index.html", phrases: [] },
  { source: "examples/hybrid-video-player/README.md", page: "examples/hybrid-video-player/index.html", phrases: [] },
  { source: "docs/guides/quickstart.md", page: "docs/quickstart/index.html", phrases: ["Build and check a local Project", "Start a Change"] },
  { source: "docs/product/design-philosophy.md", page: "docs/product/philosophy/index.html", phrases: ["Keep Git honest", "Make disclosure structural", "Stay open and portable"] },
  { source: "docs/design/architecture.md", page: "docs/design/architecture/index.html", phrases: ["The Project path", "Cloudflare-first mapping", "Recovery and export"] },
];
for (const check of parityChecks) {
  const source = await readFile(resolve(check.source), "utf8");
  const page = await readFile(resolve(root, check.page), "utf8");
  if (!page.includes(`data-document-source="${check.source}"`)) throw new Error(`site page is not rendered from its document: ${check.page}`);
  for (const block of source.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)) {
    const escaped = block[1].replace(/[&<>\"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    if (!page.includes(`<code>${escaped}</code>`)) throw new Error(`site code block drift: ${check.source}`);
  }
  for (const phrase of check.phrases) {
    if (!source.includes(phrase) || !page.includes(phrase)) throw new Error(`site/docs parity missing: ${phrase}`);
  }
}

const internalHrefs = new Set();
for (const relative of pages) {
  const html = await readFile(resolve(root, relative), "utf8");
  if (!/<title>[^<]+<\/title>/.test(html)) throw new Error(`site title missing: ${relative}`);
  if (!/<meta name="description" content="[^"]+">/.test(html)) throw new Error(`site description missing: ${relative}`);
  if (!/<link rel="canonical" href="https:\/\/anyam\.whymelabs\.com[^\"]*">/.test(html)) throw new Error(`site canonical URL missing: ${relative}`);
  if (!html.includes("/assets/site.css")) throw new Error(`site stylesheet missing: ${relative}`);
  if (/TODO|replace-with-/.test(html)) throw new Error(`unfinished placeholder in site page: ${relative}`);
  for (const match of html.matchAll(/href="(\/[^"#?]*)/g)) {
    const href = match[1];
    if (href && !href.startsWith("/assets/")) internalHrefs.add(href);
  }
}

for (const href of internalHrefs) {
  const relative = href === "/" ? "index.html" : href.endsWith("/") ? `${href.slice(1)}index.html` : href.slice(1);
  if (!(await exists(resolve(root, relative)))) throw new Error(`site internal link missing: ${href} -> ${relative}`);
}

console.log(JSON.stringify({
  protocol: "anyam.site-smoke/v1",
  status: "succeeded",
  pages: pages.length - 1,
  assets: assets.length,
  internalLinksChecked: internalHrefs.size,
  parityDocuments: parityChecks.length,
  receipt: "static-pages=present; metadata=present; internal-links=resolved; docs-parity=seven-sources-and-all-fenced-code; placeholders=absent",
}, null, 2));
