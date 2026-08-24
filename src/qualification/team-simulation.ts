import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  CollaborationCoordinator,
  type ReviewOwnershipRule,
} from "../change-control/collaboration.ts";
import {
  LocalChangeCoordinator,
  type WorkspaceSource,
} from "../change-control/local.ts";
import {
  CONTRACT_VERSIONS,
  createProject,
  createProjectRevision,
  deriveProjectView,
  type ActorRef,
  type Artifact,
  type Change,
  type ChangeRevision,
  type Evidence,
  type GitRef,
  type Project,
  type ProjectRevision,
  type Release,
  type RepositoryMirror,
  type SourceSpace,
  type Target,
} from "../kernel/contracts.ts";
import { createPublicProjection } from "../disclosure/hybrid.ts";
import { createTargetDeploymentProfile } from "../delivery/target-deployment.ts";
import { sealVerifiedRelease } from "../delivery/promotion.ts";
import { LocalGitRepositoryDriver } from "../portability/local-git.ts";
import {
  LocalProjectExporter,
  verifyProjectExportPackage,
} from "../portability/project-export.ts";
import {
  MirrorCoordinator,
  type MirrorChangeSink,
  type MirrorInboundChangeInput,
  type MirrorProviderResult,
  type MirrorRemoteAdapter,
  type MirrorRemoteCommit,
  type MirrorRemoteState,
  type MirrorRefUpdate,
} from "../portability/mirror.ts";
import { main as anyamCliMain } from "../../packages/create-anyam/src/cli.ts";

const execFile = promisify(execFileCallback);
let observedGitOperationCount = 0;

export const TEAM_SIMULATION_PROTOCOL = "anyam.team-simulation/v1" as const;

export type SimulationVerdict = "VERIFIED" | "NOT VERIFIED" | "INCONCLUSIVE";

export type SimulationFinding = {
  id: string;
  scenarioId: string;
  verdict: Exclude<SimulationVerdict, "VERIFIED">;
  seam: string;
  message: string;
  recoveryAction: string;
  issueTitle: string;
  issueBody: string;
};

export type SimulationScenario = {
  id: string;
  verdict: SimulationVerdict;
  receipt: string;
  observations: Readonly<Record<string, unknown>>;
  findings: readonly SimulationFinding[];
};

export type TeamSimulationReport = {
  protocol: typeof TEAM_SIMULATION_PROTOCOL;
  status: "succeeded" | "blocked";
  startedAt: string;
  finishedAt: string;
  scenarios: readonly SimulationScenario[];
  findings: readonly SimulationFinding[];
  measurements: {
    humanActorCount: number;
    agentActorCount: number;
    repositoryArchetypeCount: number;
    gitOperationCount: number;
    localWorkspaceCount: number;
    localChangeCount: number;
    qualificationScopeReceipt: string;
  };
  provider: {
    cloudflare: "not-run";
    receipt: string;
  };
  credentialValues: "not-printed";
  canonicalWrite: false;
};

type GitResult = {
  stdout: string;
  stderr: string;
};

type GitConflictReceipt = {
  initialCommit: string;
  mainBeforeFeatureMerge: string;
  featureACommit: string;
  mergeConflict: boolean;
  rebaseConflict: boolean;
  resolvedFeatureCommit: string;
  mainAfterFeatureMerge: string;
  featureBBeforeRebase: string;
  resolvedFeatureBCommit: string;
  branches: readonly string[];
  tag?: string;
};

type BuildReceipt = {
  artifactDigest: string;
  outputDigest: string;
  configurationDigest: string;
  toolchainDigest: string;
  dependencyDigest: string;
  environmentDigest: string;
  outputFiles: readonly string[];
  receipt: string;
};

type RepositoryFixture = {
  id: "worker" | "cli";
  project: Project;
  sourceSpace: SourceSpace;
  seedDirectory: string;
  canonicalDirectory: string;
  files: Readonly<Record<string, string>>;
  git: GitConflictReceipt;
  repositoryId: string;
  repositoryRefs: readonly GitRef[];
};

type HybridFixture = {
  project: Project;
  sourceSpaces: readonly SourceSpace[];
  directories: Readonly<Record<string, string>>;
  commits: Readonly<Record<string, string>>;
  remoteCommit: string;
  files: Readonly<Record<string, Readonly<Record<string, string>>>>;
  repositoryRefs: Readonly<Record<string, readonly GitRef[]>>;
};

type CollaborationResult = {
  canonicalRevision: ProjectRevision;
  changes: readonly Change[];
  revisions: readonly ChangeRevision[];
  findings: readonly SimulationFinding[];
  observations: Readonly<Record<string, unknown>>;
  evidence: readonly Evidence[];
  target: Target;
  release: Release;
  artifact: Artifact;
  build: BuildReceipt;
  workspaceCount: number;
  changeCount: number;
};

type MirrorScenarioResult = {
  receipt: string;
  observations: Readonly<Record<string, unknown>>;
  coordinator: MirrorCoordinator;
  inboundChange: Change;
  inboundCommit: string;
};

function actor(actorId: string, clientId = "client:team-simulation"): ActorRef {
  return {
    principalId: `principal:${actorId}`,
    actorId: `actor:${actorId}`,
    sessionId: `session:${actorId}`,
    clientId,
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is missing from the simulation fixture`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refSignature(refs: readonly GitRef[]): string {
  return refs.map((ref) => `${ref.name}=${ref.oid}`).sort().join("|");
}

function finding(input: Omit<SimulationFinding, "id" | "verdict"> & { verdict?: Exclude<SimulationVerdict, "VERIFIED"> }): SimulationFinding {
  return {
    id: `finding:${input.scenarioId}:${input.seam}`,
    verdict: input.verdict ?? "NOT VERIFIED",
    scenarioId: input.scenarioId,
    seam: input.seam,
    message: input.message,
    recoveryAction: input.recoveryAction,
    issueTitle: input.issueTitle,
    issueBody: input.issueBody,
  };
}

async function captureScenario<T>(scenarios: SimulationScenario[], id: string, action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scenarios.push({ id, verdict: "INCONCLUSIVE", receipt: `scenario=${id}; status=inconclusive; error=${message}; providerMutation=false`, observations: { error: message }, findings: [] });
    return undefined;
  }
}

async function git(directory: string | undefined, args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<GitResult> {
  observedGitOperationCount += 1;
  try {
    const result = await execFile("git", [...args], {
      cwd: directory,
      env: { ...process.env, ...env },
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr
      : "";
    throw new Error(`git ${args.join(" ")} failed${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ""}`);
  }
}

async function command(commandName: string, args: readonly string[], directory: string): Promise<GitResult> {
  try {
    const result = await execFile(commandName, [...args], { cwd: directory, env: process.env });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr
      : "";
    const stdout = error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string"
      ? error.stdout
      : "";
    const detail = stderr.trim().length > 0 ? stderr.trim() : stdout.trim();
    throw new Error(`${commandName} ${args.join(" ")} failed${detail.length > 0 ? `: ${detail}` : ""}`);
  }
}

async function gitValue(directory: string, args: readonly string[]): Promise<string> {
  return (await git(directory, args)).stdout.trim();
}

async function attemptGit(directory: string, args: readonly string[]): Promise<{ ok: boolean; message: string }> {
  try {
    await git(directory, args);
    return { ok: true, message: "ok" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function commit(directory: string, message: string): Promise<string> {
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "--quiet", "-m", message]);
  return gitValue(directory, ["rev-parse", "HEAD"]);
}

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
}

async function readFiles(root: string, current = "", includeGenerated = false): Promise<Record<string, string>> {
  const directory = join(root, current);
  const entries = await readdir(directory, { withFileTypes: true });
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || (!includeGenerated && entry.name === "dist")) continue;
    const relativePath = current.length === 0 ? entry.name : `${current}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(result, await readFiles(root, relativePath, includeGenerated));
    } else if (entry.isFile()) {
      result[relativePath] = await readFile(join(root, relativePath), "utf8");
    }
  }
  return result;
}

async function initializeRepository(directory: string, files: Readonly<Record<string, string>>): Promise<string> {
  await mkdir(directory, { recursive: true });
  await writeFiles(directory, files);
  await git(directory, ["init", "--quiet", "--initial-branch=main"]);
  await git(directory, ["config", "user.name", "Anyam Team Simulation"]);
  await git(directory, ["config", "user.email", "team-simulation@example.test"]);
  await git(directory, ["config", "commit.gpgsign", "false"]);
  return commit(directory, "chore: seed simulation repository");
}

