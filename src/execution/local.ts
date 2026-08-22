import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  CONTRACT_VERSIONS,
  opaqueId,
  type Action,
  type ActorRef,
  type Artifact,
  type DisclosurePolicyRef,
  type Evidence,
  type Release,
  type Run,
  type Target,
  type Verifier,
} from "../kernel/contracts.ts";
import {
  EvidenceLedger,
  evaluateStageGate,
  type EvidenceRecord,
  type EvidenceRequirement,
  type StageGateDecision,
} from "../kernel/evidence.ts";
import { targetDeploymentProfile } from "../delivery/target-deployment.ts";
import { createReleaseInputSet } from "../delivery/release-input.ts";

type JsonRecord = Record<string, unknown>;

export type NormalizedTarget = {
  id: string;
  adapterId: string;
  acceptedArtifactTypes: readonly string[];
  requiredCapabilities: readonly string[];
  contractDigest: string;
};

export type NormalizedProjectSource = {
  root: string;
  provenance: string;
};

export type NormalizedModule = {
  id: string;
  root: string;
  dependencyIds: readonly string[];
  artifactTypes: readonly string[];
  actionIds: readonly string[];
};

export type NormalizedProjectManifest = {
  schema: "anyam.project/v1";
  projectId: string;
  name: string;
  referenceType: string;
  sourceSpaceIds: readonly string[];
  source: NormalizedProjectSource;
  modules: readonly NormalizedModule[];
  actions: readonly Action[];
  verifiers: readonly Verifier[];
  targets: readonly NormalizedTarget[];
  artifactTypesByModule: Readonly<Record<string, readonly string[]>>;
  digest: string;
  warnings: readonly string[];
};

export type LocalExecutionContext = {
  directory: string;
  projectRevisionId: string;
  projectViewId: string;
  sourceSpaceSnapshots: Readonly<Record<string, string>>;
  actor: ActorRef;
  runnerId: string;
  policyVersion: string;
  authorizationEpoch: string;
  capabilityGrantId: string;
  dependencyDigest: string;
  toolchainDigest: string;
  environmentDigest: string;
  disclosure: DisclosurePolicyRef;
  owner: string;
  changeRevisionId?: string;
  workspaceId?: string;
  targetId?: string;
  targetDeploymentProfileDigest?: string;
  declaredEffects?: readonly string[];
};

/**
 * Provider-neutral input passed to a Runner. A remote Runner receives this
 * same semantic envelope; only the process/container mechanics change.
 */
export type NormalizedActionInput = {
  action: Action;
  verifier?: Verifier;
  projectRevisionId: string;
  projectViewId: string;
  sourceSpaceSnapshots: Readonly<Record<string, string>>;
  changeRevisionId?: string;
  workspaceId?: string;
  inputDigests: readonly string[];
  effectDigests: readonly string[];
  dependencyDigest: string;
  toolchainDigest: string;
  environmentDigest: string;
  policyVersion: string;
  authorizationEpoch: string;
  targetId?: string;
  targetDeploymentProfileDigest?: string;
  disclosure: DisclosurePolicyRef;
  actor: ActorRef;
  capabilityGrantId: string;
  runnerId: string;
};

/** Provider-neutral output returned by a Runner after an Action attempt. */
export type NormalizedActionOutput = {
  status: "succeeded" | "failed" | "indeterminate";
  exitCode: number | undefined;
  inputDigests: readonly string[];
  outputDigests: readonly string[];
  outputDigest: string;
  stdoutDigest: string;
  stderrDigest: string;
};

export type LocalActionResult = {
  run: Run;
  evidence: EvidenceRecord;
  artifacts: readonly Artifact[];
  runnerInput: NormalizedActionInput;
  runnerOutput: NormalizedActionOutput;
  cacheHit: boolean;
  stdout: string;
  stderr: string;
  validityKey: string;
  /** A source-revision-independent key for safe cache reuse. */
  reuseKey: string;
};

export type LocalReleasePlan = {
  changedPaths: readonly string[] | undefined;
  directModuleIds: readonly string[];
  affectedModuleIds: readonly string[];
  selectedActionIds: readonly string[];
  skippedActionIds: readonly string[];
  reusedActionIds: readonly string[];
  fallbackActionIds: readonly string[];
  receipt: string;
};

export type LocalReleaseResult = {
  manifest: NormalizedProjectManifest;
  runs: readonly Run[];
  evidence: readonly EvidenceRecord[];
  artifacts: readonly Artifact[];
  release: Release;
  gate: StageGateDecision;
  plan: LocalReleasePlan;
  cacheHits: number;
  warnings: readonly string[];
};

export type LocalExecutionErrorCode =
  | "manifest-invalid"
  | "manifest-duplicate"
  | "manifest-reference-invalid"
  | "action-not-found"
  | "verifier-not-found"
  | "action-input-invalid"
  | "action-output-invalid"
  | "action-input-missing"
  | "action-output-missing"
  | "target-not-found"
  | "target-artifact-mismatch"
  | "command-failed"
  | "runner-error";

export class LocalExecutionError extends Error {
  readonly code: LocalExecutionErrorCode;
  readonly affectedObject: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    code: LocalExecutionErrorCode;
    message: string;
    affectedObject: string;
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "LocalExecutionError";
    this.code = input.code;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function fail(input: ConstructorParameters<typeof LocalExecutionError>[0]): never {
  throw new LocalExecutionError(input);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? "null";
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex")}`;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail({
      code: "manifest-invalid",
      message: `Manifest field ${path} must be an array of strings.`,
      affectedObject: path,
      recoveryAction: "repair the Project Manifest field and rerun the local check",
      receipt: `field=${path}; expected=string[]`,
    });
  }
  return [...value];
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail({
      code: "manifest-invalid",
      message: `Manifest field ${path} must be a non-empty string.`,
      affectedObject: path,
      recoveryAction: "repair the Project Manifest field and rerun the local check",
      receipt: `field=${path}; expected=non-empty-string`,
    });
  }
  return value;
}

function resources(value: unknown, path: string): Readonly<Record<string, string | number | boolean>> {
  if (!isRecord(value) || Object.entries(value).some(([, nested]) => !scalar(nested))) {
    fail({
      code: "manifest-invalid",
      message: `Manifest field ${path} must contain only scalar resource declarations.`,
      affectedObject: path,
      recoveryAction: "use string, number, or boolean resource declarations",
      receipt: `field=${path}; expected=scalar-record`,
    });
  }
  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (scalar(nested)) normalized[key] = nested;
  }
  return normalized;
}

function relativeDeclaration(value: string, path: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "..") ||
    normalized.includes("\0")
  ) {
    fail({
      code: path.includes("output") ? "action-output-invalid" : "action-input-invalid",
      message: `Action declaration ${path} must be a relative path or glob without traversal.`,
      affectedObject: path,
      recoveryAction: "use a relative input glob or output path below the Project directory",
      receipt: `field=${path}; value=${JSON.stringify(value)}; rule=relative-no-traversal`,
    });
  }
  return normalized;
}

