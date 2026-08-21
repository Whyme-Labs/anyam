import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  AUTHORITY_COMMAND_PROTOCOL,
  AuthorityPlaneCoordinator,
  emptyAuthorityPlaneSnapshot,
  type AuthoritySession,
} from "../src/cloudflare/authority-plane.ts";
import {
  CONTRACT_VERSIONS,
  type ActorRef,
} from "../src/kernel/contracts.ts";
import {
  ExternalRunnerCoordinator,
  runnerResultContext,
  runnerResultMessage,
  type RunnerResult,
} from "../src/execution/runner.ts";
import type { NormalizedActionInput, NormalizedActionOutput } from "../src/execution/local.ts";

const realmId = "realm:runner-authority-completion";
const projectId = "project:runner-authority-completion";
const sourceSpaceId = "source:runner-authority-completion";
const baseRevisionId = "project-revision:runner-authority:base";
const candidateRevisionId = "project-revision:runner-authority:candidate";
const workspaceId = "workspace:runner-authority";
const changeId = "change:runner-authority";
const changeRevisionId = "change-revision:runner-authority";
const projectViewId = "project-view:runner-authority";

const ownerSession: AuthoritySession = {
  realmId,
  principalId: "principal:owner",
  actorId: "actor:owner",
  sessionId: "session:owner",
  clientId: "client:anyam-cli",
  authorizationEpoch: 4,
};

const runnerSession: AuthoritySession = {
  realmId,
  principalId: "principal:runner-service",
  actorId: "actor:runner-service",
  sessionId: "session:runner-service",
  clientId: "anyam-runner-coordinator",
  authorizationEpoch: 4,
  kind: "runner",
};

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function signMessage(privateKey: ReturnType<typeof keyPair>["privateKey"], message: string): string {
  return sign(null, Buffer.from(message), privateKey).toString("base64url");
}

function actionInput(): NormalizedActionInput {
  const actor: ActorRef = {
    principalId: ownerSession.principalId,
    actorId: ownerSession.actorId,
    sessionId: ownerSession.sessionId,
    clientId: ownerSession.clientId,
  };
  return {
    action: {
      protocol: CONTRACT_VERSIONS.action,
      id: "action:runner-authority",
      moduleId: "module:runner-authority",
      moduleRoot: ".",
      dependencyIds: [],
      command: "npm test",
      inputGlobs: ["src/**/*.ts"],
      outputPaths: ["dist/result.txt"],
      network: [],
      resources: { profile: "linux-amd64" },
      contractDigest: "sha256:action-runner-authority",
    },
    verifier: {
      protocol: CONTRACT_VERSIONS.verifier,
      id: "verifier:runner-authority",
      actionId: "action:runner-authority",
      disclosure: "full",
      requiredFor: ["release"],
      contractDigest: "sha256:verifier-runner-authority",
    },
    projectRevisionId: candidateRevisionId,
    projectViewId,
    changeRevisionId,
    workspaceId,
    sourceSpaceSnapshots: { [sourceSpaceId]: "snapshot:runner-authority:candidate" },
    inputDigests: ["src/main.ts=sha256:source"],
    effectDigests: ["sha256:effect:artifact"],
    dependencyDigest: "sha256:dependencies",
    toolchainDigest: "sha256:toolchain",
    environmentDigest: "sha256:environment",
    policyVersion: "policy:runner-authority:v1",
    authorizationEpoch: String(ownerSession.authorizationEpoch),
    targetId: "target:runner-authority",
    disclosure: { projectionId: projectViewId, classification: "project" },
    actor,
    capabilityGrantId: "grant:runner-authority",
    runnerId: "runner:unassigned",
  };
}

function authorityCommand(authority: AuthorityPlaneCoordinator, command: "project.create" | "workspace.create" | "change.create" | "revision.publish" | "run.request", idempotencyKey: string, payload: Record<string, unknown>) {
  return authority.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command, idempotencyKey, payload }, ownerSession);
}

