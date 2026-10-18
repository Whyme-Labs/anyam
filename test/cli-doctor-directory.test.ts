import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { LOCAL_ACTION_POLICY } from "../packages/create-anyam/src/agent.ts";
import { scaffoldProject, type LocalCheckReport } from "../packages/create-anyam/src/scaffold.ts";

const execFile = promisify(execFileCallback);
const cli = fileURLToPath(new URL("../packages/create-anyam/src/anyam.ts", import.meta.url));
const loader = import.meta.resolve("tsx");

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "anyam-doctor-")));
  const current = join(root, "current");
  const selected = join(root, "selected Project");
  await scaffoldProject({ directory: current, name: "current", kind: "library" });
  await scaffoldProject({ directory: selected, name: "selected", kind: "worker" });
  const run = (command: string, args: readonly string[], cwd = current) => execFile(process.execPath,
    ["--import", loader, cli, command, ...args, "--json"],
    { cwd, timeout: LOCAL_ACTION_POLICY.timeoutMs, env: { ...process.env, ANYAM_STATE_HOME: join(root, "state") } });
  return { root, current, selected, run };
}

test("doctor and check report blockers from --directory instead of passing the current Project", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.selected, "src/index.ts"), "");
    for (const command of ["doctor", "check"]) {
      for (const path of [f.selected, relative(f.current, f.selected)]) {
        await assert.rejects(f.run(command, ["--directory", path]), (error: unknown) => {
          assert.ok(error instanceof Error && "stdout" in error && "code" in error);
          assert.equal(error.code, 1);
          const report = JSON.parse(String(error.stdout)) as LocalCheckReport;
          assert.equal(report.directory, f.selected);
          assert.equal(report.status, "blocked");
          assert.ok(report.blockers.some(blocker => blocker.code === "source.empty"));
          return true;
        });
      }
    }
    assert.equal(await readFile(join(f.selected, "src/index.ts"), "utf8"), "");
    for (const directory of [f.current, f.selected]) await assert.rejects(access(join(directory, ".anyam")), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("doctor and check select the explicit directory over a positional Project", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.current, "src/index.ts"), "");
    for (const command of ["doctor", "check"]) {
      const report = JSON.parse((await f.run(command, [f.current, "--directory", relative(f.current, f.selected)])).stdout) as LocalCheckReport;
      assert.equal(report.directory, f.selected);
      assert.equal(report.status, "passed");
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("doctor and check retain positional and current-directory selection", async () => {
  const f = await fixture();
  try {
    for (const command of ["doctor", "check"]) {
      for (const [args, directory] of [[[], f.current], [[relative(f.current, f.selected)], f.selected]] as const) {
        const report = JSON.parse((await f.run(command, args)).stdout) as LocalCheckReport;
        assert.equal(report.directory, directory);
        assert.equal(report.status, "passed");
      }
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
