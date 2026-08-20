import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  createReleaseAssetTarget,
  publishReleaseArtifact,
  ReleasePublicationCoordinator,
  type ReleaseAssetTarget,
} from "../src/delivery/release-publication.ts";
import { CONTRACT_VERSIONS, type Artifact, type DisclosureClassification } from "../src/kernel/contracts.ts";
import type { ImmutableRelease } from "../src/delivery/promotion.ts";
import { RealmAuthorityHttpClient, type JsonObject } from "../src/portability/realm-authority-client.ts";
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

function jsonDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function seedDisposableReleaseRepository(input: { owner: string; repository: string; token: string }): Promise<string> {
  const path = ".anyam-release-assets-qualification.txt";
  const bytes = new TextEncoder().encode("Anyam immutable release-assets qualification seed\n");
  const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/contents/${path}`;
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${input.token}` };
  const existingResponse = await fetch(url, { headers });
  const existingBody = await existingResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (existingResponse.status === 200) {
    const existingContent = typeof existingBody.content === "string" ? existingBody.content.replaceAll("\n", "") : "";
    const existingBytes = existingContent.length > 0 ? Buffer.from(existingContent, "base64") : Buffer.alloc(0);
    if (digest(existingBytes) !== digest(bytes)) throw new Error(`disposable repository seed ${path} already exists with a different digest; reconcile the owner-controlled repository before retrying`);
    return `provider=github; operation=seed; path=${path}; bytes=${bytes.byteLength}; digest=${digest(bytes)}; existing=true; credentialMaterialStored=false`;
  }
  if (existingResponse.status !== 404) throw new Error(`disposable repository seed lookup returned HTTP ${existingResponse.status}`);
  const createResponse = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ message: "Seed disposable release-assets qualification repository", branch: "main", content: Buffer.from(bytes).toString("base64") }),
  });
  const createBody = await createResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!createResponse.ok) {
    const message = typeof createBody.message === "string" ? createBody.message : "provider error";
    throw new Error(`disposable repository seed returned HTTP ${createResponse.status}: ${message}`);
  }
  const commit = createBody.commit as Record<string, unknown> | undefined;
  const commitSha = typeof commit?.sha === "string" ? commit.sha : "not-returned";
  return `provider=github; operation=seed; path=${path}; bytes=${bytes.byteLength}; digest=${digest(bytes)}; commit=${commitSha}; existing=false; credentialMaterialStored=false`;
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

function authorityObject(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`customer Realm Authority returned malformed ${field}`);
  return value as JsonObject;
}

function authorityField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`customer Realm Authority response omitted ${field}`);
  return value.trim();
}

function authorityResultValue(value: JsonObject): JsonObject {
  return value.value === undefined ? value : authorityObject(value.value, "value");
}

type AuthorityConfig = { baseUrl: string; ownerSession: string };

function authorityConfig(): AuthorityConfig | undefined {
  const baseUrl = optional("ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_BASE_URL");
  const direct = optional("ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_OWNER_SESSION");
  const file = optional("ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_OWNER_SESSION_FILE");
  if (direct && file) throw new Error("set only one of ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_OWNER_SESSION or ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_OWNER_SESSION_FILE; credential material is not printed");
  const ownerSession = file ? readOwnerSessionFile(file) : direct;
  const configured = [baseUrl, ownerSession].some((value) => value !== undefined);
  if (!configured) return undefined;
  if (!baseUrl) throw new Error("ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_BASE_URL is required when live customer Realm Authority qualification is enabled");
  if (!ownerSession) throw new Error("set ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_OWNER_SESSION or ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_OWNER_SESSION_FILE for the authenticated Realm owner; credential material is never printed");
  return { baseUrl, ownerSession: ownerSession.trim() };
}

function readOwnerSessionFile(path: string): string {
  // Keep owner-session loading synchronous so it happens before any provider
  // mutation. The value is never included in a receipt.
  return readFileSync(path, "utf8").trim();
}

type CleanupReceipt = { status: "succeeded" | "blocked" | "not-run"; receipt: string; recoveryAction?: string };

