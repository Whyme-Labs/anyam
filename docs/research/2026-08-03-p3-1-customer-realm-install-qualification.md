# P3-1 customer-operated Realm installation and owner claim qualification

Date: 2026-08-03
Issue: [Qualify a new customer-operated Realm installation and claim](https://github.com/wms2537/anyam/issues/81)
Status: provider binding/deployment boundary passed; end-to-end installer and live owner-claim path blocked

## Question

Can a new customer install Anyam into a customer-owned Cloudflare account,
prove ownership, bind the Realm resources, claim the installation with an
owner identity, and recover it from a customer-owned export without Anyam
storing provider credentials?

## Account and provider receipt

The qualification used the refreshed Wrangler OAuth session and selected the
customer account with `CLOUDFLARE_ACCOUNT_ID`:

```text
accountId=1e0170aaabc90ecf5f466128d1f0466a
owner=swmengappdev@gmail.com
credentialsStoredByAnyam=false
```

This was a disposable resource set in the customer-owned account, not a new
Cloudflare account. The exact resource creation receipts were:

| Resource | Receipt |
| --- | --- |
| D1 | `anyam-p3-install-20260803-metadata`; UUID `f35a9205-a929-404f-b4de-39c17ff4eefb`; created `2026-08-03T07:39:16.276Z`; region APAC |
| R2 | `anyam-p3-install-20260803-exports`; created `2026-08-03T07:39:22.109Z` |
| R2 preview | `anyam-p3-install-20260803-exports-preview`; created `2026-08-03T07:39:27.098Z` |
| Queue | `anyam-p3-install-20260803-events`; ID `870814c7345d492d8e2701f675b9c6fe`; created `2026-08-03T07:39:31.978338Z` |

## Customer-owned Worker deployment

The Worker was deployed from a customer-specific binding configuration using
Wrangler 4.118.0:

```text
worker=anyam-p3-install-20260803
url=https://anyam-p3-install-20260803.swmengappdev.workers.dev
version=91917469-8e0e-45b8-bfcb-60403e5a1a9f
workflow=anyam-p3-install-workflow-20260803
buildRevision=issue-81-install-qualification
```

The final dry-run reported a 5.22 KiB upload (1.72 KiB gzip) and all five
customer-owned bindings: SQLite Durable Object, D1, R2, Queue, and Workflow.

The first request immediately after deploy returned Cloudflare error `1042`.
After propagation, five consecutive health requests returned HTTP 200. This
is a provider propagation observation, not a Worker authority result; the
installer must expose it as a retryable readiness state rather than treating
the first deploy response as ready.

Stable health receipt:

```text
protocol=anyam.customer-realm-worker/v1
status=ready
authority=customer-owned
hostingMode=customer-operated
installationId=installation:p3:20260803
configuredBindings=REALM_COORDINATOR,ANYAM_METADATA_DB,ANYAM_EXPORTS,ANYAM_EVENTS,ANYAM_WORKFLOW
missingBindings=
credentialFree=true
```

The well-known surface returned the same receipt. A POST to `/api/install`
returned HTTP 405 with `method_not_allowed`; no public mutation route exists.

## Local installation, owner, and recovery receipt

The existing framework-neutral `CustomerRealmInstallation` kernel was run
against the real deployed resource receipt:

```text
protocol=anyam.customer-realm-install-qualification/v1
status=passed
installation=installation:p3:20260803
installPhase=realm-ready
installCheckpoint=sha256:b4da6e98547b8b228a6809d7a609d1164e643568dd64c2c89546ab034e8ea205
accountOwnership=customer
credentialsStored=false
resources=6
ownerPhase=owner-ready
ownerPrincipal=principal:p3-qualification-owner
passkeyVerified=true (local adapter fixture)
recoveryEnrolled=true
materialStoredInInstallation=false
persistedReopen=owner-ready; sameInstallation=true
recoveryBundle=sha256:d41f76672ea94b1a5949d1d80a8a24f044c788911b67129a7c11221840c1108c
recoveryVerification=verified
recoveryCredentialFree=true
restorePhase=recovery-pending
credentialsRestored=false
ownerActivationRequired=true
activationPhase=owner-ready
resourcesReconciled=true
```

This proves the state-machine contract: explicit customer ownership, owner
claim metadata, credential-free export, quarantined restore, fresh owner
activation, and provider-resource reconciliation.

## Qualification boundary and follow-up

The requested end-to-end customer journey is **not yet qualified**:

- The shipped Worker deliberately exposes only health and bootstrap metadata;
  it has no install, account-inspection, provisioning, or owner-claim route.
- Resource creation was performed by customer-authenticated Wrangler, not by
  an Anyam customer-operated installer or provider adapter.
- `passkeyVerified=true` was a local kernel fixture. No live WebAuthn/OIDC
  owner enrollment was exercised.
- The account was customer-owned but not a newly created Cloudflare account.
- Project import was intentionally not part of this ticket.

The missing product path is tracked in [Implement the customer-operated install
and owner-claim control path](https://github.com/wms2537/anyam/issues/88).

## Teardown

The disposable Worker, Workflow, D1 database, R2 buckets, and Queue must be
deleted after the receipt is retained. The exact deletion commands and
post-delete empty listings are:

```text
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler delete anyam-p3-install-20260803
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler workflows delete anyam-p3-install-workflow-20260803
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler queues delete anyam-p3-install-20260803-events
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler d1 delete anyam-p3-install-20260803-metadata --skip-confirmation
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler r2 bucket delete anyam-p3-install-20260803-exports
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler r2 bucket delete anyam-p3-install-20260803-exports-preview
```

The deletion commands succeeded. Follow-up `wrangler d1 list --json`, `r2
bucket list`, and `queues list` queries returned no matching
`anyam-p3-install-20260803` resources. A request to the deleted Worker URL
returned HTTP 404 (`error code: 1042`).
