import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  AUTHORITY_COMMAND_PROTOCOL,
  AuthorityPlaneCoordinator,
  emptyAuthorityPlaneSnapshot,
  type AuthorityCommandName,
  type AuthoritySession,
} from "../cloudflare/authority-plane.ts";
import {
  createWorkerTarget,
  sealVerifiedRelease,
  shipWorkerRelease,
  WorkerPromotionCoordinator,
  type DeliveryAdapterResult,
  type HealthObservation,
  type ImmutableRelease,
  type WorkerDeployment,
  type WorkerPreview,
  type WorkerTarget,
  type WorkerTargetAdapter,
} from "../delivery/promotion.ts";
import {
  CONTRACT_VERSIONS,
  createProject,
  createProjectRevision,
  type Artifact,
  type Project,
  type ProjectExport,
  type Release,
  type SourceSpace,
  type Target,
} from "../kernel/contracts.ts";
import {
  CustomerRealmInstallation,
  InMemoryCustomerRealmCloudflareAdapter,
  InMemoryCustomerRealmProjectImporter,
  verifyCustomerRealmRecoveryBundle,
  type CustomerRealmImportReceipt,
} from "../installation/customer-realm.ts";
import { SmartHttpCredentialAuthority, handleSmartHttpRequest, smartHttpRouteUrl } from "../portability/smart-http.ts";
import { SmartHttpRepositoryDriver } from "../portability/smart-http-driver.ts";
import { projectExportDigest } from "../portability/project-export.ts";
import { gitCommitIdentity, gitProjectRevisionId, gitTreeIdentity, inspectGitSource } from "../../packages/create-anyam/src/git-source.ts";
import { LocalAgentManager } from "../../packages/create-anyam/src/agent.ts";
import { measureLinuxWorkspaceResourceLimits } from "../../packages/create-anyam/src/workspace-boundary.ts";
import { scaffoldProject, startChange } from "../../packages/create-anyam/src/scaffold.ts";

const execFile = promisify(execFileCallback);
export const PRIVATE_ALPHA_JOURNEY_PROTOCOL = "anyam.private-alpha-journey-qualification/v1" as const;
type JsonObject = Record<string, unknown>;

export type PrivateAlphaJourneyReceipt = {
  protocol: typeof PRIVATE_ALPHA_JOURNEY_PROTOCOL;
  status: "succeeded";
  hostingMode: "customer-operated-fixture";
  providerQualification: "fixture-bound; live-provider-qualification-separate";
  stages: Readonly<Record<string, "passed">>;
  realm: Readonly<Record<string, string | number>>;
  git: Readonly<Record<string, string | number | boolean>>;
  agent: Readonly<Record<string, string | number | boolean>>;
  change: Readonly<Record<string, string | number | boolean>>;
  execution: Readonly<Record<string, string | number | boolean>>;
  landing: Readonly<Record<string, string | number | boolean>>;
  delivery: Readonly<Record<string, string | number | boolean>>;
  recovery: Readonly<Record<string, string | number | boolean>>;
  limits: Readonly<Record<string, string>>;
  credentialFree: true;
  canonicalWrite: "landing-only";
  providerFactsAreNotAnyamLimits: true;
};

function digest(value: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
function stableDigest(value: unknown): string {
  return digest(JSON.stringify(value) ?? "null");
}
async function git(directory: string | undefined, args: readonly string[]): Promise<string> {
  const result = await execFile("git", [...args], { cwd: directory, encoding: "utf8" });
  return result.stdout.trim();
}
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function runGitHttpBackend(request: IncomingMessage, response: ServerResponse, projectRoot: string): Promise<void> {
  const body = await requestBody(request);
  const requestUrl = new URL(request.url ?? "/", "http://anyam-upstream.invalid");
  const contentType = headerValue(request.headers["content-type"]);
  const gitProtocol = headerValue(request.headers["git-protocol"]);
  const result = await new Promise<{ stdout: Buffer; stderr: string; code: number }>((resolveChild, rejectChild) => {
    const stdout: Buffer[] = [];
    const stderr: string[] = [];
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: requestUrl.pathname,
        QUERY_STRING: requestUrl.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_LENGTH: String(body.byteLength),
        ...(contentType ? { CONTENT_TYPE: contentType } : {}),
        ...(gitProtocol ? { HTTP_GIT_PROTOCOL: gitProtocol } : {}),
        GATEWAY_INTERFACE: "CGI/1.1",
        SERVER_PROTOCOL: "HTTP/1.1",
        SERVER_NAME: "anyam-upstream.invalid",
        SERVER_PORT: "80",
        SERVER_SOFTWARE: "anyam-private-alpha-fixture",
        REMOTE_ADDR: "127.0.0.1",
        SCRIPT_NAME: "",
        REQUEST_URI: request.url ?? "/",
      },
    });
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(chunk.toString()));
    child.once("error", rejectChild);
    child.once("close", (code) => resolveChild({ stdout: Buffer.concat(stdout), stderr: stderr.join(""), code: code ?? 1 }));
    child.stdin.end(body);
  });
  if (result.code !== 0) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(result.stderr || "git http-backend failed");
    return;
  }
  const crlf = result.stdout.indexOf(Buffer.from("\r\n\r\n"));
  const lf = result.stdout.indexOf(Buffer.from("\n\n"));
  const separator = crlf >= 0 ? crlf : lf;
  const separatorBytes = crlf >= 0 ? 4 : 2;
  if (separator < 0) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("git http-backend returned no CGI headers");
    return;
  }
  const headers = new Headers();
  let status = 200;
  for (const line of result.stdout.subarray(0, separator).toString("utf8").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value.split(" ", 1)[0] ?? "200", 10) || 200;
    else headers.append(name, value);
  }
  response.writeHead(status, Object.fromEntries(headers.entries()));
  response.end(result.stdout.subarray(separator + separatorBytes));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolveAddress, rejectAddress) => {
    server.once("error", rejectAddress);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return rejectAddress(new Error("private-alpha fixture did not expose a TCP address"));
      resolveAddress("http://127.0.0.1:" + address.port);
    });
  });
}
async function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
}

