import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalRefBinding, FencedCanonicalRefProvider, FencedRefObservation, FencedRefRequest } from "../../src/cloudflare/canonical-ref-reconciliation.ts";

type ProviderState = { generation: number; epoch: number; projectRevisionId: string | null; candidateOid: string | null; sealed: boolean; lastOid: string | null };

/** Test provider only. Its serialized API and durable JSON generation ledger
 * model the required provider contract while writing real isolated Git refs.
 * This is not a production provider or power-loss/concurrent-process proof. */
export class FencedGitProviderFixture implements FencedCanonicalRefProvider {
  readonly id = "provider:offline-fenced-git";
  readonly qualification = { fencedPublication: "observed" as const, receipt: "scope=serialized-offline-fixture; realGit=true; liveProvider=false; allCanonicalWritesObeyEpochAndSeal=true" };
  private queue: Promise<unknown> = Promise.resolve();
  readonly events: { operation: string; request: unknown; result: FencedRefObservation }[] = [];

  constructor(readonly root: string, readonly directories: Readonly<Record<string, string>>, private readonly afterOperation?: (operation: string, result: FencedRefObservation) => void) {
    mkdirSync(root, { recursive: true });
  }

  private serialized<T>(operation: () => T): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private path(binding: CanonicalRefBinding): string {
    return join(this.root, createHash("sha256").update(`${binding.repositoryId}\0${binding.ref}`).digest("hex") + ".json");
  }

  private actual(binding: CanonicalRefBinding): string | null {
    const directory = this.directories[binding.repositoryId];
    if (!directory) throw new Error("fixture_repository_not_enrolled");
    try { return execFileSync("git", ["rev-parse", "--verify", binding.ref], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return null; }
  }

  private write(binding: CanonicalRefBinding, state: ProviderState): void {
    const path = this.path(binding);
    writeFileSync(path + ".pending", JSON.stringify(state));
    renameSync(path + ".pending", path);
  }

  private state(binding: CanonicalRefBinding): ProviderState {
    const path = this.path(binding);
    const actual = this.actual(binding);
    const state: ProviderState = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as ProviderState : { generation: 0, epoch: 0, projectRevisionId: null, candidateOid: null, sealed: false, lastOid: actual };
    if (state.lastOid !== actual) {
      // A bypass of the modeled provider is detectable drift, not an accepted
      // sealed observation. Production isolation of every writer is unqualified.
      state.generation += 1;
      state.lastOid = actual;
      state.sealed = false;
    }
    this.write(binding, state);
    return state;
  }

  private response(binding: CanonicalRefBinding, state: ProviderState, challenge: string): FencedRefObservation {
    return { ...binding, providerId: this.id, oid: state.lastOid, generation: state.generation, epoch: state.epoch, projectRevisionId: state.projectRevisionId, candidateOid: state.candidateOid, sealed: state.sealed, challenge, receipt: `provider=offline-fixture; generation=${state.generation}; epoch=${state.epoch}; sealed=${state.sealed}; credentialMaterial=false` };
  }

  observe(input: CanonicalRefBinding & { challenge: string }): Promise<FencedRefObservation> {
    return this.serialized(() => this.response(input, this.state(input), input.challenge));
  }

  repair(input: FencedRefRequest): Promise<FencedRefObservation> {
    return this.serialized(() => {
      const state = this.state(input);
      if (state.generation !== input.expectedGeneration || state.lastOid !== input.expectedOid) throw new Error("fixture_provider_stale_generation_or_ref");
      if (input.epoch < state.epoch || (input.epoch === state.epoch && (state.projectRevisionId !== input.projectRevisionId || state.candidateOid !== input.desiredOid))) throw new Error("fixture_provider_stale_or_reused_epoch");
      if (state.sealed && input.epoch === state.epoch) throw new Error("fixture_provider_sealed_epoch");
      if (input.epoch > state.epoch && state.epoch !== 0 && !state.sealed) throw new Error("fixture_provider_previous_epoch_not_sealed");
      execFileSync("git", ["update-ref", input.ref, input.desiredOid, input.expectedOid ?? "0".repeat(input.desiredOid.length)], { cwd: this.directories[input.repositoryId]!, encoding: "utf8" });
      const next: ProviderState = { generation: state.generation + 1, epoch: input.epoch, projectRevisionId: input.projectRevisionId, candidateOid: input.desiredOid, sealed: false, lastOid: input.desiredOid };
      this.write(input, next);
      const result = this.response(input, next, input.challenge);
      this.events.push({ operation: "repair", request: input, result });
      this.afterOperation?.("repair", result);
      return result;
    });
  }

  seal(input: FencedRefRequest): Promise<FencedRefObservation> {
    return this.serialized(() => {
      const state = this.state(input);
      if (state.generation !== input.expectedGeneration || state.lastOid !== input.desiredOid || state.epoch !== input.epoch || state.projectRevisionId !== input.projectRevisionId || state.candidateOid !== input.desiredOid || state.sealed) throw new Error("fixture_provider_seal_binding_or_generation_mismatch");
      state.sealed = true;
      state.generation += 1;
      this.write(input, state);
      const result = this.response(input, state, input.challenge);
      this.events.push({ operation: "seal", request: input, result });
      this.afterOperation?.("seal", result);
      return result;
    });
  }

  /** Competing writes before sealing preserve generation even after OID ABA. */
  externalMove(binding: CanonicalRefBinding, oid: string): Promise<void> {
    return this.serialized(() => {
      const state = this.state(binding);
      if (state.sealed) throw new Error("fixture_provider_sealed_epoch");
      execFileSync("git", ["update-ref", binding.ref, oid], { cwd: this.directories[binding.repositoryId]!, encoding: "utf8" });
      state.lastOid = oid;
      state.generation += 1;
      this.write(binding, state);
    });
  }
}
