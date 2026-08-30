import { createHash, createHmac } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  GitHubAppInstallationTokenIssuer,
  GitHubAppProjectionAdapter,
  GitHubMirrorProducer,
  cleanupGitHubAppDisposable,
  createGitHubMirrorIngestionHttpTransport,
  FetchGitHubAppHttpClient,
  FetchGitHubRestClient,
  NodeGitSmartHttpTransport,
  type GitHubAppInstallation,
  type GitHubReconciliationTask,
  type GitHubAppTokenIssuer,
  type GitHubPullRequestObservation,
} from "../src/portability/github-app.ts";
import { MirrorCoordinator, type MirrorChangeSink } from "../src/portability/mirror.ts";
import { CONTRACT_VERSIONS, type Change, type GitRef, type RepositoryMirror } from "../src/kernel/contracts.ts";
import { RealmAuthorityHttpClient, RealmAuthorityRequestError, type JsonObject } from "../src/portability/realm-authority-client.ts";
import { loadAnyamAuthCredential } from "../packages/create-anyam/src/auth.ts";
import { ANYAM_GITHUB_APP_QUALIFICATION_PATH, ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, ANYAM_GITHUB_APP_QUALIFICATION_SCOPE, type AnyamGitHubAppQualificationOperation } from "../apps/realm-worker/src/qualification-protocol.ts";

const protocol = "anyam.github-app-qualification/v1" as const;
const execFile = promisify(execFileCallback);
type Json = Record<string, unknown>;
type CleanupReceipt = { status: "succeeded" | "blocked" | "not-run"; receipt: string; recoveryAction?: string };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; set it in the same terminal that runs this qualification`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function requireConfiguration(names: readonly string[]): void {
  const missing = names.filter((name) => optional(name) === undefined);
  if (optional("ANYAM_GITHUB_APP_PRIVATE_KEY") === undefined && optional("ANYAM_GITHUB_APP_PRIVATE_KEY_FILE") === undefined) {
    missing.push("ANYAM_GITHUB_APP_PRIVATE_KEY or ANYAM_GITHUB_APP_PRIVATE_KEY_FILE");
  }
  if (missing.length > 0) throw new Error(`missing qualification inputs: ${missing.join(", ")}; set them in the same terminal that runs this qualification`);
}

function positiveInteger(name: string): number {
  const raw = required(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer; received ${JSON.stringify(raw)}`);
  return value;
}

function commaSeparatedIntegers(name: string): number[] {
  const values = required(name).split(",").map((value) => Number(value.trim()));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error(`${name} must contain non-negative integer milliseconds`);
  return values;
}

function privateKey(): string {
  const file = optional("ANYAM_GITHUB_APP_PRIVATE_KEY_FILE");
  const value = file ? readFileSync(file, "utf8") : required("ANYAM_GITHUB_APP_PRIVATE_KEY");
  return value.replaceAll("\\n", "\n");
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

function refs(entries: readonly [string, string][]): GitRef[] {
  return entries.map(([name, oid]) => ({ name, oid }));
}

function runGit(directory: string, args: readonly string[], maxBufferBytes: number): Promise<string> {
  return execFile("git", [...args], { cwd: directory, maxBuffer: maxBufferBytes }).then(({ stdout }) => stdout.trim());
}

async function seedRepository(maxBufferBytes: number): Promise<{ directory: string; initialOid: string; secondOid: string; divergentOid: string; proposalBranch: string; proposalInitialOid: string; proposalSecondOid: string; bundlePath: string; bundleDigest: string }> {
  const directory = mkdtempSync(join(tmpdir(), "anyam-github-app-qualification-"));
  await runGit(directory, ["init", "-b", "main"], maxBufferBytes);
  await runGit(directory, ["config", "user.name", "Anyam GitHub App qualification"], maxBufferBytes);
  await runGit(directory, ["config", "user.email", "qualification@anyam.dev"], maxBufferBytes);
  writeFileSync(join(directory, "README.md"), "Anyam GitHub App qualification\n");
  await runGit(directory, ["add", "README.md"], maxBufferBytes);
  await runGit(directory, ["commit", "-m", "Seed public Source Space"], maxBufferBytes);
  const initialOid = await runGit(directory, ["rev-parse", "HEAD"], maxBufferBytes);
  const bundlePath = join(directory, "qualification-initial.bundle");
  await runGit(directory, ["bundle", "create", bundlePath, "refs/heads/main"], maxBufferBytes);
  await runGit(directory, ["bundle", "verify", bundlePath], maxBufferBytes);
  const bundleDigest = digest(readFileSync(bundlePath));

  const proposalBranch = "qualification-pr";
  await runGit(directory, ["checkout", "-b", proposalBranch], maxBufferBytes);
  writeFileSync(join(directory, "README.md"), "Anyam GitHub App qualification\nPull request initial revision\n");
  await runGit(directory, ["commit", "-am", "Create disposable pull request"], maxBufferBytes);
  const proposalInitialOid = await runGit(directory, ["rev-parse", "HEAD"], maxBufferBytes);
  writeFileSync(join(directory, "README.md"), "Anyam GitHub App qualification\nPull request successive revision\n");
  await runGit(directory, ["commit", "-am", "Advance disposable pull request"], maxBufferBytes);
  const proposalSecondOid = await runGit(directory, ["rev-parse", "HEAD"], maxBufferBytes);

  await runGit(directory, ["checkout", "main"], maxBufferBytes);
  writeFileSync(join(directory, "README.md"), "Anyam GitHub App qualification\nInbound proposal revision\n");
  await runGit(directory, ["commit", "-am", "Record inbound proposal revision"], maxBufferBytes);
  const secondOid = await runGit(directory, ["rev-parse", "HEAD"], maxBufferBytes);

  await runGit(directory, ["checkout", "--orphan", "divergent"], maxBufferBytes);
  writeFileSync(join(directory, "README.md"), "Anyam divergent qualification state\n");
  await runGit(directory, ["add", "README.md"], maxBufferBytes);
  await runGit(directory, ["commit", "-m", "Create explicit force-push divergence"], maxBufferBytes);
  const divergentOid = await runGit(directory, ["rev-parse", "HEAD"], maxBufferBytes);
  await runGit(directory, ["update-ref", "refs/heads/main", initialOid], maxBufferBytes);
  return { directory, initialOid, secondOid, divergentOid, proposalBranch, proposalInitialOid, proposalSecondOid, bundlePath, bundleDigest };
}

function mirror(input: { repository: string; initialGeneration: string; initialOid?: string }): RepositoryMirror {
  const initialRefs = input.initialOid ? refs([["refs/heads/main", input.initialOid]]) : [];
  return {
    protocol: CONTRACT_VERSIONS.mirror,
    id: "mirror:github-app-qualification",
    projectId: "project:github-app-qualification",
    sourceSpaceId: "source:github-app-qualification-public",
    provider: "github",
    remoteRepository: input.repository,
    direction: "bidirectional",
    canonicalAuthority: "anyam",
    refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
    disclosure: "public",
    state: "healthy",
    canonicalProjectRevisionId: "project-revision:github-app-qualification:initial",
    canonicalRefs: initialRefs,
    remoteGeneration: input.initialGeneration,
    remoteRefs: initialRefs,
    pendingInboundChangeIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    receipt: "qualification=github-app; sourceSpace=public; canonicalAuthority=anyam; providerRole=projection; providerProtection=not-required; canonicalWrite=false",
  };
}

function changeSink(changes: Change[]): MirrorChangeSink {
  return {
    async createChange(input) {
      const change: Change = {
        protocol: CONTRACT_VERSIONS.change,
        id: `change:github-app-qualification:${input.remoteCommit.oid}`,
        projectId: input.projectId,
        intentId: input.intentId,
        baseProjectRevisionId: input.baseProjectRevisionId,
        status: "submitted",
        latestRevisionId: null,
        origin: { ...input.origin },
      };
      changes.push(change);
      return { status: "succeeded", value: change };
    },
  };
}

function signed(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function proposalRevision(observation: GitHubPullRequestObservation): { changeKey: string; revisionKey: string } {
  return {
    changeKey: digest([observation.repository, observation.number, observation.baseCommit]),
    revisionKey: digest([observation.repository, observation.number, observation.baseCommit, observation.headCommit]),
  };
}

function authorityField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`customer Realm Authority response omitted ${field}`);
  return value.trim();
}

function authorityObject(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`customer Realm Authority response returned a malformed ${field}`);
  return value as JsonObject;
}

function authorityArray(value: unknown, field: string): JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`customer Realm Authority response returned a malformed ${field}`);
  return value.map((entry, index) => authorityObject(entry, `${field}[${index}]`));
}

function authoritySession(): string | undefined {
  const direct = optional("ANYAM_GITHUB_APP_AUTHORITY_OWNER_SESSION");
  const file = optional("ANYAM_GITHUB_APP_AUTHORITY_OWNER_SESSION_FILE");
  if (direct && file) throw new Error("set only one of ANYAM_GITHUB_APP_AUTHORITY_OWNER_SESSION or ANYAM_GITHUB_APP_AUTHORITY_OWNER_SESSION_FILE; credential material is not printed");
  if (file) return readFileSync(file, "utf8").trim();
  return direct;
}

