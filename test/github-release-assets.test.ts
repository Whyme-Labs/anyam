import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { CONTRACT_VERSIONS, type Artifact, type DisclosureClassification } from "../src/kernel/contracts.ts";
import { createReleaseAssetTarget, publishReleaseArtifact, ReleasePublicationCoordinator, type ReleaseAssetTarget } from "../src/delivery/release-publication.ts";
import type { ImmutableRelease } from "../src/delivery/promotion.ts";
import {
  GITHUB_RELEASE_ASSETS_ADAPTER_ID,
  GITHUB_RELEASE_ASSETS_AUDIENCE,
  FetchGitHubReleaseAssetsClient,
  GitHubReleaseAssetsAdapter,
  type GitHubRelease,
  type GitHubReleaseAsset,
  type GitHubReleaseAssetsClient,
  type GitHubReleaseAssetsCredentialBroker,
} from "../src/portability/github-release-assets.ts";

const owner = "anyam-test";
const repository = "release-assets";
const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifact(id: string, bytes: Uint8Array, disclosure: DisclosureClassification = "public"): Artifact {
  return {
    protocol: CONTRACT_VERSIONS.artifact,
    id,
    type: "package.archive",
    digest: digest(bytes),
    projectRevisionId: "project-revision:release-assets",
    outputPath: `${id.replaceAll(":", "-")}.tgz`,
    disclosure: { projectionId: `projection:${disclosure}`, classification: disclosure },
  };
}

function release(id: string, selected: Artifact, releaseDigest: string): ImmutableRelease {
  return {
    protocol: CONTRACT_VERSIONS.verifiedRelease,
    id,
    projectId: "project:release-assets",
    release: {
      protocol: CONTRACT_VERSIONS.release,
      id,
      projectRevisionId: selected.projectRevisionId,
      artifactIds: [selected.id],
      evidenceIds: [],
      configurationDigests: ["sha256:configuration-release-assets"],
      stateAssumptions: [],
      policyVersion: "policy:release-assets",
      status: "ready",
    },
    artifacts: [selected],
    evidence: [],
    releaseDigest,
    receipt: `fixture=detached-release; release=${id}`,
  };
}

function target(disclosure: DisclosureClassification = "public"): ReleaseAssetTarget {
  return createReleaseAssetTarget({
    target: {
      protocol: CONTRACT_VERSIONS.target,
      id: `target:github-release-assets:${disclosure}`,
      projectId: "project:release-assets",
      name: "GitHub release downloads",
      adapterId: GITHUB_RELEASE_ASSETS_ADAPTER_ID,
      acceptedArtifactTypes: ["package.archive"],
      requiredEvidenceKeys: [],
      state: "configured",
    },
    contractDigest: "sha256:github-release-assets-test-contract",
  });
}

function broker(scopes: readonly string[] = ["contents:read", "contents:write"]): GitHubReleaseAssetsCredentialBroker {
  return {
    async issue() {
      return {
        token: "credential-material-held-in-memory-only",
        credentialId: "credential:github-release-assets-test",
        expiresAt: future(),
        audience: GITHUB_RELEASE_ASSETS_AUDIENCE,
        scopes,
        receipt: `scope=${scopes.join(",")}; selectedRepository=true; credentialMaterialStored=false`,
      };
    },
  };
}

class FakeGitHubReleaseClient implements GitHubReleaseAssetsClient {
  readonly calls: string[] = [];
  readonly releases = new Map<string, GitHubRelease>();
  readonly bytes = new Map<string, Uint8Array>();
  readonly responseLoss = new Set<string>();
  private nextRelease = 1;
  private nextAsset = 1;

  findReleaseByTag(input: { tagName: string }): Promise<GitHubRelease | null> {
    this.calls.push(`find:${input.tagName}`);
    return Promise.resolve([...this.releases.values()].find((release) => release.tagName === input.tagName) ?? null);
  }

