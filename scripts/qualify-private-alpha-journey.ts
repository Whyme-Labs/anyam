import { PRIVATE_ALPHA_JOURNEY_PROTOCOL, runPrivateAlphaJourneyQualification } from "../src/qualification/private-alpha-journey.ts";

let result: Record<string, unknown> | undefined;
let errorMessage: string | undefined;
try {
  result = await runPrivateAlphaJourneyQualification();
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error);
}

if (errorMessage) {
  console.log(JSON.stringify({
    protocol: PRIVATE_ALPHA_JOURNEY_PROTOCOL,
    status: "blocked",
    error: errorMessage,
    hostingMode: "customer-operated-fixture",
    providerQualification: "fixture-bound; live-provider-qualification-separate",
    credentialValues: "not-printed",
    recoveryAction: "inspect the named stage and retry the same deterministic fixture journey",
  }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify(result, null, 2));
}
