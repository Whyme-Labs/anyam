# Artifacts Workspace contract and competition demo gates

This slice gives a trusted Realm caller an injected Artifacts Workspace control
adapter. Each Workspace/Source Space gets an independent fork, selected from an
exact base commit/tree and bound to the provider's account, namespace and UUID.
Canonical source and Anyam Authority remain separate. Only Landing can publish
canonical state under the existing authority and reconciliation contracts.

## Reproduce the local contract

Use a disposable checkout with Node, npm and Git. Install the locked dependencies
with `npm ci`; this downloads dependencies but does not contact an Artifacts
account. Then run:

```sh
git rev-parse HEAD
git rev-parse HEAD^{tree}
npm run typecheck
npm run typecheck:scripts
npm run typecheck:artifacts-workspaces
npm run build:artifacts-workspaces
npm run qualification:artifacts-workspaces
npm run qualification:scm-credential-model
```

The Worker build is a Wrangler **dry run** with a local-only placeholder binding.
It confirms that the adapter's structural subset fits the pinned official
Workers types and bundles with an Artifacts binding. It does not execute the
binding or deploy anything. Its HTTP handler always returns 404; no credential
or repository mutation route is exposed. `createArtifactsWorkspaceControl`
requires a trusted caller to supply the current Realm authorization callback.
Its optional third argument injects the metadata store; omitting it retains the
explicit process-local contract. No durable binding is provisioned by this app.

`createArtifactsWorkspaceQualification` separately accepts the current run-owner
authorization callback, Workspace authorization, custody store and run ledger.
The owner supplies an explicit run ID, execution mode, account/namespace, exact
prepared source UUID/base and disposable names. It performs no account discovery,
source provisioning, plan activation, deployment or automatic retry. Reusing a
recorded run ID is rejected without exposing or rewriting its previous receipt.
All target names are checked before the first fork; every selection is validated
before provider access. The caller must qualify its exclusive disposable scope
and actual durable storage before live use.

The one-shot ledger records operation intents before provider effects and stores
allowlisted UUID/token metadata, exact observation claims/digests, pending effects
and confirmed token-retirement IDs. It never stores token plaintext or raw
provider exceptions. Local tests use actual disposable SQLite, replace the
connection/store/ledger/adapter, and inject rollback failures before and after
provider effects. A lost fork reply retains its named reservation with unknown
UUID; the invoker does not adopt a repository merely because that name exists.
Declared provider metadata is copied before asynchronous checks. Branches,
object metadata and token IDs that contain observed credential plaintext are
rejected. One-way SHA-256 fingerprints and credential lengths preserve this
guard across restart, including plaintext embedded in a metadata string. UUIDs
and token IDs are journaled before fingerprinting awaits, with a durable pending
guard marker. An unfinished guard requires named reconciliation after restart;
fresh provider metadata cannot replace missing redaction custody.

Cleanup reauthorizes the recorded scope and rereads the recorded UUID. Complete
`listTokens` results require unique valid IDs and a page length equal to the
provider's total; incomplete or malformed pages fail closed. Fresh UUID checks
surround each inventory read. All active IDs are retired, and another complete
inventory must confirm no active tokens before deletion. This can reconcile a
lost mint/initial-token reply for a known owned UUID. It does not reopen blocked
Workspace custody or certify provider expiry timing. Each resource is attempted
independently; one failure cannot hide another resource's cleanup result.
False/not-found revocation alone does not prove retirement. Complete fresh
inactive inventories can reconcile known IDs whose retirement reply was lost;
active or newly journaled IDs still block deletion.

Deletion requires a separately injected `deleteOwned` port qualified to delete
only the expected immutable UUID. The official binding exposes `delete(name)`;
the invoker never substitutes that API for a conditional UUID operation. If the
port is absent, known tokens are still retired and the resource receipt names
`qualification.guarded_delete_unqualified`. An uncertain deletion is journaled
before the call and is never automatically repeated, including after restart.
The local fixture qualifies this port's contract, not a live service capability.

Receipts identify the execution mode, selected account/namespace, named resources,
pending states, token IDs, exact observation digests, operation intents and
recovery codes. Operation intents are not measured billing or performance.
`liveQualified` remains false; Git scope, expiry timing and native harnesses remain
`not-run`. A `local-fixture` success means the injected binding contract and owned
cleanup passed. The `live-approved` label requires owner authorization and cannot
upgrade those other gates.

The Workspace tests inject fake Artifacts responses. They concurrently provision
two distinct forks, retire their initial tokens, check source and fork UUIDs,
remotes, default-branch heads and commit trees, issue explicit read/write tokens,
and exercise drift, revocation, expiry, lookup failure and lost replies. The
Smart HTTP tests separately execute actual Git clone/fetch/push/CAS/export/restore
against an owned loopback fixture. These are distinct evidence levels: fake
binding conformance plus real local Git transport, **not live Artifacts Git**.

