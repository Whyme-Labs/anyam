import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  CONTRACT_VERSIONS,
  type Artifact,
  type Evidence,
  type Release,
  type Target,
} from "../src/kernel/contracts.ts";
import {
  ExternalRunnerCoordinator,
  RunnerError,
  runnerResultMessage,
  runnerResultContext,
  type RunnerResult,
} from "../src/execution/runner.ts";
import type { NormalizedActionInput, NormalizedActionOutput } from "../src/execution/local.ts";
import {
  createReleaseAssetTarget,
  ReleasePublicationCoordinator,
  type PublishedArtifact,
  type ReleaseTargetAdapter,
} from "../src/delivery/release-publication.ts";
import { publishReleaseArtifact } from "../src/delivery/release-publication.ts";
import { sealVerifiedRelease, type DeliveryAdapterResult, type ImmutableRelease } from "../src/delivery/promotion.ts";

const actor = {
  principalId: "principal:runner-test",
  actorId: "actor:runner-test",
  sessionId: "session:runner-test",
  clientId: "client:runner-test",
};

const projectId = "project:cli-tool";
const realmId = "realm:runner-test";

function actionInput(): NormalizedActionInput {
  return {
    action: {
      protocol: CONTRACT_VERSIONS.action,
      id: "action:build-cli",
      moduleId: "module:cli",
      moduleRoot: ".",
      dependencyIds: [],
      command: "build-cli",
      inputGlobs: ["src/**/*.ts"],
      outputPaths: ["dist/cli.tar.gz"],
      network: ["registry.example"],
      resources: { profile: "macos-arm64" },
      contractDigest: "sha256:action-build-cli",
    },
    verifier: {
      protocol: CONTRACT_VERSIONS.verifier,
      id: "verifier:cli-smoke",
      actionId: "action:build-cli",
      disclosure: "full",
      requiredFor: ["release"],
      contractDigest: "sha256:verifier-cli-smoke",
    },
    projectRevisionId: "project-revision:cli:v1",
    projectViewId: "project-view:cli:project",
    sourceSpaceSnapshots: { "source:cli": "snapshot:cli:v1" },
    inputDigests: ["src/main.ts=sha256:source"],
    effectDigests: ["sha256:effect-artifact"],
    dependencyDigest: "sha256:dependencies",
    toolchainDigest: "sha256:toolchain",
    environmentDigest: "sha256:environment",
    policyVersion: "policy:runner:v1",
    authorizationEpoch: "epoch:runner:v1",
    targetId: "target:downloads",
    disclosure: { projectionId: "project-view:cli:project", classification: "project" },
    actor,
    capabilityGrantId: "grant:runner-test",
    runnerId: "runner:unassigned",
  };
}

function outputLocations() {
  return {
    logs: "runs/cli/logs",
    artifacts: "runs/cli/artifacts",
    evidence: "runs/cli/evidence",
  } as const;
}

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey: pair.privateKey, publicKey };
}

function signMessage(privateKey: ReturnType<typeof keyPair>["privateKey"], message: string): string {
  return sign(null, Buffer.from(message), privateKey).toString("base64url");
}

function coordinatorWithRunner(now: () => string) {
  const coordinator = new ExternalRunnerCoordinator({ realmId, projectId, now });
  const keys = keyPair();
  coordinator.enrollRunner({
    id: "runner:macos-builder",
    provider: "customer-runner",
    publicKey: keys.publicKey,
    platform: { operatingSystem: "macos", architecture: "arm64", isolation: "vm" },
    capabilities: ["os:macos", "arch:arm64", "isolation:vm", "toolchain:node"],
    networkDestinations: ["registry.example"],
    secretUse: "brokered",
    canUploadArtifacts: true,
    canUploadEvidence: true,
    approvedBy: actor,
    enrollmentReceipt: "operator-approved=fixture; key-rotation=explicit",
  });
  coordinator.activateRunner("runner:macos-builder", actor);
  return { coordinator, keys };
}

function enqueue(coordinator: ExternalRunnerCoordinator, idempotencyKey = "job:cli:v1", leaseExpiresAt = "2026-08-03T02:00:00.000Z") {
  return coordinator.enqueue({
    idempotencyKey,
    actionInput: actionInput(),
    runnerRequirements: ["os:macos", "arch:arm64", "isolation:vm", "toolchain:node"],
    secretUseAliases: ["registry-token"],
    outputLocations: outputLocations(),
    leaseExpiresAt,
  });
}

