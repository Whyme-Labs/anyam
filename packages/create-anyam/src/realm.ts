import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { runLocalCheck, type LocalCheckReport } from "./scaffold.js";

export const ANYAM_CLI_REALM_PROTOCOL = "anyam.cli-realm/v1" as const;
const STATE_FILE = ".anyam/realm.json";

export type RealmPlan = {
  protocol: typeof ANYAM_CLI_REALM_PROTOCOL;
  version: "v1";
  installationId: string;
  accountId: string;
  resources: readonly string[];
  permissions: readonly string[];
  domains: readonly string[];
  secrets: readonly { name: string; storage: "customer-cloudflare-secret"; materialStored: false }[];
  cost: { status: "not-estimated"; receipt: string };
  migration: { strategy: "resumable"; receipt: string };
  rollback: { strategy: "checkpoint-and-export"; receipt: string };
  destruction: { strategy: "explicit-provider-deletion"; receipt: string };
  digest: string;
};

export type RealmState = {
  protocol: typeof ANYAM_CLI_REALM_PROTOCOL;
  version: "v1";
  installationId: string;
  phase: "provider-pending" | "installed" | "upgrade-pending" | "recovery-pending" | "destroy-pending";
  desiredVersion: string;
  plan: RealmPlan;
  planDigest: string;
  checkpointDigest: string;
  credentialFree: true;
  providerMutation: false;
  receipt: string;
};

export type RealmProviderAdapterResult = {
  readonly status: "succeeded" | "blocked" | "indeterminate";
  readonly providerOperationId: string;
  readonly receipt: string;
  readonly recoveryAction: string;
};

/** Customer-owned mutation seam. Provider credentials never enter RealmState. */
export type RealmProviderAdapter = {
  install(input: { plan: RealmPlan; checkpoint: RealmState }): Promise<RealmProviderAdapterResult>;
  upgrade(input: { state: RealmState; desiredVersion: string }): Promise<RealmProviderAdapterResult>;
  destroy(input: { state: RealmState }): Promise<RealmProviderAdapterResult>;
};

export type RealmCommandResult = {
  protocol: typeof ANYAM_CLI_REALM_PROTOCOL;
  status: "planned" | "succeeded" | "blocked" | "unchanged";
  operation: "plan" | "install" | "upgrade" | "doctor" | "export" | "restore" | "destroy";
  directory: string;
  state?: RealmState;
  plan?: RealmPlan;
  doctor?: LocalCheckReport;
  exportPath?: string;
  recoveryAction: string;
  receipt: string;
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stable(nested)]));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`realm ${field} is required`);
  return value.trim();
}

function providerReceipt(value: string, field: string): string {
  const receipt = required(value, field);
  if (/(?:Bearer\s+\S+|(?:token|secret|password|api[_-]?key|private[_-]?key)\s*[=:]\s*\S+)/iu.test(receipt)) throw new Error(`${field} contains credential material`);
  return receipt;
}

function providerResult(input: RealmProviderAdapterResult): RealmProviderAdapterResult {
  const providerOperationId = required(input.providerOperationId, "providerOperationId");
  const receipt = providerReceipt(input.receipt, "providerReceipt");
  const recoveryAction = required(input.recoveryAction, "providerRecoveryAction");
  return { status: input.status, providerOperationId, receipt, recoveryAction };
}

function resourcePermissions(resources: readonly string[]): readonly string[] {
  const permissions = new Set<string>(["Workers Scripts Read", "Workers Scripts Write", "D1 Read", "R2 Read", "Queues Read", "Workflows Read"]);
  for (const resource of resources) {
    if (resource.toLocaleLowerCase().includes("d1")) permissions.add("D1 Edit");
    if (resource.toLocaleLowerCase().includes("r2")) permissions.add("R2 Edit");
    if (resource.toLocaleLowerCase().includes("queue")) permissions.add("Queues Edit");
    if (resource.toLocaleLowerCase().includes("workflow")) permissions.add("Workflows Edit");
  }
  return [...permissions].sort();
}

