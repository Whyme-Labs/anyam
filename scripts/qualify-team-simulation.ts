import { runTeamSimulation } from "../src/qualification/team-simulation.ts";

try {
  const report = await runTeamSimulation({ fixtureRoot: process.cwd() });
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "succeeded") process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ protocol: "anyam.team-simulation/v1", status: "blocked", error: error instanceof Error ? error.message : String(error), credentialValues: "not-printed", canonicalWrite: false, recoveryAction: "inspect the named scenario receipt and rerun the same local simulation" }, null, 2));
  process.exitCode = 2;
}
