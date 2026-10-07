import assert from "node:assert/strict";
import { MemorySmartHttpCredentialStore, SmartHttpCredentialAuthority } from "../../src/portability/smart-http.ts";

const phases = ["absent", "read-active", "write-active", "revoked", "expired"] as const;
const probes = ["read", "write", "peer-repository", "peer-source", "peer-workspace"] as const;
type Phase = typeof phases[number];
type Probe = typeof probes[number];
export type CredentialModelCase = { phase: Phase; probe: Probe; restarted: boolean; outcome: string };

// Independent domain oracle: explicit permitted/denied outcomes, rather than
// another copy of the implementation's sequence of conditionals.
const expected: Record<Phase, readonly string[]> = {
  absent: ["invalid", "invalid", "invalid", "invalid", "invalid"],
  "read-active": ["allowed", "operation-denied", "repository-mismatch", "source-space-mismatch", "operation-denied"],
  "write-active": ["allowed", "allowed", "repository-mismatch", "source-space-mismatch", "workspace-mismatch"],
  revoked: ["revoked", "revoked", "revoked", "revoked", "revoked"],
  expired: ["expired", "expired", "expired", "expired", "expired"],
};

export function assertCredentialModel(cases: readonly CredentialModelCase[]): void {
  assert.equal(cases.length, phases.length * probes.length * 2);
  const unique = new Set<string>();
  for (const item of cases) {
    const key = JSON.stringify([item.phase, item.probe, item.restarted]);
    assert.equal(unique.has(key), false, `duplicate model case ${key}`);
    unique.add(key);
    assert.equal(item.outcome, expected[item.phase][probes.indexOf(item.probe)], key);
  }
}

export async function qualifyCredentialStateModel() {
  const cases: CredentialModelCase[] = [];
  const start = Date.parse("2026-10-02T12:00:00Z");
  const expiry = start + 60_000; // Fixture clock boundary, not an operational budget.
  for (const phase of phases) for (const restarted of [false, true]) for (const probe of probes) {
    let now = start;
    const store = new MemorySmartHttpCredentialStore();
    let authority = new SmartHttpCredentialAuthority({ store, now: () => now });
    let token = "unrecognised-fixture-token";
    if (phase !== "absent") {
      const issued = await authority.issue({ repositoryId: "repo:own", sourceSpaceId: "source:own", workspaceId: "workspace:own", operation: phase === "read-active" ? "read" : "write", expiresAt: new Date(expiry).toISOString() });
      assert.equal(issued.canonicalWrite, false);
      token = issued.token;
      if (phase === "revoked") assert.equal(await authority.revoke(token), true);
      if (phase === "expired") now = expiry; // Exact expiry must deny, including after hydration.
    }
    if (restarted) { authority = new SmartHttpCredentialAuthority({ store, now: () => now }); await authority.ready(); }
    const observed = await authority.validate(token, {
      repositoryId: probe === "peer-repository" ? "repo:peer" : "repo:own",
      sourceSpaceId: probe === "peer-source" ? "source:peer" : "source:own",
      workspaceId: probe === "peer-workspace" ? "workspace:peer" : "workspace:own",
      operation: probe === "write" || probe === "peer-workspace" ? "write" : "read",
    });
    cases.push({ phase, probe, restarted, outcome: observed.valid ? "allowed" : observed.code });
    assert.doesNotMatch(JSON.stringify(await store.load()), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "store must remain credential-free");
  }
  assertCredentialModel(cases);
  const mutations = [
    { name: "allow-revoked-read", phase: "revoked", probe: "read" },
    { name: "allow-read-token-write", phase: "read-active", probe: "write" },
    { name: "allow-peer-workspace", phase: "write-active", probe: "peer-workspace" },
  ] as const;
  const mutationResults = mutations.map(mutation => {
    const changed = cases.map(item => item.phase === mutation.phase && item.probe === mutation.probe ? { ...item, outcome: "allowed" } : item);
    assert.throws(() => assertCredentialModel(changed), assert.AssertionError, mutation.name);
    return { name: mutation.name, detected: true };
  });
  return {
    protocol: "anyam.scm-credential-bounded-model/v1", provider: "concrete-SmartHttpCredentialAuthority", store: "MemorySmartHttpCredentialStore",
    phases, probes, restartModes: [false, true], caseCount: cases.length, cases, mutations: mutationResults,
    scope: "finite authority transitions and audience bindings; no provider, concurrency, liveness or whole-product proof",
    secretsIncluded: false,
  };
}