  createDraftRelease(input: { tagName: string }): Promise<GitHubRelease> {
    this.calls.push("create");
    const created: GitHubRelease = { id: String(this.nextRelease++), tagName: input.tagName, draft: true, immutable: false, htmlUrl: `https://github.com/${owner}/${repository}/releases/tag/${input.tagName}`, assets: [] };
    this.releases.set(created.id, created);
    if (this.responseLoss.has("create")) throw new Error("response-lost-after-create");
    return Promise.resolve(created);
  }

  inspectRelease(input: { releaseId: string }): Promise<GitHubRelease> {
    this.calls.push(`inspect:${input.releaseId}`);
    const release = this.releases.get(input.releaseId);
    if (!release) return Promise.reject(new Error("release-not-found"));
    return Promise.resolve(release);
  }

  uploadAsset(input: { releaseId: string; name: string; mediaType: string; bytes: Uint8Array }): Promise<GitHubReleaseAsset> {
    this.calls.push(`upload:${input.name}`);
    const release = this.releases.get(input.releaseId);
    if (!release) return Promise.reject(new Error("release-not-found"));
    const uploaded: GitHubReleaseAsset = { id: String(this.nextAsset++), name: input.name, size: input.bytes.byteLength, mediaType: input.mediaType, apiUrl: `https://api.github.com/repos/${owner}/${repository}/releases/assets/${this.nextAsset}`, browserDownloadUrl: `https://github.com/${owner}/${repository}/releases/download/${release.tagName}/${input.name}`, digest: digest(input.bytes) };
    this.bytes.set(uploaded.id, new Uint8Array(input.bytes));
    this.releases.set(release.id, { ...release, assets: [...release.assets, uploaded] });
    if (this.responseLoss.has(`upload:${input.name}`)) throw new Error("response-lost-after-upload");
    return Promise.resolve(uploaded);
  }

  downloadAsset(input: { asset: GitHubReleaseAsset }): Promise<{ bytes: Uint8Array; mediaType: string; receipt: string }> {
    this.calls.push(`download:${input.asset.name}`);
    const bytes = this.bytes.get(input.asset.id);
    if (!bytes) return Promise.reject(new Error("asset-not-found"));
    return Promise.resolve({ bytes: new Uint8Array(bytes), mediaType: input.asset.mediaType, receipt: "provider=fake; download=verified" });
  }

  publishRelease(input: { releaseId: string }): Promise<GitHubRelease> {
    this.calls.push("publish");
    const release = this.releases.get(input.releaseId);
    if (!release) return Promise.reject(new Error("release-not-found"));
    this.releases.set(release.id, { ...release, draft: false, immutable: true });
    if (this.responseLoss.has("publish")) throw new Error("response-lost-after-publish");
    return Promise.resolve(release);
  }

  deleteRelease(input: { releaseId: string }): Promise<void> {
    this.calls.push(`delete:${input.releaseId}`);
    this.releases.delete(input.releaseId);
    return Promise.resolve();
  }

  corruptAsset(name: string, bytes: Uint8Array): void {
    const release = [...this.releases.values()][0];
    if (!release) throw new Error("test release missing");
    const asset = release?.assets.find((candidate) => candidate.name === name);
    if (!asset) throw new Error("test asset missing");
    this.bytes.set(asset.id, new Uint8Array(bytes));
    this.releases.set(release.id, { ...release, assets: release.assets.map((candidate) => candidate.id === asset.id ? { ...candidate, size: bytes.byteLength, digest: digest(bytes) } : candidate) });
  }
}

function adapter(client: FakeGitHubReleaseClient, disclosure: DisclosureClassification = "public", scopes: readonly string[] = ["contents:read", "contents:write"]): GitHubReleaseAssetsAdapter {
  const bytes = new Map<string, Uint8Array>();
  return new GitHubReleaseAssetsAdapter({
    owner,
    repository,
    disclosure,
    credentialBroker: broker(scopes),
    client,
    artifactReader: { read: async (value) => new Uint8Array(bytes.get(value.digest) ?? testBytes.get(value.digest) ?? []) },
    requireImmutableRelease: true,
    capabilityReceipt: "provider=fixture; selectedRepository=true; immutableRelease=observed; responseLossReconciliation=observed",
  });
}

