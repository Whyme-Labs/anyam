import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repository = dirname(scriptsDirectory);
const temporaryDirectory = await mkdtemp(join(repository, ".worker-test-boundary-"));
const probePath = join(temporaryDirectory, "pull-request-rest.type-probe.test.ts");
const probeConfigPath = join(temporaryDirectory, "tsconfig.json");

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

try {
  const source = await readFile(join(repository, "test/pull-request-rest.test.ts"), "utf8");
  await writeFile(probePath, `${source}\nconst __intentionalWorkerTestBoundaryError: string = __missingWorkerTestBoundaryValue;\n`, "utf8");
  await writeFile(probeConfigPath, JSON.stringify({ extends: "../tsconfig.worker-tests.json", compilerOptions: { noEmit: true }, include: ["pull-request-rest.type-probe.test.ts"] }, null, 2), "utf8");
  const result = await runTypeScript(probeConfigPath);
  const output = `${result.stdout}${result.stderr}`;
  const rejectedIntentionalError = result.code !== 0 && output.includes("__missingWorkerTestBoundaryValue");
  console.log(JSON.stringify({ protocol: "anyam.worker-test-type-boundary/v1", status: rejectedIntentionalError ? "succeeded" : "blocked", project: "tsconfig.worker-tests.json", source: "test/pull-request-rest.test.ts", intentionalTypeError: "rejected", compilerExitCode: result.code, ...(rejectedIntentionalError ? {} : { diagnostics: output.slice(-2000) }), receipt: `project=tsconfig.worker-tests.json; source=test/pull-request-rest.test.ts; intentionalErrorRejected=${rejectedIntentionalError}; baseline=run-by-repository-gate` }, null, 2));
  if (!rejectedIntentionalError) process.exitCode = 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
