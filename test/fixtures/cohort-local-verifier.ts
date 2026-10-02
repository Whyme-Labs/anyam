import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createWorkspaceBoundary, measureLinuxWorkspaceResourceLimits, removeWorkspaceBoundary, runWorkspaceCommand, WORKSPACE_BOUNDARY_POLICY, type WorkspaceBoundary } from "../../packages/create-anyam/src/workspace-boundary.ts";
import { trustedGitArgs, trustedGitEnvironment } from "../../packages/create-anyam/src/trusted-git.ts";
import { AuthorityPlaneCoordinator, AUTHORITY_COMMAND_PROTOCOL, type AuthoritySession } from "../../src/cloudflare/authority-plane.ts";
import type { AuthoritySQLiteStore } from "../../src/cloudflare/authority-sqlite.ts";
import { normalizeProjectManifest, type NormalizedActionInput, type NormalizedActionOutput } from "../../src/execution/local.ts";
import { ExternalRunnerCoordinator, runnerResultContext, runnerResultMessage, type SignedRunnerCompletion, type RunnerResult } from "../../src/execution/runner.ts";
import type { Evidence } from "../../src/kernel/contracts.ts";
import { CanonicalRefReconciler } from "../../src/cloudflare/canonical-ref-reconciliation.ts";
import { SQLiteCohortLandingAuthority } from "../../src/cloudflare/cohort-landing.ts";
import { cohortStore } from "./cohort-sqlite.ts";
import { FencedGitProviderFixture } from "./fenced-git-provider.ts";
import { prepareCohort, projectId, session, type CohortVerification, type realGitSources } from "./reconciliation-project.ts";

// Reference-fixture wiring only: no hosted Runner adapter or enrollment route.
export function requireFixtureGitEnvironment(): void {
  // Presentation and prompt flags cannot select a repository or Git config.
  const harmless = new Set(["GIT_PAGER", "GIT_TERMINAL_PROMPT"]);
  const override = Object.keys(process.env).find((key) => key.startsWith("GIT_") && !harmless.has(key) && process.env[key] !== undefined);
  if (override) throw new Error(`offline qualification refuses inherited Git override ${override}; unset Git overrides for this command; fixtureGitMutation=false`);
}