function unique(values: readonly string[], path: string): readonly string[] {
  if (new Set(values).size !== values.length) {
    fail({
      code: "manifest-duplicate",
      message: `Manifest field ${path} contains duplicate identifiers.`,
      affectedObject: path,
      recoveryAction: "remove duplicate identifiers and rerun the local check",
      receipt: `field=${path}; rule=unique-identifiers`,
    });
  }
  return values;
}

function actionContractDigest(action: Omit<Action, "contractDigest" | "protocol">): string {
  return digest(action);
}

function verifierContractDigest(verifier: Omit<Verifier, "contractDigest" | "protocol">): string {
  return digest(verifier);
}

function targetContractDigest(target: Omit<NormalizedTarget, "contractDigest">): string {
  return digest(target);
}

/**
 * Normalize the JSON Project Manifest once. Local and remote Runners consume
 * this same semantic shape; only the Runner mechanics differ.
 */
export function normalizeProjectManifest(value: unknown): NormalizedProjectManifest {
  if (!isRecord(value)) {
    fail({
      code: "manifest-invalid",
      message: "Project Manifest must be a JSON object.",
      affectedObject: "manifest",
      recoveryAction: "write a JSON object matching anyam.project/v1",
      receipt: "manifest-type=non-object",
    });
  }
  const schema = requiredString(value.schema, "schema");
  if (schema !== "anyam.project/v1") {
    fail({
      code: "manifest-invalid",
      message: `Unsupported Project Manifest schema ${schema}.`,
      affectedObject: "manifest.schema",
      recoveryAction: "migrate the Project Manifest to anyam.project/v1 before running Actions",
      receipt: `schema=${schema}; expected=anyam.project/v1`,
    });
  }
  const projectId = requiredString(value.id, "id");
  const name = requiredString(value.name, "name");
  const referenceType = requiredString(value.referenceType, "referenceType");
  const sourceSpaceIds = unique(stringArray(value.sourceSpaceIds, "sourceSpaceIds"), "sourceSpaceIds");
  if (!isRecord(value.source)) {
    fail({
      code: "manifest-invalid",
      message: "Project Manifest must declare source provenance.",
      affectedObject: "source",
      recoveryAction: "declare source.root and source.provenance in the Project Manifest",
      receipt: "field=source; expected=object",
    });
  }
  const source: NormalizedProjectSource = {
    root: relativeDeclaration(requiredString(value.source.root, "source.root"), "source.root"),
    provenance: requiredString(value.source.provenance, "source.provenance"),
  };
  const modulesValue = value.modules;
  if (!Array.isArray(modulesValue) || modulesValue.length === 0) {
    fail({
      code: "manifest-invalid",
      message: "Project Manifest must declare at least one module.",
      affectedObject: "modules",
      recoveryAction: "declare one module with an Action and Artifact type",
      receipt: "field=modules; expected=non-empty-array",
    });
  }

  const actions: Action[] = [];
  const modules: NormalizedModule[] = [];
  const artifactTypesByModule: Record<string, readonly string[]> = {};
  const actionIds = new Set<string>();
  const moduleIds = new Set<string>();
  for (const [moduleIndex, moduleValue] of modulesValue.entries()) {
    if (!isRecord(moduleValue)) {
      fail({
        code: "manifest-invalid",
        message: `Manifest module ${moduleIndex} must be an object.`,
        affectedObject: `modules[${moduleIndex}]`,
        recoveryAction: "repair the module declaration",
        receipt: `field=modules[${moduleIndex}]; expected=object`,
      });
    }
    const moduleId = requiredString(moduleValue.id, `modules[${moduleIndex}].id`);
    if (moduleIds.has(moduleId)) {
      fail({
        code: "manifest-duplicate",
        message: `Module ${moduleId} is declared more than once.`,
        affectedObject: moduleId,
        recoveryAction: "give each Module a unique stable identifier",
        receipt: `module=${moduleId}; rule=unique-module-id`,
      });
    }
    moduleIds.add(moduleId);
    const moduleRoot = relativeDeclaration(requiredString(moduleValue.root, `modules[${moduleIndex}].root`), `modules[${moduleIndex}].root`);
    const dependencyIds = unique(stringArray(moduleValue.dependencies, `modules[${moduleIndex}].dependencies`), `modules[${moduleIndex}].dependencies`);
    const artifactTypes = unique(stringArray(moduleValue.artifactTypes, `modules[${moduleIndex}].artifactTypes`), `modules[${moduleIndex}].artifactTypes`);
    artifactTypesByModule[moduleId] = artifactTypes;
    const actionValues = moduleValue.actions;
    if (!Array.isArray(actionValues) || actionValues.length === 0) {
      fail({
        code: "manifest-invalid",
        message: `Module ${moduleId} must declare at least one Action.`,
        affectedObject: `modules[${moduleIndex}].actions`,
        recoveryAction: "declare a portable Action with inputs, outputs, and a command",
        receipt: `module=${moduleId}; expected=non-empty-action-array`,
      });
    }
    for (const [actionIndex, actionValue] of actionValues.entries()) {
      if (!isRecord(actionValue)) {
        fail({
          code: "manifest-invalid",
          message: `Action ${moduleId}[${actionIndex}] must be an object.`,
          affectedObject: `modules[${moduleIndex}].actions[${actionIndex}]`,
          recoveryAction: "repair the Action declaration",
          receipt: `module=${moduleId}; action-index=${actionIndex}; expected=object`,
        });
      }
      const id = requiredString(actionValue.id, `modules[${moduleIndex}].actions[${actionIndex}].id`);
      if (actionIds.has(id)) {
        fail({
          code: "manifest-duplicate",
          message: `Action ${id} is declared more than once.`,
          affectedObject: id,
          recoveryAction: "give each Action a unique stable identifier",
          receipt: `action=${id}; rule=unique-action-id`,
        });
      }
      actionIds.add(id);
      const actionWithoutDigest: Omit<Action, "contractDigest" | "protocol"> = {
        id,
        moduleId,
        moduleRoot,
        dependencyIds,
        command: requiredString(actionValue.command, `modules[${moduleIndex}].actions[${actionIndex}].command`),
        inputGlobs: stringArray(actionValue.inputs, `modules[${moduleIndex}].actions[${actionIndex}].inputs`).map(
          (input, index) => relativeDeclaration(input, `modules[${moduleIndex}].actions[${actionIndex}].inputs[${index}]`),
        ),
        outputPaths: stringArray(actionValue.outputs, `modules[${moduleIndex}].actions[${actionIndex}].outputs`).map(
          (output, index) => relativeDeclaration(output, `modules[${moduleIndex}].actions[${actionIndex}].outputs[${index}]`),
        ),
        network: stringArray(actionValue.network, `modules[${moduleIndex}].actions[${actionIndex}].network`),
        resources: resources(actionValue.resources, `modules[${moduleIndex}].actions[${actionIndex}].resources`),
      };
      actions.push({
        protocol: CONTRACT_VERSIONS.action,
        ...actionWithoutDigest,
        contractDigest: actionContractDigest(actionWithoutDigest),
      });
    }
    modules.push({
      id: moduleId,
      root: moduleRoot,
      dependencyIds: [...dependencyIds],
      artifactTypes: [...artifactTypes],
      actionIds: actions
        .filter((action) => action.moduleId === moduleId)
        .map((action) => action.id),
    });
  }

  const moduleIdsById = new Set(modules.map((module) => module.id));
  for (const module of modules) {
    const unknownDependency = module.dependencyIds.find((dependencyId) => !moduleIdsById.has(dependencyId));
    if (unknownDependency) {
      fail({
        code: "manifest-reference-invalid",
        message: `Module ${module.id} depends on unknown Module ${unknownDependency}.`,
        affectedObject: module.id,
        recoveryAction: "declare the dependency Module or remove the stale dependency before running Actions",
        receipt: `module=${module.id}; dependency=${unknownDependency}; dependency-reference=missing`,
      });
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (module: NormalizedModule): void => {
    if (visited.has(module.id)) return;
    if (visiting.has(module.id)) {
      fail({
        code: "manifest-reference-invalid",
        message: `Module dependency graph contains a cycle at ${module.id}.`,
        affectedObject: module.id,
        recoveryAction: "remove the dependency cycle so the Release plan has a deterministic order",
        receipt: `module=${module.id}; dependency-graph=cycle; visiting=${[...visiting].join(",")}`,
      });
    }
    visiting.add(module.id);
    for (const dependencyId of module.dependencyIds) {
      const dependency = modules.find((candidate) => candidate.id === dependencyId);
      if (dependency) visit(dependency);
    }
    visiting.delete(module.id);
    visited.add(module.id);
  };
  for (const module of modules) visit(module);

  const verifierValues = value.verifiers;
  if (!Array.isArray(verifierValues)) {
    fail({
      code: "manifest-invalid",
      message: "Project Manifest must declare Verifiers.",
      affectedObject: "verifiers",
      recoveryAction: "declare a Verifier for every Action required by the Release policy",
      receipt: "field=verifiers; expected=array",
    });
  }
  const verifiers: Verifier[] = [];
  const verifierIds = new Set<string>();
  for (const [index, verifierValue] of verifierValues.entries()) {
    if (!isRecord(verifierValue)) {
      fail({
        code: "manifest-invalid",
        message: `Verifier ${index} must be an object.`,
        affectedObject: `verifiers[${index}]`,
        recoveryAction: "repair the Verifier declaration",
        receipt: `field=verifiers[${index}]; expected=object`,
      });
    }
    const id = requiredString(verifierValue.id, `verifiers[${index}].id`);
    if (verifierIds.has(id)) {
      fail({
        code: "manifest-duplicate",
        message: `Verifier ${id} is declared more than once.`,
        affectedObject: id,
        recoveryAction: "give each Verifier a unique stable identifier",
        receipt: `verifier=${id}; rule=unique-verifier-id`,
      });
    }
    verifierIds.add(id);
    const actionId = requiredString(verifierValue.actionId, `verifiers[${index}].actionId`);
    if (!actionIds.has(actionId)) {
      fail({
        code: "manifest-reference-invalid",
        message: `Verifier ${id} references unknown Action ${actionId}.`,
        affectedObject: id,
        recoveryAction: "bind the Verifier to a declared Action",
        receipt: `verifier=${id}; action=${actionId}; reference=missing`,
      });
    }
    const disclosure = verifierValue.disclosure;
    if (disclosure !== "full" && disclosure !== "result-only") {
      fail({
        code: "manifest-invalid",
        message: `Verifier ${id} must declare full or result-only disclosure.`,
        affectedObject: id,
        recoveryAction: "choose a disclosure policy for the Verifier",
        receipt: `verifier=${id}; disclosure=${String(disclosure)}`,
      });
    }
    const verifierWithoutDigest: Omit<Verifier, "contractDigest" | "protocol"> = {
      id,
      actionId,
      disclosure,
      requiredFor: unique(stringArray(verifierValue.requiredFor, `verifiers[${index}].requiredFor`), `verifiers[${index}].requiredFor`),
    };
    verifiers.push({
      protocol: CONTRACT_VERSIONS.verifier,
      ...verifierWithoutDigest,
      contractDigest: verifierContractDigest(verifierWithoutDigest),
    });
  }

  const targetValues = value.targets;
  if (!Array.isArray(targetValues)) {
    fail({
      code: "manifest-invalid",
      message: "Project Manifest must declare Targets.",
      affectedObject: "targets",
      recoveryAction: "declare an Artifact Target for the Project",
      receipt: "field=targets; expected=array",
    });
  }
  const targets: NormalizedTarget[] = [];
  const targetIds = new Set<string>();
  for (const [index, targetValue] of targetValues.entries()) {
    if (!isRecord(targetValue)) {
      fail({
        code: "manifest-invalid",
        message: `Target ${index} must be an object.`,
        affectedObject: `targets[${index}]`,
        recoveryAction: "repair the Target declaration",
        receipt: `field=targets[${index}]; expected=object`,
      });
    }
    const id = requiredString(targetValue.id, `targets[${index}].id`);
    if (targetIds.has(id)) {
      fail({
        code: "manifest-duplicate",
        message: `Target ${id} is declared more than once.`,
        affectedObject: id,
        recoveryAction: "give each Target a unique stable identifier",
        receipt: `target=${id}; rule=unique-target-id`,
      });
    }
    targetIds.add(id);
    const targetWithoutDigest: Omit<NormalizedTarget, "contractDigest"> = {
      id,
      adapterId: requiredString(targetValue.adapter, `targets[${index}].adapter`),
      acceptedArtifactTypes: unique(stringArray(targetValue.accepts, `targets[${index}].accepts`), `targets[${index}].accepts`),
      requiredCapabilities: unique(stringArray(targetValue.requiredCapabilities, `targets[${index}].requiredCapabilities`), `targets[${index}].requiredCapabilities`),
    };
    targets.push({ ...targetWithoutDigest, contractDigest: targetContractDigest(targetWithoutDigest) });
  }

  const knownFields = new Set(["schema", "id", "name", "referenceType", "sourceSpaceIds", "source", "modules", "verifiers", "targets"]);
  const warnings = Object.keys(value)
    .filter((key) => !knownFields.has(key))
    .map((key) => `unknown manifest field preserved in digest: ${key}`);
  return {
    schema: "anyam.project/v1",
    projectId,
    name,
    referenceType,
    sourceSpaceIds,
    source,
    modules,
    actions,
    verifiers,
    targets,
    artifactTypesByModule,
    digest: digest(value),
    warnings,
  };
}

function globRegExp(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") index += 1;
      expression += "(?:.*/)?";
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`${expression}$`);
}

function normalizeChangedPath(value: string, index: number): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.length === 0 || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    fail({
      code: "manifest-invalid",
      message: `Changed path ${index} must be relative and must not traverse outside the Project Workspace.`,
      affectedObject: `changedPaths[${index}]`,
      recoveryAction: "provide normalized tracked paths relative to the Project Workspace",
      receipt: `field=changedPaths[${index}]; path=${JSON.stringify(value)}; relative-no-traversal=false`,
    });
  }
  return normalized;
}

