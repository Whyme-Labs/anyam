# Current Source disclosure on Authority reads

Ordinary authenticated Authority reads use `AuthorityDisclosure` after the
Coordinator loads its snapshot and revalidates the human Session. Stored Views
provide immutable contributing Source scope. Current Realm policy, explicit
resource-scoped denies, Source reader/discoverability rules and policy versions
provide authority; a historical View is never an authorization cache.

Project descriptions list readable Sources only. Counts use the same eligibility
predicates as child reads. Disclosed Project View Revision identities hash only
readable Source descriptors and snapshots, independently of canonical manifest
IDs and hidden activity. Workspace, Change, candidate Run, Mirror and Release
references likewise use contributing scope. Canonical records are unchanged.

A record spanning an inaccessible Source is unavailable until a separately
approved audience projection exists. Missing, hidden and inconsistent records
return the same `not_found` projection. Intent and comment classifications are
checked independently for the Project collaboration audience. Reading an
unrelated restricted Source does not authorize restricted collaboration. Intent
summaries omit author, assignee, Session and activity timestamps. Pull Request
summaries omit provider identity, remote repositories, review identities and
receipt/digest details, and validate represented Change lineage.

Runs retain authorized basic identity, disclosed revision, status and readable
Workspace/Change bindings. Ordinary stored Run/Evidence digests alone cannot
prove accepted job input/output closure or detail disclosure. A separate accepted
signed completion contract now retains its proof for the explicit Realm-owner
detail endpoint described in [disclosed writes and owner Run detail](disclosed-writes-and-owner-run-detail.md).
Artifact scope additionally requires its exact producing
Run or Change View; a globally reused projection label supplies no authority.
Ordinary reads therefore omit runner/verifier
identities, attempt, contract, input/output/environment/toolchain/dependency
and log digests. Mirror operation/checkpoint/delivery/proposal records and
Promotion provider/checkpoint/configuration/provenance details are similarly
not exposed without an approved detail projection. Basic eligible Mirror,
Release, Target and Promotion status remains available.

Explicit Authority state/recovery requires a current human Realm-wide owner.
A Project-scoped owner is insufficient. Full state/storage receipts and signed
recovery export additionally require complete current Source access. Otherwise
state returns disclosed counts and export returns safe `not_found`.

## Local verification

- `npm run qualification:disclosure-local`: projection regressions plus the
  actual Coordinator in workerd SQLite through production REST/MCP handlers.
- `npm run typecheck:worker-tests`: includes the actual runtime fixture.
- `npm run qualification:worker-test-boundary`: compiles exact fixture source
  copies and requires rejection of an intentional missing-symbol error.
- `npm test`: includes both disclosure regression files.

The runtime uses owned temporary SQLite, synthetic passkey/host-cookie/OAuth
contexts, a fixed test clock, disabled telemetry and denied outbound requests.
It does not qualify WebAuthn, OAuth consent, live providers or hosted deployment.
The `.mjs` Node orchestration harness is not covered by the Worker TypeScript
project; its Worker fixture is.

The bounded policy check exhausts 256 combinations of current/stale Source
policy, reader membership/empty reader sets, discoverability, capability allow,
Source deny, relationship availability and relationship deny. Every metadata
allow must refine the actual kernel Source authorization, and adding a Source
deny must never permit access. A separate 32-variation check compares all
ordinary readable observations under hidden-state changes. These are bounded
executable refinement/noninterference checks, not an unbounded formal proof.

## Remaining product boundaries

The separate [disclosed write qualification](disclosed-writes-and-owner-run-detail.md)
resolves read-safe Project View Revision selectors into exact server-side
canonical context for Workspace creation, Change creation, Change Revision
publication and Run request. This read qualification alone does not establish
their write authority. Raw exact-selector commands for these four operations
now require a human Realm-wide owner with complete Source access.

Restricted Intent/comment reader scopes, audience-approved Sealed Verifier
invocation/result projections and Mirror/Promotion recovery details remain
separate contracts. The fixed owner Run detail does not implement those
contracts or qualify private implementations merely from fixture digests.
