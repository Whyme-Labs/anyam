import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repository = dirname(scriptsDirectory);
const sources = ["test/pull-request-rest.test.ts", "test/fixtures/artifacts-realm-runtime.ts"];
const probes = [];

function runTypeScript(configPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repository, "node_modules/typescript/bin/tsc"), "-p", configPath, "--noEmit"], { cwd: repository, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

for (const sourcePath of sources) {
  // Keep the copied file at its original import depth under the repository.
  const temporaryDirectory = await mkdtemp(join(dirname(dirname(join(repository, sourcePath))), ".worker-test-boundary-"));
  const probeName = basename(sourcePath).replace(/\.ts$/, ".type-probe.ts");
  try {
    const source = await readFile(join(repository, sourcePath), "utf8");
    await writeFile(join(temporaryDirectory, probeName), `${source}\nconst __intentionalWorkerTestBoundaryError: string = __missingWorkerTestBoundaryValue;\n`, "utf8");
    if (sourcePath === "test/fixtures/artifacts-realm-runtime.ts") {
      await writeFile(join(temporaryDirectory, "artifacts-binding.ts"), await readFile(join(repository, "test/fixtures/artifacts-binding.ts"), "utf8"), "utf8");
    }
    const configPath = join(temporaryDirectory, "tsconfig.json");
    await writeFile(configPath, JSON.stringify({ extends: join(repository, "tsconfig.worker-tests.json"), compilerOptions: { noEmit: true }, include: [probeName] }, null, 2), "utf8");
    const result = await runTypeScript(configPath);
    const output = `${result.stdout}${result.stderr}`;
    const errors = output.split("\n").filter(line => line.includes("error TS"));
    const rejected = result.code !== 0 && errors.length > 0 && errors.every(line => line.includes(probeName) && line.includes("__missingWorkerTestBoundaryValue"));
    probes.push({ source: sourcePath, intentionalTypeError: rejected ? "rejected" : "not-rejected", compilerExitCode: result.code, ...(rejected ? {} : { diagnostics: output.slice(-2000) }) });
    if (!rejected) process.exitCode = 1;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ protocol: "anyam.worker-test-type-boundary/v1", status: process.exitCode ? "blocked" : "succeeded", project: "tsconfig.worker-tests.json", probes, receipt: "baseline=run-by-repository-gate; probes=exact-source-copies; cleanup=owned-probes-only" }, null, 2));
