import { CONTRACT_VERSIONS, opaqueId, type Landing } from "../kernel/contracts.ts";
import { AUTHORITY_PLANE_PROTOCOL, AuthorityPlaneError, type AuthorityPlaneSnapshot, type AuthoritySession } from "./authority-plane.ts";
import { AuthoritySQLiteStore } from "./authority-sqlite.ts";

export type CanonicalRefBinding = { sourceSpaceId: string; repositoryId: string; ref: string };
type SelectedRef = CanonicalRefBinding & { desiredOid: string; baseOid: string };

export type FencedRefObservation = CanonicalRefBinding & {
  providerId: string;
  oid: string | null;
  generation: number;
  epoch: number;
  projectRevisionId: string | null;
  candidateOid: string | null;
  sealed: boolean;
  challenge: string;
  receipt: string;
};

export type FencedRefRequest = SelectedRef & {
  projectRevisionId: string;
  epoch: number;
  expectedGeneration: number;
  expectedOid: string | null;
  challenge: string;
};

/** Trusted provider seam. All canonical writers must obey the durable epoch
 * floor and sealed-epoch rule. Plain Git OID CAS does not implement this seam. */
export type FencedCanonicalRefProvider = {
  id: string;
  qualification: { fencedPublication: "observed" | "unverified" | "unsupported"; receipt: string };
  observe(input: CanonicalRefBinding & { challenge: string }): Promise<FencedRefObservation>;
  repair(input: FencedRefRequest): Promise<FencedRefObservation>;
  seal(input: FencedRefRequest): Promise<FencedRefObservation>;
};

export type CanonicalRefProjectionRecord = {
  protocol: "anyam.canonical-ref-projection/v1";
  id: string;
  projectId: string;
  projectRevisionId: string;
  landingId: string;
  providerId: string;
  qualificationReceipt: string;
  epoch: number;
  policyVersion: string;
  state: "pending" | "complete";
  bindings: readonly SelectedRef[];
  repaired: Record<string, FencedRefObservation>;
  sealed: Record<string, FencedRefObservation>;
  receipt: string;
};

function stop(detail: string): never {
  throw new AuthorityPlaneError({ code: "indeterminate", message: `Canonical-ref reconciliation blocked: ${detail}.`, recoveryAction: "inspect the exact canonical selection and provider generation; resume only its bound reconciliation after fresh read-back", receipt: `canonicalProjection=blocked; ${detail}; canonicalMutation=false` });
}

function integer(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function oid(value: string): boolean { return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value); }

/** Internal offline lifecycle. Pending progress and completion use the existing
 * Authority SQLite transaction/version fence. External repositories never
 * participate in that transaction; provider sealing fences completed workers. */
export class CanonicalRefReconciler {
  constructor(private readonly input: {
    store: AuthoritySQLiteStore;
    session: AuthoritySession;
    projectId: string;
    bindings: readonly CanonicalRefBinding[];
    provider: FencedCanonicalRefProvider;
  }) {}

  private load(): AuthorityPlaneSnapshot {
    const snapshot = this.input.store.load(this.input.session.realmId);
    if (!snapshot) stop("Authority snapshot missing");
    return snapshot;
  }

  private selected(snapshot: AuthorityPlaneSnapshot): SelectedRef[] {
    const { projectId, provider } = this.input;
    if (provider.qualification.fencedPublication !== "observed" || !provider.qualification.receipt || !provider.id) stop("provider fenced publication is unqualified");
    const project = snapshot.projects[projectId];
    const revisionId = snapshot.canonicalByProject[projectId];
    const revision = revisionId ? snapshot.projectRevisions[revisionId] : undefined;
    const parent = revision?.parentProjectRevisionId ? snapshot.projectRevisions[revision.parentProjectRevisionId] : undefined;
    const bindings = [...structuredClone(this.input.bindings)].sort((left, right) => left.sourceSpaceId.localeCompare(right.sourceSpaceId));
    if (!project || !revision || revision.projectId !== projectId || !parent || parent.projectId !== projectId || bindings.length !== project.sourceSpaceIds.length || new Set(bindings.map((binding) => binding.sourceSpaceId)).size !== bindings.length || new Set(bindings.map((binding) => binding.repositoryId)).size !== bindings.length) stop("complete unique Project repository coverage and Landing lineage required");
    return bindings.map((binding) => {
      const desiredOid = revision.sourceSpaceSnapshots[binding.sourceSpaceId];
      const baseOid = parent.sourceSpaceSnapshots[binding.sourceSpaceId];
      if (!project.sourceSpaceIds.includes(binding.sourceSpaceId) || snapshot.sourceSpaces[binding.sourceSpaceId]?.repositoryId !== binding.repositoryId || !binding.ref.startsWith("refs/") || /[\s\0]/u.test(binding.ref) || !desiredOid || !baseOid || !oid(desiredOid) || !oid(baseOid)) stop("repository/ref/candidate binding or Git source identity invalid");
      return { ...binding, desiredOid, baseOid };
    });
  }

