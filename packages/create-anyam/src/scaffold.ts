import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gitCommitIdentity, gitProjectRevisionId, gitTreeIdentity, inspectGitSource, LocalGitSourceError } from "./git-source.js";

const execFile = promisify(execFileCallback);
const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export type ProjectTemplateKind = "worker" | "library";

export type ScaffoldInput = {
  directory: string;
  name?: string;
  kind: ProjectTemplateKind;
  dryRun?: boolean;
};

export type ScaffoldResult = {
  status: "created" | "unchanged" | "planned";
  directory: string;
  name: string;
  kind: ProjectTemplateKind;
  git: "initialized" | "existing" | "not-created";
  createdFiles: readonly string[];
};

export type CheckReceipt = {
  name: string;
  status: "passed" | "observed";
  receipt: string;
};

export type CheckBlocker = {
  code: string;
  message: string;
};

export type LocalCheckReport = {
  status: "passed" | "blocked";
  directory: string;
  receipts: readonly CheckReceipt[];
  blockers: readonly CheckBlocker[];
};

type TemplateFile = {
  path: string;
  content: string;
};

const projectSchema = "anyam.project/v1";

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function manifestShapeProblems(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["manifest must be a JSON object"];
  const problems: string[] = [];
  if (typeof value.id !== "string") problems.push("id");
  if (typeof value.referenceType !== "string") problems.push("referenceType");
  if (!Array.isArray(value.sourceSpaceIds)) problems.push("sourceSpaceIds");
  if (!isRecord(value.source)) problems.push("source");
  const modules = value.modules;
  if (!Array.isArray(modules) || modules.length === 0) {
    problems.push("modules");
  } else {
    for (const [index, module] of modules.entries()) {
      if (!isRecord(module)) {
        problems.push(`modules[${index}]`);
        continue;
      }
      if (typeof module.id !== "string") problems.push(`modules[${index}].id`);
      if (typeof module.root !== "string") problems.push(`modules[${index}].root`);
      if (!Array.isArray(module.dependencies)) problems.push(`modules[${index}].dependencies`);
      if (!Array.isArray(module.artifactTypes)) problems.push(`modules[${index}].artifactTypes`);
      if (!Array.isArray(module.actions) || module.actions.length === 0) {
        problems.push(`modules[${index}].actions`);
      } else {
        for (const [actionIndex, action] of module.actions.entries()) {
          if (!isRecord(action)) {
            problems.push(`modules[${index}].actions[${actionIndex}]`);
            continue;
          }
          for (const field of ["id", "command", "inputs", "outputs", "network", "resources"] as const) {
            if (field === "id" || field === "command") {
              if (typeof action[field] !== "string") problems.push(`modules[${index}].actions[${actionIndex}].${field}`);
            } else if (field === "resources") {
              if (!isRecord(action[field])) problems.push(`modules[${index}].actions[${actionIndex}].${field}`);
            } else if (!Array.isArray(action[field])) {
              problems.push(`modules[${index}].actions[${actionIndex}].${field}`);
            }
          }
        }
      }
    }
  }
  if (!Array.isArray(value.verifiers) || value.verifiers.length === 0) problems.push("verifiers");
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    problems.push("targets");
  } else {
    for (const [index, target] of value.targets.entries()) {
      if (!isRecord(target)) {
        problems.push(`targets[${index}]`);
        continue;
      }
      for (const field of ["id", "adapter", "accepts", "requiredCapabilities"] as const) {
        if (field === "id" || field === "adapter") {
          if (typeof target[field] !== "string") problems.push(`targets[${index}].${field}`);
        } else if (!Array.isArray(target[field])) {
          problems.push(`targets[${index}].${field}`);
        }
      }
    }
  }
  return problems;
}

function normalizedName(input: ScaffoldInput): string {
  const name = input.name?.trim() || basename(resolve(input.directory));
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error(`Project name ${JSON.stringify(name)} must start with a letter and contain only letters, numbers, dots, underscores, or hyphens.`);
  }
  return name;
}

function manifest(name: string, kind: ProjectTemplateKind): string {
  const artifactType = kind === "worker" ? "worker.bundle" : "package.archive";
  const target = kind === "worker"
    ? { id: "target:cloudflare-worker", adapter: "cloudflare.worker", accepts: [artifactType], requiredCapabilities: [] }
    : { id: "target:release-assets", adapter: "generic.release-assets", accepts: [artifactType], requiredCapabilities: [] };
  return `${JSON.stringify({
    schema: projectSchema,
    id: `project:local:${name}`,
    name,
    referenceType: kind === "worker" ? "typescript-worker" : "typescript-library",
    sourceSpaceIds: ["source:local"],
    source: { root: "src", provenance: "scaffold" },
    modules: [{
      id: "module:main",
      root: "src",
      dependencies: [],
      actions: [{
        id: "action:check",
        command: "anyam check",
        inputs: ["anyam.json", "package.json", "tsconfig.json", "src/**/*.ts"],
        outputs: [],
        network: [],
        resources: {},
      }],
      artifactTypes: [artifactType],
    }],
    verifiers: [{
      id: "verifier:local-check",
      actionId: "action:check",
      disclosure: "full",
      requiredFor: ["release"],
    }],
    targets: [target],
  }, null, 2)}\n`;
}

