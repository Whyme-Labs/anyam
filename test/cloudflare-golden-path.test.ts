import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createCloudflareWorkerReleaseManifest, type WorkerReleaseManifest } from "../src/cloudflare/worker-release-manifest.ts";
import { createMigrationPlan } from "../src/delivery/migration-plan.ts";
import { createTargetDeploymentProfile } from "../src/delivery/target-deployment.ts";
import { createWorkerTarget, sealVerifiedRelease, type ImmutableRelease, type WorkerTarget } from "../src/delivery/promotion.ts";
import { CONTRACT_VERSIONS } from "../src/kernel/contracts.ts";
import { normalizeProjectManifest, runLocalRelease, targetFromManifest, type LocalExecutionContext } from "../src/execution/local.ts";

const fixtureRoot = fileURLToPath(new URL("../fixtures/worker-golden/", import.meta.url));
const actor = { principalId: "principal:golden", actorId: "actor:golden", sessionId: "session:golden", clientId: "client:golden" };

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function context(directory: string, targetId: string): LocalExecutionContext {
  return {
    directory,
    projectRevisionId: "project-revision:worker-golden:v1",
    projectViewId: "project-view:worker-golden:project",
    sourceSpaceSnapshots: { "worker-golden-source": "snapshot:worker-golden:v1" },
    actor,
    runnerId: "runner:golden-local",
    policyVersion: "policy:worker-golden:v1",
    authorizationEpoch: "epoch:worker-golden:v1",
    capabilityGrantId: "grant:worker-golden",
    dependencyDigest: "sha256:worker-golden-dependencies:v1",
    toolchainDigest: "sha256:worker-golden-toolchain:v1",
    environmentDigest: "sha256:worker-golden-environment:v1",
    disclosure: { projectionId: "project-view:worker-golden:project", classification: "project" },
    owner: "Anyam golden path test",
    changeRevisionId: "change-revision:worker-golden:v1",
    workspaceId: "workspace:worker-golden:v1",
    targetId,
    declaredEffects: ["artifact.create", "migration.apply", "target.promote"],
  };
}

function target(input: { base: ReturnType<typeof targetFromManifest>; id: string; environment: "staging" | "production" }): WorkerTarget {
  const production = input.environment === "production";
  return createWorkerTarget({
    target: {
      ...input.base,
      id: input.id,
      deploymentProfile: createTargetDeploymentProfile({
        environment: input.environment,
        channel: production ? "stable" : "beta",
        audience: input.id,
        runtimeIdentity: `worker:${input.id}`,
        routeIdentities: [`route:${input.id}`],
        bindingIdentities: [`binding:${input.id}`],
        dataResourceIdentities: [`d1:${input.id}`, `r2:${input.id}`, `kv:${input.id}`, `queue:${input.id}`],
        configurationDigests: [digest(`config:${input.id}`)],
        secretUseAliases: [`secret-use:${input.id}`],
        dataClass: production ? "production" : "isolated",
        resourceSharing: "isolated",
      }),
    },
    capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
  });
}

function bindings(environment: "staging" | "production"): readonly { name: string; kind: string; resourceIdentity: string; providerFields: Readonly<Record<string, string>> }[] {
  const suffix = environment;
  return [
    { name: "DB", kind: "d1", resourceIdentity: `d1:${suffix}`, providerFields: { database_id: `database-${suffix}` } },
    { name: "EXPORTS", kind: "r2_bucket", resourceIdentity: `r2:${suffix}`, providerFields: { bucket_name: `anyam-golden-${suffix}-exports` } },
    { name: "CACHE", kind: "kv_namespace", resourceIdentity: `kv:${suffix}`, providerFields: { namespace_id: `kv-${suffix}` } },
    { name: "EVENTS", kind: "queue", resourceIdentity: `queue:${suffix}`, providerFields: { queue_name: `anyam-golden-${suffix}-events` } },
    { name: "AUX", kind: "service", resourceIdentity: `service:${suffix}`, providerFields: { service: `anyam-golden-${suffix}-aux` } },
    { name: "GOLDEN_OBJECT", kind: "durable_object_namespace", resourceIdentity: `do:${suffix}`, providerFields: { class_name: "GoldenObject", namespace_id: `do-${suffix}` } },
    { name: "ANYAM_RELEASE_ID", kind: "plain_text", resourceIdentity: `release-id:${suffix}`, providerFields: { text: `release:${suffix}` } },
  ];
}

