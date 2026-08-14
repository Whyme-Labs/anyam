import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createReleaseAssetTarget,
  publishReleaseArtifact,
  ReleasePublicationCoordinator,
  type ReleaseAssetTarget,
} from "../src/delivery/release-publication.ts";
import { CONTRACT_VERSIONS, type Artifact, type DisclosureClassification } from "../src/kernel/contracts.ts";
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

const protocol = "anyam.github-release-assets-qualification/v1" as const;
const fixtureOwner = "anyam-qualification";
const fixtureRepository = "release-assets";
const actor = { principalId: "principal:qualification", actorId: "actor:qualification", sessionId: "session:qualification", clientId: "client:qualification" };

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifact(id: string, bytes: Uint8Array, disclosure: DisclosureClassification = "public"): Artifact {
  return {
    protocol: CONTRACT_VERSIONS.artifact,
    id,
    type: "package.archive",
    digest: digest(bytes),
    projectRevisionId: "project-revision:github-release-assets-qualification",
    outputPath: `${id.replaceAll(":", "-")}.tgz`,
    disclosure: { projectionId: `projection:${disclosure}`, classification: disclosure },
  };
}

function release(id: string, selected: Artifact, marker: string): ImmutableRelease {
  return {
    protocol: CONTRACT_VERSIONS.verifiedRelease,
    id,
    projectId: "project:github-release-assets-qualification",
    release: {
      protocol: CONTRACT_VERSIONS.release,
      id,
      projectRevisionId: selected.projectRevisionId,
      artifactIds: [selected.id],
      evidenceIds: [],
      configurationDigests: [`sha256:configuration:${marker}`],
      stateAssumptions: [],
      policyVersion: "policy:github-release-assets-qualification",
      status: "ready",
    },
    artifacts: [selected],
    evidence: [],
    releaseDigest: digest(new TextEncoder().encode(`release:${marker}`)),
    receipt: `fixture=detached-release; release=${id}`,
  };
}

function target(disclosure: DisclosureClassification = "public"): ReleaseAssetTarget {
  return createReleaseAssetTarget({
    target: {
      protocol: CONTRACT_VERSIONS.target,
      id: `target:github-release-assets-qualification:${disclosure}`,
      projectId: "project:github-release-assets-qualification",
      name: "Qualification release downloads",
      adapterId: GITHUB_RELEASE_ASSETS_ADAPTER_ID,
      acceptedArtifactTypes: ["package.archive"],
      requiredEvidenceKeys: [],
      state: "configured",
    },
    contractDigest: "sha256:github-release-assets-qualification",
  });
}

class FixtureClient implements GitHubReleaseAssetsClient {
  readonly releases = new Map<string, GitHubRelease>();
  readonly bytes = new Map<string, Uint8Array>();
  readonly responseLoss = new Set<string>();
  private nextRelease = 1;
  private nextAsset = 1;

  async findReleaseByTag(input: { tagName: string }): Promise<GitHubRelease | null> {
    return [...this.releases.values()].find((release) => release.tagName === input.tagName) ?? null;
  }

  async createDraftRelease(input: { tagName: string }): Promise<GitHubRelease> {
    const value: GitHubRelease = { id: `release-${this.nextRelease++}`, tagName: input.tagName, draft: true, immutable: false, htmlUrl: `https://github.com/${fixtureOwner}/${fixtureRepository}/releases/tag/${input.tagName}`, assets: [] };
    this.releases.set(value.id, value);
    if (this.responseLoss.has("create")) throw new Error("response-lost-after-create");
    return value;
  }

  async inspectRelease(input: { releaseId: string }): Promise<GitHubRelease> {
    const value = this.releases.get(input.releaseId);
    if (!value) throw new Error("release-not-found");
    return value;
  }

