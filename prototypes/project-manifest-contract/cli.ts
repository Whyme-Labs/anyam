/**
 * THROWAWAY TUI — the model is portable; this shell exists only to push it by
 * hand and expose the contract after every action.
 */

import { stdin, stdout } from "node:process";
import {
  applyExplicitConfig,
  detectProject,
  initialState,
  migrateLegacyManifest,
  planAction,
  planTarget,
  type DemoState,
  type ExecutionMode,
  type ReferenceProject,
  verify,
} from "./model.ts";

const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;
const green = (value: string) => `\x1b[32m${value}\x1b[0m`;
const yellow = (value: string) => `\x1b[33m${value}\x1b[0m`;

let state: DemoState = initialState("cloudflare-worker");

function frame(): string {
  const { manifest } = state;
  const moduleLines = manifest.modules.map((module) => `  ${module.name} @ ${module.root} · ${module.actions.map((action) => action.name).join(", ")} · artifacts: ${module.artifacts.join(", ")}`).join("\n");
  const verifierLines = manifest.verifiers.map((verifier) => `  ${verifier.name} · ${verifier.disclosure} · ${verifier.action}`).join("\n");
  const targetLines = manifest.targets.map((target) => `  ${target.name} → ${target.adapter} · accepts: ${target.accepts.join(", ")}`).join("\n");
  const plan = state.actionPlan ? `\n${bold("Last Action Plan")}\n  mode: ${state.actionPlan.mode}\n  command: ${state.actionPlan.command}\n  inputs: ${state.actionPlan.inputs.join(", ")}\n  outputs: ${state.actionPlan.outputs.join(", ")}\n  network: ${state.actionPlan.network.join(", ") || "none"}\n  resources: ${state.actionPlan.resources.cpu} CPU / ${state.actionPlan.resources.memory}\n  contract digest: ${state.actionPlan.contractDigest}` : "";
  const warnings = state.warnings.length ? `\n${bold("Migration / contract warnings")}\n${state.warnings.map((warning) => `  ${yellow("!")} ${warning}`).join("\n")}` : "";
  return [
    bold("Anyam manifest contract prototype"),
    dim("Question: can convention detection and explicit config drive one local/remote contract?"),
    "",
    `${bold("Reference project")}: ${state.reference}`,
    `${bold("Schema")}: ${manifest.schema} · ${manifest.source.explicitConfig ? "explicit override applied" : "zero-config detection"}`,
    `${bold("Detected from")}: ${manifest.source.detectedFrom.join(", ")}`,
    "",
    bold("Modules / Actions"),
    moduleLines,
    "",
    bold("Verifiers"),
    verifierLines,
    "",
    bold("Targets"),
    targetLines,
    plan,
    state.verifierResult ? `\n${bold("Verifier result")}\n  ${green(state.verifierResult)}` : "",
    state.targetPlan ? `\n${bold("Target plan")}\n  ${state.targetPlan}` : "",
    warnings,
    "",
    `${bold("Last action")}: ${state.lastAction}`,
    "",
    bold("Keys"),
    `${bold("1")} worker  ${bold("2")} rust CLI  ${bold("d")} detect  ${bold("c")} explicit config  ${bold("l")} local plan  ${bold("r")} remote plan`,
    `${bold("v")} verify  ${bold("t")} target  ${bold("e")} migrate v0  ${bold("x")} reset  ${bold("q")} quit`,
  ].join("\n");
}

function render(): void {
  console.clear();
  console.log(frame());
}

function setReference(reference: ReferenceProject): void {
  state = initialState(reference);
}

function run(key: string): boolean {
  if (key === "q") return false;
  if (key === "1") { setReference("cloudflare-worker"); state.lastAction = "selected Cloudflare Worker reference"; }
  else if (key === "2") { setReference("rust-cli"); state.lastAction = "selected Rust CLI reference"; }
  else if (key === "d") { state.manifest = detectProject(state.reference); state.lastAction = "detected conventions again"; }
  else if (key === "c") { state.manifest = applyExplicitConfig(state.manifest); state.lastAction = "applied explicit override without replacing detected defaults"; }
  else if (key === "l" || key === "r") { const mode: ExecutionMode = key === "l" ? "local" : "remote"; state.actionPlan = planAction(state.manifest, state.manifest.modules[0].name, "build", mode); state.lastAction = `planned ${mode} build`; }
  else if (key === "v") { state.verifierResult = verify(state.manifest, state.manifest.verifiers[0].name); state.lastAction = "ran declared Verifier"; }
  else if (key === "t") { state.targetPlan = planTarget(state.manifest, state.manifest.targets[0].name); state.lastAction = "planned Target adapter"; }
  else if (key === "e") {
    const legacy = { schema: "anyam.project/v0" as const, name: state.manifest.project.name, modules: state.manifest.modules.map((module) => ({ name: module.name, root: module.root, checks: module.actions.map((action) => action.name) })), deploy: { adapter: state.manifest.targets[0].adapter, artifact: state.manifest.targets[0].accepts[0] } };
    const migrated = migrateLegacyManifest(legacy);
    state.manifest = migrated.manifest;
    state.warnings = migrated.warnings;
    state.lastAction = "migrated legacy v0 shape to v1";
  } else if (key === "x") { setReference(state.reference); state.lastAction = "reset to detected conventions"; }
  return true;
}

function demo(): void {
  const actions = ["1", "d", "c", "l", "r", "v", "t", "e"];
  for (const action of actions) { run(action); console.log(`\n--- key ${action} ---\n${frame()}`); }
}

if (process.argv.includes("--demo")) {
  demo();
} else {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Run this prototype in an interactive terminal, or pass --demo.");
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  render();
  stdin.on("data", (chunk) => { if (run(chunk.toString().trim())) render(); else { stdin.setRawMode(false); stdout.write("\n"); process.exit(0); } });
}