  private requireRecord(snapshot: AuthorityPlaneSnapshot): CanonicalRefProjectionRecord {
    const record = snapshot.canonicalRefProjections[this.input.projectId];
    const selected = this.selected(snapshot);
    if (!record || record.protocol !== "anyam.canonical-ref-projection/v1" || record.projectId !== this.input.projectId || record.projectRevisionId !== snapshot.canonicalByProject[this.input.projectId] || record.providerId !== this.input.provider.id || record.qualificationReceipt !== this.input.provider.qualification.receipt || !integer(record.epoch) || record.epoch === 0 || JSON.stringify(record.bindings) !== JSON.stringify(selected)) stop("current exact reconciliation record required");
    const result = Object.values(snapshot.idempotency).map((entry) => entry.result).find((result) => (result.value.landing as Landing | undefined)?.id === record.landingId);
    const landing = result?.value.landing as Landing | undefined;
    const policy = (result?.value.reviewPacket as { explanation?: { policyVersion?: string } } | undefined)?.explanation?.policyVersion;
    if (!landing || landing.projectRevisionId !== record.projectRevisionId || landing.projectId !== record.projectId || result?.version !== record.epoch || policy !== record.policyVersion || !snapshot.landings[record.landingId]) stop("projection epoch or policy differs from its immutable Landing result");
    return structuredClone(record);
  }

  private observation(value: FencedRefObservation, binding: SelectedRef, challenge: string): FencedRefObservation {
    if (value.providerId !== this.input.provider.id || value.sourceSpaceId !== binding.sourceSpaceId || value.repositoryId !== binding.repositoryId || value.ref !== binding.ref || value.challenge !== challenge || !integer(value.generation) || !integer(value.epoch) || typeof value.sealed !== "boolean" || !value.receipt || (value.oid !== null && !oid(value.oid))) stop("provider observation identity, challenge, generation or receipt mismatch");
    return structuredClone(value);
  }

  private async observe(binding: SelectedRef): Promise<FencedRefObservation> {
    const challenge = opaqueId("canonical-ref-probe");
    return this.observation(await this.input.provider.observe({ ...binding, challenge }), binding, challenge);
  }

  private exact(value: FencedRefObservation, record: CanonicalRefProjectionRecord, binding: SelectedRef): void {
    if (value.epoch !== record.epoch || value.projectRevisionId !== record.projectRevisionId || value.candidateOid !== binding.desiredOid || value.oid !== binding.desiredOid) stop("provider state does not bind the exact Landing epoch and candidate");
  }

  private save(record: CanonicalRefProjectionRecord, phase: string, generation = "all"): void {
    const previous = this.load();
    if (previous.canonicalByProject[record.projectId] !== record.projectRevisionId) stop("canonical selection advanced while reconciling");
    const key = `canonical.projection:${record.id}:${phase}:${generation}`;
    const fingerprint = JSON.stringify({ id: record.id, projectRevisionId: record.projectRevisionId, epoch: record.epoch, bindings: record.bindings, phase, generation });
    const replay = previous.idempotency[key];
    if (replay) {
      if (replay.fingerprint !== fingerprint) stop("projection checkpoint identity reused with different state");
      return;
    }
    const existing = previous.canonicalRefProjections[record.projectId];
    if (phase !== "begin" && (!existing || existing.id !== record.id || existing.state === "complete")) stop("projection progress no longer owns the current pending operation");
    if (phase === "begin" && existing?.projectRevisionId === record.projectRevisionId) stop("another reconciliation already owns this selection");
    const next = structuredClone(previous);
    next.canonicalRefProjections[record.projectId] = structuredClone(record);
    next.version += 1;
    next.idempotency[key] = { fingerprint, result: { protocol: AUTHORITY_PLANE_PROTOCOL, command: "landing.apply", status: "succeeded", version: next.version, value: { projection: structuredClone(record) }, receipt: record.receipt } };
    const actor = { principalId: this.input.session.principalId, actorId: this.input.session.actorId, sessionId: this.input.session.sessionId, clientId: this.input.session.clientId };
    const occurredAt = new Date().toISOString();
    const revision = next.projectRevisions[record.projectRevisionId]!;
    next.audit.push({ id: opaqueId("authority-audit"), command: "landing.apply", idempotencyKey: key, actor, outcome: "succeeded", stateVersion: next.version, occurredAt, collaboration: (revision.landedChangeRevisionIds ?? []).map((id) => ({ protocol: CONTRACT_VERSIONS.collaborationAudit, id: opaqueId("collaboration-audit"), projectId: record.projectId, cohortId: revision.landingCohortId!, changeId: next.changeRevisions[id]!.changeId, changeRevisionId: id, role: "landing", action: `landing.projection.${phase}`, outcome: "succeeded", actor, policyVersion: record.policyVersion, disclosure: "project", occurredAt, receipt: record.receipt })), receipt: record.receipt });
    this.input.store.commit(previous, next);
  }

