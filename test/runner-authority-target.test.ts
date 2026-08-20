import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  AUTHORITY_COMMAND_PROTOCOL,
  AuthorityPlaneCoordinator,
  emptyAuthorityPlaneSnapshot,
  type AuthorityCommandName,
  type AuthoritySession,
} from "../src/cloudflare/authority-plane.ts";
import {
  PROMOTION_EXECUTION_PROTOCOL,
  type PromotionExecutionContext,
  type PromotionExecutionResult,
} from "../src/cloudflare/promotion-execution.ts";
import {
  CONTRACT_VERSIONS,
  type ActorRef,
  type Artifact,
  type Evidence,
  type Release,
  type Target,
} from "../src/kernel/contracts.ts";
import {
  ExternalRunnerCoordinator,
  runnerResultMessage,
  runnerResultContext,
  type RunnerResult,
} from "../src/execution/runner.ts";
import type { NormalizedActionInput, NormalizedActionOutput } from "../src/execution/local.ts";
import {
  createReleaseAssetTarget,
  type PublishedArtifact,
  type ReleaseTargetAdapter,
} from "../src/delivery/release-publication.ts";
import { sealVerifiedRelease, type DeliveryAdapterResult, type ImmutableRelease } from "../src/delivery/promotion.ts";

const session: AuthoritySession = {
  realmId: "realm:runner-authority-target",
  principalId: "principal:team-owner",
  actorId: "actor:team-owner",
  sessionId: "session:team-owner",
  clientId: "client:anyam-cli",
  authorizationEpoch: 7,
};

const actor: ActorRef = {
  principalId: session.principalId,
  actorId: session.actorId,
  sessionId: session.sessionId,
  clientId: session.clientId,
};

const projectId = "project:cli-tool";
const sourceSpaceId = "source:cli";
const baseProjectRevisionId = "project-revision:cli:base";
const candidateProjectRevisionId = "project-revision:cli:candidate";
const workspaceId = "workspace:cli:runner";
const changeId = "change:cli:runner";
const intentId = "intent:cli:runner";
const changeRevisionId = "change-revision:cli:runner";

function command(
  coordinator: AuthorityPlaneCoordinator,
  name: AuthorityCommandName,
  idempotencyKey: string,
  payload: Record<string, unknown>,
) {
  return coordinator.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: name, idempotencyKey, payload }, session);
}

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

function actionInput(projectViewId: string): NormalizedActionInput {
  return {
    action: {
      protocol: CONTRACT_VERSIONS.action,
      id: "action:build-cli",
      moduleId: "module:cli",
      moduleRoot: ".",
      dependencyIds: [],
      command: "build-cli",
      inputGlobs: ["src/**/*.ts"],
      outputPaths: ["dist/cli.archive"],
      network: [],
      resources: { profile: "linux-amd64" },
      contractDigest: "sha256:action-build-cli",
    },
    verifier: {
      protocol: CONTRACT_VERSIONS.verifier,
      id: "verifier:cli-smoke",
      actionId: "action:build-cli",
      disclosure: "result-only",
      requiredFor: ["release"],
      contractDigest: "sha256:verifier-cli-smoke",
    },
    projectRevisionId: candidateProjectRevisionId,
    projectViewId,
    sourceSpaceSnapshots: { [sourceSpaceId]: "snapshot:cli:candidate" },
    changeRevisionId,
    workspaceId,
    inputDigests: ["src/main.ts=sha256:source"],
    effectDigests: ["sha256:effect-artifact"],
    dependencyDigest: "sha256:dependencies",
    toolchainDigest: "sha256:toolchain",
    environmentDigest: "sha256:environment",
    policyVersion: "policy:runner-authority-target:v1",
    authorizationEpoch: String(session.authorizationEpoch),
    targetId: "target:downloads",
    disclosure: { projectionId: projectViewId, classification: "project" },
    actor,
    capabilityGrantId: "grant:runner-authority-target",
    runnerId: "runner:unassigned",
  };
}

function signedResult(input: {
  lease: ReturnType<ExternalRunnerCoordinator["claim"]>;
  privateKey: ReturnType<typeof keyPair>["privateKey"];
  result: Omit<RunnerResult, "signature" | "context">;
}): RunnerResult {
  const context = runnerResultContext({ job: input.lease.job, attempt: input.lease.attempt });
  return {
    ...input.result,
    context,
    signature: signMessage(input.privateKey, runnerResultMessage({
      context,
      status: input.result.status,
      output: input.result.output,
      outputs: input.result.outputs,
    })),
  };
}

