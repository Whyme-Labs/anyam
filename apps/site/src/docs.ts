import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const routes: Record<string, string> = {
  "docs/README.md": "/docs/",
  "docs/guides/quickstart.md": "/docs/quickstart/",
  "docs/guides/customer-realm.md": "/docs/guides/customer-realm/",
  "docs/product/design-philosophy.md": "/docs/product/philosophy/",
  "docs/design/architecture.md": "/docs/design/architecture/",
  "docs/examples/README.md": "/docs/examples/",
  "examples/worker-app/README.md": "/examples/worker-app/",
  "examples/typescript-cli/README.md": "/examples/typescript-cli/",
  "examples/hybrid-video-player/README.md": "/examples/hybrid-video-player/",
};

function escape(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// The documentation uses this small Markdown subset. HTML is always escaped;
// relative links resolve to site pages or the exact repository source path.
export async function documentationBody(repository: string, source: string): Promise<string> {
  const markdown = await readFile(resolve(repository, source), "utf8");
  const inline = (value: string): string => {
    const tokens: string[] = [];
    const token = (html: string) => `\u0000${tokens.push(html) - 1}\u0000`;
    const protectedValue = value.replace(/`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)/g, (_match, code: string | undefined, label: string | undefined, href: string | undefined) => {
      if (code !== undefined) return token(`<code>${escape(code)}</code>`);
      const target = href!;
      let url = target;
      if (!/^(https?:|#)/.test(target)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) throw new Error(`unsupported documentation link: ${target}`);
        const [path, fragment] = target.split("#");
        const repositoryPath = relative(repository, resolve(repository, dirname(source), path!));
        if (repositoryPath.startsWith("..")) throw new Error(`documentation link escapes repository: ${target}`);
        url = routes[repositoryPath] ?? `https://github.com/Whyme-Labs/anyam/blob/main/${repositoryPath}`;
        if (fragment) url += `#${fragment}`;
      }
      return token(`<a href="${escape(url)}">${escape(label!)}</a>`);
    });
    return escape(protectedValue).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\u0000(\d+)\u0000/g, (_m, index: string) => tokens[Number(index)]!);
  };
  const lines = markdown.trim().split(/\r?\n/);
  const output: string[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      if (i === lines.length) throw new Error(`unclosed code fence: ${source}`);
      i++;
      output.push(`<div class="code-block"><pre><code>${escape(code.join("\n"))}</code></pre></div>`);
    } else if (/^#{1,6} /.test(line)) {
      const level = line.indexOf(" ");
      const title = line.slice(level + 1);
      const id = title.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ +/g, "-");
      output.push(`<h${level} id="${id}">${inline(title)}</h${level}>`);
      i++;
    } else if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) rows.push(lines[i++]!.split("|").slice(1, -1).map(c => c.trim()));
      const header = rows.shift()!;
      if (rows[0]?.every(c => /^:?-+:?$/.test(c))) rows.shift();
      output.push(`<div class="table-wrap"><table><thead><tr>${header.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (/^- /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("- ")) {
        let item = lines[i++]!.slice(2);
        while (i < lines.length && /^  \S/.test(lines[i]!)) item += ` ${lines[i++]!.trim()}`;
        items.push(`<li>${inline(item)}</li>`);
      }
      output.push(`<ul class="check-list">${items.join("")}</ul>`);
    } else {
      const paragraph: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !/^(#{1,6} |```|\||- )/.test(lines[i]!)) paragraph.push(lines[i++]!);
      output.push(`<p>${inline(paragraph.join(" "))}</p>`);
    }
  }
  return `<article class="article architecture-article" data-document-source="${escape(source)}">${output.join("\n")}</article>`;
}