async function restoreAuthoritySnapshot(client: RealmAuthorityHttpClient, snapshot: JsonObject): Promise<CleanupReceipt> {
  try {
    const restored = await client.restoreAuthoritySnapshot(snapshot);
    if (restored.status !== "recovery-restored") return { status: "blocked", receipt: "cleanup=authority-recovery-blocked; unexpected-status; credentialMaterialStored=false", recoveryAction: "authenticate the Realm owner again, inspect the recovery receipt, and restore the exact exported snapshot" };
    const readBack = await client.exportAuthoritySnapshot();
    const readBackSnapshot = authorityObject(readBack.snapshot, "restored Authority snapshot");
    if (readBack.credentialFree !== true || Object.prototype.hasOwnProperty.call(readBackSnapshot, "credentials") || jsonDigest(readBackSnapshot) !== jsonDigest(snapshot)) return { status: "blocked", receipt: "cleanup=authority-recovery-blocked; snapshot-read-back-mismatch; credentialMaterialStored=false", recoveryAction: "retain the disposable Authority boundary and retry the exact snapshot restore after inspecting its receipt" };
    return { status: "succeeded", receipt: "cleanup=authority-recovery-restored; snapshot-read-back-verified; identity-sessions-untouched; credentialMaterialStored=false" };
  } catch (error) {
    return { status: "blocked", receipt: `cleanup=authority-recovery-blocked; errorClass=${error instanceof Error ? error.name : "unknown"}; credentialMaterialStored=false`, recoveryAction: "authenticate the Realm owner again and restore the exact credential-free Authority snapshot" };
  }
}