async function gatewayServer(config: Parameters<typeof handleSmartHttpRequest>[1]): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const method = request.method ?? "GET";
        const body = method === "GET" || method === "HEAD" ? undefined : await requestBody(request);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          const text = headerValue(value);
          if (text !== undefined) headers.set(name, text);
        }
        const url = "http://anyam-gateway.invalid" + (request.url ?? "/");
        const upstreamRequest = body === undefined ? new Request(url, { method, headers }) : new Request(url, { method, headers, body: new Uint8Array(body) as unknown as BodyInit });
        const result = await handleSmartHttpRequest(upstreamRequest, config);
        if (!result) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("not a Git route");
          return;
        }
        response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : "Anyam Git gateway fixture failed");
      }
    })();
  });
  return { server, origin: await listen(server) };
}

async function seedGitRepositories(root: string, seedDirectory: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(undefined, ["clone", "--bare", seedDirectory, join(root, "canonical.git")]);
  await git(undefined, ["--git-dir", join(root, "canonical.git"), "config", "http.receivepack", "true"]);
  await git(undefined, ["clone", "--bare", join(root, "canonical.git"), join(root, "workspace.git")]);
  await git(undefined, ["--git-dir", join(root, "workspace.git"), "config", "http.receivepack", "true"]);
}

class PrivateAlphaWorkerAdapter implements WorkerTargetAdapter {
  readonly protocol = "anyam.target-adapter/v1" as const;
  readonly id = "cloudflare.worker";
  readonly contractDigest = "sha256:private-alpha-worker-adapter:v1";
  private sequence = 0;
  private readonly healthStates: HealthObservation["state"][] = ["healthy", "unhealthy", "healthy"];
  async preview(input: { release: ImmutableRelease; target: WorkerTarget }): Promise<DeliveryAdapterResult<WorkerPreview>> {
    this.sequence += 1;
    return { status: "succeeded", value: { previewId: "preview:private-alpha:" + this.sequence, providerVersionId: "version:private-alpha:preview:" + this.sequence, releaseDigest: input.release.releaseDigest, artifactDigests: input.release.artifacts.map((artifact) => artifact.digest), receipt: "provider=customer-operated-fixture; operation=preview; releaseDigest=" + input.release.releaseDigest }, receipt: "provider=customer-operated-fixture; operation=preview; target=" + input.target.id };
  }
  async apply(input: { release: ImmutableRelease; target: WorkerTarget }): Promise<DeliveryAdapterResult<WorkerDeployment>> {
    this.sequence += 1;
    return { status: "succeeded", value: { deploymentId: "deployment:private-alpha:" + this.sequence, providerVersionId: "version:private-alpha:apply:" + this.sequence, releaseDigest: input.release.releaseDigest, artifactDigests: input.release.artifacts.map((artifact) => artifact.digest), providerOperationId: "provider-operation:private-alpha:" + this.sequence, receipt: "deployment=customer-operated-fixture; releaseDigest=" + input.release.releaseDigest }, receipt: "provider=customer-operated-fixture; operation=apply; target=" + input.target.id };
  }
  async health(input: { release: ImmutableRelease; target: WorkerTarget; deploymentId?: string }): Promise<DeliveryAdapterResult<HealthObservation>> {
    this.sequence += 1;
    const state = this.healthStates.shift() ?? "unknown";
    const observation: HealthObservation = { protocol: "anyam.health-observation/v1", id: "health:private-alpha:" + this.sequence, targetId: input.target.id, releaseId: input.release.release.id, state, checkId: "worker-health:private-alpha-fixture", checkedAt: new Date().toISOString(), receipt: "health=customer-operated-fixture; releaseId=" + input.release.release.id + "; state=" + state + "; deployment=" + (input.deploymentId ?? "none"), outputDigest: digest(input.release.release.id + ":" + state + ":" + (input.deploymentId ?? "none")) };
    return { status: "succeeded", value: observation, receipt: observation.receipt };
  }
  async rollback(input: { release: ImmutableRelease; previousRelease: ImmutableRelease; target: WorkerTarget }): Promise<DeliveryAdapterResult<WorkerDeployment>> {
    this.sequence += 1;
    return { status: "succeeded", value: { deploymentId: "deployment:private-alpha:rollback:" + this.sequence, providerVersionId: "version:private-alpha:rollback:" + this.sequence, releaseDigest: input.previousRelease.releaseDigest, artifactDigests: input.previousRelease.artifacts.map((artifact) => artifact.digest), providerOperationId: "provider-operation:private-alpha:rollback:" + this.sequence, receipt: "rollback=customer-operated-fixture; releaseDigest=" + input.previousRelease.releaseDigest }, receipt: "provider=customer-operated-fixture; operation=rollback; target=" + input.target.id };
  }
}

