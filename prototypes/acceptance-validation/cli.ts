#!/usr/bin/env bun
/** PROTOTYPE — run with `bun prototypes/acceptance-validation/cli.ts`. */

import {
  CRITERIA,
  currentStage,
  evaluateStage,
  initialState,
  reset,
  runScenario,
  type AcceptanceState,
  type Stage,
} from './model';

const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;

const STAGES: Stage[] = ['K0', 'private-alpha', 'public-beta'];

function shortStatus(status: string): string {
  if (status === 'passed') return 'PASS';
  if (status === 'failed') return 'FAIL';
  if (status === 'stale') return 'STALE';
  return '----';
}

function render(state: AcceptanceState): void {
  if (process.stdout.isTTY) console.clear();

  const gates = STAGES.map((stage) => evaluateStage(state, stage));
  console.log(bold('Anyam acceptance and validation prototype'));
  console.log(dim('Question: does an evidence matrix make stage advancement explicit?'));
  console.log('');
  console.log(`${bold('Current stage')}: ${currentStage(state)}`);
  console.log(`${bold('Last action')}: ${state.lastAction}`);
  console.log('');
  console.log(bold('Stage gates'));
  for (const gate of gates) {
    const blockerCount = gate.missing.length + gate.failed.length + gate.stale.length;
    const suffix = gate.status === 'passed' ? '' : ` (${blockerCount} blockers)`;
    console.log(`  ${gate.stage.padEnd(14)} ${gate.status.toUpperCase()}${suffix}`);
  }
  console.log('');
  console.log(bold('Acceptance matrix'));
  for (const criterion of CRITERIA) {
    const record = state.evidence[criterion.key];
    console.log(
      `  ${shortStatus(record.status).padEnd(5)} ${criterion.dimension.padEnd(24)} ${criterion.label}`,
    );
    console.log(dim(`        receipt: ${criterion.receipt}`));
    console.log(dim(`        detail:  ${record.detail}`));
  }
  console.log('');
  console.log(bold('Recent evidence'));
  for (const item of state.history.slice(-5)) console.log(`  ${item}`);
  console.log('');
  console.log(bold('Commands'));
  console.log('  1  run K0 happy path');
  console.log('  2  run private-alpha happy path');
  console.log('  3  inject import recovery failure');
  console.log('  4  resume import from recovery checkpoint');
  console.log('  5  run public-beta happy path');
  console.log('  6  make security Evidence stale');
  console.log('  7  requalify security Evidence');
  console.log('  r  reset');
  console.log('  q  quit');
}

function actionFor(input: string): string | undefined {
  return {
    '1': 'k0',
    '2': 'alpha',
    '3': 'alpha-recovery-failure',
    '4': 'alpha-recovery-resume',
    '5': 'beta',
    '6': 'beta-stale-security',
    '7': 'beta-requalify-security',
  }[input];
}

function applyInput(state: AcceptanceState, input: string): AcceptanceState | undefined {
  if (input === 'q') return undefined;
  if (input === 'r') return reset();
  const scenario = actionFor(input);
  return scenario ? runScenario(state, scenario) : state;
}

async function interactive(): Promise<void> {
  let state = initialState();
  render(state);

  for await (const line of console) {
    const next = applyInput(state, line.trim().toLowerCase());
    if (!next) break;
    state = next;
    render(state);
  }
}

function demo(): void {
  let state = initialState();
  for (const input of ['1', '2', '3', '4', '5', '6', '7']) {
    state = applyInput(state, input) ?? state;
    render(state);
    console.log(dim(`\n--- demo action ${input} ---\n`));
  }
}

if (process.argv.includes('--demo')) demo();
else await interactive();
