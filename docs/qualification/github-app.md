# GitHub App projection qualification

`npm run qualification:github-app` is a bounded provider qualification for the
GitHub App projection adapter. It is not a production-support claim. Anyam
remains canonical; GitHub is an external projection and contribution surface.

The qualification requires a customer-operated GitHub App installation with
selected-repository access. The runtime adapter uses `Contents: write`,
`Metadata: read`, and `Pull requests: read`. The qualification setup also uses
`Pull requests: write` to create a disposable branch and PR, then advances the
PR head deterministically; this setup permission is not required by the
production observation path. `Administration: write` is used only for the
explicit disposable-repository cleanup step. Subscribe the App to exactly
`push` and `pull_request` events. The qualification repository must be
disposable and must equal the explicit cleanup target.

## Webhook ingress

The customer Realm exposes the provider wake-up boundary at:

```text
POST https://<realm-host>/webhooks/github
```

Configure the GitHub App's **Webhook URL** to that exact HTTPS URL only after
the Realm Worker has been deployed with its Queue binding and a bound
`ANYAM_GITHUB_MIRROR_PRODUCER` synchronizer. Set the Worker variables
`ANYAM_GITHUB_APP_REPOSITORY` and `ANYAM_GITHUB_APP_INSTALLATION_ID` to the
exact selected `owner/name` and GitHub App installation ID. Subscribe the App
to `push` and `pull_request` events. Store the App webhook secret only as a
Worker secret:

```bash
wrangler secret put ANYAM_GITHUB_APP_WEBHOOK_SECRET --config <customer-wrangler-config>
```

The ingress verifies the raw request body using `X-Hub-Signature-256`, checks
the event, repository, installation, and delivery identities, and enforces the
configured body tripwire. It returns a `202` quickly and queues a
credential-free wake-up envelope. The envelope is a hint, not provider truth:
the synchronizer must re-inspect GitHub with a just-in-time installation token,
create the signed `mirror.sync` handoff, and send it to
`/internal/mirrors/ingest`. Provider tokens and App private keys must never be
placed in Queue messages, Authority state, Evidence, exports, or issue
comments.

The non-secret body tripwire is configured in Wrangler variables:

```jsonc
{
  "vars": {
    "ANYAM_GITHUB_WEBHOOK_BODY_BYTES_LIMIT": "1048576",
    "ANYAM_GITHUB_WEBHOOK_BODY_BYTES_RECEIPT": "measured=<receipt>; bodyBytesLimit=1048576; remeasure-before-production"
  }
}
```

The public ingress also requires a Cloudflare Rate Limit binding. The example
configs use a qualification tripwire of `100` requests per `60` seconds per
edge client; the value is not a product limit and must be remeasured before
production. Create a Rate Limit namespace in the customer account, replace
the example `namespace_id`, and keep the matching
`ANYAM_GITHUB_WEBHOOK_RATE_LIMIT_RECEIPT` in the Worker variables. A missing
binding or receipt fails closed with `503`; a tripped binding returns `429` so
GitHub can redeliver after the window.

`1048576` is a qualification tripwire inherited by the example configs, not a
universal product limit. Remeasure the largest healthy delivery for the
customer's enabled events before production. If the Queue or synchronizer is
not configured, the endpoint fails closed with an actionable `503` and the
provider should retry the delivery.

Do not use a guessed URL, a public HTTP endpoint, or a qualification Worker as
the production App webhook target. The route is shipped by the Realm Worker;
the provider synchronizer remains a separate, least-privilege service binding
so GitHub credentials stay outside the Realm and Queue boundary.

The Realm-to-producer service binding uses one separate shared secret. Set the
same value as a secret on both Workers; it is only an internal service
authentication value and is never sent to GitHub:

