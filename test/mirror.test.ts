import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_VERSIONS,
  type Change,
  type GitRef,
  type MirrorOperation,
  type RepositoryMirror,
} from "../src/kernel/contracts.ts";
import {
  MirrorCoordinator,
  MirrorError,
  type MirrorChangeSink,
  type MirrorInboundChangeInput,
  type MirrorProviderResult,
  type MirrorRemoteAdapter,
  type MirrorRemoteCommit,
  type MirrorRemoteState,
  type MirrorRefUpdate,
} from "../src/portability/mirror.ts";

const actor = {
  principalId: "principal:mirror-service",
  actorId: "actor:mirror-service",
  sessionId: "session:mirror",
  clientId: "client:mirror",
};

const projectId = "project:video-player";
const sourceSpaceId = "source:community";

function refs(...entries: readonly [string, string][]): GitRef[] {
  return entries.map(([name, oid]) => ({ name, oid }));
}

function mirror(overrides: Partial<RepositoryMirror> = {}): RepositoryMirror {
  return {
    protocol: CONTRACT_VERSIONS.mirror,
    id: "mirror:github-video",
    projectId,
    sourceSpaceId,
    provider: "github",
    remoteRepository: "wms2537/video-player",
    direction: "bidirectional",
    canonicalAuthority: "anyam",
    refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
    disclosure: "public",
    state: "healthy",
    canonicalProjectRevisionId: "project-revision:initial",
    canonicalRefs: [],
    remoteGeneration: "remote:g0",
    remoteRefs: [],
    pendingInboundChangeIds: [],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    receipt: "fixture=github-mirror; source-space=public",
    ...overrides,
  };
}

function canonical(projectRevisionId: string, mainOid: string, overrides: Partial<Parameters<MirrorCoordinator["sync"]>[0]["canonical"]> = {}) {
  return {
    projectRevisionId,
    sourceSpaceId,
    sourceSpaceClassification: "public" as const,
    disclosure: "public" as const,
    verified: true,
    verificationReceipt: `evidence=verified; revision=${projectRevisionId}`,
    refs: refs(["refs/heads/main", mainOid], ["refs/heads/private-codec", "private-codec-oid"]),
    ...overrides,
  };
}

function update(remoteRef: string, currentOid: string | undefined, kind: MirrorRefUpdate["kind"], previousOid?: string): MirrorRefUpdate {
  return {
    remoteRef,
    ...(previousOid ? { previousOid } : {}),
    ...(currentOid ? { currentOid } : {}),
    kind,
    receipt: `fixture-update; ref=${remoteRef}; kind=${kind}; current=${currentOid ?? "absent"}`,
  };
}

class ScriptedGitHubRemote implements MirrorRemoteAdapter {
  state: MirrorRemoteState;
  readonly pushCalls: Array<{ expectedGeneration: string; desiredRefs: readonly GitRef[]; operationId: string }> = [];
  pushFailure: MirrorProviderResult<MirrorRemoteState> | undefined;
  inspectFailure: MirrorProviderResult<MirrorRemoteState> | undefined;
  private generation = 0;

  constructor(initial: MirrorRemoteState) {
    this.state = initial;
  }

  setState(state: MirrorRemoteState): void {
    this.state = state;
  }

  async inspect(): Promise<MirrorProviderResult<MirrorRemoteState>> {
    if (this.inspectFailure) return this.inspectFailure;
    return {
      status: "succeeded",
      value: {
        ...this.state,
        refs: this.state.refs.map((ref) => ({ ...ref })),
        updates: this.state.updates.map((entry) => ({ ...entry })),
        commits: this.state.commits.map((commit) => ({ ...commit, author: { ...commit.author } })),
      },
    };
  }

  async push(input: Parameters<MirrorRemoteAdapter["push"]>[0]): Promise<MirrorProviderResult<MirrorRemoteState>> {
    this.pushCalls.push({ expectedGeneration: input.expectedGeneration, desiredRefs: input.desiredRefs.map((ref) => ({ ...ref })), operationId: input.operationId });
    if (this.pushFailure) return this.pushFailure;
    if (input.expectedGeneration !== this.state.generation) {
      return {
        status: "failed",
        errorCode: "mirror.remote_generation_stale",
        message: "Remote generation changed before the mirror push.",
        retryable: false,
        affectedObject: input.mirror.remoteRepository,
        recoveryAction: "inspect remote state and choose an explicit reconciliation",
        receipt: `expected=${input.expectedGeneration}; actual=${this.state.generation}`,
      };
    }
    this.generation += 1;
    this.state = {
      generation: `remote:push-${this.generation}`,
      refs: input.desiredRefs.map((ref) => ({ ...ref })),
      updates: input.desiredRefs.map((ref) => update(ref.name, ref.oid, "fast-forward")),
      commits: [],
      originOperationId: input.operationId,
      receipt: `fixture-push; operation=${input.operationId}`,
    };
    return { status: "succeeded", value: this.state };
  }
}

