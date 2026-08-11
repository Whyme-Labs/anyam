# Bootstrap, onboarding, import, and recovery

Status: Accepted

## Context

Anyam must make the first path easy without hiding irreversible or
authority-bearing steps. A new user may start in Hosted SaaS, connect an
existing Cloudflare account for Managed Customer-Account mode, install Anyam
in a customer account, or import an existing GitHub/GitLab/generic-Git
repository. The same Project should then reach an agent workspace, preview,
Release, and first Promotion with recoverable failures.

Issue [#27](https://github.com/Whyme-Labs/anyam/issues/27) asked for the safe
bootstrap state machine, local CLI setup, Realm owner recovery, provider
imports, Source Space decomposition, agent connection, first preview,
Promotion, and damaging recovery cases. The logic prototype is preserved on
[`codex/prototype-bootstrap-onboarding`](https://github.com/Whyme-Labs/anyam/tree/codex/prototype-bootstrap-onboarding)
at commit [`18387d5`](https://github.com/Whyme-Labs/anyam/commit/18387d5).

## Decision

### One progressive onboarding state machine

The first-run state is explicit and resumable:

```text
new
→ mode-selected
→ account-ready
→ realm-ready
→ owner-ready
→ project-ready
→ importing
→ imported
→ agent-ready
→ preview-ready
→ promoting
→ active
```

Any state can become `blocked` with an operation, reason, checkpoint, partial
effects, remediation, and Audit Event. Recovery resumes from a verified
checkpoint or returns to a safe previous phase; it never silently repeats
non-idempotent side effects or activates a partial Project.

The prototype demonstrated the two most damaging early cases:

1. Git history transfer fails after a repository and preflight record exist.
   Recovery preserves the quarantine and resumes the import; it does not
   create a second repository or mark the Project imported.
2. Target health verification fails after a Release is verified and a deploy
   request is made. Recovery leaves the Release available, does not claim
   production changed, and retries the guarded Promotion without rebuilding
   source.

### Hosting-mode entry paths

#### Hosted SaaS

```text
open Anyam portal
→ authenticate with passkey/OIDC
→ create Realm and enroll owner recovery
→ create/import Project
→ choose Project Profile and Source Spaces
→ connect local/remote agent
→ preview → verify → Promote
```

Anyam creates the hosted Realm and selected control/application resources. The
customer remains the Project owner and can export or move the Project at any
point.

#### Managed Customer-Account

```text
open Anyam portal
→ authenticate to Anyam Realm
→ connect customer Cloudflare account through explicit OAuth/grant
→ review requested resources, bindings, and ownership
→ provision only approved resources
→ create/import Project
→ preview → verify → Promote in customer Targets
```

The installation grant is short-lived/revocable and resource-scoped. A failed
account grant or partial provisioning produces a blocked installation record;
it does not leave an untracked broad API credential.

#### Customer-operated Realm

```text
deploy open-source Anyam installer in customer Cloudflare account
→ verify account control and required bindings
→ create first Realm Owner with passkey and recovery method
→ record recovery material outside the deployment
→ create/import Project
→ optionally connect Anyam-hosted support or external identity
```

There is no default admin password and no required Anyam global account. The
installer credential provisions infrastructure; it is not a permanent Git,
Realm, or Project credential.

### First-owner bootstrap and recovery

The first owner flow creates:

```text
Realm owner principal
passkey/WebAuthn credential
recovery method or codes
device/session record
owner audit event
authorization epoch
```

The owner must complete recovery enrollment before protected Project creation,
Source Space visibility changes, policy changes, export of restricted data, or
Target Promotion. Recovery uses a separately authenticated path, creates an
Audit Event, rotates or invalidates affected sessions/grants, and requires
post-recovery review. It cannot bypass Source Space isolation or immutable
history.

### Project creation

`anyam project create` and the web flow ask for only the information needed to
create a Project identity, owner, visibility intent, and optional description.
Anyam then proposes a Project Manifest, default Source Space, conventions,
Actions, Verifiers, and Targets from disclosed source/configuration. Detection
is a proposal; the owner confirms or edits it.

The Project is not considered ready for import or agent work until:

- the Realm and owner authority are valid;
- the Project identity and default Source Space are durable;
- the Project Profile/View is explicit enough to disclose safely;
- a recovery/export path exists;
- no production Target or secret has been implicitly created.

### Import providers and source decomposition

All imports use `RepositoryDriver` and the staged Project Export/import
contract:

```text
choose GitHub/GitLab/generic Git
→ authenticate provider with narrow import grant
→ preflight refs, object format, LFS/large objects, licenses, secrets,
   disclosure, and provider capabilities
→ choose or confirm Source Spaces and public/private Profiles
→ quarantine repositories and transfer exact history
→ verify object/digest/identity integrity
→ create Project Revision and public projections
→ optionally import supported metadata as local Intents/Changes
→ explicit owner activation
```

Source Space decomposition is owner-declared. Anyam may suggest public,
commercial, internal, or restricted boundaries from paths and metadata, but it
does not claim that a Project Profile is functionally complete or that every
public profile builds. The invariant is disclosure integrity: inaccessible
objects and metadata are not reachable or discoverable through the public
View.

The import preflight reports warnings and blockers with named remediation:

```text
object format not supported by selected driver
LFS object missing or unverifiable
private history selected for public Projection
credential/secret detected in selected lineage
license ownership requires human decision
provider metadata cannot be imported and will remain external
```

A warning does not silently become an allow; a blocker does not silently
discard data. Supported issue/review metadata becomes local Intent/Change
history; unsupported provider metadata is preserved as external extension data
or listed as a migration gap.

### CLI and local agent setup

The canonical developer path is:

```text
anyam auth login <Realm>
anyam project clone <Project>
anyam agent setup codex|claude|cursor
anyam change start <description>
```

The CLI stores refresh authority in the OS keychain and obtains short-lived
Git Workspace credentials. `anyam agent setup` writes no secrets to the
repository, agent instructions, MCP configuration, or shell history. The local
stdio broker supplies task-scoped MCP authority outside model context. Remote
MCP uses the project-scoped HTTP authorization profile.

Agent setup is optional. An ordinary Git client can work after import through
the Anyam Git Gateway; an agent can be attached later or replaced without
changing the Project or Workspace identity.

### First preview and Promotion

The first candidate path is:

```text
Change/Workspace
→ publish exact source revision
→ run detected/confirmed Actions and Verifiers
→ create Candidate Output
→ build immutable Artifact and Evidence
→ create Release
→ issue isolated preview Target
→ health-check preview
→ request Promotion to selected Target
→ verify Target health
→ mark Release/Target active
```

The UI and CLI distinguish `source landed`, `Release verified`, `Promotion
executing`, `Target healthy`, and `Target unchanged`. A failed health check
leaves an explicit failed/unknown Promotion and a still-available verified
Release; rollback is a new guarded Promotion, not a history rewrite.

### Idempotency and recovery rules

Every bootstrap/import/provision/Promotion operation has a stable operation ID,
idempotency key, expected prior state, checkpoint, and owner-visible audit.

- Retrying the same operation with the same input returns the prior result or
  the same blocked state.
- Reusing an idempotency key for different source, account, or Project input is
  an explicit conflict.
- A partial repository, object copy, account binding, or Target request is
  retained in quarantine or marked unknown; it is never silently treated as
  complete.
- Recovery verifies provider state and digests before advancing the state
  machine.
- Revoked account grants, expired credentials, or changed policy force a fresh
  authorization step rather than an automatic continuation.
- A failed migration leaves the prior activated version or an explicit blocked
  state where rollback is not safe.

### Mode migration and handoff

Moving a Project between Hosted SaaS, Managed Customer-Account, and
Customer-operated Realm uses Project Export:

```text
request export with disclosure policy
→ verify repository/metadata/object digests and signatures
→ import into destination Realm/account quarantine
→ rebuild Read Models and public projections
→ reconcile Mirrors and Targets as proposed state
→ owner compares state and activates destination
→ revoke old grants/credentials after confirmation
```

The old mode remains available until the owner confirms activation or chooses
an explicit cutover. A failed import does not delete the source Project.

### Qualification gates

Before describing onboarding as production-ready, qualify:

- hosted, managed, and customer-operated happy paths from a clean state;
- first-owner recovery, lost device/session revocation, and no-default-admin
  installation;
- account OAuth/grant denial, revocation, partial provisioning, and retry;
- GitHub, GitLab, and generic-Git object, LFS, signature, and metadata import;
- public/private Source Space decomposition and hidden-object negative tests;
- import interruption after repository creation, object transfer, metadata
  import, and projection creation;
- repeated operation/idempotency and stale checkpoint recovery;
- CLI Git credential helper and Codex/Claude/Cursor local broker setup;
- first preview, failed health check, retry, rollback, and unchanged Target;
- hosted-to-customer mode export/import and old-mode retention/cutover;
- migration failure, restore from Project Export, and audit/provenance
  comparison.

Each gate produces Evidence tied to the exact installer, provider driver,
schema, policy, account, disclosure, and target. A passed gate becomes stale
when a material input changes.

## Consequences

- First-run UX stays progressive: a solo developer can move through the same
  states with fewer policy gates, while teams and high-risk Projects add
  approvals without a separate product.
- Import is safer than a one-click repository copy because it makes public/
  private boundaries, missing objects, and provider gaps visible before
  activation.
- Partial failures are longer to model than a boolean “installed” flag, but
  they preserve ownership and make recovery inspectable.
- The CLI and web portal can share one state machine and one operation history;
  agents consume the same semantic state rather than scraping onboarding UI.
- Project mode transitions remain possible without making a hosted Anyam
  account the permanent root of trust.

## Rejected alternatives

- **One-click import that immediately activates production:** makes unreviewed
  source, secrets, dependencies, and Target effects authoritative.
- **Import the entire repository as one public/private boundary:** cannot
  support hybrid Source Spaces without disclosure leakage.
- **Treat path heuristics as functional build guarantees:** owners decide
  Profiles; Anyam enforces disclosure integrity, not universal “works” claims.
- **Partial failure as success with a warning:** creates a landmine; blocked
  state, checkpoint, effects, and remediation must be explicit.
- **Provision with a permanent Cloudflare API token:** creates broad account
  blast radius and violates the grant model.
- **Force an agent during project creation:** ordinary Git and human workflows
  remain valid; agent connection is a separate reversible step.
- **Promote directly from a moving branch:** Releases and Evidence bind exact
  source and Target state; Promotion never rebuilds unbound source.

## References

- [Bootstrap prototype](https://github.com/Whyme-Labs/anyam/tree/codex/prototype-bootstrap-onboarding)
- [Hosting, tenancy, and ownership](0018-hosting-tenancy-and-ownership-modes.md)
- [Portable Project Exports](0017-portable-project-exports-and-single-authority-mirrors.md)
- [CLI, Git, MCP, and agent connection](0009-cli-git-mcp-agent-connection.md)
- [Evidence validity and provenance](0013-evidence-validity-policy-and-provenance.md)
- [System threat model](0014-system-threat-model.md)
