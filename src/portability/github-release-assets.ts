import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  type Artifact,
  type DisclosureClassification,
} from "../kernel/contracts.ts";
import {
  type DeliveryAdapterFailure,
  type DeliveryAdapterResult,
  type ImmutableRelease,
} from "../delivery/promotion.ts";
import {
  type PublishedArtifact,
  type ReleaseAssetTarget,
  type ReleaseTargetAdapter,
} from "../delivery/release-publication.ts";

/**
 * GitHub is a replaceable publication projection. This adapter never receives
 * a repository checkout, never rebuilds a Release, and never advances Anyam's
 * Target pointer. It only transfers one detached, digest-bound Artifact.
 */
export const GITHUB_RELEASE_ASSETS_PROTOCOL = "anyam.github-release-assets/v1" as const;
export const GITHUB_RELEASE_ASSETS_ADAPTER_ID = "github.release-assets" as const;
export const GITHUB_RELEASE_ASSETS_AUDIENCE = "aud:anyam:github-release-assets" as const;

export type GitHubReleaseAsset = {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mediaType: string;
  readonly apiUrl?: string;
  readonly browserDownloadUrl?: string;
  readonly digest?: string;
};

export type GitHubRelease = {
  readonly id: string;
  readonly tagName: string;
  readonly draft: boolean;
  readonly immutable?: boolean;
  readonly htmlUrl: string;
  readonly assets: readonly GitHubReleaseAsset[];
};

export type GitHubReleaseAssetsCredential = {
  readonly token: string;
  readonly credentialId: string;
  readonly expiresAt: string;
  readonly audience: typeof GITHUB_RELEASE_ASSETS_AUDIENCE;
  /** A scope receipt, never the token itself. */
  readonly scopes: readonly string[];
  readonly receipt: string;
};

export type GitHubReleaseAssetsCredentialOperation = "inspect" | "create" | "upload" | "download" | "publish" | "delete";

export type GitHubReleaseAssetsCredentialBroker = {
  issue(input: {
    owner: string;
    repository: string;
    operation: GitHubReleaseAssetsCredentialOperation;
    disclosure: DisclosureClassification;
  }): Promise<GitHubReleaseAssetsCredential>;
};

export type GitHubReleaseAssetsClient = {
  findReleaseByTag(input: { owner: string; repository: string; tagName: string; token: string }): Promise<GitHubRelease | null>;
  createDraftRelease(input: { owner: string; repository: string; tagName: string; token: string }): Promise<GitHubRelease>;
  inspectRelease(input: { owner: string; repository: string; releaseId: string; token: string }): Promise<GitHubRelease>;
  uploadAsset(input: { owner: string; repository: string; releaseId: string; name: string; mediaType: string; bytes: Uint8Array; token: string }): Promise<GitHubReleaseAsset>;
  downloadAsset(input: { owner: string; repository: string; releaseId: string; asset: GitHubReleaseAsset; token: string }): Promise<{ bytes: Uint8Array; mediaType: string; receipt: string }>;
  publishRelease(input: { owner: string; repository: string; releaseId: string; token: string }): Promise<GitHubRelease>;
  deleteRelease(input: { owner: string; repository: string; releaseId: string; token: string }): Promise<void>;
};

export type GitHubReleaseAssetsArtifactReader = {
  read(artifact: Artifact): Promise<Uint8Array>;
};

export type GitHubReleaseAssetsAdapterOptions = {
  owner: string;
  repository: string;
  disclosure: DisclosureClassification;
  credentialBroker: GitHubReleaseAssetsCredentialBroker;
  client: GitHubReleaseAssetsClient;
  artifactReader: GitHubReleaseAssetsArtifactReader;
  /** Require the provider's observed immutable-release capability. */
  requireImmutableRelease?: boolean;
  /** A provider capability receipt must be supplied by the caller. */
  capabilityReceipt: string;
  assetNameFor?: (input: { release: ImmutableRelease; artifact: Artifact }) => string;
  mediaTypeFor?: (artifact: Artifact) => string;
};

