import { createHash } from "node:crypto";

import type { Artifact } from "../kernel/contracts.ts";
import type { ImmutableRelease } from "../delivery/promotion.ts";

export const WORKER_RELEASE_MANIFEST_PROTOCOL = "anyam.worker-release-manifest/v1" as const;

export type WorkerReleaseModuleType = "es-module" | "commonjs" | "wasm" | "text" | "data";

export type WorkerReleaseModule = {
  name: string;
  type: WorkerReleaseModuleType;
  digest: string;
};

export type WorkerReleaseBinding = {
  name: string;
  kind: string;
  resourceIdentity?: string;
  configurationDigest?: string;
  secretUseAlias?: string;
  /** Provider-native non-secret fields such as namespace_id or service. */
  providerFields?: Readonly<Record<string, string>>;
};

export type WorkerReleaseStaticAssets = {
  manifestDigest: string;
  namespaceDigest: string;
  /** Exact Release Artifacts that the customer asset uploader must publish. */
  artifactDigests?: readonly string[];
  providerFields?: Readonly<Record<string, string>>;
};

export type WorkerReleaseDurableObjectMigrations = {
  fromTag?: string;
  toTag: string;
  stepsDigest: string;
  /** Provider-native Durable Object migration steps, when this Release carries them. */
  steps?: readonly Readonly<Record<string, unknown>>[];
};

export type WorkerReleaseManifest = {
  protocol: typeof WORKER_RELEASE_MANIFEST_PROTOCOL;
  mainModule: string;
  applicationArtifactDigest: string;
  modules: readonly WorkerReleaseModule[];
  staticAssets?: WorkerReleaseStaticAssets;
  compatibility: {
    date: string;
    flags: readonly string[];
  };
  bindings: readonly WorkerReleaseBinding[];
  durableObjectMigrations?: WorkerReleaseDurableObjectMigrations;
  healthContract: {
    paths: readonly string[];
    expectedReleaseIdentity: string;
  };
  digest: string;
};

export type CloudflareWorkerVersionResources = {
  bindings?: readonly Readonly<Record<string, unknown>>[];
  script?: Readonly<Record<string, unknown>> & {
    main_module?: string;
    modules?: readonly Readonly<Record<string, unknown>>[];
  };
  script_runtime?: {
    compatibility_date?: string;
    compatibility_flags?: readonly string[];
    migration_tag?: string;
  };
  assets?: Readonly<Record<string, unknown>>;
  durable_object_migrations?: Readonly<Record<string, unknown>>;
};

export type CloudflareWorkerVersionReadback = {
  id: string;
  annotations?: {
    "workers/tag"?: string;
    "workers/message"?: string;
  };
  metadata?: {
    annotations?: {
      "workers/tag"?: string;
      "workers/message"?: string;
    };
  };
  resources?: CloudflareWorkerVersionResources;
};

export class WorkerReleaseManifestError extends Error {
  readonly code: "invalid" | "artifact-missing" | "readback-missing" | "readback-mismatch";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    code: WorkerReleaseManifestError["code"];
    message: string;
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "WorkerReleaseManifestError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stable(nested)]));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function moduleContentDigest(value: Readonly<Record<string, unknown>>): string | undefined {
  const encoded = value.content_base64;
  if (typeof encoded !== "string") return undefined;
  try {
    const binary = atob(encoded);
    return digestBytes(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: "Cloudflare returned invalid base64 Worker module content.", recoveryAction: "inspect the exact provider version detail and retry only after the provider returns valid module content", receipt: "readback=invalid; moduleContent=base64-invalid; providerMutation=false" });
  }
}

function manifestWithoutDigest(manifest: Omit<WorkerReleaseManifest, "digest">): unknown {
  return {
    protocol: manifest.protocol,
    mainModule: manifest.mainModule,
    applicationArtifactDigest: manifest.applicationArtifactDigest,
    modules: manifest.modules,
    ...(manifest.staticAssets ? { staticAssets: manifest.staticAssets } : {}),
    compatibility: manifest.compatibility,
    bindings: manifest.bindings,
    ...(manifest.durableObjectMigrations ? { durableObjectMigrations: manifest.durableObjectMigrations } : {}),
    healthContract: manifest.healthContract,
  };
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new WorkerReleaseManifestError({ code: "invalid", message: `${field} is required in a Worker Release Manifest.`, recoveryAction: `provide a non-empty ${field} and retry before provider upload`, receipt: `field=${field}; manifest=invalid; providerMutation=false` });
  return value.trim();
}