The bounded credential model tests the concrete `SmartHttpCredentialAuthority`
with `MemorySmartHttpCredentialStore`, using an independent explicit outcome
table. Its domains are five phases (absent, read-active, write-active, revoked,
expired), five probes (own read/write and peer Repository/Source Space/Workspace),
and two restart modes. The receipt enumerates all 50 measured cases. Three
deliberately incorrect allowed-outcome traces must be detected: revoked read,
read-token write and peer-Workspace write. These are trace mutations, not claims
of production code mutation coverage. Exact expiry is tested. The check does not
prove arbitrary histories, concurrent writes, liveness, full SCM refinement,
provider behavior or the whole product. Earlier recollections attributed to
Anyam #184/#194 are not evidence of a shipped formal model.

## Adapter boundary

`ArtifactsWorkspaceSelection` pins Project, Project Revision, Project View,
Workspace, Source Space, source provider identity, target name and SHA-1 base
commit/tree. Caller input is copied and frozen. The trusted callback must resolve
and recheck current authoritative Workspace/disclosure grants, throwing on
denial and returning their expiry; the adapter does not infer authority from IDs.
Authorization is checked before provider access and again around asynchronous
fork/mint effects. This callback is an internal contract, not a hosted grant
implementation or a substitute for current Realm policy.

The documented fork API has no pinned-commit argument. The adapter reads the
source, then verifies the actual fork's default-branch head and exact commit/tree
before releasing context. It retires the initial fork token before readback.
It accepts only the credential-free remote matching the enrolled account,
namespace and name, and binds the immutable provider UUID into the Anyam
Repository ID. A later delete/recreate at the same name fails fresh identity
validation before token minting. Complete remotes must be explicitly enrolled in
`SmartHttpRepositoryDriver`; repo basenames cannot carry provider authority.

Tokens leave this module only through the existing `SmartHttpCredentialIssuer`
seam. Requested read/write scope is explicit; write requires the exact Workspace.
The expiry fits both the request and current grant and the documented Artifacts
token TTL bounds from workers-types 5.20261001.1 (60 to 31536000 seconds).
Tokens are repository-scoped, so an agent never receives a canonical repository
write token. `canonicalWrite: false` labels the Anyam authority boundary; it does
not imply that Artifacts offers ref-scoped tokens. The credential consumer must
keep returned plaintext out of logs, argv, stored remote URLs and receipts.

Revocation stops issuance before awaiting provider retirement. Tokens rejected
after minting are retired, including revocation during the mint. An unconfirmed
retirement or unknown mint blocks further issuance. An unknown inventory cannot
be reported as completely revoked merely because locally known token IDs were
retired. Errors name the target and uncertain effect, withholding provider error
text that might contain credentials. Reconcile the named repository and token
inventory before retrying; the adapter never broadly deletes repositories.

The default metadata store is **process-local**. A trusted caller can inject
`SQLiteArtifactsWorkspaceStore` using the synchronous SQL host already used by
Realm Authority. Local qualification opens actual disposable SQLite files,
replaces the database connection/store/adapter, and verifies exact enrollment,
name/Workspace reservations, token IDs and revocation survive. These contexts
report `sqlite-contract`; canonical publication stays unqualified. Stored
selection grants no authority: the current callback and provider UUID are checked
again after restart. Only declared selection fields enter custody, and current
authorization receives an immutable copy.

Each fork and mint commits a pending marker before its provider effect. A
concurrent adapter cannot start another mint while that marker remains. Known
token IDs are committed before later asynchronous checks or credential release;
plaintext is never stored. Revocation commits its block before provider access,
including reservations whose fork has not yet enrolled a context. A revoked
pre-effect reservation remains a durable tombstone rather than being released;
a pending fork reports uncertain inventory and cannot later release context.
Revocation then removes IDs only after confirmed retirement. Pending/lost mint replies
cannot certify complete revocation. Failed writes roll back, withhold credentials
and prevent unjournaled provider effects. Unknown operations retain reservations
and require named reconciliation rather than automatic adoption or broad deletion.

This qualifies local SQLite metadata custody, not a deployed Durable Object,
cross-region authority, durable grant epochs, complete provider token inventory,
an adoption/reopen/delete workflow or orphan cleanup. Production must supply and
qualify its actual Realm storage/routing and reconciliation before exposing this
seam to agents.