const testBytes = new Map<string, Uint8Array>();

test("GitHub release-assets publishes detached bytes, reconciles response loss, verifies downloads, and records provider metadata", async () => {
  const client = new FakeGitHubReleaseClient();
  const bytes = new TextEncoder().encode("immutable release bytes\n");
  const selected = artifact("artifact:one", bytes);
  testBytes.set(selected.digest, bytes);
  const verified = release("release:one", selected, `sha256:${"1".repeat(64)}`);
  client.responseLoss.add("create");
  client.responseLoss.add("upload:artifact-one.tgz");
  client.responseLoss.add("upload:artifact-one.tgz.anyam-release.json");
  client.responseLoss.add("publish");
  const result = await adapter(client).publish({ publicationId: "publication:one", attempt: 0, release: verified, artifact: selected, target: target() });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.value.releaseDigest, verified.releaseDigest);
  assert.equal(result.value.artifactDigest, selected.digest);
  assert.equal(result.value.providerByteLength, bytes.byteLength);
  assert.equal(result.value.providerCapabilities?.immutableRelease, true);
  assert.match(result.value.providerReleaseUrl ?? "", /^https:\/\/github\.com\//u);
  assert.match(result.value.receipt, /responseLossReconciliation|immutableObserved=true/u);
  assert.ok(client.calls.filter((call) => call.startsWith("upload:")).length >= 2);
});

test("generic publication coordinator makes duplicate publication idempotent and rolls back by pointer without rebuilding", async () => {
  const client = new FakeGitHubReleaseClient();
  const firstBytes = new TextEncoder().encode("release one\n");
  const secondBytes = new TextEncoder().encode("release two\n");
  const firstArtifact = artifact("artifact:first", firstBytes);
  const secondArtifact = artifact("artifact:second", secondBytes);
  testBytes.set(firstArtifact.digest, firstBytes);
  testBytes.set(secondArtifact.digest, secondBytes);
  const first = release("release:first", firstArtifact, `sha256:${"2".repeat(64)}`);
  const second = release("release:second", secondArtifact, `sha256:${"3".repeat(64)}`);
  const targetValue = target();
  const releaseAdapter = adapter(client);
  const coordinator = new ReleasePublicationCoordinator({ projectId: "project:release-assets", target: targetValue, adapter: releaseAdapter, releases: [first, second] });
  const publishedFirst = await publishReleaseArtifact({ coordinator, releaseId: first.release.id, artifactId: firstArtifact.id, idempotencyKey: "publish:first", actor: { principalId: "principal:test", actorId: "actor:test", sessionId: "session:test", clientId: "client:test" } });
  const duplicate = await publishReleaseArtifact({ coordinator, releaseId: first.release.id, artifactId: firstArtifact.id, idempotencyKey: "publish:first", actor: { principalId: "principal:test", actorId: "actor:test", sessionId: "session:test", clientId: "client:test" } });
  const publishedSecond = await publishReleaseArtifact({ coordinator, releaseId: second.release.id, artifactId: secondArtifact.id, idempotencyKey: "publish:second", actor: { principalId: "principal:test", actorId: "actor:test", sessionId: "session:test", clientId: "client:test" }, expectedCurrentReleaseId: first.release.id });
  const rolledBack = await publishReleaseArtifact({ coordinator, releaseId: first.release.id, artifactId: firstArtifact.id, idempotencyKey: "publish:rollback", actor: { principalId: "principal:test", actorId: "actor:test", sessionId: "session:test", clientId: "client:test" }, expectedCurrentReleaseId: second.release.id });
  assert.equal(publishedFirst.state, "published");
  assert.equal(duplicate.id, publishedFirst.id);
  assert.equal(publishedSecond.state, "published");
  assert.equal(rolledBack.state, "published");
  assert.equal(coordinator.getTarget().currentReleaseId, first.release.id);
  assert.deepEqual(coordinator.getTarget().releaseHistory, [first.release.id, second.release.id, first.release.id]);
  assert.equal(rolledBack.providerByteLength, firstBytes.byteLength);
});