function digestString(value: string, field: string): string {
  const normalized = required(value, field);
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) throw new WorkerReleaseManifestError({ code: "invalid", message: `${field} must be a sha256 digest.`, recoveryAction: `record a content digest for ${field} before provider upload`, receipt: `field=${field}; digest=invalid; manifest=invalid; providerMutation=false` });
  return normalized;
}

function validateProviderFields(fields: Readonly<Record<string, string>> | undefined, field: string): void {
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!key.trim() || !value.trim() || /(?:token|secret|password|credential|jwt|private[_-]?key)/iu.test(key)) {
      throw new WorkerReleaseManifestError({ code: "invalid", message: `${field} contains credential-shaped provider metadata.`, recoveryAction: "record only non-secret provider resource identities and configuration fields in the Worker Release Manifest", receipt: `field=${field}; providerField=${key}; credentialMaterialStored=false; manifest=invalid; providerMutation=false` });
    }
  }
}

function moduleTypeForArtifact(artifact: Artifact): WorkerReleaseModuleType {
  switch (artifact.type) {
    case "worker.bundle":
    case "worker.module":
      return "es-module";
    case "worker.commonjs":
      return "commonjs";
    case "worker.wasm":
      return "wasm";
    case "worker.text":
      return "text";
    case "worker.data":
      return "data";
    default:
      throw new WorkerReleaseManifestError({ code: "invalid", message: `Artifact ${artifact.id} type ${artifact.type} cannot be represented as a Worker module.`, recoveryAction: "declare a supported Worker module Artifact type or exclude non-Worker Artifacts from the Worker Release Manifest", receipt: `artifact=${artifact.id}; artifactType=${artifact.type}; manifest=invalid; providerMutation=false` });
  }
}

function moduleNameForArtifact(artifact: Artifact): string {
  const outputPath = required(artifact.outputPath ?? "", `artifact ${artifact.id}.outputPath`).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (outputPath.startsWith("/") || outputPath.split("/").some((segment) => segment === ".." || segment.toLocaleLowerCase() === ".git")) {
    throw new WorkerReleaseManifestError({ code: "invalid", message: `Artifact ${artifact.id} has an unsafe Worker module path.`, recoveryAction: "publish a workspace-relative Worker module path outside Git metadata", receipt: `artifact=${artifact.id}; outputPath=${outputPath}; manifest=invalid; providerMutation=false` });
  }
  return outputPath;
}

