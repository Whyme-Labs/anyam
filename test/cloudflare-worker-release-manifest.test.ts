import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertCloudflareWorkerVersionReadback,
  createCloudflareWorkerReleaseManifest,
  WorkerReleaseManifestError,
  workerReleaseManifestUploadMetadata,
} from "../src/cloudflare/worker-release-manifest.ts";
import { CONTRACT_VERSIONS, type Artifact, type Evidence, type Release } from "../src/kernel/contracts.ts";
import type { ImmutableRelease } from "../src/delivery/promotion.ts";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function release(): ImmutableRelease {
  const firstBytes = "export default {}";
  const secondBytes = "export const helper = true";
  const artifacts: readonly Artifact[] = [
    { protocol: CONTRACT_VERSIONS.artifact, id: "artifact:main", type: "worker.bundle", digest: digest(firstBytes), projectRevisionId: "project-revision:manifest", outputPath: "src/worker.js" },
    { protocol: CONTRACT_VERSIONS.artifact, id: "artifact:helper", type: "worker.module", digest: digest(secondBytes), projectRevisionId: "project-revision:manifest", outputPath: "src/helper.js" },
  ];
  const evidence: readonly Evidence[] = [];
  const base: Release = {
    protocol: CONTRACT_VERSIONS.release,
    id: "release:manifest",
    projectRevisionId: "project-revision:manifest",
    artifactIds: artifacts.map((artifact) => artifact.id),
    evidenceIds: [],
    configurationDigests: [digest("configuration")],
    stateAssumptions: ["manifest test"],
    policyVersion: "policy:manifest-test",
    status: "ready",
  };
  return { protocol: CONTRACT_VERSIONS.verifiedRelease, id: "verified-release:manifest", projectId: "project:manifest", release: base, artifacts, evidence, releaseDigest: digest("release"), receipt: "fixture=manifest" };
}

function releaseWithStaticAsset(): ImmutableRelease {
  const base = release();
  const asset: Artifact = { protocol: CONTRACT_VERSIONS.artifact, id: "artifact:asset", type: "worker.asset", digest: digest("asset-bytes"), projectRevisionId: "project-revision:manifest", outputPath: "assets/index.html" };
  return { ...base, artifacts: [...base.artifacts, asset], release: { ...base.release, artifactIds: [...base.release.artifactIds, asset.id] } };
}

test("Worker Release Manifest carries modules, assets, bindings, compatibility, migrations, and health identity", () => {
  const manifest = createCloudflareWorkerReleaseManifest({
    release: release(),
    compatibilityDate: "2026-01-01",
    compatibilityFlags: ["nodejs_compat"],
    staticAssets: { manifestDigest: digest("assets-manifest"), namespaceDigest: digest("assets-namespace"), providerFields: { namespace_id: "assets-namespace-id" } },
    bindings: [{ name: "DB", kind: "d1", resourceIdentity: "d1:production", configurationDigest: digest("db-config"), providerFields: { database_id: "db-id" } }],
    durableObjectMigrations: { fromTag: "v1", toTag: "v2", stepsDigest: digest("migration") },
    healthPaths: ["/health", "/ready"],
  });
  assert.equal(manifest.mainModule, "src/worker.js");
  assert.equal(manifest.modules.length, 2);
  assert.equal(manifest.bindings[0]?.name, "DB");
  assert.equal(manifest.staticAssets?.manifestDigest, digest("assets-manifest"));
  assert.equal(manifest.durableObjectMigrations?.toTag, "v2");
  assert.match(manifest.digest, /^sha256:[a-f0-9]{64}$/u);
  const metadata = workerReleaseManifestUploadMetadata(manifest, "release:manifest", "anyam-manifest");
  assert.equal(metadata.main_module, "src/worker.js");
  assert.deepEqual(metadata.compatibility_flags, ["nodejs_compat"]);
  assert.deepEqual(metadata.bindings, [{ name: "DB", type: "d1", database_id: "db-id" }]);
  assert.match(String((metadata.annotations as { "workers/message": string })["workers/message"]), new RegExp(`manifest=${manifest.digest}`));
});

test("Worker Release Manifest separates static asset Artifacts from executable modules", () => {
  const manifest = createCloudflareWorkerReleaseManifest({
    release: releaseWithStaticAsset(),
    compatibilityDate: "2026-01-01",
    staticAssetArtifactIds: ["artifact:asset"],
    staticAssets: { manifestDigest: digest("assets-manifest"), namespaceDigest: digest("assets-namespace") },
  });
  assert.equal(manifest.modules.length, 2);
  assert.deepEqual(manifest.staticAssets?.artifactDigests, [digest("asset-bytes")]);
  const metadata = workerReleaseManifestUploadMetadata(manifest, "release:manifest", "anyam-manifest", "asset-upload-jwt");
  assert.deepEqual(metadata.assets, { jwt: "asset-upload-jwt" });
});

test("Worker Release Manifest read-back blocks binding drift and accepts an exact provider observation", () => {
  const manifest = createCloudflareWorkerReleaseManifest({
    release: release(),
    compatibilityDate: "2026-01-01",
    bindings: [{ name: "DB", kind: "d1", providerFields: { database_id: "db-id" } }],
  });
  const version = {
    id: "version:manifest",
    metadata: { annotations: { "workers/tag": "anyam-manifest", "workers/message": `Anyam Release release:manifest; manifest=${manifest.digest}` } },
    resources: {
      bindings: [{ name: "DB", type: "d1", database_id: "db-id" }],
      script_runtime: { compatibility_date: "2026-01-01", compatibility_flags: [] },
    },
  };
  assert.match(assertCloudflareWorkerVersionReadback({ manifest, version }), /readback=verified/);
  const moduleReadback = { ...version, resources: { ...version.resources, script: { modules: manifest.modules.map((module) => ({ name: module.name })) } } };
  assert.match(assertCloudflareWorkerVersionReadback({ manifest, version: moduleReadback }), /readback=verified/);
  const moduleDrift = { ...moduleReadback, resources: { ...moduleReadback.resources, script: { modules: [{ name: "wrong.js" }] } } };
  assert.throws(() => assertCloudflareWorkerVersionReadback({ manifest, version: moduleDrift }), (error: unknown) => error instanceof WorkerReleaseManifestError && error.code === "readback-mismatch");
  const drifted = { ...version, resources: { ...version.resources, bindings: [{ name: "DB", type: "d1", database_id: "other-db" }] } };
  assert.throws(() => assertCloudflareWorkerVersionReadback({ manifest, version: drifted }), (error: unknown) => error instanceof WorkerReleaseManifestError && error.code === "readback-mismatch");
});
