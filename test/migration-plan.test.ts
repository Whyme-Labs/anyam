import assert from "node:assert/strict";
import test from "node:test";

import { PromotionError, sealVerifiedRelease } from "../src/delivery/promotion.ts";
import { createMigrationPlan, MigrationPlanError } from "../src/delivery/migration-plan.ts";
import { createTargetDeploymentProfile } from "../src/delivery/target-deployment.ts";
import { CONTRACT_VERSIONS, type Artifact, type Evidence, type Release, type Target } from "../src/kernel/contracts.ts";

const artifact: Artifact = { protocol: CONTRACT_VERSIONS.artifact, id: "artifact:migration", type: "worker.bundle", digest: "sha256:worker", projectRevisionId: "project-revision:migration" };
const evidence: Evidence = {
  protocol: CONTRACT_VERSIONS.evidence,
  version: "v1",
  id: "evidence:migration",
  key: "migration.compatibility",
  criterion: "migration compatibility",
  outcome: "passed",
  validityKey: "sha256:migration-validity",
  actionId: "action:migration-check",
  verifierId: "verifier:migration-check",
  toolchainDigest: "sha256:toolchain",
  dependencyDigest: "sha256:dependencies",
  environmentDigest: "sha256:environment",
  inputDigests: ["migration.sql=sha256:migration"],
  effectDigests: [],
  outputDigest: "sha256:migration-report",
  createdAt: "2026-08-23T00:00:00.000Z",
  producer: { kind: "run", id: "run:migration", version: "v1" },
  projectRevisionId: artifact.projectRevisionId,
  projectViewId: "project-view:migration",
  runId: "run:migration",
  actor: { principalId: "principal:migration", actorId: "actor:migration", sessionId: "session:migration", clientId: "client:migration" },
  runnerId: "runner:migration",
  policyVersion: "policy:migration",
  authorizationEpoch: "1",
  capabilityGrantId: "grant:migration",
  disclosure: { projectionId: "project-view:migration", classification: "project" },
  receipt: "migration=verified; credentialMaterialStored=false",
  invalidators: [],
  owner: "migration-test",
  targetId: "target:production",
};

const productionTarget: Target = {
  protocol: CONTRACT_VERSIONS.target,
  id: "target:production",
  projectId: "project:migration",
  name: "Production",
  adapterId: "cloudflare.worker",
  acceptedArtifactTypes: ["worker.bundle"],
  requiredEvidenceKeys: [],
  state: "configured",
  deploymentProfile: createTargetDeploymentProfile({ environment: "production", channel: "stable", audience: "stable", runtimeIdentity: "worker:production", routeIdentities: ["app.example.com"], bindingIdentities: [], dataResourceIdentities: [], configurationDigests: ["sha256:target-config"], secretUseAliases: [], dataClass: "production", resourceSharing: "isolated" }),
};

function release(migrationPlan: Release["migrationPlan"]): Release {
  return {
    protocol: CONTRACT_VERSIONS.release,
    id: "release:migration",
    projectRevisionId: artifact.projectRevisionId,
    artifactIds: [artifact.id],
    evidenceIds: [evidence.id],
    configurationDigests: ["sha256:build-definition"],
    stateAssumptions: [],
    policyVersion: "policy:migration",
    status: "ready",
    ...(migrationPlan === undefined ? {} : { migrationPlan }),
  };
}

test("production sealing blocks unknown migration compatibility", () => {
  const plan = createMigrationPlan({ strategy: "custom", afterSchemaDigest: "sha256:schema-after", compatibility: "unknown", rollback: "safe" });
  assert.throws(
    () => sealVerifiedRelease({ projectId: "project:migration", release: release(plan), artifacts: [artifact], evidence: [evidence], target: productionTarget }),
    (error: unknown) => {
      assert.ok(error instanceof MigrationPlanError);
      assert.equal(error.code, "incompatible");
      assert.match(error.receipt, /production-blocked/);
      return true;
    },
  );
});

test("expand-contract migration with application-only rollback remains explicit and promotable", () => {
  const plan = createMigrationPlan({ strategy: "expand-contract", beforeSchemaDigest: "sha256:schema-before", afterSchemaDigest: "sha256:schema-after", compatibility: "bidirectional", rollback: "application-only", migrationArtifactIds: [artifact.id], requiredEvidenceKeys: [evidence.key] });
  const sealed = sealVerifiedRelease({ projectId: "project:migration", release: release(plan), artifacts: [artifact], evidence: [evidence], target: productionTarget });
  assert.equal(sealed.release.migrationPlan?.strategy, "expand-contract");
  assert.equal(sealed.release.migrationPlan?.rollback, "application-only");
  assert.match(sealed.release.migrationPlan?.planDigest ?? "", /^sha256:/);
  assert.match(sealed.release.inputSet?.inputClosureDigest ?? "", /^sha256:/);
});

test("migration Artifact and Evidence references must be declared by the Release", () => {
  const missingArtifactPlan = createMigrationPlan({ strategy: "manual", compatibility: "forward-only", rollback: "manual-data-action", migrationArtifactIds: ["artifact:not-declared"] });
  assert.throws(
    () => sealVerifiedRelease({ projectId: "project:migration", release: release(missingArtifactPlan), artifacts: [artifact], evidence: [evidence], target: productionTarget }),
    (error: unknown) => {
      assert.ok(error instanceof PromotionError);
      assert.equal(error.code, "invalid-release");
      assert.match(error.recoveryAction, /migration Artifact/);
      return true;
    },
  );

  const missingEvidencePlan = createMigrationPlan({ strategy: "manual", compatibility: "forward-only", rollback: "manual-data-action", migrationArtifactIds: [artifact.id], requiredEvidenceKeys: ["migration.not-declared"] });
  assert.throws(
    () => sealVerifiedRelease({ projectId: "project:migration", release: release(missingEvidencePlan), artifacts: [artifact], evidence: [evidence], target: productionTarget }),
    (error: unknown) => {
      assert.ok(error instanceof PromotionError);
      assert.equal(error.code, "invalid-release");
      assert.match(error.recoveryAction, /migration Evidence/);
      return true;
    },
  );
});