  async uploadAsset(input: { releaseId: string; name: string; mediaType: string; bytes: Uint8Array }): Promise<GitHubReleaseAsset> {
    const releaseValue = this.releases.get(input.releaseId);
    if (!releaseValue) throw new Error("release-not-found");
    const id = `asset-${this.nextAsset++}`;
    const asset: GitHubReleaseAsset = { id, name: input.name, size: input.bytes.byteLength, mediaType: input.mediaType, apiUrl: `https://api.github.com/repos/${fixtureOwner}/${fixtureRepository}/releases/assets/${id}`, browserDownloadUrl: `https://github.com/${fixtureOwner}/${fixtureRepository}/releases/download/${releaseValue.tagName}/${input.name}`, digest: digest(input.bytes) };
    this.bytes.set(id, new Uint8Array(input.bytes));
    this.releases.set(releaseValue.id, { ...releaseValue, assets: [...releaseValue.assets, asset] });
    if (this.responseLoss.has(`upload:${input.name}`)) throw new Error("response-lost-after-upload");
    return asset;
  }

  async downloadAsset(input: { asset: GitHubReleaseAsset }): Promise<{ bytes: Uint8Array; mediaType: string; receipt: string }> {
    const value = this.bytes.get(input.asset.id);
    if (!value) throw new Error("asset-not-found");
    return { bytes: new Uint8Array(value), mediaType: input.asset.mediaType, receipt: "provider=fixture; download=verified" };
  }

  async publishRelease(input: { releaseId: string }): Promise<GitHubRelease> {
    const value = this.releases.get(input.releaseId);
    if (!value) throw new Error("release-not-found");
    const published = { ...value, draft: false, immutable: true };
    this.releases.set(value.id, published);
    if (this.responseLoss.has("publish")) throw new Error("response-lost-after-publish");
    return published;
  }

  async deleteRelease(input: { releaseId: string }): Promise<void> {
    this.releases.delete(input.releaseId);
  }

  corrupt(name: string): void {
    const releaseValue = [...this.releases.values()].find((candidate) => candidate.assets.some((entry) => entry.name === name));
    if (!releaseValue) throw new Error("fixture-asset-missing");
    const asset = releaseValue.assets.find((entry) => entry.name === name);
    if (!asset) throw new Error("fixture-asset-missing");
    const bytes = new TextEncoder().encode("mismatched bytes\n");
    this.bytes.set(asset.id, bytes);
    this.releases.set(releaseValue.id, { ...releaseValue, assets: releaseValue.assets.map((entry) => entry.id === asset.id ? { ...entry, size: bytes.byteLength, digest: digest(bytes) } : entry) });
  }
}

function fixtureBroker(scopes: readonly string[] = ["contents:read", "contents:write"]): GitHubReleaseAssetsCredentialBroker {
  return { async issue() { return { token: "fixture-token-held-in-memory-only", credentialId: "credential:fixture", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), audience: GITHUB_RELEASE_ASSETS_AUDIENCE, scopes, receipt: `scope=${scopes.join(",")}; selectedRepository=true; credentialMaterialStored=false` }; } };
}

function fixtureAdapter(client: FixtureClient, bytes: Map<string, Uint8Array>, disclosure: DisclosureClassification = "public", scopes: readonly string[] = ["contents:read", "contents:write"]): GitHubReleaseAssetsAdapter {
  return new GitHubReleaseAssetsAdapter({
    owner: fixtureOwner,
    repository: fixtureRepository,
    disclosure,
    credentialBroker: fixtureBroker(scopes),
    client,
    artifactReader: { read: async (value) => new Uint8Array(bytes.get(value.digest) ?? []) },
    capabilityReceipt: "provider=fixture; selectedRepository=true; immutableRelease=observed; responseLossReconciliation=observed; authority=fixture",
    requireImmutableRelease: true,
  });
}