export function createCloudflareWorkerReleaseManifest(input: {
  release: ImmutableRelease;
  compatibilityDate: string;
  compatibilityFlags?: readonly string[];
  bindings?: readonly WorkerReleaseBinding[];
  staticAssets?: WorkerReleaseStaticAssets;
  staticAssetArtifactIds?: readonly string[];
  /** Migration Artifacts executed by an external data provider (for example D1). */
  externalMigrationArtifactIds?: readonly string[];
  durableObjectMigrations?: WorkerReleaseDurableObjectMigrations;
  healthPaths?: readonly string[];
}): WorkerReleaseManifest {
  const staticAssetIds = new Set(input.staticAssetArtifactIds ?? []);
  const migrationArtifactIds = new Set(input.release.release.migrationPlan?.migrationArtifactIds ?? []);
  const externalMigrationArtifactIds = new Set(input.externalMigrationArtifactIds ?? []);
  if ([...externalMigrationArtifactIds].some((artifactId) => !migrationArtifactIds.has(artifactId))) throw new WorkerReleaseManifestError({ code: "invalid", message: `Release ${input.release.release.id} contains an external migration Artifact that is not declared by its Migration Plan.`, recoveryAction: "declare every externally executed migration Artifact in the Release Migration Plan before provider upload", receipt: `release=${input.release.release.id}; externalMigrationArtifacts=undeclared; manifest=invalid; providerMutation=false` });
  const artifacts = input.release.artifacts.filter((artifact) => !staticAssetIds.has(artifact.id) && !migrationArtifactIds.has(artifact.id));
  const staticAssetArtifacts = input.release.artifacts.filter((artifact) => staticAssetIds.has(artifact.id));
  const allMigrationArtifacts = input.release.artifacts.filter((artifact) => migrationArtifactIds.has(artifact.id));
  const migrationArtifacts = allMigrationArtifacts.filter((artifact) => !externalMigrationArtifactIds.has(artifact.id));
  if (staticAssetIds.size !== staticAssetArtifacts.length) throw new WorkerReleaseManifestError({ code: "artifact-missing", message: `Release ${input.release.release.id} does not contain every declared static asset Artifact.`, recoveryAction: "declare only exact static asset Artifact IDs from the sealed Release before provider upload", receipt: `release=${input.release.release.id}; staticAssetArtifacts=${staticAssetIds.size}; found=${staticAssetArtifacts.length}; manifest=invalid; providerMutation=false` });
  if (migrationArtifactIds.size !== allMigrationArtifacts.length) throw new WorkerReleaseManifestError({ code: "artifact-missing", message: `Release ${input.release.release.id} does not contain every declared migration Artifact.`, recoveryAction: "attach every migration Artifact named by the sealed Release migration plan before provider upload", receipt: `release=${input.release.release.id}; migrationArtifacts=${migrationArtifactIds.size}; found=${allMigrationArtifacts.length}; manifest=invalid; providerMutation=false` });
  if (migrationArtifacts.length > 0 && !input.durableObjectMigrations) throw new WorkerReleaseManifestError({ code: "invalid", message: `Release ${input.release.release.id} declares migration Artifacts without Durable Object migration metadata.`, recoveryAction: "bind the migration Artifact digest to explicit Durable Object migration metadata before provider upload", receipt: `release=${input.release.release.id}; migrationArtifacts=${migrationArtifacts.length}; migrations=configuration-missing; manifest=invalid; providerMutation=false` });
  if (migrationArtifacts.length > 0 && input.durableObjectMigrations) {
    const expectedStepsDigest = migrationArtifacts.length === 1
      ? digestString(migrationArtifacts[0]?.digest ?? "", "migration Artifact digest")
      : digest({ artifactDigests: migrationArtifacts.map((artifact) => digestString(artifact.digest, `artifact ${artifact.id}.digest`)) });
    if (input.durableObjectMigrations.stepsDigest !== expectedStepsDigest) throw new WorkerReleaseManifestError({ code: "invalid", message: `Release ${input.release.release.id} migration metadata does not match its migration Artifact closure.`, recoveryAction: "set stepsDigest to the exact migration Artifact digest closure before provider upload", receipt: `release=${input.release.release.id}; expectedStepsDigest=${expectedStepsDigest}; observedStepsDigest=${input.durableObjectMigrations.stepsDigest}; manifest=invalid; providerMutation=false` });
  }
  if (input.durableObjectMigrations?.steps !== undefined) {
    const expectedProviderStepsDigest = digest(input.durableObjectMigrations.steps);
    if (input.durableObjectMigrations.stepsDigest !== expectedProviderStepsDigest) throw new WorkerReleaseManifestError({ code: "invalid", message: `Release ${input.release.release.id} Durable Object migration steps do not match their digest.`, recoveryAction: "set stepsDigest to the canonical digest of the provider migration steps before upload", receipt: `release=${input.release.release.id}; expectedStepsDigest=${expectedProviderStepsDigest}; observedStepsDigest=${input.durableObjectMigrations.stepsDigest}; manifest=invalid; providerMutation=false` });
  }
  if (staticAssetArtifacts.length > 0 && !input.staticAssets) throw new WorkerReleaseManifestError({ code: "invalid", message: `Release ${input.release.release.id} declares static asset Artifacts without static asset configuration.`, recoveryAction: "provide staticAssets metadata and a customer-owned asset uploader for the exact static asset Artifacts", receipt: `release=${input.release.release.id}; staticAssets=configuration-missing; manifest=invalid; providerMutation=false` });
  if (artifacts.length === 0) throw new WorkerReleaseManifestError({ code: "invalid", message: `Release ${input.release.release.id} has no Worker Artifacts.`, recoveryAction: "attach at least one verified Worker module Artifact before provider upload", receipt: `release=${input.release.release.id}; modules=0; manifest=invalid; providerMutation=false` });
  const modules = artifacts.map((artifact) => ({ name: moduleNameForArtifact(artifact), type: moduleTypeForArtifact(artifact), digest: digestString(artifact.digest, `artifact ${artifact.id}.digest`) }));
  if (new Set(modules.map((module) => module.name)).size !== modules.length) throw new WorkerReleaseManifestError({ code: "invalid", message: `Release ${input.release.release.id} contains duplicate Worker module names.`, recoveryAction: "give every uploaded Worker module a unique output path", receipt: `release=${input.release.release.id}; modules=${modules.length}; uniqueModules=${new Set(modules.map((module) => module.name)).size}; manifest=invalid; providerMutation=false` });
  const mainModule = modules[0]?.name;
  if (!mainModule) throw new WorkerReleaseManifestError({ code: "invalid", message: `Release ${input.release.release.id} has no main Worker module.`, recoveryAction: "attach a main Worker module Artifact before provider upload", receipt: `release=${input.release.release.id}; mainModule=missing; manifest=invalid; providerMutation=false` });
  for (const binding of input.bindings ?? []) validateProviderFields(binding.providerFields, `binding ${binding.name}.providerFields`);
  validateProviderFields(input.staticAssets?.providerFields, "staticAssets.providerFields");
  const withoutDigest: Omit<WorkerReleaseManifest, "digest"> = {
    protocol: WORKER_RELEASE_MANIFEST_PROTOCOL,
    mainModule,
    applicationArtifactDigest: digest({ projectRevisionId: input.release.release.projectRevisionId, artifactDigests: modules.map((module) => module.digest) }),
    modules,
    ...(input.staticAssets ? { staticAssets: { ...input.staticAssets, ...(staticAssetArtifacts.length > 0 ? { artifactDigests: staticAssetArtifacts.map((artifact) => digestString(artifact.digest, `artifact ${artifact.id}.digest`)) } : {}) } } : {}),
    compatibility: { date: required(input.compatibilityDate, "compatibilityDate"), flags: [...(input.compatibilityFlags ?? [])].map((flag) => required(flag, "compatibilityFlag")) },
    bindings: [...(input.bindings ?? [])],
    ...(input.durableObjectMigrations ? { durableObjectMigrations: input.durableObjectMigrations } : {}),
    healthContract: { paths: [...(input.healthPaths ?? ["/health"])].map((path) => required(path, "healthPath")), expectedReleaseIdentity: input.release.release.id },
  };
  return { ...withoutDigest, digest: digest(manifestWithoutDigest(withoutDigest)) };
}

