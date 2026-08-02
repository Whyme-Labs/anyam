/** PROTOTYPE — disposable terminal shell for the bootstrap state machine. */
import * as readline from 'node:readline';
import { BootstrapAction, BootstrapError, BootstrapState, initialState, reduce } from './model';

const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;

let state: BootstrapState = initialState();
let operation = 1;

const dispatch = (action: BootstrapAction) => {
  try {
    state = reduce(state, action);
  } catch (error) {
    if (error instanceof BootstrapError) {
      state = { ...state, audit: [...state.audit, `error:${error.code}:${error.message}`] };
      console.log(JSON.stringify({ code: error.code, message: error.message, details: error.details }, null, 2));
    } else throw error;
  }
};

const render = () => {
  console.clear();
  console.log(bold('Anyam bootstrap/onboarding prototype'));
  console.log(dim('Question: can first-run setup recover safely from partial import and promotion failure?'));
  console.log();
  console.log(bold('State'));
  console.log(JSON.stringify(state, null, 2));
  console.log();
  console.log(bold('Actions'));
  console.log(`${bold('[h]')} hosted  ${bold('[m]')} managed  ${bold('[o]')} customer-operated  ${bold('[c]')} connect account`);
  console.log(`${bold('[r]')} create Realm  ${bold('[u]')} register owner/recovery  ${bold('[p]')} create Project`);
  console.log(`${bold('[i]')} start/complete GitHub import  ${bold('[f]')} fail current operation  ${bold('[x]')} recover`);
  console.log(`${bold('[a]')} attach Codex  ${bold('[v]')} create preview  ${bold('[d]')} start/complete Promotion  ${bold('[q]')} quit`);
};

const run = (actions: BootstrapAction[]) => {
  for (const action of actions) dispatch(action);
  console.log(JSON.stringify(state, null, 2));
};

const demo = () => {
  run([
    { type: 'select_mode', mode: 'customer-operated' },
    { type: 'connect_account' },
    { type: 'create_realm' },
    { type: 'register_owner' },
    { type: 'create_project' },
    { type: 'start_import', provider: 'github', operationId: 'import-001' },
    { type: 'fail_current', reason: 'remote history transfer interrupted' },
    { type: 'recover' },
    { type: 'complete_import', sourceSpaces: ['community', 'commercial-core'], revision: 'git:abc123' },
    { type: 'attach_agent', client: 'codex' },
    { type: 'create_preview', revision: 'git:abc123' },
    { type: 'start_promotion', releaseId: 'release-demo' },
    { type: 'fail_current', reason: 'target health check unavailable' },
    { type: 'recover' },
    { type: 'start_promotion', releaseId: 'release-demo' },
    { type: 'complete_promotion' },
  ]);
};

if (process.argv.includes('--demo')) {
  demo();
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  render();
  rl.input.on('data', (chunk: Buffer) => {
    const key = chunk.toString().trim().toLowerCase();
    const nextOperation = `op-${String(operation++).padStart(3, '0')}`;
    if (key === 'q') {
      rl.close();
      return;
    }
    if (key === 'h') dispatch({ type: 'select_mode', mode: 'hosted-saas' });
    else if (key === 'm') dispatch({ type: 'select_mode', mode: 'managed-customer-account' });
    else if (key === 'o') dispatch({ type: 'select_mode', mode: 'customer-operated' });
    else if (key === 'c') dispatch({ type: 'connect_account' });
    else if (key === 'r') dispatch({ type: 'create_realm' });
    else if (key === 'u') dispatch({ type: 'register_owner' });
    else if (key === 'p') dispatch({ type: 'create_project' });
    else if (key === 'i') {
      if (state.phase === 'project-ready') {
        dispatch({ type: 'start_import', provider: 'github', operationId: nextOperation });
      } else if (state.phase === 'importing') {
        dispatch({ type: 'complete_import', sourceSpaces: ['community'], revision: 'git:demo123' });
      }
    } else if (key === 'f') {
      dispatch({ type: 'fail_current', reason: 'operator-injected recovery case' });
    } else if (key === 'x') dispatch({ type: 'recover' });
    else if (key === 'a') dispatch({ type: 'attach_agent', client: 'codex' });
    else if (key === 'v') dispatch({ type: 'create_preview', revision: 'git:demo123' });
    else if (key === 'd') {
      if (state.phase === 'preview-ready') dispatch({ type: 'start_promotion', releaseId: 'release-demo' });
      else if (state.phase === 'promoting') dispatch({ type: 'complete_promotion' });
    }
    render();
  });
}

