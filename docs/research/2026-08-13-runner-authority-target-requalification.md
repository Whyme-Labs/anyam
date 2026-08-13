# Runner, Authority, and non-web Target requalification

Date: 2026-08-13

Issue: [#187 Requalify the external Runner and non-web Target path for team adoption](https://github.com/Whyme-Labs/anyam/issues/187)

Protocol: `anyam.runner-authority-target-requalification/v1`

Status: **local Authority composition qualified; live transport evidence remains bounded to the existing P3-25 receipt**

## Decision boundary

The selected implementation path is the current-contract composition path. It
does not create a second Runner, Release, Target, or Promotion model. The
existing external pull Runner and generic Target contracts are now exercised
together with the current Realm Authority ledger:

```text
Runner Job/Attempt
  → signed Result
  → Run
  → Evidence
  → Artifact
  → canonical Project Revision landing
  → Release
  → Target
  → Promotion request
  → trusted Promotion execution
```

The composition is deliberately not a universal provider claim. The live
receipt remains [P3-25](2026-08-10-p3-25-external-runner-generic-target-live.md):
one owner-operated macOS/arm64 Runner, a real Cloudflare Queue pull transport,
R2 output read-back, and a disposable GitHub Release Target. It passed its
residual cancellation, revocation, duplicate, disclosure, and retry probes,
then deleted and verified all disposable resources. `networkBytes=not-observed`
is still a measurement gap, not an Anyam network limit.

## Local composition receipt

The focused test in
[`test/runner-authority-target.test.ts`](../../test/runner-authority-target.test.ts)
uses an enrolled Linux/amd64 container Runner fixture and the current
`AuthorityPlaneCoordinator`. It records the complete non-web journey without
provider credentials or external resources:

1. Create a TypeScript CLI Project, Source Space, Workspace, Change, and
   candidate Project Revision.
2. Enroll and activate a Runner with an explicit Linux/amd64 container profile,
   empty network destination set, and `secretUse=none`.
3. Enqueue, pull, claim, and sign a single Attempt against immutable input and
   output locations.
4. Accept the signed completion and verify that the opaque Attempt credential
   is not present in the completion.
5. Record the Run, Evidence, and Artifact in the Realm Authority ledger.
6. Land the candidate Project Revision atomically against the expected
   canonical revision.
7. Create a verified Release and configure a generic CLI-download Target.
8. Confirm that an unexecuted Promotion request is blocked at the Authority
   boundary.
9. Execute the Promotion through a detached generic Target adapter, then
   verify Target pointer/history, Release/Artifact lineage, and credential-free
   publication output.

The test uses fixture provider mechanics only. Its receipts intentionally use
`bytes=not-observed` and do not create an Anyam capacity number.

## Boundary matrix

| Boundary | Qualified here | Existing live receipt | Not claimed |
| --- | --- | --- | --- |
| OS / architecture / isolation | Linux / amd64 / container fixture | macOS / arm64 owner Runner | Universal OS, architecture, GPU, hardware, or mobile support |
| Network | Empty declared destination set | Host `networkBytes=not-observed` | A network budget, SLO, or unrestricted-network safety claim |
| Secrets | `secretUse=none`; no secret value or token is emitted | Brokered qualification controls; no raw secret recorded | Production secret-broker qualification for every provider |
| Inputs and outputs | Immutable input digests; Attempt-scoped logs, Artifact, and Evidence paths | R2 output and direct read-back digest match | Arbitrary output stores or unqualified registry semantics |
| Cancellation and retry | Existing Runner fixture state machine plus live P3-25 residual probes | Cancellation, revocation, duplicate, and fresh retry passed | Forced-stop semantics for every host/provider |
| Provider credentials | No provider credential in the local composition | Live qualification credentials were opaque, scoped, and not persisted | A universal credential scheme for package/model/device providers |
| Recovery | Authority request is blocked until a trusted executor; execution returns a checkpoint and target history | Live cleanup and recovery receipts passed | Automatic recovery from every provider outage or ambiguous host cleanup |
| Cleanup | No external resource is created by the local test | P3-25 disposable Queue, Worker, R2, and GitHub Target were deleted and verified absent | Persistent production cleanup policy |

## Authority and trust rules

- The Runner can produce a Run result, typed Artifact, and Evidence. It cannot
  land source, create a Release, advance a Target pointer, or promote a
  Release.
- The Authority ledger records the Runner result as a Run before the Release
  path is eligible.
- A generic Target adapter receives a detached verified Release and one
  selected Artifact. It does not receive canonical source-write authority.
- Promotion execution must return the exact execution digest, Target identity,
  Release identity, and Artifact digest expected by the Authority coordinator.
- An unexecuted `promotion.request` remains a visible blocked owner decision;
  it is not silently treated as a deployment or publication.
- Credentials are capability material, not evidence. Receipts record only
  credential-free status or safe digests.

## Team journey

For a real team, the smallest safe non-web workflow is:

```text
Developer or agent creates an Intent
  → Authority creates a Workspace and Change
  → Runner executes a declared Action or Verifier
  → signed Attempt result becomes Run/Evidence/Artifact
  → reviewers inspect the Change and evidence
  → Landing service updates the canonical Project Revision
  → Release is sealed from the landed revision
  → Target adapter publishes the exact Artifact
  → Promotion policy advances the Target or leaves an explicit blocker
```

This is the same lineage used by a Worker deployment. The only project-type
specific pieces are the Action, Artifact type, verifier, and Target adapter.

## Remaining qualification work

The following are intentionally still open and should not be generalized from
this receipt:

- Compose the live Queue pull transport with the current Realm Authority
  Worker rather than the qualification Worker-only coordinator.
- Qualify at least one real non-GitHub non-web provider, such as an npm/OCI
  registry, while preserving exact Artifact digest and duplicate-publication
  behavior.
- Measure network bytes and enforce declared network destinations for a real
  hostile-workload Runner.
- Qualify customer secret-broker use without exposing secret values to the
  Runner, logs, Artifact, Evidence, or model context.
- Add provider-specific cancellation and recovery receipts for Windows,
  macOS, GPU, and hardware-in-the-loop lanes where those are needed.

Those are provider and execution-adapter frontiers, not reasons to add another
core Authority contract. No new Anyam limit is introduced until its receipt is
measured.