function pathUnderModuleRoot(path: string, root: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

function moduleDirectlyAffected(module: NormalizedModule, actions: readonly Action[], changedPaths: readonly string[]): boolean {
  if (changedPaths.some((path) => pathUnderModuleRoot(path, module.root))) return true;
  return actions
    .filter((action) => action.moduleId === module.id)
    .some((action) => changedPaths.some((path) => action.inputGlobs.some((pattern) => globRegExp(pattern).test(path))));
}

function releasePlanReceipt(input: {
  changedPaths: readonly string[] | undefined;
  directModuleIds: readonly string[];
  affectedModuleIds: readonly string[];
  selectedActionIds: readonly string[];
  skippedActionIds: readonly string[];
  reusedActionIds: readonly string[];
  fallbackActionIds: readonly string[];
}): string {
  return [
    "release-plan=v1",
    `changedPaths=${input.changedPaths === undefined ? "not-provided" : input.changedPaths.length === 0 ? "empty" : input.changedPaths.join(",")}`,
    `directModules=${input.directModuleIds.join(",") || "none"}`,
    `affectedModules=${input.affectedModuleIds.join(",") || "none"}`,
    `selectedActions=${input.selectedActionIds.join(",") || "none"}`,
    `skippedActions=${input.skippedActionIds.join(",") || "none"}`,
    `reusedActions=${input.reusedActionIds.join(",") || "none"}`,
    `fallbackActions=${input.fallbackActionIds.join(",") || "none"}`,
  ].join("; ");
}

export function createLocalReleasePlan(input: {
  manifest: NormalizedProjectManifest;
  changedPaths?: readonly string[];
}): LocalReleasePlan {
  const changedPaths = input.changedPaths?.map(normalizeChangedPath);
  const allActionIds = input.manifest.actions.map((action) => action.id);
  if (changedPaths === undefined) {
    return {
      changedPaths,
      directModuleIds: input.manifest.modules.map((module) => module.id),
      affectedModuleIds: input.manifest.modules.map((module) => module.id),
      selectedActionIds: allActionIds,
      skippedActionIds: [],
      reusedActionIds: [],
      fallbackActionIds: [],
      receipt: releasePlanReceipt({ changedPaths, directModuleIds: input.manifest.modules.map((module) => module.id), affectedModuleIds: input.manifest.modules.map((module) => module.id), selectedActionIds: allActionIds, skippedActionIds: [], reusedActionIds: [], fallbackActionIds: [] }),
    };
  }

  const directModuleIds = input.manifest.modules
    .filter((module) => moduleDirectlyAffected(module, input.manifest.actions, changedPaths))
    .map((module) => module.id);
  const affectedModuleIds = new Set(directModuleIds);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const module of input.manifest.modules) {
      if (affectedModuleIds.has(module.id)) continue;
      if (module.dependencyIds.some((dependencyId) => affectedModuleIds.has(dependencyId))) {
        affectedModuleIds.add(module.id);
        expanded = true;
      }
    }
  }
  const affected = input.manifest.modules.filter((module) => affectedModuleIds.has(module.id)).map((module) => module.id);
  const selectedActionIds = input.manifest.actions.filter((action) => affectedModuleIds.has(action.moduleId)).map((action) => action.id);
  const skippedActionIds = input.manifest.actions.filter((action) => !affectedModuleIds.has(action.moduleId)).map((action) => action.id);
  return {
    changedPaths,
    directModuleIds,
    affectedModuleIds: affected,
    selectedActionIds,
    skippedActionIds,
    reusedActionIds: [],
    fallbackActionIds: [],
    receipt: releasePlanReceipt({ changedPaths, directModuleIds, affectedModuleIds: affected, selectedActionIds, skippedActionIds, reusedActionIds: [], fallbackActionIds: [] }),
  };
}