function claim(coordinator: ExternalRunnerCoordinator, privateKey: ReturnType<typeof keyPair>["privateKey"], jobId: string) {
  const offer = coordinator.pull("runner:macos-builder");
  assert.ok(offer);
  return coordinator.claim({
    runnerId: "runner:macos-builder",
    jobId,
    attemptId: offer.attempt.id,
    challenge: offer.challenge,
    signature: signMessage(privateKey, `anyam.runner-claim/v1|${offer.challenge}`),
  });
}

function signedResult(lease: ReturnType<typeof claim>, privateKey: ReturnType<typeof keyPair>["privateKey"], result: Omit<RunnerResult, "signature" | "context">): RunnerResult {
  const context = runnerResultContext({ job: lease.job, attempt: lease.attempt });
  return {
    ...result,
    context,
    signature: signMessage(privateKey, runnerResultMessage({
      context,
      status: result.status,
      output: result.output,
      outputs: result.outputs,
      ...(result.recoveryAction ? { recoveryAction: result.recoveryAction } : {}),
    })),
  };
}

function passedEvidence(lease: ReturnType<typeof claim>, artifactId: string): Evidence {
  return {
    protocol: CONTRACT_VERSIONS.evidence,
    version: "v1",
    id: "evidence:cli-smoke",
    key: "action:build-cli:verifier:verifier:cli-smoke",
    criterion: "CLI smoke test passed on the external Runner.",
    outcome: "passed",
    validityKey: "sha256:runner-evidence-validity",
    actionId: "action:build-cli",
    verifierId: "verifier:cli-smoke",
    toolchainDigest: "sha256:toolchain",
    dependencyDigest: "sha256:dependencies",
    environmentDigest: "sha256:environment",
    inputDigests: ["src/main.ts=sha256:source"],
    effectDigests: ["sha256:effect-artifact"],
    outputDigest: "sha256:runner-result",
    createdAt: "2026-08-03T00:30:00.000Z",
    producer: { kind: "run", id: lease.job.runId, version: "v1" },
    projectRevisionId: lease.job.projectRevisionId,
    projectViewId: lease.job.projectViewId,
    runId: lease.job.runId,
    actor,
    runnerId: lease.attempt.runnerId ?? "runner:macos-builder",
    policyVersion: "policy:runner:v1",
    authorizationEpoch: "epoch:runner:v1",
    capabilityGrantId: "grant:runner-test",
    disclosure: { ...lease.job.disclosure },
    receipt: `external-runner=true; artifact=${artifactId}`,
    invalidators: ["project-revision", "runner-profile", "policy"],
    owner: "runner qualification",
    targetId: "target:downloads",
    sourceSpaceSnapshots: { "source:cli": "snapshot:cli:v1" },
    actionContractDigest: "sha256:action-build-cli",
    verifierContractDigest: "sha256:verifier-cli-smoke",
  };
}