export type WorkerReleaseManifestUploadMetadataOptions = {
  /** Script uploads may apply Durable Object migrations; version uploads may not. */
  includeDurableObjectMigrations?: boolean;
  /** A migration preflight deliberately deploys code without attaching assets. */
  includeStaticAssets?: boolean;
};

export function workerReleaseManifestUploadMetadata(manifest: WorkerReleaseManifest, releaseId: string, tag: string, assetsJwt?: string, options: WorkerReleaseManifestUploadMetadataOptions = {}): Record<string, unknown> {
  const includeDurableObjectMigrations = options.includeDurableObjectMigrations !== false;
  const includeStaticAssets = options.includeStaticAssets !== false;
  return {
    main_module: manifest.mainModule,
    compatibility_date: manifest.compatibility.date,
    compatibility_flags: [...manifest.compatibility.flags],
    bindings: manifest.bindings.map((binding) => ({ name: binding.name, type: binding.kind, ...(binding.providerFields ?? {}) })),
    ...(includeStaticAssets && manifest.staticAssets ? { assets: { ...(manifest.staticAssets.providerFields ?? {}), ...(assetsJwt ? { jwt: assetsJwt } : {}) } } : {}),
    ...(includeDurableObjectMigrations && manifest.durableObjectMigrations ? {
      migrations: {
        ...(manifest.durableObjectMigrations.fromTag === undefined ? {} : { old_tag: manifest.durableObjectMigrations.fromTag }),
        new_tag: manifest.durableObjectMigrations.toTag,
        ...(manifest.durableObjectMigrations.steps === undefined ? {} : { steps: manifest.durableObjectMigrations.steps }),
      },
    } : {}),
    annotations: {
      "workers/message": `Anyam Release ${releaseId}; manifest=${manifest.digest}`,
      "workers/tag": tag,
    },
  };
}

