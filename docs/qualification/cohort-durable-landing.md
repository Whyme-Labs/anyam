# Offline durable Cohort Landing

`SQLiteCohortLandingAuthority` implements the existing trusted `LandingAuthority`
seam. It is an internal adapter, without an HTTP, MCP, CLI, or generic Authority
command route. Creating it does not enroll an Actor, grant a Capability, or
authorize canonical writes. Hosted Landing must retain its Realm authorization
and repository-observation boundaries before connecting this adapter.

The adapter reloads the SQLite Authority snapshot, validates every exact latest
submitted member and Workspace/View/base lineage, composes compatible snapshot
updates, and invokes a caller-supplied synchronous policy gate on copies of that
fresh snapshot and selection. The gate must use current collaboration policy,
review, Findings, Conflicts, Evidence validity, and authorization context. The
adapter validates the resulting decision's Project, Cohort, and canonical base;
it does not reconstruct or certify the caller's policy configuration. Explicit
member Conflict IDs fail closed because their resolution ledger is not present
in this Authority snapshot.

One SQLite transaction commits one canonical Project Revision with every member
revision in its lineage, one Landing, all member Change and Workspace terminal
states, an audit event, and an immutable idempotency result. An unchanged
snapshot carried by a member's composed View does not overwrite another
member's update. Differing updates to the same Source Space block composition.
No Git repository is written during canonical selection.

The durable Authority audit event embeds existing typed collaboration events
for every exact member, including Project, Cohort, Actor, Landing role, policy
version, disclosure, and receipt. A crash after commit cannot lose that context
while waiting for an in-memory collaboration event.

ADR 0002 requires later Landing to wait for canonical-ref reconciliation.
This adapter rejects a new Landing when the current canonical revision has
Landing lineage, because it cannot yet certify durable, fenced reconciliation
completion. Historical replay remains allowed. A read-only plan whose supplied
refs are current does not remove this gate; completing that lifecycle is a
separate qualification gap. The qualified slice is the initial offline Cohort
selection and its projection-recovery experiment, not repeated hosted Landing.

The idempotency key is `landing.cohort:<cohortId>` and binds the Project, ordered
exact members, and expected base. Reuse with different inputs fails. Replaying
a committed request returns its historical Landing before today's policy gate;
this cannot authorize new work or alter canonical state. Reopen reconstructs
the result from the existing Authority entity and idempotency tables. No new
storage engine, schema migration, or background task is introduced.

The stored `idempotency[key].result.value.reviewPacket` includes the exact
policy explanation, selected member IDs, full consumed Evidence artifacts,
and gate-supplied Review Approvals when available. Missing approval artifacts
are explicit. This packet is internal historical review material; it is not
automatically disclosed through local MCP `change.inspect`. Approval content,
policy configuration, and authorization are the trusted gate's responsibility,
not independently durable live inputs supplied by this adapter.

`canonicalRefProjectionPlan` is a read-only internal projection for explicitly
bound, enrolled Source Space repositories. It identifies current refs, known
canonical ancestor refs needing repair, and unknown external refs requiring
reconciliation. It returns exact expected/desired OIDs and the observed
Authority version, without a credential or write authority. Its coverage is
limited to supplied bindings; omitted repositories remain unqualified. Reload
canonical selection before repair and after read-back. A stale plan is not a
provider fence.

The local Git driver's `compareAndSwapRefs` now uses one `git update-ref --stdin`
transaction with expected old OIDs, verification-only guards, preparation, and
commit. Every desired ref needs an explicit expected OID or `null`. A stale ref
or invalid desired object aborts every ref update in that repository. Separate
repositories still have separate transactions. Ref OIDs do not supply a
monotonic epoch fence against an ABA transition or a stale repair worker racing
a newer canonical selection; a durable automatic canonical repair writer is
therefore not connected here.

`test/cohort-landing.test.ts` qualifies synthetic recorded Run/Evidence and
independent Review Approvals, stale Evidence/member/policy rejection, composed
View composition in both orders, and a deterministic intervening Landing that
loses the SQLite version fence without partial writes. A subprocess exits
abruptly after manifest insertion and after canonical-row insertion; reopening
recovers the complete prior state. Exit after commit simulates a lost success
response and historical replay leaves all persisted records unchanged.

The Git recovery fixture uses real disposable repositories and commits. After
canonical selection, it repairs one repository and stops. SQLite reopen and
Git read-back distinguish the repaired repository from the lagging one; the
remaining per-repository CAS completes repair, while the stale original CAS
fails. `test/local-git-cas.test.ts` reproduces the prior partial-ref bug and
qualifies one winner among simultaneous CAS requests.

This is an offline durability slice. It does not qualify power-loss durability,
live Artifacts, native coding harnesses, live verifier proofs, hosted membership
or capability journeys, durable collaboration-state recovery, full provider
epoch fencing, or atomic distributed Git writes. A reopened new Landing still
requires the trusted caller to restore and freshly evaluate its policy gate.