function updateLocalReleasePlan(input: LocalReleasePlan, updates: { reusedActionIds: readonly string[]; fallbackActionIds: readonly string[] }): LocalReleasePlan {
  return {
    ...input,
    reusedActionIds: [...updates.reusedActionIds],
    fallbackActionIds: [...updates.fallbackActionIds],
    receipt: releasePlanReceipt({ ...input, reusedActionIds: updates.reusedActionIds, fallbackActionIds: updates.fallbackActionIds }),
  };
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files.sort();
}

async function inputFiles(root: string, patterns: readonly string[]): Promise<{
  files: readonly { path: string; digest: string }[];
  missingPatterns: readonly string[];
}> {
  const allFiles = await walkFiles(root);
  const files: { path: string; digest: string }[] = [];
  const seen = new Set<string>();
  const missingPatterns: string[] = [];
  for (const pattern of patterns) {
    const matcher = globRegExp(pattern);
    const matches = allFiles.filter((path) => matcher.test(path));
    if (matches.length === 0) missingPatterns.push(pattern);
    for (const path of matches) {
      if (seen.has(path)) continue;
      seen.add(path);
      files.push({ path, digest: digest(await readFile(join(root, path))) });
    }
  }
  return { files, missingPatterns };
}

async function outputFiles(root: string, paths: readonly string[]): Promise<{
  files: readonly { path: string; digest: string; bytes: number }[];
  missingPaths: readonly string[];
}> {
  const files: { path: string; digest: string; bytes: number }[] = [];
  const missingPaths: string[] = [];
  for (const path of paths) {
    try {
      const bytes = await readFile(join(root, path));
      const metadata = await stat(join(root, path));
      files.push({ path, digest: digest(bytes), bytes: metadata.size });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") missingPaths.push(path);
      else throw error;
    }
  }
  return { files, missingPaths };
}

type CommandResult = { exitCode: number; stdout: string; stderr: string };

function executeCommand(directory: string, command: string): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    const child = spawn(shell, args, { cwd: directory, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let spawnError: string | undefined;
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once("error", (error) => { spawnError = error instanceof Error ? error.message : String(error); });
    child.once("close", (code) => resolveResult({
      exitCode: code ?? 1,
      stdout,
      stderr: spawnError ? `${stderr}${spawnError}` : stderr,
    }));
  });
}

