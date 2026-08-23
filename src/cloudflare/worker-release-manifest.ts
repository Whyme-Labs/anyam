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
    modules?: readonly Readonly<Record<string, unknown>>[];
  };
  script_runtime?: {
    compatibility_date?: string;
    compatibility_flags?: readonly string[];
  };
  assets?: Readonly<Record<string, unknown>>;
  durable_object_migrations?: Readonly<Record<string, unknown>>;
};

export type CloudflareWorkerVersionReadback = {
  id: string;
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
  durableObjectMigrations?: WorkerReleaseDurableObjectMigrations;
  healthPaths?: readonly string[];
}): WorkerReleaseManifest {
  const staticAssetIds = new Set(input.staticAssetArtifactIds ?? []);
  const artifacts = input.release.artifacts.filter((artifact) => !staticAssetIds.has(artifact.id));
  const staticAssetArtifacts = input.release.artifacts.filter((artifact) => staticAssetIds.has(artifact.id));
  if (staticAssetIds.size !== staticAssetArtifacts.length) throw new WorkerReleaseManifestError({ code: "artifact-missing", message: `Release ${input.release.release.id} does not contain every declared static asset Artifact.`, recoveryAction: "declare only exact static asset Artifact IDs from the sealed Release before provider upload", receipt: `release=${input.release.release.id}; staticAssetArtifacts=${staticAssetIds.size}; found=${staticAssetArtifacts.length}; manifest=invalid; providerMutation=false` });
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

export function workerReleaseManifestUploadMetadata(manifest: WorkerReleaseManifest, releaseId: string, tag: string, assetsJwt?: string): Record<string, unknown> {
  return {
    main_module: manifest.mainModule,
    compatibility_date: manifest.compatibility.date,
    compatibility_flags: [...manifest.compatibility.flags],
    bindings: manifest.bindings.map((binding) => ({ name: binding.name, type: binding.kind, ...(binding.providerFields ?? {}) })),
    ...(manifest.staticAssets ? { assets: { ...(manifest.staticAssets.providerFields ?? {}), ...(assetsJwt ? { jwt: assetsJwt } : {}) } } : {}),
    ...(manifest.durableObjectMigrations ? { migrations: manifest.durableObjectMigrations } : {}),
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

export function assertCloudflareWorkerVersionReadback(input: { manifest: WorkerReleaseManifest; version: CloudflareWorkerVersionReadback }): string {
  const { manifest, version } = input;
  const message = version.metadata?.annotations?.["workers/message"] ?? "";
  if (!message.includes(`manifest=${manifest.digest}`)) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} did not read back the expected Worker Release Manifest digest.`, recoveryAction: "inspect the exact provider version detail and publish a new immutable Release only after its manifest digest matches", receipt: `providerVersionId=${version.id}; expectedManifestDigest=${manifest.digest}; observedManifestDigest=missing-or-mismatch; readback=blocked; providerMutation=false` });
  const resources = version.resources;
  if (!resources?.script_runtime) throw new WorkerReleaseManifestError({ code: "readback-missing", message: `Cloudflare version ${version.id} did not return script runtime configuration for read-back.`, recoveryAction: "use the version-detail API that returns runtime configuration before treating the Worker version as deployable", receipt: `providerVersionId=${version.id}; readback=missing; field=script_runtime; providerMutation=false` });
  if (resources.script_runtime.compatibility_date !== manifest.compatibility.date || JSON.stringify([...(resources.script_runtime.compatibility_flags ?? [])].sort()) !== JSON.stringify([...manifest.compatibility.flags].sort())) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} runtime configuration does not match the Worker Release Manifest.`, recoveryAction: "reconcile compatibility date and flags with the immutable Release before deployment", receipt: `providerVersionId=${version.id}; expectedCompatibilityDate=${manifest.compatibility.date}; observedCompatibilityDate=${resources.script_runtime.compatibility_date ?? "missing"}; readback=blocked; providerMutation=false` });
  const observedBindings = resources.bindings ?? [];
  const observedModules = resources.script?.modules;
  if (observedModules) {
    const moduleNames = observedModules.map((module) => typeof module.name === "string" ? module.name : "").sort();
    const expectedNames = manifest.modules.map((module) => module.name).sort();
    if (JSON.stringify(moduleNames) !== JSON.stringify(expectedNames)) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} modules do not match the Worker Release Manifest.`, recoveryAction: "reconcile the provider module set with the immutable Release before deployment", receipt: `providerVersionId=${version.id}; expectedModules=${expectedNames.join(",")}; observedModules=${moduleNames.join(",")}; readback=blocked; providerMutation=false` });
  }
  for (const expected of manifest.bindings) {
    const observed = observedBindings.find((binding) => binding.name === expected.name && binding.type === expected.kind);
    if (!observed || !providerFieldMatches(expected, observed)) throw new WorkerReleaseManifestError({ code: "readback-mismatch", message: `Cloudflare version ${version.id} binding ${expected.name} does not match the Worker Release Manifest.`, recoveryAction: "reconcile Worker bindings and resource identities with the immutable Release before deployment", receipt: `providerVersionId=${version.id}; binding=${expected.name}; expectedKind=${expected.kind}; readback=blocked; providerMutation=false` });
  }
  if (manifest.staticAssets && !resources.assets) throw new WorkerReleaseManifestError({ code: "readback-missing", message: `Cloudflare version ${version.id} did not return static asset configuration for read-back.`, recoveryAction: "use the version-detail API that returns the asset namespace before treating the Worker version as deployable", receipt: `providerVersionId=${version.id}; readback=missing; field=assets; providerMutation=false` });
  if (manifest.durableObjectMigrations && !resources.durable_object_migrations) throw new WorkerReleaseManifestError({ code: "readback-missing", message: `Cloudflare version ${version.id} did not return Durable Object migration configuration for read-back.`, recoveryAction: "reconcile Durable Object migration state before treating the Worker version as deployable", receipt: `providerVersionId=${version.id}; readback=missing; field=durable_object_migrations; providerMutation=false` });
  return `providerVersionId=${version.id}; manifestDigest=${manifest.digest}; modules=${manifest.modules.length}; bindings=${manifest.bindings.length}; runtime=verified; readback=verified; providerMutation=false`;
}