function signedResult(lease: ReturnType<ExternalRunnerCoordinator["claim"]>, privateKey: ReturnType<typeof keyPair>["privateKey"], output: NormalizedActionOutput): RunnerResult {
  const context = runnerResultContext({ job: lease.job, attempt: lease.attempt });
  const result: Omit<RunnerResult, "signature" | "context"> = {
    status: "succeeded",
    output,
    outputs: [{ kind: "artifact", location: `runs/result/artifacts/${lease.attempt.id}/result.txt`, digest: output.outputDigest, disclosure: { projectionId: projectViewId, classification: "project" }, receipt: "readBackDigest=verified; bytes=not-observed" }],
  };
  return {
    ...result,
    context,
    signature: signMessage(privateKey, runnerResultMessage({ context, ...result })),
  };
}

function setup() {
  const authority = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(realmId));
  authorityCommand(authority, "project.create", "authority:project", {
    projectId,
    projectRevisionId: baseRevisionId,
    name: "Runner Authority completion",
    referenceType: "typescript-cli",
    sourceSpaces: [{ id: sourceSpaceId, name: "source", classification: "public", snapshotId: "snapshot:runner-authority:base" }],
  });
  const workspace = authorityCommand(authority, "workspace.create", "authority:workspace", { projectId, workspaceId, projectRevisionId: baseRevisionId, sourceSpaceIds: [sourceSpaceId], mounts: ["source"] });
  const actualProjectViewId = (workspace.value.view as { id: string }).id;
  const change = authorityCommand(authority, "change.create", "authority:change", { projectId, changeId, intentId: "intent:runner-authority", baseProjectRevisionId: baseRevisionId, workspaceId });
  assert.equal(change.status, "succeeded");
  const revision = authorityCommand(authority, "revision.publish", "authority:revision", { projectId, changeId, revisionId: changeRevisionId, projectRevisionId: candidateRevisionId, projectViewId: actualProjectViewId, workspaceId, sourceSpaceSnapshots: { [sourceSpaceId]: "snapshot:runner-authority:candidate" }, declaredEffects: ["artifact.create"] });
  assert.equal(revision.status, "succeeded");
  const input = actionInput();
  input.projectViewId = actualProjectViewId;
  input.disclosure = { projectionId: actualProjectViewId, classification: "project" };
  const runRequest = authorityCommand(authority, "run.request", "authority:run-request", {
    projectId,
    runId: "run:runner-authority",
    actionId: input.action.id,
    projectRevisionId: candidateRevisionId,
    projectViewId: actualProjectViewId,
    changeRevisionId,
    workspaceId,
    verifierId: input.verifier?.id,
    actionContractDigest: input.action.contractDigest,
    verifierContractDigest: input.verifier?.contractDigest,
    inputDigests: input.inputDigests,
    outputDigests: [],
    effectDigests: input.effectDigests,
    dependencyDigest: input.dependencyDigest,
    toolchainDigest: input.toolchainDigest,
    environmentDigest: input.environmentDigest,
    targetId: input.targetId,
    policyVersion: input.policyVersion,
    capabilityGrantId: input.capabilityGrantId,
  });
  assert.equal(runRequest.status, "succeeded");
  return { authority, input, runId: (runRequest.value.run as { id: string }).id, projectViewId: actualProjectViewId };
}

function makeRunner(input: NormalizedActionInput, runId: string) {
  const keys = keyPair();
  const runner = new ExternalRunnerCoordinator({ realmId, projectId, now: () => "2026-08-21T01:00:00.000Z" });
  const profile = runner.enrollRunner({ id: "runner:authority", provider: "internal-runner", publicKey: keys.publicKey, platform: { operatingSystem: "linux", architecture: "amd64", isolation: "container" }, capabilities: ["os:linux", "arch:amd64", "isolation:container", "toolchain:node"], networkDestinations: [], networkEnforcement: "deny-all", networkBoundaryReceipt: "qualification=fixture; networkEnforcement=deny-all", secretUse: "none", canUploadArtifacts: true, canUploadEvidence: true, approvedBy: input.actor, enrollmentReceipt: "enrollment=fixture; authority-sync=required" });
  runner.activateRunner(profile.id, input.actor);
  const queued = runner.enqueue({ runId, idempotencyKey: "runner:authority:job", actionInput: input, runnerRequirements: ["os:linux", "arch:amd64", "isolation:container", "toolchain:node"], outputLocations: { logs: "runs/result/logs", artifacts: "runs/result/artifacts", evidence: "runs/result/evidence" }, leaseExpiresAt: "2026-08-21T02:00:00.000Z" });
  const offer = runner.pull(profile.id);
  assert.ok(offer);
  const lease = runner.claim({ runnerId: profile.id, jobId: queued.job.id, attemptId: offer.attempt.id, challenge: offer.challenge, signature: signMessage(keys.privateKey, `anyam.runner-claim/v1|${offer.challenge}`) });
  const output: NormalizedActionOutput = { status: "succeeded", exitCode: 0, inputDigests: [...queued.job.inputDigests], outputDigests: ["dist/result.txt=sha256:artifact"], outputDigest: "sha256:artifact", stdoutDigest: "sha256:stdout", stderrDigest: "sha256:stderr" };
  return { runner, keys, profile: runner.getRunner(profile.id)!, lease, result: signedResult(lease, keys.privateKey, output) };
}