type QualificationAuthorityClient = {
  inspectProject(projectId: string): Promise<JsonObject>;
  inspectState(): Promise<JsonObject>;
  inspectMirror(mirrorId: string): Promise<JsonObject>;
  createProject(body: JsonObject, idempotencyKey: string): Promise<JsonObject>;
  createWorkspace(projectId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject>;
  configureMirror(body: JsonObject, idempotencyKey: string): Promise<JsonObject>;
  syncMirror(mirrorId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject>;
  reconcileMirror(mirrorId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject>;
  exportAuthorityRecovery(): Promise<JsonObject>;
  restoreAuthorityRecovery(bundle: JsonObject): Promise<JsonObject>;
  activateAuthorityRecovery(bundleId: string, bundleDigest: string): Promise<JsonObject>;
};

class OAuthQualificationAuthorityClient implements QualificationAuthorityClient {
  private readonly endpoint: string;

  constructor(private readonly baseUrl: string, private readonly accessToken: string) {
    this.endpoint = new URL(ANYAM_GITHUB_APP_QUALIFICATION_PATH, baseUrl).toString();
  }

  private async request(operation: AnyamGitHubAppQualificationOperation, body: JsonObject = {}): Promise<JsonObject> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${this.accessToken}` },
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({ protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, operation, ...body }),
    });
    const value: unknown = await response.json().catch(() => undefined);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RealmAuthorityRequestError({ status: response.status, code: "qualification_response_invalid", recoveryAction: "inspect the customer Realm qualification capability response and retry the same immutable operation", receipt: `qualification=github-app; operation=${operation}; response=object-required; credentialMaterialStored=false` });
    const payload = value as JsonObject;
    if (!response.ok) throw new RealmAuthorityRequestError({ status: response.status, code: typeof payload.code === "string" ? payload.code : `http_${response.status}`, recoveryAction: typeof payload.recoveryAction === "string" ? payload.recoveryAction : "inspect the customer Realm qualification receipt and retry the same immutable operation", receipt: typeof payload.receipt === "string" ? payload.receipt : `qualification=github-app; operation=${operation}; receipt=not-returned; credentialMaterialStored=false` });
    return payload;
  }

  inspectProject(projectId: string): Promise<JsonObject> { return this.request("authority.project.inspect", { projectId }); }
  inspectState(): Promise<JsonObject> { return this.request("authority.state.inspect"); }
  inspectMirror(mirrorId: string): Promise<JsonObject> { return this.request("authority.mirror.inspect", { mirrorId }); }
  createProject(body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request("authority.project.create", { payload: body, idempotencyKey }); }
  createWorkspace(projectId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request("authority.workspace.create", { payload: { ...body, projectId }, idempotencyKey }); }
  configureMirror(body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request("authority.mirror.configure", { payload: body, idempotencyKey }); }
  syncMirror(mirrorId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request("authority.mirror.mutate", { mirrorId, mirrorOperation: "sync", payload: { ...body, mirrorId }, idempotencyKey }); }
  reconcileMirror(mirrorId: string, body: JsonObject, idempotencyKey: string): Promise<JsonObject> { return this.request("authority.mirror.mutate", { mirrorId, mirrorOperation: "reconcile", payload: { ...body, mirrorId }, idempotencyKey }); }
  exportAuthorityRecovery(): Promise<JsonObject> { return this.request("authority.recovery.export"); }
  restoreAuthorityRecovery(bundle: JsonObject): Promise<JsonObject> { return this.request("authority.recovery.restore", { bundle, idempotencyKey: "qualification:authority-recovery-restore" }); }
  activateAuthorityRecovery(bundleId: string, bundleDigest: string): Promise<JsonObject> { return this.request("authority.recovery.activate", { bundleId, bundleDigest, idempotencyKey: `qualification:authority-recovery-activate:${bundleId}` }); }
}

type AuthorityConfig = { baseUrl: string; ownerSession?: string; oauthAccessToken?: string; authMode: "owner-cookie" | "oauth-keychain" | "oauth-process"; authReceipt: string; mirrorHandoffKeyId: string; mirrorHandoffSecret: string };

function authorityMirrorHandoffSecret(): string | undefined {
  const direct = optional("ANYAM_GITHUB_APP_MIRROR_HANDOFF_SECRET");
  const file = optional("ANYAM_GITHUB_APP_MIRROR_HANDOFF_SECRET_FILE");
  if (direct && file) throw new Error("set only one of ANYAM_GITHUB_APP_MIRROR_HANDOFF_SECRET or ANYAM_GITHUB_APP_MIRROR_HANDOFF_SECRET_FILE; credential material is not printed");
  if (file) return readFileSync(file, "utf8").trim();
  return direct;
}

async function authorityConfig(): Promise<AuthorityConfig | undefined> {
  const baseUrl = optional("ANYAM_GITHUB_APP_AUTHORITY_BASE_URL");
  const ownerSession = authoritySession();
  const directOauthToken = optional("ANYAM_GITHUB_APP_AUTHORITY_OAUTH_TOKEN");
  const configured = [baseUrl, ownerSession, directOauthToken].some((value) => value !== undefined);
  if (!configured) return undefined;
  if (!baseUrl) throw new Error("ANYAM_GITHUB_APP_AUTHORITY_BASE_URL is required when live customer Realm Authority qualification is enabled");
  if (ownerSession && directOauthToken) throw new Error("set only one of the compatibility owner session or ANYAM_GITHUB_APP_AUTHORITY_OAUTH_TOKEN; credential material is never printed");
  const staleBinding = [
    "ANYAM_GITHUB_APP_AUTHORITY_PROJECT_ID",
    "ANYAM_GITHUB_APP_AUTHORITY_SOURCE_SPACE_ID",
    "ANYAM_GITHUB_APP_AUTHORITY_PROJECT_REVISION_ID",
    "ANYAM_GITHUB_APP_AUTHORITY_PROJECT_VIEW_ID",
    "ANYAM_GITHUB_APP_AUTHORITY_MIRROR_ID",
  ].find((name) => optional(name) !== undefined);
  if (staleBinding) throw new Error(`${staleBinding} is no longer accepted; the qualification creates a disposable Authority Project and restores the credential-free Realm snapshot after cleanup`);
  const mirrorHandoffKeyId = optional("ANYAM_GITHUB_APP_MIRROR_HANDOFF_KEY_ID");
  const mirrorHandoffSecret = authorityMirrorHandoffSecret();
  if (!mirrorHandoffKeyId || !mirrorHandoffSecret) throw new Error("ANYAM_GITHUB_APP_MIRROR_HANDOFF_KEY_ID and ANYAM_GITHUB_APP_MIRROR_HANDOFF_SECRET (or _FILE) are required when live customer Realm Mirror ingestion qualification is enabled; credential material is not printed");
  if (ownerSession) return { baseUrl, ownerSession, authMode: "owner-cookie", authReceipt: "oauth=compatibility-owner-session; credentialStorage=operator-file-or-process; supportedOAuth=false; credentialMaterialStored=false", mirrorHandoffKeyId, mirrorHandoffSecret };
  const oauth = await loadAnyamAuthCredential({ realm: baseUrl, ...(directOauthToken ? { accessToken: directOauthToken } : {}), ...(optional("ANYAM_GITHUB_APP_AUTHORITY_OAUTH_CLIENT_ID") ? { clientId: optional("ANYAM_GITHUB_APP_AUTHORITY_OAUTH_CLIENT_ID")! } : {}) });
  const grantedScopes = oauth.scope.split(/\s+/u).filter(Boolean);
  if (!grantedScopes.includes(ANYAM_GITHUB_APP_QUALIFICATION_SCOPE)) throw new Error(`stored OAuth credential does not include ${ANYAM_GITHUB_APP_QUALIFICATION_SCOPE}; run anyam auth login --realm ${baseUrl} --client-id <client-id> --scope ${ANYAM_GITHUB_APP_QUALIFICATION_SCOPE}; credential values are not printed`);
  const expectedResource = new URL("/mcp", baseUrl).toString();
  if (oauth.resource !== expectedResource) throw new Error(`stored OAuth credential is bound to ${oauth.resource}, not ${expectedResource}; run anyam auth login again for the Realm qualification resource; credential values are not printed`);
  return { baseUrl, oauthAccessToken: oauth.accessToken, authMode: oauth.credentialStorage === "os-keychain" ? "oauth-keychain" : "oauth-process", authReceipt: oauth.receipt, mirrorHandoffKeyId, mirrorHandoffSecret };
}

function refsValue(value: unknown, field: string): GitRef[] {
  return authorityArray(value, field).map((entry, index) => ({ name: authorityField(entry.name, `${field}[${index}].name`), oid: authorityField(entry.oid, `${field}[${index}].oid`) }));
}

function authorityResultValue(value: JsonObject): JsonObject {
  return value.value === undefined ? value : authorityObject(value.value, "value");
}

function authorityMirrorFromResponse(value: JsonObject): JsonObject {
  return authorityObject(authorityResultValue(value).mirror, "mirror");
}

function authorityMirrorRefs(mirror: JsonObject, field: "canonicalRefs" | "remoteRefs"): GitRef[] {
  return refsValue(mirror[field], `mirror.${field}`);
}

function authorityMirrorGeneration(mirror: JsonObject): string {
  return authorityField(mirror.remoteGeneration, "mirror.remoteGeneration");
}

async function restoreAuthorityRecovery(client: QualificationAuthorityClient, bundle: JsonObject): Promise<CleanupReceipt> {
  try {
    const restored = await client.restoreAuthorityRecovery(bundle);
    if (restored.status !== "recovery-quarantined") return { status: "blocked", receipt: "cleanup=authority-restore-blocked; unexpected-recovery-status; credentialMaterialStored=false", recoveryAction: "authenticate the Realm owner again, inspect the Authority recovery receipt, and restore the exact signed bundle" };
    const readBack = await client.exportAuthorityRecovery();
    const readBackBundle = authorityObject(readBack.bundle, "restored Authority recovery bundle");
    const readBackSnapshot = authorityObject(readBackBundle.snapshot, "restored Authority recovery snapshot");
    const originalSnapshot = authorityObject(bundle.snapshot, "original Authority recovery snapshot");
    if (readBack.credentialFree !== true || digest(readBackSnapshot) !== digest(originalSnapshot)) return { status: "blocked", receipt: "cleanup=authority-restore-blocked; snapshot-read-back-mismatch; credentialMaterialStored=false", recoveryAction: "retain the exact disposable Authority Realm, inspect the signed restore and export receipts, and retry without changing the bundle" };
    const activated = await client.activateAuthorityRecovery(authorityField(restored.bundleId, "bundleId"), authorityField(restored.bundleDigest, "bundleDigest"));
    if (activated.status !== "recovery-activated" && activated.status !== "already-active") return { status: "blocked", receipt: "cleanup=authority-activation-blocked; unexpected-status; credentialMaterialStored=false", recoveryAction: "complete the passkey-authenticated Authority recovery activation ceremony with the exact quarantined bundle" };
    return { status: "succeeded", receipt: "cleanup=authority-recovery-restored; authority-state-replaced; quarantine-read-back-verified; passkey-activation-verified; identity-sessions-untouched; credentialMaterialStored=false" };
  } catch (error) {
    return { status: "blocked", receipt: `cleanup=authority-restore-blocked; errorClass=${error instanceof Error ? error.name : "unknown"}; credentialMaterialStored=false`, recoveryAction: "authenticate the Realm owner again, inspect the Authority recovery receipt, and restore the exact exported snapshot" };
  }
}

async function qualifyCustomerRealmAuthority(input: {
  seeded: Awaited<ReturnType<typeof seedRepository>>;
  repository: string;
  installationId: string;
  qualificationId: string;
  webhookSecret: string;
  authorityClient: QualificationAuthorityClient;
  authorityConfig: AuthorityConfig;
  adapter: GitHubAppProjectionAdapter;
  forcePush: Extract<Awaited<ReturnType<GitHubAppProjectionAdapter["push"]>>, { status: "succeeded" }>;
  reconciled: Extract<Awaited<ReturnType<MirrorCoordinator["sync"]>>, { status: "succeeded" }>;
  pullRequestNumber: number;
  observedPr: GitHubPullRequestObservation;
  proposalRevisionPush: { receipt: string };
  waitForSecond: { second?: { changeKey: string; revisionKey: string }; attempts: number };
}): Promise<JsonObject> {
  const client = input.authorityClient;
  const suffix = digest([input.qualificationId, input.seeded.initialOid]).slice("sha256:".length, "sha256:".length + 24);
  const projectId = `project:github-app-qualification:${suffix}`;
  const sourceSpaceId = `source:github-app-qualification-public:${suffix}`;
  const projectRevisionId = `project-revision:github-app-qualification:${suffix}`;
  const workspaceId = `workspace:github-app-qualification:${suffix}`;
  const projectionId = `projection:github-app-qualification-public:${suffix}`;
  const mirrorId = `mirror:github-app-qualification:${suffix}`;
  const repositoryId = `repository:github-app-qualification:${suffix}`;
  const createdProject = authorityResultValue(await client.createProject({ projectId, name: "Anyam GitHub App qualification", referenceType: "git", sourceSpaces: [{ id: sourceSpaceId, name: "Qualification public", classification: "public", snapshotId: input.seeded.initialOid, repositoryId }], projectRevisionId }, `github-app:${input.qualificationId}:authority:project-create`));
  const createdCanonical = authorityObject(createdProject.canonicalRevision, "createdProject.canonicalRevision");
  if (authorityField(createdCanonical.id, "createdProject.canonicalRevision.id") !== projectRevisionId) throw new Error("customer Realm Authority created a different canonical Project Revision than requested");
  // Omit mounts so the Authority applies its canonical Source Space mount
  // default; an explicit empty array is rejected by the typed workspace route.
  const createdWorkspace = authorityResultValue(await client.createWorkspace(projectId, { workspaceId, projectRevisionId, sourceSpaceIds: [sourceSpaceId], projectionId, classification: "public" }, `github-app:${input.qualificationId}:authority:workspace-create`));
  const createdView = authorityObject(createdWorkspace.view, "createdWorkspace.view");
  const projectViewId = authorityField(createdView.id, "createdWorkspace.view.id");
  const mirrorPayload = { mirrorId, projectId, sourceSpaceId, provider: "github", remoteRepository: input.repository, refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }], disclosure: "public", state: "healthy", canonicalProjectRevisionId: projectRevisionId, canonicalRefs: [{ name: "refs/heads/main", oid: input.seeded.initialOid }], remoteGeneration: "qualification:empty", remoteRefs: [], pendingInboundChangeIds: [], receipt: "qualification=github-app-authority; setup=disposable-mirror; credentialMaterialStored=false" };
  const mirrorIdempotencyKey = `github-app:${input.qualificationId}:authority:mirror-configure`;
  let configuredMirror: JsonObject;
  try {
    configuredMirror = await client.configureMirror(mirrorPayload, mirrorIdempotencyKey);
  } catch (error) {
    if (!(error instanceof RealmAuthorityRequestError) || error.status < 500) throw error;
    configuredMirror = await client.configureMirror(mirrorPayload, mirrorIdempotencyKey);
  }
  authorityMirrorFromResponse(configuredMirror);
  const config = { ...input.authorityConfig, projectId, sourceSpaceId, projectRevisionId, projectViewId, mirrorId };
  const state = await client.inspectState();
  const authorityState = authorityObject(state.authority, "authority state");
  const realmId = authorityField(authorityState.realmId, "authority.realmId");
  const projectResponse = await client.inspectProject(config.projectId);
  const project = authorityObject(projectResponse.project, "project");
  const canonicalRevision = authorityObject(projectResponse.canonicalRevision, "canonicalRevision");
  const sourceSpaces = authorityArray(projectResponse.sourceSpaces, "sourceSpaces");
  if (authorityField(project.id, "project.id") !== config.projectId) throw new Error("customer Realm Authority returned a different Project identity");
  if (authorityField(canonicalRevision.id, "canonicalRevision.id") !== config.projectRevisionId) throw new Error("customer Realm Authority canonical Project Revision does not match the qualification binding");
  if (authorityField(canonicalRevision.projectId, "canonicalRevision.projectId") !== config.projectId) throw new Error("customer Realm Authority canonical Project Revision is bound to a different Project");
  const source = sourceSpaces.find((entry) => entry.id === config.sourceSpaceId);
  if (!source || authorityField(source.classification, "sourceSpace.classification") !== "public") throw new Error("customer Realm Authority qualification requires the bound Source Space to be public");
  if (authorityField(source.repositoryId, "sourceSpace.repositoryId") !== repositoryId) throw new Error("customer Realm Authority Source Space did not retain the Realm-issued Repository identity");
  const initialSnapshot = authorityField((canonicalRevision.sourceSpaceSnapshots as Record<string, unknown> | undefined)?.[config.sourceSpaceId], "canonicalRevision.sourceSpaceSnapshots");
  if (initialSnapshot !== input.seeded.initialOid) throw new Error(`customer Realm Authority canonical Source Space snapshot ${initialSnapshot} does not match the seeded provider snapshot ${input.seeded.initialOid}; recreate the disposable Authority binding for this qualification`);
  const initialMirrorResponse = await client.inspectMirror(config.mirrorId);
  const initialMirror = authorityMirrorFromResponse(initialMirrorResponse);
  if (authorityField(initialMirror.id, "mirror.id") !== config.mirrorId || authorityField(initialMirror.projectId, "mirror.projectId") !== config.projectId || authorityField(initialMirror.sourceSpaceId, "mirror.sourceSpaceId") !== config.sourceSpaceId || authorityField(initialMirror.provider, "mirror.provider") !== "github" || authorityField(initialMirror.remoteRepository, "mirror.remoteRepository") !== input.repository) throw new Error("customer Realm Authority Mirror binding does not match the selected GitHub App repository and public Source Space");
  if (authorityField(initialMirror.canonicalProjectRevisionId, "mirror.canonicalProjectRevisionId") !== config.projectRevisionId) throw new Error("customer Realm Authority Mirror is bound to a stale canonical Project Revision");
  if (authorityField(initialMirror.remoteGeneration, "mirror.remoteGeneration") !== "qualification:empty" || authorityMirrorRefs(initialMirror, "remoteRefs").length !== 0) throw new Error("customer Realm Authority Mirror is not at the required empty disposable remote boundary");
  if (authorityMirrorRefs(initialMirror, "canonicalRefs").some((ref) => ref.name !== "refs/heads/main" || ref.oid !== input.seeded.initialOid)) throw new Error("customer Realm Authority Mirror canonical refs do not match the seeded qualification ref");

  const canonicalRefs = [{ name: "refs/heads/main", oid: input.seeded.initialOid }];
  const providerCurrent = input.reconciled.value.mirror;
  if (providerCurrent.remoteRefs.length !== 1 || providerCurrent.remoteRefs[0]?.name !== "refs/heads/main" || providerCurrent.remoteRefs[0]?.oid !== input.seeded.initialOid) throw new Error("provider Mirror was not at the canonical ref before the Authority producer qualification");
  const authorityOutbound = await client.syncMirror(config.mirrorId, {
    canonicalProjectRevisionId: config.projectRevisionId,
    canonicalRefs,
    expectedRemoteGeneration: "qualification:empty",
    remoteGeneration: providerCurrent.remoteGeneration,
    remoteRefs: providerCurrent.remoteRefs,
    operationId: `github-app:${input.qualificationId}:authority:outbound`,
    checkpointId: `checkpoint:github-app:${input.qualificationId}:authority:outbound`,
    operationKind: "outbound",
    operationState: "succeeded",
    mirrorState: "healthy",
    inboundChangeIds: [],
    completedInboundChangeIds: [],
    pendingInboundChangeIds: [],
    receipt: "qualification=github-app-authority; operation=outbound; provider=github-app; credentialMaterialStored=false",
  }, `github-app:${input.qualificationId}:authority:outbound`);
  const afterOutbound = authorityMirrorFromResponse(authorityOutbound);
  if (authorityMirrorGeneration(afterOutbound) !== providerCurrent.remoteGeneration) throw new Error("customer Realm Authority outbound Mirror generation did not bind to the provider generation used by the signed producer");
  const providerInboundPush = await input.adapter.push({
    mirror: providerCurrent,
    expectedGeneration: providerCurrent.remoteGeneration,
    expectedRefs: providerCurrent.remoteRefs,
    desiredRefs: [{ name: "refs/heads/main", oid: input.seeded.secondOid }],
    operationId: `github-app:${input.qualificationId}:authority:producer-inbound`,
    idempotencyKey: `github-app:${input.qualificationId}:authority:producer-inbound`,
  });
  if (providerInboundPush.status !== "succeeded") throw new Error(`provider inbound producer seed failed: ${providerInboundPush.errorCode}; ${providerInboundPush.recoveryAction}`);
  const producerMirror: RepositoryMirror = {
    ...providerCurrent,
    id: config.mirrorId,
    projectId: config.projectId,
    sourceSpaceId: config.sourceSpaceId,
    canonicalProjectRevisionId: config.projectRevisionId,
    canonicalRefs,
    remoteGeneration: providerCurrent.remoteGeneration,
    remoteRefs: providerCurrent.remoteRefs.map((ref) => ({ ...ref })),
    pendingInboundChangeIds: [],
    receipt: "qualification=github-app-authority; producer=mirror-ingestion; credentialMaterialStored=false",
  };
  const producer = new GitHubMirrorProducer({
    adapter: input.adapter,
    mirror: producerMirror,
    realmId,
    repositoryId,
    projectViewId: config.projectViewId,
    canonicalProjectRevisionId: config.projectRevisionId,
    canonicalRefs,
    installationId: input.installationId,
    handoffKeyId: input.authorityConfig.mirrorHandoffKeyId,
    handoffSecret: input.authorityConfig.mirrorHandoffSecret,
    ingest: createGitHubMirrorIngestionHttpTransport({ baseUrl: config.baseUrl }),
  });
  const authorityInboundDeliveryId = `delivery:github-app:${input.qualificationId}:producer-inbound`;
  const producerWebhookBody = JSON.stringify({ ref: "refs/heads/main", before: input.seeded.initialOid, after: input.seeded.secondOid, forced: false, deleted: false, repository: { full_name: input.repository }, installation: { id: input.installationId } });
  const producerWebhook = { body: producerWebhookBody, event: "push", deliveryId: authorityInboundDeliveryId, signature: signed(producerWebhookBody, input.webhookSecret), secret: input.webhookSecret, mirrorId: config.mirrorId, mappedRemoteRefs: ["refs/heads/main"] } as const;
  const authorityInbound = await producer.processWebhook(producerWebhook);
  if (authorityInbound.status !== "succeeded") throw new Error(`customer Realm signed Mirror producer did not ingest the provider delivery: ${authorityInbound.recoveryAction ?? authorityInbound.receipt}`);
  const authorityInboundDuplicate = await producer.processWebhook(producerWebhook);
  if (authorityInboundDuplicate.status !== "succeeded" || authorityInboundDuplicate.webhook.status !== "duplicate") throw new Error(`customer Realm signed Mirror producer did not deduplicate the redelivered provider delivery: state=${authorityInboundDuplicate.status}; webhook=${authorityInboundDuplicate.webhook.status}`);
  const authorityInboundReadBack = await client.inspectMirror(config.mirrorId);
  const authorityInboundMirror = authorityMirrorFromResponse(authorityInboundReadBack);
  const authorityInboundProposalKey = "ref:refs/heads/main";
  const authorityInboundProposal = authorityArray(authorityInboundReadBack.proposals, "authorityInbound.proposals").find((proposal) => proposal.proposalKey === authorityInboundProposalKey && proposal.latestHeadCommit === input.seeded.secondOid);
  if (!authorityInboundProposal) throw new Error("customer Realm signed Mirror ingestion did not create the expected inbound external proposal");
  const authorityInboundChangeId = authorityField(authorityInboundProposal.changeId, "authorityInbound.proposal.changeId");
  const authorityInboundRevisionIds = authorityInboundProposal.changeRevisionIds;
  if (!Array.isArray(authorityInboundRevisionIds) || authorityInboundRevisionIds.length !== 1 || authorityMirrorGeneration(authorityInboundMirror) !== providerInboundPush.value.generation) throw new Error("customer Realm signed Mirror ingestion did not persist the exact provider generation and one inbound Change Revision");

  const authorityForcePush = await client.syncMirror(config.mirrorId, {
    canonicalProjectRevisionId: config.projectRevisionId,
    canonicalRefs,
    expectedRemoteGeneration: authorityMirrorGeneration(authorityInboundMirror),
    remoteGeneration: input.forcePush.value.generation,
    remoteRefs: [{ name: "refs/heads/main", oid: input.seeded.divergentOid }],
    operationId: `github-app:${input.qualificationId}:authority:force-push`,
    checkpointId: `checkpoint:github-app:${input.qualificationId}:authority:force-push`,
    operationKind: "sync",
    operationState: "failed",
    mirrorState: "divergent",
    ...(authorityInboundChangeId ? { inboundChangeIds: [authorityInboundChangeId], pendingInboundChangeIds: [authorityInboundChangeId] } : { inboundChangeIds: [], pendingInboundChangeIds: [] }),
    completedInboundChangeIds: [],
    errorCode: "mirror.force_push_detected",
    recoveryAction: "choose canonical-wins after inspecting the explicit remote rewrite",
    receipt: "qualification=github-app-authority; operation=force-push; provider=github-app; credentialMaterialStored=false",
  }, `github-app:${input.qualificationId}:authority:force-push`);
  const forceMirror = authorityMirrorFromResponse(authorityForcePush);
  const authorityReconciled = await client.reconcileMirror(config.mirrorId, {
    canonicalProjectRevisionId: config.projectRevisionId,
    canonicalRefs,
    expectedRemoteGeneration: authorityMirrorGeneration(forceMirror),
    remoteGeneration: input.reconciled.value.mirror.remoteGeneration,
    remoteRefs: canonicalRefs,
    operationId: `github-app:${input.qualificationId}:authority:canonical-wins`,
    checkpointId: `checkpoint:github-app:${input.qualificationId}:authority:canonical-wins`,
    operationKind: "reconcile",
    operationState: "succeeded",
    mirrorState: "healthy",
    inboundChangeIds: [],
    completedInboundChangeIds: [],
    pendingInboundChangeIds: [],
    ...(typeof forceMirror.checkpointId === "string" ? { resumeCheckpointId: forceMirror.checkpointId } : {}),
    reconciliation: "canonical-wins",
    receipt: "qualification=github-app-authority; operation=canonical-wins; provider=github-app; credentialMaterialStored=false",
  }, `github-app:${input.qualificationId}:authority:canonical-wins`);
  const afterReconcile = authorityMirrorFromResponse(authorityReconciled);

  const proposalKey = `pr:${input.pullRequestNumber}`;
  const prProposal = (headCommit: string, deliveryId: string): JsonObject => ({ provider: "github", installationId: input.installationId, sourceIdentity: `github-app:${input.installationId}`, remoteRepository: input.repository, proposalKind: "pull-request", proposalKey, latestHeadCommit: headCommit, baseProjectRevisionId: config.projectRevisionId, projectViewId: config.projectViewId, disclosure: "public", receipt: `qualification=github-app-authority; proposal=pull-request; head=${headCommit}; credentialMaterialStored=false`, remoteRef: `refs/heads/${input.observedPr.headRef}`, baseRef: input.observedPr.baseRef, baseCommit: input.seeded.initialOid, sourceSpaceSnapshots: { [config.sourceSpaceId]: headCommit }, status: "open" });
  const prSync = async (headCommit: string, deliveryId: string, operationSuffix: string): Promise<JsonObject> => {
    const currentMirrorResponse = await client.inspectMirror(config.mirrorId);
    const currentMirror = authorityMirrorFromResponse(currentMirrorResponse);
    const currentGeneration = authorityMirrorGeneration(currentMirror);
    return client.syncMirror(config.mirrorId, { canonicalProjectRevisionId: config.projectRevisionId, canonicalRefs, expectedRemoteGeneration: currentGeneration, remoteGeneration: currentGeneration, remoteRefs: canonicalRefs, operationId: `github-app:${input.qualificationId}:authority:${operationSuffix}`, checkpointId: `checkpoint:github-app:${input.qualificationId}:authority:${operationSuffix}`, operationKind: "sync", operationState: "succeeded", mirrorState: "healthy", inboundChangeIds: [], completedInboundChangeIds: [], pendingInboundChangeIds: [], delivery: { provider: "github", installationId: input.installationId, sourceIdentity: `github-app:${input.installationId}`, remoteRepository: input.repository, deliveryId, eventType: operationSuffix === "pr-opened" ? "pull_request.opened" : "pull_request.synchronize", proposalKey }, externalProposal: prProposal(headCommit, deliveryId), receipt: `qualification=github-app-authority; operation=${operationSuffix}; credentialMaterialStored=false` }, `github-app:${input.qualificationId}:authority:${operationSuffix}`);
  };
  const authorityPrFirst = await prSync(input.observedPr.headCommit, `delivery:github-app:${input.qualificationId}:pr-opened`, "pr-opened");
  const authorityPrSecond = await prSync(input.seeded.proposalSecondOid, `delivery:github-app:${input.qualificationId}:pr-synchronize`, "pr-synchronize");
  const authorityPrDuplicate = await prSync(input.seeded.proposalSecondOid, `delivery:github-app:${input.qualificationId}:pr-synchronize`, "pr-synchronize-duplicate");
  const finalMirrorResponse = await client.inspectMirror(config.mirrorId);
  const finalMirror = authorityMirrorFromResponse(finalMirrorResponse);
  const exportedDigest = digest(finalMirrorResponse);
  const readBackResponse = await client.inspectMirror(config.mirrorId);
  const readBackDigest = digest(readBackResponse);
  if (exportedDigest !== readBackDigest) throw new Error(`customer Realm Authority Mirror ledger read-back digest ${readBackDigest} did not match export digest ${exportedDigest}`);
  const proposal = authorityObject(authorityResultValue(authorityPrSecond).proposal, "authority PR proposal");
  const revisionIds = Array.isArray(proposal.changeRevisionIds) ? proposal.changeRevisionIds : [];
  if (typeof proposal.changeId !== "string" || revisionIds.length < 2) throw new Error("customer Realm Authority did not preserve one PR Change with successive Revisions");
  const duplicateReceipt = typeof authorityPrDuplicate.receipt === "string" ? authorityPrDuplicate.receipt : "";
  if (!duplicateReceipt.includes("duplicate=true")) throw new Error("customer Realm Authority did not deduplicate the repeated PR delivery");
  const outboundValue = authorityResultValue(authorityOutbound);
  return { status: "succeeded", realm: { baseUrl: config.baseUrl, projectId: config.projectId, sourceSpaceId: config.sourceSpaceId, repositoryId, projectRevisionId: config.projectRevisionId, projectViewId: config.projectViewId, mirrorId: config.mirrorId }, stateReceipt: authorityField(state.receipt, "authority.receipt"), outbound: { status: authorityOutbound.status, operation: authorityField(authorityObject(outboundValue.operation, "outbound.operation").id, "outbound.operation.id") }, inbound: { status: authorityInbound.status, producerReceipt: authorityInbound.receipt, duplicateDelivery: authorityInboundDuplicate.webhook.status === "duplicate", changeId: authorityInboundChangeId ?? "missing", changeRevisionCount: authorityInboundRevisionIds.length, deliveryId: authorityInboundDeliveryId, providerGeneration: providerInboundPush.value.generation }, forcePush: { status: authorityForcePush.status, mirrorState: authorityField(forceMirror.state, "forcePush.mirror.state") }, reconciliation: { status: authorityReconciled.status, mirrorState: authorityField(afterReconcile.state, "reconciliation.mirror.state") }, pullRequest: { proposalKey, changeId: authorityField(proposal.changeId, "proposal.changeId"), revisionCount: revisionIds.length, stableChange: true, successiveRevisions: true, duplicateDelivery: true, setupReceipt: input.proposalRevisionPush.receipt, observationAttempts: input.waitForSecond.attempts }, mirrorLedgerReadBack: { exportedDigest, readBackDigest, readBackVerified: true }, credentialValues: "not-printed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true, finalMirrorState: authorityField(finalMirror.state, "finalMirror.state") };
}

async function waitForSecondProposalRevision(input: { adapter: GitHubAppProjectionAdapter; first: GitHubPullRequestObservation; number: number; waitMs: number; pollMs: number; fallbackHeadCommit?: string }): Promise<{ first: { changeKey: string; revisionKey: string }; second?: { changeKey: string; revisionKey: string }; attempts: number; lastHeadCommit: string; headSource: "pull-request-api" | "git-ref-readback" }> {
  const first = proposalRevision(input.first);
  const started = Date.now();
  let attempts = 1;
  let lastHeadCommit = input.first.headCommit;
  if (input.fallbackHeadCommit && input.fallbackHeadCommit !== input.first.headCommit) {
    return { first, second: proposalRevision({ ...input.first, headCommit: input.fallbackHeadCommit }), attempts, lastHeadCommit: input.fallbackHeadCommit, headSource: "git-ref-readback" };
  }
  while (Date.now() - started < input.waitMs) {
    await new Promise((resolve) => setTimeout(resolve, input.pollMs));
    attempts += 1;
    const next = await input.adapter.observePullRequest({ number: input.number });
    if (next.status === "succeeded") {
      lastHeadCommit = next.value.headCommit;
      if (next.value.headCommit !== input.first.headCommit) return { first, second: proposalRevision(next.value), attempts, lastHeadCommit, headSource: "pull-request-api" };
    }
  }
  return { first, attempts, lastHeadCommit, headSource: "pull-request-api" };
}

async function main(): Promise<void> {
  const apiBaseUrl = optional("ANYAM_GITHUB_APP_API_BASE_URL") ?? "https://api.github.com";
  requireConfiguration([
    "ANYAM_GITHUB_APP_ID",
    "ANYAM_GITHUB_APP_INSTALLATION_ID",
    "ANYAM_GITHUB_APP_REPOSITORY",
    "ANYAM_GITHUB_APP_WEBHOOK_SECRET",
    "ANYAM_GITHUB_APP_QUALIFICATION_ID",
    "ANYAM_GITHUB_APP_DISPOSABLE_REPOSITORY",
    "ANYAM_GITHUB_APP_JWT_LIFETIME_SECONDS",
    "ANYAM_GITHUB_APP_JWT_SIZING_RECEIPT",
    "ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SECONDS",
    "ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SIZING_RECEIPT",
    "ANYAM_GITHUB_APP_GIT_MAX_BUFFER_BYTES",
    "ANYAM_GITHUB_APP_GIT_SIZING_RECEIPT",
    "ANYAM_GITHUB_APP_RETRY_DELAYS_MS",
    "ANYAM_GITHUB_APP_RETRY_SIZING_RECEIPT",
    "ANYAM_GITHUB_APP_QUEUE_MAX_PENDING",
    "ANYAM_GITHUB_APP_QUEUE_SIZING_RECEIPT",
    "ANYAM_GITHUB_APP_PR_REVISION_WAIT_MS",
    "ANYAM_GITHUB_APP_PR_REVISION_POLL_MS",
  ]);
  const appId = required("ANYAM_GITHUB_APP_ID");
  const installationId = required("ANYAM_GITHUB_APP_INSTALLATION_ID");
  const repository = required("ANYAM_GITHUB_APP_REPOSITORY");
  const repositoryUrl = optional("ANYAM_GITHUB_APP_REPOSITORY_URL") ?? `https://github.com/${repository}.git`;
  const webhookSecret = required("ANYAM_GITHUB_APP_WEBHOOK_SECRET");
  const qualificationId = required("ANYAM_GITHUB_APP_QUALIFICATION_ID");
  const disposableRepository = required("ANYAM_GITHUB_APP_DISPOSABLE_REPOSITORY");
  if (disposableRepository !== repository) throw new Error("ANYAM_GITHUB_APP_DISPOSABLE_REPOSITORY must exactly equal ANYAM_GITHUB_APP_REPOSITORY; cleanup target must be explicit");
  const jwtLifetimeSeconds = positiveInteger("ANYAM_GITHUB_APP_JWT_LIFETIME_SECONDS");
  const jwtSizingReceipt = required("ANYAM_GITHUB_APP_JWT_SIZING_RECEIPT");
  const clockSkewSeconds = positiveInteger("ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SECONDS");
  const clockSkewSizingReceipt = required("ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SIZING_RECEIPT");
  const gitMaxBufferBytes = positiveInteger("ANYAM_GITHUB_APP_GIT_MAX_BUFFER_BYTES");
  const gitSizingReceipt = required("ANYAM_GITHUB_APP_GIT_SIZING_RECEIPT");
  const retryDelaysMs = commaSeparatedIntegers("ANYAM_GITHUB_APP_RETRY_DELAYS_MS");
  const retrySizingReceipt = required("ANYAM_GITHUB_APP_RETRY_SIZING_RECEIPT");
  const queueMaxPending = positiveInteger("ANYAM_GITHUB_APP_QUEUE_MAX_PENDING");
  const queueSizingReceipt = required("ANYAM_GITHUB_APP_QUEUE_SIZING_RECEIPT");
  const proposalWaitMs = positiveInteger("ANYAM_GITHUB_APP_PR_REVISION_WAIT_MS");
  const proposalPollMs = positiveInteger("ANYAM_GITHUB_APP_PR_REVISION_POLL_MS");
  if (proposalPollMs > proposalWaitMs) throw new Error("ANYAM_GITHUB_APP_PR_REVISION_POLL_MS must not exceed ANYAM_GITHUB_APP_PR_REVISION_WAIT_MS");
  const authorityInputs = await authorityConfig();

  const seeded = await seedRepository(gitMaxBufferBytes);
  let cleanup: CleanupReceipt | undefined;
  let authorityCleanup: CleanupReceipt | undefined;
  let authorityClient: QualificationAuthorityClient | undefined;
  let authorityRecoverySnapshot: JsonObject | undefined;
  let authorityMutated = false;
  let authority: JsonObject | undefined;
  let adapter: GitHubAppProjectionAdapter | undefined;
  const deliveryRecords = new Map<string, { task: GitHubReconciliationTask; processed: boolean }>();
  const deliveryLedger = {
    recordIfAbsent: (task: GitHubReconciliationTask) => { const existing = deliveryRecords.get(task.deliveryId); if (existing) return JSON.stringify(existing.task) === JSON.stringify(task) ? "duplicate" as const : "conflict" as const; deliveryRecords.set(task.deliveryId, { task, processed: false }); return "accepted" as const; },
    listPending: (): readonly GitHubReconciliationTask[] => [...deliveryRecords.values()].filter((entry) => !entry.processed).map((entry) => entry.task),
    markProcessed: (deliveryId: string) => { const entry = deliveryRecords.get(deliveryId); if (entry) entry.processed = true; },
  };
  const installation: GitHubAppInstallation = {
    installationId,
    repository,
    repositoryUrl,
    disposableQualificationId: qualificationId,
    selectedRepository: true,
    permissions: { contents: "write", metadata: "read", pullRequests: "write", administration: "write" },
    events: ["push", "pull_request"],
  };
  let http: FetchGitHubAppHttpClient | undefined;
  let issuer: GitHubAppInstallationTokenIssuer | undefined;
  let api: FetchGitHubRestClient | undefined;
  try {
    http = new FetchGitHubAppHttpClient({ baseUrl: apiBaseUrl, retry: { delaysMs: retryDelaysMs, sizingReceipt: retrySizingReceipt } });
    issuer = new GitHubAppInstallationTokenIssuer({ http, appId, privateKey: privateKey(), jwtLifetimeSeconds, clockSkewSeconds, sizingReceipt: jwtSizingReceipt, clockSkewSizingReceipt });
    api = new FetchGitHubRestClient(http);
    adapter = new GitHubAppProjectionAdapter({ installation, issuer, git: new NodeGitSmartHttpTransport({ sourceDirectory: seeded.directory, maxBufferBytes: gitMaxBufferBytes, sizingReceipt: gitSizingReceipt }), api, queue: { maxPending: queueMaxPending, sizingReceipt: queueSizingReceipt, deliveryLedger } });
    const emptyMirror = mirror({ repository, initialGeneration: "qualification:empty" });
    const initialInspection = await adapter.inspect({ mirror: emptyMirror, knownRefs: [], knownGeneration: "qualification:empty" });
    if (initialInspection.status !== "succeeded") throw new Error(`initial GitHub ref inspection failed: ${initialInspection.errorCode}; ${initialInspection.recoveryAction}`);
    if (initialInspection.value.refs.length !== 0) throw new Error(`disposable repository is not empty; observed ${initialInspection.value.refs.length} mapped refs`);
    // The provider's verified empty generation is authoritative. Seeding the
    // Mirror with the local placeholder would make the first canonical
    // projection look like a remote-and-canonical divergence before any
    // provider mutation occurred.
    emptyMirror.remoteGeneration = initialInspection.value.generation;
    emptyMirror.receipt = `${emptyMirror.receipt}; remoteGeneration=verified-empty; providerReceipt=${initialInspection.value.receipt}`;

    const changes: Change[] = [];
    const service = new MirrorCoordinator({ mirror: emptyMirror, remote: adapter, changeSink: changeSink(changes), sourceSpaceClassification: "public" });
    const actor = { principalId: "principal:github-app-qualification", actorId: "actor:github-app-qualification", sessionId: "session:github-app-qualification", clientId: "client:github-app-qualification" };
    const outbound = await service.sync({ canonical: { projectRevisionId: "project-revision:github-app-qualification:one", sourceSpaceId: emptyMirror.sourceSpaceId, sourceSpaceClassification: "public", disclosure: "public", verified: true, verificationReceipt: "qualification=source-verified", refs: refs([["refs/heads/main", seeded.initialOid]]) }, idempotencyKey: "qualification:outbound", actor });
    if (outbound.status !== "succeeded") throw new Error(`outbound projection failed: ${outbound.errorCode}; ${outbound.recoveryAction}; receipt=${outbound.receipt}`);

    const setupToken = await issuer.issue({ installationId, repository, permissions: ["contents:write", "metadata:read", "pull_requests:write"] });
    if (!setupToken.token.trim() || !Number.isFinite(Date.parse(setupToken.expiresAt)) || Date.parse(setupToken.expiresAt) <= Date.now()) throw new Error("GitHub App qualification setup credential was missing or expired");
    const setupGit = new NodeGitSmartHttpTransport({ sourceDirectory: seeded.directory, maxBufferBytes: gitMaxBufferBytes, sizingReceipt: gitSizingReceipt });
    await runGit(seeded.directory, ["update-ref", `refs/heads/${seeded.proposalBranch}`, seeded.proposalInitialOid], gitMaxBufferBytes);
    const proposalBranchPush = await setupGit.push({ repositoryUrl, token: setupToken.token, expectedRefs: [], desiredRefs: [{ name: `refs/heads/${seeded.proposalBranch}`, oid: seeded.proposalInitialOid }], refMappings: [{ localRef: `refs/heads/${seeded.proposalBranch}`, remoteRef: `refs/heads/${seeded.proposalBranch}` }], operationId: "github:qualification:pr-branch", idempotencyKey: "github:qualification:pr-branch" });
    const pullRequest = await api.createPullRequest({ repository, head: seeded.proposalBranch, base: "main", title: "Anyam disposable projection qualification", token: setupToken.token });
    const pullRequestNumber = pullRequest.number;

    await runGit(seeded.directory, ["update-ref", "refs/heads/main", seeded.secondOid], gitMaxBufferBytes);
    const externalPush = await adapter.push({ mirror: service.repositoryMirror, expectedGeneration: service.repositoryMirror.remoteGeneration, expectedRefs: refs([["refs/heads/main", seeded.initialOid]]), desiredRefs: refs([["refs/heads/main", seeded.secondOid]]), operationId: "github:qualification:external-push", idempotencyKey: "github:qualification:external-push" });
    if (externalPush.status !== "succeeded") throw new Error(`inbound push seed failed: ${externalPush.errorCode}; ${externalPush.recoveryAction}`);
    const inbound = await service.sync({ canonical: { projectRevisionId: "project-revision:github-app-qualification:one", sourceSpaceId: emptyMirror.sourceSpaceId, sourceSpaceClassification: "public", disclosure: "public", verified: true, verificationReceipt: "qualification=source-verified", refs: refs([["refs/heads/main", seeded.initialOid]]) }, idempotencyKey: "qualification:inbound", actor });
    if (inbound.status !== "succeeded" || inbound.value.inboundChanges.length !== 1) throw new Error(`inbound push did not become one pending Change; state=${inbound.status}`);

    // Move only the disposable qualification worktree's local main ref to the
    // orphaned commit before the CAS force-push. The adapter still enforces the
    // remote expected OID; this makes the provider perform the real rewrite.
    await runGit(seeded.directory, ["update-ref", "refs/heads/main", seeded.divergentOid], gitMaxBufferBytes);
    const forcePush = await adapter.push({ mirror: service.repositoryMirror, expectedGeneration: externalPush.value.generation, expectedRefs: refs([["refs/heads/main", seeded.secondOid]]), desiredRefs: refs([["refs/heads/main", seeded.divergentOid]]), operationId: "github:qualification:force-push", idempotencyKey: "github:qualification:force-push" });
    if (forcePush.status !== "succeeded") throw new Error(`force-push seed failed: ${forcePush.errorCode}; ${forcePush.recoveryAction}`);
    const forceInspection = await adapter.inspect({ mirror: service.repositoryMirror, knownRefs: refs([["refs/heads/main", seeded.secondOid]]), knownGeneration: forcePush.value.generation });
    if (forceInspection.status !== "succeeded" || forceInspection.value.updates[0]?.kind !== "force-push") {
      const forceInspectionReceipt = forceInspection.status === "failed" ? forceInspection.receipt : "inspection=succeeded; updateKinds=unexpected";
      throw new Error(`force-push was not classified explicitly; state=${forceInspection.status}; errorCode=${forceInspection.status === "failed" ? forceInspection.errorCode : "none"}; receipt=${forceInspectionReceipt}; updateKinds=${forceInspection.status === "succeeded" ? forceInspection.value.updates.map((update) => update.kind).join(",") : "not-returned"}`);
    }
    const blockedReconciliation = await service.sync({ canonical: { projectRevisionId: "project-revision:github-app-qualification:one", sourceSpaceId: emptyMirror.sourceSpaceId, sourceSpaceClassification: "public", disclosure: "public", verified: true, verificationReceipt: "qualification=source-verified", refs: refs([["refs/heads/main", seeded.initialOid]]) }, idempotencyKey: "qualification:force-push-blocked", actor });
    if (blockedReconciliation.status !== "failed" || blockedReconciliation.errorCode !== "mirror.force_push_detected") throw new Error(`force-push did not require explicit reconciliation: state=${blockedReconciliation.status}`);
    await runGit(seeded.directory, ["update-ref", "refs/heads/main", seeded.initialOid], gitMaxBufferBytes);
    const reconciled = await service.sync({ canonical: { projectRevisionId: "project-revision:github-app-qualification:one", sourceSpaceId: emptyMirror.sourceSpaceId, sourceSpaceClassification: "public", disclosure: "public", verified: true, verificationReceipt: "qualification=source-verified", refs: refs([["refs/heads/main", seeded.initialOid]]) }, idempotencyKey: "qualification:force-push-canonical-wins", reconciliation: "canonical-wins", resumeCheckpointId: blockedReconciliation.checkpoint.id, actor });
    if (reconciled.status !== "succeeded" || reconciled.value.mirror.state !== "healthy") throw new Error(`explicit canonical-wins reconciliation did not restore a healthy Mirror: state=${reconciled.status}`);

    class ResumeIssuer implements GitHubAppTokenIssuer {
      calls = 0;
      constructor(private readonly delegate: GitHubAppTokenIssuer) {}
      async issue(input: Parameters<GitHubAppTokenIssuer["issue"]>[0]): Promise<{ token: string; expiresAt: string }> {
        this.calls += 1;
        const issued = await this.delegate.issue(input);
        return this.calls === 2 ? { ...issued, expiresAt: "2000-01-01T00:00:00.000Z" } : issued;
      }
    }
    const resumeIssuer = new ResumeIssuer(issuer);
    const resumeAdapter = new GitHubAppProjectionAdapter({ installation, issuer: resumeIssuer, git: new NodeGitSmartHttpTransport({ sourceDirectory: seeded.directory, maxBufferBytes: gitMaxBufferBytes, sizingReceipt: gitSizingReceipt }), api, queue: { maxPending: queueMaxPending, sizingReceipt: queueSizingReceipt, deliveryLedger } });
    const resumedFirst = await resumeAdapter.inspect({ mirror: service.repositoryMirror, knownRefs: refs([["refs/heads/main", seeded.divergentOid]]), knownGeneration: forcePush.value.generation });
    if (resumedFirst.status !== "succeeded") throw new Error(`credential resume first inspection failed: ${resumedFirst.errorCode}`);
    const resumedExpired = await resumeAdapter.inspect({ mirror: service.repositoryMirror, knownRefs: refs([["refs/heads/main", seeded.divergentOid]]), knownGeneration: forcePush.value.generation });
    if (resumedExpired.status !== "failed" || resumedExpired.errorCode !== "github_app.credential_expired") throw new Error("expired JIT credential was not rejected");
    const resumed = await resumeAdapter.inspect({ mirror: service.repositoryMirror, knownRefs: refs([["refs/heads/main", seeded.divergentOid]]), knownGeneration: forcePush.value.generation });
    if (resumed.status !== "succeeded") throw new Error("credential expiry did not resume with a fresh installation credential");

    const webhookBody = JSON.stringify({ ref: "refs/heads/main", before: seeded.secondOid, after: seeded.divergentOid, forced: true, deleted: false, repository: { full_name: repository }, installation: { id: installationId } });
    const webhook = resumeAdapter.acceptWebhook({ body: webhookBody, event: "push", deliveryId: "delivery:github-app:one", signature: signed(webhookBody, webhookSecret), secret: webhookSecret, mirrorId: service.repositoryMirror.id, mappedRemoteRefs: ["refs/heads/main"] });
    const duplicate = resumeAdapter.acceptWebhook({ body: webhookBody, event: "push", deliveryId: "delivery:github-app:one", signature: signed(webhookBody, webhookSecret), secret: webhookSecret, mirrorId: service.repositoryMirror.id, mappedRemoteRefs: ["refs/heads/main"] });
    if (webhook.status !== "accepted" || duplicate.status !== "duplicate") throw new Error(`webhook dedupe failed: first=${webhook.status}; duplicate=${duplicate.status}`);
    const drained = await resumeAdapter.drainReconciliation({ limit: 1, reinspect: async (task) => ({ status: "succeeded", receipt: `qualification=reinspected; delivery=${task.deliveryId}; remoteState=authoritative; credentialMaterialStored=false` }) });
    if (drained.status !== "succeeded") throw new Error(`webhook reconciliation did not drain: ${drained.recoveryAction ?? drained.receipt}`);

    const observedPr = await adapter.observePullRequest({ number: pullRequestNumber });
    if (observedPr.status !== "succeeded") throw new Error(`pull-request observation failed: ${observedPr.errorCode}; ${observedPr.recoveryAction}`);
    if (observedPr.value.headRef !== seeded.proposalBranch) throw new Error(`pull-request ${pullRequestNumber} head ref did not match the seeded qualification branch; observed=${observedPr.value.headRef}; expected=${seeded.proposalBranch}`);
    const proposal = adapter.externalProposal(observedPr.value, { projectViewId: "project-view:github-app-qualification-public", baseProjectRevisionId: "project-revision:github-app-qualification:one", disclosure: "public", deliveryId: "delivery:github-app:pr", sourceSpaceSnapshots: { [emptyMirror.sourceSpaceId]: observedPr.value.headCommit } });
    if (proposal.proposalKey !== String(pullRequestNumber) || proposal.remoteRepository !== repository || JSON.stringify(proposal).includes("title")) throw new Error("pull-request proposal was not stable and metadata-minimal");
    await runGit(seeded.directory, ["update-ref", `refs/heads/${seeded.proposalBranch}`, seeded.proposalSecondOid], gitMaxBufferBytes);
    const proposalRevisionPush = await setupGit.push({ repositoryUrl, token: setupToken.token, expectedRefs: refs([[`refs/heads/${seeded.proposalBranch}`, seeded.proposalInitialOid]]), desiredRefs: [{ name: `refs/heads/${seeded.proposalBranch}`, oid: seeded.proposalSecondOid }], refMappings: [{ localRef: `refs/heads/${seeded.proposalBranch}`, remoteRef: `refs/heads/${seeded.proposalBranch}` }], operationId: "github:qualification:pr-revision", idempotencyKey: "github:qualification:pr-revision" });
    const proposalBranchReadBack = await setupGit.inspect({ repositoryUrl, token: setupToken.token, refs: [`refs/heads/${seeded.proposalBranch}`], knownGeneration: "qualification:pr-revision" });
    const proposalBranchOid = proposalBranchReadBack.refs.find((ref) => ref.name === `refs/heads/${seeded.proposalBranch}`)?.oid;
    if (proposalBranchOid !== seeded.proposalSecondOid) throw new Error(`pull-request branch push did not read back the requested head; expected=${seeded.proposalSecondOid}; observed=${proposalBranchOid ?? "missing"}; pushReceipt=${proposalRevisionPush.receipt}; readBackReceipt=${proposalBranchReadBack.receipt}`);
    const secondProposal = await waitForSecondProposalRevision({ adapter, first: observedPr.value, number: pullRequestNumber, waitMs: proposalWaitMs, pollMs: proposalPollMs, fallbackHeadCommit: proposalBranchOid });
    if (!secondProposal.second) throw new Error(`pull-request ${pullRequestNumber} did not publish a successive head revision within the measured wait window; attempts=${secondProposal.attempts}; lastHeadCommit=${secondProposal.lastHeadCommit}; expectedHeadCommit=${seeded.proposalSecondOid}; headSource=${secondProposal.headSource}; waitMs=${proposalWaitMs}; pollMs=${proposalPollMs}; pushReceipt=${proposalRevisionPush.receipt}; branchReadBackReceipt=${proposalBranchReadBack.receipt}`);
    if (secondProposal.first.changeKey !== secondProposal.second.changeKey || secondProposal.first.revisionKey === secondProposal.second.revisionKey) throw new Error("pull-request revisions did not preserve stable Change identity while advancing the Revision");

    const restoredDirectory = mkdtempSync(join(tmpdir(), "anyam-github-app-restore-"));
    try {
      await runGit(restoredDirectory, ["init"], gitMaxBufferBytes);
      await runGit(restoredDirectory, ["fetch", seeded.bundlePath, "refs/heads/main:refs/heads/main"], gitMaxBufferBytes);
      const restoredOid = await runGit(restoredDirectory, ["rev-parse", "refs/heads/main"], gitMaxBufferBytes);
      if (restoredOid !== seeded.initialOid) throw new Error(`export/restore returned ${restoredOid}, expected ${seeded.initialOid}`);
    } finally {
      rmSync(restoredDirectory, { recursive: true, force: true });
    }

    if (authorityInputs) {
      authorityClient = authorityInputs.authMode === "owner-cookie"
        ? new RealmAuthorityHttpClient({ baseUrl: authorityInputs.baseUrl, ownerSession: authorityInputs.ownerSession! })
        : new OAuthQualificationAuthorityClient(authorityInputs.baseUrl, authorityInputs.oauthAccessToken!);
      const recovery = await authorityClient.exportAuthorityRecovery();
      authorityRecoverySnapshot = authorityObject(recovery.bundle, "authority recovery bundle");
      const recoverySnapshot = authorityObject(authorityRecoverySnapshot.snapshot, "authority recovery snapshot");
      if (recovery.credentialFree !== true || Object.prototype.hasOwnProperty.call(recoverySnapshot, "credentials")) throw new Error("customer Realm Authority recovery bundle was not credential-free; no Authority mutation was attempted");
      const initialAuthorityState = await authorityClient.inspectState();
      const initialAuthority = authorityObject(initialAuthorityState.authority, "authority state");
      const initialCounts = authorityObject(initialAuthority.counts, "authority state counts");
      const occupied = Object.entries(initialCounts).filter(([key, value]) => key !== "audit" && typeof value === "number" && value > 0);
      if (occupied.length > 0) throw new Error(`customer Realm Authority is not an empty disposable boundary (${occupied.map(([key, value]) => `${key}=${String(value)}`).join(", ")}); use a fresh Realm or restore its credential-free recovery snapshot before retrying`);
      authorityMutated = true;
      authority = await qualifyCustomerRealmAuthority({ seeded, repository, installationId, qualificationId, webhookSecret, authorityClient, authorityConfig: authorityInputs, adapter, forcePush, reconciled, pullRequestNumber, observedPr: observedPr.value, proposalRevisionPush, waitForSecond: secondProposal });
      if (authority.status === "not-run") throw new Error("customer Realm Authority qualification did not run; set the Realm URL and owner session and retry the same disposable qualification");
    }

    cleanup = await cleanupGitHubAppDisposable({ installation, issuer, api, repositoryPrefix: repository, qualificationId, disposableRepository });
    if (cleanup.status !== "succeeded") throw new Error(`provider cleanup failed: ${cleanup.recoveryAction ?? cleanup.receipt}`);
    if (authorityClient && authorityRecoverySnapshot) {
      authorityCleanup = await restoreAuthorityRecovery(authorityClient, authorityRecoverySnapshot);
      if (authorityCleanup.status !== "succeeded") throw new Error(`customer Realm Authority cleanup failed: ${authorityCleanup.recoveryAction ?? authorityCleanup.receipt}`);
    }
    const authorityRun = authority ?? { status: "not-run", receipt: "authority=not-run; inputs=not-configured; credentialValues=not-printed; canonicalWrite=false" };
    const authorityOutput = authorityInputs ? { ...authorityRun, authentication: authorityInputs.authMode, authenticationReceipt: authorityInputs.authReceipt } : authorityRun;
    const cleanupResult = authorityCleanup ? { provider: cleanup, authority: authorityCleanup } : { provider: cleanup };
    console.log(JSON.stringify({ protocol, status: "succeeded", qualificationScope: authority ? "provider-adapter-and-customer-realm-authority" : "provider-adapter", acceptance: authority ? "qualified; provider and customer Realm/Authority boundary exercised" : "qualified; provider adapter boundary exercised; customer Realm/Authority not configured", qualificationId, repository, mappedRef: "refs/heads/main", outbound: "projected", inbound: { changeCount: changes.length }, forcePush: "classified", credentialExpiry: "rejected-and-resumed", webhook: "signed-deduplicated-and-reconciled", pullRequestSetup: { branch: seeded.proposalBranch, created: true, branchPush: proposalBranchPush.receipt, successiveRevisionPush: proposalRevisionPush.receipt }, pullRequestObservation: { proposalKey: String(pullRequestNumber), stableObservationIdentity: true, successiveHeadObserved: true, headSource: secondProposal.headSource, authorityChangeLedger: authority ? "customer-realm-recorded" : "not-run" }, gitBundleExportRestore: { bundleDigest: seeded.bundleDigest, restored: true, ...(authority ? { authorityExportRestore: "credential-free-snapshot-restored" } : { authorityExportRestore: "not-run" }) }, authority: authorityOutput, credentialValues: "not-printed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true, cleanup: cleanupResult }, null, 2));
  } catch (error) {
    if (!cleanup) {
      try {
        const cleanupHttp = http ?? new FetchGitHubAppHttpClient({ baseUrl: apiBaseUrl, retry: { delaysMs: retryDelaysMs, sizingReceipt: retrySizingReceipt } });
        const cleanupIssuer = issuer ?? new GitHubAppInstallationTokenIssuer({ http: cleanupHttp, appId, privateKey: privateKey(), jwtLifetimeSeconds, clockSkewSeconds, sizingReceipt: jwtSizingReceipt, clockSkewSizingReceipt });
        const cleanupApi = api ?? new FetchGitHubRestClient(cleanupHttp);
        cleanup = await cleanupGitHubAppDisposable({ installation, issuer: cleanupIssuer, api: cleanupApi, repositoryPrefix: repository, qualificationId, disposableRepository });
      } catch (cleanupError) {
        cleanup = { status: "blocked", receipt: `cleanup=blocked; repository=${repository}; exception=${cleanupError instanceof Error ? cleanupError.name : "unknown"}; credentialMaterialStored=false`, recoveryAction: "restore the GitHub App credential authority, then retry exact disposable-repository cleanup" };
      }
    }
    if (!authorityCleanup && authorityMutated && authorityClient && authorityRecoverySnapshot) authorityCleanup = await restoreAuthorityRecovery(authorityClient, authorityRecoverySnapshot);
    const cleanupReceipt = [cleanup?.receipt, authorityCleanup?.receipt].filter((receipt): receipt is string => receipt !== undefined).join("; ") || "cleanup=not-run; adapter-not-qualified";
    throw new Error(`${error instanceof Error ? error.message : "GitHub App qualification failed"}; cleanup=${cleanupReceipt}`);
  } finally {
    rmSync(seeded.directory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? error.message : "GitHub App qualification failed", credentialValues: "not-printed", canonicalWrite: false, recoveryAction: "inspect the named GitHub App operation, retain the same disposable repository, and retry only after reconciling provider state" }, null, 2));
  process.exitCode = 2;
}
