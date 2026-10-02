import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";

const repository = resolve(".");
const required = [
  "docs/README.md",
  "docs/guides/quickstart.md",
  "docs/guides/customer-realm.md",
  "docs/product/design-philosophy.md",
  "docs/design/architecture.md",
  "docs/examples/README.md",
];
const checked = ["README.md", "packages/create-anyam/README.md", ...required];

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

for (const relative of required) {
  if (!(await exists(resolve(repository, relative)))) throw new Error(`required documentation missing: ${relative}`);
}

let linksChecked = 0;
for (const relative of checked) {
  const source = await readFile(resolve(repository, relative), "utf8");
  const headings = [...source.matchAll(/^# /gm)];
  if (relative !== "README.md" && headings.length !== 1) throw new Error(`${relative} must contain one H1 heading`);
  for (const match of source.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const target = href.split("#", 1)[0];
    if (!target) continue;
    const absolute = resolve(repository, dirname(relative), target);
    const targetExists = await exists(absolute) || (await exists(absolute.replace(/\/$/, "")));
    if (!targetExists) throw new Error(`documentation link missing: ${relative} -> ${href}`);
    linksChecked += 1;
  }
}

const index = await readFile(resolve(repository, "docs/README.md"), "utf8");
for (const phrase of ["Quickstart", "Design philosophy", "Architecture", "Examples", "Customer-operated Realm"]) {
  if (!index.includes(phrase)) throw new Error(`documentation index missing section: ${phrase}`);
}

console.log(JSON.stringify({
  protocol: "anyam.docs-smoke/v1",
  status: "succeeded",
  documents: checked.length,
  linksChecked,
  receipt: "required-guides=present; headings=one-per-document; relative-links=resolved; index=complete",
}, null, 2));
