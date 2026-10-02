import { fixtureGit, runLocalVerifierCohortQualification } from "../test/fixtures/cohort-local-verifier.ts";

// This command owns disposable reference fixtures only. It never operates on
// the caller's Project or turns the test provider into a hosted adapter.
try {
  if (fixtureGit(process.cwd(), "status", "--porcelain", "--untracked-files=no")) throw new Error("commit the exact implementation before generating its qualification report");
  const implementation = { revision: fixtureGit(process.cwd(), "rev-parse", "HEAD"), tree: fixtureGit(process.cwd(), "rev-parse", "HEAD^{tree}") };
  console.log(JSON.stringify(await runLocalVerifierCohortQualification(implementation), null, 2));
} catch (error) {
  console.error(JSON.stringify({ protocol: "anyam.cohort-local-verifier-qualification/v1", status: "blocked", error: error instanceof Error ? error.message : String(error), recoveryAction: "inspect the exact local fixture boundary; do not substitute a supervised runner or synthetic passing Evidence", liveProviderCalls: false, nativeHarnessCalls: false }, null, 2));
  process.exitCode = 2;
}
