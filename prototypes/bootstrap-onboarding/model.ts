/**
 * PROTOTYPE — bootstrap/import/recovery state machine.
 *
 * Question: can a first-run flow stay low-friction while making partial
 * installation, import, preview, and promotion failures explicit and
 * recoverable? The model is pure; cli.ts is the disposable TUI.
 */

export type HostingMode = 'hosted-saas' | 'managed-customer-account' | 'customer-operated';
export type Phase =
  | 'new'
  | 'mode-selected'
  | 'account-ready'
  | 'realm-ready'
  | 'owner-ready'
  | 'project-ready'
  | 'importing'
  | 'imported'
  | 'agent-ready'
  | 'preview-ready'
  | 'promoting'
  | 'active'
  | 'blocked';

export interface BootstrapState {
  phase: Phase;
  mode?: HostingMode;
  account?: { provider: 'anyam' | 'customer-cloudflare'; connected: boolean };
  realmId?: string;
  owner?: { principalId: string; recoveryEnrolled: boolean };
  projectId?: string;
  source?: {
    provider: 'github' | 'gitlab' | 'generic-git';
    sourceSpaces: string[];
    importOperationId: string;
    importedRevision?: string;
  };
  agent?: { client: 'codex' | 'claude' | 'cursor'; connected: boolean };
  preview?: { url: string; revision: string };
  release?: { id: string; status: 'verified' | 'promoting' | 'active' | 'failed' };
  blocked?: {
    operation: 'import' | 'promotion';
    reason: string;
    checkpoint: Phase;
    partialEffects: string[];
  };
  audit: string[];
}

export type BootstrapAction =
  | { type: 'select_mode'; mode: HostingMode }
  | { type: 'connect_account' }
  | { type: 'create_realm' }
  | { type: 'register_owner' }
  | { type: 'create_project' }
  | {
      type: 'start_import';
      provider: NonNullable<BootstrapState['source']>['provider'];
      operationId: string;
    }
  | { type: 'complete_import'; sourceSpaces: string[]; revision: string }
  | { type: 'attach_agent'; client: 'codex' | 'claude' | 'cursor' }
  | { type: 'create_preview'; revision: string }
  | { type: 'start_promotion'; releaseId: string }
  | { type: 'complete_promotion' }
  | { type: 'fail_current'; reason: string }
  | { type: 'recover' }
  | { type: 'reset' };

export class BootstrapError extends Error {
  readonly code: 'invalid_transition' | 'invalid_input' | 'already_complete';
  readonly details: Record<string, unknown>;

  constructor(
    code: BootstrapError['code'],
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
    this.details = details;
  }
}

const withAudit = (state: BootstrapState, message: string): BootstrapState => ({
  ...state,
  audit: [...state.audit, message],
});

const requirePhase = (state: BootstrapState, phases: Phase[], action: string) => {
  if (!phases.includes(state.phase)) {
    throw new BootstrapError(
      'invalid_transition',
      `${action} is not valid while the bootstrap is ${state.phase}.`,
      { phase: state.phase, allowed_phases: phases },
    );
  }
};

export const initialState = (): BootstrapState => ({ phase: 'new', audit: [] });

