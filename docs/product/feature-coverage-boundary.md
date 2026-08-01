# Anyam Feature Coverage Boundary

Status: Ratified by the owner on 2 August 2026

This catalog defines which capabilities Anyam owns, when they become necessary, what it integrates, and what it deliberately excludes. It applies the [Product Constitution](constitution.md), [Initial Market Wedge](initial-market-wedge.md), and [competitive coverage baseline](../research/2026-08-01-competitive-coverage-baseline.md).

It is a product-coverage decision, not the implementation sequence. Detailed release slicing remains a separate decision.

## Coverage classes

Every capability belongs to the earliest class whose necessity test it passes.

| Class | Necessity test | Meaning |
|---|---|---|
| **Innovation kernel** | Removing it makes Anyam an ordinary agent-enabled forge | Anyam must own and prove the capability in the first differentiated end-to-end system |
| **Credible team product** | The initial customer cannot use Anyam as its sole canonical forge for the 30-day validation without it | Required parity and production completeness around the kernel |
| **Enterprise expansion** | Needed for advanced identity, governance, compliance, scale, or administration after team adoption | Open-source enterprise capability, never a proprietary edition |
| **Ecosystem expansion** | Broadens public participation, distribution, project types, federation, or extensions | Added after the source and trust model is proven |
| **Integration surface** | Anyam must govern the interaction but should use a specialist provider | Anyam owns the contract, authorization, policy, normalized result, and audit—not necessarily the engine |
| **Explicit non-goal** | The capability violates the constitution or does not belong in the relevant product horizon | Permanent prohibitions are distinguished from deferred possibilities |

Two rules prevent scope distortion:

1. A parity feature does not enter the innovation kernel merely because an incumbent has it.
2. A differentiator does not leave the innovation kernel merely because it is difficult.

## Innovation kernel

The innovation kernel is the smallest coherent proof of Anyam's identity.

### Project and source model

- Project as the root managed object rather than a repository or application.
- Independently governed Source Spaces with separate object graphs, histories, visibility, access, licensing, and model-processing policy.
- Owner-declared Project Profiles.
- Capability-safe Project Views with no references or metadata from inaccessible Source Spaces.
- Immutable Source Space Snapshots and atomic Project Revisions across spaces.
- A replaceable repository driver over normal Git repositories.
- A standard-Git public projection that can be cloned without reaching private objects.
- A minimally usable composite Workspace with unified status and diff across authorized Source Spaces.

### Change and source authority

- Stable Change identity across revisions, rebases, repositories, and Source Spaces.
- Immutable Change Revisions identified by exact commits and Snapshots.
- One Change spanning public, private, internal, and restricted source.
- Explicit Change dependencies.
- Durable textual, symbol, contract, schema, dependency, infrastructure, behavior, intent, visibility, and policy Conflicts.
- Trusted Landing as the only path that advances canonical Project state.
- No ordinary human or agent canonical repository write credentials.

### Disclosure and publication

- Disclosure Projections for Changes, reviews, Runs, Evidence, Releases, and activity.
- Public contribution without private-source discovery.
- Governed Publication Changes rather than visibility toggles.
- Disclosure checks covering object reachability, metadata, search, events, timing, context, and notifications.

### Delegated human and agent authority

- Principal to Actor to Session to Task identity.
- Narrow, temporary, audience-bound Capability Grants with explicit denies.
- Task-scoped source, Workspace, Change, tool, network, Secret Use, budget, and duration authority.
- Source Space-specific model-processing policy.
- Revocation and expiry enforced by the Realm.
- Exact Context Manifests.
- Model-independent semantic agent operations through minimal CLI, API, and MCP surfaces.
- Isolated agent Workspaces and protected canonical source.

### Verification and policy

- Runs against exact immutable inputs.
- Revision-addressed, reproducible Evidence.
- Explicit Evidence freshness and invalidation.
- Sealed Verifiers with disclosure-controlled results.
- Human- and machine-readable Policy Explanations.
- AI output treated as a proposal or finding, never silent proof or approval.

### Artifact and release lineage

- Immutable Artifacts tied to exact source and execution inputs.
- Releases containing exact Artifacts, configuration, and Evidence.
- General Targets and policy-controlled Promotion.
- Deployment of the already verified Release without rebuilding a branch.
- One Cloudflare application Target sufficient to prove the chain end to end.

### Trust, ownership, and proof

- Immutable Audit Events connecting authority, source, agent context, policy, Evidence, Releases, and Promotion.
- Complete Project Export in documented versioned formats.
- A Customer-operated Realm requiring neither Anyam SaaS nor another forge.
- A hybrid-source Cloudflare reference Project demonstrating the entire kernel.