export function createRealmPlan(input: { installationId: string; accountId: string; resources: readonly string[]; domains?: readonly string[] }): RealmPlan {
  const installationId = required(input.installationId, "installationId");
  const accountId = required(input.accountId, "accountId");
  const resources = [...new Set(input.resources.map((resource) => required(resource, "resource")))];
  if (resources.length === 0) throw new Error("realm resources must contain at least one explicit resource type");
  const body: Omit<RealmPlan, "digest"> = {
    protocol: ANYAM_CLI_REALM_PROTOCOL,
    version: "v1",
    installationId,
    accountId,
    resources,
    permissions: resourcePermissions(resources),
    domains: [...(input.domains ?? [])].map((domain) => required(domain, "domain")),
    secrets: [
      { name: "ANYAM_HANDOFF_SECRET", storage: "customer-cloudflare-secret", materialStored: false },
      { name: "ANYAM_RECOVERY_KEY", storage: "customer-cloudflare-secret", materialStored: false },
    ],
    cost: { status: "not-estimated", receipt: "provider pricing not queried; no cost number claimed" },
    migration: { strategy: "resumable", receipt: "install and upgrade use checkpointed idempotent transitions" },
    rollback: { strategy: "checkpoint-and-export", receipt: "restore uses credential-free exported state and explicit activation" },
    destruction: { strategy: "explicit-provider-deletion", receipt: "CLI never deletes provider resources without an explicit adapter operation" },
  };
  return { ...body, digest: digest(body) };
}

function checkpointDigest(state: Omit<RealmState, "checkpointDigest">): string {
  return digest({ ...state, checkpointDigest: "pending" });
}

function stateWithCheckpoint(state: Omit<RealmState, "checkpointDigest">): RealmState {
  const checkpoint = checkpointDigest(state);
  return { ...state, checkpointDigest: checkpoint };
}

function statePath(directory: string): string {
  return join(resolve(directory), STATE_FILE);
}

