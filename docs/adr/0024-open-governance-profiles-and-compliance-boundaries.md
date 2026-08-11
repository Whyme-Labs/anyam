# Open Governance Profiles and compliance boundaries

Status: Accepted

## Context

Anyam's primary users are technical developers and teams, but the same
Project/Change/Evidence model must eventually support organizations with
strong identity, audit, residency, encryption, separation-of-duty, retention,
support, and compliance requirements. Those requirements must not create a
proprietary enterprise edition or turn an unverified provider guarantee into a
legal promise.

Issue [#32](https://github.com/Whyme-Labs/anyam/issues/32) asked which enterprise
controls belong in the kernel, which are adapters, how they should be
administered, and how to sequence them without promising certifications before
their prerequisites are known.

## Decision

Enterprise governance is represented by a versioned, portable **Governance
Profile** applied to the same open-source Realm, Organization, Project, Source
Space, Change, Evidence, Release, Target, and Capability contracts.

There is no proprietary enterprise edition and no hosted-only first-party
governance capability. Managed services may operate capacity or support, but
the server, CLI, schemas, policy evaluation, exports, and first-party adapters
remain open source and capability-complete.

### Governance Profile

A Governance Profile declares requirements and Evidence for:

```text
identity and session strength
roles, relationships, and custom capabilities
device/network conditions
Source Space and Project disclosure
policy versioning and separation of duties
audit and retention classes
residency/data-class placement
encryption and key references
runner/integration identity
support and incident ownership
RPO/RTO and recovery drills
dedicated/shared isolation
compliance control mappings
```

Profiles are Changes with review, Evidence, activation, version history, and
rollback as a new Profile Change. A profile does not grant access; it tightens
the policy and qualification obligations applied to an operation. Profile
activation increments the relevant authorization/policy epoch and invalidates
stale high-risk approvals and Evidence.

### Identity and session controls

Every Realm supports passkeys/WebAuthn and authorization-code OIDC/OAuth as the
baseline. The local Realm remains the authority that maps `issuer + subject` to
a Principal and applies memberships, Source Space policy, Capability Grants,
and explicit denies.

Enterprise adapters may add:

- SAML SSO;
- SCIM lifecycle provisioning and deprovisioning;
- enterprise-managed identities;
- device posture, network/location, and managed-device conditions;
- hardware-backed or recent-authentication requirements; and
- administrator-approved first-party or enterprise App clients.

No customer requires an Anyam global identity. Upstream identity tokens
establish identity; the Realm issues its own audience-bound resource
credentials. Broad PATs, static service tokens, and shared administrator
credentials are prohibited by default for enterprise automation.

### Audit, retention, and legal hold

Immutable attributable Audit Events, complete Project Export, policy history,
and Evidence/Release provenance exist in every Hosting Mode. A Governance
Profile can add:

- retention classes for operational telemetry, domain events, Evidence,
  releases, security audit, and legal hold;
- independent audit/export destinations;
- restricted-writer and reader separation;
- bucket/object retention controls where the provider qualifies them;
- export verification and restore attestations; and
- deletion approval and break-glass review.

Anyam does not choose one universal retention period. Retention is a Realm or
Project policy with a legal/operational owner, data classification, storage
receipt, and export/recovery behavior. Provider log retention is not the
Anyam audit ledger and does not satisfy a customer policy by itself.

Governance state itself—Profiles, policy versions, retention rules, residency
declarations, audit configuration, control mappings, and compliance Evidence—
is part of the signed Realm/Project Export. No hosted installation may keep the
only copy of the rules that governed a customer's history.

### Residency and data sovereignty

Residency is a data-class policy, not a domain or deployment label. A profile
must inventory and classify at least:

```text
source objects and refs
Project Views and indexes
grants, sessions, and audit
logs, queues, and Workflow state
Evidence, Artifacts, Releases, and backups
mirrors and provider telemetry
Runner inputs/outputs and caches
model context and external provider calls
```

The selected Cloudflare account, region/jurisdiction, RepositoryDriver,
Runner, mirror, Target, and model provider must each prove the requested
placement or be rejected/downgraded before data dispatch. A customer-operated
Realm may enforce account-level placement and deny unsupported paths. Anyam
must refuse a residency guarantee when the provider path cannot prove it.

“Runs on Cloudflare” is not a residency attestation. External Runners,
mirrors, logs, caches, and model calls are separate disclosure and placement
decisions.

### Encryption and keys

Provider-managed encryption is the open baseline. Enterprise adapters may add:

- customer-managed encryption keys;
- customer-controlled key rotation and revocation;
- HSM/KMS-backed signing or encryption;
- key version references in Evidence/Release manifests; and
- key-access audit and recovery procedures.

Anyam stores key identifiers, versions, provider, purpose, and policy metadata,
never raw key material. A provider that cannot prove the required key control
is not a valid path for that Governance Profile. Key rotation is a Change with
re-encryption/recovery Evidence; a key reference in a manifest never implies
that the key value is exportable.

### Policy administration and separation of duties

Governance Profiles require versioned policy-as-code evaluated by the existing
deny-first capability pipeline. High-risk decisions bind to exact Project
Revision, Change Revision, Evidence Key, Target, policy version, and
authorization epoch.

The default separation is:

```text
author/agent  ≠  verifier  ≠  approver  ≠  Landing authority  ≠  Promoter
```

An actor cannot approve its own high-risk Change or Evidence. A verifier cannot
approve its own result. Landing and Target Promotion remain distinct. A solo
Realm can use self-approval only where a risk policy explicitly allows it;
high-risk Profiles require an independent or two-person decision.

Break-glass access is a separate authenticated path with narrow resources,
explicit duration, reason, alerts, immutable Audit Events, and post-incident
review. It cannot bypass Source Space isolation, audience boundaries,
immutable history, credential safety, or required Evidence.

### Enterprise automation identity

Integrations, Runners, scanners, deployment controllers, and support tools use
installed-App or workload identities:

```text
App/workload enrollment
  → administrator resource/action grant
  → asymmetric identity proof
  → short-lived installation/job credential
  → signed Evidence and audit
```

The grant names Projects, Source Spaces, Actions, Targets, effects, and
disclosure. A Runner or integration never receives a shared administrator
credential or unrestricted PAT. Provider-specific identity such as SPIFFE,
OIDC, mTLS, or Cloudflare Access is an adapter; Realm policy and Anyam
Capability Grants remain authoritative.

### Support and incident ownership

Support responsibility follows Hosting Mode:

- Customer-operated teams own first response and account operations; Anyam may
  provide optional support, upgrades, and recovery services.
- Managed Customer-Account contracts state which Anyam operations are covered
  and which remain customer-owned.
- Hosted SaaS may offer Anyam-operated support tiers and incident communication.

Anyam does not promise response-time or recovery-time commitments until incident
volume, staffing, provider dependencies, and restore receipts support them.
The support contract names escalation, data access, diagnostic redaction,
provider coordination, and customer/Anyam responsibility.

### Compliance boundaries

Before any certification or regulatory guarantee, Anyam must have:

```text
control inventory and owner
system/data-flow boundary
shared-responsibility matrix
policy and audit evidence
retention/residency/key evidence
access-review and incident runbooks
restore/recovery drills
independent readiness assessment
```

The product may ship control mappings, evidence exports, responsibility
matrices, policy explanations, and audit-ready runbooks now. It must not claim
SOC 2, ISO, sector certification, residency compliance, or legal sufficiency
until the corresponding independent prerequisites and customer deployment
boundaries are qualified.

### Isolation profiles

A Governance Profile can require:

- a dedicated Cloudflare account;
- a dedicated Anyam installation or Realm;
- dedicated RepositoryDriver/object storage;
- dedicated Runner trust domain;
- dedicated observability/export destination; or
- a customer-controlled model/provider boundary.

Shared installations remain valid for lower-risk profiles. The kernel still
enforces logical cross-tenant isolation in every topology. Dedicated placement
is a declared control with its own cost, recovery, residency, and migration
Evidence—not an implicit guarantee.

## Roadmap

### K0 and private alpha

- Passkeys/OIDC, Realm-owned grants and policy epochs.
- Immutable Audit Events and complete Project Export.
- Baseline policy-as-code, separation-of-duty verbs, Secret Use, and break-
  glass shape.
- Data-class inventory and provider capability reporting.
- Customer-operated diagnostics, retention configuration, and recovery
  checkpoints.

### Public beta

- Multiple Realms and team governance.
- SAML/SCIM and approved enterprise client adapters where qualified.
- Exportable Governance Profiles, audit/reconciliation reports, retention
  classes, residency declarations, and integration/workload identities.
- Customer-visible responsibility and billing-owner surfaces.

### Enterprise/ecosystem expansion

- Customer-managed keys, dedicated isolation, advanced device/network policy,
  legal hold, residency administration, compliance dashboards, formal support
  commitments, and independent certification readiness.
- These remain open adapters and services; none removes the Project, Change,
  Evidence, Capability, Release, Target, or export semantics.

## Consequences

This design gives technical teams a simple open-source baseline and gives
regulated organizations a path to stronger controls without forking Anyam or
making unverified guarantees. Governance is inspectable, portable, and tied to
the same exact state and Evidence that governs ordinary delivery.

The cost is that compliance becomes a real system boundary: data inventory,
retention, key, support, and recovery Evidence must be maintained per Hosting
Mode and customer deployment. That is preferable to a checkbox enterprise
label whose underlying provider and operational assumptions cannot be proven.
