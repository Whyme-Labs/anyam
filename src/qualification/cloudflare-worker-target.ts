import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  type Artifact,
  type Evidence,
  type Release,
} from "../kernel/contracts.ts";
import {
  createWorkerTarget,
  sealVerifiedRelease,
  type ImmutableRelease,
  type WorkerTarget,
} from "../delivery/promotion.ts";
import { createTargetDeploymentProfile } from "../delivery/target-deployment.ts";

export const CLOUDFLARE_WORKER_TARGET_QUALIFICATION_PROJECT_ID = "project:cloudflare-worker-target-qualification";
export const CLOUDFLARE_WORKER_TARGET_QUALIFICATION_TARGET_ID = "target:cloudflare-worker-target-qualification";
const qualificationConfigurationDigest = "sha256:cloudflare-worker-target-qualification-config";

export type WorkerTargetQualificationReleaseInput = {
  id: string;
  fileName: string;
  bytes: Uint8Array;
  createdAt?: string;
};

export type WorkerTargetQualificationRelease = {
  artifact: Artifact;
  evidence: Evidence;
  immutable: ImmutableRelease;
};

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function qualificationTarget(): WorkerTarget {
  return createWorkerTarget({
    target: {
      protocol: CONTRACT_VERSIONS.target,
      id: CLOUDFLARE_WORKER_TARGET_QUALIFICATION_TARGET_ID,
      projectId: CLOUDFLARE_WORKER_TARGET_QUALIFICATION_PROJECT_ID,
      name: "Disposable Cloudflare Worker Target qualification",
      adapterId: "cloudflare.worker",
      acceptedArtifactTypes: ["worker.bundle"],
      requiredEvidenceKeys: [],
      state: "configured",
      deploymentProfile: createTargetDeploymentProfile({
        environment: "staging",
        channel: "alpha",
        audience: "qualification",
        runtimeIdentity: "worker:cloudflare-worker-target-qualification",
        routeIdentities: ["route:cloudflare-worker-target-qualification"],
        bindingIdentities: [],
        dataResourceIdentities: [],
        configurationDigests: [qualificationConfigurationDigest],
        secretUseAliases: [],
        dataClass: "synthetic",
        resourceSharing: "isolated",
      }),
    },
    capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
  });
}

/**
 * Build the disposable provider qualification Release with an explicit local
 * Evidence record. The record proves the exact bytes and input closure used
 * by the provider operation; it does not claim that the provider succeeded.
 */
export function createWorkerTargetQualificationRelease(input: WorkerTargetQualificationReleaseInput): WorkerTargetQualificationRelease {
  const artifactDigest = digest(input.bytes);
  const projectRevisionId = `${CLOUDFLARE_WORKER_TARGET_QUALIFICATION_PROJECT_ID}:revision`;
  const projectViewId = `${CLOUDFLARE_WORKER_TARGET_QUALIFICATION_PROJECT_ID}:view`;
  const artifact: Artifact = {
    protocol: CONTRACT_VERSIONS.artifact,
    id: `artifact:${input.id}`,
    type: "worker.bundle",
    digest: artifactDigest,
    projectRevisionId,
    outputPath: input.fileName,
  };
  const evidence: Evidence = {
    protocol: CONTRACT_VERSIONS.evidence,
    version: "v1",
    id: `evidence:${input.id}`,
    key: "qualification:worker-target-bundle",
    criterion: "The disposable Worker module is digest-bound before provider upload.",
    outcome: "passed",
    validityKey: digest(new TextEncoder().encode(`${artifactDigest}:qualification`)),
    actionId: "action:qualification-worker-bundle",
    verifierId: "verifier:qualification-worker-bundle",
    toolchainDigest: "sha256:cloudflare-worker-target-qualification-toolchain:v1",
    dependencyDigest: "sha256:cloudflare-worker-target-qualification-dependencies:v1",
    environmentDigest: "sha256:cloudflare-worker-target-qualification-environment:v1",
    inputDigests: [artifactDigest],
    effectDigests: [],
    outputDigest: artifactDigest,
    createdAt: input.createdAt ?? new Date().toISOString(),
    producer: { kind: "attestation", id: `attestation:${input.id}`, version: "v1" },
    projectRevisionId,
    projectViewId,
    runId: `run:${input.id}`,
    actor: {
      principalId: "principal:cloudflare-worker-target-qualification",
      actorId: "actor:cloudflare-worker-target-qualification",
      sessionId: "session:cloudflare-worker-target-qualification",
      clientId: "client:cloudflare-worker-target-qualification",
    },
    runnerId: "runner:cloudflare-worker-target-qualification",
    policyVersion: "policy:cloudflare-worker-target-qualification:v1",
    authorizationEpoch: "1",
    capabilityGrantId: "grant:cloudflare-worker-target-qualification",
    disclosure: { projectionId: projectViewId, classification: "project" },
    receipt: `evidence=passed; source=qualification-fixture; artifactDigest=${artifactDigest}; provider=not-observed; credentialMaterialStored=false`,
    invalidators: [],
    owner: "Anyam Cloudflare Worker Target qualification",
    targetId: CLOUDFLARE_WORKER_TARGET_QUALIFICATION_TARGET_ID,
    workspaceId: "workspace:cloudflare-worker-target-qualification",
  };
  const release: Release = {
    protocol: CONTRACT_VERSIONS.release,
    id: `release:${input.id}`,
    projectRevisionId,
    artifactIds: [artifact.id],
    evidenceIds: [evidence.id],
    configurationDigests: [qualificationConfigurationDigest],
    stateAssumptions: ["disposable Worker; no customer data; cleanup is required"],
    policyVersion: "policy:cloudflare-worker-target-qualification:v1",
    status: "ready",
    name: input.id,
  };
  const target = qualificationTarget();
  return {
    artifact,
    evidence,
    immutable: sealVerifiedRelease({
      projectId: CLOUDFLARE_WORKER_TARGET_QUALIFICATION_PROJECT_ID,
      release,
      artifacts: [artifact],
      evidence: [evidence],
      target,
    }),
  };
}

export function createWorkerTargetQualificationTarget(): WorkerTarget {
  return qualificationTarget();
}
