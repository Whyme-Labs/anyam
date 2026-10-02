# Offline Cohort workflow with actual local verification

From a clean committed checkout, run:

```sh
npm run qualification:cohort-local-verifier
```

The command creates disposable two-repository reference fixtures, executes four
actual verifier processes, records signed Runner completions in local Authority
SQLite, and exercises two Cohort Landings with partial projection recovery. Its
JSON report binds the implementation HEAD/tree, source commit OIDs, exact member
Change Revisions, Views, input and output digests, Action/Verifier contracts,
Runner profiles/Attempts, Evidence, Review Approvals and Landing packets. It
destroys the disposable databases and repositories after capture. It never
operates on the caller's Project or configures a hosted Runner.

Inherited `GIT_*` overrides are rejected before fixture Git mutations, including
repository, worktree, index, object-directory and configuration selectors;
the harmless `GIT_PAGER` and `GIT_TERMINAL_PROMPT` flags are allowed.
Unset these overrides for the qualification command; it does not silently
redirect operations or modify the caller's environment.

Each Source Space has a small committed arithmetic module and a verifier with
positive and negative input assertions. The candidate is checked out by exact
OID and cloned into the existing enforceable Workspace boundary. The immutable
Runner Job is assigned before execution, with actual declared-file digests,
toolchain binary digest, one disclosed Source Space and the boundary receipt.
Networking is deny-all, ambient credentials are sanitized, and Git metadata is
protected by the existing Workspace implementation. Linux uses its existing
measured resource policy. An unsupported boundary fails closed; the command
does not fall back to supervised execution.

An ephemeral fixture Runner signs the exact observed result. The existing
`runner.complete` transition verifies it and creates the durable terminal Run,
Evidence and Artifact references. Output references bind actual local bytes
read back after the process. No `run.record` or `evidence.record` success
declaration is used by this qualification. Input/commit drift, failed verifier
results and changed signed context/output references cannot become passing
Cohort Evidence. Historical Evidence cannot satisfy a different exact member.

The first Landing remains inspectable while a serialized file-backed fake
provider loses its reply after repairing one real Git ref. A second Landing
blocks until SQLite reopen, fresh provider read-back, full ref repair and sealed
completion. The second packet retains the prior completion, and original
Landing results remain immutable. Provider fencing qualification still covers
only the offline client protocol under the fake provider's guarantees; see
[the durable Landing qualification](cohort-durable-landing.md).

This receipt proves actual execution of the declared reference verifiers and
their signed local consumption. Fixture policy, Actor/reviewer identities and
grants are synthetic governance. It does not qualify production Runner
enrollment/key custody, durable collaboration-policy restoration, native coding
harnesses, real-team adoption, live provider atomicity/fencing, live Cloudflare
Artifacts, hardware durability, or distributed Git transactions. It creates no
HTTP, REST, MCP or CLI authority route and changes no security policy or storage
engine. The qualification command and its regression tests intentionally share
reference-fixture wiring under `test/fixtures/`.