async function qualifyCustomerRealmAuthority(input: {
  client: RealmAuthorityHttpClient;
  selected: Artifact;
  verified: ImmutableRelease;
  target: ReleaseAssetTarget;
}): Promise<{ receipt: string; cleanupSnapshot: JsonObject; projectId: string; releaseId: string; targetId: string; promotionStatus: string }> {
  const recovery = await input.client.exportAuthoritySnapshot();
  const snapshot = authorityObject(recovery.snapshot, "Authority recovery snapshot");
  if (recovery.credentialFree !== true || Object.prototype.hasOwnProperty.call(snapshot, "credentials")) throw new Error("customer Realm Authority recovery snapshot was not credential-free; no Authority mutation was attempted");
  const state = await input.client.inspectState();
  const authority = authorityObject(state.authority, "Authority state");
  const counts = authorityObject(authority.counts, "Authority state counts");
  const occupied = Object.entries(counts).filter(([key, value]) => key !== "audit" && typeof value === "number" && value > 0);
  if (occupied.length > 0) throw new Error(`customer Realm Authority is not an empty disposable boundary (${occupied.map(([key, value]) => `${key}=${String(value)}`).join(", ")}); use a fresh Realm or restore its credential-free snapshot before retrying`);

  const suffix = input.verified.releaseDigest.slice("sha256:".length, "sha256:".length + 24);
  const projectId = `project:github-release-assets:${suffix}`;
  const sourceSpaceId = `source:github-release-assets:${suffix}`;
  const projectRevisionId = `project-revision:github-release-assets:${suffix}`;
  const workspaceId = `workspace:github-release-assets:${suffix}`;
  const changeId = `change:github-release-assets:${suffix}`;
  const intentId = `intent:github-release-assets:${suffix}`;
  const changeRevisionId = `change-revision:github-release-assets:${suffix}`;
  const runId = `run:github-release-assets:${suffix}`;
  const evidenceId = `evidence:github-release-assets:${suffix}`;
  const artifactId = `artifact:github-release-assets:${suffix}`;
  const releaseId = `release:github-release-assets:${suffix}`;
  const targetId = `target:github-release-assets:${suffix}`;

  const project = await input.client.createProject({ projectId, name: "Anyam GitHub release-assets qualification", referenceType: "git", sourceSpaces: [{ id: sourceSpaceId, name: "Qualification public", classification: "public", snapshotId: input.verified.releaseDigest }], projectRevisionId }, `github-release-assets:${suffix}:project-create`);
  const canonical = authorityObject(project.canonicalRevision, "canonical Project Revision");
  if (authorityField(canonical.id, "canonicalRevision.id") !== projectRevisionId) throw new Error("customer Realm Authority returned a different canonical Project Revision than requested");
  // Omit mounts so the Authority applies the canonical Source Space mount
  // default; an explicit empty list is not a valid Workspace boundary.
  const workspace = await input.client.createWorkspace(projectId, { workspaceId, projectRevisionId, sourceSpaceIds: [sourceSpaceId], projectionId: `projection:github-release-assets:${suffix}`, classification: "public" }, `github-release-assets:${suffix}:workspace-create`);
  const view = authorityObject(workspace.view, "Project View");
  if (typeof view.id !== "string" || view.id.trim().length === 0) throw new Error("customer Realm Authority returned an invalid Project View identity");
  const actualProjectViewId = authorityField(view.id, "view.id");

  const change = await input.client.command({ command: "change.create", idempotencyKey: `github-release-assets:${suffix}:change-create`, payload: { projectId, changeId, intentId, baseProjectRevisionId: projectRevisionId, workspaceId } });
  const changeValue = authorityResultValue(change);
  const changeRecord = authorityObject(changeValue.change, "Change");
  if (authorityField(changeRecord.id, "change.id") !== changeId) throw new Error("customer Realm Authority returned a different Change identity");
  const revision = await input.client.command({ command: "revision.publish", idempotencyKey: `github-release-assets:${suffix}:revision-publish`, payload: { projectId, changeId, workspaceId, projectViewId: actualProjectViewId, projectRevisionId, sourceSpaceSnapshots: { [sourceSpaceId]: input.verified.releaseDigest }, declaredEffects: ["release-download-artifact"], revisionId: changeRevisionId, kind: "implementation" } });
  const revisionValue = authorityResultValue(revision);
  const revisionRecord = authorityObject(revisionValue.revision, "Change Revision");
  if (authorityField(revisionRecord.id, "revision.id") !== changeRevisionId || authorityField(revisionRecord.projectRevisionId, "revision.projectRevisionId") !== projectRevisionId) throw new Error("customer Realm Authority Change Revision lineage did not match the canonical Project Revision");

  const run = await input.client.command({ command: "run.record", idempotencyKey: `github-release-assets:${suffix}:run-record`, payload: { projectId, runId, actionId: `action:github-release-assets:${suffix}`, projectRevisionId, projectViewId: actualProjectViewId, runnerId: `runner:github-release-assets:${suffix}`, status: "succeeded", outputDigest: input.selected.digest, changeRevisionId, workspaceId, inputDigests: [input.verified.releaseDigest], outputDigests: [input.selected.digest] } });
  const runValue = authorityResultValue(run);
  const runRecord = authorityObject(runValue.run, "Run");
  if (authorityField(runRecord.id, "run.id") !== runId) throw new Error("customer Realm Authority returned a different Run identity");
  const evidence = await input.client.command({ command: "evidence.record", idempotencyKey: `github-release-assets:${suffix}:evidence-record`, payload: { projectId, evidenceId, runId, key: "release-download-bytes", criterion: "The detached Artifact bytes are exactly the bytes published to the release Target.", outcome: "passed", validityKey: `release-download:${input.selected.digest}`, actionId: `action:github-release-assets:${suffix}`, verifierId: "verifier:github-release-assets-qualification", toolchainDigest: "sha256:qualification-toolchain", dependencyDigest: "sha256:qualification-dependencies", environmentDigest: "sha256:qualification-environment", inputDigests: [input.verified.releaseDigest], effectDigests: ["sha256:release-download-artifact"], outputDigest: input.selected.digest, projectRevisionId, projectViewId: actualProjectViewId, changeRevisionId, runnerId: `runner:github-release-assets:${suffix}`, policyVersion: "policy:github-release-assets-qualification", authorizationEpoch: "owner-session", capabilityGrantId: `grant:github-release-assets:${suffix}`, disclosure: { projectionId: `projection:github-release-assets:${suffix}`, classification: "public" }, receipt: "qualification=detached-artifact-byte-verification; credentialMaterialStored=false", invalidators: ["source-revision", "artifact-digest", "target-policy"], owner: "Anyam release-assets qualification", workspaceId } });
  const evidenceValue = authorityResultValue(evidence);
  const evidenceRecord = authorityObject(evidenceValue.evidence, "Evidence");
  if (authorityField(evidenceRecord.id, "evidence.id") !== evidenceId || authorityField(evidenceRecord.outcome, "evidence.outcome") !== "passed") throw new Error("customer Realm Authority did not record passed Evidence");
  const recordedArtifact = await input.client.command({ command: "artifact.record", idempotencyKey: `github-release-assets:${suffix}:artifact-record`, payload: { projectId, artifactId, type: input.selected.type, digest: input.selected.digest, projectRevisionId, changeRevisionId, runId, actionId: `action:github-release-assets:${suffix}`, outputPath: input.selected.outputPath, provenanceDigest: input.verified.releaseDigest, disclosure: { projectionId: `projection:github-release-assets:${suffix}`, classification: "public" } } });
  const artifactValue = authorityResultValue(recordedArtifact);
  const artifactRecord = authorityObject(artifactValue.artifact, "Artifact");
  if (authorityField(artifactRecord.id, "artifact.id") !== artifactId || authorityField(artifactRecord.digest, "artifact.digest") !== input.selected.digest) throw new Error("customer Realm Authority Artifact did not preserve the exact selected digest");
  const releaseResult = await input.client.command({ command: "release.create", idempotencyKey: `github-release-assets:${suffix}:release-create`, payload: { projectId, releaseId, name: "Anyam GitHub release-assets qualification", projectRevisionId, artifactIds: [artifactId], evidenceIds: [evidenceId], configurationDigests: ["sha256:github-release-assets-configuration"], stateAssumptions: ["disposable public release-download Target"], policyVersion: "policy:github-release-assets-qualification", changeRevisionId, provenanceDigest: input.verified.releaseDigest } });
  const releaseValue = authorityResultValue(releaseResult);
  const releaseRecord = authorityObject(releaseValue.release, "Release");
  if (authorityField(releaseRecord.id, "release.id") !== releaseId || authorityField(releaseRecord.status, "release.status") !== "ready") throw new Error("customer Realm Authority did not record a ready Release");
  const targetResult = await input.client.command({ command: "target.configure", idempotencyKey: `github-release-assets:${suffix}:target-configure`, payload: { projectId, targetId, name: input.target.name, adapterId: input.target.adapterId, acceptedArtifactTypes: [...input.target.acceptedArtifactTypes], requiredEvidenceKeys: [...input.target.requiredEvidenceKeys] } });
  const targetValue = authorityResultValue(targetResult);
  const targetRecord = authorityObject(targetValue.target, "Target");
  if (authorityField(targetRecord.id, "target.id") !== targetId) throw new Error("customer Realm Authority returned a different Target identity");
  const promotion = await input.client.command({ command: "promotion.request", idempotencyKey: `github-release-assets:${suffix}:promotion-request`, payload: { projectId, promotionId: `promotion:github-release-assets:${suffix}`, targetId, releaseId, releaseDigest: input.verified.releaseDigest }, allowStatuses: [409] });
  const promotionStatus = authorityField(promotion.status, "promotion.status");
  if (promotionStatus !== "blocked") throw new Error(`customer Realm Authority Promotion unexpectedly returned ${promotionStatus}; provider execution must remain a separate handoff`);
  const finalState = await input.client.inspectState();
  return { cleanupSnapshot: snapshot, projectId, releaseId, targetId, promotionStatus, receipt: `authority=customer-realm; project=${projectId}; artifact=${artifactId}; evidence=${evidenceId}; release=${releaseId}; target=${targetId}; promotion=${promotionStatus}; canonicalWrite=false; credentialMaterialStored=false; stateReadBack=${jsonDigest(finalState)}` };
}

