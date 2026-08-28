# Application assurance execution plan

Status: review draft

Owner direction recorded: 28 August 2026

This document turns the product direction "strong production discipline should
be cheap enough for every project" into an implementation sequence for Anyam.
It does not replace the [platform blueprint](./anyam-platform-blueprint.md),
the [product constitution](../product/constitution.md), `CONTEXT.md`, or the
ADRs. Those documents remain authoritative for vocabulary and accepted
architecture. GitHub issue [#182](https://github.com/Whyme-Labs/anyam/issues/182)
remains the current Wayfinder map, and issue
[#286](https://github.com/Whyme-Labs/anyam/issues/286) remains the real-team
qualification gate.

The issue tracker is the live status source. Issue references in this document
name the current frontier at the time of writing and may later be closed or
superseded.

## Decision

Anyam remains an open-source, Git-compatible Project SCM for humans and agents.
It should grow into the source, Release, and Promotion authority that makes the
safe path to production the shortest path.

The product rule is:

> Bank-grade technical primitives by default. Human ceremony stays
> proportional to the actual risk and team structure.

"Bank-grade" is a direction for engineering guarantees, not a certification or
regulatory claim. Every guarantee still needs a contract, a measured receipt,
a failure mode, and a recovery path.

Anyam should provide the machinery for:

- immutable and attributable Changes;
- verified Artifacts and Releases;
- least-authority human, agent, Runner, and provider access;
- staged, health-verified Promotion;
- backward-compatible data migrations;
- tested recovery rather than untested backups;
- production access without reusable raw credentials;
- drift detection and reconciliation;
- Evidence-backed readiness claims.

Anyam must not become a runtime dependency for the deployed application. A
Mailda Node, Lajur deployment, or company ledger must keep serving permitted
requests if the Anyam Realm is unavailable. Anyam governs how software reaches
and changes a Target. It does not sit in every application request path.

## Product outcome

The intended adoption experience is one command followed by an explicit review
of what Anyam discovered:

```sh
pnpm dlx create-anyam adopt
```

For supported Cloudflare Workers applications, the command should inspect the
project, propose the Project manifest, identify missing controls, and explain
which claims remain unproved. The first run is read-only. It must not deploy,
create cloud resources, change DNS, apply migrations, or copy credentials.

A supported application may add a small runtime adapter:

```ts
import { anyam } from "@anyam/runtime-cloudflare";
import worker from "./worker";

export default anyam(worker);
```

That wrapper is not the guarantee. It supplies release identity, health,
redaction, and Evidence hooks. The guarantee comes from protected transitions
remaining inside the existing Anyam lifecycle:

```text
Intent
  -> Workspace
  -> Change and immutable Change Revisions
  -> Runs and Evidence
  -> Landing
  -> immutable Release
  -> Target proposal
  -> policy decision
  -> Promotion
  -> health verification
  -> current, stopped, rolled back, or reconciled state
```

A provider account owner can still change infrastructure outside Anyam. No
software control plane can remove the cloud owner's ultimate authority. Anyam
must instead make its normal path exclusive, make bypass unnecessary, and
report out-of-band changes as Target drift.

## What already exists and what is still missing

| Area | Current foundation | Missing proof or capability |
| --- | --- | --- |
| Authority | Realm, Organization, Project, Source Space, Project View, Capability Grant, audit | Real sustained operation, key rotation, complete signed readiness claim, independent review |
| Source and work | Git compatibility, Workspace, Intent, Change, Change Revision, review, Landing | Named real-team adoption and remaining provider boundary qualification |
| Verification | Action, Run, Verifier, Evidence, validity and provenance concepts | A common application health and runtime Evidence protocol |
| Delivery | Artifact, Release, Target, Promotion, promotion executor, health and rollback concepts | General application adoption, progressive delivery qualification, drift observation, unknown-result reconciliation |
| Manifest | `anyam.project/v1` with Source Spaces, mounts, Actions, outputs, Verifiers, resources, and deployment Targets | Deterministic import of an existing application and richer application-impact contracts |
| Data change | Migration planning and rollback distinctions exist in the design | D1-first implementation, compatibility rehearsal, backfill and contraction gates tied to Release and Promotion |
| Recovery | Project Export and bounded recovery paths exist | Clean-infrastructure restore of both the Realm and adopted applications, with measured application invariants |
| Production access | Capability Grants and task-scoped agent authority exist | A brokered data and diagnostic access path that does not expose broad provider or database credentials |
| Readiness | Stage Gates and Evidence exist | A generated readiness projection that cannot be greener than its current Evidence |

The immediate problem is not missing product vocabulary. The repository already
has most of the correct nouns. The work is to finish the current credibility
gate, extend the existing objects, and prove the system against real
applications.

## Non-negotiable architecture choices

### Reuse the existing domain model

Do not create a second `ChangeSet` beside `Change`. Code, schema,
infrastructure, permissions, configuration, and recovery impact belong to the
Change Revision and its Runs, Evidence, Release, Target, and Promotion.

Do not create a separate assurance authority beside the Realm. Application
controls extend the existing Policy Profile, Capability Grant, Evidence, and
Stage Gate machinery.

Do not create a second deployment manifest. Evolve `anyam.project/v1` through a
versioned, backward-compatible manifest change with an ADR and migration path.

### Keep protected transitions in Anyam

A provider adapter may inspect state, execute a requested operation, and return
a result. It cannot decide that a Release is valid, approve its own Evidence,
or make a Promotion canonical.

A Runner may build and test an Artifact. It cannot seal the Release or receive
ambient production authority.

An agent may propose a Change and produce bounded Evidence. It cannot approve
its own protected effect or mint broader authority for itself.

### Separate control plane from runtime

The Anyam Realm owns identity, policy, Evidence, Release lineage, Target state,
and Promotion authority.

The application runtime owns application requests, business authorization, and
business data. The runtime adapter must not call a hosted Anyam service before
serving ordinary requests.

The production access broker is an operational path, not a mandatory proxy in
front of the application.

### Remain Cloudflare-first, not Cloudflare-hostage

Implement the first complete application-assurance path for Cloudflare Workers,
D1, Durable Objects, R2, Queues, Workflows, KV, and Service Bindings. Preserve
provider contracts and export boundaries. Do not delay a working Cloudflare
path to invent a lowest-common-denominator multi-cloud API.

A second provider adapter comes only after the Cloudflare path has passed its
own Stage Gate and another real workload proves that the abstraction is not
Cloudflare-specific by accident.

### Fail closed where the risk is high

For a Protected Policy Profile, unknown migration compatibility, missing
recovery Evidence, stale health Evidence, an ambiguous provider result, or
unreconciled Target drift blocks Promotion.

For a Solo Policy Profile, the human owner may make a recorded override where
one-person operation makes human separation of duties impossible. An agent or
Runner never receives that override. The receipt must state what was bypassed,
why, who accepted the risk, and how to recover.

## How existing objects should grow

| Existing object | Application-assurance responsibility |
| --- | --- |
| Project Revision | Exact application manifest, resource graph, Actions, Verifiers, and declared deployment assumptions |
| Change Revision | Typed impact over source, dependencies, schema, infrastructure, configuration, permissions, secrets, data classes, and recovery |
| Run | Deterministic execution over exact inputs in a named environment and Runner boundary |
| Evidence | Test, security, migration, health, recovery, drift, review, and external attestation results with validity keys |
| Artifact | Immutable build output, manifest, SBOM, provenance, migration artifact, report, or recovery bundle |
| Release | Project Revision, Artifact digests, configuration digests, schema compatibility range, required Evidence, policy version, and provenance |
| Target | Exact provider account, environment, accepted Artifact types, resource identities, data class, health contract, recovery contract, and observed state |
| Promotion | Idempotent staged transition, approvals, traffic movement, health evaluation, stop conditions, rollback or compensation, and reconciliation |
| Policy Profile | Required controls, review routes, Evidence, recovery age, migration rules, access rules, and owner-override policy |
| Capability Grant | Narrow human, agent, Runner, provider, and operational authority with resource, action, audience, and lifetime bounds |
| Audit Event | Immutable fact for every protected decision, provider operation, override, unknown result, drift finding, and recovery action |

The exact schema change requires an ADR. The requirements are more important
than the JSON shape:

- every resource has a stable local identity and provider adapter type;
- provider IDs remain adapter data rather than Project identity;
- environments and Targets are explicit;
- sensitive resources declare a data class;
- Actions declare inputs, outputs, network policy, Runner requirements, and
  budgets;
- Verifiers declare what assertion they make and when it becomes stale;
- Releases declare schema and runtime compatibility;
- Targets declare health and recovery contracts;
- Policy Profiles declare which Evidence is mandatory;
- unsupported or indeterminate states remain visible.

## Work package 0: finish the credible-team floor

Do this before Anyam accepts production authority for another application.
Bounded design and dogfood work may proceed in parallel, but no production-ready
or general-availability claim may depend on it.

### Close the current security and provider frontier

Follow issue #182 and close the remaining open findings, including the current
work around:

- live GitHub App signed mirror production and webhook ingress;
- complete signature binding for the real-team readiness bundle;
- one shared credential-material scanner across provider boundaries;
- Workspace mount bijection and path safety;
- Mirror handoff audience, Realm, installation, issuer, lifetime, rotation, and
  replay binding;
- supported owner OAuth credentials for live qualification.

The implementation must keep malformed, stale, cross-Realm, cross-installation,
credential-bearing, replayed, or ambiguous inputs outside Authority state.

### Run the real-team gate

Run issue #286 with a named 3 to 10 person cohort for 30 calendar days and at
least 25 terminal Changes. Use Anyam itself and Mailda as the first two genuine
coding-agent products. Add Lajur if its current pilot work benefits from the
trial, but do not simulate a product merely to satisfy the count.

The trial must include:

- ordinary Git work;
- concurrent human and agent Workspaces;
- Intent and pull-request-compatible lifecycles;
- review, conflict, rebase, Landing, Release, Target, and rollback;
- a customer-operated Cloudflare Realm;
- bidirectional GitHub projection without making GitHub canonical;
- complete export and restore;
- sustained load and contention;
- Queue recovery and duplicate delivery;
- authentication throttling and key rotation;
- incident alerting;
- independently reviewed security Evidence;
- an explicit team retention decision.

Local fixtures remain useful, but they do not satisfy this gate.

### Exit condition

Anyam is credible for a real small team only when the current conjunctive gate
passes. Missing, stale, failed, or indeterminate Evidence keeps it non-ready.

## Work package 1: adopt an existing application

Extend `packages/create-anyam` with an `adopt` flow.

### Required behavior

The first pass is deterministic and read-only. It should inspect:

- package manager and lockfiles;
- workspace and monorepo layout;
- Worker and Hono entrypoints;
- `wrangler.toml` and `wrangler.jsonc`;
- D1 bindings and migration directories;
- Durable Object classes and migration declarations;
- R2, KV, Queue, Workflow, Service Binding, Hyperdrive, and secret bindings;
- build, test, type-check, lint, browser-test, and deployment scripts;
- CI workflows and external Runner assumptions;
- current staging and production environments;
- health, doctor, backup, and recovery commands;
- existing direct-deployment paths;
- files likely to contain credentials, without reading or printing secret
  values.

The output is:

1. a proposed versioned Project manifest;
2. a deterministic inventory receipt;
3. a gap report;
4. a list of unsupported or ambiguous states;
5. an explicit mutation plan for later approval.

An LLM may explain the report or propose a fix. It is not the source of truth
for inventory, authority, or provider state.

### Acceptance

- Running the scan twice on the same Project Revision produces the same result.
- The scan does not mutate local files unless the owner accepts the patch.
- The scan does not call a provider unless the owner requests live inventory.
- A live inventory call uses a narrowly scoped Capability Grant and records the
  provider receipt separately.
- No secret value appears in terminal output, Evidence, logs, exports, or agent
  context.
- Mailda produces a useful manifest and gap report without an application
  rewrite.
- A simple Worker fixture and a monorepo fixture qualify separately, so Mailda
  is not the only shape the scanner understands.

## Work package 2: add the application runtime protocol

Create a small Cloudflare runtime adapter. Keep it optional and local to the
customer-operated application.

### Runtime responsibilities

- expose immutable Release and Target identity;
- attach request and trace correlation identifiers;
- carry actor and delegator attribution where the application already has it;
- expose machine-readable liveness, readiness, and version endpoints;
- emit structured health and invariant observations;
- redact declared sensitive fields;
- provide bounded idempotency helpers;
- state which schema versions the runtime can read and write;
- produce Evidence payloads without provider or customer credentials;
- continue operating when the Anyam Realm is unreachable.

### Runtime non-responsibilities

The adapter does not replace application authentication, business
authorization, tenant isolation, business invariants, or the application's own
command model. It must not turn Anyam into a central authorization service for
every request.

### Acceptance

- Removing network access to the Anyam Realm does not stop ordinary application
  traffic.
- Health output identifies the exact Release without revealing secrets.
- Old and new runtime versions can coexist during a declared compatibility
  window.
- The adapter cannot silently mark a business invariant as passed. The
  application supplies the invariant observation and Anyam verifies its
  contract and provenance.
- The same Evidence protocol works through CLI, REST, MCP, and the control room.

## Work package 3: qualify immutable Releases and provenance

Extend the existing Artifact and Release path rather than creating a second
release service.

A Protected Release should contain or bind:

- exact Project Revision and Change Revision lineage;
- immutable application Artifact digests;
- dependency lockfile and toolchain digests;
- configuration and binding digests with secret values omitted;
- migration and backfill Artifacts;
- SBOM;
- build provenance;
- required test and security Evidence;
- schema read and write compatibility;
- policy version;
- signer and signing-key identity;
- reproducibility result where the build supports it;
- recovery and rollback assumptions.

A Runner remains an untrusted executor. It can submit an Artifact and
attestation. Anyam verifies expected inputs, digest binding, authority, and
required Evidence before sealing the Release.

Reproducibility is not a cosmetic green check. A non-reproducible Project may
state why and use another accepted provenance control. A Protected Policy
Profile may require reproducibility and block when it is unavailable.

## Work package 4: complete the Cloudflare Target and Promotion path

Extend the existing promotion executor into the first complete application
Target adapter.

### Promotion sequence

```text
1. Observe the current Target and reconcile drift.
2. Verify the immutable Release and required Evidence.
3. Acquire the narrow executor capability.
4. Upload or create the candidate version without moving production traffic.
5. Create a measured preview or canary path.
6. Run health, compatibility, integration, and policy Verifiers.
7. Move a bounded cohort or traffic percentage.
8. Observe version-specific health and application invariants.
9. Increase exposure according to the Promotion plan.
10. Mark current, stop, roll back, compensate, or reconcile an unknown result.
11. Revoke or release the executor capability and seal the receipt.
```

The adapter must support measured fallbacks because a provider preview alias or
canary mechanism may not work in every account state. A fallback is not assumed
safe because the API accepted it. It needs its own live receipt.

The provider credential may remain encrypted in a customer-operated vault when
the provider does not offer true short-lived credentials. The Runner and agent
still receive only a short-lived Anyam Capability Grant to request one exact
operation. They never receive the provider credential itself.

### Required Target observations

- current Worker version and traffic allocation;
- routes, domains, and environment identity;
- D1, Durable Object, R2, KV, Queue, Workflow, and Service Binding identities;
- configuration digests;
- schema digest or migration position;
- health state and last observation time;
- recovery readiness;
- out-of-band drift;
- provider operation identity and unknown-result state.

### Acceptance

- Uploading a candidate does not move production traffic unless the Promotion
  plan explicitly reaches that stage.
- A failed canary blocks broader exposure.
- A response loss cannot cause a blind duplicate provider mutation.
- A Runner cannot promote even if it produces a valid Artifact.
- A compromised application repository does not reveal a reusable production
  credential.
- Direct provider changes produce drift rather than silently becoming Anyam
  truth.
- Rollback is blocked when the prior Release cannot safely use the current data
  state.

## Work package 5: make migration safety executable

Implement the first complete `Migration Plan` adapter for D1. Preserve the
existing distinction between application rollback, data rollback, compensation,
and roll-forward.

### Required migration classes

- expansion: additive and compatible with the currently deployed runtime;
- backfill: bounded, resumable, idempotent data transition;
- compatibility transition: old and new runtimes can coexist;
- contraction: removal or tightening after the rollback window closes;
- forward-only: cannot safely reverse, but has a verified roll-forward plan;
- incompatible: known to break a currently valid runtime;
- unknown: the analyzer cannot prove the class.

### Required checks

- parse and classify every migration statement;
- bind migration files and schema digests to the Release;
- verify the old runtime against the expanded schema;
- verify the new runtime against the expanded schema;
- rehearse against production-shaped, non-production data;
- identify destructive statements, table rewrites, lock risk, and missing
  indexes where the provider exposes enough evidence;
- make backfills resumable and observable;
- reconcile row counts and application invariants after backfill;
- put contraction in a later Release;
- state whether rollback, compensation, or roll-forward is possible;
- block Protected Promotion when compatibility is unknown.

### Acceptance

- New code never reaches traffic before its required compatible expansion.
- An expansion does not break the current Release.
- A destructive contraction cannot ship in the same rollback window as the code
  that stops using the old field.
- A failed backfill resumes without duplicating business effects.
- Application rollback cannot claim to restore data.
- A schema rollback is never offered where a compensating transaction or
  roll-forward is the only honest recovery.

PostgreSQL through a separate adapter may follow. Do not force every workload
into D1 and do not design the PostgreSQL adapter before D1 has passed the
Mailda and company-ledger paths.

## Work package 6: qualify recovery, not backups

Use Project Export, Target contracts, Actions, Verifiers, and Evidence. Do not
create a parallel backup authority.

### Recovery scope

For an adopted Cloudflare application, the recovery contract may include:

- application Artifacts and Release manifests;
- D1 data and migration position;
- R2 object inventory and integrity manifests;
- Durable Object recovery or rebuild procedure;
- Queue and Workflow configuration;
- DNS, routes, mail routing, and other provider configuration;
- encrypted secret and key escrow where the application requires it;
- customer-held recovery material;
- application-level reconciliation and invariants;
- a clean-account or clean-environment restoration procedure.

A backup receipt proves that bytes were copied. A recovery receipt proves that
the system was restored, verified, and measured.

### Required drill

```text
1. Select an exact Release and recovery point.
2. Create clean disposable Target resources.
3. Restore data, objects, configuration, and required key material.
4. Deploy the exact compatible Release.
5. Run integrity, authorization, and business-invariant Verifiers.
6. Exercise representative reads and writes.
7. Record observed data loss window and recovery duration.
8. Destroy or retain the drill Target according to policy.
9. Seal the recovery Evidence and its stale conditions.
```

The same discipline applies to the Anyam Realm itself. Realm export without a
clean restore does not close the credible-team gate.

### Acceptance

- Restore succeeds into infrastructure that did not contain the original
  application state.
- An apparently successful restore that violates application invariants fails
  the Stage Gate.
- Key material remains unavailable to Anyam operators who lack the declared
  customer-held recovery material.
- Recovery numbers are reported as dated observations, not universal SLOs.
- Recovery Evidence becomes stale when the schema, resource graph, key
  generation, or recovery procedure materially changes.

## Work package 7: broker production access

Build a customer-operated production access broker under Realm policy. It
should use existing Capability Grants and Audit Events.

### V0 access modes

1. Application-owned diagnostic Actions. These are preferred because the
   application can preserve tenant, authorization, and redaction semantics.
2. Bounded read-only database access through a provider adapter. This is a
   fallback for diagnosis, with strict parsing, resource binding, row and byte
   budgets, timeouts, and redaction.

Production writes should normally occur through application commands. Generic
agent-authored SQL writes are out of scope for V0.

Human break-glass access remains possible where the provider owner requires it,
but it is a separately governed incident path. Agents and Runners cannot invoke
break-glass.

### Every request binds

- Actor and delegator;
- Realm, Project, and Target;
- exact resource;
- permitted operation or query class;
- reason and incident or Intent;
- issue time and expiry;
- row, byte, duration, and export budgets;
- redaction policy;
- required approval;
- result digest and audit receipt.

### Acceptance

- No caller receives a reusable D1, PostgreSQL, or provider credential.
- A grant for one Target fails against another Target.
- Expired or revoked authority fails before resource access.
- A query exceeding its declared budget stops and names the recovery action.
- Supervised or sensitive reads leave an immutable disclosure record.
- Exported results follow the receiving Actor's Project View and data policy.
- Removing the broker does not stop ordinary application traffic.

## Work package 8: observe drift and reconcile unknown results

Create a Target observer beside the promotion executor. The observer reads
provider state and produces Evidence. It does not mutate the Target by default.

It should detect:

- deployed version changes;
- traffic allocation changes;
- route and domain changes;
- resource replacement or deletion;
- binding and configuration changes;
- migration-position changes;
- policy-relevant secret or credential rotation metadata;
- missing Queue consumers or provider subscriptions;
- stale health and recovery Evidence;
- partially applied or unknown provider operations.

A drift finding offers three explicit actions:

1. adopt the observed state through a Change and Release;
2. restore the expected Release and Target state;
3. record an accepted temporary exception with expiry and recovery action.

Do not automatically overwrite unknown provider state. Reinspect first, bind
the result to the original operation identity, and make ambiguity visible.

## Work package 9: extend Policy Profiles

Keep Policy Profile as the one governance object. Supply templates, not a new
assurance-profile authority.

### Solo template

- immutable Release and provenance;
- required automated Evidence;
- agent self-approval forbidden;
- owner override allowed only with a signed risk receipt;
- tested backup and periodic recovery Evidence;
- no broad credential in agent or Runner context;
- drift visible.

### Team template

Adds:

- independent review for protected effects;
- ownership and review routes;
- separation between Artifact production and Promotion approval;
- role-scoped production access;
- incident ownership and escalation.

### Protected template

Adds:

- strict migration compatibility;
- clean-infrastructure recovery qualification;
- customer-controlled key and credential custody where required;
- stronger separation of duties;
- signed Evidence bundle;
- explicit data classification and retention;
- brokered production access;
- drift blocks Promotion;
- stricter Evidence freshness and external-attestation requirements.

A high-integrity company ledger can use a Protected Policy Profile plus its own
business invariants. A Policy Profile does not make the company legally or
regulatorily compliant.

## Work package 10: generate readiness from Evidence

Do not create a manually edited compliance dashboard. Build a readiness
projection derived from current Evidence and Stage Gate evaluation.

Each material claim should have:

- claim identifier and scope;
- contract and required Evidence types;
- state such as specified, implemented, qualified locally, qualified live,
  observed in production, failed, stale, or indeterminate;
- exact validity key;
- owner;
- observed time;
- stale conditions;
- recovery action;
- public and restricted projections.

README status, control-room state, and release claims should be generated from
this projection where practical. A comment saying "does not ship without X"
must point to an executable Stage Gate or an open issue. Precise claims such as
"never", "always", "cannot", or "same authority" should be backed by a named
Verifier where the property is mechanically testable.

This directly addresses the recurring failure mode where good prose convinces
a reviewer that an unenforced property already exists.

## Work package 11: build the control room last

The control room should present authoritative state that already exists in the
domain model. It must not become the place where missing contracts are hidden
behind green cards.

Required views include:

- adoption inventory and unresolved gaps;
- Change impact and Evidence;
- Release contents and provenance;
- Target state, drift, and recovery readiness;
- Promotion stages and health observations;
- migration compatibility;
- production access grants and disclosures;
- incident, override, rollback, and compensation history;
- export and recovery receipts.

Every blocked state names the failed control, observed value, expected value,
Evidence, and recovery action.

## Dogfood sequence

### Target zero: Anyam itself

Use the customer-operated Realm and the Anyam repository to prove ordinary
human and agent work, review, Landing, Release, Promotion, export, and recovery.
The current real-team gate remains authoritative.

### Target one: Mailda

Mailda is the first adopted application because it exercises most of the hard
Cloudflare boundaries:

- Workers;
- D1 migrations;
- Durable Objects and key custody;
- R2 encrypted content;
- Queues and account-level event wiring;
- Workflows;
- customer-owned deployment;
- `doctor` and machine-verifiable health;
- canary and rollback;
- clean-account recovery;
- sensitive customer data.

The Mailda integration should proceed in this order:

1. run `create-anyam adopt` and accept no automatic mutation;
2. make `mailda doctor`, deployment planning, and recovery output stable JSON
   Evidence protocols;
3. wrap the Worker with the local runtime adapter;
4. create staging and production Targets;
5. qualify immutable Release provenance;
6. qualify expansion, canary, Promotion, and later contraction;
7. run a clean-account recovery drill;
8. remove production credentials from developer, agent, and ordinary Runner
   paths;
9. run a non-critical design-partner pilot;
10. preserve Mailda's standalone CLI and customer-owned operation when Anyam is
    disconnected.

Do not generalize a control merely because Mailda has one implementation. First
make it work, then extract the part that another application actually needs.

### Target two: company operating system

Build a small high-integrity reference application covering:

- company identity;
- share classes;
- shareholders;
- issuance and transfer;
- treasury shares;
- resolutions;
- voting record-date snapshots;
- corporate actions;
- append-only journal and projections.

Use it to test application invariants and failure injection:

- duplicate issuance;
- concurrent transfers;
- stale commands;
- unauthorized execution;
- reordered and duplicated Queue events;
- projection corruption;
- migration incompatibility;
- failed backfill;
- agent self-approval;
- rollback after an irreversible data transition.

Token representation, public offering, secondary trading, custody, and exchange
integration remain optional adapters. The application-assurance work must not
depend on the pending token-offering licence.

### Target three: Lajur

Adopt Lajur after Mailda and the company ledger pass their gates. Lajur proves
that the model works for an ordinary commercial application with a few
high-integrity transaction lanes rather than a system where every record is a
financial journal.

Apply stronger controls to unit holds, bookings, deposits, commissions,
inventory, and integration outboxes. Keep ordinary CRM reads and reporting
simple.

## Ordered implementation backlog

Do not open all tickets at once. Keep issue #182 as the sole current Wayfinder
map until its real-team gate closes. Bounded tasks required to run that gate may
land beneath it. After #286 passes, open one successor Wayfinder map named
"Make safe production the default" and decompose it in this order.

| Order | Work item | Depends on | Exit evidence |
| --- | --- | --- | --- |
| 0 | Close #182 security and provider frontier | Current map | All current P1 and P2 findings resolved with live or deterministic receipts as required |
| 1 | Run #286 real-team trial | 0 | Signed complete gate bundle and retention decision |
| 2 | ADR for manifest and application-assurance extensions | 0, may be drafted during 1 | Accepted domain mapping, version migration, failure behavior, export, and recovery |
| 3 | Read-only `create-anyam adopt` | 2 | Mailda plus simple and monorepo fixtures produce deterministic safe reports |
| 4 | Runtime health and Evidence protocol | 2 | Application remains available without Realm connectivity and emits exact Release identity |
| 5 | Release provenance completion | 2, 3 | Signed Artifact and Release bundle with required provenance and policy evaluation |
| 6 | Cloudflare Target observer | 2, 3 | Actual state, drift, and unknown results are detected without mutation |
| 7 | Progressive Promotion adapter | 4, 5, 6 | Candidate, canary, health, traffic movement, stop, rollback, and reconciliation pass live qualification |
| 8 | D1 Migration Plan adapter | 3, 7 | Expansion, coexistence, backfill, reconciliation, contraction, and failure cases pass |
| 9 | Cloudflare recovery qualification | 3, 5, 8 | Clean-infrastructure restore passes application invariants with observed recovery receipt |
| 10 | Production access broker | 2, 6 | Task-scoped audited access works without exposing reusable credentials |
| 11 | Mailda governed pilot | 3 through 10 | Real non-critical Node installs, updates, fails, recovers, and remains operable without Anyam |
| 12 | Company-ledger benchmark | 7 through 10 | All seeded concurrency, replay, authorization, migration, and recovery failures are prevented or repaired |
| 13 | Lajur adoption | 11, 12 | Same contracts work without Mailda-specific or ledger-specific assumptions |
| 14 | Control-room completion | Stable contracts from prior work | UI truthfully projects the existing authority and Evidence states |
| 15 | Second provider decision | 11 through 13 | Evidence identifies the real common contract and the provider-specific boundary |

Follow the repository working rule of one implementation ticket per work
session. A ticket closes only when its required contract, tests, live receipt
where applicable, export, recovery, documentation, and independent review are
complete.

## Failure-injection acceptance matrix

| Injected condition | Required result |
| --- | --- |
| Agent attempts to approve its own protected Change | Denied and audited |
| Runner attempts to seal or promote its own Artifact | Denied before Target mutation |
| Credential-shaped material appears in a provider response | Rejected and redacted without echoing the value |
| Capability Grant is replayed or used for another Target | Denied before provider or data access |
| Direct `wrangler deploy` changes production | Target drift detected and further protected Promotion blocked until reconciled |
| Provider accepts a mutation but the response is lost | Reinspection identifies the result; no blind duplicate mutation |
| Queue delivers the same event twice | One business effect and an idempotent replay receipt |
| New runtime cannot use the expanded schema | Promotion blocked before production exposure |
| Old runtime cannot use the expanded schema | Expansion blocked before candidate deployment |
| Destructive contraction lands while rollback is still valid | Release rejected |
| Canary error or invariant rate crosses its declared bound | Promotion stopped and previous safe state retained or restored |
| Data transition makes application rollback unsafe | Rollback blocked; verified compensation or roll-forward offered |
| Restore returns bytes but violates an application invariant | Recovery qualification fails |
| Realm is unavailable | Deployed application continues ordinary operation |
| Realm infrastructure is lost | Project Export and recovery procedure restore canonical authority into clean infrastructure |
| One-person owner invokes a permitted override | Risk, actor, control, expiry, and recovery action recorded; agent cannot invoke it |

Every test must identify which layer caught the failure. A passing test that
cannot say whether policy, runtime, database, adapter, or provider produced the
result is weak Evidence.

## Measurements

Do not publish universal numbers before measurement. Record dated observations
for:

- adoption steps and manual interventions;
- Change lead time;
- deployment frequency;
- failed Promotion rate;
- time to stop a bad rollout;
- time to reconcile an unknown provider result;
- clean restore success and observed duration;
- observed data loss window;
- drift detection delay;
- false-block and false-pass findings;
- percentage of production Changes with complete Release lineage;
- stale Evidence rate;
- direct secret exposures, which should remain zero;
- operator and reviewer burden under Solo, Team, and Protected Policy Profiles.

A measurement becomes a product limit only after a separate owner decision and
capacity policy. Provider facts remain provider facts.

## Suggested repository layout

Do not create a package for every concept. Keep domain contracts in the current
kernel until a real boundary requires extraction.

A reasonable first layout is:

```text
src/
  application/                 Project manifest and Change-impact extensions
  adapters/cloudflare/         Target, migration, recovery, and observation contracts

packages/
  create-anyam/                Existing scaffold plus read-only adopt flow
  runtime-cloudflare/          Small customer-runtime adapter

apps/
  promotion-executor/          Existing executor extended for application Targets
  target-observer/             Read-only provider state and drift Evidence
  production-access-broker/    Customer-operated task-scoped diagnostic access

fixtures/
  application-assurance/       Simple Worker, monorepo, Mailda-shaped, and failure fixtures

docs/
  adr/                         One ADR per authority or compatibility decision
  receipts/                    Bounded live provider and recovery observations
```

Keep D1 migration and Cloudflare recovery logic inside the adapter boundary
until a second consumer proves a package boundary. Package sprawl would make
this harder to operate without improving authority.

## Definition of V0 done

Application assurance V0 is complete only when all of these are true:

- Anyam has passed the current credible-team gate;
- an existing Mailda deployment can be adopted without a rewrite;
- the Runner and agent do not receive reusable production credentials;
- an immutable Release reaches staging and production only through governed
  Promotion;
- a bad candidate is stopped before full exposure;
- expansion, runtime coexistence, backfill, reconciliation, and later
  contraction are proven against D1;
- an incompatible rollback is refused;
- Target drift and unknown provider outcomes are reconciled;
- Mailda restores into clean infrastructure and verifies original content and
  application invariants;
- production diagnostic access is task-scoped and audited;
- Mailda keeps operating when Anyam is unavailable or disconnected;
- Project, Release, Evidence, and recovery export remain customer-controlled;
- an independent reviewer has no unresolved critical or high-severity finding
  in the declared V0 boundary.

The capability becomes a general Anyam application-assurance claim only after
Mailda, the company ledger, and Lajur or another materially different
application use the same contracts without hidden product-specific authority.

## Deliberate non-goals

- a second Anyam authority named "Assurance";
- a runtime proxy that every customer request must cross;
- full GitHub Actions compatibility;
- a generic Kubernetes platform;
- a lowest-common-denominator multi-cloud resource model;
- SAML, SCIM, broad federation, or enterprise administration before the
  credible-team gate;
- a compliance badge or automatic legal conclusion;
- autonomous generic SQL writes to production;
- A/B experimentation before safe progressive delivery works;
- a marketplace or large control-room expansion before the contracts are
  stable;
- claiming that one import command makes an unsupported application safe;
- forcing every transaction workload into D1;
- making GitHub, Anyam Cloud, or another hosted service a hidden runtime
  dependency.

## Final operating rule

The safe path must be easier than the bypass.

A developer or agent should describe the intended change. Anyam should derive
what can be derived, request the irreducible decisions, run deterministic
verification, narrow authority, move the immutable Release progressively,
observe the real Target, and retain enough Evidence to recover.

The system succeeds when a one-person team receives strong technical guarantees
without pretending to have a bank's staff, and when a regulated team can add
stricter policy without rebuilding the application from scratch.
