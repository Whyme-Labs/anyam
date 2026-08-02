import { createInterface } from "node:readline";
import {
  criticalPath,
  evidenceKey,
  gateBlockers,
  initialState,
  reduce,
  resolveKey,
  riskKey,
  stage,
  stageOrder,
  type PlanState,
  type StageId,
} from "./stages.ts";

const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;

function render(state: PlanState): void {
  console.clear();
  console.log(bold("ANYAM — PHASED DELIVERY PROGRAM (PROTOTYPE)"));
  console.log(dim("Question: can dependency, evidence, and risk gates explain the path without calendar commitments?"));
  console.log();
  console.log(bold("Stages"));
  for (const id of stageOrder) {
    const current = stage(id);
    const blockers = gateBlockers(state, id);
    const status = state.stages[id].padEnd(8);
    const gate = blockers.length === 0 ? "READY" : `${blockers.length} blocker(s)`;
    console.log(`  ${id.padEnd(9)} ${status} ${current.title} — ${gate}`);
  }

  console.log();
  console.log(bold("Critical path"));
  console.log(`  ${criticalPath(state).join(" → ") || "complete"}`);

  console.log();
  console.log(bold("Current gate details"));
  const active = stageOrder.find((id) => state.stages[id] === "active");
  if (!active) {
    console.log(dim("  No active stage. Try: start K0"));
  } else {
    const current = stage(active);
    console.log(`  ${active}: ${current.title}`);
    console.log(`  owner: ${current.owner}`);
    console.log(`  staffing: ${current.staffing}`);
    console.log(`  workstreams: ${current.workstreams.join(", ")}`);
    console.log(`  integrations: ${current.integrations.join(", ")}`);
    console.log("  evidence:");
    for (const item of current.evidence) console.log(`    ${state.evidence[evidenceKey(active, item)]}  ${evidenceKey(active, item)}  ${item.label}`);
    console.log("  risks:");
    for (const risk of current.risks) console.log(`    ${state.risks[riskKey(active, risk)]}  ${riskKey(active, risk)}  ${risk.question}`);
  }

  console.log();
  console.log(bold("Last action"));
  console.log(`  ${state.message}`);
  console.log();
  console.log(bold("Commands"));
  console.log(`  ${bold("start K0")}                 activate a stage after dependencies are complete`);
  console.log(`  ${bold("evidence K0:local-loop")}    accept a receipt for the active gate`);
  console.log(`  ${bold("risk K0:r-kernel-model")}    retire a measured risk spike`);
  console.log(`  ${bold("promote K0")}               complete a stage only when its gate is ready`);
  console.log(`  ${bold("reset")} / ${bold("q")}              reset or quit`);
}

function dispatch(state: PlanState, line: string): PlanState | null {
  const [command, value] = line.trim().split(/\s+/, 2);
  if (command === "q" || command === "quit" || command === "exit") return null;
  if (command === "reset") return reduce(state, { type: "reset" });
  if (command === "start" && value && stageOrder.includes(value as StageId)) return reduce(state, { type: "start", stage: value as StageId });
  if (command === "promote" && value && stageOrder.includes(value as StageId)) return reduce(state, { type: "promote", stage: value as StageId });
  if ((command === "evidence" || command === "risk") && value) {
    const resolved = resolveKey(value);
    if (!resolved || resolved.kind !== command) return { ...state, message: `Invalid ${command} key ${value}. Use one shown in the current gate.` };
    return reduce(state, command === "evidence" ? { type: "acceptEvidence", key: value } : { type: "retireRisk", key: value });
  }
  return { ...state, message: `Unknown command: ${line}.` };
}

let state = initialState();
const input = createInterface({ input: process.stdin, output: process.stdout });

render(state);
input.setPrompt("\n> ");
input.prompt();
input.on("line", (line) => {
  const next = dispatch(state, line);
  if (next === null) {
    input.close();
    return;
  }
  state = next;
  render(state);
  input.prompt();
});
