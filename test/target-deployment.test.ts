import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTargetCanPromote,
  assertTargetResourceIsolation,
  createTargetDeploymentProfile,
  targetDeploymentContractDigest,
  TargetDeploymentProfileError,
} from "../src/delivery/target-deployment.ts";
import { CONTRACT_VERSIONS, type Target } from "../src/kernel/contracts.ts";

function target(id: string, deploymentProfile: Target["deploymentProfile"], projectId = "project:target-profile"): Target {
  const base: Target = {
    protocol: CONTRACT_VERSIONS.target,
    id,
    projectId,
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

test("Target Promotion requires an explicit complete profile", () => {
  assert.throws(
    () => assertTargetCanPromote(target("legacy", undefined)),
    (error: unknown) => {
      assert.ok(error instanceof TargetDeploymentProfileError);
      assert.equal(error.code, "incomplete-profile");
      assert.match(error.receipt, /deploymentProfile=missing/);
      return true;
    },
  );
  assert.throws(
    () => assertTargetCanPromote(target("incomplete", profile({ configurationDigests: [] }))),
    (error: unknown) => {
      assert.ok(error instanceof TargetDeploymentProfileError);
      assert.equal(error.code, "incomplete-profile");
      assert.match(error.receipt, /configurationDigests=0/);
      return true;
    },
  );
  assert.throws(
    () => assertTargetCanPromote(target("unknown-environment", profile({ environment: "custom" }))),
    (error: unknown) => {
      assert.ok(error instanceof TargetDeploymentProfileError);
      assert.equal(error.code, "incomplete-profile");
      assert.match(error.receipt, /risk=unknown/);
      return true;
    },
  );
  assert.throws(
    () => assertTargetCanPromote(target("unknown-data", profile({ dataClass: "custom" }))),
    (error: unknown) => {
      assert.ok(error instanceof TargetDeploymentProfileError);
      assert.equal(error.code, "incomplete-profile");
      assert.match(error.receipt, /risk=unknown/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertTargetCanPromote(target("complete", profile())));
});

test("resource overlap requires exact owner approval and is Realm-wide", () => {
  const existing = target("staging-a", profile({ environment: "staging", dataClass: "isolated", resourceSharing: "owner-approved", sharingPolicyDigest: "sha256:policy-a", runtimeIdentity: "worker:shared", bindingIdentities: ["d1:shared"] }), "project:a");
  const mismatched = target("staging-b", profile({ environment: "staging", dataClass: "isolated", resourceSharing: "owner-approved", sharingPolicyDigest: "sha256:policy-b", runtimeIdentity: "worker:shared", bindingIdentities: ["d1:shared"] }), "project:b");
  assert.throws(
    () => assertTargetResourceIsolation({ existing: [existing], candidate: mismatched }),
    (error: unknown) => {
      assert.ok(error instanceof TargetDeploymentProfileError);
      assert.equal(error.code, "resource-conflict");
      assert.match(error.receipt, /sharingPolicyMatch=false/);
      return true;
    },
  );

  const approved = target("staging-c", profile({ environment: "staging", dataClass: "isolated", resourceSharing: "owner-approved", sharingPolicyDigest: "sha256:policy-a", runtimeIdentity: "worker:shared", bindingIdentities: ["d1:shared"] }), "project:c");
  assert.doesNotThrow(() => assertTargetResourceIsolation({ existing: [existing], candidate: approved }));

  const isolated = target("staging-d", profile({ environment: "staging", dataClass: "isolated", runtimeIdentity: "worker:shared", bindingIdentities: ["d1:shared"] }), "project:d");
  assert.throws(
    () => assertTargetResourceIsolation({ existing: [isolated], candidate: target("staging-e", profile({ environment: "staging", dataClass: "isolated", runtimeIdentity: "worker:shared", bindingIdentities: ["d1:shared"] }), "project:e") }),
    (error: unknown) => {
      assert.ok(error instanceof TargetDeploymentProfileError);
      assert.equal(error.code, "resource-conflict");
      return true;
    },
  );
});