export function workerReleaseModuleContentType(type: WorkerReleaseModuleType): string {
  switch (type) {
    case "es-module": return "application/javascript+module";
    case "commonjs": return "application/javascript";
    case "wasm": return "application/wasm";
    case "text": return "text/plain";
    case "data": return "application/octet-stream";
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

function providerFieldMatches(expected: WorkerReleaseBinding, observed: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(expected.providerFields ?? {}).every(([key, value]) => observed[key] === value);
}

function providerFieldsMatch(expected: Readonly<Record<string, string>> | undefined, observed: Readonly<Record<string, unknown>> | undefined): boolean {
  if (!observed) return false;
  return Object.entries(expected ?? {}).every(([key, value]) => observed[key] === value);
}

export function assertCloudflareWorkerVersionReadback(input: { manifest: WorkerReleaseManifest; version: CloudflareWorkerVersionReadback }): string {
  const { manifest, version } = input;
  const message = version.metadata?.annotations?.["workers/message"] ?? version.annotations?.["workers/message"] ?? "";
  if (!message.includes(`manifest=${manifest.digest}`)) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} did not read back the expected Worker Release Manifest digest.`, recoveryAction: "inspect the exact provider version detail and publish a new immutable Release only after its manifest digest matches", receipt: `providerVersionId=${version.id}; expectedManifestDigest=${manifest.digest}; observedManifestDigest=missing-or-mismatch; readback=blocked; providerMutation=false` });
  const resources = version.resources;
  if (!resources?.script_runtime) throw new WorkerReleaseManifestError({ code: "readback-missing", message: `Cloudflare version ${version.id} did not return script runtime configuration for read-back.`, recoveryAction: "use the version-detail API that returns runtime configuration before treating the Worker version as deployable", receipt: `providerVersionId=${version.id}; readback=missing; field=script_runtime; providerMutation=false` });
  if (resources.script_runtime.compatibility_date !== manifest.compatibility.date || JSON.stringify([...(resources.script_runtime.compatibility_flags ?? [])].sort()) !== JSON.stringify([...manifest.compatibility.flags].sort())) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} runtime configuration does not match the Worker Release Manifest.`, recoveryAction: "reconcile compatibility date and flags with the immutable Release before deployment", receipt: `providerVersionId=${version.id}; expectedCompatibilityDate=${manifest.compatibility.date}; observedCompatibilityDate=${resources.script_runtime.compatibility_date ?? "missing"}; readback=blocked; providerMutation=false` });
  const observedBindings = resources.bindings ?? [];
  const observedModules = resources.script?.modules;
  if (!observedModules) throw new WorkerReleaseManifestError({ code: "readback-missing", message: `Cloudflare version ${version.id} did not return Worker modules for read-back.`, recoveryAction: "request version detail with module inclusion before treating the Worker version as deployable", receipt: `providerVersionId=${version.id}; readback=missing; field=script.modules; readback=blocked; providerMutation=false` });
  if (resources.script?.main_module !== manifest.mainModule) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} main module does not match the Worker Release Manifest.`, recoveryAction: "reconcile the provider main module with the immutable Release before deployment", receipt: `providerVersionId=${version.id}; expectedMainModule=${manifest.mainModule}; observedMainModule=${resources.script?.main_module ?? "missing"}; readback=blocked; providerMutation=false` });
  const moduleNames = observedModules.map((module) => typeof module.name === "string" ? module.name : "").sort();
  const expectedNames = manifest.modules.map((module) => module.name).sort();
  if (JSON.stringify(moduleNames) !== JSON.stringify(expectedNames)) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} modules do not match the Worker Release Manifest.`, recoveryAction: "reconcile the provider module set with the immutable Release before deployment", receipt: `providerVersionId=${version.id}; expectedModules=${expectedNames.join(",")}; observedModules=${moduleNames.join(",")}; readback=blocked; providerMutation=false` });
  for (const expected of manifest.modules) {
    const observed = observedModules.find((module) => module.name === expected.name);
    if (!observed) continue;
    const observedDigest = moduleContentDigest(observed);
    if (observedDigest !== undefined && observedDigest !== expected.digest) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} module ${expected.name} content does not match the Worker Release Manifest.`, recoveryAction: "reconcile the provider module bytes with the immutable Release before deployment", receipt: `providerVersionId=${version.id}; module=${expected.name}; expectedDigest=${expected.digest}; observedDigest=${observedDigest}; readback=blocked; providerMutation=false` });
  }
  for (const expected of manifest.bindings) {
    const observed = observedBindings.find((binding) => binding.name === expected.name && binding.type === expected.kind);
    if (!observed || !providerFieldMatches(expected, observed)) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} binding ${expected.name} does not match the Worker Release Manifest.`, recoveryAction: "reconcile Worker bindings and resource identities with the immutable Release before deployment", receipt: `providerVersionId=${version.id}; binding=${expected.name}; expectedKind=${expected.kind}; readback=blocked; providerMutation=false` });
  }
  if (manifest.staticAssets) {
    if (!resources.assets) throw new WorkerReleaseManifestError({ code: "readback-missing", message: `Cloudflare version ${version.id} did not return static asset configuration for read-back.`, recoveryAction: "use the version-detail API that returns the asset configuration before treating the Worker version as deployable", receipt: `providerVersionId=${version.id}; readback=missing; field=assets; providerMutation=false` });
    if (!providerFieldsMatch(manifest.staticAssets.providerFields, resources.assets)) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} static asset configuration does not match the Worker Release Manifest.`, recoveryAction: "reconcile the provider static asset configuration with the immutable Release before deployment", receipt: `providerVersionId=${version.id}; readback=mismatch; field=assets; providerMutation=false` });
  }
  if (manifest.durableObjectMigrations) {
    const migrations = resources.durable_object_migrations;
    const observedRuntimeTag = resources.script_runtime.migration_tag;
    if (!migrations && observedRuntimeTag !== manifest.durableObjectMigrations.toTag) throw new WorkerReleaseManifestError({ code: "readback-missing", message: `Cloudflare version ${version.id} did not return the applied Durable Object migration tag for read-back.`, recoveryAction: "apply the Durable Object migration through a non-versioned deployment and read back its migration tag before treating the Worker version as deployable", receipt: `providerVersionId=${version.id}; expectedMigrationTag=${manifest.durableObjectMigrations.toTag}; observedMigrationTag=${observedRuntimeTag ?? "missing"}; readback=missing; field=script_runtime.migration_tag; providerMutation=false` });
    if (migrations) {
      const observedOldTag = migrations.old_tag ?? migrations.fromTag;
      const observedNewTag = migrations.new_tag ?? migrations.toTag;
      if ((manifest.durableObjectMigrations.fromTag !== undefined && observedOldTag !== manifest.durableObjectMigrations.fromTag) || observedNewTag !== manifest.durableObjectMigrations.toTag) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} Durable Object migration tags do not match the Worker Release Manifest.`, recoveryAction: "reconcile old and new Durable Object migration tags with the immutable Release before deployment", receipt: `providerVersionId=${version.id}; expectedOldTag=${manifest.durableObjectMigrations.fromTag ?? "none"}; observedOldTag=${String(observedOldTag ?? "missing")}; expectedNewTag=${manifest.durableObjectMigrations.toTag}; observedNewTag=${String(observedNewTag ?? "missing")}; readback=blocked; providerMutation=false` });
      if (manifest.durableObjectMigrations.steps !== undefined) {
        if (!Array.isArray(migrations.steps)) throw new WorkerReleaseManifestError({ code: "readback-missing", message: `Cloudflare version ${version.id} did not return Durable Object migration steps for read-back.`, recoveryAction: "request the exact Worker version detail with migration steps before deployment", receipt: `providerVersionId=${version.id}; readback=missing; field=durable_object_migrations.steps; providerMutation=false` });
        const observedStepsDigest = digest(migrations.steps);
        if (observedStepsDigest !== manifest.durableObjectMigrations.stepsDigest) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} Durable Object migration steps do not match the Worker Release Manifest.`, recoveryAction: "reconcile the provider migration steps with the immutable Release before deployment", receipt: `providerVersionId=${version.id}; expectedStepsDigest=${manifest.durableObjectMigrations.stepsDigest}; observedStepsDigest=${observedStepsDigest}; readback=blocked; providerMutation=false` });
      }
    }
  }
  return `providerVersionId=${version.id}; manifestDigest=${manifest.digest}; modules=${manifest.modules.length}; bindings=${manifest.bindings.length}; runtime=verified; readback=verified; providerMutation=false`;
}