async function writeState(directory: string, state: RealmState): Promise<void> {
  const path = statePath(directory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function readRealmState(directory: string): Promise<RealmState | undefined> {
  try {
    const value = JSON.parse(await readFile(statePath(directory), "utf8")) as RealmState;
    if (value.protocol !== ANYAM_CLI_REALM_PROTOCOL || value.version !== "v1" || value.credentialFree !== true || value.providerMutation !== false) throw new Error("realm state protocol or trust boundary is invalid");
    const { checkpointDigest: _checkpointDigest, ...withoutCheckpoint } = value;
    if (value.planDigest !== value.plan.digest || value.checkpointDigest !== checkpointDigest(withoutCheckpoint)) throw new Error("realm state checkpoint digest is invalid");
    return value;
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`realm state could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function realmPlan(input: { directory: string; installationId: string; accountId: string; resources: readonly string[]; domains?: readonly string[] }): RealmCommandResult {
  const plan = createRealmPlan(input);
  return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: "planned", operation: "plan", directory: resolve(input.directory), plan, recoveryAction: "Review the plan, then run realm install with the same installation and account identities.", receipt: `operation=plan; installation=${plan.installationId}; account=${plan.accountId}; resources=${plan.resources.join(",")}; readOnly=true; providerMutation=false; credentialMaterialStored=false` };
}

export async function realmInstall(input: { directory: string; installationId: string; accountId: string; resources: readonly string[]; domains?: readonly string[]; desiredVersion?: string; providerAdapter?: RealmProviderAdapter }): Promise<RealmCommandResult> {
  const directory = resolve(input.directory);
  const plan = createRealmPlan(input);
  const existing = await readRealmState(directory);
  if (existing && existing.planDigest === plan.digest && existing.phase === "installed") return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: "unchanged", operation: "install", directory, state: existing, plan, recoveryAction: "No action is required; the installation checkpoint is already installed.", receipt: `${existing.receipt}; idempotent=true` };
  const state = stateWithCheckpoint({ protocol: ANYAM_CLI_REALM_PROTOCOL, version: "v1", installationId: plan.installationId, phase: "provider-pending", desiredVersion: input.desiredVersion?.trim() || "0.0.0", plan, planDigest: plan.digest, credentialFree: true, providerMutation: false, receipt: `operation=install; installation=${plan.installationId}; provider=not-invoked; checkpoint=resumable; credentialMaterialStored=false` });
  await writeState(directory, state);
  if (input.providerAdapter) {
    const result = providerResult(await input.providerAdapter.install({ plan, checkpoint: state }));
    const completed = stateWithCheckpoint({ ...state, phase: result.status === "succeeded" ? "installed" : "provider-pending", receipt: `${state.receipt}; providerStatus=${result.status}; providerOperationId=${result.providerOperationId}; ${result.receipt}; providerMutation=observed; credentialFree=true` });
    await writeState(directory, completed);
    return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: result.status === "succeeded" ? "succeeded" : "blocked", operation: "install", directory, state: completed, plan, recoveryAction: result.recoveryAction, receipt: `${completed.receipt}; stateFile=${STATE_FILE}` };
  }
  return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: "blocked", operation: "install", directory, state, plan, recoveryAction: "Run the customer-owned Cloudflare adapter/install route with this exact installation checkpoint; the CLI did not claim provider provisioning.", receipt: `${state.receipt}; stateFile=${STATE_FILE}; providerMutation=false` };
}

export async function realmUpgrade(input: { directory: string; desiredVersion: string; providerAdapter?: RealmProviderAdapter }): Promise<RealmCommandResult> {
  const directory = resolve(input.directory);
  const current = await readRealmState(directory);
  if (!current) return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: "blocked", operation: "upgrade", directory, recoveryAction: "Run realm plan and realm install before upgrading.", receipt: "operation=upgrade; state=missing; providerMutation=false" };
  const desiredVersion = required(input.desiredVersion, "desiredVersion");
  if (current.desiredVersion === desiredVersion && current.phase === "installed") return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: "unchanged", operation: "upgrade", directory, state: current, recoveryAction: "No upgrade is required.", receipt: `${current.receipt}; idempotent=true` };
  const state = stateWithCheckpoint({ ...current, phase: "upgrade-pending", desiredVersion, receipt: `operation=upgrade; from=${current.desiredVersion}; to=${desiredVersion}; provider=not-invoked; checkpoint=resumable; credentialMaterialStored=false` });
  await writeState(directory, state);
  if (input.providerAdapter) {
    const result = providerResult(await input.providerAdapter.upgrade({ state, desiredVersion }));
    const completed = stateWithCheckpoint({ ...state, phase: result.status === "succeeded" ? "installed" : "upgrade-pending", receipt: `${state.receipt}; providerStatus=${result.status}; providerOperationId=${result.providerOperationId}; ${result.receipt}; providerMutation=observed; credentialFree=true` });
    await writeState(directory, completed);
    return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: result.status === "succeeded" ? "succeeded" : "blocked", operation: "upgrade", directory, state: completed, recoveryAction: result.recoveryAction, receipt: `${completed.receipt}; stateFile=${STATE_FILE}` };
  }
  return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: "blocked", operation: "upgrade", directory, state, recoveryAction: "Run the customer-owned upgrade adapter against this checkpoint; no source, Target, or audit state was rewritten by the CLI.", receipt: `${state.receipt}; providerMutation=false` };
}

export async function realmDoctor(directory: string): Promise<RealmCommandResult> {
  const resolved = resolve(directory);
  const state = await readRealmState(resolved);
  if (!state) return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: "blocked", operation: "doctor", directory: resolved, recoveryAction: "Run realm plan/install to create a verified customer-operated installation checkpoint.", receipt: "operation=doctor; state=missing; providerMutation=false" };
  const doctor = await runLocalCheck(resolved);
  const status = state.phase === "installed" && doctor.status === "passed" ? "succeeded" : "blocked";
  return { protocol: ANYAM_CLI_REALM_PROTOCOL, status, operation: "doctor", directory: resolved, state, doctor, recoveryAction: status === "succeeded" ? "No local recovery action is currently required." : "Resolve the named local or provider-pending checkpoint before activation.", receipt: `operation=doctor; phase=${state.phase}; localCheck=${doctor.status}; providerMutation=false; credentialMaterialStored=false` };
}

export async function realmExport(directory: string, exportPath: string): Promise<RealmCommandResult> {
  const resolved = resolve(directory);
  const state = await readRealmState(resolved);
  if (!state) return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: "blocked", operation: "export", directory: resolved, recoveryAction: "Create a verified Realm state checkpoint before exporting.", receipt: "operation=export; state=missing; providerMutation=false" };
  const output = resolve(exportPath);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: "succeeded", operation: "export", directory: resolved, state, exportPath: output, recoveryAction: "Retain this credential-free export in customer-controlled storage.", receipt: `operation=export; path=${output}; digest=${digest(state)}; credentialFree=true; providerMutation=false` };
}

export async function realmRestore(directory: string, exportPath: string): Promise<RealmCommandResult> {
  const resolved = resolve(directory);
  const value = JSON.parse(await readFile(resolve(exportPath), "utf8")) as RealmState;
  if (value.protocol !== ANYAM_CLI_REALM_PROTOCOL || value.credentialFree !== true || value.providerMutation !== false || value.planDigest !== value.plan.digest) throw new Error("realm restore export is not a verified credential-free Anyam state");
  const state = stateWithCheckpoint({ ...value, phase: "recovery-pending", receipt: `operation=restore; source=${resolve(exportPath)}; provider=not-invoked; ownerActivationRequired=true; credentialMaterialStored=false` });
  await writeState(resolved, state);
  return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: "succeeded", operation: "restore", directory: resolved, state, exportPath: resolve(exportPath), recoveryAction: "Authenticate the customer owner and reconcile provider resources before activation.", receipt: `${state.receipt}; providerMutation=false` };
}

export async function realmDestroy(directory: string, providerAdapter?: RealmProviderAdapter): Promise<RealmCommandResult> {
  const resolved = resolve(directory);
  const current = await readRealmState(resolved);
  if (!current) return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: "unchanged", operation: "destroy", directory: resolved, recoveryAction: "No local installation state exists.", receipt: "operation=destroy; state=missing; providerMutation=false" };
  const state = stateWithCheckpoint({ ...current, phase: "destroy-pending", receipt: `operation=destroy; provider=not-invoked; explicit-provider-deletion-required; credentialMaterialStored=false` });
  await writeState(resolved, state);
  if (providerAdapter) {
    const result = providerResult(await providerAdapter.destroy({ state }));
    const completed = stateWithCheckpoint({ ...state, receipt: `${state.receipt}; providerStatus=${result.status}; providerOperationId=${result.providerOperationId}; ${result.receipt}; providerMutation=observed; credentialFree=true` });
    await writeState(resolved, completed);
    return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: result.status === "succeeded" ? "succeeded" : "blocked", operation: "destroy", directory: resolved, state: completed, recoveryAction: result.recoveryAction, receipt: `${completed.receipt}; stateFile=${STATE_FILE}` };
  }
  return { protocol: ANYAM_CLI_REALM_PROTOCOL, status: "blocked", operation: "destroy", directory: resolved, state, recoveryAction: "Run the customer-owned provider destruction adapter after retaining the export; the CLI did not delete provider resources.", receipt: `${state.receipt}; providerMutation=false` };
}