test("external pull Runner executes an immutable non-web Action and publishes its typed Artifact through a generic Target", async () => {
  const keys = keyPair();
  // Enroll the key actually used by this test runner, then use it for the pull.
  const runnerCoordinator = new ExternalRunnerCoordinator({ realmId, projectId, now: () => "2026-08-03T00:00:00.000Z" });
  runnerCoordinator.enrollRunner({
    id: "runner:macos-builder",
    provider: "customer-runner",
    publicKey: keys.publicKey,
    platform: { operatingSystem: "macos", architecture: "arm64", isolation: "vm" },
    capabilities: ["os:macos", "arch:arm64", "isolation:vm", "toolchain:node"],
    networkDestinations: ["registry.example"],
    secretUse: "brokered",
    canUploadArtifacts: true,
    canUploadEvidence: true,
    approvedBy: actor,
    enrollmentReceipt: "operator-approved=fixture; key-rotation=explicit",
  });
  runnerCoordinator.activateRunner("runner:macos-builder", actor);
  const freshQueued = enqueue(runnerCoordinator);
  assert.equal(freshQueued.job.state, "queued");
  assert.equal(freshQueued.run.status, "queued");
  assert.equal(freshQueued.attempt.state, "queued");
  const offer = runnerCoordinator.pull("runner:macos-builder");
  assert.ok(offer);
  const lease = runnerCoordinator.claim({
    runnerId: "runner:macos-builder",
    jobId: freshQueued.job.id,
    attemptId: offer.attempt.id,
    challenge: offer.challenge,
    signature: signMessage(keys.privateKey, `anyam.runner-claim/v1|${offer.challenge}`),
  });
  assert.equal(lease.job.state, "running");
  assert.equal(JSON.stringify(lease.job).includes(lease.credential.token), false);
  assert.equal(lease.credential.audience, "runner-job");

  const output: NormalizedActionOutput = {
    status: "succeeded",
    exitCode: 0,
    inputDigests: ["src/main.ts=sha256:source"],
    outputDigests: ["dist/cli.tar.gz=sha256:cli-archive"],
    outputDigest: "sha256:runner-result",
    stdoutDigest: "sha256:stdout",
    stderrDigest: "sha256:stderr",
  };
  const outputs = [
    { kind: "log" as const, location: `runs/cli/logs/${lease.attempt.id}/stdout`, digest: "sha256:stdout", disclosure: { projectionId: "project-view:cli:project", classification: "project" as const }, receipt: "run-scoped-log=true" },
    { kind: "artifact" as const, location: `runs/cli/artifacts/${lease.attempt.id}/cli.tar.gz`, digest: "sha256:cli-archive", disclosure: { projectionId: "project-view:cli:project", classification: "project" as const }, receipt: "run-scoped-artifact=true" },
    { kind: "evidence" as const, location: `runs/cli/evidence/${lease.attempt.id}/smoke.json`, digest: "sha256:smoke-evidence", disclosure: { projectionId: "project-view:cli:project", classification: "project" as const }, receipt: "run-scoped-evidence=true" },
  ];
  const result = signedResult(lease, keys.privateKey, { status: "succeeded", output, outputs });
  const completion = runnerCoordinator.submit({ credential: lease.credential, result });
  assert.equal(completion.job.state, "succeeded");
  assert.equal(completion.attempt.state, "succeeded");
  assert.equal(completion.run.status, "succeeded");
  assert.equal(completion.run.runnerId, "runner:macos-builder");
  assert.deepEqual(completion.run.outputDigests, output.outputDigests);
  assert.equal(completion.run.outputDigest, output.outputDigest);
  assert.equal(completion.run.exitCode, output.exitCode);
  assert.equal(completion.outputs.length, 3);
  assert.equal(runnerCoordinator.listOutputs(completion.attempt.id).every((entry) => entry.runId === completion.run.id && entry.attemptId === completion.attempt.id), true);

  const artifactOutput = completion.outputs.find((entry) => entry.kind === "artifact");
  assert.ok(artifactOutput);
  const artifact: Artifact = {
    protocol: CONTRACT_VERSIONS.artifact,
    id: "artifact:cli-tarball",
    type: "cli.archive",
    digest: artifactOutput.digest,
    projectRevisionId: completion.job.projectRevisionId,
    runId: completion.run.id,
    actionId: completion.job.actionId,
    outputPath: "dist/cli.tar.gz",
    provenanceDigest: completion.resultDigest,
    disclosure: { ...completion.job.disclosure },
  };
  const evidence = passedEvidence(lease, artifact.id);
  const release: Release = {
    protocol: CONTRACT_VERSIONS.release,
    id: "release:cli:v1",
    projectRevisionId: completion.job.projectRevisionId,
    artifactIds: [artifact.id],
    evidenceIds: [evidence.id],
    configurationDigests: ["sha256:manifest"],
    stateAssumptions: ["download-channel-is-append-only"],
    policyVersion: "policy:runner:v1",
    status: "ready",
    name: "cli-v1",
    provenanceDigest: completion.resultDigest,
  };
  const baseTarget: Target = {
    protocol: CONTRACT_VERSIONS.target,
    id: "target:downloads",
    projectId,
    name: "CLI downloads",
    adapterId: "generic.release-assets",
    acceptedArtifactTypes: ["cli.archive"],
    requiredEvidenceKeys: [],
    state: "configured",
  };
  const target = createReleaseAssetTarget({ target: baseTarget });
  const verified = sealVerifiedRelease({ projectId, release, artifacts: [artifact], evidence: [evidence], target });
  const adapter: ReleaseTargetAdapter = {
    protocol: CONTRACT_VERSIONS.targetAdapter,
    id: "generic.release-assets",
    contractDigest: "sha256:generic-target",
    async publish(input) {
      const value: PublishedArtifact = {
        targetId: input.target.id,
        releaseId: input.release.release.id,
        artifactId: input.artifact.id,
        releaseDigest: input.release.releaseDigest,
        artifactDigest: input.artifact.digest,
        providerObjectId: "download:cli-v1",
        receipt: "provider=scripted-download; acceptedTypedArtifact=cli.archive",
      };
      return { status: "succeeded", value, receipt: value.receipt };
    },
  };
  const publication = new ReleasePublicationCoordinator({ projectId, target, adapter, releases: [verified] });
  const published = await publishReleaseArtifact({ coordinator: publication, releaseId: release.id, artifactId: artifact.id, idempotencyKey: "publish:cli:v1", actor });
  assert.equal(published.state, "published");
  assert.equal(publication.getTarget().currentArtifactId, artifact.id);
  assert.equal(publication.getTarget().currentReleaseId, release.id);
});