class RecordingChangeSink implements MirrorChangeSink {
  readonly inputs: MirrorInboundChangeInput[] = [];
  readonly changes: Change[] = [];
  failure: MirrorProviderResult<Change> | undefined;

  async createChange(input: MirrorInboundChangeInput): Promise<MirrorProviderResult<Change>> {
    this.inputs.push(input);
    if (this.failure) return this.failure;
    const change: Change = {
      protocol: CONTRACT_VERSIONS.change,
      id: `change:mirror:${input.remoteCommit.oid}`,
      projectId: input.projectId,
      intentId: input.intentId,
      baseProjectRevisionId: input.baseProjectRevisionId,
      status: "submitted",
      latestRevisionId: null,
      origin: { ...input.origin, ...(input.origin.remoteAuthor ? { remoteAuthor: { ...input.origin.remoteAuthor } } : {}) },
    };
    this.changes.push(change);
    return { status: "succeeded", value: change };
  }
}

function remoteState(input: {
  generation: string;
  refs: readonly GitRef[];
  updates: readonly MirrorRefUpdate[];
  commits?: readonly MirrorRemoteCommit[];
  originOperationId?: string;
}): MirrorRemoteState {
  return {
    ...input,
    commits: input.commits ?? [],
    receipt: `fixture-remote; generation=${input.generation}`,
  };
}

function coordinator(remote: ScriptedGitHubRemote, sink = new RecordingChangeSink(), overrides: Partial<RepositoryMirror> = {}) {
  return { coordinator: new MirrorCoordinator({ mirror: mirror(overrides), remote, changeSink: sink, sourceSpaceClassification: "public" }), sink };
}

test("projects only the permitted public refs outbound and preserves loop provenance", async () => {
  const remote = new ScriptedGitHubRemote(remoteState({ generation: "remote:g0", refs: [], updates: [] }));
  const { coordinator: service, sink } = coordinator(remote);
  const first = await service.sync({ canonical: canonical("project-revision:one", "commit:one"), idempotencyKey: "outbound-one", actor });
  assert.equal(first.status, "succeeded");
  if (first.status !== "succeeded") return;
  assert.deepEqual(remote.pushCalls[0]?.desiredRefs, refs(["refs/heads/main", "commit:one"]));
  assert.equal(remote.pushCalls[0]?.desiredRefs.some((ref) => ref.name.includes("private")), false);
  assert.equal(first.value.mirror.state, "healthy");
  assert.equal(first.value.operation.kind, "outbound");
  assert.equal(first.value.mirror.lastOriginOperationId, first.value.operation.id);
  assert.equal(sink.inputs.length, 0);

  const duplicate = await service.sync({ canonical: canonical("project-revision:one", "commit:one"), idempotencyKey: "outbound-one", actor });
  assert.equal(duplicate.status, "succeeded");
  assert.equal(remote.pushCalls.length, 1, "idempotency must not push a second time");

  const reflected = await service.sync({ canonical: canonical("project-revision:one", "commit:one"), idempotencyKey: "reflected-operation", actor });
  assert.equal(reflected.status, "succeeded");
  assert.equal(sink.inputs.length, 0, "an outbound origin must not loop back into an inbound Change");
});

