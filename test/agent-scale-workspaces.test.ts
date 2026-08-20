import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);

test("agent-scale Workspace qualification fans out isolated work and funnels it through verified Landing", async () => {
  const result = await execFile(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/qualify-agent-scale-workspaces.ts"], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });
  const value = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(value.status, "succeeded");
  assert.equal(value.canonicalWrite, false);
  assert.equal(value.credentialValues, "not-printed");
  assert.equal((value.measurements as { workspaceCount: number }).workspaceCount, 3);
  assert.equal((value.workspaces as { isolated: boolean }).isolated, true);
  assert.equal((value.overlap as { status: string }).status, "blocked");
  assert.equal((value.evidence as { blockedGate: { status: string }; readyGate: { status: string } }).blockedGate.status, "blocked");
  assert.equal((value.evidence as { blockedGate: { status: string }; readyGate: { status: string } }).readyGate.status, "ready");
  assert.equal((value.landing as { status: string }).status, "succeeded");
  assert.equal((value.duplicateEvent as { status: string }).status, "blocked");
  assert.equal((value.staleBase as { status: string }).status, "blocked");
  assert.equal((value.retryResume as { status: string }).status, "succeeded");
  assert.equal((value.landableRevisions as { status: string }).status, "verified");
  assert.equal((value.release as { status: string }).status, "not-created");
  assert.equal((value.cleanup as { status: string }).status, "succeeded");
});
