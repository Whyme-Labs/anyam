import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const cli = fileURLToPath(new URL("../packages/create-anyam/src/anyam.ts", import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anyam-cli-change-"));
  const directory = join(root, "project");
  const execute = (args: readonly string[]) => execFile(process.execPath,
    ["--import", "tsx", cli, ...args, "--json"], { cwd: process.cwd(), encoding: "utf8",
      env: { ...process.env, ANYAM_STATE_HOME: join(root, "private-state") } });
  await execute(["init", directory, "--type", "library", "--name", "cli-change"]);
  return { root, directory, execute };
}

test("public CLI preserves Change title words and persists the same review metadata", async () => {
  for (const words of [["Verify the local arithmetic candidate"], ["change"], ["start"], ["start", "the", "change"]]) {
    const { root, directory, execute } = await fixture();
    try {
      const result = JSON.parse((await execute(["change", "start", ...words, "--directory", directory])).stdout);
      const stored = JSON.parse(await readFile(join(directory, ".anyam", "change.json"), "utf8"));
      assert.equal(result.title, words.join(" "));
      assert.equal(stored.title, result.title);
      assert.equal(stored.id, result.changeId);
      assert.equal(result.status, "created");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("public CLI rejects a missing Change title before creating metadata or starting an agent", async () => {
  const { root, directory, execute } = await fixture();
  try {
    await assert.rejects(execute(["change", "start", "--agent", "cli", "--directory", directory]),
      (error: unknown) => error instanceof Error && "stderr" in error
        && /Change title must not be empty/.test(String(error.stderr)));
    await assert.rejects(access(join(directory, ".anyam", "change.json")), { code: "ENOENT" });
    await assert.rejects(access(join(root, "private-state")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
