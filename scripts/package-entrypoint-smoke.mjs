import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const packageManifest = require("../packages/create-anyam/package.json");

function executable(command) {
  if (process.platform !== "win32") return command;
  if (command === "npm" || command === "npx" || command === "pnpm") return `${command}.cmd`;
  return `${command}.exe`;
}

async function run(command, args, options = {}) {
  const result = await execFile(executable(command), args, options);
  return result.stdout;
}

async function commandAvailable(command) {
  try {
    await run(command, ["--version"]);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw new Error(`${command} is installed but its --version check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function scaffoldWith(label, command, args, cwd, target) {
  const output = await run(command, [...args, target, "--json"], { cwd });
  const result = JSON.parse(output);
  if (result.status !== "created" || !result.createdFiles.includes("anyam.json")) {
    throw new Error(`${label} did not create a valid Anyam template: ${output}`);
  }
  return { label, target, kind: result.kind, git: result.git };
}

const root = await mkdtemp(join(tmpdir(), "anyam-package-entrypoints-"));
const packDirectory = join(root, "pack");
const tarball = join(packDirectory, `create-anyam-${packageManifest.version}.tgz`);
await mkdir(packDirectory, { recursive: true });
await run("npm", ["pack", "--workspace=create-anyam", "--pack-destination", packDirectory], { cwd: process.cwd() });

const results = [];
const missingCommands = [];
results.push(await scaffoldWith("npm exec (npm create equivalent for an offline tarball)", "npm", ["exec", "--yes", `--package=${tarball}`, "--", "create-anyam"], root, join(root, "npm", "demo")));
results.push(await scaffoldWith("npx create-anyam", "npx", ["--yes", `--package=${tarball}`, "create-anyam"], root, join(root, "npx", "demo")));

if (await commandAvailable("pnpm")) {
  results.push(await scaffoldWith("pnpm dlx create-anyam", "pnpm", ["dlx", tarball, "--"], root, join(root, "pnpm", "demo")));
} else {
  missingCommands.push("pnpm");
}

if (await commandAvailable("bun")) {
  const bunRoot = join(root, "bun");
  await mkdir(bunRoot, { recursive: true });
  await run("bun", ["install", "--cwd", bunRoot, tarball, "--no-progress"]);
  results.push(await scaffoldWith("bun x create-anyam", "bun", ["x", "--bun", "create-anyam"], bunRoot, join(bunRoot, "demo")));
} else {
  missingCommands.push("bun");
}

const status = missingCommands.length === 0 ? "passed" : "blocked";
console.log(JSON.stringify({ package: packageManifest.name, version: packageManifest.version, status, missingCommands, results }, null, 2));
await rm(root, { recursive: true, force: true });
if (status === "blocked") process.exitCode = 1;
