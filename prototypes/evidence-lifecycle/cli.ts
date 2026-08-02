/**
 * THROWAWAY TUI — thin shell around model.ts. It intentionally renders the
 * complete Evidence, approval, provenance, disclosure, and policy state after
 * every action.
 */

import { stdin, stdout } from "node:process";
import { initialState, reduce, type EvidenceAction, type EvidenceState } from "./model.ts";

const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;
const color = (value: string, code: number) => `\x1b[${code}m${value}\x1b[0m`;

let state: EvidenceState = initialState();

function frame(): string {
  const evidence = state.evidence;
  const approval = state.approval;
  return [
    bold("Anyam Evidence lifecycle prototype"),
    dim("Question: what becomes stale, what can be reused, and what may be disclosed?"),
    "",
    `${bold("Source")}: ${state.sourceRevision}   ${bold("Policy")}: ${state.policyVersion}   ${bold("Target")}: ${state.target}`,
    `${bold("Effects")}: ${state.effects.map((effect) => `${effect.kind}:${effect.subject}`).join(", ")}`,
    "",
    bold("Evidence"),
    `  ${evidence.id} from ${evidence.run} · ${evidence.status === "valid" ? color("valid", 32) : color("STALE", 31)}`,
    `  binds: source=${evidence.sourceRevision} · verifier=${evidence.verifierVersion} · policy=${evidence.policyVersion} · target=${evidence.target}`,
    `  invalidated by: ${evidence.invalidatedBy.join("; ") || "none"}`,
    `  provenance: ${evidence.provenance.principal} → ${evidence.provenance.actor} → ${evidence.provenance.runner} · ${evidence.provenance.toolchain}`,
    "",
    bold("Approval"),
    `  ${approval.id} · ${approval.status} · evidence=${approval.evidenceId} · approver=${approval.approver ?? "none"}`,
    "",
    bold("Disclosure Projection"),
    `  ${state.projection}`,
    "",
    bold("Policy Explanation"),
    `  decision: ${state.explanation.decision === "allow" ? color(state.explanation.decision, 32) : color(state.explanation.decision, 33)}`,
    `  blocker: ${state.explanation.blocker}`,
    `  remediation: ${state.explanation.remediation}`,
    `  policy version: ${state.explanation.policyVersion}`,
    "",
    `${bold("Last action")}: ${state.lastAction}`,
    "",
    bold("Keys"),
    `${bold("s")} source change  ${bold("p")} policy change  ${bold("t")} Target change  ${bold("e")} add DB effect`,
    `${bold("c")} cache check  ${bold("r")} rerun  ${bold("a")} approve  ${bold("d")} disclosure  ${bold("x")} recompute  ${bold("q")} quit`,
  ].join("\n");
}

function render(): void { console.clear(); console.log(frame()); }

function dispatch(key: string): boolean {
  const actions: Record<string, EvidenceAction> = {
    s: { type: "source-changed", revision: "main@a2f1" },
    p: { type: "policy-changed", version: "policy@19" },
    t: { type: "target-changed", target: "staging@rel-25" },
    e: { type: "add-effect", effect: { kind: "database", subject: "codec_preferences" } },
    c: { type: "cache-check" },
    r: { type: "rerun" },
    a: { type: "approve", approver: "reviewer:maya" },
    d: { type: "disclose", audience: "public-contributor" },
    x: { type: "recompute" },
  };
  if (key === "q") return false;
  const action = actions[key];
  if (action) state = reduce(state, action);
  return true;
}

function demo(): void {
  const actions = ["c", "s", "c", "r", "a", "t", "d", "x"];
  for (const key of actions) { state = reduce(state, ({ c: { type: "cache-check" }, s: { type: "source-changed", revision: "main@a2f1" }, r: { type: "rerun" }, a: { type: "approve", approver: "reviewer:maya" }, t: { type: "target-changed", target: "staging@rel-25" }, d: { type: "disclose", audience: "public-contributor" }, x: { type: "recompute" } } as Record<string, EvidenceAction>)[key]); console.log(`\n--- key ${key} ---\n${frame()}`); }
}

if (process.argv.includes("--demo")) demo();
else {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Run this prototype in an interactive terminal, or pass --demo.");
  stdin.setRawMode(true); stdin.setEncoding("utf8"); render();
  stdin.on("data", (chunk) => { if (dispatch(chunk.toString().trim())) render(); else { stdin.setRawMode(false); stdout.write("\n"); process.exit(0); } });
}
