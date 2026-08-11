# Evidence validity, policy explanations, and provenance

Status: Accepted

## Context

Anyam cannot treat a green check, a model explanation, or a previously approved
Change as timeless truth. Source, dependencies, Verifiers, policy, Target
state, declared effects, disclosure context, and execution environments can
change after a Run. The system must preserve what was observed, make stale
Evidence visible, explain policy blockers, and avoid disclosing restricted
inputs through public results or caches.

Issue [#21](https://github.com/Whyme-Labs/anyam/issues/21) asked for schemas and
validity rules for Runs, findings, Evidence, attestations, policy decisions,
approvals, and provenance, including freshness and invalidation, effect
declarations, semantic diffs, sealed-result disclosure, SLSA/SBOM integration,
human and agent provenance, policy explanation, and cached-Evidence reuse.

The lifecycle was exercised in the throwaway prototype on branch
[`codex/prototype-evidence-lifecycle`](https://github.com/Whyme-Labs/anyam/tree/codex/prototype-evidence-lifecycle),
commit `8019817`. The owner accepted its behavior in ticket [#21](https://github.com/Whyme-Labs/anyam/issues/21).

## Decision

### Evidence is an immutable assertion with an exact validity key

An Evidence record is produced by a Run and never edited in place. Its validity
key contains every declared input that can affect the assertion:

```text
Project Revision or Change Revision
disclosed Project View and Source Space inputs
Action and Verifier identity/version
toolchain, dependency, image, and environment digests
declared input and output digests
declared effect set and semantic-diff version
governing policy version and authorization epoch where relevant
Target or Target contract when the assertion is Target-bound
verifier-owned inputs and sealed-test contract
```

The Evidence record also carries Run, producer, disclosure, provenance,
creation, and freshness metadata. A Verifier may declare which parts of this
key are relevant; it may not omit an input that its contract declares as
material.

Evidence has at least these lifecycle states:

```text
valid  — the bound inputs and governing policy still match
stale  — one or more bound inputs or governing policy changed
```

The original Evidence and its invalidation causes remain inspectable. A fresh
Run creates a new Evidence identity; it does not overwrite or repair the old
record. Failed, indeterminate, superseded, and unavailable outcomes are
recorded as result details or additional lifecycle states without pretending
that they are valid Evidence.

### Invalidation is explicit and conservative

Anyam marks Evidence stale when a material bound state changes, including:

- source Snapshot, Project Revision, or Change Revision;
- dependency, toolchain, image, Action, or Verifier version;
- declared inputs, effects, outputs, or semantic-diff interpretation;
- governing policy version or authorization epoch;
- Target identity or Target contract for Target-bound Evidence;
- sealed verifier inputs, disclosure contract, or owner-controlled test data;
- provenance or attestation verification required by the Evidence contract.

The invalidation record names the changed state and the new identity or version
when it is safe to disclose it. Hidden resources use the existing safe
Disclosure Projection rules; a public audience must not learn a private file,
verifier, timing, dependency, or Target identifier merely because Evidence was
invalidated.

### Cached Evidence is an optimization, not authority

A cached Evidence lookup is a hit only when the complete validity key and
disclosure audience match. A partial match is a miss or stale result, not a
best-effort reuse. A cache hit still requires Anyam to verify the Evidence
digest, producer/Verifier identity, policy epoch, disclosure policy, and
required approvals before using it in Landing, Release creation, or Promotion.

Caches are scoped by Project, Source Space, Project View, trust zone, and
model/provider policy. They must not allow a public actor or external model to
infer inaccessible source from hit/miss timing or cache keys. Cache contents
cannot create authority, extend an approval, or make stale Evidence current.

### Effects are declared inputs to policy, not proof

A Change or Run declares structured effects such as:

```text
API or contract change
database or migration change
secret use
infrastructure or binding change
dependency or toolchain change
Target or deployment change
```

Static analysis, semantic diffing, Verifiers, and agents may propose effects;
the owner or policy engine may require confirmation. An effect declaration is
not Evidence that the effect occurred, and an absent declaration is not proof
that no effect exists. Policy may block Landing or Promotion until required
effect Evidence is present.

### Policy decisions are explainable and bound to exact state

Every policy evaluation returns a `Policy Explanation` with:

```text
allow, deny, or indeterminate
decision identity
operation and resource
Project/Change/Run/Target state
policy version and authorization epoch
satisfied and missing capabilities
blocker and remediation
approval and Evidence identities
expiry or re-evaluation condition
```

Unknown protected context remains `indeterminate` and fails closed for high-risk
operations. A policy explanation may reveal what capability is missing and how
to remediate it, but it must not reveal hidden resources or private policy
metadata.

Policy evaluation is monotonic for one exact state: adding a blocker cannot
silently turn a denied operation into an allowed one. A later source, policy,
Target, effect, or Evidence change creates a new decision identity.

### Approvals bind Evidence, not just a Change title

An approval is valid only for the exact:

```text
Change Revision and base Project Revision
Evidence set and Evidence identities
declared effect set
policy version and authorization epoch
Target and Target contract
approver identity and separation-of-duty result
```

When any bound value changes, the approval becomes stale and must be obtained
again. An approval is never transferred to a later revision by matching a
Change ID, branch name, release name, or human-readable summary.

Author, agent, Verifier, approver, Landing authority, and Promotion authority
remain separate according to ADR 0008. Solo convenience may relax low-risk
approval policy, but it does not weaken Evidence binding or provenance.

### Provenance identifies the production chain without collecting private reasoning

Every Run, Evidence, Artifact, Release, policy decision, and approval records
the relevant production chain:

```text
Principal → Actor → Session → Task → Change/Run
client and model/provider identity
Workspace and Project View
source, Manifest, Action, Verifier, toolchain, dependencies
Runner identity and capability profile
inputs, outputs, digests, timestamps, policy, and approvals
```

Provenance excludes credential values, unrestricted secret material, private
model chain-of-thought, and inaccessible Project Content. Agent summaries and
human explanations may be attached as review content, but they are not
reproducible Evidence without a Run and declared producer contract.

### Standard attestations are normalized at the boundary

SLSA provenance, SBOMs, in-toto statements, signatures, and external scanner
reports may enter through typed Evidence or Artifact attestations. Anyam
retains the original statement and digest, then normalizes the fields needed
for Project View disclosure, Policy Explanation, freshness, Release lineage,
and Target Promotion. An imported attestation is not upgraded into an
Anyam-reproducible Build claim when its provenance is insufficient.

### Sealed and public disclosure are projections of the same assertion

Evidence has an owner-defined disclosure policy. A maintainer may see full
inputs, findings, provenance, and verifier detail. A public contributor may
receive a result-only Disclosure Projection such as pass/fail, safe summary,
and remediation without learning private source, test names, fixtures,
customer data, timing, or object identifiers.

Disclosure projection does not alter the underlying Evidence or validity key.
Audience changes can invalidate a projection or require a new projection
contract, but they do not rewrite the Run. Sealed Verifiers follow the
additional contract in ADR 0004, including side-channel policy, appeals, and
safe unknown-resource behavior.

## Consequences

- Evidence remains useful as a durable historical assertion without being
  mistaken for current truth after its inputs change.
- Developers and agents see exactly why a Change is blocked and what action can
  restore validity.
- Cached checks can accelerate iteration while remaining subordinate to exact
  provenance and policy validation.
- Public contribution and private compatibility testing can share a logical
  Change without exposing restricted Evidence.
- Policy, review, Release, and Promotion systems can consume one normalized
  Evidence contract rather than interpreting tool-specific green checks.
- The ledger, object store, and disclosure layer must preserve more metadata
  than a conventional CI status table, but that metadata is what makes
  revocation, audit, and rollback trustworthy.

## Rejected alternatives

- **Green check as permanent truth:** source, policy, Target, toolchain, and
  verifier changes make this unsafe.
- **Mutate an Evidence record after rerun:** destroys historical provenance and
  makes old approvals impossible to audit.
- **Reuse cache by source revision alone:** ignores policy, toolchain,
  dependencies, verifier, Target, effects, and disclosure context.
- **Approval attached only to Change ID or branch:** allows a reviewer to appear
  to approve a different revision than the one inspected.
- **Return private verifier failures to public contributors:** leaks source,
  fixtures, customer data, or timing through result detail.
- **Treat agent or model explanation as Evidence:** explanations are useful
  context but are not reproducible assertions.
- **Use SLSA/SBOM/in-toto as Anyam's whole model:** these standards cover
  adjacent provenance or inventory concerns; Anyam still owns Project, Change,
  disclosure, policy, and Promotion semantics.