export function reduce(state: BootstrapState, action: BootstrapAction): BootstrapState {
  if (action.type === 'reset') return initialState();

  switch (action.type) {
    case 'select_mode':
      requirePhase(state, ['new'], action.type);
      return withAudit({ ...state, phase: 'mode-selected', mode: action.mode }, `mode.selected:${action.mode}`);

    case 'connect_account':
      requirePhase(state, ['mode-selected'], action.type);
      if (!state.mode) throw new BootstrapError('invalid_input', 'hosting mode is required before account connection.');
      return withAudit(
        {
          ...state,
          phase: 'account-ready',
          account: {
            provider: state.mode === 'hosted-saas' ? 'anyam' : 'customer-cloudflare',
            connected: true,
          },
        },
        `account.connected:${state.mode}`,
      );

    case 'create_realm':
      requirePhase(state, ['account-ready'], action.type);
      return withAudit({ ...state, phase: 'realm-ready', realmId: 'realm-demo' }, 'realm.created');

    case 'register_owner':
      requirePhase(state, ['realm-ready'], action.type);
      return withAudit(
        {
          ...state,
          phase: 'owner-ready',
          owner: { principalId: 'principal-demo', recoveryEnrolled: true },
        },
        'owner.registered:passkey+recovery',
      );

    case 'create_project':
      requirePhase(state, ['owner-ready'], action.type);
      return withAudit({ ...state, phase: 'project-ready', projectId: 'project-demo' }, 'project.created');

    case 'start_import':
      requirePhase(state, ['project-ready'], action.type);
      if (!action.operationId.trim()) throw new BootstrapError('invalid_input', 'import operation ID is required.');
      return withAudit(
        {
          ...state,
          phase: 'importing',
          source: {
            provider: action.provider,
            sourceSpaces: [],
            importOperationId: action.operationId,
          },
        },
        `import.started:${action.provider}:${action.operationId}`,
      );

    case 'complete_import':
      requirePhase(state, ['importing'], action.type);
      if (action.sourceSpaces.length === 0) {
        throw new BootstrapError('invalid_input', 'at least one Source Space must be selected for import.');
      }
      return withAudit(
        {
          ...state,
          phase: 'imported',
          source: { ...state.source!, sourceSpaces: action.sourceSpaces, importedRevision: action.revision },
        },
        `import.completed:${action.revision}`,
      );

    case 'attach_agent':
      requirePhase(state, ['imported'], action.type);
      return withAudit(
        { ...state, phase: 'agent-ready', agent: { client: action.client, connected: true } },
        `agent.attached:${action.client}`,
      );

    case 'create_preview':
      requirePhase(state, ['agent-ready'], action.type);
      return withAudit(
        {
          ...state,
          phase: 'preview-ready',
          preview: { url: 'https://preview.example.test/project-demo', revision: action.revision },
          release: { id: 'release-demo', status: 'verified' },
        },
        `preview.ready:${action.revision}`,
      );

    case 'start_promotion':
      requirePhase(state, ['preview-ready'], action.type);
      return withAudit(
        { ...state, phase: 'promoting', release: { id: action.releaseId, status: 'promoting' } },
        `promotion.started:${action.releaseId}`,
      );

    case 'complete_promotion':
      requirePhase(state, ['promoting'], action.type);
      return withAudit(
        { ...state, phase: 'active', release: { ...state.release!, status: 'active' } },
        `promotion.completed:${state.release?.id ?? 'unknown'}`,
      );

    case 'fail_current': {
      if (state.phase !== 'importing' && state.phase !== 'promoting') {
        throw new BootstrapError(
          'invalid_transition',
          'Failure injection is only valid during import or promotion.',
          { phase: state.phase },
        );
      }
      const operation = state.phase === 'importing' ? 'import' : 'promotion';
      return withAudit(
        {
          ...state,
          phase: 'blocked',
          blocked: {
            operation,
            reason: action.reason,
            checkpoint: operation === 'import' ? 'project-ready' : 'preview-ready',
            partialEffects:
              operation === 'import'
                ? ['repository-created', 'source-preflight-recorded']
                : ['release-verified', 'target-deploy-requested'],
          },
          release: operation === 'promotion' && state.release ? { ...state.release, status: 'failed' } : state.release,
        },
        `blocked:${operation}:${action.reason}`,
      );
    }

    case 'recover':
      requirePhase(state, ['blocked'], action.type);
      if (!state.blocked) throw new BootstrapError('invalid_input', 'blocked state has no recovery record.');
      return withAudit(
        {
          ...state,
          phase: state.blocked.operation === 'import' ? 'importing' : 'preview-ready',
          blocked: undefined,
          release:
            state.blocked.operation === 'promotion' && state.release
              ? { ...state.release, status: 'verified' }
              : state.release,
        },
        `recovered:${state.blocked.operation}`,
      );

    default:
      throw new BootstrapError('invalid_transition', 'unknown bootstrap action.');
  }
}
