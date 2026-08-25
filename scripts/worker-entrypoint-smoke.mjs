import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// This inventory is the route contract for the deployable Workers. The bundle
// smoke below fails when a route disappears from the shipped JavaScript, while
// the source path keeps the failure readable to the next maintainer.
const workers = [
  {
    id: "realm",
    config: "apps/realm-worker/wrangler.example.jsonc",
    sources: ["apps/realm-worker/src/index.ts", "apps/realm-worker/src/passkey-owner.ts", "apps/realm-worker/src/authority-edge.ts", "apps/realm-worker/src/github-actions-bridge-route.ts", "apps/realm-worker/src/github-actions-bridge-contract.ts", "src/cloudflare/realm-worker.ts"],
    routes: ["/health", "/mcp", "/authorize", "/owner/login", "/api/projects", "/api/projects/", "/api/intents", "/api/pull-requests", "/api/integrations/github-actions/bridge/exchange", "/api/integrations/github-actions/bridge/outbound/bundle", "/api/integrations/github-actions/bridge/outbound/complete"],
  },
  {
    id: "public-gateway",
    config: "apps/public-gateway-worker/wrangler.example.jsonc",
    source: "apps/public-gateway-worker/src/index.ts",
    routes: ["/health", "/public/source-manifest", "/projects/public/source.git/", "/public/contributions"],
  },
  {
    id: "hosted-saas",
    config: "apps/hosted-saas-qualification/wrangler.example.jsonc",
    source: "apps/hosted-saas-qualification/src/index.ts",
    routes: ["/health", "/admin/", "/r/"],
  },
  {
    id: "runner-qualification",
    config: "apps/runner-qualification/wrangler.qualification.jsonc",
    source: "apps/runner-qualification/src/index.ts",
    routes: ["/health", "/jobs/", "/status", "/claim", "/result"],
  },
  {
    id: "replay-archive-workload",
    config: "apps/replay-archive-workload-qualification/wrangler.jsonc",
    source: "apps/replay-archive-workload-qualification/src/index.ts",
    routes: ["/measure", "/cleanup"],
  },
  {
    id: "provider-target",
    config: "apps/provider-qualification-target/wrangler.jsonc",
    source: "apps/provider-qualification-target/src/index.ts",
    routes: ["operationId", "invalid_qualification_request"],
  },
  {
    id: "promotion-executor",
    config: "apps/promotion-executor/wrangler.example.jsonc",
    source: "apps/promotion-executor/src/index.ts",
    routes: ["/health", "/execute", "anyam.promotion-execution/v1"],
  },
  {
    id: "linux-egress-qualification",
    config: "apps/linux-egress-qualification/wrangler.example.jsonc",
    source: "apps/linux-egress-qualification/src/index.ts",
    routes: ["/run", "anyam.workspace-egress/v1", "enableInternet=false"],
    containersRolloutNone: true,
  },
];

async function ensureFile(path, label) {
  try {
    const details = await stat(path);
    if (!details.isFile()) throw new Error(`${label} is not a file`);
  } catch (error) {
    throw new Error(`${label} is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function qualifyWorker(worker, tempRoot) {
  const sourcePaths = worker.sources ?? [worker.source];
  const configPath = join(root, worker.config);
  for (const source of sourcePaths) await ensureFile(join(root, source), `${worker.id} source`);
  await ensureFile(configPath, `${worker.id} Wrangler config`);
  const source = (await Promise.all(sourcePaths.map((path) => readFile(join(root, path), "utf8")))).join("\n");
  if (!/export\s+default\s*[{]/u.test(source)) throw new Error(`${worker.id} entrypoint does not export a default Worker handler`);
  for (const route of worker.routes) {
    if (!source.includes(route)) throw new Error(`${worker.id} route contract is missing from source: ${route}`);
  }

  const outdir = join(tempRoot, worker.id);
  const args = [
    join(root, "node_modules/wrangler/bin/wrangler.js"),
    "deploy",
    "--dry-run",
    "--config",
    worker.config,
    "--outdir",
    outdir,
  ];
  if (worker.containersRolloutNone) args.push("--containers-rollout=none");
  const result = await execFile(process.execPath, args, { cwd: root });
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes("Total Upload:")) throw new Error(`${worker.id} Wrangler output did not report a bundle upload size`);
  const bundlePath = join(outdir, "index.js");
  await ensureFile(bundlePath, `${worker.id} bundled entrypoint`);
  const bundle = await readFile(bundlePath, "utf8");
  if (bundle.length === 0) throw new Error(`${worker.id} bundled entrypoint is empty`);
  for (const route of worker.routes) {
    if (!bundle.includes(route)) throw new Error(`${worker.id} route contract is missing from bundle: ${route}`);
  }
  return { id: worker.id, status: "passed", sources: sourcePaths, config: worker.config, routes: worker.routes, bundleBytes: Buffer.byteLength(bundle), receipt: "source=default-handler; routes=source-and-bundle-present; wrangler=dry-run; deployment=not-performed" };
}

const tempRoot = await mkdtemp(join(tmpdir(), "anyam-worker-entrypoint-smoke-"));
try {
  const results = [];
  for (const worker of workers) results.push(await qualifyWorker(worker, tempRoot));
  console.log(JSON.stringify({ protocol: "anyam.worker-entrypoint-smoke/v1", status: "passed", workers: results, credentialValues: "not-printed", deployment: "not-performed", receipt: "all-deployable-entrypoints=source-and-bundle-qualified; provider-bindings=not-live" }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ protocol: "anyam.worker-entrypoint-smoke/v1", status: "blocked", error: error instanceof Error ? error.message : String(error), credentialValues: "not-printed", recoveryAction: "repair the named source, route contract, or Wrangler bundle and rerun the repository gate", receipt: "entrypoint=not-qualified; deployment=not-performed" }, null, 2));
  process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
