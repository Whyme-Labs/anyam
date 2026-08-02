import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  type ActorRef,
  type Change,
  type ChangeOrigin,
  type DisclosureClassification,
  type GitRef,
  type MirrorCheckpoint,
  type MirrorOperation,
  type MirrorRefMapping,
  type MirrorState,
  type RepositoryMirror,
  type SourceSpaceClassification,
} from "../kernel/contracts.ts";

/** A commit observed at a remote ref. The adapter may omit the message when
 * the provider does not expose it, but it must identify the commit and author
 * before Anyam can create an inbound Change. */
export type MirrorRemoteCommit = {
  oid: string;
  ref: string;
  author: { name: string; email?: string };
  message?: string;
  disclosure: DisclosureClassification;
  originOperationId?: string;
};

export type MirrorRefUpdate = {
  remoteRef: string;
  previousOid?: string;
  currentOid?: string;
  kind: "unchanged" | "created" | "fast-forward" | "force-push" | "deleted";
  originOperationId?: string;
  receipt: string;
};

export type MirrorRemoteState = {
  generation: string;
  refs: readonly GitRef[];
  updates: readonly MirrorRefUpdate[];
  commits: readonly MirrorRemoteCommit[];
  originOperationId?: string;
  receipt: string;
};

export type MirrorProviderFailure = {
  status: "failed";
  errorCode: string;
  message: string;
  retryable: boolean;
  affectedObject: string;
  recoveryAction: string;
  receipt: string;
  remoteMayHaveChanged?: boolean;
};

export type MirrorProviderResult<T> =
  | { status: "succeeded"; value: T }
  | MirrorProviderFailure;

/** Provider mechanics only. This adapter never receives canonical authority. */
export type MirrorRemoteAdapter = {
  inspect(input: {
    mirror: RepositoryMirror;
    knownRefs: readonly GitRef[];
    knownGeneration: string;
  }): Promise<MirrorProviderResult<MirrorRemoteState>>;
  push(input: {
    mirror: RepositoryMirror;
    expectedGeneration: string;
    expectedRefs: readonly GitRef[];
    desiredRefs: readonly GitRef[];
    operationId: string;
    idempotencyKey: string;
  }): Promise<MirrorProviderResult<MirrorRemoteState>>;
};

export type MirrorCanonicalState = {
  projectRevisionId: string;
  sourceSpaceId: string;
  sourceSpaceClassification: SourceSpaceClassification;
  disclosure: DisclosureClassification;
  verified: boolean;
  verificationReceipt: string;
  refs: readonly GitRef[];
};

export type MirrorInboundChangeInput = {
  projectId: string;
  sourceSpaceId: string;
  baseProjectRevisionId: string;
  intentId: string;
  title: string;
  localRef: string;
  remoteCommit: MirrorRemoteCommit;
  origin: ChangeOrigin;
};

/** The Change context owns Intent/Workspace creation; the mirror only supplies
 * a fully attributable proposal and verifies the returned Change provenance. */
export type MirrorChangeSink = {
  createChange(input: MirrorInboundChangeInput): Promise<MirrorProviderResult<Change>>;
};

export type MirrorReconciliation = "remote-as-proposal" | "canonical-wins";

export type MirrorSyncInput = {
  canonical: MirrorCanonicalState;
  idempotencyKey: string;
  actor?: ActorRef;
  reconciliation?: MirrorReconciliation;
  resumeCheckpointId?: string;
};

export type MirrorSyncValue = {
  mirror: RepositoryMirror;
  operation: MirrorOperation;
  checkpoint: MirrorCheckpoint;
  inboundChanges: readonly Change[];
};

export type MirrorSyncFailure = MirrorProviderFailure & {
  mirror: RepositoryMirror;
  operation: MirrorOperation;
  checkpoint: MirrorCheckpoint;
  budget: {
    name: string;
    limit: string;
    asked: string;
    receipt: string;
  };
};

export type MirrorSyncResult =
  | { status: "succeeded"; value: MirrorSyncValue }
  | MirrorSyncFailure;