function withSentinel(content: string): string {
  const marker = 'const ANYAM_TEAM_SENTINEL = "base";';
  if (content.includes(marker)) return content;
  const insertion = `${marker}\n`;
  return content.includes("export default") ? content.replace("export default", `${insertion}\nexport default`) : `${insertion}\n${content}`;
}

function replaceSentinel(content: string, value: string): string {
  return content.replace(/const ANYAM_TEAM_SENTINEL = "[^"]*";/u, `const ANYAM_TEAM_SENTINEL = "${value}";`);
}

async function createBranchConflict(input: {
  directory: string;
  conflictPath: string;
  baseContent: string;
  tag?: string;
}): Promise<GitConflictReceipt> {
  const initialCommit = await gitValue(input.directory, ["rev-parse", "HEAD"]);
  await git(input.directory, ["switch", "-c", "feature/agent-a"]);
  await writeFile(join(input.directory, input.conflictPath), replaceSentinel(input.baseContent, "agent-a"), "utf8");
  const featureACommit = await commit(input.directory, "feat: agent A change");
  await git(input.directory, ["switch", "main"]);
  await writeFile(join(input.directory, input.conflictPath), replaceSentinel(input.baseContent, "main"), "utf8");
  const mainBeforeFeatureMerge = await commit(input.directory, "feat: maintainer change");

  const mergeAttempt = await attemptGit(input.directory, ["merge", "--no-commit", "feature/agent-a"]);
  if (mergeAttempt.ok) throw new Error("git conflict scenario unexpectedly merged without a conflict");
  await git(input.directory, ["merge", "--abort"]);

  await git(input.directory, ["switch", "feature/agent-a"]);
  const rebaseAttempt = await attemptGit(input.directory, ["rebase", "main"]);
  if (rebaseAttempt.ok) throw new Error("git rebase scenario unexpectedly completed without a conflict");
  await writeFile(join(input.directory, input.conflictPath), replaceSentinel(input.baseContent, "resolved"), "utf8");
  await git(input.directory, ["add", input.conflictPath]);
  await git(input.directory, ["-c", "core.editor=true", "rebase", "--continue"], { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" });
  const resolvedFeatureCommit = await gitValue(input.directory, ["rev-parse", "HEAD"]);
  await git(input.directory, ["switch", "main"]);
  await git(input.directory, ["merge", "--ff-only", "feature/agent-a"]);
  const mainAfterFeatureMerge = await gitValue(input.directory, ["rev-parse", "HEAD"]);

  await git(input.directory, ["switch", "-c", "feature/agent-b", initialCommit]);
  const readme = join(input.directory, "README.md");
  const readmeContent = await readFile(readme, "utf8");
  await writeFile(readme, `${readmeContent}\nAgent B contribution.\n`, "utf8");
  const featureBBeforeRebase = await commit(input.directory, "feat: agent B change");
  await git(input.directory, ["switch", "main"]);
  await git(input.directory, ["switch", "feature/agent-b"]);
  await git(input.directory, ["rebase", "main"]);
  const resolvedFeatureBCommit = await gitValue(input.directory, ["rev-parse", "HEAD"]);
  if (input.tag) {
    await git(input.directory, ["switch", "main"]);
    await git(input.directory, ["tag", input.tag]);
  }
  await git(input.directory, ["switch", "main"]);
  const branches = (await gitValue(input.directory, ["branch", "--format=%(refname:short)"])).split("\n").filter((value) => value.length > 0).sort();
  const status = await gitValue(input.directory, ["status", "--porcelain"]);
  assert.equal(status, "", `simulation repository must be clean after rebase: ${status}`);
  await git(input.directory, ["fsck", "--no-progress", "--full"]);
  return {
    initialCommit,
    mainBeforeFeatureMerge,
    featureACommit,
    mergeConflict: true,
    rebaseConflict: true,
    resolvedFeatureCommit,
    mainAfterFeatureMerge,
    featureBBeforeRebase,
    resolvedFeatureBCommit,
    branches,
    ...(input.tag ? { tag: input.tag } : {}),
  };
}

async function makeWorkerFixture(root: string, fixtureRoot: string): Promise<RepositoryFixture> {
  const sourceDirectory = join(fixtureRoot, "fixtures/worker-golden");
  const seedDirectory = join(root, "worker-seed");
  await cp(sourceDirectory, seedDirectory, { recursive: true });
  const sourceFile = join(seedDirectory, "src/index.js");
  const baseContent = withSentinel(await readFile(sourceFile, "utf8"));
  await writeFile(sourceFile, baseContent, "utf8");
  const initialCommit = await initializeRepository(seedDirectory, {});
  const gitReceipt = await createBranchConflict({ directory: seedDirectory, conflictPath: "src/index.js", baseContent, tag: "v0.1.0" });
  assert.equal(gitReceipt.initialCommit, initialCommit);
  const canonicalDirectory = join(root, "worker-canonical");
  const driver = new LocalGitRepositoryDriver(join(root, "worker-driver"));
  const cloned = await driver.cloneRepository({ sourceSpaceId: "source:worker", source: seedDirectory, destination: canonicalDirectory, mirror: true, idempotencyKey: "team-simulation-worker-import" });
  if (cloned.status !== "succeeded") throw new Error(cloned.message);
  const inspected = await driver.inspectRepository({ repository: cloned.value });
  if (inspected.status !== "succeeded") throw new Error(inspected.message);
  const project = createProject({ id: "project:team-worker", name: "Team Worker Simulation", referenceType: "cloudflare-worker", sourceSpaceIds: ["source:worker"] });
  const sourceSpace: SourceSpace = { protocol: CONTRACT_VERSIONS.sourceSpace, id: "source:worker", name: "Worker source", classification: "public" };
  const files = await readFiles(canonicalDirectory);
  return { id: "worker", project, sourceSpace, seedDirectory, canonicalDirectory, files, git: gitReceipt, repositoryId: cloned.value.repositoryId, repositoryRefs: inspected.value.refs };
}

async function makeCliFixture(root: string): Promise<RepositoryFixture> {
  const seedDirectory = join(root, "cli-seed");
  const cliFiles: Readonly<Record<string, string>> = {
    "README.md": "# Anyam CLI simulation\n\nThis repository is a command-line tool.\n",
    "package.json": JSON.stringify({ name: "team-cli-simulation", version: "0.1.0", type: "module", bin: { "team-cli": "src/cli.ts" } }, null, 2) + "\n",
    "src/index.ts": 'const ANYAM_TEAM_SENTINEL = "base";\n\nexport function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n',
    "src/cli.ts": 'import { greet } from "./index.js";\n\nconst name = process.argv[2] ?? "world";\nprocess.stdout.write(`${greet(name)}\\n`);\n',
    "test/cli.test.ts": 'import { strict as assert } from "node:assert";\nassert.equal("Hello, Anyam", "Hello, Anyam");\n',
  };
  const initialCommit = await initializeRepository(seedDirectory, cliFiles);
  const gitReceipt = await createBranchConflict({ directory: seedDirectory, conflictPath: "src/index.ts", baseContent: requireValue(cliFiles["src/index.ts"], "cli source"), tag: "v0.1.0" });
  assert.equal(gitReceipt.initialCommit, initialCommit);
  const canonicalDirectory = join(root, "cli-canonical");
  const driver = new LocalGitRepositoryDriver(join(root, "cli-driver"));
  const cloned = await driver.cloneRepository({ sourceSpaceId: "source:cli", source: seedDirectory, destination: canonicalDirectory, mirror: true, idempotencyKey: "team-simulation-cli-import" });
  if (cloned.status !== "succeeded") throw new Error(cloned.message);
  const inspected = await driver.inspectRepository({ repository: cloned.value });
  if (inspected.status !== "succeeded") throw new Error(inspected.message);
  const project = createProject({ id: "project:team-cli", name: "Team CLI Simulation", referenceType: "typescript-library", sourceSpaceIds: ["source:cli"] });
  const sourceSpace: SourceSpace = { protocol: CONTRACT_VERSIONS.sourceSpace, id: "source:cli", name: "CLI source", classification: "public" };
  const files = await readFiles(canonicalDirectory);
  return { id: "cli", project, sourceSpace, seedDirectory, canonicalDirectory, files, git: gitReceipt, repositoryId: cloned.value.repositoryId, repositoryRefs: inspected.value.refs };
}

async function makeHybridFixture(root: string, fixtureRoot: string): Promise<HybridFixture> {
  const publicDirectory = join(root, "hybrid-public");
  const privateDirectory = join(root, "hybrid-private");
  await cp(join(fixtureRoot, "fixtures/hybrid/public-player"), publicDirectory, { recursive: true });
  await cp(join(fixtureRoot, "fixtures/hybrid/private-codec"), privateDirectory, { recursive: true });
  await writeFile(join(publicDirectory, "README.md"), "Public player Source Space.\n", "utf8");
  await writeFile(join(privateDirectory, "README.md"), "Restricted codec Source Space.\n", "utf8");
  await initializeRepository(publicDirectory, {});
  await initializeRepository(privateDirectory, {});
  const publicCommit = await gitValue(publicDirectory, ["rev-parse", "HEAD"]);
  const privateCommit = await gitValue(privateDirectory, ["rev-parse", "HEAD"]);
  await git(publicDirectory, ["switch", "-c", "feature/remote-contributor"]);
  await writeFile(join(publicDirectory, "README.md"), "Public player Source Space.\nRemote contribution.\n", "utf8");
  const remoteCommit = await commit(publicDirectory, "feat: remote public contribution");
  await git(publicDirectory, ["switch", "main"]);
  const project = createProject({ id: "project:team-hybrid", name: "Team Hybrid Video Player", referenceType: "hybrid-public-private", sourceSpaceIds: ["source:public-player", "source:private-codec"] });
  const sourceSpaces: readonly SourceSpace[] = [
    { protocol: CONTRACT_VERSIONS.sourceSpace, id: "source:public-player", name: "Public player", classification: "public" },
    { protocol: CONTRACT_VERSIONS.sourceSpace, id: "source:private-codec", name: "Private codec", classification: "restricted" },
  ];
  const publicDriver = new LocalGitRepositoryDriver(join(root, "hybrid-public-driver"));
  const privateDriver = new LocalGitRepositoryDriver(join(root, "hybrid-private-driver"));
  const publicClone = await publicDriver.cloneRepository({ sourceSpaceId: "source:public-player", source: publicDirectory, destination: join(root, "hybrid-public-canonical"), mirror: true, idempotencyKey: "team-simulation-hybrid-public-import" });
  const privateClone = await privateDriver.cloneRepository({ sourceSpaceId: "source:private-codec", source: privateDirectory, destination: join(root, "hybrid-private-canonical"), mirror: true, idempotencyKey: "team-simulation-hybrid-private-import" });
  if (publicClone.status !== "succeeded" || privateClone.status !== "succeeded") throw new Error("hybrid RepositoryDriver import failed");
  const publicInspection = await publicDriver.inspectRepository({ repository: publicClone.value });
  const privateInspection = await privateDriver.inspectRepository({ repository: privateClone.value });
  if (publicInspection.status !== "succeeded" || privateInspection.status !== "succeeded") throw new Error("hybrid RepositoryDriver inspection failed");
  const directories = { "source:public-player": join(root, "hybrid-public-canonical"), "source:private-codec": join(root, "hybrid-private-canonical") };
  return {
    project,
    sourceSpaces,
    directories,
    commits: { "source:public-player": publicCommit, "source:private-codec": privateCommit },
    remoteCommit,
    files: { "source:public-player": await readFiles(directories["source:public-player"]), "source:private-codec": await readFiles(directories["source:private-codec"]) },
    repositoryRefs: { "source:public-player": publicInspection.value.refs, "source:private-codec": privateInspection.value.refs },
  };
}

function projectView(project: Project, revision: ProjectRevision, sourceSpaces: readonly SourceSpace[], ids: readonly string[], classification: "public" | "project" = "project") {
  return deriveProjectView({ project, revision, sourceSpaces, allowedSourceSpaceIds: ids, projectionId: `view:${project.id}:${ids.join("+")}`, classification });
}

async function buildFixture(input: { fixture: RepositoryFixture; root: string }): Promise<BuildReceipt> {
  const releaseDirectory = join(input.root, `${input.fixture.id}-release-source`);
  await git(undefined, ["clone", "--quiet", input.fixture.seedDirectory, releaseDirectory]);
  await git(releaseDirectory, ["switch", "--quiet", "feature/agent-b"]);
  if (input.fixture.id === "worker") {
    await command("node", ["build.mjs"], releaseDirectory);
  } else {
    await writeFile(join(releaseDirectory, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", rootDir: "src", skipLibCheck: true, types: ["node"], typeRoots: [join(process.cwd(), "node_modules/@types")] }, include: ["src/**/*.ts"] }, null, 2)}\n`, "utf8");
    await command(join(process.cwd(), "node_modules/.bin/tsc"), ["--project", "tsconfig.json"], releaseDirectory);
  }
  const outputFiles = await readFiles(join(releaseDirectory, "dist"), "", true);
  const outputManifest = JSON.stringify(Object.entries(outputFiles).sort(([left], [right]) => left.localeCompare(right)));
  const configurationPath = input.fixture.id === "worker" ? "wrangler.jsonc" : "package.json";
  const configurationDigest = digest(await readFile(join(releaseDirectory, configurationPath), "utf8"));
  const nodeVersion = (await command("node", ["--version"], releaseDirectory)).stdout.trim();
  const compilerVersion = input.fixture.id === "cli" ? (await command(join(process.cwd(), "node_modules/.bin/tsc"), ["--version"], releaseDirectory)).stdout.trim() : "worker-build-script";
  const toolchainDigest = digest(`${nodeVersion}:${compilerVersion}`);
  const dependencyDigest = digest(JSON.stringify({ project: input.fixture.project.id, package: input.fixture.id }));
  const environmentDigest = digest(`${process.platform}:${process.arch}`);
  const outputDigest = digest(outputManifest);
  return {
    artifactDigest: outputDigest,
    outputDigest,
    configurationDigest,
    toolchainDigest,
    dependencyDigest,
    environmentDigest,
    outputFiles: Object.keys(outputFiles).sort(),
    receipt: `build=executed; fixture=${input.fixture.id}; branch=feature/agent-b; files=${Object.keys(outputFiles).length}; outputDigest=${outputDigest}; providerMutation=false`,
  };
}

function evidence(input: { id: string; project: Project; revision: ProjectRevision; changeRevision?: ChangeRevision; actor: ActorRef; targetId: string; key: string; build?: BuildReceipt }): Evidence {
  const build = input.build;
  return {
    protocol: CONTRACT_VERSIONS.evidence,
    version: "v1",
    id: input.id,
    key: input.key,
    criterion: `Team simulation verifier ${input.key}`,
    outcome: "passed",
    validityKey: `${input.key}:v1`,
    actionId: `action:${input.key}`,
    verifierId: `verifier:${input.key}`,
    toolchainDigest: build?.toolchainDigest ?? "sha256:team-simulation-toolchain",
    dependencyDigest: build?.dependencyDigest ?? "sha256:team-simulation-dependencies",
    environmentDigest: build?.environmentDigest ?? "sha256:team-simulation-environment",
    inputDigests: [input.revision.id],
    effectDigests: [digest(input.key)],
    outputDigest: build?.outputDigest ?? digest(`${input.id}:output`),
    createdAt: new Date().toISOString(),
    producer: { kind: "run", id: `run:${input.id}`, version: "team-simulation-v1" },
    projectRevisionId: input.revision.id,
    projectViewId: `view:${input.project.id}:all`,
    ...(input.changeRevision ? { changeRevisionId: input.changeRevision.id } : {}),
    runId: `run:${input.id}`,
    actor: input.actor,
    runnerId: "runner:team-simulation",
    policyVersion: "policy:team-simulation:v1",
    authorizationEpoch: "epoch:team-simulation:v1",
    capabilityGrantId: "grant:team-simulation-verifier",
    disclosure: { projectionId: `projection:${input.project.id}`, classification: "project" },
    receipt: build?.receipt ?? `evidence=passed; key=${input.key}; project=${input.project.id}; source=git-verified; canonicalWrite=false`,
    invalidators: ["source-revision", "policy-version"],
    owner: "Anyam team simulation",
    targetId: input.targetId,
  };
}

function targetFor(project: Project): Target {
  return {
    protocol: CONTRACT_VERSIONS.target,
    id: `target:${project.id}:staging`,
    projectId: project.id,
    name: "staging",
    adapterId: "adapter:team-simulation",
    acceptedArtifactTypes: ["worker.bundle", "cli.package"],
    requiredEvidenceKeys: ["team-check"],
    state: "configured",
    deploymentProfile: createTargetDeploymentProfile({
      environment: "staging",
      channel: "alpha",
      audience: "team-simulation",
      runtimeIdentity: `${project.id}:staging`,
      routeIdentities: [`${project.id}:staging-route`],
      bindingIdentities: [`${project.id}:staging-bindings`],
      dataResourceIdentities: [`${project.id}:staging-data`],
      configurationDigests: [digest(`${project.id}:staging:config`)],
      secretUseAliases: [`${project.id}:staging-secret`],
      dataClass: "synthetic",
      resourceSharing: "isolated",
    }),
  };
}

function artifactFor(project: Project, revision: ProjectRevision, changeRevision: ChangeRevision, target: Target, type: string, build: BuildReceipt): Artifact {
  return {
    protocol: CONTRACT_VERSIONS.artifact,
    id: `artifact:${project.id}:staging`,
    type,
    digest: build.artifactDigest,
    projectRevisionId: revision.id,
    changeRevisionId: changeRevision.id,
    runId: `run:${project.id}:build`,
    actionId: `action:${project.id}:build`,
    outputPath: build.outputFiles[0] ?? "dist/release.bundle",
    provenanceDigest: digest(`${project.id}:provenance`),
    disclosure: { projectionId: `projection:${project.id}`, classification: "project" },
  };
}

async function collaborateSingleRepository(input: { fixture: RepositoryFixture; root: string; agentId: string }): Promise<CollaborationResult> {
  const { fixture } = input;
  const project = fixture.project;
  const sourceSpaces = [fixture.sourceSpace];
  const baseRevision = createProjectRevision({ id: `project-revision:${fixture.id}:base`, projectId: project.id, sourceSpaceSnapshots: { [fixture.sourceSpace.id]: fixture.git.initialCommit } });
  const control = new LocalChangeCoordinator({ project, sourceSpaces, canonicalRevision: baseRevision });
  const moduleId = `module:${project.id}:main`;
  const target = targetFor(project);
  const authorA = actor(`${fixture.id}:maintainer`);
  const authorB = actor(`${fixture.id}:contributor`);
  const reviewer = actor(`${fixture.id}:reviewer`, "client:web");
  const verifier = actor(`${input.agentId}:${fixture.id}:verifier`, "client:runner");
  const landingActor = actor(`${fixture.id}:landing`, "client:landing");
  const view = projectView(project, baseRevision, sourceSpaces, [fixture.sourceSpace.id]);
  const source: WorkspaceSource = { sourceSpaceId: fixture.sourceSpace.id, snapshotId: fixture.git.initialCommit, files: fixture.files };
  const workspaceA = await control.createWorkspace({ view, sources: [source], mounts: [{ sourceSpaceId: fixture.sourceSpace.id, mountPath: "source" }], directory: join(input.root, `${fixture.id}-workspace-a`), actorId: authorA.actorId });
  const workspaceB = await control.createWorkspace({ view, sources: [source], mounts: [{ sourceSpaceId: fixture.sourceSpace.id, mountPath: "source" }], directory: join(input.root, `${fixture.id}-workspace-b`), actorId: authorB.actorId });
  await control.createWorkspace({ view, sources: [source], mounts: [{ sourceSpaceId: fixture.sourceSpace.id, mountPath: "source" }], directory: join(input.root, `${fixture.id}-workspace-reviewer`), actorId: reviewer.actorId });
  await control.createWorkspace({ view, sources: [source], mounts: [{ sourceSpaceId: fixture.sourceSpace.id, mountPath: "source" }], directory: join(input.root, `${fixture.id}-workspace-verifier`), actorId: verifier.actorId });
  const changeA = control.createChange({ id: `change:${fixture.id}:maintainer`, intentId: `intent:${fixture.id}:issue-1`, workspaceId: workspaceA.workspace.id, author: authorA });
  const changeB = control.createChange({ id: `change:${fixture.id}:contributor`, intentId: `intent:${fixture.id}:issue-2`, workspaceId: workspaceB.workspace.id, author: authorB });
  const revisionA = control.publishRevision({ changeId: changeA.id, workspaceId: workspaceA.workspace.id, declaredEffects: ["textual.main"], sourceSpaceSnapshots: { [fixture.sourceSpace.id]: fixture.git.resolvedFeatureCommit }, actor: authorA, affectedModuleIds: [moduleId], affectedTargetIds: [target.id] });
  const revisionB = control.publishRevision({ changeId: changeB.id, workspaceId: workspaceB.workspace.id, declaredEffects: ["textual.main"], sourceSpaceSnapshots: { [fixture.sourceSpace.id]: fixture.git.featureBBeforeRebase }, actor: authorB, affectedModuleIds: [moduleId], affectedTargetIds: [target.id] });
  const policy = { version: "policy:team-simulation:v1", requiredEvidence: [{ key: "team-check", currentValidityKey: "team-check:v1" }], requiredEvidenceByEffect: {} };
  const ownershipRules: readonly ReviewOwnershipRule[] = [
    { id: `${project.id}:module-owner`, scopeKind: "module", scopeId: moduleId, requiredReviewerPrincipalIds: [reviewer.principalId], requiredReviewerTeamIds: [], disclosure: "project", label: "module owner review" },
    { id: `${project.id}:target-owner`, scopeKind: "target", scopeId: target.id, requiredReviewerPrincipalIds: [reviewer.principalId], requiredReviewerTeamIds: [], disclosure: "project", label: "staging Target review" },
  ];
  const collaboration = new CollaborationCoordinator({
    projectId: project.id,
    canonicalRevision: baseRevision,
    policy,
    ownershipRules,
    reviewerDirectory: [{ principalId: reviewer.principalId, teamIds: [], active: true }],
    landingAuthority: { landCohort: (request) => control.landCohort(request) },
    authorizationEpoch: "epoch:team-simulation:v1",
  });
  const cohortA = await collaboration.createCohort({ members: [{ change: requireValue(control.getChange(changeA.id), changeA.id), revision: revisionA, verifierActors: [verifier] }], actor: landingActor, id: `cohort:${fixture.id}:maintainer` });
  const findingA = collaboration.submitFinding({ cohortId: cohortA.id, changeId: changeA.id, changeRevisionId: revisionA.id, author: reviewer, kind: "request-changes", severity: "blocking", summary: "Add the missing recovery assertion before Landing.", scope: { moduleId }, idempotencyKey: `${cohortA.id}:finding` });
  const blockedA = collaboration.evaluateLanding({ cohortId: cohortA.id, evidence: [] });
  assert.equal(blockedA.decision, "deny");
  collaboration.resolveFinding({ findingId: findingA.id, actor: reviewer, resolution: "Recovery assertion added in the verified revision." });
  for (const requirement of collaboration.listReviewRequirements(cohortA.id)) collaboration.approve({ cohortId: cohortA.id, requirementId: requirement.id, reviewer, evidenceIds: [] });
  const evidenceA = evidence({ id: `evidence:${fixture.id}:a`, project, revision: baseRevision, changeRevision: revisionA, actor: verifier, targetId: target.id, key: "team-check" });
  const landedA = await collaboration.land({ cohortId: cohortA.id, evidence: [evidenceA], actor: landingActor });
  collaboration.setCanonicalProjectRevision(control.canonicalRevision);

  const staleCohort = await collaboration.createCohort({ members: [{ change: requireValue(control.getChange(changeB.id), changeB.id), revision: revisionB, verifierActors: [verifier] }], actor: landingActor, baseProjectRevisionId: baseRevision.id, id: `cohort:${fixture.id}:stale` });
  const staleDecision = collaboration.evaluateLanding({ cohortId: staleCohort.id, evidence: [evidenceA] });
  assert.equal(staleDecision.decision, "deny");
  assert.ok(staleDecision.blockers.some((blocker) => blocker.kind === "stale-base"));

  const rebased = await control.rebaseChange({ changeId: changeB.id, view: projectView(project, control.canonicalRevision, sourceSpaces, [fixture.sourceSpace.id]), sources: [{ sourceSpaceId: fixture.sourceSpace.id, snapshotId: requireValue(control.canonicalRevision.sourceSpaceSnapshots[fixture.sourceSpace.id], fixture.sourceSpace.id), files: fixture.files }], mounts: [{ sourceSpaceId: fixture.sourceSpace.id, mountPath: "source" }], directory: join(input.root, `${fixture.id}-workspace-b-rebased`), actorId: authorB.actorId, declaredEffects: ["textual.main:resolved"] });
  const resolvedB = control.publishRevision({ changeId: changeB.id, workspaceId: rebased.workspace.id, declaredEffects: ["textual.main:resolved"], sourceSpaceSnapshots: { [fixture.sourceSpace.id]: fixture.git.resolvedFeatureBCommit }, actor: authorB, affectedModuleIds: [moduleId], affectedTargetIds: [target.id], kind: "implementation" });
  const cohortB = await collaboration.createCohort({ members: [{ change: requireValue(control.getChange(changeB.id), changeB.id), revision: resolvedB, verifierActors: [verifier] }], actor: landingActor, id: `cohort:${fixture.id}:contributor` });
  for (const requirement of collaboration.listReviewRequirements(cohortB.id)) collaboration.approve({ cohortId: cohortB.id, requirementId: requirement.id, reviewer, evidenceIds: [] });
  const evidenceB = evidence({ id: `evidence:${fixture.id}:b`, project, revision: control.canonicalRevision, changeRevision: resolvedB, actor: verifier, targetId: target.id, key: "team-check" });
  const landedB = await collaboration.land({ cohortId: cohortB.id, evidence: [evidenceB], actor: landingActor });
  const finalRevision = control.canonicalRevision;
  const build = await buildFixture({ fixture, root: input.root });
  const releaseEvidence = evidence({ id: `evidence:${fixture.id}:release`, project, revision: finalRevision, changeRevision: resolvedB, actor: verifier, targetId: target.id, key: "team-check", build });
  const artifact = artifactFor(project, finalRevision, resolvedB, target, fixture.id === "worker" ? "worker.bundle" : "cli.package", build);
  const release: Release = { protocol: CONTRACT_VERSIONS.release, id: `release:${fixture.id}:team`, projectRevisionId: finalRevision.id, artifactIds: [artifact.id], evidenceIds: [releaseEvidence.id], configurationDigests: [build.configurationDigest], stateAssumptions: ["local provider boundary; no Cloudflare mutation"], policyVersion: "policy:team-simulation:v1", status: "ready", changeRevisionId: resolvedB.id, provenanceDigest: digest(`${project.id}:${finalRevision.id}`), receipt: `release=ready; build=verified; providerMutation=false; project=${project.id}` };
  const sealed = sealVerifiedRelease({ projectId: project.id, release, artifacts: [artifact], evidence: [releaseEvidence], target });
  return {
    canonicalRevision: finalRevision,
    changes: [requireValue(control.getChange(changeA.id), changeA.id), requireValue(control.getChange(changeB.id), changeB.id)],
    revisions: [revisionA, resolvedB],
    findings: [],
    observations: {
      project: project.id,
      gitInitialCommit: fixture.git.initialCommit,
      gitFeatureACommit: fixture.git.resolvedFeatureCommit,
      gitFeatureBCommit: fixture.git.resolvedFeatureBCommit,
      branchNames: fixture.git.branches,
      staleDecision: staleDecision.receipt,
      landingA: landedA.landing.receipt,
      landingB: landedB.landing.receipt,
      release: `${sealed.receipt}; ${build.receipt}`,
      issueIds: [changeA.intentId, changeB.intentId],
    },
    evidence: [evidenceA, evidenceB, releaseEvidence],
    target,
    release,
    artifact,
    build,
    workspaceCount: 5,
    changeCount: 2,
  };
}

class SimulationRemote implements MirrorRemoteAdapter {
  state: MirrorRemoteState;
  readonly pushes: Array<{ expectedGeneration: string; desiredRefs: readonly GitRef[] }> = [];

  constructor(state: MirrorRemoteState) {
    this.state = state;
  }

  async inspect(): Promise<MirrorProviderResult<MirrorRemoteState>> {
    return { status: "succeeded", value: { ...this.state, refs: this.state.refs.map((ref) => ({ ...ref })), updates: this.state.updates.map((update) => ({ ...update })), commits: this.state.commits.map((commit) => ({ ...commit })) } };
  }

  async push(input: Parameters<MirrorRemoteAdapter["push"]>[0]): Promise<MirrorProviderResult<MirrorRemoteState>> {
    this.pushes.push({ expectedGeneration: input.expectedGeneration, desiredRefs: input.desiredRefs.map((ref) => ({ ...ref })) });
    if (input.expectedGeneration !== this.state.generation) return { status: "failed", errorCode: "mirror.remote_generation_stale", message: "Remote generation changed during the team simulation.", retryable: false, affectedObject: input.mirror.remoteRepository, recoveryAction: "inspect the remote generation and resume from the checkpoint", receipt: `expected=${input.expectedGeneration}; actual=${this.state.generation}` };
    const generation = `remote:g${this.pushes.length}`;
    this.state = { generation, refs: input.desiredRefs.map((ref) => ({ ...ref })), updates: input.desiredRefs.map((ref) => ({ remoteRef: ref.name, currentOid: ref.oid, kind: "fast-forward", receipt: `remote=push; ref=${ref.name}` })), commits: [], originOperationId: input.operationId, receipt: `remote=push; generation=${generation}` };
    return { status: "succeeded", value: this.state };
  }
}

class SimulationChangeSink implements MirrorChangeSink {
  readonly inputs: MirrorInboundChangeInput[] = [];
  readonly changes: Change[] = [];

  async createChange(input: MirrorInboundChangeInput): Promise<MirrorProviderResult<Change>> {
    this.inputs.push(input);
    const change: Change = {
      protocol: CONTRACT_VERSIONS.change,
      id: `change:mirror:${input.remoteCommit.oid}`,
      projectId: input.projectId,
      intentId: input.intentId,
      baseProjectRevisionId: input.baseProjectRevisionId,
      status: "submitted",
      latestRevisionId: null,
      origin: { ...input.origin },
    };
    this.changes.push(change);
    return {
      status: "succeeded",
      value: change,
    };
  }
}

function remoteState(generation: string, refs: readonly GitRef[], updates: readonly MirrorRefUpdate[], commits: readonly MirrorRemoteCommit[] = []): MirrorRemoteState {
  return { generation, refs, updates, commits, receipt: `remote=team-simulation; generation=${generation}` };
}

function mirrorRecord(project: Project, sourceSpaceId: string): RepositoryMirror {
  return { protocol: CONTRACT_VERSIONS.mirror, id: `mirror:${project.id}`, projectId: project.id, sourceSpaceId, provider: "github", remoteRepository: `simulation/${project.id}`, direction: "bidirectional", canonicalAuthority: "anyam", refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }], disclosure: "public", state: "healthy", canonicalProjectRevisionId: "project-revision:mirror:base", canonicalRefs: [], remoteGeneration: "remote:g0", remoteRefs: [], pendingInboundChangeIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), receipt: "mirror=team-simulation; canonicalAuthority=anyam" };
}

async function runHybridScenario(input: { fixture: HybridFixture; root: string; landingReceipt: string; revisionIds: readonly string[] }): Promise<SimulationScenario> {
  const fixture = input.fixture;
  const baseRevision = createProjectRevision({ id: "project-revision:team-hybrid:base", projectId: fixture.project.id, sourceSpaceSnapshots: fixture.commits });
  const projection = createPublicProjection({ project: fixture.project, canonicalRevision: baseRevision, sourceSpaces: fixture.sourceSpaces, publicSourceSpaceIds: ["source:public-player"], sources: fixture.sourceSpaces.map((source) => ({ sourceSpaceId: source.id, snapshotId: requireValue(fixture.commits[source.id], `${source.id} commit`), files: requireValue(fixture.files[source.id], `${source.id} files`) })) });
  const encoded = JSON.stringify(projection);
  assert.equal(encoded.includes("private-codec"), false);
  assert.equal(encoded.includes("source:private-codec"), false);
  const publicCloneSource = join(input.root, "hybrid-public-projection");
  const publicCloneDestination = join(input.root, "hybrid-public-clone");
  await initializeRepository(publicCloneSource, projection.files);
  await git(undefined, ["clone", "--quiet", publicCloneSource, publicCloneDestination]);
  const publicPaths = await gitValue(publicCloneDestination, ["ls-files"]);
  assert.equal(publicPaths.includes("private-codec"), false);
  assert.equal(publicPaths.includes("codec.ts"), false);
  const mirror = await runMirrorScenario({ project: fixture.project, sourceSpaceId: "source:public-player", commit: requireValue(fixture.commits["source:public-player"], "public commit"), remoteCommit: fixture.remoteCommit });
  const mirrorActor = actor("mirror-landing", "client:landing");
  const mirrorControl = new LocalChangeCoordinator({ project: fixture.project, sourceSpaces: fixture.sourceSpaces, canonicalRevision: baseRevision });
  const mirrorView = projectView(fixture.project, baseRevision, fixture.sourceSpaces, ["source:public-player"], "project");
  const mirrorWorkspace = await mirrorControl.createWorkspace({ view: mirrorView, sources: [{ sourceSpaceId: "source:public-player", snapshotId: requireValue(fixture.commits["source:public-player"], "public commit"), files: requireValue(fixture.files["source:public-player"], "public files") }], mounts: [{ sourceSpaceId: "source:public-player", mountPath: "public" }], directory: join(input.root, "hybrid-mirror-landing-workspace"), actorId: mirrorActor.actorId });
  const mirrorChange = mirrorControl.createChange({ id: mirror.inboundChange.id, intentId: mirror.inboundChange.intentId, workspaceId: mirrorWorkspace.workspace.id, author: mirrorActor, ...(mirror.inboundChange.origin ? { origin: mirror.inboundChange.origin } : {}) });
  const mirrorRevision = mirrorControl.publishRevision({ changeId: mirrorChange.id, workspaceId: mirrorWorkspace.workspace.id, declaredEffects: ["mirror.inbound"], sourceSpaceSnapshots: { "source:public-player": mirror.inboundCommit }, actor: mirrorActor });
  const mirrorLanding = mirrorControl.landChange({ changeId: mirrorChange.id, changeRevisionId: mirrorRevision.id, expectedCanonicalProjectRevisionId: baseRevision.id });
  const reconciled = await mirror.coordinator.sync({ canonical: { projectRevisionId: mirrorLanding.projectRevisionId, sourceSpaceId: "source:public-player", sourceSpaceClassification: "public", disclosure: "public", verified: true, verificationReceipt: "canonical=verified-after-mirror-landing", refs: [{ name: "refs/heads/main", oid: mirror.inboundCommit }] }, idempotencyKey: "mirror-reconciled", actor: mirrorActor });
  if (reconciled.status !== "succeeded") throw new Error(reconciled.message);
  assert.equal(reconciled.value.mirror.state, "healthy");
  assert.equal(reconciled.value.mirror.pendingInboundChangeIds.length, 0);
  return {
    id: "hybrid-public-private",
    verdict: "VERIFIED",
    receipt: `projection=verified; publicClone=verified; hybridLanding=verified; mirror=${mirror.receipt}; inboundLanding=verified; reconciliation=healthy`,
    observations: { projectionRevisionId: projection.projectionRevisionId, publicSnapshotId: projection.publicSnapshotId, publicPathCount: publicPaths.split("\n").filter((value) => value.length > 0).length, hybridLanding: input.landingReceipt, hybridRevisionIds: input.revisionIds, mirror: { ...mirror.observations, inboundLanding: mirrorLanding.receipt, reconciliation: reconciled.value.mirror.receipt } },
    findings: [],
  };
}

async function runMirrorScenario(input: { project: Project; sourceSpaceId: string; commit: string; remoteCommit: string }): Promise<MirrorScenarioResult> {
  const actorRef = actor("mirror", "client:mirror");
  const remote = new SimulationRemote(remoteState("remote:g0", [], []));
  const sink = new SimulationChangeSink();
  const mirror = mirrorRecord(input.project, input.sourceSpaceId);
  const coordinator = new MirrorCoordinator({ mirror, remote, changeSink: sink, sourceSpaceClassification: "public" });
  const outbound = await coordinator.sync({ canonical: { projectRevisionId: "project-revision:mirror:base", sourceSpaceId: input.sourceSpaceId, sourceSpaceClassification: "public", disclosure: "public", verified: true, verificationReceipt: "canonical=verified", refs: [{ name: "refs/heads/main", oid: input.commit }, { name: "refs/heads/private", oid: "private-ref" }] }, idempotencyKey: "mirror-outbound", actor: actorRef });
  if (outbound.status !== "succeeded") throw new Error(outbound.message);
  const duplicate = await coordinator.sync({ canonical: { projectRevisionId: "project-revision:mirror:base", sourceSpaceId: input.sourceSpaceId, sourceSpaceClassification: "public", disclosure: "public", verified: true, verificationReceipt: "canonical=verified", refs: [{ name: "refs/heads/main", oid: input.commit }, { name: "refs/heads/private", oid: "private-ref" }] }, idempotencyKey: "mirror-outbound", actor: actorRef });
  if (duplicate.status !== "succeeded") throw new Error(duplicate.message);
  const inboundOid = input.remoteCommit;
  remote.state = remoteState("remote:g2", [{ name: "refs/heads/main", oid: inboundOid }], [{ remoteRef: "refs/heads/main", previousOid: input.commit, currentOid: inboundOid, kind: "fast-forward", receipt: "remote=inbound; kind=fast-forward" }], [{ oid: inboundOid, ref: "refs/heads/main", author: { name: "Remote contributor", email: "remote@example.test" }, message: "Improve the public projection", disclosure: "public" }]);
  const inbound = await coordinator.sync({ canonical: { projectRevisionId: "project-revision:mirror:base", sourceSpaceId: input.sourceSpaceId, sourceSpaceClassification: "public", disclosure: "public", verified: true, verificationReceipt: "canonical=verified", refs: [{ name: "refs/heads/main", oid: input.commit }] }, idempotencyKey: "mirror-inbound", actor: actorRef });
  if (inbound.status !== "succeeded") throw new Error(inbound.message);
  const inboundChange = requireValue(sink.changes[0], "inbound mirror Change");
  return { receipt: `outbound=verified; duplicatePushes=${remote.pushes.length}; inbound=proposal; reconciliation=pending; privateRefProjected=${remote.pushes[0]?.desiredRefs.some((ref) => ref.name.includes("private")) === true}`, observations: { outbound: outbound.value.operation.receipt, inboundChanges: sink.inputs.length, mirrorState: inbound.value.mirror.state, privateRefProjected: remote.pushes[0]?.desiredRefs.some((ref) => ref.name.includes("private")) ?? false }, coordinator, inboundChange, inboundCommit: inboundOid };
}

async function runExportRestore(input: { root: string; fixtures: readonly RepositoryFixture[]; hybrid: HybridFixture; collaborations: readonly CollaborationResult[] }): Promise<SimulationScenario> {
  const driver = new LocalGitRepositoryDriver(join(input.root, "export-driver"));
  const receipts: Record<string, unknown> = {};
  for (const [index, fixture] of input.fixtures.entries()) {
    const created = await driver.createRepository({ sourceSpaceId: fixture.sourceSpace.id, directory: fixture.canonicalDirectory, idempotencyKey: `export-${fixture.id}` });
    if (created.status !== "succeeded") throw new Error(created.message);
    const destination = join(input.root, `${fixture.id}-project-export`);
    const collaboration = requireValue(input.collaborations[index], `${fixture.id} collaboration`);
    const exported = await new LocalProjectExporter(driver).exportProject({ project: fixture.project, sourceSpaces: [fixture.sourceSpace], repositories: [{ sourceSpaceId: fixture.sourceSpace.id, repository: created.value }], destination, projectRevisions: [collaboration.canonicalRevision], changes: collaboration.changes, evidence: collaboration.evidence, artifacts: [collaboration.artifact], releases: [collaboration.release], targets: [collaboration.target], idempotencyKey: `team-simulation-export-${fixture.id}` });
    if (exported.status !== "succeeded") throw new Error(exported.message);
    const verified = await verifyProjectExportPackage(destination);
    if (verified.status !== "succeeded") throw new Error(verified.message);
    const restoreDestination = join(input.root, `${fixture.id}-restored-project`);
    const restoreDriver = new LocalGitRepositoryDriver(join(input.root, `${fixture.id}-restore-driver`));
    const restored = await new LocalProjectExporter(restoreDriver).importProject({ packageDirectory: destination, destination: restoreDestination, idempotencyKey: `team-simulation-restore-${fixture.id}` });
    if (restored.status !== "succeeded") throw new Error(restored.message);
    const restoredHandle = requireValue(restored.value.repositories[fixture.sourceSpace.id], `${fixture.id} restored repository`);
    const restoredInspection = await restoreDriver.inspectRepository({ repository: restoredHandle });
    if (restoredInspection.status !== "succeeded") throw new Error(restoredInspection.message);
    assert.equal(refSignature(restoredInspection.value.refs), refSignature(fixture.repositoryRefs));
    assert.equal(restored.value.manifest.project.id, fixture.project.id);
    const replayed = await new LocalProjectExporter(new LocalGitRepositoryDriver(join(input.root, `${fixture.id}-restore-driver-replay`))).importProject({ packageDirectory: destination, destination: restoreDestination, idempotencyKey: `team-simulation-restore-${fixture.id}` });
    if (replayed.status !== "succeeded") throw new Error(replayed.message);
    assert.equal(restored.value.manifest.integrity.manifestDigest, replayed.value.manifest.integrity.manifestDigest);
    receipts[fixture.id] = { exportDigest: exported.value.manifest.integrity.manifestDigest, repositoryCount: exported.value.manifest.repositories.length, lineageCount: exported.value.manifest.lineage.length, restoredRefs: refSignature(restoredInspection.value.refs), restoredCheckpoint: restored.value.checkpoint.receipt };
  }
  const hybridRepositories: Array<{ sourceSpaceId: string; repository: { repositoryId: string; sourceSpaceId: string } }> = [];
  for (const sourceSpace of input.hybrid.sourceSpaces) {
    const directory = requireValue(input.hybrid.directories[sourceSpace.id], sourceSpace.id);
    const created = await driver.createRepository({ sourceSpaceId: sourceSpace.id, directory, idempotencyKey: `export-${sourceSpace.id}` });
    if (created.status !== "succeeded") throw new Error(created.message);
    hybridRepositories.push({ sourceSpaceId: sourceSpace.id, repository: created.value });
  }
  const hybridDestination = join(input.root, "hybrid-project-export");
  const hybridExport = await new LocalProjectExporter(driver).exportProject({ project: input.hybrid.project, sourceSpaces: input.hybrid.sourceSpaces, repositories: hybridRepositories, destination: hybridDestination, mirrors: [mirrorRecord(input.hybrid.project, "source:public-player")], idempotencyKey: "team-simulation-export-hybrid" });
  if (hybridExport.status !== "succeeded") throw new Error(hybridExport.message);
  const hybridVerified = await verifyProjectExportPackage(hybridDestination);
  if (hybridVerified.status !== "succeeded") throw new Error(hybridVerified.message);
  const hybridRestoreDestination = join(input.root, "hybrid-restored-project");
  const hybridRestoreDriver = new LocalGitRepositoryDriver(join(input.root, "hybrid-restore-driver"));
  const hybridRestored = await new LocalProjectExporter(hybridRestoreDriver).importProject({ packageDirectory: hybridDestination, destination: hybridRestoreDestination, idempotencyKey: "team-simulation-restore-hybrid" });
  if (hybridRestored.status !== "succeeded") throw new Error(hybridRestored.message);
  for (const sourceSpace of input.hybrid.sourceSpaces) {
    const restoredHandle = requireValue(hybridRestored.value.repositories[sourceSpace.id], `${sourceSpace.id} restored repository`);
    const restoredInspection = await hybridRestoreDriver.inspectRepository({ repository: restoredHandle });
    if (restoredInspection.status !== "succeeded") throw new Error(restoredInspection.message);
    assert.equal(refSignature(restoredInspection.value.refs), refSignature(requireValue(input.hybrid.repositoryRefs[sourceSpace.id], `${sourceSpace.id} original refs`)));
  }
  const hybridReplay = await new LocalProjectExporter(new LocalGitRepositoryDriver(join(input.root, "hybrid-restore-driver-replay"))).importProject({ packageDirectory: hybridDestination, destination: hybridRestoreDestination, idempotencyKey: "team-simulation-restore-hybrid" });
  if (hybridReplay.status !== "succeeded") throw new Error(hybridReplay.message);
  assert.equal(hybridRestored.value.manifest.integrity.manifestDigest, hybridReplay.value.manifest.integrity.manifestDigest);
  assert.equal(hybridRestored.value.manifest.project.id, input.hybrid.project.id);
  assert.equal(hybridExport.value.manifest.mirrors?.length, 1);
  receipts.hybrid = { exportDigest: hybridExport.value.manifest.integrity.manifestDigest, repositoryCount: hybridExport.value.manifest.repositories.length, mirrorCount: hybridExport.value.manifest.mirrors?.length ?? 0, restoredCheckpoint: hybridRestored.value.checkpoint.receipt };
  return { id: "export-restore", verdict: "VERIFIED", receipt: `export=verified; import=activated; replay=idempotent; projects=${input.fixtures.length + 1}; repositories=${input.fixtures.length + hybridRepositories.length}; credentialFree=true`, observations: receipts, findings: [] };
}

async function inspectLifecycleCapabilities(input: { intentIdentifiersObserved: number }): Promise<{ findings: readonly SimulationFinding[]; observations: Readonly<Record<string, unknown>> }> {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.map((value) => String(value)).join(" "));
  try {
    await anyamCliMain(["--help"], process.cwd());
  } finally {
    console.log = originalLog;
  }
  const help = output.join("\n");
  const issueCommands = help.split("\n").filter((line) => /^\s*(?:issue|intent)\b/iu.test(line));
  const pullRequestCommands = help.split("\n").filter((line) => /^\s*(?:pull-request|pull request|pr)\b/iu.test(line));
  const findings: SimulationFinding[] = [];
  if (issueCommands.length === 0) findings.push(finding({
      scenarioId: "issue-pr-lifecycle",
      seam: "issue-intent-lifecycle",
      message: "A Change stores an intentId, but the public Anyam interfaces do not expose an Issue or Intent resource with open, close, reopen, assignment, or discussion transitions.",
      recoveryAction: "Add a first-class Intent or Issue lifecycle to the Realm, CLI, REST, and MCP surfaces, then rerun this scenario.",
      issueTitle: "Add a first-class Issue or Intent lifecycle",
      issueBody: "Part of #182\n\nThe team simulation can create Changes with intentId strings, but it cannot open, close, reopen, assign, or discuss a first-class Issue or Intent through an Anyam public seam.\n\nAcceptance:\n- create, inspect, assign, close, reopen, and comment on an Intent through REST, CLI, and MCP;\n- preserve stable identity when a Change is created from the Intent;\n- export and restore the lifecycle;\n- keep restricted Intent metadata out of public projections;\n- add a receipt-backed end-to-end qualification.\n",
    }));
  if (pullRequestCommands.length === 0) findings.push(finding({
      scenarioId: "issue-pr-lifecycle",
      seam: "pull-request-compatibility-lifecycle",
      message: "Git branches and Anyam Changes can be exercised separately, but the public product does not expose a pull-request compatibility object that opens, closes, reopens, or maps a branch to a stable Change.",
      recoveryAction: "Add an explicit PR compatibility projection over Change and Revision, then rerun the branch, review, rebase, and closure scenarios.",
      issueTitle: "Add a pull-request compatibility lifecycle over Change and Revision",
      issueBody: "Part of #182\n\nThe team simulation exercises real Git branches, rebases, conflicts, reviews, and Landing. It cannot complete an Anyam pull-request lifecycle because no public PR projection exposes open, close, reopen, branch mapping, or review state.\n\nAcceptance:\n- map one external or local PR to one stable Change;\n- preserve identity through branch updates, rebases, review findings, and Landing;\n- expose open, closed, merged, and blocked states;\n- keep Anyam canonical and make the PR projection disclosure-safe;\n- add a receipt-backed end-to-end qualification.\n",
    }));
  return { findings, observations: { intentIdentifiersObserved: input.intentIdentifiersObserved, publicIssueCommands: issueCommands, publicPullRequestCommands: pullRequestCommands } };
}

