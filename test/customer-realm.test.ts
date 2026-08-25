import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_VERSIONS,
  createProject,
  createProjectRevision,
  type Project,
  type ProjectExport,
  type SourceSpace,
} from "../src/kernel/contracts.ts";
import {
  CustomerRealmInstallation,
  InMemoryCustomerRealmCloudflareAdapter,
  InMemoryCustomerRealmInstallationStore,
  verifyCustomerRealmRecoveryBundle,
  type CustomerRealmCloudflareAdapter,
  type CustomerRealmImport,
  type CustomerRealmImportReceipt,
  type CustomerRealmProjectImporter,
  type CustomerRealmProviderFailure,
  type CustomerRealmProviderResult,
} from "../src/installation/customer-realm.ts";
import { projectExportDigest, verifyProjectExportManifest } from "../src/portability/project-export.ts";

const sourceSpace: SourceSpace = {
  protocol: CONTRACT_VERSIONS.sourceSpace,
  id: "source:video-player-public",
  name: "video-player-public",
  classification: "public",
};

const project: Project = createProject({
  id: "project:video-player",
  name: "Video Player",
  referenceType: "typescript-library",
  sourceSpaceIds: [sourceSpace.id],
});

function projectExport(): ProjectExport {
  const revision = createProjectRevision({
    id: "project-revision:video-player-1",
    projectId: project.id,
    sourceSpaceSnapshots: { [sourceSpace.id]: "commit:video-player-1" },
  });
  const repository = {
    protocol: "anyam.repository-export/v1" as const,
    repositoryId: "repository:video-player-public",
    sourceSpaceId: sourceSpace.id,
    objectFormat: "sha1" as const,
    defaultBranch: "main",
    refs: [{ name: "refs/heads/main", oid: "commit:video-player-1" }],
    bundle: { relativePath: "repository.bundle", digest: "sha256:bundle", bytes: 1 },
    lfs: { state: "empty" as const, objects: [] },
  };
  const withoutIntegrity: ProjectExport = {
    protocol: CONTRACT_VERSIONS.export,
    version: "v1",
    exportId: "export:video-player-1",
    createdAt: "2026-08-03T00:00:00.000Z",
    project,
    sourceSpaces: [sourceSpace],
    repositories: [repository],
    largeObjects: [],
    lineage: [{ projectRevisionId: revision.id, sourceSpaceSnapshots: revision.sourceSpaceSnapshots }],
    projectRevisions: [revision],
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
    auditEventIds: ["event:project-exported"],
    recoveryCheckpointIds: ["checkpoint:project-export"],
    recovery: { checkpointId: "checkpoint:project-export", state: "verified", resumeAction: "restore from customer-owned export", receipt: "project=video-player; verified=true" },
    integrity: { manifestDigest: "", repositoryDigests: [repository.bundle.digest], credentialFree: true, receipt: "credentialFields=none" },
  };
  return { ...withoutIntegrity, integrity: { ...withoutIntegrity.integrity, manifestDigest: projectExportDigest(withoutIntegrity) } };
}

function importReceipt(exportDigest: string): CustomerRealmImportReceipt {
  return {
    projectRevisionId: "project-revision:video-player-1",
    sourceSpaceIds: [sourceSpace.id],
    exportDigest,
    checkpointId: "checkpoint:project-import",
    state: "verified",
    partialEffects: [],
    receipt: "project=video-player; revision=project-revision:video-player-1; sourceSpaces=1; verified=true",
  };
}

class ScriptedImporter implements CustomerRealmProjectImporter {
  readonly starts: string[] = [];
  readonly resumes: string[] = [];
  private failed = true;

  constructor(private readonly receipt: CustomerRealmImportReceipt, private readonly firstFailure?: CustomerRealmProviderFailure) {}

  async startImport(input: { installationId: string; project: { projectId: string }; provider: CustomerRealmImport["provider"]; source: string; operationId: string; idempotencyKey: string }): Promise<CustomerRealmProviderResult<CustomerRealmImportReceipt>> {
    this.starts.push(`${input.operationId}:${input.idempotencyKey}`);
    if (this.failed && this.firstFailure) {
      this.failed = false;
      return { ...this.firstFailure, operationId: input.operationId };
    }
    return { status: "succeeded", operationId: input.operationId, value: this.receipt, receipt: this.receipt.receipt };
  }