test("Runner Jobs reject an ineligible profile and preserve input/output scope at the trust boundary", () => {
  const coordinator = new ExternalRunnerCoordinator({ realmId, projectId, now: () => "2026-08-03T00:00:00.000Z" });
  const keys = keyPair();
  coordinator.enrollRunner({
    id: "runner:linux-unqualified",
    provider: "customer-runner",
    publicKey: keys.publicKey,
    platform: { operatingSystem: "linux", architecture: "amd64", isolation: "container" },
    capabilities: ["os:linux", "arch:amd64"],
    networkDestinations: [],
    secretUse: "none",
    canUploadArtifacts: false,
    canUploadEvidence: false,
    approvedBy: actor,
    enrollmentReceipt: "operator-approved=fixture",
  });
  coordinator.activateRunner("runner:linux-unqualified", actor);
  const queued = enqueue(coordinator);
  assert.equal(coordinator.pull("runner:linux-unqualified"), undefined);

  const qualified = keyPair();
  coordinator.enrollRunner({
    id: "runner:macos-qualified",
    provider: "customer-runner",
    publicKey: qualified.publicKey,
    platform: { operatingSystem: "macos", architecture: "arm64", isolation: "vm" },
    capabilities: ["os:macos", "arch:arm64", "isolation:vm", "toolchain:node"],
    networkDestinations: ["registry.example"],
    secretUse: "brokered",
    canUploadArtifacts: true,
    canUploadEvidence: true,
    approvedBy: actor,
    enrollmentReceipt: "operator-approved=fixture",
  });
  coordinator.activateRunner("runner:macos-qualified", actor);
  const offer = coordinator.pull("runner:macos-qualified");
  assert.ok(offer);
  const lease = coordinator.claim({
    runnerId: "runner:macos-qualified",
    jobId: queued.job.id,
    attemptId: offer.attempt.id,
    challenge: offer.challenge,
    signature: signMessage(qualified.privateKey, `anyam.runner-claim/v1|${offer.challenge}`),
  });
  const output: NormalizedActionOutput = {
    status: "succeeded",
    exitCode: 0,
    inputDigests: ["src/main.ts=sha256:tampered"],
    outputDigests: ["dist/cli.tar.gz=sha256:cli-archive"],
    outputDigest: "sha256:result",
    stdoutDigest: "sha256:stdout",
    stderrDigest: "sha256:stderr",
  };
  const invalid = signedResult(lease, qualified.privateKey, { status: "succeeded", output, outputs: [] });
  assert.throws(() => coordinator.submit({ credential: lease.credential, result: invalid }), (error: unknown) => error instanceof RunnerError && error.code === "result-input-mismatch");
  const contextTamper = { ...signedResult(lease, qualified.privateKey, { status: "succeeded", output: { ...output, inputDigests: ["src/main.ts=sha256:source"] }, outputs: [] }), context: { ...invalid.context, policyVersion: "policy:forged" } };
  assert.throws(() => coordinator.submit({ credential: lease.credential, result: contextTamper }), (error: unknown) => error instanceof RunnerError && error.code === "result-input-mismatch");
  const outputScopeViolation = signedResult(lease, qualified.privateKey, {
    status: "succeeded",
    output: { ...output, inputDigests: ["src/main.ts=sha256:source"] },
    outputs: [{ kind: "artifact", location: "runs/other-job/artifacts/cli.tar.gz", digest: "sha256:cli-archive", disclosure: { projectionId: "project-view:cli:project", classification: "project" }, receipt: "wrong-run-scope=true" }],
  });
  assert.throws(() => coordinator.submit({ credential: lease.credential, result: outputScopeViolation }), (error: unknown) => error instanceof RunnerError && error.code === "result-output-scope");
  const traversalViolation = signedResult(lease, qualified.privateKey, {
    status: "succeeded",
    output: { ...output, inputDigests: ["src/main.ts=sha256:source"] },
    outputs: [{ kind: "artifact", location: `runs/cli/artifacts/${lease.attempt.id}/../escape.tar.gz`, digest: "sha256:cli-archive", disclosure: { projectionId: "project-view:cli:project", classification: "project" }, receipt: "path-traversal=true" }],
  });
  assert.throws(() => coordinator.submit({ credential: lease.credential, result: traversalViolation }), (error: unknown) => error instanceof RunnerError && error.code === "result-output-scope");
  assert.equal(coordinator.getJob(queued.job.id)?.state, "running");
});

