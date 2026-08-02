# Anyam system threat-model research

**Research snapshot:** 2 August 2026  
**Ticket:** [#22](https://github.com/wms2537/anyam/issues/22)  
**Purpose:** primary-source security receipts and threat-model inputs for the accepted Anyam architecture

This note records external security and platform facts that inform ADR-0014. The asset inventory, trust boundaries, adversaries, and Anyam-specific requirements are design analysis derived from those facts and the accepted Anyam ADRs; they are not claims that an external source has validated Anyam.

## Executive findings

1. Anyam must treat every request as resource-specific and re-evaluate authority at the resource boundary. NIST's zero-trust architecture explicitly rejects implicit trust based on network location or asset ownership and separates authentication from authorization. [NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final)
2. Remote MCP is an OAuth-protected HTTP resource, while stdio MCP should not use the HTTP authorization flow. The current MCP authorization profile requires protected-resource metadata, authorization-server discovery, resource indicators, issuer validation, and audience-specific access tokens. [MCP authorization, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
3. Agent-specific risks are not limited to prompt injection. OWASP's current LLM list includes prompt injection, insecure output handling, supply-chain vulnerabilities, sensitive-information disclosure, insecure plugin design, excessive agency, and model denial of service. [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
4. Cloudflare execution is a bounded lane, not a universal isolation or networking guarantee. Sandbox security and outbound-traffic controls are documented as managed isolation and HTTP/HTTPS policy surfaces; they do not imply arbitrary protocol filtering or that a hostile workload is safe without an Anyam job boundary. [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/), [Sandbox outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)
5. Queue delivery must be treated as at-least-once. Duplicate and out-of-order delivery are normal inputs to the Run, Landing, Release, and Promotion state machines. [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
6. SLSA describes provenance and build-integrity expectations, but it does not define Anyam's Source Space disclosure, Change, Project Revision, policy, or Promotion semantics. Anyam must preserve imported attestations without upgrading insufficient provenance into an Anyam-reproducible Build claim. [SLSA specification v1.2](https://slsa.dev/spec/v1.2/)

## Scope and assumptions

The threat model covers:

- public, hybrid-source, and closed-source Projects;
- multiple Source Spaces and capability-composed Project Views;
- Git HTTPS through the Realm-owned Git Gateway and replaceable Repository Drivers;
- local and remote CLI/MCP coding agents;
- Cloudflare and external pull Runners;
- sealed Verifiers, Evidence, Artifacts, Releases, Targets, Mirrors, exports, and backups;
- customer-operated Realms where Anyam and the customer share a Cloudflare control plane;
- humans, services, agents, models, verifiers, adapters, and external systems as distinct Actors.

The model assumes that source confidentiality, integrity of landed state, provenance, and safe promotion are more important than making every operation available during an authority or dependency outage. Low-risk public reads may have explicitly designed degraded behavior; protected operations fail closed when required context is unknown.

## External source receipts

| Receipt | Security implication for Anyam |
|---|---|
| NIST SP 800-207 defines zero trust around resources and rejects implicit trust from network location or ownership. | Network placement, Cloudflare account ownership, a local workstation, and a runner enrollment are not sufficient authority. |
| MCP 2026-07-28 distinguishes HTTP authorization from stdio and requires resource metadata/discovery and resource indicators. | Remote MCP tokens must be audience-bound and validated at the MCP resource; local stdio must use a local broker instead of pretending to be a remote OAuth resource. |
| OWASP LLM Top 10 lists prompt injection, insecure output handling, sensitive-information disclosure, insecure plugin design, excessive agency, supply-chain risk, and model DoS. | Agent tools, model context, generated commands, tool results, and budgets need independent policy and validation. |
| Cloudflare Sandbox documents isolated execution and a brokered outbound HTTP/HTTPS surface. | Sandbox is an execution adapter with explicit capabilities, not a universal security boundary for arbitrary network protocols or all hostile workloads. |
| Cloudflare Queues documents at-least-once delivery. | Every queue-triggered state transition needs an idempotency key, expected-state guard, and durable duplicate handling. |
| SLSA v1.2 defines provenance-oriented build security. | Anyam should normalize provenance and attestations at its boundary but retain the distinction between an attested external result and an Anyam-reproducible Build. |

## Assets and security properties

The following assets are authoritative or security-sensitive. Each must have an owner, disclosure policy, integrity mechanism, and recovery path.

| Asset | Confidentiality | Integrity | Availability | Primary failure impact |
|---|---|---|---|---|
| Canonical Repository and Source Space snapshots | Source Space policy | Landing and Repository Driver integrity | Git read/write service | Source disclosure or corrupt Project state |
| Project View and public projection | Hidden-space metadata must remain absent | Projection must match authorized state | Public clone/browse | Private code or metadata leakage |
| Project Revision, Change, Change Revision, Cohort | Restricted work and review context | CAS Landing and immutable history | Collaboration workflow | Unauthorized or incorrect source transition |
| Workspace Repositories and local context | Task and model policy | Actor-scoped writes and exact base | Developer/agent iteration | Token abuse, cross-task contamination |
| Capability Grants, sessions, credentials, and auth epochs | Credential and identity secrecy | Realm policy and revocation | Protected operation access | Privilege escalation or replay |
| Secret broker and Secret Use bindings | Secret values | Allowlisted operation and audience | Approved runtime/test integration | Production secret exposure or unauthorized effects |
| Run inputs, logs, caches, Artifacts, and Evidence | Disclosure Projection and trust-zone policy | Exact input/output digests and attestation | Verification and delivery | False evidence, leakage, or blocked delivery |
| Release, Target, Promotion, and rollback state | Private deployment data | Immutable Release and guarded Promotion | Runtime/package delivery | Unauthorized production change or unsafe rollback |
| Project Content, agent context, model requests, and outputs | Model/provider policy | Provenance and disclosure | Agent operation | Sensitive data sent to a disallowed processor |
| Audit Ledger and exports | Audience-safe audit history | Append-only, attributable events | Investigation and recovery | Undetectable or unprovable compromise |
| Mirrors, backups, and Project Exports | External disclosure policy | Digest, lineage, and reconciliation | Disaster recovery | Irreversible public leakage or unrecoverable state |

## Trust boundaries

Trust boundaries are places where Anyam must authenticate, authorize, validate, constrain, or transform data. A boundary is not safe merely because both sides run on Cloudflare or belong to one customer account.

1. **Browser/CLI/IDE/MCP client → Realm and Git Gateway.** Treat clients as untrusted. Validate issuer, audience, session, client, grant, authorization epoch, and request shape. Never accept upstream identity tokens as Anyam authority.
2. **Remote MCP → Forge API.** Enforce the MCP HTTP authorization profile and reject token passthrough, query credentials, wrong audiences, stale grants, and tools not allowed by the current task.
3. **Local MCP broker → local agent process.** Keep refresh credentials in the OS keychain or broker process, expose only the active task capability, restrict the local transport, and do not put secrets in model context or configuration files.
4. **Git Gateway → Repository Driver.** The Gateway owns stable URLs, policy, audit, and short-lived exchange. The Driver receives provider-scoped credentials only after policy allows the exact Source Space and operation.
5. **Source Space → Project View/public projection.** Compose only accessible objects and metadata. Hidden objects must be absent and use safe `not_found`; no path, object ID, timing, cache, search, or notification side channel may identify them.
6. **Human/agent Workspace → canonical source.** Workspaces are writable; canonical repositories are not. Only trusted Landing performs CAS updates from an approved Cohort.
7. **Anyam coordinator → Cloudflare or external Runner.** Job identity narrows the parent grant to one Run attempt, input manifest, Project View, Action/Verifier, network aliases, Secret Use aliases, and output locations.
8. **Runner/verifier → Project Content, secrets, and external network.** Read exact authorized inputs; write only scoped outputs; use deny-by-default network and brokered Secret Use; reject undeclared effects and unbounded command execution.
9. **Queue/Workflow delivery → state machine.** Assume duplicate, delay, reordering, retry, cancellation ambiguity, and partial completion. State transitions require idempotency and expected-current-state checks.
10. **Object storage/cache → coordinator.** Content-addressed objects are untrusted until digest, signer, disclosure, grant, and validity key are checked. A cache never creates authority or fresh Evidence.
11. **Release/Promotion → Target adapter.** Adapters perform provider mechanics; Anyam retains Release lineage, policy, expected-state guard, health verification, and audit. Deployment never rebuilds unbound source.
12. **Anyam Realm → external mirror, verifier, registry, identity provider, or customer Cloudflare account.** Integrations are separate principals with installed, resource-scoped grants. External success is an input or attestation, not a local authority decision.
13. **Realm control plane → audit, backup, and export.** Audit and recovery outputs may contain concentrated sensitive metadata. Apply disclosure projection, encryption, retention, integrity verification, and restore qualification.

## Adversaries and abuse goals

| Adversary | Typical capability | Abuse goal |
|---|---|---|
| Unauthenticated public visitor/contributor | Public View and mutation entry points | Enumerate hidden source, exhaust resources, inject malicious Changes, infer private verifier behavior |
| Compromised human account/device | User session or CLI refresh credential | Read restricted spaces, grant an agent too much authority, approve or promote unauthorized state |
| Malicious maintainer or insider | Legitimate project or Realm role | Publish contamination, suppress audit, exfiltrate private code, abuse break-glass, weaken policy |
| Compromised coding agent/model/client | Task Workspace and approved tools | Prompt/tool injection, secret use, source exfiltration, unauthorized commands, excessive agency, denial of service |
| Hostile repository or dependency | Code executed by Actions, Verifiers, previews, or IDEs | Runner escape, credential theft, dependency poisoning, malicious build scripts, data exfiltration |
| Compromised Runner or verifier | Job identity, output channel, or execution host | Forge false Evidence/Artifacts, replay jobs, read other tenants, retain credentials, tamper with results |
| Malicious adapter/integration/mirror | Installed app or external endpoint | Token confusion, fake status, rewrite/diverge mirror history, corrupt Release or Target state |
| Cross-tenant implementation bug | Requests crossing Realm/Project/Source Space keys | Read or mutate another customer’s Project Content or policy |
| Supply-chain attacker | Package, image, action, provider, build tool, signing key | Build tampering, provenance forgery, credential theft, malicious release |
| Availability attacker | Public API, Git, queue, runner, model, or target | Resource exhaustion, queue flooding, expensive model/tool loops, deployment disruption |
| Cloud/platform compromise | Cloudflare account, provider control plane, or managed service | Bypass infrastructure isolation, alter storage, intercept traffic, destroy recovery copies |

## Threat catalogue and priority

Priority is qualitative and reflects the consequence of bypassing a hard boundary plus the plausibility of the attack. It is not a numerical risk score. A high-priority threat must have a verification obligation before the affected capability is treated as production-ready.

### Critical

- **Canonical write or Promotion bypass:** an agent, user, integration, queue replay, or adapter advances canonical source or a protected Target without an approved exact Change Revision, Evidence set, policy decision, and expected-current-state guard.
- **Cross-Source-Space or cross-Realm disclosure:** a Project View, Git object graph, search index, cache, error, mirror, export, log, model context, or timing path reveals hidden code or metadata.
- **Credential confusion or replay:** an MCP token is accepted by Git or a Target; a Git credential is accepted by MCP; a derived grant widens authority; a stale grant remains usable after revocation.
- **Secret disclosure or unauthorized Secret Use:** raw production secrets enter a Workspace, Runner, model context, log, Artifact, Evidence, cache, or public projection, or a broker performs an operation outside its allowlist.
- **False integrity/provenance:** a hostile Runner/verifier/adapter produces accepted Evidence or Artifacts for inputs it did not run, changed, or was not authorized to see.
- **Unsafe publication:** a Publication Change exposes private code, history, credentials, customer data, license-restricted material, or hidden object metadata, or makes a public lineage imply more than it contains.
- **Cross-tenant mutation:** a keying, authorization, storage, queue, cache, or restoration error lets one Realm read or alter another Realm's Project Content.

### High

- Agent prompt injection or malicious repository instructions cause unapproved tool use, Source Space transfer, network access, or policy bypass.
- Runner escape, insufficient cleanup, cache poisoning, undeclared network access, or output-path confusion crosses task or tenant boundaries.
- Stale Evidence or approval survives a source, effect, policy, Target, disclosure, verifier, toolchain, dependency, or authorization-epoch change.
- Queue duplication, reordering, retry, or cancellation ambiguity creates duplicate Landing, Release, Promotion, or Secret Use side effects.
- Mirror or external integration divergence overwrites accepted state, creates an infinite loop, or imports untrusted refs as canonical.
- Dependency, container image, Action, Verifier, signing-key, or provider compromise changes a Release without a trustworthy attestation.
- Audit events are omitted, mutable, attributed to the wrong principal/actor, or exported with hidden-content leakage.
- Resource exhaustion makes protected service state unavailable or causes unbounded model, Runner, storage, or Target cost.

### Medium

- Public status, cache, timing, error, search, notification, or quota differences reveal the existence or activity of a hidden object without source disclosure.
- A rollback is source-correct but incompatible with the current database or external state.
- A public mirror loses availability or history while the Anyam canonical state remains recoverable.
- A model or verifier produces an incorrect explanation that a human mistakes for Evidence, without independently bypassing policy.
- A customer-operated Realm misconfigures retention, encryption, identity providers, or external runner enrollment.

### Low / accepted design noise

Harmless duplicate queue deliveries, expired candidate outputs, cache misses, rejected unknown resources, and agent revisions that fail checks are expected states when they are visible, idempotent, and cannot advance authority.

## Security requirements and verification obligations

The following requirements are normative for the corresponding boundary. Verification is an executable qualification obligation, not a future aspiration.

| Boundary | Requirement | Qualification gate |
|---|---|---|
| Auth/token | Credentials are issuer-, audience-, client-, task-, and resource-bound; refresh and access lifetimes are separate; no token passthrough. | Negative matrix: exchange an MCP token at Git, Runner, Target, and another Realm; each is rejected. Revoke parent grant and prove all derived protected operations fail. |
| Policy | Deny-first intersection, explicit denies, safe unknown context, policy version/epoch, explainable result. | Property tests over grant/role/policy combinations; stale epoch and missing context tests; explanations contain blocker/remediation without hidden resource metadata. |
| Git Gateway | Public projection only for anonymous reads; short-lived Workspace credentials; canonical write denied to users/agents. | Clone/fetch/push matrix across Source Spaces and Workspace states; stolen Workspace token cannot push canonical refs or another Project. |
| Project View | Hidden objects are unreachable and undiscoverable, including paths, IDs, search, errors, caches, mirrors, exports, and timing-sensitive responses. | Differential disclosure tests with public and privileged principals; object-graph traversal, search, cache-hit, error, and notification probes. |
| Workspace/Landing | Landing is CAS against exact Cohort base and approved revisions; agent never gets canonical write. | Replayed, reordered, stale-base, duplicate, altered-diff, and unauthorized-approver scenarios; assert no canonical mutation. |
| Agent/MCP | Tool calls are task-scoped; repository content and tool outputs are untrusted; prompt injection cannot expand grants. | Malicious README/issue/commit/tool-result corpus; attempt every forbidden tool/effect; verify model context excludes hidden Source Spaces and raw credentials. |
| Secret Use | Broker allowlists operation and alias; raw value cannot enter process, logs, Artifact, Evidence, cache, or model context. | Canary secret tests through every supported Runner lane, log sink, error path, retry, cancellation, and output upload; verify use works without read. |
| Runner | Job grant narrows to one attempt and exact inputs; isolation, network, cleanup, output, signing, and cancellation are explicit. | Hostile workload suite per Runner profile: filesystem/process/network escape, cross-tenant reads, stale job token, retry/replay, cancellation, cleanup, and output tampering. |
| Queue/Workflow | Delivery is at-least-once and unordered; transitions are idempotent and expected-state guarded. | Duplicate/out-of-order/failure-injection harness across Run, Evidence, Landing, Release, Promotion, mirror, and revocation flows. |
| Evidence/attestation | Exact validity key; stale on material input/policy/disclosure/Target changes; imported provenance not upgraded. | Mutate each key component and assert stale/approval invalidation; forged signer, wrong input digest, wrong audience, and insufficient provenance tests. |
| Publication | Curated lineage, structural scan, license/privacy/secret/object reachability review, independent approval, irreversible history disclosure. | Fixture set containing secrets, private metadata, license conflicts, renamed objects, large blobs, hidden references, and malicious history; verify public clone receives only the selected lineage. |
| Release/Target | Immutable Release; Promotion only from approved Release; adapter result normalized; rollback is a new guarded Promotion. | Repeat, reorder, fail, and retry promotions; verify no rebuild from moving source, no unauthorized Target access, health evidence required, and rollback compatibility is explicit. |
| Mirror/integration | External refs are proposals; permitted refs only; reconciliation is digest/lineage based and loop-safe. | Bidirectional mirror fault injection: divergence, duplicate webhook, force update, deletion, outage, hostile ref, and replay; canonical state must remain Landing-owned. |
| Storage/export/audit | Content-addressed objects, append-only Audit Events, disclosure-safe exports, encrypted recovery, verified restore. | Corruption, deletion, replay, unauthorized presigned access, restore, export redaction, and audit tamper tests; compare restored Project Revision and provenance digests. |
| Tenant/BYOCF | Every storage, queue, cache, token, object, log, and adapter key includes Realm and resource scope; customer account is not implicit authority. | Automated cross-Realm/property tests plus isolated account qualification; fuzz identifiers and retry paths; prove no read/write path crosses Realm. |

## Verification process

Each qualification gate must produce an Evidence record bound to the exact source, test harness, Runner, toolchain, policy version, and disclosure contract. A green result is not enough: the gate must retain failures, rejected attempts, and stale invalidation causes.

The threat model itself is versioned. A material architecture, provider, Source Space, authentication, Runner, verifier, Target, disclosure, or policy change creates a new threat-model review Change. It may invalidate security Evidence and approvals even when source files are unchanged.

## Residual risks

The controls above reduce but do not eliminate these risks:

- A fully authorized human can approve malicious or incorrect source. Mitigation: progressive ceremony, independent approval for high-risk effects, visible Evidence, and immutable audit. Owner: Project/Realm operators.
- A model can be confidently wrong or manipulated by prompt injection. Mitigation: capability boundaries, untrusted-context treatment, deterministic Verifiers, and human review. Owner: Anyam product and Project owners.
- Cloudflare or another provider can suffer a control-plane compromise or outage. Mitigation: provider abstraction, exports, digests, restore qualification, customer-operated Realm, and external Runner option. Owner: Anyam operators and customer Realm owner.
- An external Runner host may have a kernel, hardware, or tenant-isolation flaw. Mitigation: enrollment profiles, short-lived job grants, immutable inputs, no canonical write, scoped outputs, quarantine, and runner-specific qualification. Owner: Runner operator and Anyam adapter owner.
- Side channels can leak the existence or activity of restricted state even when payloads are hidden. Mitigation: safe projections, coarse or asynchronous sealed results, cache isolation, quota policy, and explicit disclosure review. Owner: Source Space owner and Anyam security owner.
- Denial of service and provider cost attacks cannot be eliminated by authorization alone. Mitigation: visible measured tripwires, admission policy, quotas sized from receipts, idempotency, cancellation, and owner alerts. Owner: Realm operator.
- Publication is irreversible after an external clone or mirror. Mitigation: preview and independent review; communicate that prospective privacy cannot retract prior disclosure. Owner: Publisher.
- Legal, licensing, export-control, privacy, and customer-contract judgments remain human responsibilities. Mitigation: policy hooks, provenance, review evidence, and documented owner decisions; Anyam does not assert legal compliance automatically. Owner: Project/Realm operator.

These are explicit residual risks, not reasons to silently weaken the boundaries. A launch decision must name which residual risks are accepted and by whom.

## Sources

- [NIST SP 800-207: Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final)
- [MCP Authorization, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [OWASP Top 10 for Large Language Model Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- [Cloudflare Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/)
- [Cloudflare Sandbox outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)
- [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [SLSA specification v1.2](https://slsa.dev/spec/v1.2/)
- [Anyam authentication and delegation standards profile](2026-08-02-authentication-and-delegation-standards.md)
- [Anyam explainable capability policy](../adr/0008-explainable-capability-policy.md)
- [Anyam portable pull-runner plane](../adr/0012-cloudflare-default-and-portable-pull-runners.md)
- [Anyam Evidence validity and provenance](../adr/0013-evidence-validity-policy-and-provenance.md)
