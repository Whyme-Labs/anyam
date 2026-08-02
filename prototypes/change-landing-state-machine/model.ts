/**
 * THROWAWAY PROTOTYPE — not production Anyam code.
 *
 * Question this prototype answers:
 * Can stable Changes and immutable Change Revisions make concurrent work,
 * review, Integration Cohorts, atomic Landing, rebase, and revert unambiguous
 * without rewriting history or letting a stale Workspace land over newer
 * canonical state?
 *
 * The reducer is pure. The terminal shell is disposable. There is no
 * persistence, provider, network, or verifier implementation here.
 */

export type SourceSpaceName = "community" | "commercial-core";
export type ChangeStatus = "open" | "needs-changes" | "ready" | "landed" | "superseded";
export type RevisionKind = "implementation" | "rebase" | "revert";

export type ProjectRevision = {
  id: string;
  parentId: string | null;
  snapshots: Record<SourceSpaceName, string>;
  landedChangeIds: string[];
};

export type Intent = {
  id: string;
  title: string;
};

export type Workspace = {
  id: string;
  changeId: string;
  actor: string;
  baseProjectRevision: string;
};

export type Claim = {
  id: string;
  changeId: string;
  actor: string;
  scope: string;
  active: boolean;
};

export type ChangeRevision = {
  id: string;
  changeId: string;
  workspaceId: string;
  baseProjectRevision: string;
  sourceSnapshots: Record<SourceSpaceName, string>;
  affectedSpaces: SourceSpaceName[];
  effects: string[];
  kind: RevisionKind;
  parentRevisionId: string | null;
  state: "published" | "superseded" | "landed";
};

export type Change = {
  id: string;
  intentId: string;
  status: ChangeStatus;
  workspaceId: string | null;
  revisionIds: string[];
  latestRevisionId: string | null;
  approvals: string[];
};

export type Review = {
  id: string;
  changeId: string;
  reviewer: string;
  decision: "approved" | "changes-requested";
  revisionId: string;
};

export type Conflict = {
  id: string;
  kind: "stale-base" | "effect-overlap" | "claim-overlap";
  blocking: boolean;
  cohortId: string;
  changeIds: string[];
  message: string;
  resolved: boolean;
};

export type IntegrationCohort = {
  id: string;
  baseProjectRevision: string;
  changeIds: string[];
  revisionIds: string[];
  conflictIds: string[];
  status: "candidate" | "blocked" | "landed";
  landedProjectRevisionId: string | null;
};

export type Operation = {
  id: string;
  kind: string;
  note: string;
};

export type State = {
  question: string;
  project: {
    name: string;
    canonical: ProjectRevision;
  };
  intents: Record<string, Intent>;
  changes: Record<string, Change>;
  workspaces: Record<string, Workspace>;
  claims: Claim[];
  revisions: Record<string, ChangeRevision>;
  reviews: Review[];
  cohorts: Record<string, IntegrationCohort>;
  conflicts: Record<string, Conflict>;
  operations: Operation[];
  ids: {
    intent: number;
    workspace: number;
    claim: number;
    revision: number;
    review: number;
    cohort: number;
    conflict: number;
    operation: number;
    projectRevision: number;
  };
  lastMessage: string;
  lastError: string | null;
};

