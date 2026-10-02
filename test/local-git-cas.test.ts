import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalGitRepositoryDriver } from "../src/portability/local-git.ts";

test("local Git CAS rejects every ref when one desired object is invalid and permits exactly one concurrent winner", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyam-ref-cas-"));
  try {
    const driver = new LocalGitRepositoryDriver(root);
    const created = await driver.createRepository({ sourceSpaceId: "source:cas", directory: root });
    if (created.status !== "succeeded") throw new Error(created.message);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "next");
    const next = git("rev-parse", "HEAD");
    git("update-ref", "refs/heads/a", base);
    git("update-ref", "refs/heads/b", base);
    const partial = await driver.compareAndSwapRefs({ repository: created.value, expected: { "refs/heads/a": base, "refs/heads/b": base }, desired: { "refs/heads/a": next, "refs/heads/b": "f".repeat(40) } });
    assert.equal(partial.status, "failed");
    assert.equal(git("rev-parse", "refs/heads/a"), base, "invalid B aborts A's ref update too");
    assert.equal(git("rev-parse", "refs/heads/b"), base);
    const request = { repository: created.value, expected: { "refs/heads/a": base }, desired: { "refs/heads/a": next } };
    const results = await Promise.all([driver.compareAndSwapRefs(request), driver.compareAndSwapRefs(request)]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["failed", "succeeded"]);
    assert.equal(git("rev-parse", "refs/heads/a"), next);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