test("existing same-name mismatched bytes degrade instead of replacing an immutable provider object", async () => {
  const client = new FakeGitHubReleaseClient();
  const bytes = new TextEncoder().encode("stable bytes\n");
  const selected = artifact("artifact:mismatch", bytes);
  testBytes.set(selected.digest, bytes);
  const verified = release("release:mismatch", selected, `sha256:${"4".repeat(64)}`);
  const first = await adapter(client).publish({ publicationId: "publication:mismatch:seed", attempt: 0, release: verified, artifact: selected, target: target() });
  assert.equal(first.status, "succeeded");
  const assetName = "artifact-mismatch.tgz";
  client.corruptAsset(assetName, new TextEncoder().encode("different bytes\n"));
  const mismatch = await adapter(client).publish({ publicationId: "publication:mismatch:retry", attempt: 1, release: verified, artifact: selected, target: target() });
  assert.equal(mismatch.status, "failed");
  if (mismatch.status !== "failed") return;
  assert.equal(mismatch.outcome, "indeterminate");
  assert.equal(mismatch.retryable, false);
  assert.match(mismatch.recoveryAction, /reconcile/u);
});

test("public Target disclosure and scoped credential requirements fail closed", async () => {
  const client = new FakeGitHubReleaseClient();
  const bytes = new TextEncoder().encode("private bytes\n");
  const privateArtifact = artifact("artifact:private", bytes, "project");
  testBytes.set(privateArtifact.digest, bytes);
  const privateRelease = release("release:private", privateArtifact, `sha256:${"5".repeat(64)}`);
  const disclosureBlocked = await adapter(client).publish({ publicationId: "publication:private", attempt: 0, release: privateRelease, artifact: privateArtifact, target: target("public") });
  assert.equal(disclosureBlocked.status, "failed");
  if (disclosureBlocked.status === "failed") assert.equal(disclosureBlocked.errorCode, "github_release_assets.disclosure_blocked");
  const scopedBlocked = await adapter(client, "project", ["contents:read"]).publish({ publicationId: "publication:scope", attempt: 0, release: privateRelease, artifact: privateArtifact, target: target("project") });
  assert.equal(scopedBlocked.status, "failed");
  if (scopedBlocked.status === "failed") assert.equal(scopedBlocked.errorCode, "github_release_assets.scope_missing");
  assert.equal(client.releases.size, 0);
});

test("fetch-backed GitHub client retries a transient provider response with a visible sizing receipt", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const client = new FetchGitHubReleaseAssetsClient({
    retry: { delaysMs: [0], sizingReceipt: "qualification=fixture; retryStatuses=5xx; measuredAttempts=2" },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("provider busy", { status: 503 });
      return new Response(JSON.stringify({ id: 17, tag_name: "anyam-release", draft: true, immutable: false, html_url: "https://github.com/anyam-test/release-assets/releases/tag/anyam-release", assets: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const found = await client.findReleaseByTag({ owner, repository, tagName: "anyam-release", token: "fixture-token" });
  assert.equal(found?.id, "17");
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [0]);
});

test("fetch-backed GitHub client treats a missing release tag as an empty lookup", async () => {
  const client = new FetchGitHubReleaseAssetsClient({
    retry: { delaysMs: [], sizingReceipt: "qualification=fixture; retry=none" },
    fetchImpl: async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }),
  });

  const found = await client.findReleaseByTag({ owner, repository, tagName: "missing-release", token: "fixture-token" });
  assert.equal(found, null);
});
