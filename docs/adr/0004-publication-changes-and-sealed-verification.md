# Govern Publication Changes and Sealed Verification as disclosure workflows

Status: Accepted

## Context

Anyam must support a Project that publishes a useful open-source Source Space while retaining a private implementation, test suite, customer-derived data set, or operational history. A visibility toggle is unsafe: private Git history, object reachability, commit metadata, license obligations, secrets, and collaboration records can disclose information even when the current file listing looks public.

Public contributors also need meaningful validation against restricted implementations or data. Giving them private repositories or raw CI output would defeat Source Space isolation. Returning an unexplained green check, however, is not sufficient for engineering feedback or appeal.

The owner resolved the Publication Change and Sealed Verification decision tree in ticket [#12](https://github.com/Whyme-Labs/anyam/issues/12).

## Decision

### Publication Changes

1. A Publication Change creates or extends a new curated lineage inside an existing less-restricted Source Space. It does not create a new Source Space or repository for every publication, and it does not expose a reachable private parent object.
2. The default history policy is curated or selected history. Full historical publication is an explicit opt-in with its own review. Private commit messages, paths, issue links, comments, timestamps, and identities are omitted or transformed unless an explicit metadata-disclosure policy approves them.
3. Publication is a dedicated Change workflow with a disclosure preview and explicit irreversible confirmation. It is not a visibility toggle.
4. Structural disclosure checks are mandatory: inaccessible object reachability, secrets, license/provenance violations, prohibited personal or customer data, and other declared privacy rules block the Change. Anyam does not claim a universal test for whether a public profile builds, works, or is functionally complete; those are owner-declared Evidence and policy.
5. An uncertain secret, license, or privacy finding blocks publication until resolved or waived. A waiver is a versioned Policy Decision with scope, rationale, named independent approver, and expiry.
6. High-risk publication requires separation of duties. The author cannot be the sole approver for private-to-public disclosure, full history, customer-derived material, license uncertainty, or restricted-test exposure.
7. A published lineage is immutable and independent. Later restricted changes do not retroactively change it. Revocation prevents future distribution but cannot restore secrecy for clones, mirrors, or already disclosed history.
8. Publication appeals are first-class review state. Before Landing they may pause or reopen the Change. After disclosure they create an auditable publication incident and may stop future distribution or issue corrected lineage, but cannot erase exposure.

### Sealed Verification

9. External invocation is opt-in per Sealed Verifier and audience. A verifier is not externally callable merely because a contributor can see a Change or because it exists in an internal workflow.
10. Every Sealed Verifier has a versioned contract declaring accepted Project View or Change inputs, permitted audiences, output schema, side-channel class, appeal behavior, and approval requirements. Discovery is capability-safe: only explicitly published verifiers are visible, and inaccessible and nonexistent verifiers both return `not_found`.
11. Every sealed Run binds to an exact Change Revision, verifier version, toolchain, and owner-controlled private inputs. Contributors cannot choose, inspect, or alter restricted fixtures or implementation. The resulting Evidence records the declared input digests and disclosure policy.
12. Disclosure levels are explicit and owner-defined: `status`, `safe summary`, `redacted findings`, and `authorized detail`. Public contributors default to status and a bounded safe summary; verifier source, fixtures, raw logs, private names, and restricted traces remain private unless an audience is explicitly authorized.
13. Public results are asynchronous and coarse by default. The policy suppresses exact duration, test counts, cache state, resource usage, private identifiers, and distinguishable raw errors. High-sensitivity verifiers may deny external invocation entirely. Anyam does not claim perfect side-channel secrecy; it makes leakage policy explicit and offers safe denial.
14. Contributors can appeal a result against its exact Change Revision and Run. An appeal requests maintainer review or a deterministic rerun and returns only the same disclosure-safe projection. It cannot escalate to raw private Evidence.
15. Sealed Evidence becomes stale whenever any declared input or governing policy changes. Publication and Landing require fresh Evidence.
16. Contributors and maintainers receive different Disclosure Projections of one authoritative Change, Run, and Evidence record. Contributors see safe feedback and appeal state; authorized maintainers may see private linkage, raw findings, restricted traces, and the complete audit.

## Consequences

- Open-source contributors can receive useful compatibility feedback without receiving proprietary source, fixtures, or customer data.
- The public interface must explain safe summaries and appeals without implying that a public pass proves universal buildability.
- Publication and verifier policies become versioned project state and must participate in Evidence freshness and audit.
- The system needs a stable, machine-readable disclosure contract instead of ad hoc CI log filtering.
- Public disclosure is intentionally irreversible. Recovery is through corrected lineage, distribution controls, incident handling, and future Publication Changes—not a false promise of deletion.
- High-risk publication has more ceremony, but the ceremony is visible and progressive rather than hidden in a permission error.

## Rejected alternatives

- **Visibility toggle on existing private history**: exposes historical objects or metadata and cannot safely be reversed.
- **Require every public profile to build or work**: Anyam cannot define functional completeness for every Project type; owners must provide the relevant Evidence and policy.
- **Return raw private CI output to contributors**: creates an implementation, data, and side-channel disclosure channel.
- **Hide verifier failure behind a green/red check**: prevents useful contribution and makes appeals impossible to ground in an exact Run.
- **Let agents decide disclosure or resolution**: an explanation is not a Policy Decision, Evidence, or independent approval.
