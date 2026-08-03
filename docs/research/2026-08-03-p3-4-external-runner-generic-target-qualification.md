# P3 public beta: external pull Runner and generic Target qualification

**Date:** 3 August 2026
**Ticket:** [#84](https://github.com/wms2537/anyam/issues/84)
**Status:** protocol qualified; production provider lane remains unqualified

## Decision

The Anyam external pull Runner and generic Target contracts are qualified as
an in-memory TypeScript protocol fixture. The fixture proves the authority and
recovery boundary needed for a public-beta implementation:

```text
enrolled Runner profile
        ↓
capability-matched immutable Job
        ↓
pull offer and challenge proof
        ↓
attempt-scoped credential
        ↓
signed, input/output-scoped Result
        ↓
typed Artifact and Evidence
        ↓
verified Release
        ↓
Anyam-owned generic Target publication
```

The Runner never receives canonical repository-write or Promotion authority.
The Target adapter performs provider mechanics; Anyam validates lineage and
advances the Target pointer.

## Fixture receipt

The qualification used `ExternalRunnerCoordinator` with an enrolled fixture
profile representing a customer-owned macOS/arm64 VM Runner:

- provider: `customer-runner`
- identity: generated Ed25519 key pair; the private key stays in the fixture
- capabilities: macOS, arm64, VM isolation, Node toolchain
- network: `registry.example`
- Secret Use: brokered alias `registry-token`
- outputs: Run-scoped logs, typed `cli.archive` Artifact, and Evidence
- Target adapter: `generic.release-assets`
- Action: non-web CLI archive build

The successful path verified that the Runner:

1. enrolls and activates only with an operator approval receipt;
2. pulls a matching immutable Action and Project View/input manifest;
3. proves possession of the enrolled key for the pull challenge;
4. receives a `runner-job` credential bound to Job, Attempt, Runner, and lease;
5. cannot find the opaque credential token in the serialized Job;
6. submits a signed Result with the exact input digest and declared output;
7. produces output references that Anyam binds to the Run and Attempt; and
8. produces an Evidence-backed Release whose typed Artifact is published
   through the generic Target without rebuilding it.

The publication coordinator verified the exact Release and Artifact digests,
provider object identity, Target identity, and current Release/Artifact
pointers. A duplicate publication request reuses the idempotent publication;
the generic package Target suite also covers provider failure followed by
retry while preserving Release lineage.

## Recovery and boundary receipt

The negative cases verified:

- an ineligible Runner cannot pull a Job whose capability, network, Secret Use,
  or output requirements it cannot satisfy;
- tampered input digests, undeclared output paths, output traversal, and
  disclosure/scope violations fail closed;
- cancellation with unknown cleanup becomes quarantined and the Run becomes
  indeterminate;
- a late Result after cancellation is rejected because its credential is
  revoked;
- Runner unavailability produces an indeterminate Job with a recovery action;
- lease expiry produces an indeterminate Run and a fresh retry Attempt; and
- retries preserve the prior Attempt as immutable history and use a new
  idempotency boundary.

The targeted receipt command was:

```text
npx tsx --test test/runner.test.ts test/library-release.test.ts
7 tests passed; 0 failed; 0 skipped
```

The complete repository gate also passed during this qualification:

```text
npm run check
94 tests passed; 0 failed; 0 skipped

npm run verify:package
create-anyam package entrypoint smoke passed for npm exec, npx, pnpm dlx, and bun x
```

## What this does not qualify

All Runner and Target interactions above are local in-memory fixture calls. No
external process, Queue pull consumer, customer host, macOS execution,
network enforcement, real Secret broker, durable credential store, hostile
workload isolation, package registry, or provider credential was exercised.

Therefore this receipt does not claim that Anyam operates a production
external Runner fleet or a production generic Target adapter. Before a live
provider lane is advertised, it needs a separate receipt for authenticated
pull transport, durable Run/Attempt persistence, host cleanup, network and
Secret Use enforcement, credential rotation/revocation, provider-side retry
and quarantine, and an actual non-web Target.

The public-beta contract decision is nevertheless settled: specialized
execution remains a portable pull boundary, and non-web artifacts use the same
Run → Evidence → Artifact → Release → Target lineage as Cloudflare execution.
