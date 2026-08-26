# ADR 0109: Bind real-team evidence to identities and time

Status: Accepted

Issue: [#303](https://github.com/Whyme-Labs/anyam/issues/303)

## Context

The real-team gate is the final readiness boundary between synthetic
qualification and a named human trial. A shape-only validator could count the
same human or Change repeatedly, accept evidence recorded outside the trial,
accept future timestamps, or accept an unrelated provider/operator receipt.

That would turn a correct-looking JSON bundle into a false production claim.

## Decision

The validator now requires:

- unique human participant IDs and unique terminal Change IDs;
- `terminalCount` equal to the exact number of named unique Change IDs;
- parseable UTC timestamps for the trial, every scenario/operation/provider
  observation, and retention decision;
- a completed trial whose start and end are not in the future;
- scenario, operation, and provider observations inside the trial window;
- a retention decision recorded at or after trial completion and not in the
  future;
- every receipt owner, including provider and operations owners, to be one of
  the named human participants; and
- exactly `cloudflare-workers` as the provider identity for the required Worker
  Release/Target receipt.

Missing, malformed, duplicate, future, out-of-window, unrelated, and
credential-bearing evidence remains a blocker with an actionable key and next
action. Synthetic local simulations remain explicitly separate from this gate.

## Consequences

- A bundle cannot satisfy the adoption threshold through repeated identities or
  repeated records.
- Evidence provenance is bounded to the named cohort and completed trial.
- The validator remains deterministic and owner-controlled; it does not infer
  human participation or provider health from local fixtures.

## Receipt

- Tests cover duplicate humans, duplicate Changes, count mismatch, future and
  malformed timestamps, out-of-window evidence, provider mismatch, unrelated
  owners, credential-like receipts, and a valid time-bounded bundle.