```bash
wrangler secret put ANYAM_GITHUB_MIRROR_PRODUCER_SECRET --config <realm-wrangler-config>
wrangler secret put ANYAM_GITHUB_MIRROR_PRODUCER_SECRET --config <producer-wrangler-config>
wrangler secret put ANYAM_MIRROR_HANDOFF_SECRET --config <realm-wrangler-config>
wrangler secret put ANYAM_MIRROR_HANDOFF_SECRET --config <producer-wrangler-config>
wrangler secret put ANYAM_GITHUB_APP_PRIVATE_KEY --config <producer-wrangler-config>
```

The Realm and producer must also carry the same measured Mirror-handoff
tripwires. The checked-in Wrangler examples use a 300-second maximum lifetime
and a 30-second clock-skew allowance; remeasure both before production and
replace the values and receipts together. During key rotation, configure
`ANYAM_MIRROR_HANDOFF_PREVIOUS_KEY_ID` on the Realm and store its matching
`ANYAM_MIRROR_HANDOFF_PREVIOUS_SECRET` only for the overlap window. An unknown
key ID is rejected before the Authority transition.

The producer calls the Realm's service-only
`/internal/mirrors/producer-context` route to obtain the current Mirror
lineage. The Realm rejects missing, ambiguous, or incomplete context. The
producer then re-inspects the configured GitHub refs/commits or pull request,
creates one signed `mirror.sync` handoff, and calls the existing internal
`/internal/mirrors/ingest` route. Queue acknowledgement happens only after the
producer returns `status=succeeded`; a blocked or response-loss attempt is
retried without accepting provider state.

Required environment variables:

```text
ANYAM_GITHUB_APP_ID
ANYAM_GITHUB_APP_PRIVATE_KEY or ANYAM_GITHUB_APP_PRIVATE_KEY_FILE
ANYAM_GITHUB_APP_INSTALLATION_ID
ANYAM_GITHUB_APP_REPOSITORY=owner/name
ANYAM_GITHUB_APP_REPOSITORY_URL=https://github.com/owner/name.git (optional)
ANYAM_GITHUB_APP_WEBHOOK_SECRET
ANYAM_GITHUB_APP_QUALIFICATION_ID
ANYAM_GITHUB_APP_DISPOSABLE_REPOSITORY=owner/name
ANYAM_GITHUB_APP_JWT_LIFETIME_SECONDS
ANYAM_GITHUB_APP_JWT_SIZING_RECEIPT
ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SECONDS
ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SIZING_RECEIPT
ANYAM_GITHUB_APP_RETRY_DELAYS_MS
ANYAM_GITHUB_APP_RETRY_SIZING_RECEIPT
ANYAM_GITHUB_APP_QUEUE_MAX_PENDING
ANYAM_GITHUB_APP_QUEUE_SIZING_RECEIPT
ANYAM_GITHUB_APP_GIT_MAX_BUFFER_BYTES
ANYAM_GITHUB_APP_GIT_SIZING_RECEIPT
ANYAM_GITHUB_APP_PR_REVISION_WAIT_MS
ANYAM_GITHUB_APP_PR_REVISION_POLL_MS
```

## Customer setup checklist

1. Create a GitHub App in the customer GitHub account and install it on one
   disposable repository. Grant `Contents: write`, `Metadata: read`, and
   `Pull requests: write` for this qualification. Grant `Administration: write`
   only because the final cleanup deletes that explicitly disposable
   repository. Subscribe the App to exactly `push` and `pull_request`, and set
   the App Webhook URL to the deployed Realm `POST /webhooks/github` endpoint.
2. Generate the App's private key and keep the PEM in a local file readable
   only by the operator. Record the App ID and installation ID; do not paste
   the private key, webhook secret, or installation token into chat or commit
   them to the repository. Store the webhook secret with `wrangler secret put`
   on the customer Realm Worker.
3. Set `ANYAM_GITHUB_APP_REPOSITORY` and
   `ANYAM_GITHUB_APP_DISPOSABLE_REPOSITORY` to that same `owner/name`. The
   qualification refuses a different cleanup target.