  async resumeImport(input: { installationId: string; project: { projectId: string }; import: CustomerRealmImport }): Promise<CustomerRealmProviderResult<CustomerRealmImportReceipt>> {
    this.resumes.push(`${input.import.operationId}:${input.import.idempotencyKey}`);
    return { status: "succeeded", operationId: input.import.operationId, value: this.receipt, receipt: `${this.receipt.receipt}; resumed=true` };
  }
}

class FailOnceProvisionAdapter implements CustomerRealmCloudflareAdapter {
  private failed = true;

  constructor(private readonly delegate: InMemoryCustomerRealmCloudflareAdapter, private readonly failureKind: CustomerRealmProviderFailure["failureKind"] = "provider-outage") {}

  inspectAccount(input: Parameters<CustomerRealmCloudflareAdapter["inspectAccount"]>[0]): ReturnType<CustomerRealmCloudflareAdapter["inspectAccount"]> {
    return this.delegate.inspectAccount(input);
  }

  async provisionRealm(input: Parameters<CustomerRealmCloudflareAdapter["provisionRealm"]>[0]): ReturnType<CustomerRealmCloudflareAdapter["provisionRealm"]> {
    if (this.failed) {
      this.failed = false;
      return {
        status: "failed",
        errorCode: `test.${this.failureKind}`,
        message: "Injected provider failure for recovery qualification.",
        retryable: true,
        failureKind: this.failureKind,
        affectedObject: input.installationId,
        operationId: input.operationId,
        partialEffects: [],
        recoveryAction: "retry the same provisioning operation after inspecting the customer account",
        receipt: `failureKind=${this.failureKind}; operation=${input.operationId}`,
      };
    }
    return this.delegate.provisionRealm(input);
  }

  inspectProvision(input: Parameters<CustomerRealmCloudflareAdapter["inspectProvision"]>[0]): ReturnType<CustomerRealmCloudflareAdapter["inspectProvision"]> {
    return this.delegate.inspectProvision(input);
  }
}

async function createInstallation(input: {
  installationId: string;
  cloudflare?: CustomerRealmCloudflareAdapter;
  importer: CustomerRealmProjectImporter;
  store?: InMemoryCustomerRealmInstallationStore;
}) {
  const installation = new CustomerRealmInstallation({
    installationId: input.installationId,
    cloudflare: input.cloudflare ?? new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]),
    importer: input.importer,
    ...(input.store ? { store: input.store } : {}),
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  });
  await installation.install({ accountId: "account:customer", requestedResourceTypes: ["d1", "r2"], ownerConfirmed: true, operationId: `operation:${input.installationId}`, idempotencyKey: `idempotency:${input.installationId}` });
  await installation.enrollOwner({ displayName: "Realm Owner", passkeyCredentialId: `passkey:${input.installationId}`, passkeyVerified: true, recovery: { method: "external-recovery-codes", enrollmentReceipt: `recovery-receipt:${input.installationId}`, materialDigest: "sha256:external-only" }, principalId: `principal:${input.installationId}` });
  await installation.createProject({ project, sourceSpaces: [sourceSpace] });
  return installation;
}

test("customer-operated bootstrap proves ownership, stores no credentials, and creates no default administrator", async () => {
  const store = new InMemoryCustomerRealmInstallationStore();
  const importer = new ScriptedImporter(importReceipt("sha256:unused"));
  const installation = new CustomerRealmInstallation({ installationId: "installation:bootstrap", cloudflare: new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]), importer, store, now: () => new Date("2026-08-03T00:00:00.000Z") });

  await assert.rejects(
    installation.install({ accountId: "account:customer", requestedResourceTypes: ["d1"], ownerConfirmed: false }),
    (error: unknown) => error instanceof Error && error.name === "CustomerRealmInstallationError" && error.message.includes("explicit confirmation"),
  );
  assert.equal(installation.snapshot.phase, "new");

  const state = await installation.install({ accountId: "account:customer", requestedResourceTypes: ["d1", "r2"], ownerConfirmed: true, operationId: "operation:bootstrap", idempotencyKey: "idempotency:bootstrap" });
  assert.equal(state.phase, "realm-ready");
  assert.equal(state.owner, undefined);
  assert.equal(state.account?.owner, "customer");
  assert.equal(state.account?.credentialsStored, false);
  assert.equal(state.resources?.owner, "customer");
  assert.equal(state.resources?.state, "verified");
  assert.equal(state.pendingCommands.every((command) => command.status === "succeeded"), true);
  assert.equal(JSON.stringify(state).includes("password"), false);

  const reopened = await CustomerRealmInstallation.open({ installationId: "installation:bootstrap", cloudflare: new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]), importer, store, now: () => new Date("2026-08-03T00:00:00.000Z") });
  assert.equal(reopened.snapshot.phase, "realm-ready");
  assert.equal(reopened.snapshot.account?.credentialsStored, false);
});