function authoritySession(input: { realmId: string; principalId: string; actorId: string; sessionId: string; clientId: string; epoch: number }): AuthoritySession {
  return { realmId: input.realmId, principalId: input.principalId, actorId: input.actorId, sessionId: input.sessionId, clientId: input.clientId, authorizationEpoch: input.epoch };
}
function authorityExecute(coordinator: AuthorityPlaneCoordinator, session: AuthoritySession, command: AuthorityCommandName, idempotencyKey: string, payload: JsonObject): JsonObject {
  const result = coordinator.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command, idempotencyKey, payload }, session);
  if (result.status !== "succeeded") throw new Error("authority command " + command + " was " + result.status + ": " + result.receipt + "; recoveryAction=" + (result.recoveryAction ?? "inspect the authority checkpoint"));
  return result.value;
}

function projectExport(project: Project, sourceSpace: SourceSpace, baseRevision: ReturnType<typeof createProjectRevision>): ProjectExport {
  return {
    protocol: CONTRACT_VERSIONS.export,
    version: "v1",
    exportId: "export:private-alpha-journey",
    createdAt: "2026-08-12T00:00:00.000Z",
    project,
    sourceSpaces: [sourceSpace],
    repositories: [],
    largeObjects: [],
    lineage: [{ projectRevisionId: baseRevision.id, sourceSpaceSnapshots: baseRevision.sourceSpaceSnapshots }],
    projectRevisions: [baseRevision],
    intents: [],
    intentComments: [],
    changes: [],
    evidence: [],
    artifacts: [],
    releases: [],
    targets: [],
    capabilityGrants: [],
    extensions: [],
    policies: [],
    auditEventIds: [],
    recoveryCheckpointIds: ["checkpoint:private-alpha-export"],
    recovery: { checkpointId: "checkpoint:private-alpha-export", state: "verified", resumeAction: "restore from the owner-controlled Project Export", receipt: "provider=customer-operated-fixture; repositories=0" },
    integrity: { manifestDigest: "pending", repositoryDigests: [], credentialFree: true, receipt: "credentialFields=none" },
  };
}

