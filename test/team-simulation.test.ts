import assert from "node:assert/strict";
import test from "node:test";

import { runTeamSimulation } from "../src/qualification/team-simulation.ts";

test("team simulation exercises real Git, hybrid projection, review, Landing, mirror, and export seams", async () => {
  const report = await runTeamSimulation();
  const scenarios = new Map(report.scenarios.map((scenario) => [scenario.id, scenario]));
  assert.equal(report.protocol, "anyam.team-simulation/v1");
  assert.equal(scenarios.get("worker-team")?.verdict, "VERIFIED");
  assert.equal(scenarios.get("cli-team")?.verdict, "VERIFIED");
  assert.equal(scenarios.get("git-conflict-rebase")?.verdict, "VERIFIED");
  assert.equal(scenarios.get("team-review-landing")?.verdict, "VERIFIED");
  assert.equal(scenarios.get("release-sealing")?.verdict, "VERIFIED");
  assert.equal(scenarios.get("hybrid-public-private")?.verdict, "VERIFIED");
  assert.equal(scenarios.get("github-bidirectional")?.verdict, "VERIFIED");
  assert.equal(scenarios.get("export-restore")?.verdict, "VERIFIED");
  assert.equal(scenarios.get("intent-lifecycle")?.verdict, "VERIFIED");
  assert.equal(scenarios.get("pull-request-lifecycle")?.verdict, "VERIFIED");
  assert.equal(scenarios.get("issue-pr-lifecycle")?.verdict, "VERIFIED");
  const exportObservations = scenarios.get("export-restore")?.observations ?? {};
  const workerExport = exportObservations.worker as Record<string, unknown> | undefined;
  assert.equal(workerExport?.intentCount, 1);
  assert.equal(workerExport?.intentCommentCount, 1);
  assert.equal(workerExport?.pullRequestCount, 1);
  assert.equal(report.provider.cloudflare, "not-run");
  assert.equal(report.credentialValues, "not-printed");
  assert.equal(report.canonicalWrite, false);
  assert.ok(report.measurements.gitOperationCount > 0);
  assert.ok(report.measurements.localWorkspaceCount > 0);
  assert.ok(report.measurements.localChangeCount > 0);
  assert.equal(report.findings.some((finding) => finding.seam === "issue-intent-lifecycle"), false);
  assert.equal(report.findings.some((finding) => finding.seam === "pull-request-compatibility-lifecycle"), false);
  assert.match(String(scenarios.get("issue-pr-lifecycle")?.receipt), /intentLifecycle=verified/);
});
