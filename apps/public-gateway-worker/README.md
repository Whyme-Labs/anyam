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

The example config intentionally contains placeholders. Replace them with
customer-owned values and a measured receipt before deploying. Do not add a
provider token to the config or expose the upstream Git URL in responses.

The public gateway is closed until an owner uses the authenticated admin route
to open it. A missing measured logical limit fails closed; `approval-only` mode
is available when no honest quota exists yet.

The example `ADMIN_TOKEN` is an owner-only qualification secret. The Worker
does not trust caller-provided actor or role fields. A production Realm should
replace this adapter boundary with the Realm's authenticated capability check
before delegating moderator roles or broader administration.

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
records, exact replay tombstones, audit events, retryable-denial age, and
terminal-denial age. Accepted and pending records are never eligible for
compaction. Denied records may become compact replay tombstones only after the
export is persisted and the measured age boundary is reached. If a healthy
lineage or exact replay index would exceed its tripwire, compaction fails with
the budget name, limit, ask, receipt, and recovery action; intake is not made
lossy to satisfy a limit.

The export is stored in the customer-owned Durable Object and is verified by a
content digest before compaction. A restarted coordinator can load the export,
retain accepted contribution IDs, and reject both same-payload idempotency
replays and changed-payload request-ID replays after compaction.
