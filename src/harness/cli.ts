import { fileURLToPath } from "node:url";

import { runK0Harness } from "./k0.ts";

const report = await runK0Harness({
  fixtureRoot: fileURLToPath(new URL("../../fixtures/", import.meta.url)),
});

console.log(JSON.stringify(report, null, 2));
if (report.gate.status !== "ready") process.exitCode = 1;