function manifestFor(release: ImmutableRelease, environment: "staging" | "production"): WorkerReleaseManifest {
  const migrationArtifact = release.artifacts.find((artifact) => artifact.outputPath === "dist/migrations/0001-add-region.sql");
  const assetArtifact = release.artifacts.find((artifact) => artifact.outputPath === "dist/assets/index.html");
  assert.ok(migrationArtifact);
  assert.ok(assetArtifact);
  return createCloudflareWorkerReleaseManifest({
    release,
    compatibilityDate: "2026-01-01",
    bindings: bindings(environment),
    staticAssetArtifactIds: [assetArtifact.id],
    externalMigrationArtifactIds: [migrationArtifact.id],
    staticAssets: { manifestDigest: assetArtifact.digest, namespaceDigest: digest(`assets:${environment}`) },
    healthPaths: ["/health"],
  });
}

test("golden Worker seals one multi-resource artifact closure for isolated staging and production Targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-worker-golden-"));
  try {
    await cp(fixtureRoot, directory, { recursive: true });
    const rawManifest = JSON.parse(await readFile(join(directory, "anyam.json"), "utf8")) as unknown;
    const normalized = normalizeProjectManifest(rawManifest);
    const baseTarget = targetFromManifest(normalized.targets[0]!, normalized.projectId);
    const stagingTarget = target({ base: baseTarget, id: "target:golden-staging", environment: "staging" });
    const productionTarget = target({ base: baseTarget, id: "target:golden-production", environment: "production" });
    const local = await runLocalRelease({ manifest: rawManifest, context: context(directory, stagingTarget.id), releaseName: "golden" });
    assert.equal(local.evidence.every((record) => record.outcome === "passed"), true);
    assert.deepEqual(local.artifacts.map((artifact) => artifact.outputPath), ["dist/index.js", "dist/helper.js", "dist/assets/index.html", "dist/migrations/0001-add-region.sql"]);
    const migrationArtifact = local.artifacts.find((artifact) => artifact.outputPath === "dist/migrations/0001-add-region.sql");
    assert.ok(migrationArtifact);
    const migrationPlan = createMigrationPlan({ strategy: "expand-contract", beforeSchemaDigest: digest("schema-before"), afterSchemaDigest: digest("schema-after"), compatibility: "bidirectional", rollback: "application-only", migrationArtifactIds: [migrationArtifact.id] });
    const stagingRelease = sealVerifiedRelease({ projectId: normalized.projectId, release: { ...local.release, migrationPlan }, artifacts: local.artifacts, evidence: local.evidence, target: stagingTarget });
    const productionRelease = sealVerifiedRelease({ projectId: normalized.projectId, release: { ...local.release, migrationPlan }, artifacts: local.artifacts, evidence: local.evidence, target: productionTarget });
    const stagingManifest = manifestFor(stagingRelease, "staging");
    const productionManifest = manifestFor(productionRelease, "production");
    assert.deepEqual(stagingRelease.artifacts.map((artifact) => artifact.digest), productionRelease.artifacts.map((artifact) => artifact.digest));
    assert.equal(stagingRelease.release.inputSet?.inputClosureDigest, productionRelease.release.inputSet?.inputClosureDigest);
    assert.equal(stagingManifest.modules.length, 2);
    assert.equal(stagingManifest.staticAssets?.artifactDigests?.length, 1);
    assert.equal(stagingManifest.durableObjectMigrations, undefined);
    assert.equal(stagingManifest.bindings.length, 7);
    assert.notEqual(stagingManifest.digest, productionManifest.digest);
    assert.notEqual(stagingRelease.releaseDigest, productionRelease.releaseDigest);
    assert.notEqual(stagingManifest.bindings[0]?.resourceIdentity, productionManifest.bindings[0]?.resourceIdentity);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