class ArchiveTargetAdapter implements ReleaseTargetAdapter {
  readonly protocol = CONTRACT_VERSIONS.targetAdapter;
  readonly id = "generic.release-assets";
  readonly contractDigest = "sha256:generic-release-assets:v2";
  private sequence = 0;

  async publish(input: {
    publicationId: string;
    attempt: number;
    release: ImmutableRelease;
    artifact: Artifact;
    target: ReturnType<typeof createReleaseAssetTarget>;
  }): Promise<DeliveryAdapterResult<PublishedArtifact>> {
    const providerObjectId = `download:${++this.sequence}`;
    const value: PublishedArtifact = {
      targetId: input.target.id,
      releaseId: input.release.release.id,
      artifactId: input.artifact.id,
      releaseDigest: input.release.releaseDigest,
      artifactDigest: input.artifact.digest,
      providerObjectId,
      receipt: `provider=fixture-download; operation=publish; object=${providerObjectId}; bytes=not-observed`,
    };
    return { status: "succeeded", value, receipt: value.receipt };
  }
}

function promotionExecutor(adapter: ArchiveTargetAdapter) {
  return {
    async execute(context: Readonly<PromotionExecutionContext>): Promise<PromotionExecutionResult> {
      const release = sealVerifiedRelease({
        projectId: context.project.id,
        release: context.release,
        artifacts: context.artifacts,
        evidence: context.evidence,
        target: context.target,
      });
      const artifact = release.artifacts[0];
      assert.ok(artifact);
      const target = createReleaseAssetTarget({ target: context.target });
      const publication = await adapter.publish({
        publicationId: context.promotion.id,
        attempt: context.promotion.attempt + 1,
        release,
        artifact,
        target,
      });
      assert.equal(publication.status, "succeeded");
      if (publication.status !== "succeeded") throw new Error("fixture Target publication unexpectedly failed");
      assert.equal(publication.value.artifactDigest, artifact.digest);
      const releaseHistory = [...(context.target.releaseHistory ?? []), context.release.id];
      return {
        protocol: PROMOTION_EXECUTION_PROTOCOL,
        status: "succeeded",
        adapterId: context.target.adapterId,
        executionDigest: context.executionDigest,
        promotion: {
          ...context.promotion,
          state: "healthy",
          attempt: context.promotion.attempt + 1,
          providerOperationId: publication.value.providerObjectId,
          receipt: publication.receipt,
        },
        target: {
          id: context.target.id,
          projectId: context.project.id,
          state: "healthy",
          currentReleaseId: context.release.id,
          releaseHistory,
        },
        checkpoint: {
          idempotencyKey: context.executionIdempotencyKey,
          attempt: context.promotion.attempt + 1,
          stage: "complete",
          providerOperationIds: [publication.value.providerObjectId],
          receipt: "checkpoint=generic-target-publication-complete; credentialFree=true",
        },
        receipt: `${publication.receipt}; releaseDigest=${release.releaseDigest}; artifactDigest=${artifact.digest}`,
      };
    },
  };
}

