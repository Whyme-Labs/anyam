/**
 * PROTOTYPE — acceptance and validation program
 *
 * Question: can one evidence-backed acceptance model describe the journeys
 * and stage gates that prove Anyam works for solo developers, teams, public
 * contributors, coding agents, hybrid Source Spaces, recovery, portability,
 * security, accessibility, performance, and operations?
 *
 * This module is intentionally pure. The terminal shell is throwaway; the
 * matrix and gate evaluation are the part worth carrying into the real test
 * contract if the shape survives the walkthrough.
 */

export type Stage = 'K0' | 'private-alpha' | 'public-beta' | 'expansion';
export type EvidenceStatus = 'missing' | 'passed' | 'failed' | 'stale';

export type CriterionKey =
  | 'scaffold-local'
  | 'solo-git-flow'
  | 'agents'
  | 'portability'
  | 'performance-receipt'
  | 'worker-target'
  | 'cli-artifact-target'
  | 'hybrid-source'
  | 'recovery'
  | 'security-boundaries'
  | 'accessibility'
  | 'operations-rollback'
  | 'team-review'
  | 'public-contribution'
  | 'multi-realm'
  | 'repository-fallback'
  | 'two-way-mirror'
  | 'external-runner'
  | 'npm-target';

export interface CriterionDefinition {
  key: CriterionKey;
  label: string;
  dimension: string;
  stage: Stage;
  receipt: string;
}

export interface EvidenceRecord {
  status: EvidenceStatus;
  receipt: string;
  detail: string;
}

export interface GateResult {
  stage: Stage;
  status: 'open' | 'passed' | 'blocked';
  missing: CriterionKey[];
  failed: CriterionKey[];
  stale: CriterionKey[];
}

export interface AcceptanceState {
  evidence: Record<CriterionKey, EvidenceRecord>;
  history: string[];
  lastAction: string;
}

export const CRITERIA: CriterionDefinition[] = [
  {
    key: 'scaffold-local',
    label: 'Local scaffold and explicit connect',
    dimension: 'developer experience',
    stage: 'K0',
    receipt: 'generated files and local checks are observable; no cloud side effect',
  },
  {
    key: 'solo-git-flow',
    label: 'Solo Git-compatible Change flow',
    dimension: 'solo developer',
    stage: 'K0',
    receipt: 'clone, edit, commit, push, check, and local undo are recorded',
  },
  {
    key: 'agents',
    label: 'Codex, Claude Code, and Cursor task isolation',
    dimension: 'coding agents',
    stage: 'K0',
    receipt: 'each agent receives a bounded Workspace and cannot write canonical source',
  },
  {
    key: 'portability',
    label: 'Project Export and restore',
    dimension: 'portability',
    stage: 'K0',
    receipt: 'export digest and restore comparison cover source, metadata, and recovery refs',
  },
  {
    key: 'performance-receipt',
    label: 'Performance measurement before tripwires',
    dimension: 'performance',
    stage: 'K0',
    receipt: 'healthy reference runs are measured; no unreceipted quota is asserted',
  },
  {
    key: 'worker-target',
    label: 'Cloudflare Worker preview and Promotion',
    dimension: 'web application',
    stage: 'private-alpha',
    receipt: 'immutable Release, health verification, current Target, and rollback state',
  },
  {
    key: 'cli-artifact-target',
    label: 'CLI/library Artifact and release asset',
    dimension: 'non-web project',
    stage: 'private-alpha',
    receipt: 'typed Artifact digest, Release lineage, and downloadable Target result',
  },
  {
    key: 'hybrid-source',
    label: 'Public/private Source Space projection',
    dimension: 'hybrid source',
    stage: 'private-alpha',
    receipt: 'public view omits private objects and metadata; owner decides functional completeness',
  },
  {
    key: 'recovery',
    label: 'Import and Promotion failure recovery',
    dimension: 'failure recovery',
    stage: 'private-alpha',
    receipt: 'blocked operation exposes checkpoint, partial effects, remediation, and safe resume',
  },
  {
    key: 'security-boundaries',
    label: 'Critical trust-boundary qualification',
    dimension: 'security',
    stage: 'private-alpha',
    receipt: 'canonical write, disclosure, token audience, Secret Use, Evidence, and tenant gates',
  },
  {
    key: 'accessibility',
    label: 'Accessible web companion journey',
    dimension: 'accessibility',
    stage: 'private-alpha',
    receipt: 'keyboard, focus, name/role/value, contrast, and reduced-motion evidence',
  },
  {
    key: 'operations-rollback',
    label: 'Operational health and rollback',
    dimension: 'operations',
    stage: 'private-alpha',
    receipt: 'audit trail, health state, retry behavior, and immutable rollback Promotion',
  },
  {
    key: 'team-review',
    label: 'Team review and separation of duties',
    dimension: 'teams',
    stage: 'public-beta',
    receipt: 'multiple principals, review findings, approvals, and policy explanations',
  },
  {
    key: 'public-contribution',
    label: 'Public contributor workflow',
    dimension: 'public contributors',
    stage: 'public-beta',
    receipt: 'public projection contribution becomes a local Change without private disclosure',
  },
  {
    key: 'multi-realm',
    label: 'Multiple isolated Realms',
    dimension: 'tenancy',
    stage: 'public-beta',
    receipt: 'cross-Realm access is denied unless an explicit receiving-Realm grant exists',
  },
  {
    key: 'repository-fallback',
    label: 'Second repository-driver path',
    dimension: 'provider portability',
    stage: 'public-beta',
    receipt: 'same Project contracts survive driver change and export/restore',
  },
  {
    key: 'two-way-mirror',
    label: 'Two-way GitHub mirror',
    dimension: 'ecosystem compatibility',
    stage: 'public-beta',
    receipt: 'inbound commits become Changes; divergence and loops remain explicit',
  },
  {
    key: 'external-runner',
    label: 'Portable external pull Runner',
    dimension: 'cross-platform execution',
    stage: 'public-beta',
    receipt: 'immutable input, narrowed job grant, scoped outputs, signed result, and expiry',
  },
  {
    key: 'npm-target',
    label: 'npm package Target',
    dimension: 'ecosystem output',
    stage: 'public-beta',
    receipt: 'package Artifact and Release promote without rebuilding source',
  },
];

