# Real-team adoption gate runbook

This runbook is for the owner of a named Anyam Realm. It is the only path that
can close [#286](https://github.com/Whyme-Labs/anyam/issues/286). Local
fixtures and synthetic actors are useful engineering evidence but do not satisfy
this gate.

## 1. Start the cohort

Record 3–10 consenting human participant IDs, at least two coding-agent
products, the customer-operated Realm ID, and the exact UTC start date in an
owner-controlled evidence JSON file. Keep the file outside the repository if
it contains personal information; only credential-free receipts belong in the
repository or issue comments.

## 2. Run bounded engineering qualification

```bash
npm run qualification:team-simulation > team-simulation.json
```

This verifies the Worker and CLI archetypes, concurrent Workspaces, Git
conflicts/rebase, Intent and Pull Request lifecycle, hybrid projection,
bidirectional mirror, and export/restore. Its `provider.cloudflare=not-run`
receipt must remain visible.

## 3. Run the customer-owned provider journey

Prepare an owner-only `ANYAM_GOLDEN_API_TOKEN_FILE` and a disposable
`ANYAM_GOLDEN_CONFIG_FILE`, then run:

```bash
npm run qualification:cloudflare-golden-path
npm run qualification:cloudflare-golden-recovery
```

Use only disposable Worker names and customer-owned resources. Preserve the
provider operation IDs, version/deployment IDs, health and rollback receipts;
never copy a token into the evidence bundle.

## 4. Collect the 30-day evidence

During the trial, record real receipts for every scenario and operation key in
the `anyam.real-team-adoption-gate/v1` contract:

- ordinary Git and concurrent human/agent Workspaces;
- Intent, Pull Request, review/Landing, conflict/rebase, and hybrid projection;
- bidirectional GitHub projection, export/restore, and no-canonical-write;
- customer-owned Worker Release/Target;
- sustained load, Queue recovery, Durable Object contention, backup/restore
  RPO/RTO, authentication throttling, key rotation, incident alerting, and
  independent security review.

Each receipt needs an owner, observation timestamp, next action, and
credential-free receipt text. `not-verified` and `indeterminate` are blockers.

The gate also requires a signed Authority export and external attestation
keyring. Keep the keyring files outside the repository; they contain public
keys only and use this shape:

```json
{
  "authority:key:v1": "-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----"
}
```

Set the paths before evaluation:

```bash
export ANYAM_REAL_TEAM_AUTHORITY_KEY_FILE=/secure/real-team/authority-keys.json
export ANYAM_REAL_TEAM_ATTESTATION_KEYS_FILE=/secure/real-team/attestation-keys.json
```

The evidence bundle must include `authorityExport`, `terminalChanges`, and
`externalAttestations`. `authorityExport` signs the complete credential-free
Authority snapshot and names its `cohortId`, `realmId`, `exportDigest`,
`signingKeyId`, and `exportedAt`. Each terminal Change entry names its
`changeId`, `terminalState`, `auditEventId`, and latest `revisionId`. Each
external attestation names its `attestationId`, reviewer identity, report
digest, signing key, cohort, Realm, and `signedAt`; its reviewer must not be a
trial participant. The independent-security-review receipt must repeat the
attestation ID, reviewer ID, and report digest.

For bidirectional GitHub projection, provider sync and reconciliation must use
the internal signed Mirror handoff after RepositoryDriver observation. The
human REST and generic Authority routes intentionally reject provider claims;
the local team simulation's fixture-only mirror seam is not adoption evidence.

## 5. Evaluate the gate

```bash
npm run qualification:real-team-gate -- ./real-team-evidence.json
```

The command prints a disclosure-safe blocker list and a `summary.verification`
mode. It returns success only after the trial spans 30 calendar days, at least
25 terminal Changes exist, the signed Authority export and external
attestations verify with the configured public keys, all scenarios and
operations are verified, the provider receipt is bound to the signed
Promotion, and the team records an explicit `continue` decision. Without
trusted keys the result is explicitly `manual-review-only` and remains
blocked.

Until that command returns `status=ready`, Anyam remains an internal/private
alpha for production-readiness claims.