export class MirrorError extends Error {
  readonly code: string;
  readonly affectedObject: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: string; message: string; affectedObject: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "MirrorError";
    this.code = input.code;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${digest(value)}`;
}

function nonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new MirrorError({
      code: "mirror.invalid_input",
      message: `${field} must not be empty.`,
      affectedObject: field,
      recoveryAction: `provide a non-empty ${field} and retry the mirror operation`,
      receipt: `field=${field}; present=false`,
    });
  }
}

function disclosureRank(value: DisclosureClassification): number {
  return value === "public" ? 0 : value === "project" ? 1 : 2;
}

function disclosureAllows(mirrorDisclosure: DisclosureClassification, observed: DisclosureClassification): boolean {
  return disclosureRank(observed) <= disclosureRank(mirrorDisclosure);
}

function refsMap(refs: readonly GitRef[]): Map<string, string> {
  return new Map(refs.map((ref) => [ref.name, ref.oid]));
}

function refsEqual(left: readonly GitRef[], right: readonly GitRef[]): boolean {
  if (left.length !== right.length) return false;
  const rightMap = refsMap(right);
  return left.every((ref) => rightMap.get(ref.name) === ref.oid);
}

function cloneMirror(mirror: RepositoryMirror): RepositoryMirror {
  return {
    ...mirror,
    refMappings: mirror.refMappings.map((mapping) => ({ ...mapping })),
    canonicalRefs: mirror.canonicalRefs.map((ref) => ({ ...ref })),
    remoteRefs: mirror.remoteRefs.map((ref) => ({ ...ref })),
    pendingInboundChangeIds: [...mirror.pendingInboundChangeIds],
  };
}

function cloneOperation(operation: MirrorOperation): MirrorOperation {
  return {
    ...operation,
    ...(operation.actor ? { actor: { ...operation.actor } } : {}),
    inboundChangeIds: [...operation.inboundChangeIds],
  };
}

function cloneCheckpoint(checkpoint: MirrorCheckpoint): MirrorCheckpoint {
  return {
    ...checkpoint,
    canonicalRefs: checkpoint.canonicalRefs.map((ref) => ({ ...ref })),
    remoteRefs: checkpoint.remoteRefs.map((ref) => ({ ...ref })),
    completedInboundChangeIds: [...checkpoint.completedInboundChangeIds],
  };
}

function cloneResult(result: MirrorSyncResult): MirrorSyncResult {
  return result.status === "succeeded"
    ? {
      status: "succeeded",
      value: {
        mirror: cloneMirror(result.value.mirror),
        operation: cloneOperation(result.value.operation),
        checkpoint: cloneCheckpoint(result.value.checkpoint),
        inboundChanges: result.value.inboundChanges.map(clone),
      },
    }
    : {
      ...result,
      mirror: cloneMirror(result.mirror),
      operation: cloneOperation(result.operation),
      checkpoint: cloneCheckpoint(result.checkpoint),
      budget: { ...result.budget },
    };
}

function projectCanonicalRefs(canonical: MirrorCanonicalState, mappings: readonly MirrorRefMapping[]): GitRef[] {
  const local = refsMap(canonical.refs);
  const projected: GitRef[] = [];
  for (const mapping of mappings) {
    const oid = local.get(mapping.localRef);
    if (oid !== undefined) projected.push({ name: mapping.remoteRef, oid });
  }
  return projected.sort((left, right) => left.name.localeCompare(right.name));
}

function allowedRemoteRefs(refs: readonly GitRef[], mappings: readonly MirrorRefMapping[]): GitRef[] {
  const names = new Set(mappings.map((mapping) => mapping.remoteRef));
  return refs.filter((ref) => names.has(ref.name)).map((ref) => ({ ...ref })).sort((left, right) => left.name.localeCompare(right.name));
}

function mappingForRemote(remoteRef: string, mappings: readonly MirrorRefMapping[]): MirrorRefMapping | undefined {
  return mappings.find((mapping) => mapping.remoteRef === remoteRef);
}

function operationKind(input: MirrorSyncInput): MirrorOperation["kind"] {
  return input.reconciliation ? "reconcile" : "sync";
}

function classifyProviderState(failure: MirrorProviderFailure, remoteMayHaveChanged = false): MirrorState {
  if (/credential|auth|token|permission|forbidden/i.test(failure.errorCode)) return "credential-failed";
  if (remoteMayHaveChanged || failure.remoteMayHaveChanged) return "divergent";
  return failure.retryable ? "lagging" : "blocked";
}

export class MirrorCoordinator {
  private mirror: RepositoryMirror;
  private readonly remote: MirrorRemoteAdapter;
  private readonly changeSink: MirrorChangeSink;
  private readonly sourceSpaceClassification: SourceSpaceClassification;
  private readonly now: () => string;
  private readonly operations = new Map<string, MirrorOperation>();
  private readonly checkpoints = new Map<string, MirrorCheckpoint>();
  private readonly idempotency = new Map<string, MirrorSyncResult>();
  private readonly inboundChangeIds = new Map<string, string>();

  constructor(input: {
    mirror: RepositoryMirror;
    remote: MirrorRemoteAdapter;
    changeSink: MirrorChangeSink;
    sourceSpaceClassification: SourceSpaceClassification;
    now?: () => string;
  }) {
    nonEmpty(input.mirror.id, "mirror.id");
    nonEmpty(input.mirror.projectId, "mirror.projectId");
    nonEmpty(input.mirror.sourceSpaceId, "mirror.sourceSpaceId");
    nonEmpty(input.mirror.remoteRepository, "mirror.remoteRepository");
    if (input.mirror.direction !== "bidirectional") {
      throw new MirrorError({
        code: "mirror.direction_unsupported",
        message: "Only bidirectional Repository Mirrors are supported by this coordinator.",
        affectedObject: input.mirror.id,
        recoveryAction: "configure a bidirectional Mirror or install a provider-specific adapter",
        receipt: `mirror=${input.mirror.id}; direction=${input.mirror.direction}`,
      });
    }
    const localRefs = new Set<string>();
    const remoteRefs = new Set<string>();
    for (const mapping of input.mirror.refMappings) {
      nonEmpty(mapping.localRef, "mirror.refMappings.localRef");
      nonEmpty(mapping.remoteRef, "mirror.refMappings.remoteRef");
      if (localRefs.has(mapping.localRef) || remoteRefs.has(mapping.remoteRef)) {
        throw new MirrorError({
          code: "mirror.ref_mapping_duplicate",
          message: `Mirror ${input.mirror.id} maps one local or remote ref more than once.`,
          affectedObject: input.mirror.id,
          recoveryAction: "configure one unambiguous local-to-remote ref mapping per permitted ref",
          receipt: `mirror=${input.mirror.id}; local=${mapping.localRef}; remote=${mapping.remoteRef}`,
        });
      }
      localRefs.add(mapping.localRef);
      remoteRefs.add(mapping.remoteRef);
    }
    if (input.mirror.disclosure === "public" && input.sourceSpaceClassification !== "public") {
      throw new MirrorError({
        code: "mirror.disclosure_violation",
        message: `Public Mirror ${input.mirror.id} cannot map a non-public Source Space.`,
        affectedObject: input.mirror.sourceSpaceId,
        recoveryAction: "map only a public Source Space or lower the Mirror disclosure policy",
        receipt: `mirror=${input.mirror.id}; disclosure=${input.mirror.disclosure}; sourceClassification=${input.sourceSpaceClassification}`,
      });
    }
    this.mirror = cloneMirror(input.mirror);
    this.remote = input.remote;
    this.changeSink = input.changeSink;
    this.sourceSpaceClassification = input.sourceSpaceClassification;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  get repositoryMirror(): RepositoryMirror {
    return cloneMirror(this.mirror);
  }

  listOperations(): readonly MirrorOperation[] {
    return [...this.operations.values()].map(cloneOperation);
  }

  listCheckpoints(): readonly MirrorCheckpoint[] {
    return [...this.checkpoints.values()].map(cloneCheckpoint);
  }

  getCheckpoint(checkpointId: string): MirrorCheckpoint | undefined {
    const checkpoint = this.checkpoints.get(checkpointId);
    return checkpoint ? cloneCheckpoint(checkpoint) : undefined;
  }

  async resume(input: MirrorSyncInput & { checkpointId: string }): Promise<MirrorSyncResult> {
    const checkpoint = this.checkpoints.get(input.checkpointId);
    if (!checkpoint || checkpoint.mirrorId !== this.mirror.id) {
      throw new MirrorError({
        code: "mirror.checkpoint_not_found",
        message: `Mirror checkpoint ${input.checkpointId} is not known for ${this.mirror.id}.`,
        affectedObject: input.checkpointId,
        recoveryAction: "inspect the Mirror checkpoints and resume from a known checkpoint",
        receipt: `mirror=${this.mirror.id}; checkpoint=${input.checkpointId}; known=false`,
      });
    }
    return this.sync({ ...input, resumeCheckpointId: checkpoint.id });
  }

  async sync(input: MirrorSyncInput): Promise<MirrorSyncResult> {
    nonEmpty(input.idempotencyKey, "mirror.idempotencyKey");
    const previous = this.idempotency.get(input.idempotencyKey);
    if (previous) return cloneResult(previous);
    const projectedCanonical = projectCanonicalRefs(input.canonical, this.mirror.refMappings);
    const operationId = stableId("mirror-operation", { mirrorId: this.mirror.id, idempotencyKey: input.idempotencyKey });
    const checkpointId = stableId("mirror-checkpoint", { operationId, state: "preflight" });
    const operation: MirrorOperation = {
      protocol: CONTRACT_VERSIONS.mirrorOperation,
      id: operationId,
      mirrorId: this.mirror.id,
      kind: operationKind(input),
      state: "started",
      canonicalProjectRevisionId: input.canonical.projectRevisionId,
      expectedRemoteGeneration: this.mirror.remoteGeneration,
      ...(input.actor ? { actor: { ...input.actor } } : {}),
      inboundChangeIds: [],
      checkpointId,
      createdAt: this.now(),
      receipt: `mirror=sync-started; id=${operationId}; canonical=${input.canonical.projectRevisionId}; resume=${input.resumeCheckpointId ?? "none"}`,
    };
    let checkpoint: MirrorCheckpoint = {
      protocol: CONTRACT_VERSIONS.mirrorCheckpoint,
      id: checkpointId,
      mirrorId: this.mirror.id,
      operationId,
      state: "preflight",
      canonicalProjectRevisionId: input.canonical.projectRevisionId,
      canonicalRefs: projectedCanonical,
      remoteGeneration: this.mirror.remoteGeneration,
      remoteRefs: this.mirror.remoteRefs.map((ref) => ({ ...ref })),
      completedInboundChangeIds: [],
      recoveryAction: "resume the same Mirror operation after fixing the named blocked condition",
      receipt: `mirror=${this.mirror.id}; checkpoint=${checkpointId}; state=preflight`,
    };
    this.operations.set(operation.id, operation);
    this.checkpoints.set(checkpoint.id, checkpoint);

    const invalidCanonical = this.validateCanonical(input.canonical);
    if (invalidCanonical) return this.fail(input, operation, checkpoint, invalidCanonical, "blocked");

    let inspected: MirrorProviderResult<MirrorRemoteState>;
    try {
      inspected = await this.remote.inspect({ mirror: cloneMirror(this.mirror), knownRefs: this.mirror.remoteRefs, knownGeneration: this.mirror.remoteGeneration });
    } catch (error) {
      inspected = {
        status: "failed",
        errorCode: "mirror.inspect_exception",
        message: `Mirror inspection threw ${error instanceof Error ? error.name : "an unknown error"}.`,
        retryable: true,
        affectedObject: this.mirror.remoteRepository,
        recoveryAction: "inspect the provider and resume from the recorded checkpoint",
        receipt: `mirror=${this.mirror.id}; operation=${operation.id}; exception=${error instanceof Error ? error.name : "unknown"}`,
      };
    }
    if (inspected.status !== "succeeded") return this.fail(input, operation, checkpoint, inspected, classifyProviderState(inspected));
    const remoteState = inspected.value;
    if (remoteState.generation.trim().length === 0 || remoteState.receipt.trim().length === 0) {
      return this.fail(input, operation, checkpoint, {
        status: "failed",
        errorCode: "mirror.remote_receipt_missing",
        message: "Mirror provider returned remote state without a generation or receipt.",
        retryable: false,
        affectedObject: this.mirror.remoteRepository,
        recoveryAction: "fix the provider adapter to return a verifiable remote generation and receipt",
        receipt: `mirror=${this.mirror.id}; generation=${remoteState.generation || "missing"}; providerReceipt=${remoteState.receipt || "missing"}`,
      }, "blocked");
    }
    const remoteRefs = allowedRemoteRefs(remoteState.refs, this.mirror.refMappings);
    const updates = remoteState.updates.filter((update) => mappingForRemote(update.remoteRef, this.mirror.refMappings) !== undefined);
    const remoteRefsChanged = !refsEqual(remoteRefs, this.mirror.remoteRefs);
    const reflected = remoteState.originOperationId !== undefined
      && remoteState.originOperationId === this.mirror.lastOriginOperationId
      && refsEqual(remoteRefs, projectedCanonical);
    const remoteChanged = !reflected && (remoteRefsChanged || remoteState.generation !== this.mirror.remoteGeneration);
    const canonicalRefsChanged = !refsEqual(projectedCanonical, this.mirror.canonicalRefs);
    const canonicalChanged = input.canonical.projectRevisionId !== this.mirror.canonicalProjectRevisionId || canonicalRefsChanged;
    const forceUpdates = updates.filter((update) => update.kind === "force-push" || update.kind === "deleted");
    checkpoint = {
      ...checkpoint,
      state: "remote-inspected",
      remoteGeneration: remoteState.generation,
      remoteRefs,
      receipt: `${checkpoint.receipt}; state=remote-inspected; remote=${remoteState.generation}; remoteChanged=${remoteChanged}; canonicalChanged=${canonicalChanged}`,
    };
    this.checkpoints.set(checkpoint.id, checkpoint);

    if ((this.mirror.state === "force-pushed" || this.mirror.state === "divergent") && !input.reconciliation) {
      return this.fail(input, operation, checkpoint, this.reconciliationFailure("mirror.reconciliation_required", "Mirror remains in a durable reconciliation state.", "choose remote-as-proposal or canonical-wins explicitly before resuming", `mirror=${this.mirror.id}; state=${this.mirror.state}`), "blocked", remoteState.generation);
    }
    if (forceUpdates.length > 0 && input.reconciliation !== "remote-as-proposal" && input.reconciliation !== "canonical-wins") {
      return this.fail(input, operation, checkpoint, this.reconciliationFailure("mirror.force_push_detected", "The remote rewrote or deleted a permitted ref.", "inspect the remote rewrite, then resume with an explicit reconciliation choice", `mirror=${this.mirror.id}; refs=${forceUpdates.map((update) => `${update.remoteRef}:${update.kind}`).join(",")}`), "blocked", remoteState.generation, "force-pushed");
    }

    if (refsEqual(projectedCanonical, remoteRefs) && (remoteChanged || canonicalChanged || this.mirror.pendingInboundChangeIds.length > 0)) {
      return this.succeed(input, operation, checkpoint, {
        state: "healthy",
        canonicalProjectRevisionId: input.canonical.projectRevisionId,
        canonicalRefs: projectedCanonical,
        remoteGeneration: remoteState.generation,
        remoteRefs,
        pendingInboundChangeIds: [],
        ...(remoteState.originOperationId ? { lastOriginOperationId: remoteState.originOperationId } : {}),
      }, []);
    }

    if (this.mirror.pendingInboundChangeIds.length > 0 && canonicalChanged && !refsEqual(projectedCanonical, remoteRefs) && input.reconciliation !== "canonical-wins") {
      return this.fail(input, operation, checkpoint, this.reconciliationFailure("mirror.pending_inbound_changes", "Inbound Changes are waiting for Landing before outbound synchronization can advance the remote.", "Land or abandon the pending inbound Changes, then retry Mirror sync", `mirror=${this.mirror.id}; pending=${this.mirror.pendingInboundChangeIds.join(",")}`), "blocked", remoteState.generation);
    }

    if (remoteChanged && canonicalChanged && !refsEqual(projectedCanonical, remoteRefs) && !input.reconciliation) {
      return this.fail(input, operation, checkpoint, this.reconciliationFailure("mirror.divergence_detected", "Canonical and remote refs changed from the last accepted Mirror boundary.", "inspect both Change proposals and choose remote-as-proposal or canonical-wins", `mirror=${this.mirror.id}; canonicalRevision=${input.canonical.projectRevisionId}; remoteGeneration=${remoteState.generation}`), "blocked", remoteState.generation, "divergent");
    }

    const shouldProposeRemote = (remoteChanged && !refsEqual(projectedCanonical, remoteRefs)) || input.reconciliation === "remote-as-proposal";
    if (shouldProposeRemote && input.reconciliation !== "canonical-wins") {
      return this.processInbound(input, operation, checkpoint, remoteState, remoteRefs, updates, projectedCanonical);
    }

    const shouldPushCanonical = (canonicalChanged && !refsEqual(projectedCanonical, remoteRefs)) || input.reconciliation === "canonical-wins";
    if (shouldPushCanonical) {
      return this.processOutbound(input, operation, checkpoint, remoteState, remoteRefs, projectedCanonical);
    }

    return this.succeed(input, operation, checkpoint, {
      state: "healthy",
      canonicalProjectRevisionId: input.canonical.projectRevisionId,
      canonicalRefs: projectedCanonical,
      remoteGeneration: remoteState.generation,
      remoteRefs,
      pendingInboundChangeIds: [...this.mirror.pendingInboundChangeIds],
    }, []);
  }

  private validateCanonical(canonical: MirrorCanonicalState): MirrorProviderFailure | undefined {
    nonEmpty(canonical.projectRevisionId, "canonical.projectRevisionId");
    nonEmpty(canonical.sourceSpaceId, "canonical.sourceSpaceId");
    nonEmpty(canonical.verificationReceipt, "canonical.verificationReceipt");
    if (canonical.sourceSpaceId !== this.mirror.sourceSpaceId) {
      return this.reconciliationFailure("mirror.source_space_mismatch", "Canonical state names a different Source Space than the Mirror.", "read the canonical state for the mapped Source Space and retry", `mirror=${this.mirror.id}; expected=${this.mirror.sourceSpaceId}; actual=${canonical.sourceSpaceId}`);
    }
    // Apply the public boundary before the internal binding check. A public
    // mirror must fail closed with the disclosure-specific receipt whenever a
    // caller presents any non-public projection, even if its classification
    // also differs from the coordinator's current Source Space binding.
    if (this.mirror.disclosure === "public" && (canonical.sourceSpaceClassification !== "public" || canonical.disclosure !== "public")) {
      return this.reconciliationFailure("mirror.disclosure_violation", "A public Mirror may receive only a public Source Space projection.", "select a public Source Space and public Disclosure Projection for this Mirror", `mirror=${this.mirror.id}; sourceClassification=${canonical.sourceSpaceClassification}; disclosure=${canonical.disclosure}`);
    }
    if (canonical.sourceSpaceClassification !== this.sourceSpaceClassification) {
      return this.reconciliationFailure("mirror.source_space_classification_mismatch", "Canonical state does not match the Source Space classification bound to the Mirror.", "refresh the Source Space policy and retry with its current Disclosure Projection", `mirror=${this.mirror.id}; configured=${this.sourceSpaceClassification}; actual=${canonical.sourceSpaceClassification}`);
    }
    if (!canonical.verified) {
      return this.reconciliationFailure("mirror.unverified_canonical", "Outbound mirroring requires a verified canonical Project Revision.", "run the required verification and supply its receipt before mirroring", `mirror=${this.mirror.id}; projectRevision=${canonical.projectRevisionId}; verified=false`);
    }
    if (!disclosureAllows(this.mirror.disclosure, canonical.disclosure)) {
      return this.reconciliationFailure("mirror.disclosure_violation", "Canonical Disclosure exceeds the Mirror's permitted Disclosure.", "use a narrower Project View or configure a matching Mirror policy", `mirror=${this.mirror.id}; mirrorDisclosure=${this.mirror.disclosure}; canonicalDisclosure=${canonical.disclosure}`);
    }
    return undefined;
  }

  private reconciliationFailure(errorCode: string, message: string, recoveryAction: string, receipt: string): MirrorProviderFailure {
    return { status: "failed", errorCode, message, retryable: false, affectedObject: this.mirror.id, recoveryAction, receipt };
  }

  private async processInbound(
    input: MirrorSyncInput,
    operation: MirrorOperation,
    checkpoint: MirrorCheckpoint,
    remoteState: MirrorRemoteState,
    remoteRefs: readonly GitRef[],
    updates: readonly MirrorRefUpdate[],
    projectedCanonical: readonly GitRef[],
  ): Promise<MirrorSyncResult> {
    const inboundChanges: Change[] = [];
    const completed = new Set(checkpoint.completedInboundChangeIds);
    const relevantUpdates = updates.filter((update) => update.kind !== "unchanged" && update.currentOid !== undefined);
    if (relevantUpdates.length === 0) {
      return this.fail(input, operation, checkpoint, this.reconciliationFailure("mirror.inbound_commit_missing", "The remote changed but supplied no attributable commit update.", "fix the provider adapter to return the changed commit, ref, author, and receipt", `mirror=${this.mirror.id}; remote=${remoteState.generation}`), "blocked", remoteState.generation);
    }
    for (const update of relevantUpdates) {
      const mapping = mappingForRemote(update.remoteRef, this.mirror.refMappings);
      if (!mapping) continue;
      const remoteCommit = remoteState.commits.find((commit) => commit.ref === update.remoteRef && commit.oid === update.currentOid);
      if (!remoteCommit) {
        return this.fail(input, operation, { ...checkpoint, state: "inbound-proposals", completedInboundChangeIds: [...completed] }, this.reconciliationFailure("mirror.inbound_commit_missing", "The remote ref update has no matching commit provenance.", "fetch and expose the exact remote commit author, ref, OID, disclosure, and receipt", `mirror=${this.mirror.id}; ref=${update.remoteRef}; oid=${update.currentOid}`), "blocked", remoteState.generation);
      }
      if (!disclosureAllows(this.mirror.disclosure, remoteCommit.disclosure)) {
        return this.fail(input, operation, { ...checkpoint, state: "inbound-proposals", completedInboundChangeIds: [...completed] }, this.reconciliationFailure("mirror.inbound_disclosure_violation", "The remote commit's Disclosure exceeds the Mirror policy.", "quarantine the remote ref and create a narrower public proposal", `mirror=${this.mirror.id}; ref=${remoteCommit.ref}; oid=${remoteCommit.oid}; disclosure=${remoteCommit.disclosure}`), "blocked", remoteState.generation);
      }
      const proposalKey = `${this.mirror.id}:${remoteCommit.ref}:${remoteCommit.oid}`;
      const knownChangeId = this.inboundChangeIds.get(proposalKey);
      if (knownChangeId) {
        completed.add(knownChangeId);
        continue;
      }
      const origin: ChangeOrigin = {
        kind: "mirror",
        source: this.mirror.provider,
        mirrorId: this.mirror.id,
        remoteRepository: this.mirror.remoteRepository,
        remoteRef: remoteCommit.ref,
        remoteCommit: remoteCommit.oid,
        remoteAuthor: { ...remoteCommit.author },
        disclosure: remoteCommit.disclosure,
        receipt: `mirror=${this.mirror.id}; remote=${this.mirror.remoteRepository}; ref=${remoteCommit.ref}; commit=${remoteCommit.oid}; providerReceipt=${remoteState.receipt}`,
      };
      const proposal: MirrorInboundChangeInput = {
        projectId: this.mirror.projectId,
        sourceSpaceId: this.mirror.sourceSpaceId,
        baseProjectRevisionId: input.canonical.projectRevisionId,
        intentId: stableId("intent:mirror", proposalKey),
        title: remoteCommit.message?.split("\n", 1)[0] ?? `Remote change ${remoteCommit.oid}`,
        localRef: mapping.localRef,
        remoteCommit,
        origin,
      };
      let created: MirrorProviderResult<Change>;
      try {
        created = await this.changeSink.createChange(proposal);
      } catch (error) {
        created = {
          status: "failed",
          errorCode: "mirror.change_sink_exception",
          message: `Inbound Change creation threw ${error instanceof Error ? error.name : "an unknown error"}.`,
          retryable: true,
          affectedObject: remoteCommit.oid,
          recoveryAction: "resume the Mirror checkpoint after fixing the Change coordinator",
          receipt: `mirror=${this.mirror.id}; commit=${remoteCommit.oid}; exception=${error instanceof Error ? error.name : "unknown"}`,
        };
      }
      if (created.status !== "succeeded") {
        return this.fail(input, operation, { ...checkpoint, state: "inbound-proposals", completedInboundChangeIds: [...completed] }, created, classifyProviderState(created), remoteState.generation);
      }
      const change = created.value;
      if (change.projectId !== this.mirror.projectId || change.baseProjectRevisionId !== input.canonical.projectRevisionId || !this.originMatches(change.origin, origin)) {
        return this.fail(input, operation, { ...checkpoint, state: "inbound-proposals", completedInboundChangeIds: [...completed] }, this.reconciliationFailure("mirror.change_provenance_mismatch", "The Change coordinator returned a Change without the exact remote provenance.", "reject the proposal and repair the Change coordinator's origin mapping before retrying", `mirror=${this.mirror.id}; expectedCommit=${remoteCommit.oid}; returnedChange=${change.id}`), "blocked", remoteState.generation);
      }
      this.inboundChangeIds.set(proposalKey, change.id);
      completed.add(change.id);
      inboundChanges.push(clone(change));
      checkpoint = {
        ...checkpoint,
        state: "inbound-proposals",
        completedInboundChangeIds: [...completed],
        recoveryAction: "resume this checkpoint; already-created inbound Changes are idempotently reused",
        receipt: `${checkpoint.receipt}; inbound=${change.id}; remoteCommit=${remoteCommit.oid}`,
      };
      this.checkpoints.set(checkpoint.id, checkpoint);
    }
    const pending = [...new Set([...this.mirror.pendingInboundChangeIds, ...completed])];
    return this.succeed(input, operation, checkpoint, {
      state: "lagging",
      canonicalProjectRevisionId: this.mirror.canonicalProjectRevisionId,
      canonicalRefs: this.mirror.canonicalRefs,
      remoteGeneration: remoteState.generation,
      remoteRefs,
      pendingInboundChangeIds: pending,
    }, inboundChanges, "inbound");
  }

  private async processOutbound(
    input: MirrorSyncInput,
    operation: MirrorOperation,
    checkpoint: MirrorCheckpoint,
    remoteState: MirrorRemoteState,
    remoteRefs: readonly GitRef[],
    projectedCanonical: readonly GitRef[],
  ): Promise<MirrorSyncResult> {
    let pushed: MirrorProviderResult<MirrorRemoteState>;
    try {
      pushed = await this.remote.push({
        mirror: cloneMirror(this.mirror),
        expectedGeneration: remoteState.generation,
        expectedRefs: remoteRefs,
        desiredRefs: projectedCanonical,
        operationId: operation.id,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      pushed = {
        status: "failed",
        errorCode: "mirror.push_exception",
        message: `Mirror push threw ${error instanceof Error ? error.name : "an unknown error"}.`,
        retryable: true,
        affectedObject: this.mirror.remoteRepository,
        recoveryAction: "inspect remote state and resume the Mirror checkpoint",
        receipt: `mirror=${this.mirror.id}; operation=${operation.id}; exception=${error instanceof Error ? error.name : "unknown"}`,
        remoteMayHaveChanged: true,
      };
    }
    if (pushed.status !== "succeeded") return this.fail(input, operation, { ...checkpoint, state: "outbound-applied", remoteGeneration: remoteState.generation, remoteRefs: [...remoteRefs] }, pushed, classifyProviderState(pushed, pushed.remoteMayHaveChanged), remoteState.generation);
    const resultRefs = allowedRemoteRefs(pushed.value.refs, this.mirror.refMappings);
    if (!refsEqual(resultRefs, projectedCanonical)) {
      return this.fail(input, operation, { ...checkpoint, state: "outbound-applied", remoteGeneration: pushed.value.generation, remoteRefs: resultRefs }, this.reconciliationFailure("mirror.push_result_mismatch", "The remote provider did not return the exact refs requested by canonical Landing.", "quarantine the provider result and reconcile remote state before retrying", `mirror=${this.mirror.id}; expected=${projectedCanonical.map((ref) => `${ref.name}:${ref.oid}`).join(",")}; actual=${resultRefs.map((ref) => `${ref.name}:${ref.oid}`).join(",")}`), "divergent", pushed.value.generation);
    }
    return this.succeed(input, operation, { ...checkpoint, state: "outbound-applied", remoteGeneration: pushed.value.generation, remoteRefs: resultRefs }, {
      state: "healthy",
      canonicalProjectRevisionId: input.canonical.projectRevisionId,
      canonicalRefs: projectedCanonical,
      remoteGeneration: pushed.value.generation,
      remoteRefs: resultRefs,
      pendingInboundChangeIds: [],
      lastOriginOperationId: operation.id,
    }, [], "outbound");
  }

  private originMatches(actual: ChangeOrigin | undefined, expected: ChangeOrigin): boolean {
    return actual?.kind === "mirror"
      && actual.source === expected.source
      && actual.mirrorId === expected.mirrorId
      && actual.remoteRepository === expected.remoteRepository
      && actual.remoteRef === expected.remoteRef
      && actual.remoteCommit === expected.remoteCommit
      && actual.disclosure === expected.disclosure;
  }

  private fail(
    input: MirrorSyncInput,
    operation: MirrorOperation,
    checkpoint: MirrorCheckpoint,
    failure: MirrorProviderFailure,
    state: MirrorState,
    actualRemoteGeneration?: string,
    explicitState?: MirrorState,
  ): MirrorSyncFailure {
    const completedAt = this.now();
    const completedOperation: MirrorOperation = {
      ...operation,
      kind: input.reconciliation ? "reconcile" : operation.kind,
      state: state === "divergent" || state === "force-pushed" ? "degraded" : state === "blocked" || state === "credential-failed" ? "blocked" : "failed",
      ...(actualRemoteGeneration ? { actualRemoteGeneration } : {}),
      errorCode: failure.errorCode,
      completedAt,
      receipt: `${operation.receipt}; state=${state}; error=${failure.errorCode}; ${failure.receipt}`,
    };
    const completedCheckpoint: MirrorCheckpoint = {
      ...checkpoint,
      state: "blocked",
      recoveryAction: failure.recoveryAction,
      receipt: `${checkpoint.receipt}; state=blocked; error=${failure.errorCode}; ${failure.receipt}`,
    };
    this.operations.set(completedOperation.id, completedOperation);
    this.checkpoints.set(completedCheckpoint.id, completedCheckpoint);
    this.mirror = {
      ...this.mirror,
      state: explicitState ?? state,
      lastOperationId: completedOperation.id,
      checkpointId: completedCheckpoint.id,
      updatedAt: completedAt,
      ...(actualRemoteGeneration ? { remoteGeneration: actualRemoteGeneration } : {}),
    };
    const budgetReceipt = `mirror=${this.mirror.id}; remote=${this.mirror.remoteRepository}; operation=${completedOperation.id}; error=${failure.errorCode}`;
    const result: MirrorSyncFailure = {
      ...failure,
      mirror: cloneMirror(this.mirror),
      operation: cloneOperation(completedOperation),
      checkpoint: cloneCheckpoint(completedCheckpoint),
      budget: {
        name: "mirror-ref-reconciliation",
        limit: "every permitted mapped ref, remote generation, and inbound provenance receipt",
        asked: this.mirror.remoteRepository,
        receipt: budgetReceipt,
      },
    };
    this.idempotency.set(input.idempotencyKey, result);
    return result;
  }

  private succeed(
    input: MirrorSyncInput,
    operation: MirrorOperation,
    checkpoint: MirrorCheckpoint,
    next: {
      state: MirrorState;
      canonicalProjectRevisionId: string;
      canonicalRefs: readonly GitRef[];
      remoteGeneration: string;
      remoteRefs: readonly GitRef[];
      pendingInboundChangeIds: readonly string[];
      lastOriginOperationId?: string;
    },
    inboundChanges: readonly Change[],
    kind: MirrorOperation["kind"] = operation.kind,
  ): MirrorSyncResult {
    const completedAt = this.now();
    const completedOperation: MirrorOperation = {
      ...operation,
      kind,
      state: "succeeded",
      actualRemoteGeneration: next.remoteGeneration,
      inboundChangeIds: inboundChanges.map((change) => change.id),
      completedAt,
      receipt: `${operation.receipt}; state=succeeded; kind=${kind}; remote=${next.remoteGeneration}; inbound=${inboundChanges.map((change) => change.id).join(",") || "none"}`,
    };
    const completedCheckpoint: MirrorCheckpoint = {
      ...checkpoint,
      state: "completed",
      canonicalProjectRevisionId: next.canonicalProjectRevisionId,
      canonicalRefs: next.canonicalRefs.map((ref) => ({ ...ref })),
      remoteGeneration: next.remoteGeneration,
      remoteRefs: next.remoteRefs.map((ref) => ({ ...ref })),
      completedInboundChangeIds: [...new Set([...checkpoint.completedInboundChangeIds, ...inboundChanges.map((change) => change.id)])],
      recoveryAction: next.pendingInboundChangeIds.length > 0
        ? "Land the pending inbound Changes, then resume Mirror sync"
        : "No recovery action is required; inspect the operation receipt for lineage",
      receipt: `${checkpoint.receipt}; state=completed; kind=${kind}`,
    };
    this.operations.set(completedOperation.id, completedOperation);
    this.checkpoints.set(completedCheckpoint.id, completedCheckpoint);
    this.mirror = {
      ...this.mirror,
      state: next.state,
      canonicalProjectRevisionId: next.canonicalProjectRevisionId,
      canonicalRefs: next.canonicalRefs.map((ref) => ({ ...ref })),
      remoteGeneration: next.remoteGeneration,
      remoteRefs: next.remoteRefs.map((ref) => ({ ...ref })),
      pendingInboundChangeIds: [...next.pendingInboundChangeIds],
      lastOperationId: completedOperation.id,
      checkpointId: completedCheckpoint.id,
      updatedAt: completedAt,
      ...(next.lastOriginOperationId ? { lastOriginOperationId: next.lastOriginOperationId } : {}),
      receipt: `${this.mirror.receipt}; last=${completedOperation.id}; state=${next.state}`,
    };
    const result: MirrorSyncResult = {
      status: "succeeded",
      value: {
        mirror: cloneMirror(this.mirror),
        operation: cloneOperation(completedOperation),
        checkpoint: cloneCheckpoint(completedCheckpoint),
        inboundChanges: inboundChanges.map(clone),
      },
    };
    this.idempotency.set(input.idempotencyKey, result);
    return result;
  }
}
