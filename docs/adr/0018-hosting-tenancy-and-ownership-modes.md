# Hosting, tenancy, and ownership modes

Status: Accepted

## Context

Anyam is completely open source and must remain useful in three deployment
shapes without creating a hosted-only product tier:

1. fully hosted SaaS for the shortest path from idea to a running Project;
2. managed customer-account mode, where Anyam operates collaboration while the
   customer owns Cloudflare resources and production state;
3. Customer-operated Realm, where the customer deploys and controls Anyam in
   its own Cloudflare account without requiring Anyam SaaS.

Issue [#26](https://github.com/Whyme-Labs/anyam/issues/26) asked how those modes
share code, preserve ownership and isolation, manage upgrades, support
application-attached portals and custom domains, and separate the control and
application planes. The owner confirmed the decisions in a one-question-at-a-
time grilling session. This ADR records the shared understanding.

## Decision

### One open product, three hosting modes

All modes run the same open-source Anyam contracts, domain model, policy
engine, Project Export format, and first-party capabilities. Hosting is an
operational topology, not a product capability split.

| Mode | Anyam-operated resources | Customer-owned resources | Primary responsibility |
|---|---|---|---|
| **Hosted SaaS** | control plane, repositories, metadata, execution, optional hosted applications | Project Content, ownership decisions, domain/data policies, exports | Anyam operates infrastructure; customer governs Project and may export it |
| **Managed customer-account** | collaboration/control plane and selected orchestration | Cloudflare account, source repositories, apps, data, secrets, domains, Targets | Anyam operates through explicit revocable grants; customer owns production boundary |
| **Customer-operated Realm** | only what the customer chooses to run/support | Anyam installation, Cloudflare account, source, metadata, apps, data, secrets, domains, Targets | Customer operates and controls the Realm; Anyam SaaS is optional |

The hosted and managed modes may offer support, upgrades, and managed execution,
but they may not withhold capabilities from the open-source Customer-operated
Realm. Commercial services add operations and capacity, not proprietary domain
semantics.

### Realm, Organization, and Project tenancy

The **Realm** is the tenant and security boundary. An Organization groups
principals, teams, and Projects inside one Realm. A Project is the root managed
unit and may contain multiple Source Spaces, repositories, modules, Targets,
and application aliases.

```text
Installation
└── Realm(s)
    └── Organization(s)
        └── Project(s)
            ├── Source Spaces / Repositories
            ├── Changes / Runs / Evidence
            ├── Artifacts / Releases / Targets
            └── application and source aliases
```

Hosted SaaS places many Realms in shared qualified infrastructure with strict
logical isolation. A customer Cloudflare account may host one Anyam
installation and multiple independent Realms. Separate accounts or
installations remain available when a customer needs stronger operational,
residency, or organizational isolation.

An application-specific source portal is a Project view, not an independent
Anyam installation:

```text
source.app.example.com
  → Project view in a Realm
```

It does not duplicate identity, repository, policy, search, or upgrade services.

### Control plane and application plane

The Anyam control plane owns:

```text
Realm identity and policy
Project/Source Space graph
Changes, Runs, Evidence, Releases, Targets
Git Gateway and RepositoryDriver coordination
agent capabilities and MCP
audit, exports, upgrades, and recovery
```

The optional application plane owns customer deployables and runtime state:

```text
Workers/containers or other Target artifacts
domains and routing
application data and bindings
runtime telemetry and health
```

The application plane never receives Realm administration, canonical source
write, agent delegation, or production-approval authority. A deployed version
contains a signed Release/Project lineage manifest; runtime telemetry can be
submitted back as an explicitly disclosed event but cannot rewrite source or
approve its own Promotion.

Hosted SaaS may run preview and production applications in Anyam's Cloudflare
account through a Workers for Platforms adapter. Managed customer-account and
Customer-operated modes run production workloads in the customer's account.
The application can move between modes through Project Export and the same
Release/Target contracts.

### Ownership and use of Project Content

The customer owns Project Content in every mode:

```text
source, metadata, Changes, Runs, Evidence, Artifacts, Releases,
deployment history, logs, model context, policies, and audit data
```

Anyam may operate infrastructure or process data only to provide the selected
mode and explicitly requested integrations. Anyam does not use Project Content
for advertising or model training by default. Realm Telemetry is minimal,
transparent, disableable, and disabled by default for Customer-operated
Realms. Complete export and recovery are product guarantees, not a paid-only
feature.

Support access is disabled by default. A support operator requires a scoped,
expiring, recent-authenticated break-glass grant, a reason, explicit Project
and data disclosure, audit, customer notification where policy permits, and
post-incident review. Break-glass cannot bypass Source Space isolation,
audience checks, immutable history, or credential safety.

### Cross-account authority

Managed customer-account mode uses explicit installation grants or OAuth
authorization to reach selected customer resources. The Anyam service never
stores a permanent broad Cloudflare API token as its customer authority.

The effective permission is resource- and action-scoped:

```text
customer grant
∩ Realm/Project policy
∩ current Task/Target action
∩ device/network/model conditions
− explicit denies
```

The customer can revoke the installation grant, rotate resources, or migrate
to Customer-operated mode. Revocation invalidates derived credentials and
quarantines in-flight protected operations.

### Domain and origin isolation

The default public control-plane topology is:

```text
app.anyam.dev       hosted portal
api.anyam.dev       API
auth.anyam.dev      Realm authorization
git.anyam.dev       Git Gateway
mcp.anyam.dev       remote MCP resources
```

Customer-operated installations may use customer domains. Custom domains are
aliases to a Project or Target; they do not create Realms or installations.

Production applications and source portals remain separate origins. Privileged
cookies are host-only; no broad `.example.com` cookie shares source authority
with an application runtime.

Previews use a separate registrable domain, never `*.anyam.dev`. Preview
origins receive no control-plane cookies, privileged cross-origin access, or
ability to reach the Realm API without a separately authorized capability.
Untrusted customer code therefore cannot inherit the brand domain's session
authority through subdomain placement.

### SaaS isolation tiers

Shared hosted SaaS provides qualified logical Realm isolation. Every token,
queue, cache, object, log, D1 query, Durable Object identity, provider call,
and adapter request carries Realm and resource scope. Shared infrastructure is
not described as physical isolation beyond the qualified Cloudflare boundary.

Sensitive, regulated, or customer-requested deployments may use a dedicated
Cloudflare account and Anyam installation. Dedicated mode changes placement,
operations, and responsibility—not the Project/API/Export contracts.

### Upgrades and supportability

Anyam ships one open-source release train with versioned schemas and migration
contracts:

- Hosted SaaS upgrades after qualification and rollback readiness.
- Managed customer-account installations use customer-approved windows.
- Customer-operated Realms choose automatic, scheduled, or manual upgrades.
- Migrations are forward-compatible, resumable, exportable, and reversible
  where the underlying state permits; irreversible migrations declare that
  condition before activation.
- Upgrade and rollback tools use the same public schemas and Project Export.
- No hosted-only server module or hidden protocol is required for operation.

An upgrade is a Change with Runs, Evidence, a Release, and a guarded Promotion
when it changes Project or Realm state. A failed migration leaves an explicit
blocked/recovery state rather than silently mixing schema versions.

### Mode transitions and exit

Mode changes use the same staged path as migration:

```text
export complete Project
→ verify signatures, objects, policies, and disclosure
→ import into destination Realm/account
→ rebuild and compare projections
→ reconcile providers, Mirrors, and Targets
→ explicit owner activation
```

No mode transition requires a proprietary Anyam account. A hosted customer can
move to managed customer-account or Customer-operated mode; a customer Realm
can use hosted services later without changing object identity or Git history.

## Responsibility matrix

| Responsibility | Hosted SaaS | Managed customer-account | Customer-operated Realm |
|---|---|---|---|
| Anyam control-plane availability | Anyam | Anyam for selected control plane | Customer |
| Cloudflare account and billing | Anyam | Customer | Customer |
| Source repository storage | Anyam, customer export rights | Customer | Customer |
| Application runtime and domains | Anyam or selected customer Target | Customer | Customer |
| Project policy and approvals | Customer/Realm owners | Customer/Realm owners | Customer/Realm owners |
| Secrets and production data | Customer policy; provider-operated storage | Customer | Customer |
| Upgrades | Anyam scheduled | shared approval | Customer-selected |
| Backups/exports | Anyam plus customer export | shared, customer-owned data | Customer |
| Support access | opt-in break-glass | opt-in break-glass | customer support or explicit Anyam grant |
| Specialized execution | Anyam managed or external Runner | customer/Anyam approved Runner | customer/approved Runner |

## Qualification gates

Before claiming a hosting mode is production-ready, qualify:

- cross-Realm storage, token, cache, queue, search, event, and export isolation;
- customer-account grant scope, revocation, rotation, and failed-provider
  recovery;
- hosted application cannot reach control-plane authority or source-write
  credentials;
- preview origin cannot receive or replay control-plane cookies/tokens;
- custom-domain routing cannot cross Project or Realm boundaries;
- shared-to-dedicated and hosted-to-Customer-operated export/restore preserves
  Git object identity, Project, Change, Evidence, Release, audit, and
  disclosure state;
- migrations can resume, report blocked state, and recover from a verified
  export;
- support break-glass is scoped, expiring, visible, and fully audited;
- telemetry and model-processing policies are honored in every mode;
- no hosted-only capability is missing from a clean Customer-operated install.

Each gate produces Evidence bound to exact release, schema, policy, account,
disclosure, and provider versions. A gate becomes stale when those inputs
change.

## Consequences

- The same Anyam product can serve an individual, a team, an agency, and a
  regulated customer without changing the Project model.
- Customer ownership is clear even when Anyam operates infrastructure.
- Hosted SaaS is convenient but not the only path to source recovery or
  production control.
- Shared SaaS needs strong logical isolation and dedicated-account qualification
  rather than an imprecise claim that every tenant has a separate account.
- Separate preview and source origins add a little domain setup but remove a
  much larger cookie and subdomain trust hazard.
- One release train and public migrations keep open-source forks supportable
  without creating a proprietary edition.

## Rejected alternatives

- **One Realm or installation per application:** duplicates auth, policy,
  search, upgrades, and operational state; Project aliases are sufficient.
- **One Realm per Cloudflare account:** blocks agencies and multi-organization
  customers; separate accounts remain available for stronger isolation.
- **Anyam-hosted broad Cloudflare API token:** creates a cross-account blast
  radius and violates the capability model.
- **Application and source portal on one privileged origin:** turns runtime XSS
  or subdomain takeover into a source-control/session boundary failure.
- **Hosted-only enterprise capabilities:** conflicts with Anyam's complete
  open-source product decision and customer-operability requirement.
- **Customer content used as default training/advertising inventory:** violates
  Project Content ownership and trust expectations.
- **Support superuser:** creates an unreviewable standing bypass; support must
  use narrow break-glass authority.

## References

- [Hosting and tenancy issue](https://github.com/Whyme-Labs/anyam/issues/26)
- [Cloudflare-first architecture](0015-cloudflare-first-architecture-and-provider-boundaries.md)
- [Portable Project Exports and mirrors](0017-portable-project-exports-and-single-authority-mirrors.md)
- [Realm authentication and delegation](0007-realm-owned-authentication-and-delegation.md)
- [Explainable capability policy](0008-explainable-capability-policy.md)
- [System threat model](0014-system-threat-model.md)
