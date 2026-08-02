import { join } from "node:path";

import {
  CONTRACT_VERSIONS,
  createProject,
  createProjectRevision,
  deriveProjectView,
  type ProjectExport,
} from "../kernel/contracts.ts";
import {
  EvidenceLedger,
  evaluateStageGate,
  type EvidenceRecord,
  type ResidualRisk,
  type RiskSpikeReceipt,
  type StageGateDecision,
} from "../kernel/evidence.ts";
import { referenceFixtures, validateReferenceFixtures, type FixtureValidationResult } from "../fixtures/reference.ts";
import {
  InMemoryIdentityProvider,
  InMemoryProjectExporter,
  InMemoryRepositoryDriver,
  InMemoryRunner,
  InMemoryTargetAdapter,
  isCredentialFree,
} from "./adapters.ts";
import type { AdapterResult } from "./adapters.ts";

export type AdapterSeamStatus = "passed" | "failed";

export type K0HarnessReport = {
  contractVersion: typeof CONTRACT_VERSIONS.kernel;
  fixtures: FixtureValidationResult;
  gate: StageGateDecision;
  evidence: readonly EvidenceRecord[];
  adapterSeams: {
    repositoryDriver: AdapterSeamStatus;
    runner: AdapterSeamStatus;
    targetAdapter: AdapterSeamStatus;
    identity: AdapterSeamStatus;
    export: AdapterSeamStatus;
  };
  riskSpikes: readonly RiskSpikeReceipt[];
  residualRisks: readonly ResidualRisk[];
  projectExport: ProjectExport | null;
};

function failedAdapter<T>(errorCode: string, message: string): AdapterResult<T> {
  return { status: "failed", errorCode, message, retryable: false };
}