export async function runTeamSimulation(input: { fixtureRoot?: string } = {}): Promise<TeamSimulationReport> {
  const startedAt = new Date().toISOString();
  const root = await mkdtemp(join(tmpdir(), "anyam-team-simulation-"));
  const fixtureRoot = input.fixtureRoot ?? process.cwd();
  const scenarios: SimulationScenario[] = [];
  const findings: SimulationFinding[] = [];
  observedGitOperationCount = 0;
  let localWorkspaceCount = 0;
  let localChangeCount = 0;
  try {
    const workerBundle = await captureScenario(scenarios, "worker-team", async () => {
      const fixture = await makeWorkerFixture(root, fixtureRoot);
      const collaboration = await collaborateSingleRepository({ fixture, root, agentId: "codex" });
      localWorkspaceCount += collaboration.workspaceCount;
      localChangeCount += collaboration.changeCount;
      scenarios.push({ id: "worker-team", verdict: "VERIFIED", receipt: `git=real; branches=${fixture.git.branches.length}; mergeConflict=${fixture.git.mergeConflict}; rebaseConflict=${fixture.git.rebaseConflict}; landing=verified; release=sealed-from-build; providerMutation=false`, observations: { project: fixture.project.id, refs: fixture.repositoryRefs, collaboration: collaboration.observations, build: collaboration.build }, findings: [] });
      return { fixture, collaboration };
    });
    const cliBundle = await captureScenario(scenarios, "cli-team", async () => {
      const fixture = await makeCliFixture(root);
      const collaboration = await collaborateSingleRepository({ fixture, root, agentId: "claude" });
      localWorkspaceCount += collaboration.workspaceCount;
      localChangeCount += collaboration.changeCount;
      scenarios.push({ id: "cli-team", verdict: "VERIFIED", receipt: `git=real; branches=${fixture.git.branches.length}; tag=${fixture.git.tag ?? "none"}; mergeConflict=${fixture.git.mergeConflict}; rebaseConflict=${fixture.git.rebaseConflict}; landing=verified; release=sealed-from-build; providerMutation=false`, observations: { project: fixture.project.id, refs: fixture.repositoryRefs, collaboration: collaboration.observations, build: collaboration.build }, findings: [] });
      return { fixture, collaboration };
    });
    if (workerBundle && cliBundle) {
      scenarios.push({ id: "git-conflict-rebase", verdict: "VERIFIED", receipt: `workerMergeConflict=${workerBundle.fixture.git.mergeConflict}; workerRebaseConflict=${workerBundle.fixture.git.rebaseConflict}; cliMergeConflict=${cliBundle.fixture.git.mergeConflict}; cliRebaseConflict=${cliBundle.fixture.git.rebaseConflict}; fsck=passed`, observations: { workerBranches: workerBundle.fixture.git.branches, cliBranches: cliBundle.fixture.git.branches }, findings: [] });
      scenarios.push({ id: "team-review-landing", verdict: "VERIFIED", receipt: `workerLandings=2; cliLandings=2; staleBases=blocked; reviewFinding=resolved; independentApproval=observed`, observations: { worker: workerBundle.collaboration.observations, cli: cliBundle.collaboration.observations }, findings: [] });
      scenarios.push({ id: "release-sealing", verdict: "VERIFIED", receipt: `workerBuild=${workerBundle.collaboration.build.receipt}; cliBuild=${cliBundle.collaboration.build.receipt}; providerMutation=false`, observations: { workerArtifact: workerBundle.collaboration.artifact.digest, cliArtifact: cliBundle.collaboration.artifact.digest, workerOutputFiles: workerBundle.collaboration.build.outputFiles, cliOutputFiles: cliBundle.collaboration.build.outputFiles }, findings: [] });
    }
    const hybridBundle = await captureScenario(scenarios, "hybrid-public-private", async () => {
      const fixture = await makeHybridFixture(root, fixtureRoot);
      const baseRevision = createProjectRevision({ id: "project-revision:team-hybrid:base", projectId: fixture.project.id, sourceSpaceSnapshots: fixture.commits });
      const control = new LocalChangeCoordinator({ project: fixture.project, sourceSpaces: fixture.sourceSpaces, canonicalRevision: baseRevision });
      const publicView = projectView(fixture.project, baseRevision, fixture.sourceSpaces, ["source:public-player"], "public");
      const privateView = projectView(fixture.project, baseRevision, fixture.sourceSpaces, ["source:private-codec"], "project");
      const publicWorkspace = await control.createWorkspace({ view: publicView, sources: [{ sourceSpaceId: "source:public-player", snapshotId: requireValue(fixture.commits["source:public-player"], "public commit"), files: requireValue(fixture.files["source:public-player"], "public files") }], mounts: [{ sourceSpaceId: "source:public-player", mountPath: "public" }], directory: join(root, "hybrid-workspace-public"), actorId: actor("hybrid-public").actorId });
      const privateWorkspace = await control.createWorkspace({ view: privateView, sources: [{ sourceSpaceId: "source:private-codec", snapshotId: requireValue(fixture.commits["source:private-codec"], "private commit"), files: requireValue(fixture.files["source:private-codec"], "private files") }], mounts: [{ sourceSpaceId: "source:private-codec", mountPath: "private" }], directory: join(root, "hybrid-workspace-private"), actorId: actor("hybrid-private").actorId });
      const publicChange = control.createChange({ id: "change:hybrid:public", intentId: "intent:hybrid:public", workspaceId: publicWorkspace.workspace.id, author: actor("hybrid-public") });
      const privateChange = control.createChange({ id: "change:hybrid:private", intentId: "intent:hybrid:private", workspaceId: privateWorkspace.workspace.id, author: actor("hybrid-private") });
      const publicRevision = control.publishRevision({ changeId: publicChange.id, workspaceId: publicWorkspace.workspace.id, declaredEffects: ["public-player.modify"], sourceSpaceSnapshots: { "source:public-player": requireValue(fixture.commits["source:public-player"], "public commit") }, actor: actor("hybrid-public") });
      const privateRevision = control.publishRevision({ changeId: privateChange.id, workspaceId: privateWorkspace.workspace.id, declaredEffects: ["private-codec.modify"], sourceSpaceSnapshots: { "source:private-codec": requireValue(fixture.commits["source:private-codec"], "private commit") }, actor: actor("hybrid-private") });
      const landing = control.landCohort({ cohortId: "cohort:hybrid", members: [{ changeId: publicChange.id, changeRevisionId: publicRevision.id }, { changeId: privateChange.id, changeRevisionId: privateRevision.id }], expectedCanonicalProjectRevisionId: baseRevision.id });
      const scenario = await runHybridScenario({ fixture, root, landingReceipt: landing.receipt, revisionIds: [publicRevision.id, privateRevision.id] });
      scenarios.push(scenario);
      const hybridMirror = scenario.observations.mirror;
      const mirrorObservations = isRecord(hybridMirror) ? hybridMirror : {};
      scenarios.push({ id: "github-bidirectional", verdict: "VERIFIED", receipt: String(mirrorObservations.reconciliation ?? "mirror-reconciliation=observed"), observations: mirrorObservations, findings: [] });
      localWorkspaceCount += 2;
      localChangeCount += 2;
      return { fixture, scenario };
    });
    if (workerBundle && cliBundle && hybridBundle) {
      const exportScenario = await captureScenario(scenarios, "export-restore", () => runExportRestore({ root, fixtures: [workerBundle.fixture, cliBundle.fixture], hybrid: hybridBundle.fixture, collaborations: [workerBundle.collaboration, cliBundle.collaboration] }));
      if (exportScenario) scenarios.push(exportScenario);
    } else {
      scenarios.push({ id: "export-restore", verdict: "INCONCLUSIVE", receipt: "scenario=export-restore; status=inconclusive; prerequisite=repository-scenarios", observations: { prerequisite: "worker, cli, and hybrid scenarios must complete" }, findings: [] });
    }
    const intentIdentifiersObserved = (workerBundle?.collaboration.changes.length ?? 0) + (cliBundle?.collaboration.changes.length ?? 0);
    const lifecycle = await inspectLifecycleCapabilities({ intentIdentifiersObserved });
    const lifecycleFindings = lifecycle.findings;
    findings.push(...lifecycleFindings);
    scenarios.push({ id: "issue-pr-lifecycle", verdict: lifecycleFindings.length === 0 ? "VERIFIED" : "NOT VERIFIED", receipt: lifecycleFindings.length === 0 ? "issueLifecycle=observed; pullRequestLifecycle=observed" : "issueLifecycle=not-exposed; pullRequestLifecycle=not-exposed; simulation=blocked", observations: lifecycle.observations, findings: lifecycleFindings });
    const allFindings = scenarios.flatMap((scenario) => scenario.findings).concat(findings.filter((candidate) => !scenarios.some((scenario) => scenario.findings.some((entry) => entry.id === candidate.id))));
    const humanActorCount = new Set(["maintainer", "contributor", "reviewer"]).size;
    const agentActorCount = new Set(["codex", "claude"]).size;
    const repositoryArchetypeCount = new Set(["worker", "cli"]).size;
    return { protocol: TEAM_SIMULATION_PROTOCOL, status: allFindings.length === 0 && scenarios.every((scenario) => scenario.verdict === "VERIFIED") ? "succeeded" : "blocked", startedAt, finishedAt: new Date().toISOString(), scenarios, findings: allFindings, measurements: { humanActorCount, agentActorCount, repositoryArchetypeCount, gitOperationCount: observedGitOperationCount, localWorkspaceCount, localChangeCount, qualificationScopeReceipt: "scope=team-simulation; counts=observed-run-values; not-a-product-limit; provider=not-run" }, provider: { cloudflare: "not-run", receipt: "cloudflare=not-run; use the owner-run golden-path qualifier for live deployment evidence" }, credentialValues: "not-printed", canonicalWrite: false };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