test("provider failures become visible checkpoints and resume with the same import identity", async () => {
  const exportManifest = projectExport();
  const failure: CustomerRealmProviderFailure = {
    status: "failed",
    errorCode: "import.queue_duplicate",
    message: "Queue delivered the import command twice.",
    retryable: true,
    failureKind: "queue-duplicate",
    affectedObject: project.id,
    operationId: "operation:import",
    partialEffects: ["quarantine:source:video-player-public"],
    recoveryAction: "deduplicate the command and resume from the recorded checkpoint",
    receipt: "queue=import; delivery=2; idempotency=stable",
  };
  const importer = new ScriptedImporter(importReceipt(projectExportDigest(exportManifest)), failure);
  const installation = await createInstallation({ installationId: "installation:import", importer });
  await installation.importProject({ provider: "generic-git", source: "https://git.example/video-player.git", operationId: "operation:import", idempotencyKey: "idempotency:import" });
  assert.equal(installation.snapshot.phase, "degraded");
  assert.equal(installation.snapshot.degraded?.kind, "queue-duplicate");
  assert.ok(installation.snapshot.degraded?.checkpointId);
  assert.deepEqual(installation.snapshot.degraded?.partialEffects, ["quarantine:source:video-player-public"]);
  assert.equal(installation.snapshot.pendingCommands.find((command) => command.operation === "project.import")?.status, "degraded");

  const recovered = await installation.recover();
  assert.equal(recovered.phase, "imported");
  assert.equal(recovered.project?.projectRevisionId, "project-revision:video-player-1");
  assert.equal(importer.starts[0], "operation:import:idempotency:import");
  assert.equal(importer.resumes[0], "operation:import:idempotency:import");
  assert.equal(recovered.pendingCommands.find((command) => command.operation === "project.import")?.status, "succeeded");
});

test("import outage, workflow stall, partial mutation, and non-retryable failure remain explicit", async () => {
  const cases: readonly { kind: CustomerRealmProviderFailure["failureKind"]; retryable: boolean }[] = [
    { kind: "provider-outage", retryable: true },
    { kind: "workflow-stall", retryable: true },
    { kind: "partial-mutation", retryable: true },
    { kind: "import-failure", retryable: false },
  ];
  for (const [index, failureCase] of cases.entries()) {
    const failure: CustomerRealmProviderFailure = {
      status: "failed",
      errorCode: `import.${failureCase.kind}`,
      message: `Injected ${failureCase.kind}.`,
      retryable: failureCase.retryable,
      failureKind: failureCase.kind,
      affectedObject: project.id,
      operationId: `operation:failure:${index}`,
      partialEffects: failureCase.kind === "partial-mutation" ? ["quarantine:source:video-player-public"] : [],
      recoveryAction: failureCase.retryable ? "resume the same Import Operation from its Recovery Checkpoint" : "restore a verified Project Export or correct the provider receipt before retrying",
      receipt: `failureKind=${failureCase.kind}; retryable=${failureCase.retryable}`,
    };
    const installation = await createInstallation({ installationId: `installation:failure:${index}`, importer: new ScriptedImporter(importReceipt("sha256:unused"), failure) });
    const state = await installation.importProject({ provider: "generic-git", source: `https://git.example/video-player-${index}.git`, operationId: `operation:failure:${index}`, idempotencyKey: `idempotency:failure:${index}` });
    assert.equal(state.phase, failureCase.retryable ? "degraded" : "blocked");
    assert.equal(state.degraded?.kind, failureCase.kind);
    assert.equal(state.degraded?.retryable, failureCase.retryable);
    assert.match(state.degraded?.safeRecoveryAction ?? "", /Import Operation|Project Export/);
    if (failureCase.kind === "partial-mutation") assert.deepEqual(state.degraded?.partialEffects, ["quarantine:source:video-player-public"]);
    if (!failureCase.retryable) await assert.rejects(installation.recover(), (error: unknown) => error instanceof Error && error.name === "CustomerRealmInstallationError" && error.message.includes("Automatic recovery is blocked"));
  }
});

