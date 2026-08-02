/**
 * THROWAWAY LOGIC PROTOTYPE — not production Anyam code.
 *
 * Question: can one small, portable Project manifest describe zero-config
 * detection and explicit overrides for a Cloudflare Worker and a Rust CLI,
 * while keeping local/remote Actions, Verifiers, Artifacts, and Targets on
 * the same contract?
 */

export type ReferenceProject = "cloudflare-worker" | "rust-cli";
export type ExecutionMode = "local" | "remote";

export interface Action {
  name: string;
  command: string;
  inputs: string[];
  outputs: string[];
  network: string[];
  resources: { cpu: string; memory: string };
}

export interface Module {
  name: string;
  root: string;
  dependsOn: string[];
  actions: Action[];
  artifacts: string[];
}

export interface Verifier {
  name: string;
  action: string;
  disclosure: "full" | "result-only";
  requiredFor: string[];
}

export interface Target {
  name: string;
  adapter: string;
  accepts: string[];
  requires: string[];
}

export interface ProjectManifest {
  schema: "anyam.project/v1";
  project: { name: string; reference: ReferenceProject };
  source: { detectedFrom: string[]; explicitConfig: boolean };
  modules: Module[];
  verifiers: Verifier[];
  targets: Target[];
}

export interface LegacyManifest {
  schema: "anyam.project/v0";
  name: string;
  modules: Array<{ name: string; root: string; checks?: string[] }>;
  deploy?: { adapter: string; artifact: string };
}

export interface ActionPlan {
  mode: ExecutionMode;
  module: string;
  action: string;
  command: string;
  inputs: string[];
  outputs: string[];
  network: string[];
  resources: { cpu: string; memory: string };
  contractDigest: string;
}

export interface DemoState {
  reference: ReferenceProject;
  manifest: ProjectManifest;
  lastAction: string;
  actionPlan: ActionPlan | null;
  verifierResult: string | null;
  targetPlan: string | null;
  warnings: string[];
}

const workerAction = (name: string, command: string, inputs: string[], outputs: string[], network: string[] = []): Action => ({
  name,
  command,
  inputs,
  outputs,
  network,
  resources: { cpu: "detected", memory: "detected" },
});

const rustAction = (name: string, command: string, inputs: string[], outputs: string[]): Action => ({
  name,
  command,
  inputs,
  outputs,
  network: [],
  resources: { cpu: "detected", memory: "detected" },
});

export function detectProject(reference: ReferenceProject): ProjectManifest {
  if (reference === "cloudflare-worker") {
    return {
      schema: "anyam.project/v1",
      project: { name: "edge-player", reference },
      source: { detectedFrom: ["package.json", "wrangler.jsonc", "src/index.ts"], explicitConfig: false },
      modules: [{
        name: "worker",
        root: ".",
        dependsOn: [],
        actions: [
          workerAction("check", "npm test", ["src/**", "test/**", "package-lock.json"], ["reports/junit.xml"]),
          workerAction("build", "npx wrangler deploy --dry-run", ["src/**", "wrangler.jsonc", "package-lock.json"], ["dist/worker.js"], ["registry.npmjs.org"]),
        ],
        artifacts: ["cloudflare.worker-bundle"],
      }],
      verifiers: [{ name: "public-contract", action: "worker.check", disclosure: "full", requiredFor: ["cloudflare.preview"] }],
      targets: [{ name: "preview", adapter: "cloudflare.worker", accepts: ["cloudflare.worker-bundle"], requires: ["health-check"] }],
    };
  }

  return {
    schema: "anyam.project/v1",
    project: { name: "atlas-cli", reference },
    source: { detectedFrom: ["Cargo.toml", "Cargo.lock", "src/main.rs"], explicitConfig: false },
    modules: [{
      name: "cli",
      root: ".",
      dependsOn: [],
      actions: [
        rustAction("check", "cargo test --locked", ["src/**", "tests/**", "Cargo.lock"], ["reports/junit.xml"]),
        rustAction("build", "cargo build --release --locked", ["src/**", "Cargo.lock"], ["target/release/atlas"]),
      ],
      artifacts: ["executable", "release-archive"],
    }],
    verifiers: [{ name: "cli-smoke", action: "cli.check", disclosure: "full", requiredFor: ["release-downloads"] }],
    targets: [{ name: "release-downloads", adapter: "generic.release-assets", accepts: ["executable", "release-archive"], requires: ["signature"] }],
  };
}

