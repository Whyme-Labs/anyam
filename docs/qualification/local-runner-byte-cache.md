# Local Runner cached output byte integrity

`LocalExecutionEngine.runAction` rereads every declared output file before
returning an exact cached result or attesting reusable Evidence for another
Project Revision. It compares ordered output paths and SHA-256 digests of the
actual bytes with the producing Run's recorded output digests. Matching input
keys, file sizes, or existing Artifact references cannot substitute for this
check. Existing Source Space, Project View, disclosure, policy, authorization
epoch, Action, Verifier, toolchain, environment, dependency and Target cache
bindings remain required.

Changed or missing outputs fall through to ordinary Action execution. The fresh
Evidence receipt includes
`cacheReuse=not-applied; cached-output-bytes=changed-or-missing`. A successful
regeneration produces new Run/Evidence/Artifact provenance; a failed one blocks
release readiness even when older passed Evidence remains in the shared ledger.
Affected release planning records the damaged Action as a fallback and retains
reuse for eligible unaffected Actions. Original producing records remain
immutable. Unexpected output read/storage errors propagate instead of returning
cached success. Actions without declared outputs retain normal reuse.

The focused regression tests execute small file-producing Node Actions in
disposable directories and independently hash the read-back Artifact bytes:

```sh
node --import ./node_modules/tsx/dist/loader.mjs --test \
  --test-name-pattern='exact Runner cache|reusable Runner cache|failed Runner cache|Runner cache propagates' \
  test/execution-local.test.ts
```

Coverage includes same-size byte tampering, deleted output recovery, healthy
reuse after regeneration, changed/deleted cross-revision fallback, reuse of an
unaffected no-output Action, immutable original provenance, failed regeneration
with historical passed Evidence, and propagation of an unreadable output error.
The repository gate also runs the existing complete-validity and healthy
cross-revision cache tests.

This is a point-in-time check of local materialized output bytes before cache
reuse. It adds output reads and hashing when a cached candidate exists. It does
not establish atomic filesystem custody, prevent concurrent or subsequent file
changes, redesign symlink handling, sandbox Action processes, independently
verify Verifier truth, or verify a remote Runner's uploaded bytes. The external
Runner's signed manifest/output references and the Realm owner's accepted Run
detail retain their existing qualification boundaries; see
[ADR 0037](../adr/0037-external-pull-runners-and-generic-target-qualification.md)
and [owner Run detail qualification](disclosed-writes-and-owner-run-detail.md).
No authorization, signature format, credential handling, provider deployment,
or production execution contract changes here.