The kernel includes only the UI, Git, execution, and Cloudflare plumbing needed to demonstrate these invariants. It is not yet the credible team product.

## Credible team product

The credible team product is the kernel plus the minimum breadth, reliability, and familiarity required for a small team to keep Anyam canonical for a real Project.

### Everyday Git and source navigation

- Git Smart HTTP and SSH.
- Branches, tags, import, export, fetch, push, and protected canonical refs.
- Push and pull Repository Mirrors with divergence detection and loop prevention.
- Bidirectional GitHub mirroring: landed refs move outward; GitHub commits and pull requests enter as externally sourced Changes and pass normal Landing policy.
- Git LFS or an equivalent large-object path.
- Credential helper issuing short-lived repository credentials.
- Source browser, blame, history, textual diff, repository search, symbol definitions, and references.
- Fast public anonymous clone and authenticated private clone.

### Local and remote developer experience

- One-command Project clone, Workspace creation, and agent setup.
- Fast local edit, snapshot, diff, undo, and check loop without continuous Realm access.
- Operation Log and actionable interrupted-operation recovery.
- Change stacks, dependency visualization, refresh, rebase, and restacking assistance.
- Local checks against uncommitted work.
- IDE integrations using the same CLI and API contracts.
- Remote development Workspaces with terminals and preview services.

### Collaboration and review

- Intents/issues, labels, milestones, comments, attachments, subscriptions, and notifications.
- Pull-request-style Change pages and normal branch compatibility views.
- Inline review, suggestions, revision-to-revision comparison, and finding resolution.
- File, module, symbol, contract, schema, Source Space, and Target ownership.
- Required reviewers, approval invalidation, and separation-of-duty policy.
- Change dependencies, stacks, Integration Cohorts, and merge-queue compatibility views.
- Public issue and contribution intake with independently governed private implementation work.
- Safe linked public/private work and disclosure-specific status updates.

### Coding-agent workflows

- First-party setup for Codex, Claude Code, Cursor, and generic MCP or CLI agents.
- Local stdio MCP broker and project-scoped remote MCP.
- Local and remote agent Sessions.
- Agent handoff by immutable Change Revision rather than a shared mutable Workspace.
- Agent budgets, cancellation, leases, activity visibility, and immediate revocation.
- Structured agent findings and effects.
- No dependency on an Anyam-owned coding model.

### Actions, checks, and runners

- Small portable declarative Action and Verifier format.
- Reusable workflows, dependency graphs, affected checks, matrices, and parallel jobs.
- Logs, annotations, caches, Artifacts, cancellation, retry, timeouts, and retention.
- Managed bounded Linux execution on Cloudflare.
- Zero-trust pull runners for macOS, Windows, ARM, GPU, hardware, private-network, or oversized work.
- Deny-by-default network controls and Secret Use through a trusted broker.
- Explicit unsupported behavior rather than a false promise of full GitHub Actions compatibility.

### Identity and security baseline

- Local passkeys and upstream OAuth/OIDC.
- Organizations, teams, standard roles, ownership, and surface-specific permissions.
- Short-lived API, MCP, Git, agent, runner, integration, and Promotion credentials with separate audiences.
- Fine-grained expiring PAT compatibility fallback.
- App installations using short-lived installation grants.
- Step-up authentication for high-risk operations.
- Secret scanning and push protection.
- Dependency, SAST, and security-result ingestion through Verifiers.
- SBOMs, signed provenance, Artifact attestations, and audit export.

### Artifacts, Releases, and Targets

- Generic Artifact and OCI distribution.
- Artifact access separate from source access.
- Release pages, manifests, notes, downloads, signing, and verification.
- Preview, staging, and production Targets.
- Protected Promotion, approvals, health verification, gradual or atomic switching where supported, and rollback Evidence.
- Cloudflare application deployment adapter.
- Registry and release-download Targets for the non-web reference Project.

### Interfaces and operation

- Accessible web portal, complete CLI, stable REST API, project-scoped MCP, webhooks, and versioned events.
- Customer-operated installation, bootstrap, upgrades, schema migration, backup, restore, diagnostics, and status.
- Searchable Project catalog and activity views.
- Complete Git plus collaboration, Evidence, Artifact-index, Release, policy, and audit export.
- Documented recovery without an Anyam-operated service.

### Public project baseline

- Public Project and Source Space pages.
- Anonymous Git read and source browsing.
- Moderated issue and contribution intake.
- Independently permissioned source, issues, reviews, Runs, logs, Evidence, Artifacts, and Releases.
- Optional GitHub public mirror and contribution bridge without making GitHub canonical.

### Generality gate

The open-source Rust CLI/library reference Project must pass ordinary Git contribution, local-first and agent Changes, cross-platform checks, package and binary Releases, and non-runtime Target Promotion before Anyam may call this tier complete.

