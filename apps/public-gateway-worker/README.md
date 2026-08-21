# Anyam public gateway Worker

This package is the customer-operated Cloudflare adapter for the P3 public
contribution boundary. It is deliberately narrower than a complete Git forge:

- public Git Smart HTTP read is proxied only for one configured public Source
  Space;
- `git-receive-pack` is rejected, so anonymous clients never get canonical write
  authority;
- contribution envelopes are serialized by a SQLite-backed Durable Object;
- idempotency, replay rejection, provider-timeout recovery, suspension, reopen,
  and cleanup are recorded in the customer Realm;
- the Cloudflare Worker Rate Limiting binding is an outer coarse abuse tripwire;
  the Durable Object ledger remains authoritative for logical intake decisions.
- optional Turnstile server-side validation is a fail-closed, result-only
  contribution gate; it never grants canonical write or private Source Space
  access and never places the provider secret in a response or ledger record.

Public Git is routed through the shared `anyam.smart-http/v1` transport. The
worker does not maintain a second provider `fetch` path: request and response
bodies are counted as they stream, the duration deadline remains active until
the response body closes, and the concurrency slot is released exactly once
on close, cancellation, or error. Configure the four public-Git limits with a
single workload measurement receipt:

```text
PUBLIC_GIT_REQUEST_BYTES_LIMIT
PUBLIC_GIT_RESPONSE_BYTES_LIMIT
PUBLIC_GIT_DURATION_MS_LIMIT
PUBLIC_GIT_CONCURRENCY_LIMIT
PUBLIC_GIT_BUDGET_RECEIPT
```

If any value or receipt is missing, public Git remains closed with a receipt
that names the missing budget and ask. The concurrency tracker is an
isolate-local tripwire; a durable cross-isolate coordinator is not claimed by
this adapter and must be qualified separately before it is used as a global
quota.

For a deployed public gateway, bind `PUBLIC_GIT_BUDGET_COORDINATOR` to the
customer-owned `PublicGitBudgetCoordinatorDO`. Public Git fails closed when
that binding is absent. The Durable Object leases one operation per stream,
expires abandoned leases using the measured duration budget, and releases the
lease when the shared transport observes close, cancellation, or error.

The example config intentionally contains placeholders. Replace them with
customer-owned values and a measured receipt before deploying. Do not add a
provider token to the config or expose the upstream Git URL in responses.

The public gateway is closed until an owner uses the authenticated admin route
to open it. A missing measured logical limit fails closed; `approval-only` mode
is available when no honest quota exists yet.

Moderation is authorized by the bound Realm service, not by a static
administrator token. Admin requests carry a short-lived Realm session handle
in `x-anyam-realm-session`; the gateway asks the Realm to validate the owner or
moderator relationship for the exact Project and operation, then forwards only
the Realm-authorized Actor and role to the Durable Object. The service-binding
secret authenticates the Worker-to-Worker call but never grants moderation by
itself. Caller-provided actor or role fields are ignored.

Configure `PUBLIC_GATEWAY_REALM_AUTHORITY` as a service binding to the
customer-owned Realm Worker and set `PUBLIC_GATEWAY_REALM_SERVICE_SECRET` with
`wrangler secret put`. Without both bindings, moderation remains blocked.

Set `PUBLIC_ABUSE_MODE=turnstile-required` only after measuring a provider
timeout tripwire and storing the Turnstile secret as a customer-owned secret
binding. The contribution JSON must then include `turnstileToken`; missing,
expired, replayed, mismatched, malformed, or provider-unavailable validation is
rejected or challenged without materialization. Public Git clone/fetch remains
independent of this contribution gate.

## Ledger recovery and compaction

The Durable Object keeps accepted and pending lineage, exact replay tombstones,
and moderation/recovery events. It does not silently delete request identities.
Before any compaction, an owner must create a durable export and then submit a
receipt-backed retention policy:

```text
POST /admin/ledger/export
POST /admin/ledger/compact
```

The retention policy must measure and name every boundary: detailed request
records, exact replay tombstones, audit events, retryable-denial age,
terminal-denial age, retryable replay window, and terminal-denial replay
window. Accepted and pending records are never eligible for compaction. Denied
records may become compact replay tombstones only after the export is persisted
and the measured age boundary is reached. The replay-defense clock starts when
the exact tombstone is materialized, so local retention cannot silently consume
the provider protection window. If a healthy lineage or exact replay index
would exceed its tripwire, compaction fails with the budget name, limit, ask,
receipt, and recovery action; intake is not made lossy to satisfy a limit.

The export is stored in the customer-owned Durable Object and is verified by a
content digest before compaction. A restarted coordinator can load the export,
retain accepted contribution IDs, and reject both same-payload idempotency
replays and changed-payload request-ID replays after compaction.

## Exact replay archive after the local tripwire

For a high-volume Project, bind the optional customer-owned R2 bucket
`PUBLIC_GATEWAY_REPLAY_ARCHIVE`. When the measured local tombstone tripwire
would be exceeded, the coordinator writes one immutable exact replay object per
request before clearing those local tombstones. The archive object is addressed
by the Project and request identity, read back, and content-digest verified.
The coordinator remains authoritative for accepted lineage and never treats an
archive object as Landing or Change authority.

After restart, archived request identities are checked before any new intake is
accepted. An archive read or write failure is fail-closed and names the
recovery action; an already-written immutable object can be retried safely.
The archive's `bytes` receipt is the measured serialized object representation,
not a claim about R2 billing or a universal provider quota. Provider usage,
latency, and cost must be remeasured for each customer workload before setting
the archive tripwire.

## Owner-authorized replay archive deletion

Replay archive cleanup is a separate destructive maintenance operation, not a
provider lifecycle side effect:

```text
POST /admin/ledger/replay-archive/delete-expired
```

It requires the latest digest-verified coordinator export, an owner-authorized
maintenance receipt, and an explicit `legalHold=clear` receipt. Only
terminal-denial objects with `retryable=false` and an expired
`replayDefenseUntil` are eligible. Retryable objects and legacy objects
without a measured expiry are protected; accepted/pending lineage, audit, and
recovery state are never in the deletion scope. Each provider deletion is
digest-checked and reports `deleted` or idempotent `already-absent`. A
provider or integrity failure stops the operation and names the recovery
action.

The operation records the export digest, requested/deleted/already-absent
counts, protected-object counts, owner/hold receipts, and a Recovery
Checkpoint in the Durable Object ledger. This is a customer policy boundary,
not a universal retention duration or legal-hold implementation.