test("Runner cancellation, provider unavailability, quarantine, and replay remain visible and recoverable", () => {
  const coordinator = new ExternalRunnerCoordinator({ realmId, projectId, now: () => "2026-08-03T00:00:00.000Z" });
  const keys = keyPair();
  coordinator.enrollRunner({
    id: "runner:customer",
    provider: "customer-runner",
    publicKey: keys.publicKey,
    platform: { operatingSystem: "macos", architecture: "arm64", isolation: "vm" },
    capabilities: ["os:macos", "arch:arm64", "isolation:vm", "toolchain:node"],
    networkDestinations: ["registry.example"],
    secretUse: "brokered",
    canUploadArtifacts: true,
    canUploadEvidence: true,
    approvedBy: actor,
    enrollmentReceipt: "operator-approved=fixture",
  });
  coordinator.activateRunner("runner:customer", actor);
  const queued = enqueue(coordinator);
  const offer = coordinator.pull("runner:customer");
  assert.ok(offer);
  const lease = coordinator.claim({ runnerId: "runner:customer", jobId: queued.job.id, attemptId: offer.attempt.id, challenge: offer.challenge, signature: signMessage(keys.privateKey, `anyam.runner-claim/v1|${offer.challenge}`) });
  const requested = coordinator.requestCancellation({ jobId: queued.job.id, actor, reason: "operator detected a compromised workspace" });
  assert.equal(requested.state, "cancel-requested");
  const cancelled = coordinator.finalizeCancellation({ credential: lease.credential, outcome: "unknown", receipt: "cleanup=unproven; provider=unavailable" });
  assert.equal(cancelled.job.state, "quarantined");
  assert.equal(cancelled.run.status, "indeterminate");
  assert.match(cancelled.job.recoveryAction ?? "", /quarantine|retry/i);
  assert.throws(() => coordinator.submit({ credential: lease.credential, result: signedResult(lease, keys.privateKey, { status: "failed", output: { status: "failed", exitCode: 1, inputDigests: queued.job.inputDigests, outputDigests: [], outputDigest: "sha256:failed", stdoutDigest: "sha256:stdout", stderrDigest: "sha256:stderr" }, outputs: [], recoveryAction: "late result" }) }), (error: unknown) => error instanceof RunnerError && error.code === "credential-invalid");
  const retry = coordinator.retry({ jobId: queued.job.id, idempotencyKey: "job:cli:retry", leaseExpiresAt: "2026-08-03T02:00:00.000Z", actor });
  assert.equal(retry.job.state, "queued");
  assert.equal(retry.attempt.state, "queued");
  assert.equal(retry.job.attemptIds.length, 2);

  const available = coordinator.markRunnerUnavailable("runner:customer", actor, "customer network disconnected");
  assert.equal(available.status, "unavailable");
  assert.ok(coordinator.listEvents().some((event) => event.type === "runner.unavailable"));
});

test("expired Runner leases become indeterminate and resume through a fresh Attempt", () => {
  let current = "2026-08-03T00:00:00.000Z";
  const { coordinator, keys } = coordinatorWithRunner(() => current);
  const queued = enqueue(coordinator, "job:expiry", "2026-08-03T00:30:00.000Z");
  const offer = coordinator.pull("runner:macos-builder");
  assert.ok(offer);
  current = "2026-08-03T00:31:00.000Z";
  assert.throws(() => coordinator.claim({ runnerId: "runner:macos-builder", jobId: queued.job.id, attemptId: offer.attempt.id, challenge: offer.challenge, signature: signMessage(keys.privateKey, `anyam.runner-claim/v1|${offer.challenge}`) }), (error: unknown) => error instanceof RunnerError && error.code === "lease-expired");
  assert.equal(coordinator.getJob(queued.job.id)?.state, "expired");
  const retry = coordinator.retry({ jobId: queued.job.id, idempotencyKey: "job:expiry:retry", leaseExpiresAt: "2026-08-03T01:30:00.000Z", actor });
  assert.equal(retry.job.state, "queued");
  assert.equal(retry.attempt.state, "queued");
  assert.equal(retry.job.attemptIds.length, 2);
});