async function qualifyFixture(): Promise<Record<string, unknown>> {
  const client = new FixtureClient();
  const bytes = new Map<string, Uint8Array>();
  const firstBytes = new TextEncoder().encode("first immutable release\n");
  const secondBytes = new TextEncoder().encode("second immutable release\n");
  const firstArtifact = artifact("artifact:first", firstBytes);
  const secondArtifact = artifact("artifact:second", secondBytes);
  bytes.set(firstArtifact.digest, firstBytes);
  bytes.set(secondArtifact.digest, secondBytes);
  const first = release("release:first", firstArtifact, "first");
  const second = release("release:second", secondArtifact, "second");
  const adapter = fixtureAdapter(client, bytes);
  const firstTag = `artifact-first.tgz`;
  client.responseLoss.add("create");
  client.responseLoss.add(`upload:${firstTag}`);
  client.responseLoss.add(`upload:${firstTag}.anyam-release.json`);
  client.responseLoss.add("publish");
  const responseLoss = await adapter.publish({ publicationId: "publication:response-loss", attempt: 0, release: first, artifact: firstArtifact, target: target() });
  assert.equal(responseLoss.status, "succeeded");
  const coordinator = new ReleasePublicationCoordinator({ projectId: first.projectId, target: target(), adapter, releases: [first, second] });
  const published = await publishReleaseArtifact({ coordinator, releaseId: first.release.id, artifactId: firstArtifact.id, idempotencyKey: "fixture:first", actor });
  const duplicate = await publishReleaseArtifact({ coordinator, releaseId: first.release.id, artifactId: firstArtifact.id, idempotencyKey: "fixture:first", actor });
  const secondPublication = await publishReleaseArtifact({ coordinator, releaseId: second.release.id, artifactId: secondArtifact.id, idempotencyKey: "fixture:second", actor, expectedCurrentReleaseId: first.release.id });
  const rollback = await publishReleaseArtifact({ coordinator, releaseId: first.release.id, artifactId: firstArtifact.id, idempotencyKey: "fixture:rollback", actor, expectedCurrentReleaseId: second.release.id });
  assert.equal(published.state, "published");
  assert.equal(duplicate.id, published.id);
  assert.equal(secondPublication.state, "published");
  assert.equal(rollback.state, "published");
  client.corrupt("artifact-second.tgz");
  const mismatch = await adapter.publish({ publicationId: "publication:mismatch", attempt: 1, release: second, artifact: secondArtifact, target: target() });
  assert.equal(mismatch.status, "failed");
  if (mismatch.status === "failed") assert.equal(mismatch.outcome, "indeterminate");
  return { status: "succeeded", mode: "fixture", responseLossReconciled: true, duplicateIdempotent: true, secondReleasePublished: true, rollbackByPointer: true, mismatchDegraded: true, credentialScopes: "contents:read,contents:write (fixture)" };
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

async function qualifyLive(): Promise<Record<string, unknown>> {
  const repository = optional("ANYAM_GITHUB_RELEASE_ASSETS_REPOSITORY");
  const disposableRepository = optional("ANYAM_GITHUB_RELEASE_ASSETS_DISPOSABLE_REPOSITORY");
  const token = optional("ANYAM_GITHUB_RELEASE_ASSETS_TOKEN");
  const scopes = optional("ANYAM_GITHUB_RELEASE_ASSETS_SCOPES")?.split(",").map((scope) => scope.trim()).filter(Boolean);
  const expiresAt = optional("ANYAM_GITHUB_RELEASE_ASSETS_TOKEN_EXPIRES_AT");
  const scopeReceipt = optional("ANYAM_GITHUB_RELEASE_ASSETS_SCOPE_RECEIPT");
  const authorityReceipt = optional("ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_RECEIPT");
  if (!repository || !disposableRepository || !token || !scopes || !expiresAt || !scopeReceipt || !authorityReceipt) return { status: "blocked", mode: "live", live: "not-run", recoveryAction: "set ANYAM_GITHUB_RELEASE_ASSETS_REPOSITORY, _DISPOSABLE_REPOSITORY, _TOKEN, _SCOPES, _TOKEN_EXPIRES_AT, _SCOPE_RECEIPT, and _AUTHORITY_RECEIPT; credential values are never printed" };
  if (disposableRepository !== repository) throw new Error("ANYAM_GITHUB_RELEASE_ASSETS_DISPOSABLE_REPOSITORY must exactly equal the selected repository");
  const [owner, name, ...extra] = repository.split("/");
  if (!owner || !name || extra.length > 0) throw new Error("ANYAM_GITHUB_RELEASE_ASSETS_REPOSITORY must be owner/name");
  if (!scopes.includes("contents:read") || !scopes.includes("contents:write")) throw new Error("ANYAM_GITHUB_RELEASE_ASSETS_SCOPES must include contents:read,contents:write");
  if (Date.parse(expiresAt) <= Date.now()) throw new Error("ANYAM_GITHUB_RELEASE_ASSETS_TOKEN_EXPIRES_AT must be future-dated");
  const capabilityReceipt = `provider=github; repository=${repository}; scopeReceipt=${scopeReceipt}; authorityReceipt=${authorityReceipt}; credentialMaterialStored=false`;
  const bytes = new TextEncoder().encode("Anyam disposable immutable release qualification\n");
  const selected = artifact("artifact:live", bytes);
  const verified = release("release:live", selected, "live");
  const targetValue = target("public");
  const broker: GitHubReleaseAssetsCredentialBroker = { async issue() { return { token, credentialId: "credential:env:github-release-assets", expiresAt, audience: GITHUB_RELEASE_ASSETS_AUDIENCE, scopes, receipt: `${scopeReceipt}; selectedRepository=true; credentialMaterialStored=false` }; } };
  const client = new FetchGitHubReleaseAssetsClient({ retry: { delaysMs: [], sizingReceipt: "qualification=caller-supplied; retry=none" } });
  const adapter = new GitHubReleaseAssetsAdapter({ owner, repository: name, disclosure: "public", credentialBroker: broker, client, artifactReader: { read: async () => bytes }, capabilityReceipt, requireImmutableRelease: true });
  const tagName = `anyam-${verified.releaseDigest.slice("sha256:".length)}`;
  const existing = await client.findReleaseByTag({ owner, repository: name, tagName, token });
  if (existing) throw new Error(`disposable Release already exists for deterministic tag ${tagName}; reconcile it before retrying without deleting an owner object`);
  let result: Awaited<ReturnType<GitHubReleaseAssetsAdapter["publish"]>> | undefined;
  let cleanup: Record<string, unknown> = { status: "not-run", receipt: "cleanup=not-run" };
  try {
    result = await adapter.publish({ publicationId: "publication:live", attempt: 0, release: verified, artifact: selected, target: targetValue });
  } finally {
    try {
      const created = await client.findReleaseByTag({ owner, repository: name, tagName, token });
      if (created) cleanup = await adapter.deleteForQualification(created.id);
      else cleanup = { status: "succeeded", receipt: "cleanup=no-release-observed; credentialMaterialStored=false" };
    } catch (error) {
      cleanup = { status: "blocked", receipt: `cleanup=blocked; errorClass=${error instanceof Error ? error.name : "unknown"}; credentialMaterialStored=false`, recoveryAction: "retain the disposable repository, inspect the deterministic Release, and retry cleanup with the owner-controlled credential" };
    }
  }
  if (!result || result.status !== "succeeded") {
    const error = result && result.status === "failed" ? `${result.errorCode}; ${result.recoveryAction}; ${result.receipt}` : "live release publication did not return a result";
    throw new Error(`${error}; cleanup=${JSON.stringify(cleanup)}`);
  }
  if (!result.value.providerReleaseId) throw new Error("live release publication omitted provider release identity");
  if (cleanup.status !== "succeeded") throw new Error(`live release cleanup did not complete: ${JSON.stringify(cleanup)}`);
  return { status: "succeeded", mode: "live", repository, providerReleaseId: result.value.providerReleaseId, providerAssetId: result.value.providerAssetId, releaseDigest: result.value.releaseDigest, artifactDigest: result.value.artifactDigest, receipt: result.receipt, cleanup };
}

const fixture = await qualifyFixture();
let live: Record<string, unknown>;
try {
  live = await qualifyLive();
} catch (error) {
  live = { status: "blocked", mode: "live", error: error instanceof Error ? error.message : String(error), credentialValues: "not-printed", recoveryAction: "inspect the exact disposable GitHub Release by deterministic tag, clean it up, and retry only after reconciling provider state" };
}
const status = live.status === "succeeded" ? "succeeded" : "blocked";
console.log(JSON.stringify({ protocol, status, fixture, live, credentialValues: "not-printed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true }, null, 2));
if (status !== "succeeded") process.exitCode = 2;
