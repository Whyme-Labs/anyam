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
The existing block remains when no qualified `CanonicalRefReconciler` is
connected. With that internal seam, a later Landing requires a durable exact
completion record and fresh provider observations of every sealed ref. Its
SQLite version fence still rejects intervening Authority writes. The new
Landing packet records the prior completion artifact; its own Git projection
starts a new reconciliation lifecycle.

`CanonicalRefReconciler` records complete, unique coverage of every Project
Source Space repository/ref and binds each desired/base Git OID to the selected
Project Revision. Its monotonic epoch comes from that immutable Cohort Landing
result's Authority version. The provider identity, qualification receipt,
Landing, epoch, policy, candidate and ref bindings cannot be substituted.
Progress and completion use a new entity collection in the existing SQLite
row store; older persisted Authority snapshots normalize the collection to empty
and retain the Landing block. The SQL table schema and storage engine are
unchanged. Current signed recovery bundles cover this collection, including its
completion epoch. Hosted restore still requires every current snapshot field;
a legacy signed bundle without this collection needs a fresh current export.
Legacy hosted recovery compatibility is not qualified by this offline slice.

A qualified `FencedCanonicalRefProvider` must durably compare expected provider
generation and ref OID, reject lower epochs and same-epoch selection reuse,
and seal a repaired epoch against further writes. A higher epoch may open the
next selected candidate after the preceding epoch is sealed. Every canonical
writer must obey this contract. Fresh challenge-bound read-back checks exact
provider/repository/ref/candidate/epoch/generation coverage before completion
and again before subsequent Landing. Unknown external refs, forged responses,
unqualified capability, incomplete coverage and stale generations fail closed.

Provider repair and sealing happen separately for each repository. Pending
SQLite checkpoints make partial effects inspectable. A lost reply is resolved
by fresh provider read-back: it does not assume the external operation failed.
Completion replay leaves Authority records unchanged. Original Landing results
and prior checkpoint artifacts remain immutable, including after a later
selection and a ref returning to an earlier OID.

The file-backed `FencedGitProviderFixture` supplies serialized fake provider
responses while mutating real isolated Git refs. Tests qualify the offline
client protocol under those provider guarantees: partial repair, subsequent
Landing, expected-generation races, lower-epoch retries across OID ABA,
response binding, competing canonical selection and abrupt Authority-process
exits after repair/seal or during completion persistence. They do not qualify
production provider atomicity, multi-process provider locking, hardware/power
loss, or prevention of a raw filesystem bypass. A deliberate raw Git bypass is
detected on fresh observation and blocks later Landing.

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
a newer canonical selection; that driver cannot satisfy the fenced-provider seam. No ordinary local Git
driver or live provider is enrolled as qualified by this milestone.

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
or capability journeys, durable collaboration-state recovery, live provider
epoch fencing, or atomic distributed Git writes. A reopened new Landing still
requires the trusted caller to restore and freshly evaluate its policy gate.
