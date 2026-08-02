/**
 * PROTOTYPE — extension and ecosystem contracts
 *
 * Question: can third-party extensions be discovered, installed, invoked,
 * upgraded, deprecated, and revoked without letting an adapter become Anyam
 * authority or an untrusted package become a hidden capability grant?
 *
 * The module is pure and in-memory. The terminal shell is throwaway; the
 * manifest, policy, and lifecycle boundaries are the design under test.
 */

export type ExtensionKind =
  | 'repository-driver'
  | 'action'
  | 'verifier'
  | 'target-adapter'
  | 'project-experience'
  | 'ide'
  | 'agent-skill'
  | 'app';

export type Trust = 'first-party' | 'verified' | 'unverified';
export type Lifecycle = 'proposed' | 'installed' | 'enabled' | 'deprecated' | 'revoked' | 'blocked';
export type Effect = 'read' | 'execute' | 'write-artifact' | 'target-promote' | 'secret-use' | 'network';

export interface ExtensionManifest {
  id: string;
  version: string;
  kind: ExtensionKind;
  trust: Trust;
  api: 'anyam.extension/v1';
  source: string;
  digest: string;
  capabilities: Effect[];
  compatibility: string;
  deprecation?: string;
}

export interface Installation {
  extensionId: string;
  projectId: string;
  lifecycle: Lifecycle;
  granted: Effect[];
  installedBy: string;
  policyDecision: string;
}

export interface ExtensionEvent {
  kind: string;
  extensionId: string;
  detail: string;
}

export interface EcosystemState {
  catalog: Record<string, ExtensionManifest>;
  installations: Installation[];
  events: ExtensionEvent[];
  lastAction: string;
}

export interface InvocationResult {
  status: 'allowed' | 'blocked' | 'proposal';
  detail: string;
  effects: Effect[];
}

const FORBIDDEN_DIRECT_EFFECTS: Effect[] = ['target-promote'];

export function initialState(): EcosystemState {
  return { catalog: {}, installations: [], events: [], lastAction: 'initial state' };
}

export function register(state: EcosystemState, manifest: ExtensionManifest): EcosystemState {
  const hasForbiddenDirectWrite = manifest.capabilities.some((effect) => effect === 'target-promote');
  const blocked = manifest.api !== 'anyam.extension/v1' || !manifest.digest ||
    (manifest.trust === 'unverified' && hasForbiddenDirectWrite);
  const lifecycle: Lifecycle = blocked ? 'blocked' : 'proposed';
  const detail = blocked
    ? 'manifest rejected: incompatible contract, missing digest, or unverified target authority'
    : `manifest accepted for review from ${manifest.source}`;

  return {
    ...state,
    catalog: { ...state.catalog, [manifest.id]: manifest },
    events: [...state.events, { kind: blocked ? 'extension.blocked' : 'extension.proposed', extensionId: manifest.id, detail }],
    lastAction: `${blocked ? 'blocked' : 'registered'} ${manifest.id}@${manifest.version}`,
  };
}

export function install(
  state: EcosystemState,
  extensionId: string,
  projectId: string,
  granted: Effect[],
  installedBy: string,
): EcosystemState {
  const manifest = state.catalog[extensionId];
  if (!manifest) return { ...state, lastAction: `install blocked: unknown extension ${extensionId}` };
  const invalidGrant = granted.some((effect) => !manifest.capabilities.includes(effect));
  const blocked = invalidGrant || manifest.trust === 'unverified' && granted.includes('target-promote');
  const lifecycle: Lifecycle = blocked ? 'blocked' : 'enabled';
  const detail = blocked
    ? 'install denied: grant exceeds manifest or unverified extension requests target authority'
    : 'installed with a project-scoped grant; the extension still cannot mutate kernel authority';
  const installation: Installation = {
    extensionId,
    projectId,
    lifecycle,
    granted: blocked ? [] : granted,
    installedBy,
    policyDecision: blocked ? 'deny' : 'allow',
  };

  return {
    ...state,
    installations: [...state.installations.filter((item) => !(item.extensionId === extensionId && item.projectId === projectId)), installation],
    events: [...state.events, { kind: blocked ? 'extension.install_denied' : 'extension.installed', extensionId, detail }],
    lastAction: `${blocked ? 'blocked' : 'installed'} ${extensionId} for ${projectId}`,
  };
}