export function proposedManifest(input: ScaffoldInput): Record<string, unknown> {
  return JSON.parse(manifest(normalizedName(input), input.kind)) as Record<string, unknown>;
}

function templateFiles(name: string, kind: ProjectTemplateKind): readonly TemplateFile[] {
  const entryPoint = kind === "worker"
    ? `export function handle(request: Request): Response {\n  return new Response(JSON.stringify({ project: ${JSON.stringify(name)}, path: new URL(request.url).pathname }));\n}\n`
    : `export function greet(name: string): string {\n  return \`Hello, \${name}\`;\n}\n`;
  const readme = kind === "worker"
    ? `# ${name}\n\nA TypeScript Worker Project scaffolded by Anyam.\n\nLocal loop:\n\n\`\`\`bash\nnpm install\nnpx create-anyam check\ngit status\nnpx create-anyam change start "Describe the next change"\n\`\`\`\n\nThe globally installed command is also available as anyam check and anyam change start.\n`
    : `# ${name}\n\nA TypeScript library Project scaffolded by Anyam.\n\nLocal loop:\n\n\`\`\`bash\nnpm install\nnpx create-anyam check\ngit status\nnpx create-anyam change start "Describe the next change"\n\`\`\`\n\nThe globally installed command is also available as anyam check and anyam change start.\n`;
  return [
    { path: "anyam.json", content: manifest(name, kind) },
    {
      path: "package.json",
      content: `${JSON.stringify({
        name,
        private: true,
        type: "module",
        scripts: { check: "anyam check" },
        devDependencies: { "create-anyam": `^${packageVersion}` },
      }, null, 2)}\n`,
    },
    {
      path: "tsconfig.json",
      content: `${JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src/**/*.ts"] }, null, 2)}\n`,
    },
    { path: ".gitignore", content: "node_modules/\ndist/\n.DS_Store\n" },
    { path: "src/index.ts", content: entryPoint },
    { path: "README.md", content: readme },
  ];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function ensureGitRepository(directory: string): Promise<"initialized" | "existing"> {
  if (await exists(join(directory, ".git"))) return "existing";
  try {
    await execFile("git", ["init", "--quiet"], { cwd: directory });
    return "initialized";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not initialize the local Git repository in ${directory}. Install Git or initialize it manually, then rerun anyam init. ${detail}`);
  }
}

export async function scaffoldProject(input: ScaffoldInput): Promise<ScaffoldResult> {
  const directory = resolve(input.directory);
  const name = normalizedName(input);
  const files = templateFiles(name, input.kind);
  if (input.dryRun) {
    return { status: "planned", directory, name, kind: input.kind, git: "not-created", createdFiles: files.map((file) => file.path) };
  }
  const alreadyInitialized = await exists(join(directory, "anyam.json"));
  await mkdir(directory, { recursive: true });
  const git = await ensureGitRepository(directory);

  if (alreadyInitialized) {
    return { status: "unchanged", directory, name, kind: input.kind, git, createdFiles: [] };
  }

  const createdFiles: string[] = [];
  for (const file of files) {
    const destination = join(directory, file.path);
    if (await exists(destination)) continue;
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, file.content, "utf8");
    createdFiles.push(file.path);
  }

  return { status: "created", directory, name, kind: input.kind, git, createdFiles };
}

type BlockerInput = {
  code: string;
  budget: string;
  limit: string;
  asked: string;
  receipt: string;
  fix: string;
};

function blocker(input: BlockerInput): CheckBlocker {
  return {
    code: input.code,
    message: `budget=${input.budget}; limit=${input.limit}; asked=${input.asked}; receipt=${input.receipt}; fix=${input.fix}`,
  };
}

export async function runLocalCheck(directoryInput: string): Promise<LocalCheckReport> {
  const directory = resolve(directoryInput);
  const receipts: CheckReceipt[] = [];
  const blockers: CheckBlocker[] = [];
  const manifestPath = join(directory, "anyam.json");
  const sourcePath = join(directory, "src");
  const gitPath = join(directory, ".git");

  let parsedManifest: Record<string, unknown> | null = null;
  try {
    const manifestSource = await readFile(manifestPath, "utf8");
    try {
      parsedManifest = JSON.parse(manifestSource) as Record<string, unknown>;
      const shapeProblems = manifestShapeProblems(parsedManifest);
      if (parsedManifest.schema !== projectSchema || typeof parsedManifest.name !== "string" || shapeProblems.length > 0) {
        blockers.push(blocker({
          code: "manifest.invalid",
          budget: "manifest.schema",
          limit: projectSchema,
          asked: shapeProblems.length > 0 ? shapeProblems.join(", ") : String(parsedManifest.schema),
          receipt: "anyam.json was read",
          fix: "review anyam.json and fix its schema and required v1 fields",
        }));
      } else {
        receipts.push({ name: "manifest", status: "passed", receipt: `schema=${parsedManifest.schema}; name=${parsedManifest.name}` });
      }
    } catch {
      blockers.push(blocker({ code: "manifest.invalid", budget: "manifest.json", limit: "valid JSON", asked: "invalid JSON", receipt: "anyam.json was readable but could not be parsed", fix: "repair anyam.json and rerun anyam check" }));
    }
  } catch (error) {
    if (isNotFound(error)) {
      blockers.push(blocker({ code: "manifest.missing", budget: "manifest.file", limit: "present and valid JSON", asked: "anyam.json", receipt: "read failed", fix: "run anyam init" }));
    } else {
      blockers.push(blocker({ code: "manifest.unreadable", budget: "manifest.file", limit: "readable anyam.json", asked: "anyam.json", receipt: "file access failed", fix: "fix local file permissions and rerun anyam check" }));
    }
  }

  try {
    const source = await readFile(join(sourcePath, "index.ts"), "utf8");
    if (source.trim().length === 0) {
      blockers.push(blocker({ code: "source.empty", budget: "source.entrypoint", limit: "non-empty src/index.ts", asked: "0 bytes", receipt: "file exists but is empty", fix: "restore the generated entry point" }));
    } else {
      receipts.push({ name: "source", status: "passed", receipt: `src/index.ts bytes=${Buffer.byteLength(source, "utf8")}` });
    }
  } catch (error) {
    if (isNotFound(error)) {
      blockers.push(blocker({ code: "source.missing", budget: "source.entrypoint", limit: "src/index.ts", asked: "missing", receipt: "read failed", fix: "run anyam init" }));
    } else {
      blockers.push(blocker({ code: "source.unreadable", budget: "source.entrypoint", limit: "readable src/index.ts", asked: "src/index.ts", receipt: "file access failed", fix: "fix local file permissions and rerun anyam check" }));
    }
  }

  if (parsedManifest) {
    receipts.push({ name: "authority", status: "observed", receipt: "no Realm, authentication, provider, or credential fields are created by local scaffolding" });
  }

  if (await exists(gitPath)) {
    receipts.push({ name: "git", status: "passed", receipt: "local Git repository is present" });
  } else {
    blockers.push(blocker({ code: "git.missing", budget: "git.repository", limit: ".git directory or worktree file", asked: "missing", receipt: "local Git metadata was not found", fix: "run anyam init or git init" }));
  }

  return {
    status: blockers.length === 0 ? "passed" : "blocked",
    directory,
    receipts,
    blockers,
  };
}

export type ChangeStartResult = {
  status: "created" | "unchanged";
  changeId: string;
  title: string;
  path: string;
};

export async function startChange(directoryInput: string, titleInput: string): Promise<ChangeStartResult> {
  const directory = resolve(directoryInput);
  const title = titleInput.trim();
  if (!title) throw new Error("Change title must not be empty.");
  const metadataDirectory = join(directory, ".anyam");
  const path = join(metadataDirectory, "change.json");
  if (await exists(path)) {
    const existing = JSON.parse(await readFile(path, "utf8")) as { id?: string; changeId?: string; title: string };
    const changeId = existing.id ?? existing.changeId;
    if (!changeId) throw new Error(`Local Change metadata at ${path} has no canonical Change id; remove it or repair it before retrying.`);
    return { status: "unchanged", changeId, title: existing.title, path };
  }
  const manifest = JSON.parse(await readFile(join(directory, "anyam.json"), "utf8")) as { id?: unknown };
  const projectId = typeof manifest.id === "string" ? manifest.id : `project:local:${basename(directory)}`;
  await mkdir(metadataDirectory, { recursive: true });
  const changeId = `change:${randomUUID()}`;
  let baseProjectRevisionId = "project-revision:local:working-tree";
  let local: Record<string, string> = {
    workspaceId: "workspace:local:working-tree",
    sourceSpaceId: "source:local",
    baseSnapshot: "snapshot:local:working-tree",
  };
  try {
    const source = await inspectGitSource(directory);
    if (source.clean) {
      baseProjectRevisionId = gitProjectRevisionId(source.commitId);
      local = {
        workspaceId: "workspace:local:working-tree",
        sourceSpaceId: "source:local",
        baseSnapshot: gitTreeIdentity(source.treeId),
        baseSourceRevision: gitCommitIdentity(source.commitId),
        baseRepositoryId: source.repositoryId,
        baseGitRef: source.gitRef,
      };
    }
  } catch (error) {
    if (!(error instanceof LocalGitSourceError)) throw error;
  }
  await writeFile(path, `${JSON.stringify({
    protocol: "anyam.change/v1",
    id: changeId,
    projectId,
    intentId: `intent:${randomUUID()}`,
    baseProjectRevisionId,
    status: "active",
    latestRevisionId: null,
    title,
    local,
  }, null, 2)}\n`, "utf8");
  return { status: "created", changeId, title, path };
}