export type Action =
  | { type: "intent"; changeId: string; title: string }
  | { type: "workspace"; changeId: string; actor: string }
  | { type: "claim"; changeId: string; actor: string; scope: string }
  | { type: "revise"; changeId: string; actor: string; effects: string[] }
  | { type: "review"; changeId: string; reviewer: string; decision: "approved" | "changes-requested" }
  | { type: "cohort"; changeIds: string[] }
  | { type: "land"; cohortId: string }
  | { type: "rebase"; changeId: string; actor: string }
  | { type: "revert"; changeId: string; actor: string }
  | { type: "invalid"; message: string }
  | { type: "reset" };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function digest(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function nextId(state: State, kind: keyof State["ids"], prefix: string): string {
  state.ids[kind] += 1;
  return `${prefix}-${String(state.ids[kind]).padStart(2, "0")}`;
}

function recordOperation(state: State, kind: string, note: string): void {
  state.operations.push({ id: nextId(state, "operation", "op"), kind, note });
}

function rejected(state: State, message: string): State {
  const next = clone(state);
  next.lastError = message;
  next.lastMessage = "No state changed.";
  recordOperation(next, "rejected", message);
  return next;
}

function accepted(state: State, kind: string, message: string): State {
  const next = clone(state);
  next.lastError = null;
  next.lastMessage = message;
  recordOperation(next, kind, message);
  return next;
}

function sourceSnapshot(
  sourceSpace: SourceSpaceName,
  base: string,
  changeId: string,
  revisionId: string,
): string {
  return `git:${sourceSpace}:${digest(`${base}:${changeId}:${revisionId}`)}`;
}

function projectRevisionId(snapshots: Record<SourceSpaceName, string>, suffix: string): string {
  return `project:${digest(`${suffix}:${Object.entries(snapshots).sort().join("|")}`)}`;
}

function latestRevision(state: State, changeId: string): ChangeRevision | null {
  const change = state.changes[changeId];
  return change?.latestRevisionId ? state.revisions[change.latestRevisionId] : null;
}

function activeClaims(state: State, changeId: string): Claim[] {
  return state.claims.filter((claim) => claim.changeId === changeId && claim.active);
}

function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function effectsOverlap(left: string[], right: string[]): string[] {
  return left.filter((effect) => right.includes(effect));
}

function spacesForEffects(effects: string[]): SourceSpaceName[] {
  const spaces = new Set<SourceSpaceName>();
  for (const effect of effects) {
    if (effect.startsWith("community:")) spaces.add("community");
    else if (effect.startsWith("commercial-core:")) spaces.add("commercial-core");
    else spaces.add("community");
  }
  return [...spaces].sort();
}

function addConflict(
  state: State,
  cohortId: string,
  kind: Conflict["kind"],
  blocking: boolean,
  changeIds: string[],
  message: string,
): string {
  const id = nextId(state, "conflict", "conflict");
  state.conflicts[id] = { id, kind, blocking, cohortId, changeIds, message, resolved: false };
  state.cohorts[cohortId].conflictIds.push(id);
  return id;
}

function createInitialState(): State {
  const snapshots = {
    community: "git:community:base",
    "commercial-core": "git:commercial-core:base",
  } as Record<SourceSpaceName, string>;
  return {
    question:
      "Can stable Changes and immutable Change Revisions make concurrent work, review, cohorts, Landing, rebase, and revert unambiguous?",
    project: {
      name: "atlas-video-player",
      canonical: {
        id: "project:base",
        parentId: null,
        snapshots,
        landedChangeIds: [],
      },
    },
    intents: {},
    changes: {},
    workspaces: {},
    claims: [],
    revisions: {},
    reviews: [],
    cohorts: {},
    conflicts: {},
    operations: [],
    ids: {
      intent: 0,
      workspace: 0,
      claim: 0,
      revision: 0,
      review: 0,
      cohort: 0,
      conflict: 0,
      operation: 0,
      projectRevision: 0,
    },
    lastMessage: "Canonical Project Revision project:base is ready.",
    lastError: null,
  };
}

function createIntent(state: State, changeId: string, title: string): State {
  if (state.changes[changeId]) return rejected(state, `Change ${changeId} already exists; its identity is stable.`);
  const next = accepted(state, "intent", `Created Intent and stable Change ${changeId}.`,);
  const intentId = nextId(next, "intent", "intent");
  next.intents[intentId] = { id: intentId, title };
  next.changes[changeId] = {
    id: changeId,
    intentId,
    status: "open",
    workspaceId: null,
    revisionIds: [],
    latestRevisionId: null,
    approvals: [],
  };
  return next;
}

function createWorkspace(state: State, changeId: string, actor: string): State {
  const change = state.changes[changeId];
  if (!change) return rejected(state, `Unknown Change ${changeId}. Create its Intent first.`);
  if (change.workspaceId) return rejected(state, `Change ${changeId} already has Workspace ${change.workspaceId}.`);
  const next = accepted(
    state,
    "workspace",
    `Created isolated Workspace from ${state.project.canonical.id} for ${changeId}; canonical state is not writable.`,
  );
  const workspaceId = nextId(next, "workspace", "workspace");
  next.workspaces[workspaceId] = {
    id: workspaceId,
    changeId,
    actor,
    baseProjectRevision: next.project.canonical.id,
  };
  next.changes[changeId].workspaceId = workspaceId;
  return next;
}

function addClaim(state: State, changeId: string, actor: string, scope: string): State {
  const change = state.changes[changeId];
  if (!change) return rejected(state, `Unknown Change ${changeId}.`);
  const next = accepted(state, "claim", `Claimed ${scope} for ${changeId}; overlapping claims remain soft coordination signals.`);
  const claimId = nextId(next, "claim", "claim");
  next.claims.push({ id: claimId, changeId, actor, scope, active: true });
  return next;
}

function publishRevision(state: State, changeId: string, actor: string, effects: string[]): State {
  const change = state.changes[changeId];
  if (!change) return rejected(state, `Unknown Change ${changeId}.`);
  if (!change.workspaceId) return rejected(state, `Change ${changeId} has no Workspace.`);
  const workspace = state.workspaces[change.workspaceId];
  if (workspace.actor !== actor) return rejected(state, `Actor ${actor} cannot publish ${changeId}'s Workspace.`);
  if (effects.length === 0) return rejected(state, "A Change Revision must declare at least one effect.");
  const next = accepted(state, "revision", `Published a new immutable Change Revision for ${changeId}; the stable Change identity remains unchanged.`);
  const nextChange = next.changes[changeId];
  const revisionId = nextId(next, "revision", "revision");
  const sourceSnapshots = {
    community: sourceSnapshot("community", next.project.canonical.snapshots.community, changeId, revisionId),
    "commercial-core": sourceSnapshot("commercial-core", next.project.canonical.snapshots["commercial-core"], changeId, revisionId),
  } as Record<SourceSpaceName, string>;
  const parentRevisionId = nextChange.latestRevisionId;
  if (parentRevisionId) next.revisions[parentRevisionId].state = "superseded";
  next.revisions[revisionId] = {
    id: revisionId,
    changeId,
    workspaceId: workspace.id,
    baseProjectRevision: workspace.baseProjectRevision,
    sourceSnapshots,
    affectedSpaces: spacesForEffects(effects),
    effects: [...new Set(effects)].sort(),
    kind: "implementation",
    parentRevisionId,
    state: "published",
  };
  nextChange.revisionIds.push(revisionId);
  nextChange.latestRevisionId = revisionId;
  nextChange.status = "open";
  nextChange.approvals = [];
  return next;
}

function recordReview(
  state: State,
  changeId: string,
  reviewer: string,
  decision: "approved" | "changes-requested",
): State {
  const change = state.changes[changeId];
  const revision = latestRevision(state, changeId);
  if (!change || !revision) return rejected(state, `Change ${changeId} needs a published Change Revision before review.`);
  const next = accepted(state, "review", `${reviewer} recorded ${decision} for ${changeId} at ${revision.id}.`);
  const reviewId = nextId(next, "review", "review");
  next.reviews.push({ id: reviewId, changeId, reviewer, decision, revisionId: revision.id });
  if (decision === "approved") {
    const nextChange = next.changes[changeId];
    if (!nextChange.approvals.includes(reviewer)) nextChange.approvals.push(reviewer);
    nextChange.status = "ready";
  } else {
    const nextChange = next.changes[changeId];
    nextChange.approvals = nextChange.approvals.filter((name) => name !== reviewer);
    nextChange.status = "needs-changes";
  }
  return next;
}

function createCohort(state: State, changeIds: string[]): State {
  const uniqueChangeIds = [...new Set(changeIds)];
  if (uniqueChangeIds.length === 0) return rejected(state, "An Integration Cohort needs at least one Change.");
  const missing = uniqueChangeIds.filter((changeId) => !state.changes[changeId] || !latestRevision(state, changeId));
  if (missing.length > 0) return rejected(state, `Cannot create a Cohort without current Change Revisions: ${missing.join(", ")}.`);

  const next = accepted(state, "cohort", `Created an Integration Cohort for ${uniqueChangeIds.join(", ")}.`);
  const cohortId = nextId(next, "cohort", "cohort");
  const revisions = uniqueChangeIds.map((changeId) => latestRevision(next, changeId) as ChangeRevision);
  const baseProjectRevision = revisions[0].baseProjectRevision;
  next.cohorts[cohortId] = {
    id: cohortId,
    baseProjectRevision,
    changeIds: uniqueChangeIds,
    revisionIds: revisions.map((revision) => revision.id),
    conflictIds: [],
    status: "candidate",
    landedProjectRevisionId: null,
  };

  const baseMismatch = revisions.filter((revision) => revision.baseProjectRevision !== baseProjectRevision);
  if (baseMismatch.length > 0) {
    addConflict(
      next,
      cohortId,
      "stale-base",
      true,
      uniqueChangeIds,
      `Changes in ${cohortId} do not share one base Project Revision. Rebase the stale Change before Landing.`,
    );
  }

  for (let leftIndex = 0; leftIndex < revisions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < revisions.length; rightIndex += 1) {
      const left = revisions[leftIndex];
      const right = revisions[rightIndex];
      const overlap = effectsOverlap(left.effects, right.effects);
      if (overlap.length > 0) {
        addConflict(
          next,
          cohortId,
          "effect-overlap",
          true,
          [left.changeId, right.changeId],
          `Effects overlap (${overlap.join(", ")}); a new Change Revision must make the composition explicit.`,
        );
      }
    }
  }

  for (let leftIndex = 0; leftIndex < uniqueChangeIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < uniqueChangeIds.length; rightIndex += 1) {
      const leftClaims = activeClaims(next, uniqueChangeIds[leftIndex]);
      const rightClaims = activeClaims(next, uniqueChangeIds[rightIndex]);
      for (const leftClaim of leftClaims) {
        for (const rightClaim of rightClaims) {
          if (scopesOverlap(leftClaim.scope, rightClaim.scope)) {
            addConflict(
              next,
              cohortId,
              "claim-overlap",
              false,
              [uniqueChangeIds[leftIndex], uniqueChangeIds[rightIndex]],
              `Claims overlap at ${leftClaim.scope}; this is a coordination warning, not an automatic block.`,
            );
          }
        }
      }
    }
  }

  if (next.cohorts[cohortId].conflictIds.some((id) => next.conflicts[id].blocking)) {
    next.cohorts[cohortId].status = "blocked";
  }
  return next;
}