export function invoke(
  state: EcosystemState,
  extensionId: string,
  projectId: string,
  requested: Effect[],
): InvocationResult {
  const manifest = state.catalog[extensionId];
  const installation = state.installations.find((item) => item.extensionId === extensionId && item.projectId === projectId);
  if (!manifest || !installation) return { status: 'blocked', detail: 'no project-scoped installation exists', effects: requested };
  if (installation.lifecycle !== 'enabled') return { status: 'blocked', detail: `installation is ${installation.lifecycle}`, effects: requested };
  const missing = requested.filter((effect) => !installation.granted.includes(effect));
  if (missing.length > 0) return { status: 'blocked', detail: `missing granted effects: ${missing.join(', ')}`, effects: requested };
  if (requested.some((effect) => FORBIDDEN_DIRECT_EFFECTS.includes(effect))) {
    return { status: 'proposal', detail: 'extension may propose a Promotion; only the kernel can apply Target authority', effects: requested };
  }
  return { status: 'allowed', detail: 'extension may perform the granted adapter operation', effects: requested };
}

export function changeLifecycle(
  state: EcosystemState,
  extensionId: string,
  lifecycle: Extract<Lifecycle, 'deprecated' | 'revoked'>,
  reason: string,
): EcosystemState {
  const installations = state.installations.map((installation) => {
    if (installation.extensionId !== extensionId) return installation;
    return { ...installation, lifecycle };
  });
  const catalog = {
    ...state.catalog,
    ...(state.catalog[extensionId]
      ? { [extensionId]: { ...state.catalog[extensionId], deprecation: reason } }
      : {}),
  };
  return {
    ...state,
    catalog,
    installations,
    events: [...state.events, { kind: `extension.${lifecycle}`, extensionId, detail: reason }],
    lastAction: `${lifecycle} ${extensionId}`,
  };
}

export function reset(): EcosystemState {
  return initialState();
}

export function runScenario(state: EcosystemState, name: string): EcosystemState {
  const target: ExtensionManifest = {
    id: 'npm-target',
    version: '1.0.0',
    kind: 'target-adapter',
    trust: 'verified',
    api: 'anyam.extension/v1',
    source: 'https://registry.example.test/npm-target.tgz',
    digest: 'sha256:target-v1',
    capabilities: ['read', 'write-artifact', 'target-promote'],
    compatibility: 'anyam.kernel/v1',
  };
  const untrusted: ExtensionManifest = {
    ...target,
    id: 'untrusted-deployer',
    trust: 'unverified',
    source: 'https://unknown.example.test/deployer.tgz',
    digest: 'sha256:untrusted',
  };

  if (name === 'register') return register(state, target);
  if (name === 'install-read-only') {
    const next = register(state, target);
    return install(next, target.id, 'atlas', ['read', 'write-artifact'], 'realm-owner');
  }
  if (name === 'install-promote') {
    const next = register(state, target);
    return install(next, target.id, 'atlas', ['read', 'write-artifact', 'target-promote'], 'realm-owner');
  }
  if (name === 'invoke-missing') {
    const next = runScenario(state, 'install-read-only');
    const result = invoke(next, target.id, 'atlas', ['target-promote']);
    return { ...next, events: [...next.events, { kind: 'extension.invoke', extensionId: target.id, detail: `${result.status}: ${result.detail}` }], lastAction: `${result.status} invocation` };
  }
  if (name === 'invoke-proposal') {
    const next = runScenario(state, 'install-promote');
    const result = invoke(next, target.id, 'atlas', ['target-promote']);
    return { ...next, events: [...next.events, { kind: 'extension.invoke', extensionId: target.id, detail: `${result.status}: ${result.detail}` }], lastAction: `${result.status} invocation` };
  }
  if (name === 'untrusted') return register(state, untrusted);
  if (name === 'deprecate') {
    const next = runScenario(state, 'install-promote');
    return changeLifecycle(next, target.id, 'deprecated', 'new installs disabled; existing release lineage remains inspectable');
  }
  if (name === 'revoke') {
    const next = runScenario(state, 'deprecate');
    return changeLifecycle(next, target.id, 'revoked', 'security response revoked installation and invalidated future invocations');
  }
  return state;
}
