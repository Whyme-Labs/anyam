import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const scripts = [
  "scripts/qualify-external-runner.ts",
  "scripts/qualify-provider-feed.ts",
  "scripts/qualify-replay-archive-workload.ts",
  "scripts/qualify-hosted-saas.ts",
  "scripts/qualify-worker-target.ts",
] as const;

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("ANYAM_") || key === "CLOUDFLARE_ACCOUNT_ID") delete environment[key];
  }
  return environment;
}

test("qualification scripts fail deterministically when their named inputs are missing", async () => {
  const environment = cleanEnvironment();
  for (const script of scripts) {
    let failure: { stdout?: string; stderr?: string; code?: string | number } | undefined;
    try {
      await execFile(process.execPath, ["node_modules/tsx/dist/cli.mjs", script], {
        cwd: process.cwd(),
        env: environment,
        maxBuffer: 1024 * 1024,
      });
      assert.fail(`${script} unexpectedly succeeded without qualification inputs`);
    } catch (error) {
      failure = error as { stdout?: string; stderr?: string; code?: string | number };
    }

    assert.ok(failure, `${script} did not return a failure result`);
    assert.notEqual(failure.code, 0, `${script} must fail closed`);
    const raw = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
    const body = JSON.parse(raw) as { status?: string; credentialValues?: string; recoveryAction?: string };
    assert.equal(body.status, "blocked", `${script} must report a blocked protocol result`);
    assert.equal(body.credentialValues, "not-printed", `${script} must not print credential material`);
    assert.equal(typeof body.recoveryAction, "string", `${script} must name a recovery action`);
  }
});
