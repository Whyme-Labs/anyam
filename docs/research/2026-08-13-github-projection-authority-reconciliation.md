# Anyam Authority reconciliation for bidirectional GitHub projection

**Date:** 13 August 2026
**Ticket:** [#186](https://github.com/Whyme-Labs/anyam/issues/186)
**Status:** research decision and bounded implementation boundary; not a production qualification

## Executive decision

Anyam remains the only canonical Project Revision authority. GitHub is an
external projection and contribution surface, never a second canonical source
of truth. The smallest durable implementation is a provider-specific GitHub
App adapter behind the existing provider-neutral `MirrorCoordinator`, plus a
customer-Realm mirror coordinator that persists mirror state, delivery
idempotency, external proposal identity, and recovery checkpoints.

The boundary is:

```text
Anyam canonical Source Space / Project Revision
        │
        ├── exact safe projection ──> GitHub mapped refs
        │                              (external, untrusted)
        │
        └── remote event or polling hint
                    │
                    v
        inspect and reconcile GitHub state
                    │
                    v
        Change proposal / Change Revision in Anyam
                    │
                    v
        normal evidence, review, policy and Landing
```

A GitHub commit, pull request, review, check, or merge event must never by
itself advance Anyam's canonical pointer. Only the existing typed Landing path
may do that. A webhook is a prompt to inspect remote state, not remote
authority.

## What is already qualified

The provider-neutral Repository Mirror contract and the bounded live
qualification in
[`2026-08-03-p3-3-github-mirror-qualification.md`](./2026-08-03-p3-3-github-mirror-qualification.md)
already cover a useful transport/coordinator boundary:

- Anyam projects only permitted mapped refs from a public Source Space.
- Private or unmapped refs are excluded from a public projection.
- Outbound pushes use expected remote generation and exact returned-ref
  validation.
- A remote fast-forward becomes an attributable, pending Anyam Change.
- Duplicate inbound input is idempotent.
- Force pushes and two-sided changes become explicit divergence rather than
  silent reconciliation.
- Credential failure records a resumable checkpoint.
- Landing remains a separate, normal Anyam operation.

That receipt was deliberately bounded. It did **not** qualify a live GitHub App
installation, signed webhook ingestion, delivery replay/order handling, PR
identity, Realm persistence, provider credential rotation, or recovery after a
provider outage. This ticket should close only after the implementation and
qualification boundary below is explicit; it must not be represented as
production-ready GitHub integration today.

## Current-state trace

| Area | Existing contract | Gap for a first-class current Authority path |
| --- | --- | --- |
| Remote transport | `MirrorRemoteAdapter` can inspect and compare remote refs, push an exact projection, and return provider receipts. | No GitHub-specific App authentication, API observation, webhook delivery, or provider backoff adapter is present. |
| Mirror coordinator | `MirrorCoordinator` handles mapped refs, disclosure, idempotency, loop provenance, force-push/deletion, divergence, and checkpointed recovery. | It is an in-process provider-neutral coordinator; its origin model has no stable GitHub PR identity or delivery ID. |
| Source authority | `ProjectRevision` and `landing.apply` provide an exact canonical pointer and CAS-guarded Landing. | Authority snapshots and commands do not persist mirrors, operations, checkpoints, remote generations, or external proposal mappings. |
| Change authority | `change.create` and `revision.publish` create normal Changes and immutable revisions. | `change.create` currently does not accept a validated mirror/PR origin payload; a PR head cannot be attached to one stable Change across synchronizations. |
| Realm Worker | Typed project/workspace/change/revision/run/evidence/landing/release/target/promotion routes exist. | There are no mirror configuration/inspection/sync/reconcile routes, GitHub webhook route, queue consumer, or mirror Durable Object state. |
| Repository driver | Provider seam covers Git transfer and repository lifecycle. | No provider-neutral event/delivery or PR observation seam; those must stay in the GitHub adapter, not leak into canonical commands. |
| Export/recovery | Project export can include mirror metadata when supplied. | A live Authority snapshot does not yet contain mirror state, delivery IDs, external proposal map, or credential-free recovery receipts. |

The smallest implementation is therefore not a new Git protocol and not a
GitHub-shaped Authority. It is a narrow mirror coordinator surface attached to
the existing Realm Authority, with a GitHub adapter that remains replaceable.

## Authority ownership

| Anyam owns | GitHub adapter observes or transports | Never delegated to GitHub |
| --- | --- | --- |
| Project and Source Space identity | Remote repository/ref state | Canonical Project Revision |
| Public/private disclosure and safe Project View | Git Smart HTTP fetch/push | Anyam Landing or promotion |
| Intent, Workspace, Change and Change Revision | Push/PR webhook delivery metadata | Anyam policy approval |
| Evidence, review findings, conflicts and policy decisions | PR title/body/head/base/reviews as untrusted provenance | Anyam credentials to clients |
| Canonical refs, Landing, Release and Target state | Provider operation IDs and rate-limit receipts | Private Source Space projection |
| Mirror state, checkpoints, divergence, idempotency and audit | GitHub installation identity and remote generation | A second canonical branch |

The GitHub App's permission is an adapter credential, not a Realm, Project,
Source Space, Target, or agent credential. The adapter must not expose its
installation token or private key to a browser, coding agent, MCP client, or
repository workspace.

## GitHub App permission profile

Use an installed GitHub App rather than a user PAT or a Realm-wide OAuth token.
An installation access token is generated from the App identity and installation
ID, is scoped to the installation's repositories, and expires after one hour.
GitHub documents installation tokens for Git over HTTPS using the
`x-access-token` username and for REST API calls:
[
GitHub App installation authentication
](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

Default permissions should be the minimum needed for the selected projection:

| GitHub App permission | Default | Why |
| --- | --- | --- |
| Metadata | Read | Repository identity and API metadata; GitHub requires metadata access for repository App operations. |
| Contents | Write for outbound projection; Read for inbound-only | Git transport and mapped ref observation. A write grant is not Anyam canonical write. |
| Pull requests | Read | Observe PR number, head/base, commits, files and reviews so a PR maps to one stable Anyam Change. |
| Commit statuses | None, or Read when explicitly needed | Read legacy status context only when a policy imports it. |
| Checks | None, or Read when explicitly needed | Read provider checks only when a policy imports them. Add Write only if Anyam intentionally publishes Anyam evidence back to GitHub. |
| Webhooks | None for an App-level webhook; Write only when managing repository hooks | Do not grant repository hook administration if one installation-level webhook is sufficient. |
| Administration / rulesets | None | Branch protection/ruleset administration remains customer-controlled. Do not make the adapter a policy bypass administrator. |

GitHub's permission matrix is the source of truth for endpoint-specific
requirements:
[
permissions required for GitHub Apps
](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).
Rulesets and branch protection can require pull requests, required status
checks, signed commits, merge queues, and block force-push/deletion; they should
be configured by the customer around the mapped branch rather than silently
mutated by Anyam:
[
available rules for rulesets
](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[
rules REST API
](https://docs.github.com/en/rest/repos/rules).

Any permission added after the default profile is a product decision and must
have a receipt in the qualification output. Provider limits such as token
lifetime and rate limits are facts about GitHub, not Anyam budgets.

## Outbound projection flow

1. A verified Anyam Project Revision is selected by an explicit mirror policy.
2. The mirror coordinator resolves the public Project View and mapped refs.
   A public mirror may only include public Source Space content; private codec
   or commercial-core refs are not sent.
3. The GitHub adapter obtains an installation token just in time and fetches
   the remote generation/ref state.
4. The adapter pushes only the exact desired mapped refs over Git Smart HTTP,
   carrying an operation/idempotency key and origin Project Revision receipt.
5. The coordinator validates the returned generation and exact mapped refs.
   A mismatch is `divergent`, not success.
6. The operation and origin are written to the Realm mirror ledger. A later
   GitHub push event whose delivery carries the same origin is loop-prevented;
   the remote is still inspected when state is uncertain.

The GitHub App may use REST Git database endpoints for observation or repair,
but the adapter must not create a second ref authority. GitHub's Git database
API can read and update raw objects/refs, while Git Smart HTTP is the normal
source-object transfer path:
[
using the REST API to interact with the Git database
](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database).

## Inbound push flow

1. GitHub sends a `push` event, or a polling/recovery job notices a remote
   generation change.
2. The Worker verifies the raw request body using the configured webhook secret
   and HMAC `X-Hub-Signature-256` with a timing-safe comparison. GitHub's
   signature guidance requires the raw payload and `sha256=` prefix:
   [validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
3. The handler persists `X-GitHub-Delivery`, event name/action, installation
   ID, repository, and receipt as an idempotency record, then queues the
   bounded reconciliation. The handler should return 2XX quickly; GitHub's
   guidance says to respond within ten seconds and process asynchronously:
   [webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
4. The queue consumer obtains a fresh installation token, inspects the named
   mapped ref, and verifies the exact commit OID/author and disclosure.
5. For a new remote commit, the mirror sink creates an Anyam Change proposal
   based on the current canonical Project Revision. The commit is untrusted
   input and cannot be approval or Landing.
6. The Change remains pending until normal Anyam checks, evidence, review,
   policy, and Landing complete. After Landing, the mirror coordinator records
   the resulting canonical/remote alignment.

GitHub's event payload contract exposes delivery ID, event/action, repository,
installation, `ref`, and push `after` SHA:
[
webhook events and payloads
](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

## Inbound pull-request flow

A pull request is a proposal surface, not a second Change authority. The
GitHub adapter should use this stable external key:

```text
github:<installation-id>:<owner>/<repo>#<pull-request-number>
```

The key maps to exactly one Anyam Change. Each new PR head SHA (including a
`synchronize` event) becomes a new immutable Change Revision under that Change;
it must not create a new Change for every force-pushed head. Preserve the
following as untrusted provenance/extension data:

```text
provider, installationId, repository, pullRequestNumber, pullRequestUrl,
headSha, baseRef, baseSha, eventDeliveryId, action, remoteAuthor,
providerReceipt
```

The current `ChangeOrigin` and `MirrorRemoteCommit` types do not contain this
stable proposal key, PR number, URL, head/base, or delivery ID. The smallest
provider-neutral change is an optional external-proposal extension plus a
Realm-scoped external-proposal ledger. Do not expose private PR body/review
content in a public Project View unless the Source Space disclosure policy
permits it.

PR reviews, approvals, and GitHub's `merged=true` flag are external evidence or
provenance only. They are not Anyam `ReviewApproval` and not Anyam Landing.
When a PR closes or merges, the adapter reconciles remote refs and marks the
external proposal closed/abandoned/observed; Anyam's Change status changes only
through its own policy and typed commands. GitHub's PR and review APIs are the
provider reference:
[
pull requests REST API
](https://docs.github.com/en/rest/pulls),
[
pull request reviews REST API
](https://docs.github.com/en/rest/pulls/reviews).

## Webhook delivery, replay, polling, and recovery

Persist these values in the mirror ledger before queueing work:

```text
deliveryId, event, action, installationId, repository,
receivedAt, signatureReceipt, queuedAt, processedAt, outcome,
remoteGeneration, mappedRefOids, operationId, checkpointId
```

The delivery ID is the dedupe key. Redelivery of the same GitHub delivery must
not create a second Change or revision. Events can arrive out of order, so the
consumer always re-inspects remote state and compares generations/OIDs rather
than applying an event as an imperative ref mutation.

GitHub does not automatically redeliver failed deliveries. The recovery loop
must therefore inspect delivery status, redeliver where supported, and run a
remote reconciliation from the saved checkpoint. GitHub documents manual/API
redelivery and failed-delivery handling:
[
handling failed webhook deliveries
](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries),
[
redelivering webhooks
](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks).

GitHub REST clients must send an explicit API version and standard JSON
headers; the currently documented supported version is a provider fact and
must be rechecked at qualification:
[
REST API versions
](https://docs.github.com/en/rest/about-the-rest-api/api-versions),
[
REST API getting started
](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api).

The adapter records `x-ratelimit-*`, `retry-after`, reset, HTTP status, and
provider operation IDs. It uses bounded exponential backoff and never converts
a GitHub rate-limit number into an Anyam limit. GitHub documents primary and
secondary rate-limit behavior here:
[
REST API rate limits
](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Divergence, force update, and loop prevention

The existing mirror state machine remains the right model:

- A fast-forward remote change becomes a pending inbound Change.
- A remote force-push or deletion becomes durable `force-pushed`/`divergent`
  state and requires explicit reconciliation.
- A canonical change and remote change in the same cycle become divergence;
  the adapter must not pick a winner silently.
- An outbound operation's origin operation ID is retained so its resulting
  push event can be recognized. Recognition suppresses duplicate proposal
  creation; it does not suppress a safety inspection when the remote state is
  uncertain.
- A GitHub PR merge is never treated as a successful Anyam Landing. Anyam must
  inspect the resulting ref and still run its own Change flow.
- A failed credential exchange leaves an immutable checkpoint. Resume repeats
  the same safe inspection/push operation with a fresh installation token; it
  does not create a new canonical revision.

The public/private separation is a security invariant, not a convention. A
remote GitHub user must never learn private ref names, object IDs, commit
messages, PR metadata, or timing-correlated private updates through an
unauthorized projection. Anyam's public mirror is a projection of a safe
Project View; it is not a filtered directory listing over a private object
graph.

## Smallest implementation boundary

### A. Persist a first-class mirror state in the customer Realm

Add a Realm-owned mirror record and operation/checkpoint records containing the
existing `RepositoryMirror` fields plus:

- mapped-ref remote generations and OIDs;
- idempotency keys and origin operation IDs;
- webhook delivery IDs and outcomes;
- external proposal key -> Anyam Change ID;
- provider credential/auth receipts without credential material;
- last successful inspection and resumable checkpoint;
- disclosure and Source Space policy receipt.

Expose narrow typed operations such as `mirror.configure`, `mirror.inspect`,
`mirror.sync`, and `mirror.reconcile`. A client must never call a raw
`remote.push` command. Keep canonical mutation behind existing typed
`landing.apply`.

### B. Implement a GitHubProjectionAdapter

The adapter owns GitHub App JWT/IAT exchange, Git Smart HTTP credentials,
REST PR/ref observation, webhook signature verification, event normalization,
queue dispatch, rate/backoff receipts, and provider-specific cleanup. It
implements the provider-neutral mirror seam and never receives canonical
Authority credentials.

The adapter should use one installation-level webhook for the qualification;
repository-hook management is a separate capability and is not required for
the first boundary.

### C. Add an external proposal identity seam

Extend mirror-origin data without coupling the kernel to “GitHub PR” as a
universal object. The provider-neutral shape should support:

```text
externalProposalKey
provider
remoteRepository
proposalNumber or providerRef
head/base refs and OIDs when available
delivery IDs and provider URL as provenance
```

`MirrorChangeSink` must create one Change per stable external proposal and
publish successive PR heads as Change Revisions. A raw push without a PR may
use the existing `(mirror, ref, commit)` proposal key.

### D. Integrate with the current Authority commands

Use existing `project.create`, `workspace.create`, `change.create`,
`revision.publish`, evidence/review, and `landing.apply` semantics. Add a
narrow mirror-specific command or typed edge that validates source-space,
disclosure, actor, provider, and external-origin fields before invoking normal
Change creation. Do not broaden `landing.apply` to accept provider data.

### E. Qualify one end-to-end boundary

The first live qualification should use one customer-operated Realm, one
public Source Space, one GitHub App installation, one disposable repository,
and one mapped `refs/heads/main`:

1. Configure mirror and record credential-free receipt.
2. Land an Anyam revision and verify exact outbound remote ref.
3. Receive a signed `push` event and create one attributable Change.
4. Open a PR and verify one stable Change; synchronize it and verify a new
   Change Revision.
5. Redeliver/duplicate events and prove no duplicate Change or Revision.
6. Exercise force-push and two-sided divergence; require explicit reconcile.
7. Rotate/expire the App credential and resume from a checkpoint.
8. Export and restore mirror ledger metadata; inspect remote before any push.
9. Delete all disposable queues, workers, repositories, hooks, and output
   prefixes, recording cleanup receipts.

This is a qualification boundary, not a claim that every GitHub feature is
supported.

## Acceptance receipt checklist

The implementation/qualification must produce redacted, reproducible receipts
for:

- exact Anyam commit SHA and Authority schema/policy version;
- GitHub App installation and repository, without private key or token value;
- granted App permission profile and customer branch/ruleset configuration;
- raw webhook signature verification and delivery ID dedupe;
- remote generation/ref OIDs before and after every operation;
- outbound operation ID and loop-prevention origin;
- inbound push Change origin and base Project Revision;
- PR external proposal key, head-to-revision mapping, and duplicate behavior;
- disclosure decision proving private refs were not projected;
- divergence/force-push/reconcile result;
- provider auth expiry/rotation and checkpoint resume;
- export/restore/re-inspection behavior;
- cleanup status for every disposable provider resource.

Every Anyam number in a receipt needs a measurement behind it. GitHub's
documented token lifetime, webhook response guidance, redelivery availability,
and rate-limit values are provider facts and must be labeled as such rather
than copied into Anyam limits.

## Explicitly out of scope for this boundary

- GitHub becoming canonical or merging directly into Anyam.
- Full GitHub Issues/projects/discussions parity.
- Anyam publishing checks, comments, or approvals back to GitHub by default.
- GitHub branch-protection/ruleset administration by the adapter.
- Public projection of private Source Spaces or private PR metadata.
- Automatic conflict resolution or automatic force-push winner selection.
- Federation with other forges.
- A second provider-specific source-control database.
- Production claims before a live App installation, webhook, PR mapping,
  recovery, and cleanup receipt exists.

## Final recommendation for #186

Accept the bounded direction above as the current Authority adoption path:

> Anyam is canonical; a GitHub App is a replaceable projection adapter; signed
> events are queued hints; remote state is inspected; pushes and pull requests
> become attributable Changes/Revisions; only normal Anyam policy and Landing
> advance canonical state.

The next implementation issue should cover the Realm mirror state and typed
API plus the external proposal ledger. A separate implementation issue should
cover the GitHub App adapter and webhook/reconciliation qualification. Keeping
those seams separate preserves the provider-neutral mirror contract and makes
GitHub integration replaceable without weakening Anyam's Authority model.

## Primary sources

- [GitHub App installation authentication](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [About creating GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps)
- [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
- [Redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)
- [Pull requests REST API](https://docs.github.com/en/rest/pulls)
- [Pull request reviews REST API](https://docs.github.com/en/rest/pulls/reviews)
- [Git database REST API](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database)
- [REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
- [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Rules REST API](https://docs.github.com/en/rest/repos/rules)
- [REST API getting started](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api)
