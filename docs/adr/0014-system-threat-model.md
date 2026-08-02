# System threat model and security qualification gates

Status: Accepted

## Context

Anyam combines Git-compatible source transfer with capabilities that Git does
not normally model: independently protected Source Spaces, composed Project
Views, autonomous agents, sealed Verifiers, portable Runners, Evidence-bound
Landing, Releases, Targets, bidirectional Mirrors, and customer-operated
Realms. A conventional repository threat model would miss the boundaries
between those objects.

Issue [#22](https://github.com/wms2537/anyam/issues/22) asked for a prioritized
threat model covering assets, trust boundaries, adversaries, metadata leakage,
supply-chain attacks, agent attacks, cross-tenant failures, publication
failures, operational compromise, residual risks, and verification obligations.
The primary-source research and threat catalogue are in
[`docs/research/2026-08-02-system-threat-model.md`](../research/2026-08-02-system-threat-model.md).

The threat model is a design constraint, not a promise that a deployment is
secure merely because it uses Cloudflare, OAuth, a sandbox, a signature, or a
green check. Every high-risk boundary needs a qualification gate bound to the
exact implementation, policy, toolchain, and disclosure context being claimed.

## Decision

### Security objectives

Anyam protects these properties in priority order:

1. **Disclosure integrity:** an Actor can discover and receive only the
   Project View, Source Space, Project Content, model context, Evidence, and
   operational metadata allowed by the current policy.
2. **State integrity:** only trusted authority can create a new canonical
   Project Revision, Release, or protected Target state, and each transition
   is bound to exact prior state and approvals.
3. **Credential and delegation integrity:** credentials are audience- and
   task-bound; derived authority only narrows; revocation and policy epochs
   take effect for protected operations.
4. **Evidence integrity:** Runs, Evidence, Artifacts, Releases, and
   attestations retain exact inputs, producer identity, disclosure, and
   validity state; stale or insufficient provenance cannot authorize delivery.
5. **Tenant and trust-zone isolation:** Realms, Projects, Source Spaces,
   Workspaces, Runners, caches, mirrors, and customer accounts cannot cross
   their declared boundaries.
6. **Recoverability and accountability:** every authority-bearing transition
   is attributable and exportable; recovery restores verifiable state rather
   than silently rewriting history.

Availability and developer convenience matter, but they do not override these
objectives. Public or low-risk operations may have explicitly designed
degraded behavior. Protected operations fail closed when required authority,
integrity, or disclosure context is unknown.

### Assets and boundaries

The authoritative asset inventory and thirteen trust boundaries are recorded
in the research note. The durable rule is:

> Anyam treats every client, agent, model, Runner, verifier, adapter, mirror,
> queue delivery, cache, and provider response as untrusted at the boundary
> where it enters a protected state transition.

Cloudflare account ownership, network location, Runner enrollment, an
authenticated upstream identity, a valid signature, or membership in one
organization is not by itself sufficient authority. The Realm resolves the
principal, Actor, Session, Task, policy, grant, audience, epoch, and exact
resource before allowing a protected operation.

### Threat priority

Priorities are qualitative rather than numerical. We do not publish a risk
number without a receipt. A **Critical** threat can disclose or corrupt a hard
boundary or advance protected state without its required evidence. A **High**
threat can bypass an important control, produce false trust, or materially
disrupt protected work. **Medium** threats leak lower-sensitivity metadata,
create recoverable operational harm, or require additional conditions. Low-risk
duplicate or rejected states are accepted only when they are visible and
cannot create authority.

The current Critical set is:

- canonical-source or protected-Target bypass;
- cross-Source-Space or cross-Realm disclosure;
- credential audience confusion, replay, or authority widening;
- raw secret disclosure or unauthorized Secret Use;
- false Evidence, Artifact, or provenance accepted as authoritative;
- unsafe Publication Change;
- cross-tenant mutation.

The current High set is:

- agent prompt/tool injection and excessive agency;
- Runner escape, cleanup failure, cache poisoning, or undeclared network;
- stale Evidence or approval surviving material state changes;
- duplicate/reordered/cancelled queue or workflow side effects;
- Mirror/integration divergence or loop;
- dependency, Action, Verifier, image, key, or provider compromise;
- missing or mutable Audit Events;
- resource exhaustion and cost attacks.

The complete catalogue and residual Medium risks remain in the research note;
this ADR records the policy that the catalogue must exist and be updated with
the architecture.

### Normative security requirements

The following requirements are load-bearing:

1. **Authentication and audience isolation.** Remote MCP follows its HTTP
   authorization profile; local stdio MCP uses a local broker. MCP, Git,
   Runner, integration, and Target credentials are separate audiences. Anyam
   never forwards one protocol token to another service.
2. **Deny-first authorization.** The ADR-0008 pipeline resolves the exact
   resource and task grant, intersects policy and context, applies approvals
   and explicit denies, and returns a disclosure-safe Policy Explanation.
3. **Safe Project Views.** A hidden Source Space is absent from the Project
   View's object graph and metadata. Anonymous public Git reads use only the
   public projection; inaccessible resources use safe `not_found`.
4. **No arbitrary canonical writes.** Humans, coding agents, Runners,
   verifiers, Mirrors, and adapters publish proposals or scoped outputs. Only
   trusted Landing authority performs the CAS transition to canonical source.
5. **Exact transition binding.** Landing, Release creation, and Promotion
   bind exact Change Revision, Project Revision, Evidence, effects, Target,
   policy version, and expected current state. Duplicate and stale requests
   do not create a second accepted transition.
6. **Secret Use, not secret read.** A broker may perform an allowlisted
   credential-backed operation without exposing the value to the Actor,
   Workspace, Runner, model context, logs, Artifact, Evidence, or cache.
7. **Bounded execution.** Every Run uses an immutable input manifest, narrowed
   job Capability Grant, declared network and Secret Use aliases, scoped output
   locations, explicit cancellation, cleanup, and signed result validation.
8. **Evidence and provenance.** Evidence is immutable and keyed to all
   material source, Action/Verifier, toolchain, dependency, effect, policy,
   Target, disclosure, and sealed inputs. Stale or insufficiently attested
   output cannot authorize Landing or Promotion.
9. **Publication safety.** Publication is a previewable curated lineage with
   structural secret/license/privacy/object-reachability checks, independent
   approval for high-risk disclosure, and explicit irreversible-publication
   semantics.
10. **Audit and recovery.** Authority-bearing operations create immutable,
    attributable Audit Events. Exports, backups, mirrors, and restores retain
    digests, disclosure policy, lineage, and schema versions.

### Qualification gates

No boundary is production-qualified until its gate is exercised against the
exact code and policy version. The gates in the research note are normative;
the minimum set is:

- token exchange and audience negative tests across MCP, Git, Runners,
  Targets, and Realms;
- authorization property tests for deny, indeterminate, explicit deny,
  revocation epoch, and safe-remediation behavior;
- public/privileged Project View differential tests, including object graph,
  search, cache, errors, timing, notifications, mirrors, and exports;
- replay, reorder, stale-base, duplicate, altered-diff, and unauthorized
  approver tests for Landing and Promotion;
- malicious repository, prompt, issue, commit, and tool-result tests against
  every agent capability;
- Secret Use canaries through every Runner lane, log sink, retry, cancellation,
  and output path;
- hostile-workload and cleanup tests for every Runner capability profile;
- duplicate/out-of-order/failure injection across queue/workflow state
  machines;
- Evidence-key mutation, forged signer, wrong digest, wrong audience, stale
  policy, and insufficient-provenance tests;
- publication fixtures containing secrets, private metadata, license conflicts,
  hidden references, and malicious history;
- cross-Realm property tests over storage, queue, cache, token, audit, and
  restoration keys;
- corruption, deletion, unauthorized object access, export redaction, and
  restore verification for recovery paths.

Each gate produces Evidence with the exact source, harness, Runner, toolchain,
policy, grant, disclosure contract, and result. A failure is retained and
visible. A passed gate becomes stale when its material inputs or governing
policy change.

### Incident response and revocation

The incident path is itself a state machine:

```text
detect or report
→ classify affected asset and boundary
→ increment relevant authorization epoch
→ revoke grants and protocol credentials
→ quarantine Workspaces/Runners/Artifacts where needed
→ stop or compensate external side effects
→ preserve Audit Events and forensic objects
→ assess disclosure and provenance impact
→ recover from verified state
→ publish a new policy, Evidence, or Publication Change if required
→ review residual risk and owner acceptance
```

Break-glass can bypass only explicitly listed operational gates; it cannot
bypass Source Space isolation, audience checks, immutable history, audit, or
credential safety. Any use creates an alert and mandatory post-incident
review.

### Residual-risk register

Anyam does not claim to eliminate:

- a fully authorized human approving malicious or incorrect work;
- model error or prompt injection that is caught only by review or testing;
- Cloudflare/provider compromise or prolonged provider outage;
- a kernel, hardware, or tenant-isolation flaw in an external Runner;
- all timing, quota, and availability side channels;
- irreversible disclosure after a public clone or mirror;
- legal, license, privacy, export-control, or customer-contract judgment;
- customer misconfiguration in a Customer-operated Realm.

Each launch or customer deployment must name the owner who accepts these
risks and the current mitigation Evidence. A residual risk is not permission
to weaken a hard boundary silently.

## Consequences

- Security semantics are shared by the browser, CLI, Git, MCP, agents,
  Runners, Mirrors, Verifiers, adapters, and Targets rather than reimplemented
  in each client.
- The platform must maintain a threat catalogue, qualification harnesses,
  disclosure tests, and incident/recovery runbooks alongside the product.
- A Cloudflare-native execution lane remains useful but is not treated as a
  universal trust boundary; the portable Runner contract is security-critical.
- The design has more explicit state and metadata than a conventional Git
  forge. That complexity is intentional: it makes hidden authority and stale
  trust visible to developers and agents.
- Availability fallbacks, cache hits, queue retries, and imported attestations
  remain subordinate to policy and exact-state validation.

## Rejected alternatives

- **Network perimeter as the security model:** conflicts with zero-trust
  resource-level authorization and fails for agents, customer accounts, and
  external Runners.
- **One global repository token:** cannot express Source Spaces, task scope,
  audience, model policy, Secret Use, or revocation epochs.
- **Sandbox equals trusted execution:** managed isolation does not make
  hostile source, tools, network, or output authoritative.
- **Signature equals truth:** a signature proves possession of a key, not that
  the signer used authorized inputs or that a result is current.
- **Green checks are permanent:** Evidence must become stale when material
  source, policy, verifier, effect, Target, disclosure, or provenance changes.
- **Last writer wins for mirrors or queues:** would let duplicate, stale, or
  untrusted external state bypass Landing and CAS guards.
- **Security by omission:** hiding a sensitive boundary from the UI or error
  response does not remove the threat; it makes the failure harder to detect.

## References

- [System threat-model research note](../research/2026-08-02-system-threat-model.md)
- [Realm-owned authentication and delegation](0007-realm-owned-authentication-and-delegation.md)
- [Explainable capability policy](0008-explainable-capability-policy.md)
- [CLI, Git, MCP, and agent connection](0009-cli-git-mcp-agent-connection.md)
- [Portable pull-runner plane](0012-cloudflare-default-and-portable-pull-runners.md)
- [Evidence validity and provenance](0013-evidence-validity-policy-and-provenance.md)