The Artifacts control adapter now exposes a trusted `observeRepository` seam.
It resolves enrolled custody, rechecks current authorization and fresh provider
UUID/remote, and reads an exact full branch ref matching the expected commit/tree.
An iterative all-parent traversal requires exact commit identities, complete
parent lists and a reachable selected base; missing objects and cycles fail.
Initial head hash/tree primitives are copied before asynchronous reads. Provider
identity and the ref are reread before releasing the existing observation digest.
These are bounded fresh observations, not provider linearizability, ABA detection
or canonical generation fencing. The trusted caller still needs to wire and
qualify this provider observer in its actual revision/verification flow.

Smart HTTP remote observation now fails with
`repository.remote_observation_unqualified`: local checkout HEAD/ref/ancestry
cannot certify a current provider ref. Locally restored repositories retain
local observation. A live revision path still needs a fresh qualified remote
readback. Remote CAS requires an explicit expected OID/null for each desired ref;
empty, abbreviated and symbolic expected values fail before credential issuance.
Both ref maps are snapshotted before awaiting credentials, so later caller
mutation cannot add unguarded refs or alter predicates.
Empty desired maps are rejected before credentials, preventing Git's implicit
default push from updating an ahead branch.
Ref keys must be full literal refs accepted by `git check-ref-format`, and
desired values must be exact OIDs/null. This rejects wildcard expansion and
force-prefixed or symbolic source expressions. Guarded pushes explicitly disable
implicit tag following and submodule recursion, so ambient Git configuration
cannot add unrequested tags or suppress the requested parent update.
Force-with-lease alone does not establish all-ref atomicity, generation fencing
or protection against ABA. Canonical reconciliation remains gated by its
separate all-writers generation/epoch/seal contract.

Official API references: [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/),
[Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/),
[authentication](https://developers.cloudflare.com/artifacts/guides/authentication/).
These support the provider facts above, not successful operation on a selected
customer account.

## A narrow demonstration worth finishing

The differentiator is independently running coding harnesses producing exact
private candidates that reviewers can compare and safely integrate, with
inspectable evidence and interruption recovery. Show the source and authority
chain, rather than presenting synthetic Actor names as actual native agents.

A five-to-ten-minute recording can follow this sequence after the live gates
below are satisfied:

1. Show the declared task, selected Source Spaces/disclosure, base Project
   Revision and two authorized Workspace identities.
2. Fork one real Artifacts repository per Workspace and run two native coding
   harnesses concurrently against them. Record actual harness versions, inputs,
   selected commit/tree OIDs and any provider/model usage.
3. Show the exact candidate changes and a deliberately conflicting/incompatible
   candidate blocked before canonical mutation. Current Cohorts require explicit
   compatibility; do not claim a same-Source-Space semantic merge capability.
4. Consume actual externally executed verification Evidence bound to each exact
   candidate, View, declared inputs and output digest. Show historical or altered
   Evidence failing to satisfy a different candidate.
5. Review the exact integrated candidate, then demonstrate Landing interruption,
   named reconciliation and recovery with later Landing blocked until completion.
   Show immutable original results and the completed authority chain.

The current offline verifier workflow is separately runnable with
`npm run qualification:cohort-local-verifier` from a clean committed checkout.
It executes real local verifier processes and SQLite Authority transitions but
uses synthetic governance and a fake fenced canonical provider. It is useful
supporting evidence, not proof of a live Artifacts Landing or native harness run.

## Claims/evidence checklist for the October 13 Malaysia buffer

| Claim | Available evidence | Remaining gate |
| --- | --- | --- |
| Official Workers Artifacts adapter contract | Typecheck, binding dry build, injected lifecycle/token/object-read tests | Named account service conformance and real Git transport |
| Independent Workspace forks and complete provider identity | Concurrent fake-binding forks and identity/drift regressions | Actual per-agent forks, durable custody and cleanup |
| Exact SCM credential isolation and restart revocation | Concrete bounded transition receipt and existing tests | Hosted store/grant epoch enforcement; provider expiry/revocation |
| Exact candidate verification and interrupted Landing recovery | Existing local verifier/SQLite/fake-provider qualifier | Real external harness/verification and qualified canonical writer |
| Concurrent native coding harnesses | No evidence supplied by this slice | Explicit harness/model/credential/cost authorization and recorded runs |
| Permissively licensed competition entry | No root first-party license applied | Owner chooses and applies an eligible license; audit dependencies |
| Reproducible submission | Local commands and proposed demo sequence | Fresh install/live run instructions, final provenance, recording and official eligibility check |

Before live work, choose the account/namespace and disposable names, confirm paid
entitlement without activating a plan, and obtain explicit permission for the
credential path, named mutations/cleanup, harnesses and measured cost envelope.
Do not migrate canonical storage, deploy, license or submit as part of this
contract exercise. Treat October 13 Malaysia as the internal buffer; confirm the
official deadline and terms independently before submission.