async function qualifyLive(): Promise<Record<string, unknown>> {
  const repository = optional("ANYAM_GITHUB_RELEASE_ASSETS_REPOSITORY");
  const disposableRepository = optional("ANYAM_GITHUB_RELEASE_ASSETS_DISPOSABLE_REPOSITORY");
  const qualificationId = optional("ANYAM_GITHUB_RELEASE_ASSETS_QUALIFICATION_ID");
  const token = optional("ANYAM_GITHUB_RELEASE_ASSETS_TOKEN");
  const scopes = optional("ANYAM_GITHUB_RELEASE_ASSETS_SCOPES")?.split(",").map((scope) => scope.trim()).filter(Boolean);
  const expiresAt = optional("ANYAM_GITHUB_RELEASE_ASSETS_TOKEN_EXPIRES_AT");
  const scopeReceipt = optional("ANYAM_GITHUB_RELEASE_ASSETS_SCOPE_RECEIPT");
  const authorityInputs = authorityConfig();
  if (!repository || !disposableRepository || !qualificationId || !token || !scopes || !expiresAt || !scopeReceipt || !authorityInputs) return { status: "blocked", mode: "live", live: "not-run", recoveryAction: "set ANYAM_GITHUB_RELEASE_ASSETS_REPOSITORY, ANYAM_GITHUB_RELEASE_ASSETS_DISPOSABLE_REPOSITORY, ANYAM_GITHUB_RELEASE_ASSETS_QUALIFICATION_ID, ANYAM_GITHUB_RELEASE_ASSETS_TOKEN, ANYAM_GITHUB_RELEASE_ASSETS_SCOPES, ANYAM_GITHUB_RELEASE_ASSETS_TOKEN_EXPIRES_AT, ANYAM_GITHUB_RELEASE_ASSETS_SCOPE_RECEIPT, ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_BASE_URL, and one of ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_OWNER_SESSION_FILE or ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_OWNER_SESSION; credential values are never printed" };
  if (disposableRepository !== repository) throw new Error("ANYAM_GITHUB_RELEASE_ASSETS_DISPOSABLE_REPOSITORY must exactly equal the selected repository");
  const [owner, name, ...extra] = repository.split("/");
  if (!owner || !name || extra.length > 0) throw new Error("ANYAM_GITHUB_RELEASE_ASSETS_REPOSITORY must be owner/name");
  if (!scopes.includes("contents:read") || !scopes.includes("contents:write")) throw new Error("ANYAM_GITHUB_RELEASE_ASSETS_SCOPES must include contents:read,contents:write");
  if (Date.parse(expiresAt) <= Date.now()) throw new Error("ANYAM_GITHUB_RELEASE_ASSETS_TOKEN_EXPIRES_AT must be future-dated");
  const bytes = new TextEncoder().encode("Anyam disposable immutable release qualification\n");
  const selected = artifact("artifact:live", bytes);
  const verified = release("release:live", selected, `live:${qualificationId}`);
  const targetValue = target("public");
  const authorityClient = new RealmAuthorityHttpClient({ baseUrl: authorityInputs.baseUrl, ownerSession: authorityInputs.ownerSession });
  const tagName = `anyam-${verified.releaseDigest.slice("sha256:".length)}`;
  const client = new FetchGitHubReleaseAssetsClient({ retry: { delaysMs: [], sizingReceipt: "qualification=caller-supplied; retry=none" } });
  const seedReceipt = await seedDisposableReleaseRepository({ owner, repository: name, token });
  const existing = await client.findReleaseByTag({ owner, repository: name, tagName, token });
  if (existing) throw new Error(`disposable Release already exists for deterministic tag ${tagName}; reconcile it before retrying without deleting an owner object`);
  let authorityQualification: Awaited<ReturnType<typeof qualifyCustomerRealmAuthority>> | undefined;
  let authoritySnapshot: JsonObject | undefined;
  let result: Awaited<ReturnType<GitHubReleaseAssetsAdapter["publish"]>> | undefined;
  let cleanup: Record<string, unknown> = { status: "not-run", receipt: "cleanup=not-run" };
  let authorityCleanup: CleanupReceipt | undefined;
  try {
    const authorityExport = await authorityClient.exportAuthoritySnapshot();
    authoritySnapshot = authorityObject(authorityExport.snapshot, "Authority recovery snapshot");
    if (authorityExport.credentialFree !== true || Object.prototype.hasOwnProperty.call(authoritySnapshot, "credentials")) throw new Error("customer Realm Authority recovery snapshot was not credential-free; no Authority mutation was attempted");
    authorityQualification = await qualifyCustomerRealmAuthority({ client: authorityClient, selected, verified, target: targetValue });
    const capabilityReceipt = `provider=github; repository=${repository}; scopeReceipt=${scopeReceipt}; ${authorityQualification.receipt}; credentialMaterialStored=false`;
    const broker: GitHubReleaseAssetsCredentialBroker = { async issue() { return { token, credentialId: "credential:env:github-release-assets", expiresAt, audience: GITHUB_RELEASE_ASSETS_AUDIENCE, scopes, receipt: `${scopeReceipt}; selectedRepository=true; authority=customer-realm; credentialMaterialStored=false` }; } };
    const adapter = new GitHubReleaseAssetsAdapter({ owner, repository: name, disclosure: "public", credentialBroker: broker, client, artifactReader: { read: async () => bytes }, capabilityReceipt, requireImmutableRelease: true });
    result = await adapter.publish({ publicationId: "publication:live", attempt: 0, release: verified, artifact: selected, target: targetValue });
    if (authorityQualification) authorityCleanup = await restoreAuthoritySnapshot(authorityClient, authorityQualification.cleanupSnapshot);
  } finally {
    try {
      const created = await client.findReleaseByTag({ owner, repository: name, tagName, token });
      if (created) {
        const cleanupAdapter: GitHubReleaseAssetsAdapter = new GitHubReleaseAssetsAdapter({ owner, repository: name, disclosure: "public", credentialBroker: { async issue() { return { token, credentialId: "credential:env:github-release-assets", expiresAt, audience: GITHUB_RELEASE_ASSETS_AUDIENCE, scopes, receipt: `${scopeReceipt}; selectedRepository=true; cleanup=true; credentialMaterialStored=false` }; } }, client, artifactReader: { read: async () => bytes }, capabilityReceipt: "cleanup=owner-controlled; credentialMaterialStored=false", requireImmutableRelease: true });
        cleanup = await cleanupAdapter.deleteForQualification(created.id);
      }
      else cleanup = { status: "succeeded", receipt: "cleanup=no-release-observed; credentialMaterialStored=false" };
    } catch (error) {
      cleanup = { status: "blocked", receipt: `cleanup=blocked; errorClass=${error instanceof Error ? error.name : "unknown"}; credentialMaterialStored=false`, recoveryAction: "retain the disposable repository, inspect the deterministic Release, and retry cleanup with the owner-controlled credential" };
    }
    if (!authorityCleanup && authoritySnapshot) authorityCleanup = await restoreAuthoritySnapshot(authorityClient, authoritySnapshot);
  }
  if (!result || result.status !== "succeeded") {
    const error = result && result.status === "failed" ? `${result.errorCode}; ${result.recoveryAction}; ${result.receipt}` : "live release publication did not return a result";
    throw new Error(`${error}; cleanup=${JSON.stringify({ provider: cleanup, authority: authorityCleanup ?? { status: "not-run" } })}`);
  }
  if (!result.value.providerReleaseId) throw new Error("live release publication omitted provider release identity");
  if (cleanup.status !== "succeeded") throw new Error(`live release cleanup did not complete: ${JSON.stringify(cleanup)}`);
  if (!authorityCleanup || authorityCleanup.status !== "succeeded") throw new Error(`customer Realm Authority cleanup did not complete: ${JSON.stringify(authorityCleanup ?? { status: "not-run" })}`);
  return { status: "succeeded", mode: "live", qualificationId, qualificationScope: "provider-adapter-and-customer-realm-authority", repository, seedReceipt, providerReleaseId: result.value.providerReleaseId, providerAssetId: result.value.providerAssetId, releaseDigest: result.value.releaseDigest, artifactDigest: result.value.artifactDigest, receipt: result.receipt, authority: { projectId: authorityQualification?.projectId, releaseId: authorityQualification?.releaseId, targetId: authorityQualification?.targetId, promotionStatus: authorityQualification?.promotionStatus, receipt: authorityQualification?.receipt }, cleanup: { provider: cleanup, authority: authorityCleanup } };
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