4. Set `ANYAM_GITHUB_APP_AUTHORITY_BASE_URL` to the deployed Realm URL. The
   supported path is an owner-approved OAuth grant stored by `anyam auth login`
   in the OS keychain. Request the dedicated
   `qualification.github-app` scope with the Realm's `/mcp` resource; the
   qualifier loads or refreshes that credential in process memory and never
   writes a session file. Do not copy an HttpOnly browser cookie.
5. Run the qualification from the same terminal that contains the non-secret
   IDs, sizing receipts, and file paths. A successful receipt must show both
   provider and Authority cleanup success; otherwise the named disposable
   resources remain an operator-owned recovery task.

To extend the provider qualification into the customer-operated Authority
boundary, set the following additional inputs. The OAuth credential is loaded
from the OS keychain after the owner approves the dedicated scope.

```text
ANYAM_GITHUB_APP_AUTHORITY_BASE_URL=https://customer-realm.example
ANYAM_GITHUB_APP_MIRROR_HANDOFF_KEY_ID=customer-mirror-key-v1
ANYAM_GITHUB_APP_MIRROR_HANDOFF_SECRET_FILE=/path/to/mirror-handoff-secret.txt
```

The Authority URL must be HTTPS (loopback HTTP is allowed only for local
development). The OAuth access token is audience-bound to the Realm `/mcp`
resource and the qualification capability endpoint; it is never printed or
persisted by the qualifier.

Authenticate the operator once with the published CLI:

```bash
anyam auth login \
  --realm https://customer-realm.example \
  --client-id <registered-public-client-id> \
  --scope qualification.github-app
```

Then run the qualification with:

```text
ANYAM_GITHUB_APP_AUTHORITY_BASE_URL=https://customer-realm.example
```

The qualifier reads the matching Realm record from the OS keychain and
refreshes it through `/oauth/token` when its access token is near expiry. For
an explicitly bounded one-off process-memory run, set
`ANYAM_GITHUB_APP_AUTHORITY_OAUTH_TOKEN` instead; it is never printed or
stored. `ANYAM_GITHUB_APP_AUTHORITY_OAUTH_CLIENT_ID` is optional and only
checks that a keychain record belongs to the expected client.

The old `ANYAM_GITHUB_APP_AUTHORITY_OWNER_SESSION` and
`ANYAM_GITHUB_APP_AUTHORITY_OWNER_SESSION_FILE` inputs remain temporary
compatibility inputs for an already-issued opaque session. They do not mint
credentials and should not be used for new qualifications.

The handoff key ID and secret must match the Realm's
`ANYAM_MIRROR_HANDOFF_KEY_ID` and `ANYAM_MIRROR_HANDOFF_SECRET` configuration.
Use either `ANYAM_GITHUB_APP_MIRROR_HANDOFF_SECRET` or
`ANYAM_GITHUB_APP_MIRROR_HANDOFF_SECRET_FILE`, never both. The producer keeps
the secret in process memory only, signs one exact `anyam.mirror-ingestion/v2`
envelope, and the Realm's `/internal/mirrors/ingest` route verifies and consumes
it. The envelope binds the current Realm, provider installation, audience,
issuer, provider repository, Mirror, delivery, proposal, issued/expiry window,
nonce, and typed command. The secret is never sent to GitHub, persisted in
Authority, or included in a receipt.

For compatibility only, an already-issued opaque session may be supplied with
exactly one of `ANYAM_GITHUB_APP_AUTHORITY_OWNER_SESSION` or
`ANYAM_GITHUB_APP_AUTHORITY_OWNER_SESSION_FILE`. These inputs do not mint a
credential. Do not copy an HttpOnly browser cookie. The Realm must be an empty,
disposable Authority boundary: the qualification exports its signed,
credential-free `anyam.authority-recovery/v1` bundle, creates one Project,
public Source Space, public Project View, and empty mapped Mirror from the
actual seeded Git OID, then restores that bundle after provider cleanup and
compares the snapshot digest. Restore is stale/replay checked and enters an
explicit quarantine; normal Authority mutation remains blocked until the
owner completes the separate passkey-authenticated
`/api/authority/recovery/activate` ceremony. This recovery boundary does not
revoke or restore identity, passkeys, owner sessions, or OAuth grants. A
non-empty Authority Realm is rejected before mutation.