## Enterprise expansion

Enterprise expansion adds governance and operating scale to the same open-source product.

### Identity and conditional access

- SAML, multiple OIDC providers, SCIM, directory and group synchronization, and managed identities.
- Custom roles, delegated administration, session policy, and hardware-backed authentication.
- Device posture, network and location conditions, IP allowlists, authentication strength, and recent-authentication requirements.
- OAuth client trust classes, model-provider allowlists, and Source Space-specific access conditions.
- Audited break-glass recovery.

### Organization-wide governance

- Inherited policy packs and rulesets as code.
- Policy simulation, effect-aware rules, exceptions, expiry, and access reviews.
- Organization-wide ownership, separation of duties, approval delegation, and Project reporting.
- Cross-Project audit and Evidence queries without weakening Source Space disclosure.

### Compliance and security administration

- Retention schedules, legal hold, Evidence preservation, audit streaming, and SIEM export.
- Compliance mappings, attestations, signing policy, data-location controls, and customer-managed keys where feasible.
- Private security advisories, vulnerability intake, organization-wide findings, remediation campaigns, risk acceptance, and security exceptions.
- Integration with specialist scanner engines rather than a requirement that Anyam implement every scanner.

### Scale and fleet operation

- Multi-account Realm administration and organization-scale Project catalogs.
- Sharded search/read models, runner fleets, workload classes, quotas, and cost attribution.
- Large-repository tuning, advanced binary locking, backup policy, disaster recovery, and upgrade orchestration.
- External collaborator, partner, and customer-specific Disclosure Projections.
- Time-limited partner authority and delegated cross-organization approval.

### Managed operation

- Optional managed upgrades, support, compliance assistance, execution capacity, and customer-account administration.
- The same capabilities and code remain available to Customer-operated Realms.

### Integration-first enterprise suites

Portfolio planning, service desks, incident management, knowledge systems, and team communication integrate first through open contracts. They are not permanent exclusions. Native Anyam capabilities may later replace those integrations where user demand and the Project/Change/Evidence model justify them.

## Ecosystem expansion

Ecosystem expansion grows participation, distribution, project types, and independently operated infrastructure after the source and trust model is proven.

### Public project network

- Discovery, topic and code search across public Projects.
- Follows, stars, forks, contribution discovery, maintainer surfaces, and Release feeds.
- Preservation, archival, import continuity, and optional funding links.
- Abuse prevention, moderation, appeals, and transparent public-instance governance.

### Cross-Realm collaboration

- Federated identity and signed portable contributions.
- Cross-Realm Changes and public Source Space mirroring.
- Trust policy, moderation, revocation, abuse controls, and recovery when a Realm disappears.
- Federation only after disclosure and identity safety are qualified.

### Extension ecosystem

- Discoverable, signed Actions, Verifiers, agent adapters, repository drivers, Target adapters, templates, policy packs, UI extensions, and integration applications.
- Capability manifests, permission review, provenance, publisher identity, revocation, and supply-chain policy.
- Compatibility and lifecycle rules for extension APIs.

### Project-type ecosystem

- Mobile, desktop, ML model, dataset, data-pipeline, notebook, infrastructure, documentation, firmware, robotics, game, design, and large-asset adapters.
- Project-specific semantic diffs, candidate views, Evidence types, Artifact viewers, and Targets.
- External specialized runners where the default Cloudflare execution lane is unsuitable.

### Distribution and fork-and-run

- Ecosystem package adapters, static Pages, documentation hosting, model and dataset catalogs, update channels, and device or customer distribution Targets.
- Public templates, safe Project forking, preview Workspaces, agent-guided customization, and customer-account claiming.
- Community-operated public-interest Realms and migration between operators.

### Native collaboration expansion

- Planning, service-desk, knowledge, incident, and communication capabilities may move from integration to native product surfaces when they strengthen the canonical Project model.

## Integration surface

Anyam owns the open contract, installation lifecycle, authorization, policy, normalized output, provenance, and audit for every integration. The specialist system may own execution or presentation.