export function fixtureGit(directory: string, ...args: string[]): string {
  requireFixtureGitEnvironment();
  return execFileSync("git", trustedGitArgs(args), { cwd: directory, env: trustedGitEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function digest(bytes: string | Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

export function verifierGitSources(root: string): ReturnType<typeof realGitSources> {
  requireFixtureGitEnvironment();
  const directories: Record<string, string> = {};
  const revisions: Record<string, string>[] = [{}, {}, {}];
  const bindings = ["a", "b"].map((space) => ({ sourceSpaceId: `source:${space}`, repositoryId: `repo:${space}`, ref: "refs/heads/canonical" }));
  for (const space of ["a", "b"]) {
    const directory = join(root, space);
    mkdirSync(join(directory, "src"), { recursive: true });
    fixtureGit(directory, "init", "--quiet");
    fixtureGit(directory, "config", "core.hooksPath", "/dev/null");
    writeFileSync(join(directory, ".gitignore"), "dist/\n.home/\n.tmp/\n.anyam/\n");
    writeFileSync(join(directory, "verify.mjs"), `import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { value } from './src/value.mjs';
assert.equal(value(2, 3), ${space === "a" ? 5 : 6});
assert.equal(value(-2, 3), ${space === "a" ? 1 : -6});
const result = { space: '${space}', assertions: 2, sourceDigest: 'sha256:' + createHash('sha256').update(readFileSync('src/value.mjs')).digest('hex') };
mkdirSync('dist', { recursive: true });
writeFileSync('dist/verification.json', JSON.stringify(result));
console.log(JSON.stringify(result));
`);
    for (const revision of [0, 1, 2]) {
      const expression = revision === 0 ? "left - right" : space === "a" ? revision === 1 ? "left + right" : "Number(left) + Number(right)" : revision === 1 ? "left * right" : "Number(left) * Number(right)";
      writeFileSync(join(directory, "src/value.mjs"), `export function value(left, right) { return ${expression}; }\n`);
      fixtureGit(directory, "add", ".");
      fixtureGit(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", `Verifier ${space} candidate ${revision}`);
      revisions[revision]![`source:${space}`] = fixtureGit(directory, "rev-parse", "HEAD");
    }
    fixtureGit(directory, "update-ref", "refs/heads/canonical", revisions[0]![`source:${space}`]!);
    directories[`repo:${space}`] = directory;
  }
  return { directories, revisions, bindings };
}

export type LocalVerificationObservation = {
  candidateOid: string;
  materializedCommit: string;
  input: NormalizedActionInput;
  command: { status: string; exitCode: number | undefined; stdout: string; stdoutDigest: string; stderrDigest: string; receipt: string };
  boundary: { enforcement: string; networkEnforcement: string; receipt: string };
  completion: SignedRunnerCompletion;
  evidence: Evidence;
  outputReadBack: { path: string; digest: string; bytes: number }[];
};

export async function executeLocalVerification(input: {
  store: AuthoritySQLiteStore;
  source: ReturnType<typeof realGitSources>;
  root: string;
  selection: Parameters<CohortVerification>[0];
  beforeExecution?: (boundary: WorkspaceBoundary) => void;
  beforeConsumption?: (completion: SignedRunnerCompletion) => void;
}): Promise<LocalVerificationObservation> {
  requireFixtureGitEnvironment();
  const { store, selection } = input;
  const sourceSpaceId = `source:${selection.space}`;
  const directory = input.source.directories[`repo:${selection.space}`]!;
  const selected = store.load(session.realmId)!.changeRevisions[selection.changeRevisionId]!;
  assert.equal(selected.sourceSpaceSnapshots?.[sourceSpaceId], selection.candidateOid);
  fixtureGit(directory, "checkout", "--detach", selection.candidateOid);
  const resourceLimits = process.platform === "linux" ? await measureLinuxWorkspaceResourceLimits(directory) : undefined;
  const boundary = await createWorkspaceBoundary({ sourceDirectory: directory, stateDirectory: input.root, projectId, changeId: selected.changeId, workspaceId: selection.workspaceId, mode: "enforceable", network: [], executablePaths: [process.execPath], ...(resourceLimits ? { resourceLimits } : {}) });
  try {
    assert.equal(boundary.networkEnforcement, "deny-all");
    const materializedCommit = fixtureGit(boundary.workspaceDirectory, "rev-parse", "HEAD");
    assert.equal(materializedCommit, selection.candidateOid);
    const fileDigests = () => ["src/value.mjs", "verify.mjs"].map((path) => `${path}=${digest(readFileSync(join(boundary.workspaceDirectory, path)))}`);
    const manifest = normalizeProjectManifest({ schema: "anyam.project/v1", id: projectId, name: "Local verifier reference", referenceType: "typescript-cli", sourceSpaceIds: [sourceSpaceId], source: { root: ".", provenance: "isolated-local-reference" }, modules: [{ id: "module:verification", root: ".", dependencies: [], actions: [{ id: `action:compatibility:${selection.space}`, command: "node verify.mjs", inputs: ["src/value.mjs", "verify.mjs"], outputs: ["dist/verification.json"], network: [], resources: {} }], artifactTypes: ["verification.report"] }], verifiers: [{ id: `verifier:compatibility:${selection.space}`, actionId: `action:compatibility:${selection.space}`, disclosure: "full", requiredFor: ["landing"] }], targets: [] });
    const runnerInput: NormalizedActionInput = {
      action: manifest.actions[0]!, verifier: manifest.verifiers[0]!,
      projectRevisionId: selection.projectRevisionId, projectViewId: selection.projectViewId,
      changeRevisionId: selection.changeRevisionId, workspaceId: selection.workspaceId,
      sourceSpaceSnapshots: { [sourceSpaceId]: selection.candidateOid }, inputDigests: fileDigests(), effectDigests: selected.declaredEffects.map((effect) => digest(effect)),
      dependencyDigest: digest("node-builtins-only"), toolchainDigest: digest(JSON.stringify({ node: process.version, binary: digest(readFileSync(process.execPath)), platform: process.platform, arch: process.arch })),
      environmentDigest: digest(JSON.stringify({ enforcement: boundary.enforcement, network: boundary.networkEnforcement, ambientCredentials: "blocked" })),
      policyVersion: "policy:fixture", authorizationEpoch: String(session.authorizationEpoch), capabilityGrantId: "grant:offline-fixture",
      disclosure: { projectionId: selection.projectViewId, classification: "project" }, actor: { principalId: session.principalId, actorId: session.actorId, sessionId: session.sessionId, clientId: session.clientId }, runnerId: "runner:unassigned",
    };
    const keys = generateKeyPairSync("ed25519"); // ephemeral fixture identity; never serialized
    const signMessage = (message: string) => sign(null, Buffer.from(message), keys.privateKey).toString("base64url");
    const runner = new ExternalRunnerCoordinator({ realmId: session.realmId, projectId });
    const profile = runner.enrollRunner({ id: `runner:local:${selection.changeRevisionId}`, provider: "offline-workspace-reference", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), platform: { operatingSystem: process.platform, architecture: process.arch, isolation: boundary.enforcement }, capabilities: ["toolchain:node"], networkDestinations: [], networkEnforcement: "deny-all", networkBoundaryReceipt: boundary.receipt, secretUse: "none", canUploadArtifacts: true, canUploadEvidence: true, approvedBy: runnerInput.actor, enrollmentReceipt: "scope=ephemeral-offline-fixture; hostedEnrollment=false" });
    runner.activateRunner(profile.id, runnerInput.actor);
    const runnerSession: AuthoritySession = { ...session, principalId: "principal:fixture-runner", actorId: "actor:fixture-runner", clientId: "anyam-runner-coordinator", kind: "runner" };
    let previous = store.load(session.realmId)!;
    let authority = new AuthorityPlaneCoordinator(previous);
    authority.registerRunnerProfile(runner.getRunner(profile.id)!, runnerSession);
    store.commit(previous, authority.snapshot());
    previous = store.load(session.realmId)!;
    authority = new AuthorityPlaneCoordinator(previous);
    const runRequest = authority.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "run.request", idempotencyKey: `request:${selection.changeRevisionId}`, payload: { projectId, ...runnerInput, actionId: runnerInput.action.id, verifierId: runnerInput.verifier!.id, actionContractDigest: runnerInput.action.contractDigest, verifierContractDigest: runnerInput.verifier!.contractDigest } }, session);
    store.commit(previous, authority.snapshot());
    const runId = (runRequest.value.run as { id: string }).id;
    const queued = runner.enqueue({ runId, idempotencyKey: `job:${selection.changeRevisionId}`, actionInput: runnerInput, runnerRequirements: ["toolchain:node"], outputLocations: { logs: `runs/${runId}/logs`, artifacts: `runs/${runId}/artifacts`, evidence: `runs/${runId}/evidence` }, leaseExpiresAt: new Date(Date.now() + WORKSPACE_BOUNDARY_POLICY.commandTimeoutMs).toISOString() });
    const offer = runner.pull(profile.id)!;
    const lease = runner.claim({ runnerId: profile.id, jobId: queued.job.id, attemptId: offer.attempt.id, challenge: offer.challenge, signature: signMessage(`anyam.runner-claim/v1|${offer.challenge}`) });
    input.beforeExecution?.(boundary);
    assert.deepEqual(fileDigests(), runnerInput.inputDigests, "materialized input drift before execution");
    const command = await runWorkspaceCommand({ boundary, command: process.execPath, args: ["verify.mjs"], protectGitMetadata: true });
    assert.equal(fixtureGit(boundary.workspaceDirectory, "rev-parse", "HEAD"), materializedCommit, "materialized commit changed during verification");
    assert.deepEqual(fileDigests(), runnerInput.inputDigests, "materialized input drift during execution");
    const outputBytes = command.status === "passed" ? readFileSync(join(boundary.workspaceDirectory, "dist/verification.json")) : undefined;
    const outputReadBack = outputBytes ? [{ path: "dist/verification.json", digest: digest(outputBytes), bytes: outputBytes.byteLength }] : [];
    const outputDigests = outputReadBack.map((output) => `${output.path}=${output.digest}`);
    const output: NormalizedActionOutput = { status: command.status === "passed" ? "succeeded" : "failed", exitCode: command.exitCode, inputDigests: [...runnerInput.inputDigests], outputDigests, outputDigest: digest(JSON.stringify({ outputDigests, stdoutDigest: command.stdoutDigest, stderrDigest: command.stderrDigest, exitCode: command.exitCode })), stdoutDigest: command.stdoutDigest, stderrDigest: command.stderrDigest };
    const resultWithoutSignature = { context: runnerResultContext(lease), status: output.status, output, outputs: outputReadBack.map((readBack) => ({ kind: "artifact" as const, location: `${lease.job.outputLocations.artifacts}/${lease.attempt.id}/${readBack.path}`, digest: readBack.digest, disclosure: runnerInput.disclosure, receipt: `readBack=actual-local-bytes; bytes=${readBack.bytes}; path=${readBack.path}` })) };
    const result: RunnerResult = { ...resultWithoutSignature, signature: signMessage(runnerResultMessage(resultWithoutSignature)) };
    const completion = runner.submit({ credential: lease.credential, result });
    input.beforeConsumption?.(completion);
    previous = store.load(session.realmId)!;
    authority = new AuthorityPlaneCoordinator(previous);
    const accepted = await authority.completeRunner({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "runner.complete", idempotencyKey: `complete:${selection.changeRevisionId}`, payload: { completion } }, runnerSession);
    store.commit(previous, authority.snapshot());
    return { candidateOid: selection.candidateOid, materializedCommit, input: runnerInput, command: { status: command.status, exitCode: command.exitCode, stdout: command.stdout, stdoutDigest: command.stdoutDigest, stderrDigest: command.stderrDigest, receipt: command.receipt }, boundary: { enforcement: boundary.enforcement, networkEnforcement: boundary.networkEnforcement, receipt: boundary.receipt }, completion, evidence: accepted.value.evidence as Evidence, outputReadBack };
  } finally { await removeWorkspaceBoundary(boundary); }
}

export async function runLocalVerifierCohortQualification(implementation: { revision: string; tree: string }) {
  requireFixtureGitEnvironment();
  const root = await mkdtemp(join(tmpdir(), "anyam-cohort-local-verifier-"));
  const path = join(root, "authority.sqlite");
  let database = new DatabaseSync(path);
  try {
    let store = cohortStore(database);
    const source = verifierGitSources(root);
    const executions: LocalVerificationObservation[] = [];
    const verify: CohortVerification = async (selection) => {
      const execution = await executeLocalVerification({ store, source, root, selection });
      executions.push(execution);
      return execution.evidence;
    };
    const first = await prepareCohort(store, "first", source, source.revisions[1]!, verify);
    const firstLanding = await new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: first.evaluate }).landCohort(first.request);
    const original = structuredClone(store.load(session.realmId)!.idempotency["landing.cohort:cohort:first"]);
    const second = await prepareCohort(store, "second", source, source.revisions[2]!, verify);
    const providerRoot = join(root, "provider-state");
    const interrupted = new FencedGitProviderFixture(providerRoot, source.directories, (operation) => { if (operation === "repair") throw new Error("lost offline provider reply"); });
    const pending = new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider: interrupted });
    await assert.rejects(pending.reconcile(), /lost offline provider reply/);
    await assert.rejects(Promise.resolve().then(() => new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: second.evaluate, reconciliation: pending }).landCohort(second.request)), /reconciliation is incomplete/);
    const partial = structuredClone(store.load(session.realmId)!.canonicalRefProjections[projectId]);
    database.close();
    database = new DatabaseSync(path);
    store = cohortStore(database);
    const reconciler = new CanonicalRefReconciler({ store, session, projectId, bindings: source.bindings, provider: new FencedGitProviderFixture(providerRoot, source.directories) });
    const firstCompletion = await reconciler.reconcile();
    const secondLanding = await new SQLiteCohortLandingAuthority({ store, session, projectId, evaluate: second.evaluate, reconciliation: reconciler }).landCohort(second.request);
    const secondCompletion = await reconciler.reconcile();
    const snapshot = store.load(session.realmId)!;
    assert.deepEqual(snapshot.idempotency["landing.cohort:cohort:first"], original);
    return { protocol: "anyam.cohort-local-verifier-qualification/v1", status: "succeeded", implementation, capturedAt: new Date().toISOString(), qualificationScope: "offline-reference-verification-and-client-reconciliation", verifierExecution: "actual-enforceable-local-process", evidenceConsumption: "signed-runner-completion", syntheticRecordedEvidence: false, governance: "fixture-policy-and-reviewer-identities", nativeHarnessCalls: false, liveProviderCalls: false, liveArtifacts: false, productionProviderFencing: "unqualified", distributedGitAtomicity: false, sourceCommits: source.revisions, executions, firstLanding, partial, firstCompletion, secondLanding, secondCompletion, reviewPackets: [snapshot.idempotency["landing.cohort:cohort:first"]!.result.value.reviewPacket, snapshot.idempotency["landing.cohort:cohort:second"]!.result.value.reviewPacket], originalLandingResultUnchanged: true, cleanup: "destroyed" };
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
}
