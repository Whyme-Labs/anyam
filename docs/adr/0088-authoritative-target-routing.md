# Authoritative Target routing

Status: Accepted

Issue: [#255](https://github.com/Whyme-Labs/anyam/issues/255)

## Context

The Promotion executor previously carried one account, Worker script, preview
hostname, and provider credential broker at process configuration scope. That
made a single executor instance unable to serve multiple isolated Targets and
made it too easy for a caller-supplied Target to be confused with provider
configuration.

## Decision

The executor owns an authoritative route registry keyed by Anyam `Target.id`.
Each route contains the provider account, Worker script, preview/health
configuration, credential broker, and optional Release Manifest builder. A
Promotion context supplies only the Target identity; the executor resolves the
route and rejects missing, duplicate, or mismatched Target routes before any
provider call.

The legacy single-route fields remain a compatibility constructor that is
normalized into a one-entry registry. They are not accepted from the signed
Promotion context and cannot select an account, script, or credential.

## Consequences

- Two Targets can use separate provider configuration and credentials through
  one service binding.
- Cross-Target execution fails before provider invocation.
- Route registration is the trust boundary for account/script/credential
  identity; caller payloads remain semantic Anyam state only.
- A future customer-operated installation can load the registry from its own
  encrypted Target configuration without changing the Promotion protocol.

## Rejected alternatives

- **One Worker service binding per Realm with caller-selected account/script:**
  widens the provider authority and makes Target substitution possible.
- **One statically configured executor forever:**
  cannot represent staging, preview, and production Targets together.
- **Provider identifiers in the Promotion context:**
  turns signed business state into caller-controlled provider routing.