function landCohort(state: State, cohortId: string): State {
  const cohort = state.cohorts[cohortId];
  if (!cohort) return rejected(state, `Unknown Integration Cohort ${cohortId}.`);
  const next = clone(state);
  if (cohort.baseProjectRevision !== next.project.canonical.id) {
    if (!cohort.conflictIds.some((id) => next.conflicts[id].kind === "stale-base" && !next.conflicts[id].resolved)) {
      addConflict(next, cohortId, "stale-base", true, cohort.changeIds, `Canonical state advanced to ${next.project.canonical.id}; ${cohort.id} must rebase before Landing.`);
    }
    next.cohorts[cohortId].status = "blocked";
    next.lastError = `Landing blocked: ${cohort.id} was based on ${cohort.baseProjectRevision}, but canonical state is ${next.project.canonical.id}.`;
    next.lastMessage = "No canonical state changed.";
    recordOperation(next, "land-blocked", next.lastError);
    return next;
  }

  const blocking = cohort.conflictIds.filter((id) => next.conflicts[id].blocking && !next.conflicts[id].resolved);
  if (blocking.length > 0) return rejected(next, `Landing blocked by unresolved Conflicts: ${blocking.join(", ")}.`);
  const missingApproval = cohort.changeIds.filter((changeId) => next.changes[changeId].approvals.length === 0);
  if (missingApproval.length > 0) return rejected(next, `Landing requires review approval for: ${missingApproval.join(", ")}.`);

  const snapshots = clone(next.project.canonical.snapshots);
  for (const revisionId of cohort.revisionIds) {
    const revision = next.revisions[revisionId];
    for (const sourceSpace of revision.affectedSpaces) {
      snapshots[sourceSpace] = revision.sourceSnapshots[sourceSpace];
    }
  }
  const projectRevisionId = nextId(next, "projectRevision", "project");
  next.project.canonical = {
    id: projectRevisionId,
    parentId: cohort.baseProjectRevision,
    snapshots,
    landedChangeIds: [...next.project.canonical.landedChangeIds, ...cohort.changeIds],
  };
  next.cohorts[cohortId].status = "landed";
  next.cohorts[cohortId].landedProjectRevisionId = projectRevisionId;
  for (const changeId of cohort.changeIds) {
    next.changes[changeId].status = "landed";
    const revision = latestRevision(next, changeId);
    if (revision) revision.state = "landed";
  }
  next.lastError = null;
  next.lastMessage = `Landed ${cohort.id} atomically as ${projectRevisionId}; canonical refs are derived after this Project Revision transition.`;
  recordOperation(next, "land", next.lastMessage);
  return next;
}