test("turns a remote fast-forward into an attributable Change and waits for Landing", async () => {
  const remote = new ScriptedGitHubRemote(remoteState({ generation: "remote:g0", refs: [], updates: [] }));
  const { coordinator: service, sink } = coordinator(remote);
  const outbound = await service.sync({ canonical: canonical("project-revision:one", "commit:one"), idempotencyKey: "seed", actor });
  assert.equal(outbound.status, "succeeded");
  if (outbound.status !== "succeeded") return;

  const commit: MirrorRemoteCommit = {
    oid: "commit:two",
    ref: "refs/heads/main",
    author: { name: "Public Contributor", email: "contributor@example.test" },
    message: "Improve playback recovery",
    disclosure: "public",
  };
  remote.setState(remoteState({
    generation: "remote:g2",
    refs: refs(["refs/heads/main", "commit:two"]),
    updates: [update("refs/heads/main", "commit:two", "fast-forward", "commit:one")],
    commits: [commit],
  }));
  const inbound = await service.sync({ canonical: canonical("project-revision:one", "commit:one"), idempotencyKey: "inbound-two", actor });
  assert.equal(inbound.status, "succeeded");
  if (inbound.status !== "succeeded") return;
  assert.equal(inbound.value.mirror.state, "lagging");
  assert.equal(inbound.value.inboundChanges.length, 1);
  assert.equal(inbound.value.inboundChanges[0]?.origin?.kind, "mirror");
  assert.equal(inbound.value.inboundChanges[0]?.origin?.source, "github");
  assert.equal(inbound.value.inboundChanges[0]?.origin?.remoteRepository, "wms2537/video-player");
  assert.equal(inbound.value.inboundChanges[0]?.origin?.remoteRef, "refs/heads/main");
  assert.equal(inbound.value.inboundChanges[0]?.origin?.remoteCommit, "commit:two");
  assert.equal(inbound.value.inboundChanges[0]?.origin?.disclosure, "public");
  assert.equal(inbound.value.inboundChanges[0]?.origin?.remoteAuthor?.email, "contributor@example.test");
  assert.equal(inbound.value.checkpoint.recoveryAction, "Land the pending inbound Changes, then resume Mirror sync");
  assert.equal(sink.inputs[0]?.baseProjectRevisionId, "project-revision:one");

  const afterLanding = await service.sync({ canonical: canonical("project-revision:two", "commit:two"), idempotencyKey: "after-landing", actor });
  assert.equal(afterLanding.status, "succeeded");
  if (afterLanding.status !== "succeeded") return;
  assert.equal(afterLanding.value.mirror.state, "healthy");
  assert.deepEqual(afterLanding.value.mirror.pendingInboundChangeIds, []);
});

test("makes force-push and divergence durable, then requires explicit reconciliation", async () => {
  const remote = new ScriptedGitHubRemote(remoteState({
    generation: "remote:g1",
    refs: refs(["refs/heads/main", "commit:one"]),
    updates: [],
  }));
  const { coordinator: service, sink } = coordinator(remote, new RecordingChangeSink(), { canonicalProjectRevisionId: "project-revision:one", canonicalRefs: refs(["refs/heads/main", "commit:one"]), remoteGeneration: "remote:g1", remoteRefs: refs(["refs/heads/main", "commit:one"]) });
  remote.setState(remoteState({
    generation: "remote:rewritten",
    refs: refs(["refs/heads/main", "commit:rewritten"]),
    updates: [update("refs/heads/main", "commit:rewritten", "force-push", "commit:one")],
    commits: [{ oid: "commit:rewritten", ref: "refs/heads/main", author: { name: "Remote Maintainer" }, disclosure: "public" }],
  }));
  const force = await service.sync({ canonical: canonical("project-revision:one", "commit:one"), idempotencyKey: "force", actor });
  assert.equal(force.status, "failed");
  if (force.status !== "failed") return;
  assert.equal(force.errorCode, "mirror.force_push_detected");
  assert.equal(force.mirror.state, "force-pushed");
  assert.equal(force.checkpoint.state, "blocked");

  const stillBlocked = await service.resume({ checkpointId: force.checkpoint.id, canonical: canonical("project-revision:one", "commit:one"), idempotencyKey: "force-without-choice", actor });
  assert.equal(stillBlocked.status, "failed");
  if (stillBlocked.status !== "failed") return;
  assert.equal(stillBlocked.errorCode, "mirror.reconciliation_required");

  const proposed = await service.resume({ checkpointId: force.checkpoint.id, canonical: canonical("project-revision:one", "commit:one"), idempotencyKey: "force-as-proposal", actor, reconciliation: "remote-as-proposal" });
  assert.equal(proposed.status, "succeeded");
  if (proposed.status !== "succeeded") return;
  assert.equal(proposed.value.mirror.state, "lagging");
  assert.equal(proposed.value.inboundChanges[0]?.origin?.remoteCommit, "commit:rewritten");
  assert.equal(sink.inputs.length, 1);

  const divergentRemote = new ScriptedGitHubRemote(remoteState({
    generation: "remote:baseline",
    refs: refs(["refs/heads/main", "commit:one"]),
    updates: [],
  }));
  const { coordinator: divergentService } = coordinator(divergentRemote, new RecordingChangeSink(), {
    canonicalProjectRevisionId: "project-revision:one",
    canonicalRefs: refs(["refs/heads/main", "commit:one"]),
    remoteGeneration: "remote:baseline",
    remoteRefs: refs(["refs/heads/main", "commit:one"]),
  });
  divergentRemote.setState(remoteState({
    generation: "remote:divergent",
    refs: refs(["refs/heads/main", "commit:remote"]),
    updates: [update("refs/heads/main", "commit:remote", "fast-forward", "commit:one")],
    commits: [{ oid: "commit:remote", ref: "refs/heads/main", author: { name: "Remote Maintainer" }, disclosure: "public" }],
  }));
  const divergence = await divergentService.sync({ canonical: canonical("project-revision:local", "commit:local"), idempotencyKey: "divergence", actor });
  assert.equal(divergence.status, "failed");
  if (divergence.status !== "failed") return;
  assert.equal(divergence.errorCode, "mirror.divergence_detected");
  assert.equal(divergence.mirror.state, "divergent");
  const canonicalWins = await divergentService.resume({ checkpointId: divergence.checkpoint.id, canonical: canonical("project-revision:local", "commit:local"), idempotencyKey: "divergence-canonical-wins", actor, reconciliation: "canonical-wins" });
  assert.equal(canonicalWins.status, "succeeded");
  if (canonicalWins.status !== "succeeded") return;
  assert.equal(canonicalWins.value.mirror.state, "healthy");
});