function cloneRun(run: Run): Run {
  return {
    ...run,
    ...(run.inputDigests ? { inputDigests: [...run.inputDigests] } : {}),
    ...(run.outputDigests ? { outputDigests: [...run.outputDigests] } : {}),
    ...(run.effectDigests ? { effectDigests: [...run.effectDigests] } : {}),
    ...(run.actor ? { actor: { ...run.actor } } : {}),
  };
}

function cloneArtifact(artifact: Artifact): Artifact {
  return { ...artifact, ...(artifact.disclosure ? { disclosure: { ...artifact.disclosure } } : {}) };
}

function cloneActionResult(result: LocalActionResult): LocalActionResult {
  return {
    ...result,
    run: cloneRun(result.run),
    evidence: { ...result.evidence },
    artifacts: result.artifacts.map(cloneArtifact),
    runnerInput: {
      ...result.runnerInput,
      action: {
        ...result.runnerInput.action,
        inputGlobs: [...result.runnerInput.action.inputGlobs],
        outputPaths: [...result.runnerInput.action.outputPaths],
        network: [...result.runnerInput.action.network],
        dependencyIds: [...result.runnerInput.action.dependencyIds],
        resources: { ...result.runnerInput.action.resources },
      },
      ...(result.runnerInput.verifier
        ? { verifier: { ...result.runnerInput.verifier, requiredFor: [...result.runnerInput.verifier.requiredFor] } }
        : {}),
      sourceSpaceSnapshots: { ...result.runnerInput.sourceSpaceSnapshots },
      inputDigests: [...result.runnerInput.inputDigests],
      effectDigests: [...result.runnerInput.effectDigests],
      disclosure: { ...result.runnerInput.disclosure },
      actor: { ...result.runnerInput.actor },
    },
    runnerOutput: {
      ...result.runnerOutput,
      inputDigests: [...result.runnerOutput.inputDigests],
      outputDigests: [...result.runnerOutput.outputDigests],
    },
    reuseKey: result.reuseKey,
  };
}

function appendCachedEvidence(ledger: EvidenceLedger, evidence: Evidence): void {
  if (ledger.list().some((record) => record.id === evidence.id)) return;
  const { protocol: _protocol, version: _version, ...appendable } = evidence;
  ledger.append(appendable);
}

/**
 * Cache is deliberately keyed by the complete Evidence validity key. It is an
 * optimization only; a stale or partial match is never reused.
 */
export class LocalExecutionCache {
  private readonly records = new Map<string, LocalActionResult>();
  private readonly reusableRecords = new Map<string, LocalActionResult>();

  get(validityKey: string): LocalActionResult | undefined {
    const record = this.records.get(validityKey);
    return record ? cloneActionResult(record) : undefined;
  }

  getReusable(reuseKey: string): LocalActionResult | undefined {
    const record = this.reusableRecords.get(reuseKey);
    return record ? cloneActionResult(record) : undefined;
  }

  set(result: LocalActionResult): void {
    if (result.evidence.outcome !== "passed") return;
    const cloned = cloneActionResult(result);
    this.records.set(result.validityKey, cloned);
    this.reusableRecords.set(result.reuseKey, cloned);
  }
}

export class LocalExecutionEngine {
  readonly manifest: NormalizedProjectManifest;
  readonly context: LocalExecutionContext;
  readonly ledger: EvidenceLedger;
  readonly cache: LocalExecutionCache;

  constructor(input: {
    manifest: NormalizedProjectManifest;
    context: LocalExecutionContext;
    ledger?: EvidenceLedger;
    cache?: LocalExecutionCache;
  }) {
    this.manifest = input.manifest;
    this.context = { ...input.context, directory: resolve(input.context.directory) };
    this.ledger = input.ledger ?? new EvidenceLedger();
    this.cache = input.cache ?? new LocalExecutionCache();
  }

  private reuseActionResult(input: {
    reusable: LocalActionResult;
    action: Action;
    verifier: Verifier | undefined;
    runnerInput: NormalizedActionInput;
    runnerOutput: NormalizedActionOutput;
    inputDigests: readonly string[];
    effectDigests: readonly string[];
    effectiveDisclosure: DisclosurePolicyRef;
    validityKey: string;
    reuseKey: string;
  }): LocalActionResult {
    const runId = opaqueId("run");
    const run: Run = {
      ...cloneRun(input.reusable.run),
      id: runId,
      projectRevisionId: this.context.projectRevisionId,
      projectViewId: this.context.projectViewId,
      runnerId: "runner:local-cache",
      status: "succeeded",
      outputDigest: input.runnerOutput.outputDigest,
      ...(this.context.changeRevisionId ? { changeRevisionId: this.context.changeRevisionId } : {}),
      ...(this.context.workspaceId ? { workspaceId: this.context.workspaceId } : {}),
      inputDigests: [...input.inputDigests],
      outputDigests: [...input.runnerOutput.outputDigests],
      effectDigests: [...input.effectDigests],
      dependencyDigest: this.context.dependencyDigest,
      toolchainDigest: this.context.toolchainDigest,
      environmentDigest: this.context.environmentDigest,
      policyVersion: this.context.policyVersion,
      ...(this.context.targetId ? { targetId: this.context.targetId } : {}),
      actor: { ...this.context.actor },
      capabilityGrantId: this.context.capabilityGrantId,
      exitCode: 0,
      stdoutDigest: input.runnerOutput.stdoutDigest,
      stderrDigest: input.runnerOutput.stderrDigest,
    };
    const evidence = this.ledger.append({
      key: `action:${input.action.id}:verifier:${input.verifier?.id ?? "missing"}`,
      criterion: `Action ${input.action.id} reused a passed cache result under its exact input closure.`,
      outcome: "passed",
      validityKey: input.validityKey,
      actionId: input.action.id,
      verifierId: input.verifier?.id ?? "verifier:missing",
      toolchainDigest: this.context.toolchainDigest,
      dependencyDigest: this.context.dependencyDigest,
      environmentDigest: this.context.environmentDigest,
      inputDigests: [...input.inputDigests],
      effectDigests: [...input.effectDigests],
      outputDigest: input.runnerOutput.outputDigest,
      producer: { kind: "attestation", id: input.reusable.evidence.id, version: "local-cache/v1" },
      projectRevisionId: this.context.projectRevisionId,
      projectViewId: this.context.projectViewId,
      ...(this.context.changeRevisionId ? { changeRevisionId: this.context.changeRevisionId } : {}),
      runId,
      actor: { ...this.context.actor },
      runnerId: "runner:local-cache",
      policyVersion: this.context.policyVersion,
      authorizationEpoch: this.context.authorizationEpoch,
      capabilityGrantId: this.context.capabilityGrantId,
      disclosure: { ...input.effectiveDisclosure },
      receipt: `action=${input.action.id}; verifier=${input.verifier?.id ?? "missing"}; reuse=verified-cache; priorEvidence=${input.reusable.evidence.id}; reuseKey=${input.reuseKey}; inputs=${input.inputDigests.length}; outputs=${input.runnerOutput.outputDigests.length}`,
      invalidators: [
        "project-view",
        "action-contract",
        "verifier-contract",
        "dependency",
        "toolchain",
        "environment",
        "policy",
        "authorization-epoch",
        "target",
        "disclosure",
        "input-closure",
      ],
      owner: this.context.owner,
      sourceSpaceSnapshots: { ...this.context.sourceSpaceSnapshots },
      actionContractDigest: input.action.contractDigest,
      ...(input.verifier ? { verifierContractDigest: input.verifier.contractDigest } : {}),
      ...(this.context.targetId ? { targetId: this.context.targetId } : {}),
      ...(this.context.workspaceId ? { workspaceId: this.context.workspaceId } : {}),
    });
    const artifacts = input.reusable.artifacts.map((artifact) => ({
      ...cloneArtifact(artifact),
      id: opaqueId("artifact"),
      projectRevisionId: this.context.projectRevisionId,
      ...(this.context.changeRevisionId ? { changeRevisionId: this.context.changeRevisionId } : {}),
      runId,
      provenanceDigest: digest({ reuseKey: input.reuseKey, priorArtifactId: artifact.id, digest: artifact.digest }),
    }));
    const result: LocalActionResult = {
      ...cloneActionResult(input.reusable),
      run,
      evidence,
      artifacts,
      runnerInput: {
        ...input.runnerInput,
        inputDigests: [...input.inputDigests],
        effectDigests: [...input.effectDigests],
      },
      runnerOutput: {
        ...input.runnerOutput,
        inputDigests: [...input.inputDigests],
        outputDigests: [...input.runnerOutput.outputDigests],
      },
      cacheHit: true,
      stdout: "",
      stderr: "",
      validityKey: input.validityKey,
      reuseKey: input.reuseKey,
    };
    this.cache.set(result);
    return result;
  }