| Integration family | Anyam-owned contract | Typical providers |
|---|---|---|
| Source and contribution | Repository driver, Repository Mirror, ref mapping, divergence, external Change ingestion | GitHub, GitLab, Forgejo, Gitea, generic Git |
| Coding agents and models | Task capability, Context Manifest, tool surface, model-processing policy, result schema | Codex, Claude Code, Cursor, Copilot, Duo, Rovo, local models |
| Actions and verification | Immutable inputs, execution grant, finding/Evidence schema, disclosure class | Containers, scanners, test services, build systems |
| Runners | Pull job, proof of runner identity, immutable inputs, outputs, network and Secret Use | Cloudflare, macOS, Windows, GPU, ARM, on-premises runners |
| Identity and posture | Principal binding, claims mapping, authentication strength, posture result | Enterprise IdPs, Cloudflare Access, device providers |
| Secrets and signing | Secret Use, signing request, key identity, attestation | Secret stores, KMS, HSM, signing services |
| Artifacts and registries | immutable digest, metadata, access policy, publish/promote result | OCI, npm, PyPI, Cargo, model and dataset registries |
| Targets | Release manifest, capability grant, deployment/publish result, health and rollback Evidence | Cloudflare, clouds, app stores, package registries, fleets |
| Planning and service | Intent/work mapping, status projection, disclosure policy | Jira, Linear, ServiceNow, email service desks |
| Notifications and collaboration | safe event projection, subscription, response mapping | Slack, Teams, email, knowledge systems |
| Security | finding schema, severity, reproduction, disclosure, exception, evidence digest | SAST, DAST, SCA, fuzzing, malware and license tools |
| Observability and incident | Release identity, Target state, telemetry, incident linkage, audit export | Metrics, logging, tracing, incident and SIEM systems |

Integrations must receive narrow installation or Task capabilities and short-lived audience-specific credentials. They never inherit every Source Space, receive administrator PATs by default, or reuse an Anyam access token against an upstream provider.

### Required first-party adapters for the credible team product

- Generic Git plus bidirectional GitHub repository and pull-request mirroring.
- Codex, Claude Code, Cursor, and generic MCP/CLI agents.
- Generic command and container Actions.
- Cloudflare execution plus the pull-runner protocol.
- OAuth/OIDC and Cloudflare Access.
- Generic and OCI Artifact distribution.
- Cloudflare runtime Targets.
- Generic webhook, event, and audit export.

Jira, Linear, ServiceNow, Slack, Teams, specialist scanners, additional cloud Targets, package ecosystems, model registries, app stores, and observability platforms follow through the same contracts.

## Explicit non-goals and deferred possibilities

### Permanent constitutional exclusions

Anyam must never require or normalize:

- proprietary enterprise-only first-party capabilities;
- an Anyam SaaS or third-party forge for a Customer-operated Realm;
- inaccessible source hidden inside a discoverable Git object graph;
- broad normal-user or coding-agent canonical write authority;
- silent AI conflict resolution or unsupported AI judgment represented as Evidence;
- a Deployment that rebuilds and substitutes unverified output for the approved Release;
- sale of, advertising against, or model training on private Project Content; or
- non-exportable Project history or Cloudflare-only domain formats.

Anyam does not build a proprietary coding model as a required product layer. It may integrate, host, or broker open and commercial models under Source Space policy.

### Deferred from the kernel and credible team product

The following are not initial promises, but they may become native capabilities later:

- a new version-control object database or wire protocol;
- full GitHub Actions marketplace behavior compatibility;
- every package registry or scanner implementation;
- native replacements for planning, service, knowledge, incident, and communication suites;
- a general-purpose browser IDE;
- GitHub-scale public social discovery;
- federation and peer-to-peer replication;
- Mercurial or other source protocols; and
- deep mobile, ML, data, firmware, robotics, game, and design experiences.

Treat these as deferred, researched choices—not permanent product ceilings.

## Coverage gates

### Innovation-kernel gate

The hybrid-source reference Project must prove all of the following in one coherent workflow:

1. Independent public, private, internal, and restricted Source Spaces.
2. A normal public Git clone with no private reachability or metadata leakage.
3. One authorized composed Workspace with unified status.
4. One stable Change spanning differently disclosed source.
5. A coding agent constrained by an exact Context Manifest and Task Capability Grant.
6. Public checks plus a Sealed Verifier returning disclosure-safe Evidence.
7. Trusted Landing with no normal-user or agent canonical write credential.
8. Exact Artifact, Release, Target, and Promotion lineage.
9. Complete audit and Project Export.
10. Operation in a Customer-operated Realm without another forge.

### Credible-team gate

A 3–10 person team must:

1. Reach its first checked Change Revision, Artifact, or preview within 30 minutes.
2. Keep Anyam as the sole canonical forge for one real Project for 30 days.
3. Use at least two different coding-agent products.
4. Land at least 25 real Changes with required Evidence and attributable authority.
5. Give no human or agent canonical repository write credentials.
6. Produce and promote at least one Release without another forge in the critical path.
7. Exercise bidirectional GitHub mirroring without creating a second canonical authority.
8. Prove the open-source Rust CLI/library workflow.
9. Export and restore the complete Project history.
10. Elect to retain Anyam as canonical after the trial.

Enterprise and ecosystem work must not delay these two gates unless it is required to preserve a constitutional invariant.
