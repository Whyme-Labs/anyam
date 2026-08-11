# Team Review, Integration Cohorts, and Authority-Separated Landing

Status: Accepted

Issue: [#53](https://github.com/Whyme-Labs/anyam/issues/53)

## Context

Anyam already has stable Changes and immutable Change Revisions, local Evidence,
Realm-owned capability policy, and compare-and-swap Landing for one Change. A
team workflow needs to compose several exact revisions without falling back to
moving branch names or a UI-only merge queue. It also needs to preserve the
hybrid public/private boundary while selecting reviewers and explaining why a
Landing is blocked.

The collaboration boundary must therefore answer five different questions:

1. Which module, Source Space, or Target owners must review this exact revision?
2. Which durable Findings remain open, and which revision do they describe?
3. Which Changes can be composed together, and which analyzers found a Conflict?
4. Which Evidence, approvals, policy version, and canonical base are current?
5. Which distinct Actor authored, verified, reviewed, Landed, or Promoted the
   result?

The system must not claim that an analyzer can formally prove a Project
"works". An analyzer reports the Conflict classes it can qualify and includes a
receipt and recovery action. Unknown semantic behavior remains an explicit
qualification gap rather than a silently accepted merge.

## Decision

### Review binds to stable Changes and exact revisions

The collaboration model adds versioned `Review Finding` and `Review Approval`
contracts. A Finding is attached to a stable Change and one immutable Change
Revision. Resolving a Finding records a new review state; it does not mutate or
rewrite the source revision it describes. A new Change Revision must be
reviewed again where its material state invalidates earlier review.

An Approval is bound to:

- the exact Change Revision and Integration Cohort member;
- the ownership requirement that caused the review;
- the active collaboration policy version; and
- the Evidence IDs supplied by the reviewer.

An Approval is stale when the Change Revision, policy, required Evidence, or
authorization context it covers changes. The approval record remains available
for audit and does not become authority merely because it is the latest record.

### Ownership rules select reviewers without widening disclosure

Review ownership rules may govern a module, Source Space, or Target. They name
required principals and/or teams and a disclosure classification. The reviewer
directory resolves active candidates, but Realm authorization remains the
authority for whether an Actor may actually review.

Review requirements and Findings are returned through Disclosure Projections.
An audience without access to a restricted scope receives a safe requirement
or blocker that says an authorized owner is required; it does not receive the
restricted rule ID, path, symbol, Source Space, analyzer detail, reviewer
identity, or private summary. A public projection is a different safe view,
not a filtered listing of the complete cohort graph.

### An Integration Cohort is the composition unit

An Integration Cohort contains one exact latest Change Revision per stable
Change and names one explicit base Project Revision. Cohort composition runs
installed `IntegrationAnalyzer` adapters over normalized member effects and
scope metadata. The kernel stores durable typed Integration Conflicts with:

- `textual`
- `semantic`
- `schema`
- `dependency`
- `policy`
- `disclosure`

An analyzer may report only the classes and inputs it can qualify. The built-in
baseline reports declared effect overlap conservatively. More precise textual,
symbol, schema, dependency, or provider analyzers use the same adapter seam and
must return a receipt and recovery action. Analyzer output never decides
authorization, rewrites source, or bypasses policy.

An open blocking Conflict prevents Landing. A Conflict is resolved by an exact
Change Revision, not by an explanation or a hidden automatic merge. Claims may
remain coordination warnings and are not universal locks.

### Policy explanations are first-class outputs

The collaboration coordinator evaluates a cohort against its current canonical
base, open Findings, open blocking Conflicts, ownership requirements, approvals,
Evidence validity, policy version, and separation-of-duty rules. It returns a
versioned Policy Explanation with:

- `allow`, `deny`, or `indeterminate` decision;
- every visible blocker and its disclosure class;
- the policy and canonical base receipt;
- a safe next command for each blocker; and
- stale, missing, failed, or indeterminate Evidence state.

The next command is diagnostic and bounded. It is not an implicit grant and
never reveals inaccessible context. Unknown required context fails closed for
protected Landing.

### Landing is atomic and authority-separated

The Project coordinator exposes an atomic `landCohort` operation. It validates
every member's latest revision, base, Source Space membership, explicit
Conflicts, and expected canonical Project Revision before mutating any state.
One successful compare-and-swap creates one Project Revision whose lineage
records all landed Change Revisions and the cohort ID. All member Changes advance
to `landed` together. A failed validation does not partially Land a member.

Only a trusted Landing Authority may call this operation. The collaboration
coordinator accepts the Authority's result only when the returned Project,
cohort, Change IDs, and Change Revision IDs exactly match the request. A
developer tool or coding agent can publish revisions and request Landing but
cannot write canonical refs.

Promotion remains a distinct authority and audit event after Release assembly;
successful Landing is not a deployment and does not imply a Target transition.

### Audit records preserve authority separation

The collaboration audit contract records distinct roles for:

```text
author → verifier → reviewer → landing → promotion
```

Analyzer observations are recorded separately. The event includes the Project,
cohort, Change/Revision where applicable, Actor, policy version, disclosure,
outcome, and receipt. It excludes credentials and private model reasoning.

The system rejects self-approval by the author or a verifier for the affected
Change Revision. Realm policy may impose stricter separation, but collaboration
cannot weaken it.

## Consequences

- Teams can review several interacting Changes as one explicit object while
  ordinary Git clients continue to create commits and push to isolated
  Workspace Repositories.
- Review history survives revision updates and remains inspectable after a
  policy or Evidence change makes an approval stale.
- Public contributors can receive safe progress and review outcomes without
  learning restricted Source Space metadata.
- The native equivalent of a merge queue is a cohort with typed conflicts and
  one atomic Project Revision, not a branch-name convention.
- Existing one-Change Landing remains a compatibility path implemented as a
  one-member cohort.
- The kernel owns policy, disclosure, lineage, and authority; analyzers and
  repository providers remain replaceable adapters.
- The model supports progressive ceremony: a solo Project can use one-member
  cohorts and self-managed policy, while teams add ownership, independent
  review, Evidence, and Promotion gates.

## Rejected alternatives

- **Use moving branch names as review identity:** loses durable review binding
  during rebases, force pushes, and agent handoffs.
- **Store one PR per repository and coordinate them manually:** cannot express
  one atomic cross-Source-Space Project Revision or one authority-separated
  audit trail.
- **Expose private requirements as permission errors:** leaks restricted IDs,
  scope metadata, timing, or analyzer detail through the public graph.
- **Treat every analyzer as a universal semantic merge proof:** overclaims
  behavior and hides qualification gaps; analyzers must state their receipt and
  limits.
- **Let a reviewer or agent call canonical Git push:** collapses author,
  reviewer, Landing, and Promotion authority and defeats deny-first policy.
- **Make approval a boolean on the Change:** cannot bind it to an exact
  revision, Evidence set, ownership requirement, or policy version.

## Qualification and implementation boundaries

This ADR defines contracts and authority boundaries, not universal analyzer
coverage or a claim that every healthy Project is formally buildable. The first
qualification covers:

1. module, Source Space, and Target reviewer selection;
2. public projection of restricted review state;
3. exact-revision Findings and stale approvals;
4. typed analyzer Conflict candidates;
5. visible missing/stale Evidence and safe commands;
6. author/verifier/reviewer/Landing/Promotion audit separation; and
7. atomic multi-Change compare-and-swap Landing.

Every future analyzer, reviewer provider, or Landing adapter must preserve these
invariants and add a fixture-backed receipt before its capability is advertised.
