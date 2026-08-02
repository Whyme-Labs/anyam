# Explainable capability policy

Status: Accepted

## Context

Anyam has one authorization surface across browser users, CLI clients, Git, local and remote MCP, agents, runners, integrations, and Targets. Roles alone cannot express Source Space disclosure, model-provider restrictions, Secret Use, task budgets, device posture, or separation of duties. A bearer token or upstream identity provider cannot be the policy source of truth.

The owner resolved the policy model through the one-question-at-a-time grilling in ticket [#16](https://github.com/wms2537/anyam/issues/16). The preceding authentication and credential standards are recorded in [ADR-0007](0007-realm-owned-authentication-and-delegation.md).

## Decision

### Effective authority

Anyam calculates authority as a deny-first intersection:

```text
Realm role and relationships
∩ Project and Source Space policy
∩ task Capability Grant
∩ device, network, and model conditions
∩ approval and separation-of-duty state
− explicit denies
```

An authentication result is not an authorization result. A role or relationship establishes an upper bound; a grant can only narrow it. An explicit deny wins.

### Fixed evaluation pipeline

Every decision follows this ordered pipeline:

```text
Authenticate principal
→ resolve Actor, client, Session, and Task
→ resolve Realm, Organization, and Team relationships
→ resolve Project and Source Space policy
→ evaluate device, network, and model conditions
→ intersect the task Capability Grant
→ evaluate approvals and separation of duties
→ apply explicit denies
→ emit allow, deny, or indeterminate with Policy Explanation
```

Policies cannot create arbitrary precedence that makes the order ambiguous. Every decision records the policy version and authorization epoch.

### Unknown and stale context

Unknown or stale required context produces `indeterminate` for high-risk private reads, Secret Use, policy changes, Landing, Promotion, and other operations explicitly classified as protected. Low-risk operations may degrade only when the policy explicitly permits that degradation. Anyam never silently coerces unknown context to allow or deny.

### Policy versions and active work

Policies are immutable versions. A policy edit is a Change with its own author, review, Evidence, approvals, and activation state. Activating a policy increments the relevant authorization epoch. Future operations use the current policy; high-risk operations never rely on grandfathered authority. Completed decisions remain immutable history and are not rewritten. Policy rollback creates a new policy version.

### Roles and relationships

Built-in roles provide understandable defaults, but organization and team membership is additive and resource-specific. Membership does not implicitly propagate across Projects or Source Spaces. Custom roles may add capabilities but cannot bypass Source Space policy, explicit denies, model conditions, approval requirements, or Target rules.

### Capability Grants and consent

A Capability Grant is task-scoped authority with exact resources and effects. It preserves:

```text
principal, actor, client, session, task
Project, Source Spaces, Change, Workspace, Run, or Target
actions, tools, effects, networks, model providers, Secret Use
budgets, expiry, policy version, and parent grant
```

Low-risk grants may be issued by policy. High-risk grants require recent human authentication and explicit consent. Renewal re-evaluates current policy and never silently extends an old grant. Grants can be revoked independently of roles and memberships.

Capabilities are stable semantic verbs such as `source.read`, `workspace.write`, `change.publish_revision`, `run.invoke`, `secret.use`, and `target.promote`; exact resource and effect constraints remain in the grant rather than being encoded into an unbounded OAuth scope vocabulary.

### Delegation

Actors cannot delegate by default. Only an explicitly authorized controller or runner exchange may create a derived grant. A derived grant:

- can only narrow parent authority;
- preserves the originating principal and full actor chain;
- binds to a new exact audience;
- has its own expiry and parent reference;
- cannot approve, Land, Promote, or change policy unless independently authorized;
- cannot renew after parent revocation.

RFC 8693 may carry a qualified exchange, but the Anyam grant remains authoritative.

### Trust zones and Secret Use

Human read, agent read, model processing, Secret Use, and sealed-verifier invocation are separate capabilities. A person may read a private Source Space while an external model is forbidden from processing it. An agent may invoke an approved test service without receiving the secret value. A verifier may return a result projection without disclosing its implementation or inputs.

The secret broker exposes allowlisted operations and service aliases, not raw values. Production secret values are unavailable to coding agents by default. A denied Secret Use operation does not reveal whether the underlying secret exists.

### Approval and separation of duties

A Change author or agent cannot approve its own Change. A verifier cannot approve the Change it verified. Landing and Production Promotion are separate authority classes. Progressive Ceremony permits solo self-approval only for low-risk policy paths. High-risk Changes require an independent approver; sensitive Promotion may require two-person approval.

Approvals bind to the exact Change Revision, Project Revision, Evidence set, Target, and policy version. A new revision, stale Evidence, policy change, or changed Target invalidates affected approvals.

Required approvals and explicit denies are monotonic blockers. An approval cannot override a deny unless the denying policy is changed by an authorized policy Change.

### Revocation and caching

Revocation increments the relevant authorization epoch for principals, devices, clients, memberships, Source Spaces, tasks, grants, runners, and installations. High-risk operations check the live grant and epoch. Derived credentials cannot renew after parent revocation; active Workspace credentials are revoked or quarantined; runners are cancelled where their adapter supports it.

Low-risk decisions may be cached only with a key containing Realm, principal, actor, client, task, resource, operation, policy version, and authorization epoch. A cache is never authoritative and never extends expiry.

### Disclosure-safe decisions

Every visible authorization result is a structured Policy Explanation containing:

```text
decision: allow | deny | indeterminate
decision identifier
visible operation and resource reference
policy version and authorization epoch
satisfied capabilities
missing capability categories
blocking approval or condition
safe remediation
re-evaluation or expiry condition
```

For resources the Actor cannot discover, Anyam returns a safe `not_found` projection and does not reveal names, identifiers, paths, timing, membership, verifier existence, or hidden policy. Humans and agents receive the same semantic facts in different presentations.

### Public and cross-Realm access

Public Source Space browsing and clone/fetch may use an anonymous public principal, but only through the safe public Project View. Mutations, expensive Runs, private collaboration, and agent access require authentication.

Realms are independent. An identity has no authority in another Realm by default. Cross-Realm contribution or integration requires an explicit, resource-scoped federation or installed-app grant, and the receiving Realm remains authoritative for local policy and revocation.

### Break-glass access

Break-glass may bypass only explicitly listed operational gates. It may never bypass Source Space isolation, audience checks, immutable history, audit recording, or credential safety. It requires a separately authenticated emergency identity, narrow scope, reason, automatic expiry, alerting, and post-incident review. Where available, sensitive use requires a second approver. Break-glass never becomes a standing role or reusable token.

### Audit

The Audit Ledger is append-only and capability-scoped. An Audit Event records Realm, principal, actor, client, session, task, grant, policy version, resource, decision, and result. It excludes credential values, refresh tokens, private model reasoning, and inaccessible Project Content. Audit views and exports use Disclosure Projections; corrections are new events, not edits.

## Consequences

- Authorization is explainable, reproducible, and consistent across all Anyam clients.
- The product must expose machine-readable Policy Explanations rather than only HTTP status codes or disabled UI controls.
- The Realm needs online grant and epoch authority for protected operations; cached ACLs and embedded token claims cannot be the source of truth.
- Agents receive precise, task-scoped capabilities without receiving a developer’s broad role or a canonical repository credential.
- The policy engine has more moving parts than simple RBAC, but each part has one job and produces a visible receipt.
- Public, private, customer, model, verifier, and Target boundaries remain independently enforceable.

## Rejected alternatives

- **Last matching policy wins:** makes rule order an implicit privilege and produces unexplained behavior.
- **Unknown means allow:** turns stale posture, outages, and missing approvals into privilege escalation.
- **Unknown means permanent deny:** unnecessarily blocks explicitly safe public or low-risk degraded operations.
- **Grandfather active tasks:** allows obsolete policy or revoked authority to continue performing protected work.
- **One global role per user:** cannot model Source Spaces, agents, model providers, Secret Use, or Target separation.
- **One `source.read` capability:** conflates human inspection, agent transfer, model processing, and verifier access.
- **Agent-controlled delegation:** permits unbounded impersonation and authority widening.
- **Break-glass superuser:** creates a hidden bypass around the very controls the emergency path is meant to protect.
- **Unscoped authorization cache:** creates stale privilege after policy, membership, grant, or device changes.
- **Audit as a mutable activity feed:** loses the provenance required to investigate authorization decisions.