test("customer-owned recovery exports lineage without credentials and requires owner activation", async () => {
  const exportManifest = projectExport();
  assert.equal(verifyProjectExportManifest(exportManifest).status, "succeeded");
  const importer = new ScriptedImporter(importReceipt(projectExportDigest(exportManifest)));
  const cloudflare = new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]);
  const installation = await createInstallation({ installationId: "installation:recovery", cloudflare, importer });
  await installation.importProject({ provider: "project-export", source: "customer://project-export", operationId: "operation:recovery-import", idempotencyKey: "idempotency:recovery-import" });

  const policy = installation.realmPolicy!;
  const session = policy.authenticatePasskey({ credentialId: "passkey:installation:recovery", challenge: "challenge:recovery", verified: true });
  const task = policy.createTask({ principalId: session.principalId, actorId: session.actorId, sessionId: session.id, purpose: "recovery test", workspaceId: "workspace:recovery", changeId: "change:recovery", modelProvider: "openai" });
  const grant = policy.createCapabilityGrant({ principalId: session.principalId, actorId: session.actorId, clientId: session.clientId, sessionId: session.id, taskId: task.id, resource: { realmId: policy.realm.id, projectId: project.id, sourceSpaceId: sourceSpace.id, workspaceId: "workspace:recovery", changeId: "change:recovery" }, sourceSpaceIds: [sourceSpace.id], actions: ["source.read", "workspace.write", "change.publish_revision"], effects: ["source.read"], allowedModelProviders: ["openai"], budget: { modelCostUsd: 1 } });
  assert.equal(grant.status, "active");

  const bundle = await installation.exportRecovery({ projectExport: exportManifest });
  assert.equal(bundle.integrity.credentialFree, true);
  assert.equal(JSON.stringify(bundle).includes("token"), false);
  assert.equal(verifyProjectExportManifest(bundle.projectExport!).status, "succeeded");
  assert.equal(installation.snapshot.audit.some((event) => event.eventType === "recovery.exported"), true);

  const tampered = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
  tampered.integrity.digest = "sha256:tampered";
  assert.equal(verifyCustomerRealmRecoveryBundle(tampered).status, "failed");

  const restored = new CustomerRealmInstallation({ installationId: "installation:recovery", cloudflare, importer, now: () => new Date("2026-08-03T00:00:00.000Z") });
  const quarantined = await restored.restoreRecovery(bundle);
  assert.equal(quarantined.phase, "recovery-pending");
  assert.equal(quarantined.account?.credentialsStored, false);
  assert.equal(quarantined.resources?.state, "recovery-pending");
  const restoredRealm = restored.realmPolicy!.snapshot();
  assert.equal(Object.keys(restoredRealm.credentials).length, 0);
  assert.equal(restoredRealm.sessions[session.id]?.status, "revoked");
  assert.equal(restoredRealm.tasks[task.id]?.status, "closed");
  assert.equal(restoredRealm.grants[grant.id]?.status, "revoked");

  const active = await restored.activateRecovery({ ownerPrincipalId: "principal:installation:recovery", recoveryReceipt: "fresh-external-recovery-receipt" });
  assert.equal(active.phase, "active");
  assert.equal(active.resources?.state, "verified");
  assert.equal(active.account?.credentialsStored, false);
});

test("provisioning outage is resumable from a customer-owned resource checkpoint", async () => {
  const delegate = new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]);
  const cloudflare = new FailOnceProvisionAdapter(delegate);
  const installation = new CustomerRealmInstallation({ installationId: "installation:provision-recovery", cloudflare, importer: new ScriptedImporter(importReceipt("sha256:unused")), now: () => new Date("2026-08-03T00:00:00.000Z") });
  const first = await installation.install({ accountId: "account:customer", requestedResourceTypes: ["d1"], ownerConfirmed: true, operationId: "operation:provision", idempotencyKey: "idempotency:provision" });
  assert.equal(first.phase, "degraded");
  assert.equal(first.degraded?.operation, "realm.provision");
  assert.equal(first.resources?.state, "provisioning");
  assert.equal(first.resources?.owner, "customer");
  const recovered = await installation.recover();
  assert.equal(recovered.phase, "realm-ready");
  assert.equal(recovered.resources?.state, "verified");
  assert.equal(recovered.account?.credentialsStored, false);
});
