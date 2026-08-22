import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTargetResourceIsolation,
  createTargetDeploymentProfile,
  targetDeploymentContractDigest,
  TargetDeploymentProfileError,
} from "../src/delivery/target-deployment.ts";
import { CONTRACT_VERSIONS, type Target } from "../src/kernel/contracts.ts";

function target(id: string, deploymentProfile: Target["deploymentProfile"]): Target {
  const base: Target = {
    protocol: CONTRACT_VERSIONS.target,
    id,
    projectId: "project:target-profile",
    name: id,
    adapterId: "cloudflare.worker",
    acceptedArtifactTypes: ["worker.bundle"],
    requiredEvidenceKeys: [],
    state: "configured",
  };
  return deploymentProfile === undefined ? base : { ...base, deploymentProfile };
}

function profile(input: Partial<Parameters<typeof createTargetDeploymentProfile>[0]> = {}) {
  return createTargetDeploymentProfile({
    environment: "production",
    channel: "stable",
    audience: "stable-users",
    runtimeIdentity: "worker:production",
    routeIdentities: ["app.example.com"],
    bindingIdentities: ["d1:production"],
    dataResourceIdentities: ["r2:production"],
    configurationDigests: ["sha256:config-production"],
    secretUseAliases: ["payments-production"],
    dataClass: "production",
    resourceSharing: "isolated",
    ...input,
  });
}

test("Target Deployment Profile is digest-bound and credential-free", () => {
  const deploymentProfile = profile();
  assert.equal(deploymentProfile.protocol, "anyam.target-deployment/v1");
  assert.match(deploymentProfile.profileDigest, /^sha256:/);
  assert.equal(JSON.stringify(deploymentProfile).includes("token="), false);
  assert.equal(JSON.stringify(deploymentProfile).includes("secret="), false);
  assert.throws(
    () => createTargetDeploymentProfile({ ...profile(), runtimeIdentity: "Bearer leaked-value" }),
    (error: unknown) => {
      assert.ok(error instanceof TargetDeploymentProfileError);
      assert.match(error.receipt, /credential-material=rejected/);
      return true;
    },
  );
  assert.throws(
    () => createTargetDeploymentProfile({ ...deploymentProfile, profileDigest: "sha256:wrong" }),
    (error: unknown) => {
      assert.ok(error instanceof TargetDeploymentProfileError);
      assert.equal(error.code, "invalid-profile");
      assert.match(error.receipt, /digest=invalid/);
      return true;
    },
  );
  assert.notEqual(
    targetDeploymentContractDigest(target("production", deploymentProfile)),
    targetDeploymentContractDigest(target("staging", profile({ environment: "staging", channel: "beta", dataClass: "production-shaped", runtimeIdentity: "worker:staging", routeIdentities: ["staging.example.com"], bindingIdentities: ["d1:staging"], dataResourceIdentities: ["r2:staging"], configurationDigests: ["sha256:config-staging"], secretUseAliases: ["payments-staging"] }))),
  );
});

test("production-sensitive Target resources cannot be shared without matching owner approval", () => {
  const production = target("production", profile());
  const staging = target("staging", profile({ environment: "staging", channel: "beta", dataClass: "production-shaped", runtimeIdentity: "worker:staging", routeIdentities: ["staging.example.com"], bindingIdentities: ["d1:production"], dataResourceIdentities: ["r2:staging"], configurationDigests: ["sha256:config-staging"], secretUseAliases: ["payments-staging"] }));
  assert.throws(
    () => assertTargetResourceIsolation({ existing: [production], candidate: staging }),
    (error: unknown) => {
      assert.ok(error instanceof TargetDeploymentProfileError);
      assert.equal(error.code, "resource-conflict");
      assert.match(error.receipt, /overlap=binding:d1:production/);
      return true;
    },
  );

  const approvedProduction = target("production-approved", profile({ resourceSharing: "owner-approved", sharingPolicyDigest: "sha256:sharing-policy" }));
  const approvedStaging = target("staging-approved", profile({ environment: "staging", channel: "beta", dataClass: "production-shaped", resourceSharing: "owner-approved", sharingPolicyDigest: "sha256:sharing-policy", runtimeIdentity: "worker:staging-approved", routeIdentities: ["staging.example.com"], bindingIdentities: ["d1:production"], dataResourceIdentities: ["r2:staging"], configurationDigests: ["sha256:config-staging-approved"], secretUseAliases: ["payments-staging"] }));
  assert.doesNotThrow(() => assertTargetResourceIsolation({ existing: [approvedProduction], candidate: approvedStaging }));
});

test("owner-approved sharing requires a policy digest", () => {
  assert.throws(
    () => createTargetDeploymentProfile({ ...profile(), resourceSharing: "owner-approved" }),
    (error: unknown) => {
      assert.ok(error instanceof TargetDeploymentProfileError);
      assert.equal(error.code, "invalid-profile");
      assert.match(error.receipt, /sharingPolicyDigest=missing/);
      return true;
    },
  );
});