const STAGE_ORDER: Stage[] = ['K0', 'private-alpha', 'public-beta', 'expansion'];

export function initialState(): AcceptanceState {
  return {
    evidence: Object.fromEntries(
      CRITERIA.map(({ key }) => [
        key,
        {
          status: 'missing',
          receipt: 'not run',
          detail: 'No Evidence has been recorded for this criterion.',
        },
      ]),
    ) as Record<CriterionKey, EvidenceRecord>,
    history: [],
    lastAction: 'initial state',
  };
}

export function requiredFor(stage: Stage): CriterionDefinition[] {
  if (stage === 'expansion') return [];
  const maxIndex = STAGE_ORDER.indexOf(stage);
  return CRITERIA.filter(({ stage: criterionStage }) => {
    return STAGE_ORDER.indexOf(criterionStage) <= maxIndex;
  });
}

export function evaluateStage(state: AcceptanceState, stage: Stage): GateResult {
  const required = requiredFor(stage);
  const missing: CriterionKey[] = [];
  const failed: CriterionKey[] = [];
  const stale: CriterionKey[] = [];

  for (const criterion of required) {
    const record = state.evidence[criterion.key];
    if (record.status === 'missing') missing.push(criterion.key);
    if (record.status === 'failed') failed.push(criterion.key);
    if (record.status === 'stale') stale.push(criterion.key);
  }

  const blocked = missing.length > 0 || failed.length > 0 || stale.length > 0;
  return {
    stage,
    status: blocked ? 'blocked' : 'passed',
    missing,
    failed,
    stale,
  };
}

export function currentStage(state: AcceptanceState): Stage {
  let result: Stage = 'K0';
  for (const stage of STAGE_ORDER.slice(0, -1)) {
    if (evaluateStage(state, stage).status === 'passed') result = stage;
  }
  return result;
}

export function recordEvidence(
  state: AcceptanceState,
  key: CriterionKey,
  status: EvidenceStatus,
  detail: string,
): AcceptanceState {
  const criterion = CRITERIA.find((item) => item.key === key);
  if (!criterion) return state;

  const next: AcceptanceState = {
    evidence: {
      ...state.evidence,
      [key]: {
        status,
        receipt: criterion.receipt,
        detail,
      },
    },
    history: [...state.history, `${status.toUpperCase()} ${key}: ${detail}`],
    lastAction: `${status} ${key}`,
  };
  return next;
}

export function runScenario(state: AcceptanceState, name: string): AcceptanceState {
  let next = state;

  const pass = (keys: CriterionKey[], detail: string) => {
    for (const key of keys) next = recordEvidence(next, key, 'passed', detail);
  };

  if (name === 'k0') {
    pass(
      ['scaffold-local', 'solo-git-flow', 'agents', 'portability', 'performance-receipt'],
      'reference fixture completed with observable output and no implicit cloud side effect',
    );
  } else if (name === 'alpha') {
    next = runScenario(next, 'k0');
    pass(
      [
        'worker-target',
        'cli-artifact-target',
        'hybrid-source',
        'recovery',
        'security-boundaries',
        'accessibility',
        'operations-rollback',
      ],
      'private-alpha reference journey completed end to end',
    );
  } else if (name === 'alpha-recovery-failure') {
    next = recordEvidence(
      next,
      'recovery',
      'failed',
      'import transfer failed after quarantine; operation is blocked at checkpoint import-verified-02',
    );
  } else if (name === 'alpha-recovery-resume') {
    next = recordEvidence(
      next,
      'recovery',
      'passed',
      'resume reused checkpoint import-verified-02 without duplicate repository or false activation',
    );
  } else if (name === 'beta') {
    next = runScenario(next, 'alpha');
    pass(
      [
        'team-review',
        'public-contribution',
        'multi-realm',
        'repository-fallback',
        'two-way-mirror',
        'external-runner',
        'npm-target',
      ],
      'public-beta qualification fixture completed with explicit authority and receipts',
    );
  } else if (name === 'beta-stale-security') {
    next = recordEvidence(
      next,
      'security-boundaries',
      'stale',
      'policy version changed after the previous trust-boundary run; requalification required',
    );
  } else if (name === 'beta-requalify-security') {
    next = recordEvidence(
      next,
      'security-boundaries',
      'passed',
      'critical trust-boundary suite rerun against current source and policy epoch',
    );
  }

  return next;
}

export function reset(): AcceptanceState {
  return initialState();
}