test("Authority consumes one signed Runner completion atomically and idempotently", async () => {
  const fixture = setup();
  const runnerFixture = makeRunner(fixture.input, fixture.runId);
  fixture.authority.registerRunnerProfile(runnerFixture.profile, runnerSession);
  const completion = runnerFixture.runner.submit({ credential: runnerFixture.lease.credential, result: runnerFixture.result });
  const command = { protocol: AUTHORITY_COMMAND_PROTOCOL, command: "runner.complete" as const, idempotencyKey: "authority:runner-complete", payload: { completion } };
  const accepted = await fixture.authority.completeRunner(command, runnerSession);
  assert.equal(accepted.status, "succeeded");
  assert.equal((accepted.value.run as { status: string }).status, "succeeded");
  assert.equal((accepted.value.evidence as { outcome: string }).outcome, "passed");
  assert.equal((accepted.value.artifacts as unknown[]).length, 1);
  assert.equal((accepted.value.attempt as { state: string }).state, "succeeded");
  assert.equal((accepted.receipt.match(/credentialState=closed/g) ?? []).length, 1);
  assert.equal(fixture.authority.snapshot().version, 7);
  const replay = await fixture.authority.completeRunner(command, runnerSession);
  assert.deepEqual(replay, accepted);
  assert.equal(fixture.authority.snapshot().version, 7);
});

test("Authority rejects a signed completion through a human session and leaves queued state untouched", async () => {
  const fixture = setup();
  const runnerFixture = makeRunner(fixture.input, fixture.runId);
  fixture.authority.registerRunnerProfile(runnerFixture.profile, runnerSession);
  const completion = runnerFixture.runner.submit({ credential: runnerFixture.lease.credential, result: runnerFixture.result });
  await assert.rejects(() => fixture.authority.completeRunner({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "runner.complete", idempotencyKey: "authority:human-runner-complete", payload: { completion } }, ownerSession), /Only the internal Runner coordinator/);
  assert.equal(fixture.authority.snapshot().runs[fixture.runId]?.status, "queued");
});

test("Authority rejects signature tampering, context drift, and output mismatch without partial Evidence or Artifact", async () => {
  for (const mode of ["signature", "context", "output"] as const) {
    const fixture = setup();
    const runnerFixture = makeRunner(fixture.input, fixture.runId);
    fixture.authority.registerRunnerProfile(runnerFixture.profile, runnerSession);
    const completion = runnerFixture.runner.submit({ credential: runnerFixture.lease.credential, result: runnerFixture.result });
    if (mode === "signature") completion.result.signature = `${completion.result.signature}tampered`;
    if (mode === "context") completion.result.context = { ...completion.result.context, projectRevisionId: "project-revision:drift" };
    if (mode === "output") completion.outputs = [];
    await assert.rejects(() => fixture.authority.completeRunner({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "runner.complete", idempotencyKey: `authority:runner-invalid:${mode}`, payload: { completion } }, runnerSession));
    const snapshot = fixture.authority.snapshot();
    assert.equal(snapshot.runs[fixture.runId]?.status, "queued");
    assert.equal(Object.keys(snapshot.evidence).length, 0);
    assert.equal(Object.keys(snapshot.artifacts).length, 0);
  }
});