function rebaseChange(state: State, changeId: string, actor: string): State {
  const change = state.changes[changeId];
  const revision = latestRevision(state, changeId);
  if (!change || !revision) return rejected(state, `Change ${changeId} needs a published Change Revision before rebase.`);
  if (!change.workspaceId || state.workspaces[change.workspaceId].actor !== actor) return rejected(state, `Actor ${actor} cannot rebase ${changeId}'s Workspace.`);
  const next = accepted(state, "rebase", `Rebased ${changeId} onto ${state.project.canonical.id}; stable Change identity preserved and a new revision will be published.`);
  const nextChange = next.changes[changeId];
  const workspace = next.workspaces[nextChange.workspaceId as string];
  workspace.baseProjectRevision = next.project.canonical.id;
  const revisionId = nextId(next, "revision", "revision");
  next.revisions[revision.id].state = "superseded";
  next.revisions[revisionId] = {
    id: revisionId,
    changeId,
    workspaceId: workspace.id,
    baseProjectRevision: workspace.baseProjectRevision,
    sourceSnapshots: {
      community: sourceSnapshot("community", next.project.canonical.snapshots.community, changeId, revisionId),
      "commercial-core": sourceSnapshot("commercial-core", next.project.canonical.snapshots["commercial-core"], changeId, revisionId),
    },
    affectedSpaces: [...revision.affectedSpaces],
    effects: [...revision.effects],
    kind: "rebase",
    parentRevisionId: revision.id,
    state: "published",
  };
  nextChange.revisionIds.push(revisionId);
  nextChange.latestRevisionId = revisionId;
  nextChange.approvals = [];
  nextChange.status = "open";
  return next;
}