export async function runPrivateAlphaJourneyQualification(): Promise<PrivateAlphaJourneyReceipt> {
  const root = await mkdtemp(join(tmpdir(), "anyam-private-alpha-journey-"));
  let upstream: Server | undefined;
  let gateway: Server | undefined;
  let agentManager: LocalAgentManager | undefined;
  try {
    const seedDirectory = join(root, "seed");
    await scaffoldProject({ directory: seedDirectory, name: "private-alpha", kind: "worker" });
    const manifestPath = join(seedDirectory, "anyam.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as JsonObject & { modules: Array<JsonObject & { actions: Array<JsonObject> }> };
    const action = manifest.modules[0]?.actions[0];
    if (!action) throw new Error("private-alpha scaffold did not declare an Action");
    action.command = "node -e \"require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/worker.bundle','private-alpha')\"";
    action.inputs = ["anyam.json", "src/**/*.ts"];
    action.outputs = ["dist/worker.bundle"];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await git(seedDirectory, ["config", "user.name", "Anyam Private Alpha Fixture"]);
    await git(seedDirectory, ["config", "user.email", "private-alpha@anyam.invalid"]);
    await git(seedDirectory, ["add", "."]);
    await git(seedDirectory, ["commit", "--quiet", "-m", "Initial private-alpha project"]);
    await seedGitRepositories(join(root, "repositories"), seedDirectory);
    upstream = createServer((request, response) => { void runGitHttpBackend(request, response, join(root, "repositories")); });
    const upstreamOrigin = await listen(upstream);
    const credentialAuthority = new SmartHttpCredentialAuthority();
    const gatewayFixture = await gatewayServer({ upstreamBase: upstreamOrigin + "/", credentials: credentialAuthority, allowInsecureUpstream: true, sourceSpaceIdForRepository: ({ repositoryId }) => repositoryId === "canonical" || repositoryId === "workspace" ? "source:private-alpha" : undefined, workspaceIdForRepository: ({ repositoryId }) => repositoryId === "workspace" ? "workspace:private-alpha" : undefined });
    gateway = gatewayFixture.server;
    const driver = new SmartHttpRepositoryDriver({ workspaceRoot: join(root, "driver"), credentials: credentialAuthority, credentialExpiresAt: () => new Date(Date.now() + 60_000).toISOString(), allowInsecureHttp: true, workspaceIdForRepository: (repositoryId) => repositoryId === "workspace" ? "workspace:private-alpha" : undefined });
    const canonicalEndpoint = smartHttpRouteUrl(gatewayFixture.origin, "canonical");
    const workspaceEndpoint = smartHttpRouteUrl(gatewayFixture.origin, "workspace");
    const canonical = await driver.cloneRepository({ sourceSpaceId: "source:private-alpha", source: canonicalEndpoint, destination: join(root, "canonical-checkout"), idempotencyKey: "private-alpha:clone:canonical" });
    if (canonical.status !== "succeeded") throw new Error("canonical clone failed: " + canonical.receipt);
    const fetched = await driver.fetchRepository({ repository: canonical.value, idempotencyKey: "private-alpha:fetch:canonical" });
    if (fetched.status !== "succeeded") throw new Error("canonical fetch failed: " + fetched.receipt);
    const canonicalPush = await driver.pushRepository({ repository: canonical.value, idempotencyKey: "private-alpha:push:canonical" });
    if (canonicalPush.status !== "failed" || canonicalPush.errorCode !== "canonical_write_denied") throw new Error("canonical Git push was not denied before the trusted Landing boundary");
    const working = await driver.cloneRepository({ sourceSpaceId: "source:private-alpha", source: workspaceEndpoint, destination: join(root, "working"), idempotencyKey: "private-alpha:clone:workspace" });
    if (working.status !== "succeeded") throw new Error("Workspace clone failed: " + working.receipt);
    const workingDirectory = join(root, "working");
    const changeStart = await startChange(workingDirectory, "Prove private-alpha delivery");
    const changeMetadata = JSON.parse(await readFile(changeStart.path, "utf8")) as JsonObject & { id: string; projectId: string; intentId: string; baseProjectRevisionId: string; local: JsonObject };
    await appendFile(join(workingDirectory, "src", "index.ts"), "\nexport const privateAlphaJourney = true;\n", "utf8");
    await git(workingDirectory, ["config", "user.name", "Anyam Private Alpha Agent"]);
    await git(workingDirectory, ["config", "user.email", "private-alpha-agent@anyam.invalid"]);
    await git(workingDirectory, ["add", "src/index.ts"]);
    await git(workingDirectory, ["commit", "--quiet", "-m", "Implement private-alpha journey"]);
    const pushed = await driver.pushRepository({ repository: working.value, idempotencyKey: "private-alpha:push:workspace" });
    if (pushed.status !== "succeeded") throw new Error("Workspace Git push failed: " + pushed.receipt);
    const source = await inspectGitSource(workingDirectory);
    if (changeMetadata.local.baseRepositoryId !== source.repositoryId) throw new Error(`private-alpha Change repository binding mismatch: base=${String(changeMetadata.local.baseRepositoryId)}; current=${source.repositoryId}`);
    const baseCommit = /^git:project-revision:([0-9a-f]{40,64})$/.exec(changeMetadata.baseProjectRevisionId)?.[1];
    if (!baseCommit) throw new Error("Change base is not a Git Project Revision: " + changeMetadata.baseProjectRevisionId);
    const candidateProjectRevisionId = gitProjectRevisionId(source.commitId);
    const sourceSnapshot = "git:snapshot:" + source.commitId;

    const project = createProject({ id: changeMetadata.projectId, name: "private-alpha", referenceType: "typescript-worker", sourceSpaceIds: ["source:private-alpha"] });
    const sourceSpace: SourceSpace = { protocol: CONTRACT_VERSIONS.sourceSpace, id: "source:private-alpha", name: "private-alpha source", classification: "internal" };
    const baseProjectRevision = createProjectRevision({ id: changeMetadata.baseProjectRevisionId, projectId: project.id, sourceSpaceSnapshots: { [sourceSpace.id]: "git:snapshot:" + baseCommit } });
    let exportManifest = projectExport(project, sourceSpace, baseProjectRevision);
    exportManifest = { ...exportManifest, integrity: { ...exportManifest.integrity, manifestDigest: projectExportDigest(exportManifest) } };
    const importReceipt: CustomerRealmImportReceipt = { projectRevisionId: baseProjectRevision.id, sourceSpaceIds: [sourceSpace.id], exportDigest: projectExportDigest(exportManifest), checkpointId: "checkpoint:private-alpha-import", state: "verified", partialEffects: [], receipt: "project=" + project.id + "; source=" + sourceSpace.id + "; revision=" + baseProjectRevision.id + "; fixture=verified" };
    const cloudflare = new InMemoryCustomerRealmCloudflareAdapter(["account:private-alpha"]);
    const installation = new CustomerRealmInstallation({ installationId: "installation:private-alpha-journey", cloudflare, importer: new InMemoryCustomerRealmProjectImporter(importReceipt), realmId: "realm:private-alpha-journey", now: () => new Date("2026-08-12T00:00:00.000Z") });
    await installation.install({ accountId: "account:private-alpha", requestedResourceTypes: ["workers", "d1", "r2", "durable-objects", "queues", "workflows"], ownerConfirmed: true, operationId: "operation:private-alpha:install", idempotencyKey: "private-alpha:install" });
    await installation.enrollVerifiedOwner({ displayName: "Private Alpha Owner", principalId: "principal:private-alpha-owner", authentication: { method: "passkey", credentialId: "passkey:private-alpha-owner", verificationReceipt: "fixture-passkey:verified" }, recovery: { method: "external-recovery-codes", enrollmentReceipt: "fixture-recovery:enrolled", materialDigest: "sha256:external-recovery-material" } });
    const ownerSession = installation.realmPolicy!.authenticatePasskey({ credentialId: "passkey:private-alpha-owner", challenge: "private-alpha-authentication", verified: true, clientId: "client:anyam-cli" });
    await installation.createProject({ project, sourceSpaces: [sourceSpace] });
    await installation.importProject({ provider: "generic-git", source: canonicalEndpoint, operationId: "operation:private-alpha:import", idempotencyKey: "private-alpha:import" });
    const realmId = installation.snapshot.realmId!;
    const epoch = installation.realmPolicy!.realm.authorizationEpoch;
    const ownerAuthority = authoritySession({ realmId, principalId: ownerSession.principalId, actorId: ownerSession.actorId, sessionId: ownerSession.id, clientId: ownerSession.clientId, epoch });

    const authority = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(realmId));
    authorityExecute(authority, ownerAuthority, "project.create", "private-alpha:authority:project", { projectId: project.id, name: project.name, referenceType: project.referenceType, projectRevisionId: baseProjectRevision.id, sourceSpaces: [{ id: sourceSpace.id, name: sourceSpace.name, classification: "internal", snapshotId: "git:snapshot:" + baseCommit }] });
    const workspaceValue = authorityExecute(authority, ownerAuthority, "workspace.create", "private-alpha:authority:workspace", { projectId: project.id, projectRevisionId: baseProjectRevision.id, workspaceId: changeMetadata.local.workspaceId, changeId: changeMetadata.id, sourceSpaceIds: [sourceSpace.id], mounts: ["source"] });
    const view = workspaceValue.view as { id: string };
    authorityExecute(authority, ownerAuthority, "change.create", "private-alpha:authority:change", { projectId: project.id, changeId: changeMetadata.id, intentId: changeMetadata.intentId, baseProjectRevisionId: baseProjectRevision.id, workspaceId: changeMetadata.local.workspaceId });

    const resourceLimits = process.platform === "linux" ? await measureLinuxWorkspaceResourceLimits(workingDirectory) : undefined;
    agentManager = new LocalAgentManager({ directory: workingDirectory, stateDirectory: join(root, "agent-state"), principalId: ownerSession.principalId, clientId: "client:anyam-local-broker", ...(resourceLimits ? { resourceLimits } : {}) });
    const started = await agentManager.startSession({ agent: "cli", changeId: changeMetadata.id, mode: "enforceable" });
    const runResult = await agentManager.invokeTool("run.start", { actionId: "action:check" });
    const localRun = runResult.run as { id: string; status: string; actionId: string; evidenceId: string; sourceRevision: string; sourceSnapshot: string; actionContractDigest: string; verifierId: string; inputDigests: readonly string[]; outputDigests: readonly string[]; outputDigest: string; toolchainDigest: string; environmentDigest: string; actorId: string; grantId: string; taskId: string; receipt: string };
    if (localRun.status !== "passed") throw new Error("declared Action did not pass: " + localRun.receipt);
    const proposed = await agentManager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify", "artifact.create", "target.promote"] });
    const revision = proposed.revision as { id: string; sourceRevision: string; sourceSnapshot: string; treeDigest: string; canonicalWrite: false };
    if (revision.sourceRevision !== gitCommitIdentity(source.commitId) || revision.sourceSnapshot !== sourceSnapshot || revision.canonicalWrite !== false) throw new Error("Change Revision was not bound to the immutable Git source state");
    await access(join(started.session.workspaceDirectory!, "dist", "worker.bundle"));
    let sourceOutputEscaped = false;
    try { await access(join(workingDirectory, "dist", "worker.bundle")); sourceOutputEscaped = true; } catch { /* expected: Action output stays in the isolated Workspace */ }
    if (sourceOutputEscaped) throw new Error("Action output escaped the enforceable Workspace");
    await agentManager.revoke(started.session.id);
    agentManager = undefined;

    const agentAuthority = authoritySession({ realmId, principalId: ownerSession.principalId, actorId: started.session.actorId, sessionId: started.session.id, clientId: started.session.clientId, epoch });
    const revisionValue = authorityExecute(authority, agentAuthority, "revision.publish", "private-alpha:authority:revision", { projectId: project.id, changeId: changeMetadata.id, revisionId: revision.id, projectRevisionId: candidateProjectRevisionId, projectViewId: view.id, workspaceId: changeMetadata.local.workspaceId, sourceSpaceSnapshots: { [sourceSpace.id]: sourceSnapshot }, declaredEffects: ["source.modify", "artifact.create", "target.promote"] });
    const authorityRevision = revisionValue.revision as { id: string };
    const runValue = authorityExecute(authority, agentAuthority, "run.record", "private-alpha:authority:run", { projectId: project.id, runId: localRun.id, actionId: localRun.actionId, projectRevisionId: candidateProjectRevisionId, projectViewId: view.id, changeRevisionId: authorityRevision.id, workspaceId: changeMetadata.local.workspaceId, runnerId: "runner:local-enforceable", status: "succeeded", inputDigests: localRun.inputDigests, outputDigests: localRun.outputDigests, outputDigest: localRun.outputDigest });
    const authorityRun = runValue.run as { id: string };
    const evidenceValue = authorityExecute(authority, agentAuthority, "evidence.record", "private-alpha:authority:evidence", { projectId: project.id, evidenceId: localRun.evidenceId, key: "private-alpha.action", criterion: "declared Action and Verifier pass against the exact Git-bound Project Revision", outcome: "passed", validityKey: candidateProjectRevisionId + ":" + localRun.actionContractDigest + ":" + localRun.verifierId, actionId: localRun.actionId, verifierId: localRun.verifierId, toolchainDigest: localRun.toolchainDigest, dependencyDigest: digest("private-alpha:dependencies"), environmentDigest: localRun.environmentDigest, inputDigests: localRun.inputDigests, effectDigests: [digest("source.modify"), digest("artifact.create"), digest("target.promote")], outputDigest: localRun.outputDigest, projectRevisionId: candidateProjectRevisionId, projectViewId: view.id, changeRevisionId: authorityRevision.id, runId: authorityRun.id, runnerId: "runner:local-enforceable", policyVersion: installation.realmPolicy!.realm.policyVersion, authorizationEpoch: epoch, capabilityGrantId: started.grant.id, disclosure: { projectionId: view.id, classification: "project" }, invalidators: ["source-revision-change", "action-contract-change", "verifier-contract-change", "policy-version-change"], owner: "private-alpha owner", targetId: "target:private-alpha-worker", workspaceId: changeMetadata.local.workspaceId, receipt: localRun.receipt + "; context=git-bound; actor=" + localRun.actorId + "; grant=" + localRun.grantId });
    const authorityEvidence = evidenceValue.evidence as import("../kernel/contracts.ts").Evidence;
    const artifactValue = authorityExecute(authority, agentAuthority, "artifact.record", "private-alpha:authority:artifact", { projectId: project.id, artifactId: "artifact:private-alpha-worker", type: "worker.bundle", digest: localRun.outputDigest, projectRevisionId: candidateProjectRevisionId, changeRevisionId: authorityRevision.id, runId: authorityRun.id, actionId: localRun.actionId, outputPath: "dist/worker.bundle", provenanceDigest: stableDigest({ run: localRun.id, evidence: localRun.evidenceId, source: sourceSnapshot }), disclosure: { projectionId: view.id, classification: "project" } });
    const authorityArtifact = artifactValue.artifact as Artifact;
    const landingValue = authorityExecute(authority, ownerAuthority, "landing.apply", "private-alpha:authority:landing", { projectId: project.id, changeRevisionId: authorityRevision.id, expectedCanonicalProjectRevisionId: baseProjectRevision.id, projectRevisionId: candidateProjectRevisionId, landingId: "landing:private-alpha" });
    const landing = landingValue.landing as { id: string; projectRevisionId: string; previousProjectRevisionId: string };
    const configurationDigest = digest(await readFile(manifestPath));
    const releaseValue = authorityExecute(authority, ownerAuthority, "release.create", "private-alpha:authority:release:healthy", { projectId: project.id, releaseId: "release:private-alpha:healthy", name: "private-alpha healthy", projectRevisionId: landing.projectRevisionId, artifactIds: [authorityArtifact.id], evidenceIds: [authorityEvidence.id], configurationDigests: [configurationDigest], stateAssumptions: ["customer-operated fixture; no customer data"], policyVersion: installation.realmPolicy!.realm.policyVersion, changeRevisionId: authorityRevision.id, provenanceDigest: stableDigest({ sourceSnapshot, actor: localRun.actorId, grant: localRun.grantId }) });
    const failingReleaseValue = authorityExecute(authority, ownerAuthority, "release.create", "private-alpha:authority:release:failing", { projectId: project.id, releaseId: "release:private-alpha:failing", name: "private-alpha failing", projectRevisionId: landing.projectRevisionId, artifactIds: [authorityArtifact.id], evidenceIds: [authorityEvidence.id], configurationDigests: [configurationDigest], stateAssumptions: ["customer-operated fixture; failing health is intentional"], policyVersion: installation.realmPolicy!.realm.policyVersion, changeRevisionId: authorityRevision.id, provenanceDigest: stableDigest({ sourceSnapshot, actor: localRun.actorId, grant: localRun.grantId }) });
    const targetValue = authorityExecute(authority, ownerAuthority, "target.configure", "private-alpha:authority:target", { projectId: project.id, targetId: "target:private-alpha-worker", name: "Private alpha Worker", adapterId: "cloudflare.worker", acceptedArtifactTypes: ["worker.bundle"], requiredEvidenceKeys: [], deploymentProfile: { environment: "staging", channel: "alpha", audience: "private-alpha", runtimeIdentity: "worker:private-alpha", routeIdentities: ["route:private-alpha"], bindingIdentities: [], dataResourceIdentities: [], configurationDigests: [configurationDigest], secretUseAliases: [], dataClass: "synthetic", resourceSharing: "isolated" } });
    const targetRecord = targetValue.target as Target;
    const target = createWorkerTarget({ target: targetRecord, capabilities: { preview: true, promote: true, healthCheck: true, rollback: true } });
    const authorityEvidenceRecord = authority.snapshot().evidence[authorityEvidence.id];
    if (!authorityEvidenceRecord) throw new Error("authority Evidence was not retained");
    const authorityArtifactRecord = authority.snapshot().artifacts[authorityArtifact.id];
    if (!authorityArtifactRecord) throw new Error("authority Artifact was not retained");
    const immutableHealthy = sealVerifiedRelease({ projectId: project.id, release: releaseValue.release as Release, artifacts: [authorityArtifactRecord], evidence: [authorityEvidenceRecord], target });
    const immutableFailing = sealVerifiedRelease({ projectId: project.id, release: failingReleaseValue.release as Release, artifacts: [authorityArtifactRecord], evidence: [authorityEvidenceRecord], target });
    const promotions = new WorkerPromotionCoordinator({ projectId: project.id, target, adapter: new PrivateAlphaWorkerAdapter() });
    promotions.registerRelease(immutableHealthy);
    promotions.registerRelease(immutableFailing);
    const promotionActor = { principalId: ownerSession.principalId, actorId: "service:anyam-landing", sessionId: ownerSession.id, clientId: "client:anyam-promotion" };
    const healthyPromotion = await shipWorkerRelease({ coordinator: promotions, releaseId: immutableHealthy.release.id, idempotencyKey: "private-alpha:promotion:healthy", actor: promotionActor });
    const failingPromotion = await shipWorkerRelease({ coordinator: promotions, releaseId: immutableFailing.release.id, idempotencyKey: "private-alpha:promotion:failing", actor: promotionActor });
    if (healthyPromotion.state !== "healthy" || failingPromotion.state !== "rolled-back" || failingPromotion.health?.state !== "unhealthy" || failingPromotion.rollbackHealth?.state !== "healthy" || promotions.getTarget().currentReleaseId !== immutableHealthy.release.id) throw new Error("private-alpha promotion invariant failed: healthy=" + healthyPromotion.state + "; failing=" + failingPromotion.state + "; rollbackHealth=" + (failingPromotion.rollbackHealth?.state ?? "missing"));
    if (failingPromotion.health?.releaseId !== immutableFailing.release.id || failingPromotion.rollbackHealth?.releaseId !== immutableHealthy.release.id) throw new Error("health observations were not bound to the Release identity they checked");

    const recoveryBundle = await installation.exportRecovery({ projectExport: exportManifest });
    const recoveryVerification = verifyCustomerRealmRecoveryBundle(recoveryBundle);
    if (recoveryVerification.status !== "verified") throw new Error("customer Realm recovery verification failed: " + recoveryVerification.errors.join("; "));
    const restored = new CustomerRealmInstallation({ installationId: installation.snapshot.installationId, cloudflare, importer: new InMemoryCustomerRealmProjectImporter(importReceipt), realmId, now: () => new Date("2026-08-12T00:00:00.000Z") });
    const quarantined = await restored.restoreRecovery(recoveryBundle);
    if (quarantined.phase !== "recovery-pending") throw new Error("recovery restore did not quarantine the installation: " + quarantined.phase);
    const activated = await restored.activateRecovery({ ownerPrincipalId: ownerSession.principalId, recoveryReceipt: "fixture-owner-recovery:verified" });
    if (activated.phase !== "active") throw new Error("recovery activation did not return an active Realm: " + activated.phase);

    return {
      protocol: PRIVATE_ALPHA_JOURNEY_PROTOCOL,
      status: "succeeded",
      hostingMode: "customer-operated-fixture",
      providerQualification: "fixture-bound; live-provider-qualification-separate",
      stages: { customerRealm: "passed", gitSmartHttp: "passed", enforceableWorkspace: "passed", gitBoundChange: "passed", declaredAction: "passed", declaredVerifier: "passed", trustedLanding: "passed", immutableRelease: "passed", previewPromotionHealth: "passed", failedPromotionRollback: "passed", exportRecovery: "passed" },
      realm: { installationId: installation.snapshot.installationId, realmId, ownerPrincipalId: ownerSession.principalId, ownerSessionId: ownerSession.id, authorizationEpoch: epoch },
      git: { canonicalEndpoint, workspaceEndpoint, baseProjectRevisionId: baseProjectRevision.id, candidateProjectRevisionId, canonicalPush: "denied", workspacePush: "succeeded", sourceRevision: gitCommitIdentity(source.commitId), sourceTree: gitTreeIdentity(source.treeId), credentialMaterialStored: false },
      agent: { sessionId: started.session.id, taskId: started.session.taskId, grantId: started.grant.id, actorId: started.session.actorId, workspaceId: started.session.workspaceId, mode: started.session.workspaceMode ?? "unknown", enforcement: started.session.workspaceEnforcement ?? "unknown", canonicalWrite: false },
      change: { changeId: changeMetadata.id, changeRevisionId: authorityRevision.id, sourceRevision: revision.sourceRevision, sourceSnapshot: revision.sourceSnapshot, declaredEffects: 3, canonicalWrite: false },
      execution: { runId: localRun.id, actionId: localRun.actionId, verifierId: localRun.verifierId, outputDigest: localRun.outputDigest, actorId: localRun.actorId, grantId: localRun.grantId, evidenceId: authorityEvidence.id, evidenceOutcome: "passed" },
      landing: { landingId: landing.id, previousProjectRevisionId: landing.previousProjectRevisionId, projectRevisionId: landing.projectRevisionId, sourceWrite: "landing-only", canonicalWrite: true },
      delivery: { targetId: target.id, healthyReleaseId: immutableHealthy.release.id, healthyReleaseDigest: immutableHealthy.releaseDigest, healthyPromotion: healthyPromotion.state, failingReleaseId: immutableFailing.release.id, failingPromotion: failingPromotion.state, failedHealth: failingPromotion.health?.state ?? "unknown", rollbackHealth: failingPromotion.rollbackHealth?.state ?? "unknown", currentReleaseId: promotions.getTarget().currentReleaseId ?? "none", healthBoundToRelease: true },
      recovery: { bundleId: recoveryBundle.bundleId, verification: recoveryVerification.status, restoredPhase: quarantined.phase, activatedPhase: activated.phase, credentialFree: recoveryBundle.integrity.credentialFree },
      limits: { fixtureCleanup: "temporary root and loopback servers are removed in finally; no production capacity limit asserted", actionBudget: "existing local-action policy receipt; remeasure-before-production", routeReadiness: "provider-specific live route receipt is separate from this fixture" },
      credentialFree: true,
      canonicalWrite: "landing-only",
      providerFactsAreNotAnyamLimits: true,
    };
  } finally {
    if (agentManager) await agentManager.revoke().catch(() => undefined);
    await close(gateway).catch(() => undefined);
    await close(upstream).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}