test("surfaces credential failure and resumes outbound sync from the checkpoint", async () => {
  const remote = new ScriptedGitHubRemote(remoteState({ generation: "remote:g0", refs: [], updates: [] }));
  remote.pushFailure = {
    status: "failed",
    errorCode: "mirror.auth_failed",
    message: "GitHub credential rejected.",
    retryable: true,
    affectedObject: "wms2537/video-player",
    recoveryAction: "rotate the GitHub App installation credential and resume the checkpoint",
    receipt: "provider=github; credential=invalid",
  };
  const { coordinator: service } = coordinator(remote);
  const failed = await service.sync({ canonical: canonical("project-revision:one", "commit:one"), idempotencyKey: "credential-failure", actor });
  assert.equal(failed.status, "failed");
  if (failed.status !== "failed") return;
  assert.equal(failed.mirror.state, "credential-failed");
  assert.equal(failed.operation.state, "blocked");
  assert.equal(failed.budget.name, "mirror-ref-reconciliation");
  remote.pushFailure = undefined;
  const resumed = await service.resume({ checkpointId: failed.checkpoint.id, canonical: canonical("project-revision:one", "commit:one"), idempotencyKey: "credential-recovery", actor });
  assert.equal(resumed.status, "succeeded");
  if (resumed.status !== "succeeded") return;
  assert.equal(resumed.value.mirror.state, "healthy");
  assert.equal(resumed.value.mirror.canonicalProjectRevisionId, "project-revision:one");
  assert.equal(service.listCheckpoints().length, 2);
});

test("rejects public Mirrors and inbound commits that cross the Disclosure boundary", async () => {
  const remote = new ScriptedGitHubRemote(remoteState({ generation: "remote:g0", refs: [], updates: [] }));
  const sink = new RecordingChangeSink();
  assert.throws(() => new MirrorCoordinator({ mirror: mirror(), remote, changeSink: sink, sourceSpaceClassification: "restricted" }), (error: unknown) => error instanceof MirrorError && error.code === "mirror.disclosure_violation");

  const { coordinator: service } = coordinator(remote, sink);
  const invalidCanonical = await service.sync({ canonical: canonical("project-revision:private", "private-head", { sourceSpaceClassification: "restricted", disclosure: "restricted" }), idempotencyKey: "private-canonical", actor });
  assert.equal(invalidCanonical.status, "failed");
  if (invalidCanonical.status !== "failed") return;
  assert.equal(invalidCanonical.errorCode, "mirror.disclosure_violation");

  const freshRemote = new ScriptedGitHubRemote(remoteState({ generation: "remote:g1", refs: refs(["refs/heads/main", "commit:one"]), updates: [] }));
  const { coordinator: restrictedCommitService, sink: restrictedSink } = coordinator(freshRemote);
  const seeded = await restrictedCommitService.sync({ canonical: canonical("project-revision:one", "commit:one"), idempotencyKey: "seed-public", actor });
  assert.equal(seeded.status, "succeeded");
  freshRemote.setState(remoteState({
    generation: "remote:g2",
    refs: refs(["refs/heads/main", "private-commit"]),
    updates: [update("refs/heads/main", "private-commit", "fast-forward", "commit:one")],
    commits: [{ oid: "private-commit", ref: "refs/heads/main", author: { name: "Private Maintainer" }, disclosure: "restricted" }],
  }));
  const restricted = await restrictedCommitService.sync({ canonical: canonical("project-revision:one", "commit:one"), idempotencyKey: "restricted-remote", actor });
  assert.equal(restricted.status, "failed");
  if (restricted.status !== "failed") return;
  assert.equal(restricted.errorCode, "mirror.inbound_disclosure_violation");
  assert.equal(restrictedSink.inputs.length, 0);
});
