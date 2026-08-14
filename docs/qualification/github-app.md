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

## Customer setup checklist

1. Create a GitHub App in the customer GitHub account and install it on one
   disposable repository. Grant `Contents: write`, `Metadata: read`, and
   `Pull requests: write` for this qualification. Grant `Administration: write`
   only because the final cleanup deletes that explicitly disposable
   repository. Subscribe the App to exactly `push` and `pull_request`.
2. Generate the App's private key and keep the PEM in a local file readable
   only by the operator. Record the App ID and installation ID; do not paste
   the private key, webhook secret, or installation token into chat or commit
   them to the repository.
3. Set `ANYAM_GITHUB_APP_REPOSITORY` and
   `ANYAM_GITHUB_APP_DISPOSABLE_REPOSITORY` to that same `owner/name`. The
   qualification refuses a different cleanup target.
4. Open the deployed customer Realm's `/owner/login`, authenticate with the
   enrolled passkey, and place only the opaque `anyam_owner_session` value in
   a local owner-session file. Do not copy the `Cookie:` header or any other
   browser data. Set `ANYAM_GITHUB_APP_AUTHORITY_BASE_URL` to the deployed
   Realm URL and point `ANYAM_GITHUB_APP_AUTHORITY_OWNER_SESSION_FILE` at that
   file.
5. Run the qualification from the same terminal that contains the non-secret
   IDs, sizing receipts, and file paths. A successful receipt must show both
   provider and Authority cleanup success; otherwise the named disposable
   resources remain an operator-owned recovery task.

To extend the provider qualification into the customer-operated Authority
boundary, set the following additional inputs. The owner session may be
provided directly for a one-off run or through a file so it is not placed in
shell history; it is sent only as the host cookie to the configured Realm and
is never printed.

```text
ANYAM_GITHUB_APP_AUTHORITY_BASE_URL=https://customer-realm.example
ANYAM_GITHUB_APP_AUTHORITY_OWNER_SESSION_FILE=/path/to/owner-session.txt
```

The Authority URL must be HTTPS (loopback HTTP is allowed only for local
development), and the owner session file should contain only the opaque
session value with no cookie header or other credentials.

Use exactly one of `ANYAM_GITHUB_APP_AUTHORITY_OWNER_SESSION` or
`ANYAM_GITHUB_APP_AUTHORITY_OWNER_SESSION_FILE`. The Realm must be an empty,
disposable Authority boundary: the qualification exports its credential-free
Authority Plane snapshot, creates one Project, public Source Space, public
Project View, and empty mapped Mirror from the actual seeded Git OID, then
restores that Authority snapshot after provider cleanup, then exports it again
and compares the snapshot digest. The Authority recovery endpoint replaces only
the Authority Plane state; it does not revoke or restore
identity, passkeys, owner sessions, or OAuth grants. This removes a hidden
pre-seeding dependency and makes the cleanup boundary explicit. A non-empty
Authority Realm is rejected before mutation.

The qualification records outbound projection, inbound ref proposal, explicit
force-push failure, canonical-wins reconciliation, one stable pull-request
Change with successive Revisions, duplicate delivery, and a credential-free
Mirror read-back digest. It never exports or prints credentials.

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
the PR; it does not itself write Anyam's Change/Revision ledger. The enclosing
qualification command writes the observed provider events through the
customer-operated Authority boundary and restores its credential-free Authority
Plane snapshot after cleanup. These are deliberate qualification boundaries, not
hidden claims.

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
production readiness. #193 remains open until the live customer-operated
Realm receipt is captured.