function createRevert(state: State, changeId: string, actor: string): State {
  const target = state.changes[changeId];
  const targetRevision = target ? [...target.revisionIds].reverse().map((id) => state.revisions[id]).find((revision) => revision.state === "landed") : null;
  if (!target || !targetRevision) return rejected(state, `No landed revision exists to revert for ${changeId}.`);
  const next = accepted(state, "revert", `Created a new revert Change for ${changeId}; no history was rewritten.`);
  const revertChangeId = `change-revert-${changeId}`;
  if (next.changes[revertChangeId]) return rejected(state, `Revert Change ${revertChangeId} already exists.`);
  const intentId = nextId(next, "intent", "intent");
  next.intents[intentId] = { id: intentId, title: `Revert ${changeId}` };
  next.changes[revertChangeId] = {
    id: revertChangeId,
    intentId,
    status: "open",
    workspaceId: null,
    revisionIds: [],
    latestRevisionId: null,
    approvals: [],
  };
  const workspaceId = nextId(next, "workspace", "workspace");
  next.workspaces[workspaceId] = {
    id: workspaceId,
    changeId: revertChangeId,
    actor,
    baseProjectRevision: next.project.canonical.id,
  };
  next.changes[revertChangeId].workspaceId = workspaceId;
  const revisionId = nextId(next, "revision", "revision");
  next.revisions[revisionId] = {
    id: revisionId,
    changeId: revertChangeId,
    workspaceId,
    baseProjectRevision: next.project.canonical.id,
    sourceSnapshots: clone(next.project.canonical.snapshots),
    affectedSpaces: [...targetRevision.affectedSpaces],
    effects: [`revert:${changeId}`],
    kind: "revert",
    parentRevisionId: targetRevision.id,
    state: "published",
  };
  for (const sourceSpace of targetRevision.affectedSpaces) {
    next.revisions[revisionId].sourceSnapshots[sourceSpace] = targetRevision.sourceSnapshots[sourceSpace];
  }
  next.changes[revertChangeId].revisionIds.push(revisionId);
  next.changes[revertChangeId].latestRevisionId = revisionId;
  next.lastMessage += ` Revert Change ${revertChangeId} is ready for review.`;
  return next;
}

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "intent":
      return createIntent(state, action.changeId, action.title);
    case "workspace":
      return createWorkspace(state, action.changeId, action.actor);
    case "claim":
      return addClaim(state, action.changeId, action.actor, action.scope);
    case "revise":
      return publishRevision(state, action.changeId, action.actor, action.effects);
    case "review":
      return recordReview(state, action.changeId, action.reviewer, action.decision);
    case "cohort":
      return createCohort(state, action.changeIds);
    case "land":
      return landCohort(state, action.cohortId);
    case "rebase":
      return rebaseChange(state, action.changeId, action.actor);
    case "revert":
      return createRevert(state, action.changeId, action.actor);
    case "invalid":
      return rejected(state, action.message);
    case "reset":
      return createInitialState();
  }
}

export { createInitialState };