test("external Runner completion composes through Authority into a non-web Target Promotion", async () => {
  const authority = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(session.realmId));
  const project = command(authority, "project.create", "authority:project", {
    projectId,
    name: "CLI tool",
    referenceType: "typescript-cli",
    projectRevisionId: baseProjectRevisionId,
    sourceSpaces: [{ id: sourceSpaceId, name: "CLI source", classification: "public", snapshotId: "snapshot:cli:base" }],
  });
  assert.equal(project.status, "succeeded");
  const workspace = command(authority, "workspace.create", "authority:workspace", {
    projectId,
    projectRevisionId: baseProjectRevisionId,
    workspaceId,
    sourceSpaceIds: [sourceSpaceId],
    mounts: ["source"],
  });
  assert.equal(workspace.status, "succeeded");
  const projectViewId = (workspace.value.view as { id: string }).id;
  const change = command(authority, "change.create", "authority:change", { projectId, changeId, intentId, baseProjectRevisionId, workspaceId });
  assert.equal(change.status, "succeeded");
  const revision = command(authority, "revision.publish", "authority:revision", {
    projectId,
    changeId,
    revisionId: changeRevisionId,
    projectRevisionId: candidateProjectRevisionId,
    projectViewId,
    workspaceId,
    sourceSpaceSnapshots: { [sourceSpaceId]: "snapshot:cli:candidate" },
    declaredEffects: ["source.modify", "artifact.create", "release.publish"],
  });
  assert.equal(revision.status, "succeeded");

  const runner = new ExternalRunnerCoordinator({ realmId: session.realmId, projectId, now: () => "2026-08-13T00:00:00.000Z" });
  const keys = keyPair();
  runner.enrollRunner({
    id: "runner:linux-builder",
    provider: "customer-runner",
    publicKey: keys.publicKey,
    platform: { operatingSystem: "linux", architecture: "amd64", isolation: "container" },
    capabilities: ["os:linux", "arch:amd64", "isolation:container", "toolchain:node"],
    networkDestinations: [],
    secretUse: "none",
    canUploadArtifacts: true,
    canUploadEvidence: true,
    approvedBy: actor,
    enrollmentReceipt: "operator-approved=fixture; provider-boundary=customer-runner",
  });
  runner.activateRunner("runner:linux-builder", actor);
  const queued = runner.enqueue({
    idempotencyKey: "runner:job:cli",
    actionInput: actionInput(projectViewId),
    runnerRequirements: ["os:linux", "arch:amd64", "isolation:container", "toolchain:node"],
    outputLocations: { logs: "runs/cli/logs", artifacts: "runs/cli/artifacts", evidence: "runs/cli/evidence" },
    leaseExpiresAt: "2026-08-13T01:00:00.000Z",
  });
  const offer = runner.pull("runner:linux-builder");
  assert.ok(offer);
  const lease = runner.claim({
    runnerId: "runner:linux-builder",
    jobId: queued.job.id,
    attemptId: offer.attempt.id,
    challenge: offer.challenge,
    signature: signMessage(keys.privateKey, `anyam.runner-claim/v1|${offer.challenge}`),
  });
  const output: NormalizedActionOutput = {
    status: "succeeded",
    exitCode: 0,
    inputDigests: [...queued.job.inputDigests],
    outputDigests: ["dist/cli.archive=sha256:cli-archive"],
    outputDigest: "sha256:cli-archive",
    stdoutDigest: "sha256:stdout",
    stderrDigest: "sha256:stderr",
  };
  const result = signedResult({
    lease,
    privateKey: keys.privateKey,
    result: {
      status: "succeeded",
      output,
      outputs: [
        { kind: "artifact", location: `runs/cli/artifacts/${lease.attempt.id}/cli.archive`, digest: output.outputDigest, disclosure: { projectionId: projectViewId, classification: "project" }, receipt: "artifact=attempt-scoped; bytes=not-observed" },
        { kind: "evidence", location: `runs/cli/evidence/${lease.attempt.id}/smoke.json`, digest: "sha256:evidence", disclosure: { projectionId: projectViewId, classification: "project" }, receipt: "evidence=attempt-scoped; verifier=passed" },
      ],
    },
  });
  const completion = runner.submit({ credential: lease.credential, result });
  assert.equal(completion.run.status, "succeeded");
  assert.equal(completion.attempt.state, "succeeded");
  assert.equal(JSON.stringify(completion).includes(lease.credential.token), false);

  const authorityRunResult = command(authority, "run.record", "authority:run", {
    projectId,
    runId: completion.run.id,
    actionId: completion.run.actionId,
    projectRevisionId: candidateProjectRevisionId,
    projectViewId,
    changeRevisionId,
    workspaceId,
    runnerId: completion.run.runnerId,
    status: completion.run.status,
    inputDigests: completion.run.inputDigests,
    outputDigests: completion.run.outputDigests,
    outputDigest: completion.run.outputDigest,
  });
  assert.equal(authorityRunResult.status, "succeeded");
  const authorityRun = authorityRunResult.value.run as { id: string };
  const evidenceResult = command(authority, "evidence.record", "authority:evidence", {
    projectId,
    evidenceId: "evidence:cli-runner",
    runId: authorityRun.id,
    key: "action:build-cli:verifier:cli-smoke",
    criterion: "CLI archive action and verifier passed on the enrolled external Runner.",
    outcome: "passed",
    validityKey: `${candidateProjectRevisionId}:sha256:action-build-cli:sha256:verifier-cli-smoke`,
    actionId: completion.run.actionId,
    verifierId: "verifier:cli-smoke",
    toolchainDigest: "sha256:toolchain",
    dependencyDigest: "sha256:dependencies",
    environmentDigest: "sha256:environment",
    inputDigests: completion.run.inputDigests,
    effectDigests: ["sha256:effect-artifact"],
    outputDigest: completion.run.outputDigest,
    projectRevisionId: candidateProjectRevisionId,
    projectViewId,
    changeRevisionId,
    runnerId: completion.run.runnerId,
    policyVersion: "policy:runner-authority-target:v1",
    authorizationEpoch: String(session.authorizationEpoch),
    capabilityGrantId: "grant:runner-authority-target",
    disclosure: { projectionId: projectViewId, classification: "project" },
    invalidators: ["project-revision", "action-contract", "verifier-contract"],
    owner: "team-owner",
    targetId: "target:downloads",
    workspaceId,
    receipt: "runner=external; verifier=passed; credentialFree=true",
  });
  assert.equal(evidenceResult.status, "succeeded");
  const evidence = evidenceResult.value.evidence as Evidence;
  const artifactResult = command(authority, "artifact.record", "authority:artifact", {
    projectId,
    artifactId: "artifact:cli-archive",
    type: "cli.archive",
    digest: completion.run.outputDigest,
    projectRevisionId: candidateProjectRevisionId,
    changeRevisionId,
    runId: authorityRun.id,
    actionId: completion.run.actionId,
    outputPath: "dist/cli.archive",
    provenanceDigest: completion.resultDigest,
    disclosure: { projectionId: projectViewId, classification: "project" },
  });
  assert.equal(artifactResult.status, "succeeded");
  const artifact = artifactResult.value.artifact as Artifact;

  const landing = command(authority, "landing.apply", "authority:landing", {
    projectId,
    changeId,
    changeRevisionId,
    projectRevisionId: candidateProjectRevisionId,
    expectedCanonicalProjectRevisionId: baseProjectRevisionId,
  });
  assert.equal(landing.status, "succeeded");
  const landedRevisionId = (landing.value.landing as { projectRevisionId: string }).projectRevisionId;
  assert.equal(landedRevisionId, candidateProjectRevisionId);
  const releaseResult = command(authority, "release.create", "authority:release", {
    projectId,
    releaseId: "release:cli-archive",
    projectRevisionId: landedRevisionId,
    artifactIds: [artifact.id],
    evidenceIds: [evidence.id],
    configurationDigests: ["sha256:cli-config"],
    stateAssumptions: ["download target is append-only"],
    policyVersion: "policy:runner-authority-target:v1",
    changeRevisionId,
    provenanceDigest: completion.resultDigest,
  });
  assert.equal(releaseResult.status, "succeeded");
  const release = releaseResult.value.release as Release;
  const targetResult = command(authority, "target.configure", "authority:target", {
    projectId,
    targetId: "target:downloads",
    name: "CLI downloads",
    adapterId: "generic.release-assets",
    acceptedArtifactTypes: ["cli.archive"],
    requiredEvidenceKeys: [],
  });
  assert.equal(targetResult.status, "succeeded");
  const target = targetResult.value.target as Target;
  const promotionRequest = command(authority, "promotion.request", "authority:promotion", {
    projectId,
    promotionId: "promotion:cli-archive",
    releaseId: release.id,
    targetId: target.id,
    releaseDigest: "declared:release:cli-archive",
  });
  assert.equal(promotionRequest.status, "blocked");
  assert.match(promotionRequest.recoveryAction ?? "", /adapter/i);

  const promoted = await authority.executePromotion({
    promotionId: "promotion:cli-archive",
    executionIdempotencyKey: "execute:cli-archive",
    executor: promotionExecutor(new ArchiveTargetAdapter()),
    session,
  });
  assert.equal(promoted.status, "succeeded", JSON.stringify(promoted));
  const promotedTarget = promoted.value.target as Target;
  assert.equal(promotedTarget.currentReleaseId, release.id);
  assert.deepEqual(promotedTarget.releaseHistory, [release.id]);
  const snapshot = authority.snapshot();
  assert.equal(snapshot.runs[completion.run.id]?.runnerId, completion.run.runnerId);
  assert.equal(snapshot.evidence[evidence.id]?.runId, completion.run.id);
  assert.equal(snapshot.artifacts[artifact.id]?.digest, completion.run.outputDigest);
  assert.equal(snapshot.releases[release.id]?.projectRevisionId, candidateProjectRevisionId);
  assert.equal(snapshot.targets[target.id]?.currentReleaseId, release.id);
  const promotedReceipt = JSON.stringify(promoted);
  assert.equal(promotedReceipt.includes(lease.credential.token), false);
  assert.equal(promotedReceipt.includes("Bearer "), false);
  assert.match(promotedReceipt, /credentialFree=true/);
});