  async runAction(input: { actionId: string; verifierId?: string; cachePolicy?: "exact" | "reusable" | "none" }): Promise<LocalActionResult> {
    const action = this.manifest.actions.find((candidate) => candidate.id === input.actionId);
    if (!action) {
      fail({
        code: "action-not-found",
        message: `Action ${input.actionId} is not declared by the Project Manifest.`,
        affectedObject: input.actionId,
        recoveryAction: "select a declared Action or update the reviewed Project Manifest",
        receipt: `action=${input.actionId}; declared=false`,
      });
    }
    const verifier = input.verifierId
      ? this.manifest.verifiers.find((candidate) => candidate.id === input.verifierId)
      : this.manifest.verifiers.find((candidate) => candidate.actionId === action.id);
    if (input.verifierId && !verifier) {
      fail({
        code: "verifier-not-found",
        message: `Verifier ${input.verifierId} is not declared by the Project Manifest.`,
        affectedObject: input.verifierId,
        recoveryAction: "select a declared Verifier or update the reviewed Project Manifest",
        receipt: `verifier=${input.verifierId}; declared=false`,
      });
    }
    if (verifier && verifier.actionId !== action.id) {
      fail({
        code: "manifest-reference-invalid",
        message: `Verifier ${verifier.id} is not bound to Action ${action.id}.`,
        affectedObject: verifier.id,
        recoveryAction: "bind the Verifier to the Action being executed",
        receipt: `verifier=${verifier.id}; action=${action.id}; reference=mismatch`,
      });
    }

    const inputs = await inputFiles(this.context.directory, action.inputGlobs);
    const inputDigests = inputs.files.map((file) => `${file.path}=${file.digest}`);
    const effectDigests = (this.context.declaredEffects ?? []).map((effect) => digest(effect));
    const effectiveDisclosure: DisclosurePolicyRef = verifier?.disclosure === "result-only"
      ? { projectionId: this.context.disclosure.projectionId, classification: "restricted" }
      : { ...this.context.disclosure };
    const moduleArtifactTypes = this.manifest.artifactTypesByModule[action.moduleId] ?? [];
    const targetContractDigest = this.context.targetDeploymentProfileDigest
      ?? this.manifest.targets.find((target) => target.id === this.context.targetId)?.contractDigest;
    const validityKey = digest({
      projectRevisionId: this.context.projectRevisionId,
      projectViewId: this.context.projectViewId,
      changeRevisionId: this.context.changeRevisionId,
      workspaceId: this.context.workspaceId,
      sourceSpaceSnapshots: this.context.sourceSpaceSnapshots,
      actionContractDigest: action.contractDigest,
      verifierContractDigest: verifier?.contractDigest,
      dependencyDigest: this.context.dependencyDigest,
      toolchainDigest: this.context.toolchainDigest,
      environmentDigest: this.context.environmentDigest,
      policyVersion: this.context.policyVersion,
      authorizationEpoch: this.context.authorizationEpoch,
      targetId: this.context.targetId,
      disclosure: this.context.disclosure,
      effectiveDisclosure,
      moduleArtifactTypes,
      targetContractDigest,
      inputDigests,
      effectDigests,
    });
    const reuseKey = digest({
      actionContractDigest: action.contractDigest,
      verifierContractDigest: verifier?.contractDigest,
      dependencyDigest: this.context.dependencyDigest,
      toolchainDigest: this.context.toolchainDigest,
      environmentDigest: this.context.environmentDigest,
      policyVersion: this.context.policyVersion,
      authorizationEpoch: this.context.authorizationEpoch,
      targetId: this.context.targetId,
      disclosure: this.context.disclosure,
      effectiveDisclosure,
      moduleArtifactTypes,
      targetContractDigest,
      inputDigests,
      effectDigests,
    });
    const runnerInput: NormalizedActionInput = {
      action: {
        ...action,
        inputGlobs: [...action.inputGlobs],
        outputPaths: [...action.outputPaths],
        network: [...action.network],
        dependencyIds: [...action.dependencyIds],
        resources: { ...action.resources },
      },
      ...(verifier ? { verifier: { ...verifier, requiredFor: [...verifier.requiredFor] } } : {}),
      projectRevisionId: this.context.projectRevisionId,
      projectViewId: this.context.projectViewId,
      sourceSpaceSnapshots: { ...this.context.sourceSpaceSnapshots },
      ...(this.context.changeRevisionId ? { changeRevisionId: this.context.changeRevisionId } : {}),
      ...(this.context.workspaceId ? { workspaceId: this.context.workspaceId } : {}),
      inputDigests,
      effectDigests,
      dependencyDigest: this.context.dependencyDigest,
      toolchainDigest: this.context.toolchainDigest,
      environmentDigest: this.context.environmentDigest,
      policyVersion: this.context.policyVersion,
      authorizationEpoch: this.context.authorizationEpoch,
      ...(this.context.targetId ? { targetId: this.context.targetId } : {}),
      ...(this.context.targetDeploymentProfileDigest ? { targetDeploymentProfileDigest: this.context.targetDeploymentProfileDigest } : {}),
      disclosure: { ...effectiveDisclosure },
      actor: { ...this.context.actor },
      capabilityGrantId: this.context.capabilityGrantId,
      runnerId: this.context.runnerId,
    };
    const cachePolicy = input.cachePolicy ?? "exact";
    const cached = cachePolicy === "none" ? undefined : this.cache.get(validityKey);
    if (cached) {
      appendCachedEvidence(this.ledger, cached.evidence);
      return { ...cached, cacheHit: true };
    }
    if (cachePolicy === "reusable") {
      const reusable = this.cache.getReusable(reuseKey);
      if (reusable) return this.reuseActionResult({ reusable, action, verifier, runnerInput, runnerOutput: reusable.runnerOutput, inputDigests, effectDigests, effectiveDisclosure, validityKey, reuseKey });
    }

    const runId = opaqueId("run");
    let commandResult: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
    let outcome: "passed" | "failed" = "passed";
    let failureReceipt: string | undefined;
    if (inputs.missingPatterns.length > 0) {
      outcome = "failed";
      failureReceipt = `missing-input-patterns=${inputs.missingPatterns.join(",")}`;
    } else {
      commandResult = await executeCommand(this.context.directory, action.command);
      if (commandResult.exitCode !== 0) {
        outcome = "failed";
        failureReceipt = `exit-code=${commandResult.exitCode}`;
      }
    }
    const outputs = outcome === "passed" ? await outputFiles(this.context.directory, action.outputPaths) : { files: [], missingPaths: [] };
    if (outputs.missingPaths.length > 0) {
      outcome = "failed";
      failureReceipt = `missing-output-paths=${outputs.missingPaths.join(",")}`;
    }
    const outputDigests = outputs.files.map((file) => `${file.path}=${file.digest}`);
    const stdoutDigest = digest(commandResult.stdout);
    const stderrDigest = digest(commandResult.stderr);
    const outputDigest = digest({ outputDigests, stdoutDigest, stderrDigest, exitCode: commandResult.exitCode });
    const runnerOutput: NormalizedActionOutput = {
      status: outcome === "passed" ? "succeeded" : "failed",
      exitCode: commandResult.exitCode,
      inputDigests: [...inputDigests],
      outputDigests: [...outputDigests],
      outputDigest,
      stdoutDigest,
      stderrDigest,
    };
    const run: Run = {
      protocol: CONTRACT_VERSIONS.run,
      id: runId,
      actionId: action.id,
      projectRevisionId: this.context.projectRevisionId,
      projectViewId: this.context.projectViewId,
      runnerId: this.context.runnerId,
      status: outcome === "passed" ? "succeeded" : "failed",
      outputDigest,
      ...(this.context.changeRevisionId ? { changeRevisionId: this.context.changeRevisionId } : {}),
      ...(this.context.workspaceId ? { workspaceId: this.context.workspaceId } : {}),
      inputDigests,
      outputDigests,
      effectDigests,
      dependencyDigest: this.context.dependencyDigest,
      toolchainDigest: this.context.toolchainDigest,
      environmentDigest: this.context.environmentDigest,
      policyVersion: this.context.policyVersion,
      ...(this.context.targetId ? { targetId: this.context.targetId } : {}),
      actor: { ...this.context.actor },
      capabilityGrantId: this.context.capabilityGrantId,
      exitCode: commandResult.exitCode,
      stdoutDigest,
      stderrDigest,
    };
    const evidenceKey = `action:${action.id}:verifier:${verifier?.id ?? "missing"}`;
    const evidence = this.ledger.append({
      key: evidenceKey,
      criterion: `Action ${action.id} completed under Verifier ${verifier?.id ?? "missing"}.`,
      outcome,
      validityKey,
      actionId: action.id,
      verifierId: verifier?.id ?? "verifier:missing",
      toolchainDigest: this.context.toolchainDigest,
      dependencyDigest: this.context.dependencyDigest,
      environmentDigest: this.context.environmentDigest,
      inputDigests,
      effectDigests,
      outputDigest,
      producer: { kind: "run", id: run.id, version: "v1" },
      projectRevisionId: this.context.projectRevisionId,
      projectViewId: this.context.projectViewId,
      ...(this.context.changeRevisionId ? { changeRevisionId: this.context.changeRevisionId } : {}),
      runId: run.id,
      actor: { ...this.context.actor },
      runnerId: this.context.runnerId,
      policyVersion: this.context.policyVersion,
      authorizationEpoch: this.context.authorizationEpoch,
      capabilityGrantId: this.context.capabilityGrantId,
      disclosure: effectiveDisclosure,
      receipt: [
        `action=${action.id}`,
        `verifier=${verifier?.id ?? "missing"}`,
        `runner=${this.context.runnerId}`,
        `exit-code=${commandResult.exitCode}`,
        `inputs=${inputDigests.length}`,
        `outputs=${outputDigests.length}`,
        failureReceipt,
      ].filter((part): part is string => part !== undefined).join("; "),
      invalidators: [
        "project-revision",
        "project-view",
        "change-revision",
        "action-contract",
        "verifier-contract",
        "dependency",
        "toolchain",
        "environment",
        "policy",
        "authorization-epoch",
        "target",
        "disclosure",
      ],
      owner: this.context.owner,
      sourceSpaceSnapshots: { ...this.context.sourceSpaceSnapshots },
      actionContractDigest: action.contractDigest,
      ...(verifier ? { verifierContractDigest: verifier.contractDigest } : {}),
      ...(this.context.targetId ? { targetId: this.context.targetId } : {}),
      ...(this.context.workspaceId ? { workspaceId: this.context.workspaceId } : {}),
    });
    const artifacts: Artifact[] = outcome === "passed"
      ? outputs.files.map((file, index) => ({
        protocol: CONTRACT_VERSIONS.artifact,
        id: opaqueId("artifact"),
        type: moduleArtifactTypes[index] ?? moduleArtifactTypes[0] ?? "generic.output",
        digest: file.digest,
        projectRevisionId: this.context.projectRevisionId,
        ...(this.context.changeRevisionId ? { changeRevisionId: this.context.changeRevisionId } : {}),
        runId: run.id,
        actionId: action.id,
        outputPath: file.path,
        provenanceDigest: digest({ validityKey, path: file.path, digest: file.digest }),
        disclosure: { ...effectiveDisclosure },
      }))
      : [];
    const result: LocalActionResult = {
      run,
      evidence,
      artifacts,
      runnerInput,
      runnerOutput,
      cacheHit: false,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      validityKey,
      reuseKey,
    };
    this.cache.set(result);
    return cloneActionResult(result);
  }
}