export function applyExplicitConfig(manifest: ProjectManifest): ProjectManifest {
  if (manifest.project.reference === "cloudflare-worker") {
    return {
      ...manifest,
      source: { ...manifest.source, explicitConfig: true },
      modules: manifest.modules.map((module) => ({
        ...module,
        actions: module.actions.map((action) => action.name === "build"
          ? { ...action, command: "npx wrangler deploy --dry-run", network: ["registry.npmjs.org", "api.cloudflare.com"], resources: { cpu: "1", memory: "512MiB" } }
          : action),
      })),
    };
  }

  return {
    ...manifest,
    source: { ...manifest.source, explicitConfig: true },
    modules: manifest.modules.map((module) => ({
      ...module,
      actions: module.actions.map((action) => action.name === "build"
        ? { ...action, resources: { cpu: "2", memory: "2GiB" } }
        : action),
    })),
  };
}

export function migrateLegacyManifest(legacy: LegacyManifest): { manifest: ProjectManifest; warnings: string[] } {
  const reference: ReferenceProject = legacy.deploy?.adapter === "cloudflare.worker" ? "cloudflare-worker" : "rust-cli";
  const detected = detectProject(reference);
  const modules = legacy.modules.map((module) => {
    const detectedModule = detected.modules.find((candidate) => candidate.name === module.name) ?? detected.modules[0];
    return { ...detectedModule, name: module.name, root: module.root };
  });
  return {
    manifest: {
      ...detected,
      project: { name: legacy.name, reference },
      source: { detectedFrom: ["legacy anyam.project/v0"], explicitConfig: true },
      modules,
      targets: legacy.deploy ? [{ name: "default", adapter: legacy.deploy.adapter, accepts: [legacy.deploy.artifact], requires: [] }] : detected.targets,
    },
    warnings: [
      "v0 checks were mapped to Verifier actions; inspect disclosure and requiredFor before committing the config.",
      "v0 deploy was mapped to a Target adapter; Promotion policy and health requirements must be reviewed.",
    ],
  };
}

export function planAction(manifest: ProjectManifest, moduleName: string, actionName: string, mode: ExecutionMode): ActionPlan {
  const module = manifest.modules.find((candidate) => candidate.name === moduleName);
  if (!module) throw new Error(`module not found: ${moduleName}`);
  const action = module.actions.find((candidate) => candidate.name === actionName);
  if (!action) throw new Error(`action not found: ${moduleName}.${actionName}`);
  const contract = JSON.stringify({ module: module.name, action, schema: manifest.schema });
  let digest = 0;
  for (const char of contract) digest = (digest * 31 + char.charCodeAt(0)) >>> 0;
  return { mode, module: module.name, action: action.name, command: action.command, inputs: action.inputs, outputs: action.outputs, network: action.network, resources: action.resources, contractDigest: digest.toString(16).padStart(8, "0") };
}

export function verify(manifest: ProjectManifest, verifierName: string): string {
  const verifier = manifest.verifiers.find((candidate) => candidate.name === verifierName);
  if (!verifier) throw new Error(`verifier not found: ${verifierName}`);
  return `${verifier.name}: pass · ${verifier.disclosure} Evidence · required for ${verifier.requiredFor.join(", ")}`;
}

export function planTarget(manifest: ProjectManifest, targetName: string): string {
  const target = manifest.targets.find((candidate) => candidate.name === targetName);
  if (!target) throw new Error(`target not found: ${targetName}`);
  return `${target.name}: ${target.adapter} accepts ${target.accepts.join(", ")} · requires ${target.requires.join(", ") || "none"}`;
}

export function initialState(reference: ReferenceProject): DemoState {
  return { reference, manifest: detectProject(reference), lastAction: "detected project conventions", actionPlan: null, verifierResult: null, targetPlan: null, warnings: [] };
}