The qualification records outbound projection, a live provider ref update
re-inspected by the `GitHubMirrorProducer`, an exact signed handoff accepted by
the Realm's internal Mirror-ingestion route, explicit force-push failure,
canonical-wins reconciliation, one stable pull-request Change with successive
Revisions, duplicate delivery, and a credential-free Mirror read-back digest.
It never exports or prints credentials.

The private key, webhook secret, installation tokens, App JWT, and provider
responses containing credentials are never printed or persisted by the
adapter. The delivery ledger supplied by the Realm boundary is mandatory; it
persists the complete delivery task before queueing so a process restart can
replay a hint recorded before the in-memory queue append. The qualification
script uses a process-local ledger only as an adapter seam test; it is not a
durable Realm receipt.

The command exercises:

- selected-installation JIT credentials and Git Smart HTTP projection;
- inbound ref observation through the provider-neutral Mirror coordinator;
- provider reinspection, signed Mirror handoff, internal Realm ingestion, and
  redelivery deduplication;
- signed, action-filtered webhook hints and persisted deduplication;
- explicit force-push blocking and `canonical-wins` reconciliation;
- credential expiry followed by fresh-credential resume;
- PR observation and metadata-minimal external proposal identity;
- a local Git bundle export/restore digest check; and
- exact disposable-repository cleanup.

The qualification creates the disposable PR through the installed App after
the initial mapped branch projection, then pushes a second head revision and
observes the provider's updated PR state during the measured wait window. It
does not require a pre-existing PR or human timing. The adapter still observes
the PR; it does not itself write Anyam's Change/Revision ledger. The enclosing
qualification command writes the observed provider events through the
customer-operated Authority boundary and restores its credential-free Authority
Plane snapshot after cleanup. For the live Authority path, the producer obtains
the selected installation credential just in time, re-inspects the provider
commit/tree/ancestry, signs the exact credential-free command envelope, and
sends it to the internal Realm route. The Realm verifies the handoff and writes
the Mirror operation, external proposal, stable Change, and Change Revision.
These are deliberate qualification boundaries, not hidden claims.

The live qualification currently exercises the producer in the qualification
process. A deployed App webhook adds one more boundary: GitHub signs and sends
the raw delivery to `/webhooks/github`; the Realm authenticates and queues the
hint; and the bound synchronizer performs the provider reinspection. A green
provider-only or synthetic-producer receipt does not prove live webhook
delivery. Record the webhook delivery ID, Queue receipt, reinspection receipt,
signed handoff receipt, duplicate redelivery result, and exact disposable
cleanup before calling that boundary qualified.

The repository is the explicitly disposable selected repository. The script
creates only its disposable Authority state inside the empty customer Realm;
it does not create an unowned GitHub repository. On
setup or adapter-authentication failure, it makes a separate cleanup attempt
for the exact named repository when the App credential can be constructed; if
credential construction itself fails, the result is an explicit blocked
cleanup receipt rather than a false success. No PAT or Realm credential may be
substituted.

A green command receipt with the Authority inputs proves the selected GitHub
App, qualification repository adapter, and the exercised customer Realm /
Authority boundary only. Without those inputs, a provider-only receipt proves
only the selected GitHub App and qualification repository adapter boundary. It
does not claim GitHub Enterprise support, general repository mirroring, or
production readiness. #321 remains open until the owner captures a live producer
receipt; the supported OAuth/capability exchange is provided by #330. #193
(the adapter implementation ticket) is closed.