export async function runLocalRelease(input: {
  manifest: unknown;
  context: LocalExecutionContext;
  releaseName: string;
  ledger?: EvidenceLedger;
  cache?: LocalExecutionCache;
  changedPaths?: readonly string[];
  stateAssumptions?: readonly string[];
}): Promise<LocalReleaseResult> {
  const manifest = normalizeProjectManifest(input.manifest);
  const ledger = input.ledger ?? new EvidenceLedger();
  const cache = input.cache ?? new LocalExecutionCache();
  const engine = new LocalExecutionEngine({ manifest, context: input.context, ledger, cache });
  const initialPlan = createLocalReleasePlan({ manifest, ...(input.changedPaths === undefined ? {} : { changedPaths: input.changedPaths }) });
  const results: LocalActionResult[] = [];
  const reusedActionIds = new Set<string>();
  const fallbackActionIds = new Set<string>();
  for (const action of manifest.actions) {
    const verifiers = manifest.verifiers.filter((verifier) => verifier.actionId === action.id);
    const selected = initialPlan.selectedActionIds.includes(action.id);
    const cachePolicy = selected ? "exact" : "reusable";
    let actionReused = true;
    if (verifiers.length === 0) {
      const result = await engine.runAction({ actionId: action.id, cachePolicy });
      results.push(result);
      actionReused = actionReused && result.cacheHit;
    } else {
      for (const verifier of verifiers) {
        const result = await engine.runAction({ actionId: action.id, verifierId: verifier.id, cachePolicy });
        results.push(result);
        actionReused = actionReused && result.cacheHit;
      }
    }
    if (actionReused) reusedActionIds.add(action.id);
    if (!selected && !actionReused) fallbackActionIds.add(action.id);
  }
  const plan = updateLocalReleasePlan(initialPlan, { reusedActionIds: [...reusedActionIds], fallbackActionIds: [...fallbackActionIds] });

  const requiredVerifiers = manifest.verifiers.filter((verifier) => verifier.requiredFor.includes("release"));
  const requiredEvidence: EvidenceRequirement[] = requiredVerifiers.map((verifier) => {
    const evidence = results.find((result) => result.evidence.key === `action:${verifier.actionId}:verifier:${verifier.id}`);
    const expectedDisclosureClassification = verifier.disclosure === "result-only"
      ? "restricted"
      : input.context.disclosure.classification;
    return {
      key: `action:${verifier.actionId}:verifier:${verifier.id}`,
      currentValidityKey: evidence?.validityKey ?? "missing",
      expectedProjectRevisionId: input.context.projectRevisionId,
      expectedProjectViewId: input.context.projectViewId,
      ...(input.context.changeRevisionId ? { expectedChangeRevisionId: input.context.changeRevisionId } : {}),
      ...(input.context.targetId ? { expectedTargetId: input.context.targetId } : {}),
      expectedDisclosureClassification,
    };
  });
  const gate = evaluateStageGate({
    gateId: `release:${input.releaseName}`,
    requiredEvidence,
    evidence: ledger.list(),
  });

  const artifactsByOutput = new Map<string, Artifact>();
  for (const artifact of results.flatMap((result) => result.artifacts)) {
    const identity = `${artifact.actionId ?? ""}:${artifact.outputPath ?? ""}:${artifact.digest}`;
    if (!artifactsByOutput.has(identity)) artifactsByOutput.set(identity, cloneArtifact(artifact));
  }
  const artifacts = [...artifactsByOutput.values()];
  const target = input.context.targetId ? manifest.targets.find((candidate) => candidate.id === input.context.targetId) : undefined;
  const releaseBlockers: string[] = [];
  if (input.context.targetId && !target) {
    releaseBlockers.push(`target=${input.context.targetId}; declared=false; fix=select a declared Target`);
  }
  if (target) {
    const unsupported = artifacts.filter((artifact) => !target.acceptedArtifactTypes.includes(artifact.type));
    if (unsupported.length > 0) {
      releaseBlockers.push(`target=${target.id}; accepted=${target.acceptedArtifactTypes.join(",")}; produced=${unsupported.map((artifact) => artifact.type).join(",")}; fix=declare a compatible Artifact type or Target`);
    }
  }
  const allBlockers = [...gate.blockers, ...releaseBlockers.map((message) => ({
    stageGate: gate.stageGate,
    evidenceKey: "target:artifact-compatibility",
    kind: "indeterminate" as const,
    message,
  }))];
  const inputSet = createReleaseInputSet({
    buildDefinitionDigest: manifest.digest,
    dependencyDigest: input.context.dependencyDigest,
    toolchainDigest: input.context.toolchainDigest,
    environmentDigest: input.context.environmentDigest,
    artifactDigests: artifacts.map((artifact) => artifact.digest),
  });
  const release: Release = {
    protocol: CONTRACT_VERSIONS.release,
    id: opaqueId("release"),
    projectRevisionId: input.context.projectRevisionId,
    artifactIds: artifacts.map((artifact) => artifact.id),
    evidenceIds: results.map((result) => result.evidence.id),
    configurationDigests: [manifest.digest],
    stateAssumptions: [...(input.stateAssumptions ?? [])],
    policyVersion: input.context.policyVersion,
    status: allBlockers.length === 0 ? "ready" : "draft",
    name: input.releaseName,
    ...(input.context.changeRevisionId ? { changeRevisionId: input.context.changeRevisionId } : {}),
    provenanceDigest: digest({
      manifest: manifest.digest,
      inputClosure: inputSet.inputClosureDigest,
      releasePlan: plan.receipt,
      projectRevisionId: input.context.projectRevisionId,
      projectViewId: input.context.projectViewId,
      changeRevisionId: input.context.changeRevisionId,
      artifacts: artifacts.map((artifact) => artifact.provenanceDigest ?? artifact.digest),
      evidence: results.map((result) => result.evidence.validityKey),
      policyVersion: input.context.policyVersion,
    }),
    inputSet,
    receipt: `release=${input.releaseName}; artifacts=${artifacts.length}; evidence=${results.length}; status=${allBlockers.length === 0 ? "ready" : "blocked"}; inputClosure=${inputSet.inputClosureDigest}; ${plan.receipt}`,
  };
  return {
    manifest,
    runs: results.map((result) => cloneRun(result.run)),
    evidence: ledger.list(),
    artifacts,
    release,
    gate: { ...gate, blockers: allBlockers },
    cacheHits: results.filter((result) => result.cacheHit).length,
    warnings: [...manifest.warnings, ...releaseBlockers, plan.receipt],
    plan,
  };
}

export function targetFromManifest(target: NormalizedTarget, projectId: string): Target {
  const targetValue: Target = {
    protocol: CONTRACT_VERSIONS.target,
    id: target.id,
    projectId,
    name: target.id,
    adapterId: target.adapterId,
    acceptedArtifactTypes: [...target.acceptedArtifactTypes],
    requiredEvidenceKeys: [],
    state: "configured",
  };
  return { ...targetValue, deploymentProfile: targetDeploymentProfile(targetValue) };
}
