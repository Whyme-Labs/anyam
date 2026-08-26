import { readFile } from "node:fs/promises";

import { validateRealTeamGate } from "../src/qualification/real-team-gate.ts";

const evidencePath = process.argv[2];
if (!evidencePath) {
  console.log(JSON.stringify({ protocol: "anyam.real-team-adoption-gate/v1", status: "blocked", blockers: [{ key: "evidence.path", message: "No real-team evidence bundle was supplied.", nextAction: "run this command with the path to the owner-controlled evidence JSON" }], credentialValues: "not-printed", canonicalWrite: false, receipt: "evidence=missing; human-cohort=not-verified; production-operations=not-verified; credentialValues=not-printed; canonicalWrite=false" }, null, 2));
  process.exitCode = 2;
} else {
  try {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as unknown;
    const result = validateRealTeamGate(evidence);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ready") process.exitCode = 2;
  } catch (error) {
    console.log(JSON.stringify({ protocol: "anyam.real-team-adoption-gate/v1", status: "blocked", blockers: [{ key: "evidence.read", message: error instanceof Error ? error.message : String(error), nextAction: "provide one readable owner-controlled evidence JSON bundle and retry the same validation" }], credentialValues: "not-printed", canonicalWrite: false, receipt: "evidence=unreadable; transition=not-applied; credentialValues=not-printed; canonicalWrite=false" }, null, 2));
    process.exitCode = 2;
  }
}