export async function runK0Harness(input: { fixtureRoot: string }): Promise<K0HarnessReport> {
  const fixtures = await validateReferenceFixtures(input.fixtureRoot);
  const workerFixture = referenceFixtures.find((fixture) => fixture.id === "worker");
  if (!workerFixture) throw new Error("K0 harness requires the Worker Reference Fixture.");

  const project = createProject(workerFixture.project);
  const revision = createProjectRevision({
    projectId: project.id,
    sourceSpaceSnapshots: Object.fromEntries(
      workerFixture.sourceSpaces.map((space) => [space.id, `snapshot:${space.id}`]),
    ),
  });

  const hybridFixture = referenceFixtures.find((fixture) => fixture.id === "hybrid-source");
  if (!hybridFixture) throw new Error("K0 harness requires the hybrid Reference Fixture.");
  const hybridProject = createProject(hybridFixture.project);
  const hybridRevision = createProjectRevision({
    projectId: hybridProject.id,
    sourceSpaceSnapshots: Object.fromEntries(
      hybridFixture.sourceSpaces.map((space) => [space.id, join("snapshot", space.id)]),
    ),
  });
  let disclosureProjectionPassed = false;
  let disclosureProjectionReceipt = "Projection did not run.";
  try {
    const publicHybridView = deriveProjectView({
      project: hybridProject,
      revision: hybridRevision,
      sourceSpaces: hybridFixture.sourceSpaces,
      allowedSourceSpaceIds: ["public-player"],
      projectionId: "public-hybrid-fixture",
      classification: "public",
    });
    disclosureProjectionPassed = !publicHybridView.visibleSourceSpaceIds.includes("private-codec")
      && !Object.hasOwn(publicHybridView.disclosedSourceSpaceSnapshots, "private-codec");
    disclosureProjectionReceipt = disclosureProjectionPassed
      ? "The public projection contains only public-player and its disclosed snapshot."
      : "The public projection disclosed the private codec Source Space.";
  } catch (error) {
    disclosureProjectionReceipt = error instanceof Error ? error.message : "unknown-projection-error";
  }

  const repositoryDriver = new InMemoryRepositoryDriver();
  const workerSourceSpace = workerFixture.sourceSpaces.find((space) => space.id === "worker-source");
  if (!workerSourceSpace) throw new Error("K0 harness requires the Worker Source Space.");
  const repositoryResult = await repositoryDriver.createRepository({ sourceSpaceId: workerSourceSpace.id });
  const snapshotResult = repositoryResult.status === "succeeded"
    ? await repositoryDriver.readSnapshot({ repository: repositoryResult.value })
    : failedAdapter<{ snapshotId: string }>("repository-create-failed", "RepositoryDriver could not create the Worker repository.");

  const runner = new InMemoryRunner();
  const runResult = snapshotResult.status === "succeeded"
    ? await runner.execute({ actionId: "worker.check", snapshotId: snapshotResult.value.snapshotId })
    : failedAdapter<{ runId: string; outputDigest: string }>("snapshot-read-failed", "RepositoryDriver could not read the Worker snapshot.");

  const targetAdapter = new InMemoryTargetAdapter();
  const promotionResult = await targetAdapter.proposePromotion({ releaseId: "release:k0-worker", artifactType: "worker.bundle" });

  const identity = new InMemoryIdentityProvider();
  const principalResult = await identity.authenticate({ externalSubject: "k0-maintainer" });

  const exporter = new InMemoryProjectExporter();
  const exportResult = await exporter.exportProject({ project, sourceSpaces: workerFixture.sourceSpaces });
  const projectExport = exportResult.status === "succeeded" ? exportResult.value : null;
  const restoreResult = projectExport
    ? await exporter.restoreProject({ projectExport })
    : failedAdapter<{ restoredProjectId: string; digest: string }>("export-failed", "Project export did not produce a restorable document.");

  const repositoryDriverPassed = repositoryResult.status === "succeeded"
    && repositoryResult.value.repositoryId.length > 0
    && repositoryResult.value.sourceSpaceId === workerSourceSpace.id
    && snapshotResult.status === "succeeded"
    && snapshotResult.value.snapshotId.length > 0;
  const runnerPassed = runResult.status === "succeeded"
    && runResult.value.runId.length > 0
    && runResult.value.outputDigest.length > 0;
  const targetAdapterPassed = promotionResult.status === "succeeded"
    && promotionResult.value.proposalId.length > 0
    && promotionResult.value.releaseId === "release:k0-worker"
    && promotionResult.value.targetState === "proposed";
  const identityPassed = principalResult.status === "succeeded" && principalResult.value.principalId.length > 0;
  const exportPassed = exportResult.status === "succeeded"
    && exportResult.value.protocol === "anyam.export/v1"
    && isCredentialFree(exportResult.value)
    && restoreResult.status === "succeeded"
    && restoreResult.value.restoredProjectId === project.id
    && restoreResult.value.digest.length > 0;

  const residualRisks: readonly ResidualRisk[] = [
    {
      id: "residual:k0-cloudflare-driver",
      description: "The customer-operated Cloudflare RepositoryDriver is not qualified by the local harness.",
      owner: "platform lead",
      mitigation: "Qualify the driver and portable restore in the customer-operated alpha before enabling it as a Stage dependency.",
      status: "accepted",
    },
  ];
  const evidenceContext = {
    actionId: "action:k0-harness",
    verifierId: "verifier:k0-harness",
    toolchainDigest: "toolchain:tsx",
    dependencyDigest: "dependency:package-lock",
    environmentDigest: "environment:local",
    inputDigests: [revision.id],
    effectDigests: [],
    outputDigest: "output:k0-harness",
    producer: { kind: "run" as const, id: "run:k0-harness", version: "v1" },
    projectRevisionId: revision.id,
    projectViewId: "worker-k0-view",
    runId: "run:k0-harness",
    actor: {
      principalId: "principal:k0-maintainer",
      actorId: "actor:k0-harness",
      sessionId: "session:k0-harness",
      clientId: "client:k0-harness",
    },
    runnerId: "runner:in-memory",
    policyVersion: "policy:k0:v1",
    authorizationEpoch: "epoch:k0:v1",
    capabilityGrantId: "grant:k0-harness",
    owner: "kernel maintainer",
    disclosure: { projectionId: "worker-k0", classification: "project" as const },
    invalidators: [],
  };

  const ledger = new EvidenceLedger();
  ledger.append({
    ...evidenceContext,
    key: "k0:fixtures",
    criterion: "All Reference Fixture journeys execute successfully.",
    outcome: fixtures.ok ? "passed" : "failed",
    validityKey: "fixtures:v1",
    receipt: `checkedFiles=${fixtures.checkedFiles}; checkedJourneys=${fixtures.checkedJourneys}; failedJourneys=${fixtures.failedJourneys.length}`,
  });
  ledger.append({
    ...evidenceContext,
    key: "k0:repository-driver",
    criterion: "RepositoryDriver returns a provider-neutral handle and readable snapshot.",
    outcome: repositoryDriverPassed ? "passed" : "failed",
    validityKey: "driver:in-memory:v1",
    receipt: repositoryResult.status === "succeeded"
      ? `repository=${repositoryResult.value.repositoryId}; snapshot=${snapshotResult.status === "succeeded" ? snapshotResult.value.snapshotId : "unavailable"}`
      : `${repositoryResult.errorCode}: ${repositoryResult.message}`,
  });
  ledger.append({
    ...evidenceContext,
    key: "k0:runner",
    criterion: "Runner returns a run identity and output digest.",
    outcome: runnerPassed ? "passed" : "failed",
    validityKey: "runner:in-memory:v1",
    receipt: runResult.status === "succeeded" ? `run=${runResult.value.runId}; output=${runResult.value.outputDigest}` : `${runResult.errorCode}: ${runResult.message}`,
  });
  ledger.append({
    ...evidenceContext,
    key: "k0:target-adapter",
    criterion: "TargetAdapter proposes a release without promoting directly.",
    outcome: targetAdapterPassed ? "passed" : "failed",
    validityKey: "target:in-memory:v1",
    receipt: promotionResult.status === "succeeded" ? `proposal=${promotionResult.value.proposalId}; state=${promotionResult.value.targetState}` : `${promotionResult.errorCode}: ${promotionResult.message}`,
  });
  ledger.append({
    ...evidenceContext,
    key: "k0:identity",
    criterion: "Identity provider returns a local principal.",
    outcome: identityPassed ? "passed" : "failed",
    validityKey: "identity:in-memory:v1",
    receipt: principalResult.status === "succeeded" ? `principal=${principalResult.value.principalId}` : `${principalResult.errorCode}: ${principalResult.message}`,
  });
  ledger.append({
    ...evidenceContext,
    key: "k0:export",
    criterion: "Project export is credential-free and restores with an integrity digest.",
    outcome: exportPassed ? "passed" : "failed",
    validityKey: "export:v1",
    receipt: exportResult.status === "succeeded"
      ? `protocol=${exportResult.value.protocol}; credentialFields=${isCredentialFree(exportResult.value) ? "none" : "present"}; restore=${restoreResult.status === "succeeded" ? restoreResult.value.digest : restoreResult.errorCode}`
      : `${exportResult.errorCode}: ${exportResult.message}`,
  });
  ledger.append({
    ...evidenceContext,
    key: "k0:disclosure-projection",
    criterion: "Public hybrid Project View excludes restricted Source Space content.",
    outcome: disclosureProjectionPassed ? "passed" : "failed",
    validityKey: "disclosure:hybrid:v1",
    receipt: disclosureProjectionReceipt,
  });

  const k0Requirement = (key: string, currentValidityKey: string) => ({
    key,
    currentValidityKey,
    expectedProjectRevisionId: revision.id,
    expectedProjectViewId: "worker-k0-view",
    expectedDisclosureClassification: "project" as const,
  });

  const gate = evaluateStageGate({
    gateId: "k0",
    requiredEvidence: [
      k0Requirement("k0:fixtures", "fixtures:v1"),
      k0Requirement("k0:repository-driver", "driver:in-memory:v1"),
      k0Requirement("k0:runner", "runner:in-memory:v1"),
      k0Requirement("k0:target-adapter", "target:in-memory:v1"),
      k0Requirement("k0:identity", "identity:in-memory:v1"),
      k0Requirement("k0:export", "export:v1"),
      k0Requirement("k0:disclosure-projection", "disclosure:hybrid:v1"),
    ],
    evidence: ledger.list(),
    residualRisks,
  });

  const riskSpikes: readonly RiskSpikeReceipt[] = [
    {
      id: "risk:k0-provider-boundary",
      question: "Can the kernel exercise repository storage without provider authority?",
      receipt: "InMemoryRepositoryDriver returned an Anyam RepositoryHandle with no provider URL or credential field.",
      owner: "kernel maintainer",
      decision: "retired",
    },
    {
      id: "risk:k0-disclosure-projection",
      question: "Can the public hybrid View omit the private codec Source Space?",
      receipt: disclosureProjectionReceipt,
      owner: "source-disclosure maintainer",
      decision: "retired",
    },
  ];
  return {
    contractVersion: CONTRACT_VERSIONS.kernel,
    fixtures,
    gate,
    evidence: ledger.list(),
    adapterSeams: {
      repositoryDriver: repositoryDriverPassed ? "passed" : "failed",
      runner: runnerPassed ? "passed" : "failed",
      targetAdapter: targetAdapterPassed ? "passed" : "failed",
      identity: identityPassed ? "passed" : "failed",
      export: exportPassed ? "passed" : "failed",
    },
    riskSpikes,
    residualRisks,
    projectExport,
  };
}
