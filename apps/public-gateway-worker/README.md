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
