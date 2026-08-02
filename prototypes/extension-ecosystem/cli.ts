#!/usr/bin/env bun
/** PROTOTYPE — run with `bun prototypes/extension-ecosystem/cli.ts`. */

import {
  initialState,
  invoke,
  register,
  reset,
  runScenario,
  type EcosystemState,
  type ExtensionManifest,
} from './model';

const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;

function render(state: EcosystemState): void {
  if (process.stdout.isTTY) console.clear();
  console.log(bold('Anyam extension and ecosystem prototype'));
  console.log(dim('Question: can adapters extend Anyam without becoming kernel authority?'));
  console.log('');
  console.log(`${bold('Last action')}: ${state.lastAction}`);
  console.log('');
  console.log(bold('Catalog'));
  const manifests = Object.values(state.catalog);
  if (manifests.length === 0) console.log('  (empty)');
  for (const manifest of manifests) {
    console.log(`  ${manifest.id}@${manifest.version} [${manifest.kind}] trust=${manifest.trust}`);
    console.log(dim(`    api=${manifest.api} source=${manifest.source} digest=${manifest.digest}`));
    console.log(dim(`    declared effects=${manifest.capabilities.join(', ')}`));
  }
  console.log('');
  console.log(bold('Installations'));
  if (state.installations.length === 0) console.log('  (empty)');
  for (const installation of state.installations) {
    console.log(`  ${installation.extensionId} → ${installation.projectId} ${installation.lifecycle}`);
    console.log(dim(`    granted=${installation.granted.join(', ') || '(none)'} decision=${installation.policyDecision}`));
  }
  console.log('');
  console.log(bold('Recent events'));
  for (const event of state.events.slice(-8)) console.log(`  ${event.kind} ${event.extensionId}: ${event.detail}`);
  console.log('');
  console.log(bold('Commands'));
  console.log('  1  register verified npm Target adapter');
  console.log('  2  install it read/write-artifact only');
  console.log('  3  invoke target promotion (blocked: missing grant)');
  console.log('  4  install with target-promote and invoke (proposal, not authority)');
  console.log('  5  register untrusted deployer (blocked)');
  console.log('  6  deprecate verified adapter');
  console.log('  7  revoke verified adapter');
  console.log('  r  reset');
  console.log('  q  quit');
}

function action(input: string): string | undefined {
  return {
    '1': 'register',
    '2': 'install-read-only',
    '3': 'invoke-missing',
    '4': 'invoke-proposal',
    '5': 'untrusted',
    '6': 'deprecate',
    '7': 'revoke',
  }[input];
}

function applyInput(state: EcosystemState, input: string): EcosystemState | undefined {
  if (input === 'q') return undefined;
  if (input === 'r') return reset();
  const scenario = action(input);
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