  async reconcile(): Promise<CanonicalRefProjectionRecord> {
    let snapshot = this.load();
    const bindings = this.selected(snapshot);
    const revisionId = snapshot.canonicalByProject[this.input.projectId]!;
    let record = snapshot.canonicalRefProjections[this.input.projectId];
    if (!record || record.projectRevisionId !== revisionId) {
      const result = Object.values(snapshot.idempotency).map((entry) => entry.result).find((result) => (result.value.landing as Landing | undefined)?.projectRevisionId === revisionId);
      const landing = result?.value.landing as Landing | undefined;
      const policyVersion = (result?.value.reviewPacket as { explanation?: { policyVersion?: string } } | undefined)?.explanation?.policyVersion;
      if (!landing || !result || !integer(result.version) || result.version === 0 || !policyVersion) stop("durable Cohort Landing result, policy and epoch required");
      record = { protocol: "anyam.canonical-ref-projection/v1", id: opaqueId("canonical-ref-projection"), projectId: this.input.projectId, projectRevisionId: revisionId, landingId: landing.id, providerId: this.input.provider.id, qualificationReceipt: this.input.provider.qualification.receipt, epoch: result.version, policyVersion, state: "pending", bindings, repaired: {}, sealed: {}, receipt: `canonicalProjection=pending; revision=${revisionId}; epoch=${result.version}; provider=${this.input.provider.id}` };
      this.save(record, "begin");
    }
    record = this.requireRecord(this.load());
    if (record.state === "complete") { await this.assertComplete(this.load()); return record; }
    for (const binding of record.bindings) {
      record = this.requireRecord(this.load());
      let observed = await this.observe(binding);
      if (observed.epoch > record.epoch) stop("stale reconciliation epoch");
      if (observed.epoch === record.epoch && (observed.projectRevisionId !== record.projectRevisionId || observed.candidateOid !== binding.desiredOid)) stop("epoch reused for a different canonical selection");
      if (observed.oid !== binding.baseOid && observed.oid !== binding.desiredOid) stop("competing external ref change requires explicit reconciliation");
      if (observed.epoch !== record.epoch || observed.oid !== binding.desiredOid) {
        const challenge = opaqueId("canonical-ref-repair");
        const before = observed;
        observed = this.observation(await this.input.provider.repair({ ...binding, projectRevisionId: record.projectRevisionId, epoch: record.epoch, expectedGeneration: before.generation, expectedOid: before.oid, challenge }), binding, challenge);
        this.exact(observed, record, binding);
        if (observed.generation <= before.generation) stop("repair did not advance provider generation");
        record.repaired[binding.sourceSpaceId] = observed;
        record.receipt = `canonicalProjection=repair-read-back; revision=${revisionId}; repository=${binding.repositoryId}; generation=${observed.generation}`;
        this.save(record, `repaired:${binding.sourceSpaceId}`, String(observed.generation));
      }
      this.exact(observed, record, binding);
      if (!observed.sealed) {
        const challenge = opaqueId("canonical-ref-seal");
        const before = observed;
        observed = this.observation(await this.input.provider.seal({ ...binding, projectRevisionId: record.projectRevisionId, epoch: record.epoch, expectedGeneration: before.generation, expectedOid: before.oid, challenge }), binding, challenge);
        this.exact(observed, record, binding);
        if (!observed.sealed || observed.generation <= before.generation) stop("provider did not durably seal a new generation");
      }
      if (record.sealed[binding.sourceSpaceId]?.generation === observed.generation && observed.sealed) continue;
      record.sealed[binding.sourceSpaceId] = observed;
      record.receipt = `canonicalProjection=sealed; revision=${revisionId}; repository=${binding.repositoryId}; generation=${observed.generation}`;
      this.save(record, `sealed:${binding.sourceSpaceId}`, String(observed.generation));
    }
    snapshot = this.load();
    record = this.requireRecord(snapshot);
    await this.assertSealed(record);
    record.state = "complete";
    record.receipt = `canonicalProjection=complete; revision=${revisionId}; epoch=${record.epoch}; repositories=${record.bindings.length}; providerSealed=true; distributedGitAtomicity=false`;
    this.save(record, "complete");
    return structuredClone(record);
  }

  private async assertSealed(record: CanonicalRefProjectionRecord): Promise<void> {
    if (Object.keys(record.sealed).length !== record.bindings.length) stop("complete sealed repository coverage required");
    for (const binding of record.bindings) {
      const sealed = record.sealed[binding.sourceSpaceId];
      if (!sealed?.sealed) stop("complete sealed repository coverage required");
      this.observation(sealed, binding, sealed.challenge);
      this.exact(sealed, record, binding);
      const observed = await this.observe(binding);
      this.exact(observed, record, binding);
      if (!observed.sealed || observed.generation !== sealed.generation) stop("sealed completion generation changed; fresh reconciliation required");
    }
  }

  /** Called immediately before a subsequent selection. A historical receipt
   * alone cannot open Landing; fresh probes must still report sealed epochs. */
  async assertComplete(snapshot: AuthorityPlaneSnapshot, projectId = this.input.projectId): Promise<void> {
    if (projectId !== this.input.projectId || snapshot.realmId !== this.input.session.realmId) stop("reconciliation belongs to a different Project or Realm");
    const record = this.requireRecord(snapshot);
    if (record.state !== "complete") stop("canonical-ref reconciliation is incomplete");
    await this.assertSealed(record);
  }
}