export class GitHubReleaseAssetsAdapterError extends Error {
  readonly errorCode: string;
  readonly outcome: "failed" | "indeterminate";
  readonly retryable: boolean;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    errorCode: string;
    message: string;
    outcome: "failed" | "indeterminate";
    retryable: boolean;
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "GitHubReleaseAssetsAdapterError";
    this.errorCode = input.errorCode;
    this.outcome = input.outcome;
    this.retryable = input.retryable;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

export type GitHubReleaseAssetsHttpOptions = {
  apiBaseUrl?: string;
  uploadBaseUrl?: string;
  retry?: { delaysMs: readonly number[]; sizingReceipt: string };
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

type JsonRecord = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stable(nested)]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

function digest(value: Uint8Array | string | unknown): string {
  const bytes = value instanceof Uint8Array ? value : Buffer.from(typeof value === "string" ? value : stableJson(value), "utf8");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field}=missing`);
  return value.trim();
}

function safeRepositoryPart(value: string, field: string): string {
  const result = required(value, field);
  if (!/^[A-Za-z0-9_.-]+$/u.test(result) || result === "." || result === "..") throw new Error(`${field}=invalid`);
  return result;
}

function safeTag(value: string): string {
  const tag = required(value, "tagName");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u.test(tag) || tag.includes("..")) throw new Error("tagName=invalid");
  return tag;
}

function safeAssetName(value: string): string {
  const name = required(value, "assetName");
  if (name.length > 240 || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name.includes("\0")) throw new Error("assetName=invalid");
  return name;
}

function safeReceipt(value: string, field: string): string {
  const receipt = required(value, field);
  if (/(token|password|secret|credential)\s*[=:]/iu.test(receipt)) throw new Error(`${field}=credential-material`);
  return receipt;
}

function safeUrl(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "api.github.com" && url.hostname !== "uploads.github.com")) throw new Error(`${field}=host-invalid`);
  return url.toString();
}

function disclosureRank(value: DisclosureClassification): number {
  return value === "public" ? 0 : value === "project" ? 1 : 2;
}

function disclosureAllows(target: DisclosureClassification, artifact: Artifact): boolean {
  return disclosureRank(target) >= disclosureRank(artifact.disclosure?.classification ?? "restricted");
}

function defaultAssetName(artifact: Artifact): string {
  const output = artifact.outputPath?.replaceAll("\\", "/").split("/").at(-1);
  return safeAssetName(output && output.length > 0 ? output : `${artifact.id.replace(/[^A-Za-z0-9_.-]/gu, "-")}.asset`);
}

function releaseTag(release: ImmutableRelease): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(release.releaseDigest)) throw new Error(`release=${release.release.id}; releaseDigest=invalid`);
  return safeTag(`anyam-${release.releaseDigest.slice("sha256:".length)}`);
}

function mediaTypeFor(artifact: Artifact, configured: ((artifact: Artifact) => string) | undefined): string {
  const value = configured?.(artifact) ?? (artifact.type === "package.archive" ? "application/gzip" : "application/octet-stream");
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\r") || value.includes("\n")) throw new Error(`artifact=${artifact.id}; mediaType=invalid`);
  return value.trim();
}

function manifestBytes(input: { release: ImmutableRelease; artifact: Artifact; target: ReleaseAssetTarget; assetName: string; mediaType: string; byteLength: number; disclosure: DisclosureClassification }): Uint8Array {
  const manifest = {
    protocol: "anyam.release-download-manifest/v1",
    targetId: input.target.id,
    releaseId: input.release.release.id,
    releaseDigest: input.release.releaseDigest,
    artifact: {
      id: input.artifact.id,
      type: input.artifact.type,
      digest: input.artifact.digest,
      byteLength: input.byteLength,
      mediaType: input.mediaType,
      assetName: input.assetName,
      disclosure: input.disclosure,
    },
    receipt: "release=detached; sourceRead=not-performed; rebuild=not-performed; credentialFree=true",
  };
  return Buffer.from(`${stableJson(manifest)}\n`, "utf8");
}

function failure(input: { errorCode: string; message: string; outcome: "failed" | "indeterminate"; retryable: boolean; recoveryAction: string; receipt: string }): DeliveryAdapterFailure {
  return {
    status: "failed",
    outcome: input.outcome,
    errorCode: input.errorCode,
    message: input.message,
    retryable: input.retryable,
    recoveryAction: input.recoveryAction,
    receipt: `${safeReceipt(input.receipt, "providerReceipt")}; credentialMaterialStored=false`,
  };
}

function adapterFailure(error: unknown, operation: string): DeliveryAdapterFailure {
  if (error instanceof GitHubReleaseAssetsAdapterError) {
    return failure({ errorCode: error.errorCode, message: error.message, outcome: error.outcome, retryable: error.retryable, recoveryAction: error.recoveryAction, receipt: `provider=github.release-assets; operation=${operation}; ${error.receipt}` });
  }
  return failure({
    errorCode: "github_release_assets.adapter_exception",
    message: `GitHub release-assets ${operation} did not complete.`,
    outcome: "indeterminate",
    retryable: true,
    recoveryAction: `inspect the GitHub release by tag and asset digest, then retry the same immutable Release; operation=${operation}`,
    receipt: `provider=github.release-assets; operation=${operation}; exception=redacted`,
  });
}

function assertCredential(credential: GitHubReleaseAssetsCredential, requiredScopes: readonly string[], operation: string): void {
  required(credential.token, "credential.token");
  required(credential.credentialId, "credential.credentialId");
  required(credential.expiresAt, "credential.expiresAt");
  if (credential.audience !== GITHUB_RELEASE_ASSETS_AUDIENCE) throw new GitHubReleaseAssetsAdapterError({ errorCode: "github_release_assets.audience_invalid", message: "The GitHub release-assets credential has the wrong audience.", outcome: "failed", retryable: false, recoveryAction: "issue a short-lived credential for the github.release-assets audience", receipt: `operation=${operation}; audience=invalid` });
  if (new Date(credential.expiresAt).getTime() <= Date.now()) throw new GitHubReleaseAssetsAdapterError({ errorCode: "github_release_assets.credential_expired", message: "The GitHub release-assets credential is expired.", outcome: "failed", retryable: true, recoveryAction: "issue a fresh scoped release-assets credential and retry the same immutable Release", receipt: `operation=${operation}; credential=expired` });
  if (!requiredScopes.every((scope) => credential.scopes.includes(scope))) throw new GitHubReleaseAssetsAdapterError({ errorCode: "github_release_assets.scope_missing", message: "The GitHub release-assets credential lacks the required scoped permission.", outcome: "failed", retryable: false, recoveryAction: `issue a credential with ${requiredScopes.join(", ")} and retry`, receipt: `operation=${operation}; scope=missing; required=${requiredScopes.join(",")}` });
  safeReceipt(credential.receipt, "credential.receipt");
}

function releaseAssetByName(release: GitHubRelease, name: string): GitHubReleaseAsset | undefined {
  return release.assets.find((asset) => asset.name === name);
}

function releaseMatches(release: GitHubRelease, tagName: string): boolean {
  return release.tagName === tagName && release.id.length > 0 && safeUrl(release.htmlUrl, "release.htmlUrl") !== undefined;
}

function assetMatches(asset: GitHubReleaseAsset, expected: { name: string; digest: string; byteLength: number }): boolean {
  return asset.name === expected.name && asset.size === expected.byteLength && (!asset.digest || asset.digest === expected.digest);
}

export class GitHubReleaseAssetsAdapter implements ReleaseTargetAdapter {
  readonly protocol = CONTRACT_VERSIONS.targetAdapter;
  readonly id = GITHUB_RELEASE_ASSETS_ADAPTER_ID;
  readonly contractDigest = `sha256:${createHash("sha256").update("anyam.github-release-assets/v1").digest("hex")}`;
  private readonly options: {
    readonly owner: string;
    readonly repository: string;
    readonly disclosure: DisclosureClassification;
    readonly credentialBroker: GitHubReleaseAssetsCredentialBroker;
    readonly client: GitHubReleaseAssetsClient;
    readonly artifactReader: GitHubReleaseAssetsArtifactReader;
    readonly capabilityReceipt: string;
    readonly assetNameFor: ((input: { release: ImmutableRelease; artifact: Artifact }) => string) | undefined;
    readonly mediaTypeFor: ((artifact: Artifact) => string) | undefined;
    readonly requireImmutableRelease: boolean;
  };

  constructor(input: GitHubReleaseAssetsAdapterOptions) {
    const owner = safeRepositoryPart(input.owner, "owner");
    const repository = safeRepositoryPart(input.repository, "repository");
    if (input.disclosure !== "public" && input.disclosure !== "project" && input.disclosure !== "restricted") throw new Error("disclosure=invalid");
    this.options = {
      owner,
      repository,
      disclosure: input.disclosure,
      credentialBroker: input.credentialBroker,
      client: input.client,
      artifactReader: input.artifactReader,
      capabilityReceipt: safeReceipt(input.capabilityReceipt, "capabilityReceipt"),
      assetNameFor: input.assetNameFor,
      mediaTypeFor: input.mediaTypeFor,
      requireImmutableRelease: input.requireImmutableRelease ?? true,
    };
  }

  async publish(input: { publicationId: string; attempt: number; release: ImmutableRelease; artifact: Artifact; target: ReleaseAssetTarget }): Promise<DeliveryAdapterResult<PublishedArtifact>> {
    try {
      return await this.publishDetached(input);
    } catch (error) {
      return adapterFailure(error, "publish");
    }
  }

  async deleteForQualification(releaseId: string): Promise<{ status: "succeeded"; receipt: string }> {
    const credential = await this.options.credentialBroker.issue({ owner: this.options.owner, repository: this.options.repository, operation: "delete", disclosure: this.options.disclosure });
    assertCredential(credential, ["contents:write"], "delete");
    await this.options.client.deleteRelease({ owner: this.options.owner, repository: this.options.repository, releaseId, token: credential.token });
    return { status: "succeeded", receipt: `provider=github.release-assets; operation=delete; releaseId=${releaseId}; credentialMaterialStored=false` };
  }

  private async credential(operation: GitHubReleaseAssetsCredentialOperation): Promise<GitHubReleaseAssetsCredential> {
    const credential = await this.options.credentialBroker.issue({ owner: this.options.owner, repository: this.options.repository, operation, disclosure: this.options.disclosure });
    assertCredential(credential, operation === "inspect" || operation === "download" ? ["contents:read"] : ["contents:write"], operation);
    return credential;
  }

  private async inspectByTag(tagName: string): Promise<GitHubRelease | null> {
    const credential = await this.credential("inspect");
    return this.options.client.findReleaseByTag({ owner: this.options.owner, repository: this.options.repository, tagName, token: credential.token });
  }

  private async inspectById(releaseId: string): Promise<GitHubRelease> {
    const credential = await this.credential("inspect");
    return this.options.client.inspectRelease({ owner: this.options.owner, repository: this.options.repository, releaseId, token: credential.token });
  }

  private async verifyDownloadedAsset(release: GitHubRelease, asset: GitHubReleaseAsset, expected: { name: string; digest: string; byteLength: number }): Promise<{ asset: GitHubReleaseAsset; mediaType: string }> {
    if (!assetMatches(asset, expected)) throw new GitHubReleaseAssetsAdapterError({ errorCode: "github_release_assets.asset_mismatch", message: `GitHub asset ${asset.name} does not match the detached Artifact.`, outcome: "indeterminate", retryable: false, recoveryAction: "retain the provider object, inspect its digest, and reconcile the Target instead of uploading a replacement", receipt: `releaseId=${release.id}; assetId=${asset.id}; expectedDigest=${expected.digest}; providerDigest=${asset.digest ?? "not-returned"}; expectedBytes=${expected.byteLength}; providerBytes=${asset.size}` });
    const credential = await this.credential("download");
    let downloaded: { bytes: Uint8Array; mediaType: string; receipt: string };
    try {
      downloaded = await this.options.client.downloadAsset({ owner: this.options.owner, repository: this.options.repository, releaseId: release.id, asset, token: credential.token });
    } catch {
      throw new GitHubReleaseAssetsAdapterError({ errorCode: "github_release_assets.download_failed", message: "GitHub release asset could not be downloaded for digest verification.", outcome: "indeterminate", retryable: true, recoveryAction: "inspect the exact provider asset and retry digest verification without changing the Release", receipt: `releaseId=${release.id}; assetId=${asset.id}; download=failed` });
    }
    const actualDigest = digest(downloaded.bytes);
    if (actualDigest !== expected.digest || downloaded.bytes.byteLength !== expected.byteLength) throw new GitHubReleaseAssetsAdapterError({ errorCode: "github_release_assets.download_digest_mismatch", message: "Downloaded GitHub release bytes do not match the detached Artifact.", outcome: "indeterminate", retryable: false, recoveryAction: "mark the Target degraded and reconcile the provider object; never accept mismatched bytes", receipt: `releaseId=${release.id}; assetId=${asset.id}; expectedDigest=${expected.digest}; actualDigest=${actualDigest}; expectedBytes=${expected.byteLength}; actualBytes=${downloaded.bytes.byteLength}` });
    return { asset, mediaType: downloaded.mediaType || asset.mediaType };
  }

  private async ensureAsset(input: { release: GitHubRelease; name: string; mediaType: string; bytes: Uint8Array; digest: string }): Promise<{ release: GitHubRelease; asset: GitHubReleaseAsset; mediaType: string; duplicate: boolean }> {
    const existing = releaseAssetByName(input.release, input.name);
    const expected = { name: input.name, digest: input.digest, byteLength: input.bytes.byteLength };
    if (existing) {
      const verified = await this.verifyDownloadedAsset(input.release, existing, expected);
      return { release: input.release, asset: verified.asset, mediaType: verified.mediaType, duplicate: true };
    }
    const credential = await this.credential("upload");
    let uploaded: GitHubReleaseAsset;
    try {
      uploaded = await this.options.client.uploadAsset({ owner: this.options.owner, repository: this.options.repository, releaseId: input.release.id, name: input.name, mediaType: input.mediaType, bytes: input.bytes, token: credential.token });
    } catch (error) {
      let reconciled: GitHubRelease | null = null;
      try { reconciled = await this.inspectById(input.release.id); } catch { reconciled = null; }
      const found = reconciled ? releaseAssetByName(reconciled, input.name) : undefined;
      if (reconciled && found) {
        const verified = await this.verifyDownloadedAsset(reconciled, found, expected);
        return { release: reconciled, asset: verified.asset, mediaType: verified.mediaType, duplicate: true };
      }
      if (error instanceof GitHubReleaseAssetsAdapterError) throw error;
      throw new GitHubReleaseAssetsAdapterError({ errorCode: "github_release_assets.upload_indeterminate", message: "GitHub asset upload may have committed but could not be reconciled.", outcome: "indeterminate", retryable: true, recoveryAction: "inspect the draft Release by tag and asset digest before retrying; do not upload a second object blindly", receipt: `releaseId=${input.release.id}; asset=${input.name}; upload=response-loss` });
    }
    const refreshed = await this.inspectById(input.release.id);
    const found = releaseAssetByName(refreshed, input.name) ?? uploaded;
    const verified = await this.verifyDownloadedAsset(refreshed, found, expected);
    return { release: refreshed, asset: verified.asset, mediaType: verified.mediaType, duplicate: false };
  }

  private async publishDetached(input: { publicationId: string; attempt: number; release: ImmutableRelease; artifact: Artifact; target: ReleaseAssetTarget }): Promise<DeliveryAdapterResult<PublishedArtifact>> {
    if (input.target.adapterId !== this.id) return failure({ errorCode: "github_release_assets.target_adapter_mismatch", message: "The selected Target does not name github.release-assets.", outcome: "failed", retryable: false, recoveryAction: "use the adapter declared by the Target", receipt: `target=${input.target.id}; adapter=${input.target.adapterId}` });
    if (input.target.projectId !== input.release.projectId || input.release.release.artifactIds.length === 0 || !input.release.release.artifactIds.includes(input.artifact.id)) return failure({ errorCode: "github_release_assets.release_lineage_invalid", message: "The detached Artifact is not part of the verified Release lineage.", outcome: "failed", retryable: false, recoveryAction: "seal and publish the exact Artifact selected by the Release", receipt: `target=${input.target.id}; release=${input.release.release.id}; artifact=${input.artifact.id}; lineage=invalid` });
    if (!disclosureAllows(this.options.disclosure, input.artifact)) return failure({ errorCode: "github_release_assets.disclosure_blocked", message: "The Target disclosure is broader than the Artifact disclosure policy.", outcome: "failed", retryable: false, recoveryAction: "use a Target with a matching or narrower disclosure projection", receipt: `targetDisclosure=${this.options.disclosure}; artifactDisclosure=${input.artifact.disclosure?.classification ?? "restricted"}; publication=blocked` });
    const tagName = releaseTag(input.release);
    const assetName = safeAssetName(this.options.assetNameFor?.({ release: input.release, artifact: input.artifact }) ?? defaultAssetName(input.artifact));
    const mediaType = mediaTypeFor(input.artifact, this.options.mediaTypeFor);
    let bytes: Uint8Array;
    try {
      bytes = await this.options.artifactReader.read(input.artifact);
    } catch {
      return failure({ errorCode: "github_release_assets.artifact_read_failed", message: "The detached Artifact bytes could not be read without rebuilding.", outcome: "failed", retryable: true, recoveryAction: "restore the exact verified Artifact bytes and retry the same Release", receipt: `artifact=${input.artifact.id}; rebuild=not-performed; providerMutation=false` });
    }
    const artifactDigest = digest(bytes);
    if (artifactDigest !== input.artifact.digest) return failure({ errorCode: "github_release_assets.artifact_digest_mismatch", message: "The detached Artifact bytes changed before publication.", outcome: "failed", retryable: false, recoveryAction: "restore the exact Artifact bytes and retry without rebuilding the Release", receipt: `artifact=${input.artifact.id}; expectedDigest=${input.artifact.digest}; actualDigest=${artifactDigest}; providerMutation=false` });
    const manifest = manifestBytes({ release: input.release, artifact: input.artifact, target: input.target, assetName, mediaType, byteLength: bytes.byteLength, disclosure: this.options.disclosure });
    const manifestName = safeAssetName(`${assetName}.anyam-release.json`);
    const manifestDigest = digest(manifest);

    let release = await this.inspectByTag(tagName);
    let duplicateRelease = false;
    if (!release) {
      const credential = await this.credential("create");
      try {
        release = await this.options.client.createDraftRelease({ owner: this.options.owner, repository: this.options.repository, tagName, token: credential.token });
      } catch {
        const reconciled = await this.inspectByTag(tagName);
        if (!reconciled) throw new GitHubReleaseAssetsAdapterError({ errorCode: "github_release_assets.release_create_indeterminate", message: "Draft GitHub Release creation may have committed but could not be reconciled.", outcome: "indeterminate", retryable: true, recoveryAction: "inspect the Release by deterministic tag before retrying", receipt: `tag=${tagName}; create=response-loss` });
        release = reconciled;
        duplicateRelease = true;
      }
    } else {
      duplicateRelease = true;
    }
    if (!release || !releaseMatches(release, tagName)) throw new GitHubReleaseAssetsAdapterError({ errorCode: "github_release_assets.release_identity_mismatch", message: "GitHub returned a Release with a different tag identity.", outcome: "indeterminate", retryable: false, recoveryAction: "reconcile the provider Release by tag and retain the Anyam Target in degraded state", receipt: `tag=${tagName}; releaseIdentity=mismatch` });

    const artifactResult = await this.ensureAsset({ release, name: assetName, mediaType, bytes, digest: input.artifact.digest });
    release = artifactResult.release;
    const manifestResult = await this.ensureAsset({ release, name: manifestName, mediaType: "application/json", bytes: manifest, digest: manifestDigest });
    release = manifestResult.release;
    const beforePublish = await this.inspectById(release.id);
    if (!beforePublish.draft) {
      release = beforePublish;
    } else {
      const credential = await this.credential("publish");
      try {
        release = await this.options.client.publishRelease({ owner: this.options.owner, repository: this.options.repository, releaseId: release.id, token: credential.token });
      } catch {
        const reconciled = await this.inspectById(release.id);
        if (reconciled.draft) throw new GitHubReleaseAssetsAdapterError({ errorCode: "github_release_assets.publish_indeterminate", message: "GitHub Release publication may have committed but could not be reconciled.", outcome: "indeterminate", retryable: true, recoveryAction: "inspect the Release by deterministic tag before retrying publication", receipt: `releaseId=${release.id}; publish=response-loss` });
        release = reconciled;
      }
    }
    const finalRelease = await this.inspectById(release.id);
    if (finalRelease.draft) throw new GitHubReleaseAssetsAdapterError({ errorCode: "github_release_assets.release_still_draft", message: "GitHub Release remained a draft after publication.", outcome: "indeterminate", retryable: true, recoveryAction: "inspect the draft Release and retry publication without uploading another asset", receipt: `releaseId=${finalRelease.id}; draft=true` });
    const immutableObserved = finalRelease.immutable === true;
    if (this.options.requireImmutableRelease && !immutableObserved) return failure({ errorCode: "github_release_assets.immutable_capability_unobserved", message: "GitHub did not return an observed immutable-release capability for this Target.", outcome: "failed", retryable: false, recoveryAction: "enable and qualify immutable releases for the selected repository, or configure a policy that explicitly permits a non-immutable Target", receipt: `releaseId=${finalRelease.id}; immutableObserved=${immutableObserved}; publication=not-qualified` });
    const verified = await this.verifyDownloadedAsset(finalRelease, artifactResult.asset, { name: assetName, digest: input.artifact.digest, byteLength: bytes.byteLength });
    const releaseUrl = safeUrl(finalRelease.htmlUrl, "release.htmlUrl");
    const assetUrl = safeUrl(verified.asset.browserDownloadUrl, "asset.browserDownloadUrl");
    const assetApiUrl = safeUrl(verified.asset.apiUrl, "asset.apiUrl");
    return {
      status: "succeeded",
      value: {
        targetId: input.target.id,
        releaseId: input.release.release.id,
        artifactId: input.artifact.id,
        releaseDigest: input.release.releaseDigest,
        artifactDigest: input.artifact.digest,
        providerObjectId: `github-release:${finalRelease.id}:asset:${verified.asset.id}`,
        providerReleaseId: finalRelease.id,
        providerAssetId: verified.asset.id,
        ...(releaseUrl ? { providerReleaseUrl: releaseUrl } : {}),
        ...(assetUrl ? { providerAssetUrl: assetUrl } : {}),
        ...(assetApiUrl ? { providerAssetApiUrl: assetApiUrl } : {}),
        providerMediaType: verified.mediaType || verified.asset.mediaType,
        providerByteLength: bytes.byteLength,
        disclosure: this.options.disclosure,
        providerCapabilities: { immutableRelease: immutableObserved, assetDigest: Boolean(verified.asset.digest), responseLossReconciliation: true, selectedRepository: true },
        receipt: `provider=github.release-assets; operation=publish; repository=${this.options.owner}/${this.options.repository}; tag=${finalRelease.tagName}; releaseId=${finalRelease.id}; assetId=${verified.asset.id}; assetName=${assetName}; manifestAsset=${manifestName}; releaseDigest=${input.release.releaseDigest}; artifactDigest=${input.artifact.digest}; manifestDigest=${manifestDigest}; bytes=${bytes.byteLength}; mediaType=${verified.mediaType || verified.asset.mediaType}; disclosure=${this.options.disclosure}; duplicateRelease=${duplicateRelease}; duplicateArtifact=${artifactResult.duplicate}; duplicateManifest=${manifestResult.duplicate}; immutableObserved=${immutableObserved}; capability=${this.options.capabilityReceipt}`,
      },
      receipt: `provider=github.release-assets; operation=publish; releaseId=${finalRelease.id}; assetId=${verified.asset.id}; responseLossReconciliation=true; credentialMaterialStored=false`,
    };
  }
}

class GitHubReleaseAssetsHttpError extends Error {
  readonly retryable: boolean;
  readonly responseLost: boolean;
  readonly receipt: string;

  constructor(input: { message: string; retryable: boolean; responseLost: boolean; receipt: string }) {
    super(input.message);
    this.name = "GitHubReleaseAssetsHttpError";
    this.retryable = input.retryable;
    this.responseLost = input.responseLost;
    this.receipt = input.receipt;
  }
}

function parseAsset(value: unknown): GitHubReleaseAsset {
  const data = value as JsonRecord;
  const id = data.id;
  const name = data.name;
  const size = data.size;
  const mediaType = data.content_type;
  if ((typeof id !== "number" && typeof id !== "string") || typeof name !== "string" || !Number.isSafeInteger(Number(size)) || typeof mediaType !== "string") throw new Error("github_release_asset_malformed");
  const digestValue = typeof data.digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(data.digest) ? data.digest : undefined;
  const apiUrl = typeof data.url === "string" ? safeUrl(data.url, "asset.apiUrl") : undefined;
  const browserDownloadUrl = typeof data.browser_download_url === "string" ? safeUrl(data.browser_download_url, "asset.browserDownloadUrl") : undefined;
  return { id: String(id), name, size: Number(size), mediaType, ...(apiUrl ? { apiUrl } : {}), ...(browserDownloadUrl ? { browserDownloadUrl } : {}), ...(digestValue ? { digest: digestValue } : {}) };
}

function parseRelease(value: unknown): GitHubRelease {
  const data = value as JsonRecord;
  const id = data.id;
  const tagName = data.tag_name;
  const draft = data.draft;
  const htmlUrl = data.html_url;
  if ((typeof id !== "number" && typeof id !== "string") || typeof tagName !== "string" || typeof draft !== "boolean" || typeof htmlUrl !== "string") throw new Error("github_release_malformed");
  const assets = Array.isArray(data.assets) ? data.assets.map(parseAsset) : [];
  return { id: String(id), tagName, draft, ...(typeof data.immutable === "boolean" ? { immutable: data.immutable } : {}), htmlUrl: safeUrl(htmlUrl, "release.htmlUrl") ?? htmlUrl, assets };
}

/** A small fetch-backed GitHub REST client; credentials are request-scoped. */
export class FetchGitHubReleaseAssetsClient implements GitHubReleaseAssetsClient {
  private readonly apiBaseUrl: string;
  private readonly uploadBaseUrl: string;
  private readonly retry: { delaysMs: readonly number[]; sizingReceipt: string };
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(input: GitHubReleaseAssetsHttpOptions = {}) {
    this.apiBaseUrl = input.apiBaseUrl ?? "https://api.github.com";
    this.uploadBaseUrl = input.uploadBaseUrl ?? "https://uploads.github.com";
    for (const [name, value] of [["apiBaseUrl", this.apiBaseUrl], ["uploadBaseUrl", this.uploadBaseUrl]] as const) {
      const url = new URL(value);
      if (url.protocol !== "https:" || !["api.github.com", "uploads.github.com"].includes(url.hostname)) throw new Error(`${name}=host-invalid`);
    }
    this.retry = input.retry ?? { delaysMs: [], sizingReceipt: "qualification=caller-supplied; retry=none" };
    if (this.retry.delaysMs.some((delay) => !Number.isInteger(delay) || delay < 0) || this.retry.sizingReceipt.trim().length === 0) throw new Error("retry=invalid");
    safeReceipt(this.retry.sizingReceipt, "retry.sizingReceipt");
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.sleep = input.sleep ?? (async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async findReleaseByTag(input: { owner: string; repository: string; tagName: string; token: string }): Promise<GitHubRelease | null> {
    const owner = safeRepositoryPart(input.owner, "owner");
    const repository = safeRepositoryPart(input.repository, "repository");
    const tagName = safeTag(input.tagName);
    const response = await this.requestJson("GET", `/repos/${owner}/${repository}/releases/tags/${encodeURIComponent(tagName)}`, input.token, undefined, true);
    if (response !== null) return parseRelease(response);
    // GitHub's tag lookup does not expose draft Releases, but the collection
    // does. Reconcile drafts before treating a deterministic tag as absent.
    const listed = await this.requestJson("GET", `/repos/${owner}/${repository}/releases`, input.token);
    if (!Array.isArray(listed)) throw new Error("github_releases_list_malformed");
    return listed.map(parseRelease).find((release) => release.tagName === tagName) ?? null;
  }

  async createDraftRelease(input: { owner: string; repository: string; tagName: string; token: string }): Promise<GitHubRelease> {
    const data = await this.requestJson("POST", `/repos/${safeRepositoryPart(input.owner, "owner")}/${safeRepositoryPart(input.repository, "repository")}/releases`, input.token, { tag_name: safeTag(input.tagName), name: safeTag(input.tagName), draft: true, prerelease: false, generate_release_notes: false });
    return parseRelease(data);
  }

  async inspectRelease(input: { owner: string; repository: string; releaseId: string; token: string }): Promise<GitHubRelease> {
    const data = await this.requestJson("GET", `/repos/${safeRepositoryPart(input.owner, "owner")}/${safeRepositoryPart(input.repository, "repository")}/releases/${encodeURIComponent(required(input.releaseId, "releaseId"))}`, input.token);
    return parseRelease(data);
  }

  async uploadAsset(input: { owner: string; repository: string; releaseId: string; name: string; mediaType: string; bytes: Uint8Array; token: string }): Promise<GitHubReleaseAsset> {
    const owner = safeRepositoryPart(input.owner, "owner");
    const repository = safeRepositoryPart(input.repository, "repository");
    const releaseId = required(input.releaseId, "releaseId");
    const name = safeAssetName(input.name);
    const response = await this.requestRaw("POST", `${this.uploadBaseUrl}/repos/${owner}/${repository}/releases/${encodeURIComponent(releaseId)}/assets?name=${encodeURIComponent(name)}`, input.token, input.bytes, input.mediaType);
    const data = JSON.parse(response.body) as unknown;
    return parseAsset(data);
  }

  async downloadAsset(input: { owner: string; repository: string; releaseId: string; asset: GitHubReleaseAsset; token: string }): Promise<{ bytes: Uint8Array; mediaType: string; receipt: string }> {
    const url = input.asset.apiUrl ?? `https://api.github.com/repos/${safeRepositoryPart(input.owner, "owner")}/${safeRepositoryPart(input.repository, "repository")}/releases/assets/${encodeURIComponent(required(input.asset.id, "asset.id"))}`;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["api.github.com", "github.com"].includes(parsed.hostname)) throw new Error("assetDownloadUrl=host-invalid");
    const response = await this.requestRaw("GET", parsed.toString(), input.token, undefined, undefined, true, { accept: "application/octet-stream" });
    return { bytes: new Uint8Array(response.bytes), mediaType: response.mediaType || input.asset.mediaType, receipt: response.receipt };
  }

  async publishRelease(input: { owner: string; repository: string; releaseId: string; token: string }): Promise<GitHubRelease> {
    const data = await this.requestJson("PATCH", `/repos/${safeRepositoryPart(input.owner, "owner")}/${safeRepositoryPart(input.repository, "repository")}/releases/${encodeURIComponent(required(input.releaseId, "releaseId"))}`, input.token, { draft: false });
    return parseRelease(data);
  }

  async deleteRelease(input: { owner: string; repository: string; releaseId: string; token: string }): Promise<void> {
    await this.requestRaw("DELETE", `${this.apiBaseUrl}/repos/${safeRepositoryPart(input.owner, "owner")}/${safeRepositoryPart(input.repository, "repository")}/releases/${encodeURIComponent(required(input.releaseId, "releaseId"))}`, input.token);
  }

  private async requestJson(method: "GET" | "POST" | "PATCH", path: string, token: string, body?: unknown, notFoundIsNull = false): Promise<unknown | null> {
    const response = await this.requestRaw(method, `${this.apiBaseUrl}${path}`, token, body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8"), body === undefined ? undefined : "application/json", notFoundIsNull);
    if (notFoundIsNull && response.status === 404) return null;
    return response.body.length === 0 ? {} : JSON.parse(response.body) as unknown;
  }

  private async requestRaw(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, body?: Uint8Array, contentType?: string, notFoundIsNull = false, extraHeaders?: Readonly<Record<string, string>>): Promise<{ status: number; body: string; bytes: ArrayBuffer; mediaType: string; receipt: string }> {
    required(token, "token");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["api.github.com", "uploads.github.com", "github.com"].includes(parsed.hostname)) throw new Error("apiUrl=host-invalid");
    for (let attempt = 0; attempt <= this.retry.delaysMs.length; attempt += 1) {
      let response: Response;
      try {
        const request: RequestInit = { method, headers: { accept: "application/vnd.github+json", ...(contentType ? { "content-type": contentType } : {}), ...(extraHeaders ?? {}), authorization: `Bearer ${token}` } };
        if (body !== undefined) request.body = body as unknown as BodyInit;
        response = await this.fetchImpl(url, request);
      } catch {
        throw new GitHubReleaseAssetsHttpError({ message: "GitHub provider request failed before a response was observed.", retryable: true, responseLost: method !== "GET", receipt: `provider=github.release-assets; http=${method}; response=not-observed; attempt=${attempt + 1}; credentialMaterialStored=false` });
      }
      const bytes = await response.arrayBuffer();
      const text = new TextDecoder().decode(bytes);
      const retryable = response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500;
      const receipt = `provider=github.release-assets; http=${method}; status=${response.status}; attempt=${attempt + 1}; retryable=${retryable}; backoff=${this.retry.sizingReceipt}; credentialMaterialStored=false`;
      if (response.status >= 200 && response.status < 300) return { status: response.status, body: text, bytes, mediaType: response.headers.get("content-type")?.split(";", 1)[0] ?? "", receipt };
      if (notFoundIsNull && response.status === 404) return { status: response.status, body: text, bytes, mediaType: "", receipt };
      const delay = this.retry.delaysMs[attempt];
      if (retryable && delay !== undefined) {
        await this.sleep(delay);
        continue;
      }
      throw new GitHubReleaseAssetsHttpError({ message: `GitHub provider request returned HTTP ${response.status}.`, retryable, responseLost: false, receipt });
    }
    throw new GitHubReleaseAssetsHttpError({ message: "GitHub provider retry policy was exhausted.", retryable: true, responseLost: method !== "GET", receipt: `provider=github.release-assets; http=${method}; retry=exhausted; backoff=${this.retry.sizingReceipt}; credentialMaterialStored=false` });
  }
}
