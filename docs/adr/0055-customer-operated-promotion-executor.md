# ADR 0055: Customer-operated Promotion executor service

## Status

Accepted for the private-alpha delivery plane.

## Context

The Realm Authority owns Promotion intent and the Anyam Target pointer, but it
must not own provider credentials or provider adapter authority. The Worker
Target qualification proved the preview, apply, release-bound health, and
verified rollback mechanics for a Cloudflare Worker. The missing boundary was
the deployable customer-operated service that can run those mechanics after an
Authority handoff.

## Decision

Bind `ANYAM_PROMOTION_EXECUTOR` to a customer-operated Promotion executor
Worker. The Realm sends only `anyam.promotion-execution/v1` context over the
internal service binding. The executor:

1. accepts only the exact protocol and typed context;
2. rejects caller-supplied credential-shaped fields, unknown adapter IDs,
   mismatched Target IDs, unsupported Artifact types, and incomplete rollback
   lineage before provider invocation;
3. selects the configured customer-owned `cloudflare.worker` Target adapter;
4. reads digest-addressed Worker Artifacts from the customer-owned R2 binding;
5. obtains Cloudflare credentials only through an in-process customer broker
   backed by the executor Worker's secret, never through Authority or a result;
6. invokes the qualified `CloudflareWorkerTargetAdapter` and
   `WorkerPromotionCoordinator` with immutable Release, Artifact, Evidence,
   and previous-Release inputs;
7. returns provider operation identities, release-bound health/rollback
   receipts, and a credential-free typed result;
8. leaves Target pointer mutation and audit persistence to Authority after its
   result validator accepts the exact execution digest.

The default qualification command is:

```sh
npm run qualification:promotion-executor
```

It qualifies the same Worker boundary locally with a bounded provider fixture
and explicitly reports `liveProvider=not-performed`. A customer deployment can
be qualified against the same `/execute` route by setting
`ANYAM_PROMOTION_EXECUTOR_URL` and an exported, credential-free
`ANYAM_PROMOTION_EXECUTOR_CONTEXT_FILE`.

## Consequences

- The Realm can remain credential-free and does not need Cloudflare API tokens.
- A customer can deploy one executor per Target or route service bindings to a
  customer-owned executor fleet without changing Authority contracts.
- Artifact bytes must be published to the executor's digest-addressed R2 store
  before Promotion execution; recording an Artifact without storage remains a
  blocked operation.
- Provider credential lifetime is an explicit customer configuration receipt,
  not an Anyam-wide limit. It must be a future ISO timestamp and be remeasured
  before production.
- Durable reconciliation, late-callback rejection, and operator status are
  defined in ADR 0056 / #179. This boundary returns safe checkpoints but does
  not pretend to own provider mechanics or credential material.

## Rejected alternatives

- Giving the Realm Worker a Cloudflare API token: violates the provider
  authority boundary and makes every Realm edge a deployment principal.
- Passing credentials in the Authority context: creates credential material in
  serialized state and audit paths.
- Treating the existing qualification Worker as the executor: it is a fixture
  operation surface, not a customer-configured provider adapter.
- Rebuilding the Worker Target adapter inside the Realm: duplicates qualified
  provider mechanics and makes credential handling ambiguous.
