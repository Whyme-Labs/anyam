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
the PR; it does not itself write Anyam's Change/Revision ledger. Project/
Authority export and restore are also outside this provider adapter command.
These are deliberate qualification boundaries, not hidden claims.

The repository must already exist and be bound to the customer Realm/Source
Space qualification. The script does not create an unowned repository. On
setup or adapter-authentication failure, it makes a separate cleanup attempt
for the exact named repository when the App credential can be constructed; if
credential construction itself fails, the result is an explicit blocked
cleanup receipt rather than a false success. No PAT or Realm credential may be
substituted.

A green command receipt therefore proves only the selected GitHub App and
qualification repository adapter boundary. It does not claim the customer
Realm/Authority vertical slice, GitHub Enterprise support, general repository
mirroring, or production readiness. #193 remains open until that live
customer-operated Realm receipt is captured.
