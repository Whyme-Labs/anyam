# ADR 0097: Deployed multi-Target route registry

Status: Accepted

Issue: [#255](https://github.com/Whyme-Labs/anyam/issues/255)

## Context

The core Promotion executor has an authoritative route registry, but the
deployed Worker example still constructed one route from process-wide
environment variables. That made the documented `staging -> production`
topology impossible without deploying another executor and service binding.

Provider credentials must remain customer-owned secrets. A route registry must
therefore describe where a credential is bound, not contain the credential
value.

## Decision

The customer-operated Promotion executor accepts `ANYAM_PROMOTION_TARGET_ROUTES`
as a non-secret JSON array. Each route names:

```text
Target ID
Cloudflare account ID
Worker script name
Workers.dev preview subdomain
optional health URL
secret binding name
declared provider scopes
optional credential source label
```

The secret binding must match
`ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN_*`. The Worker resolves that binding at
credential-observation time through the customer environment. The signed
Promotion context still contains only semantic Anyam state and the Target ID;
it cannot select an account, script, or secret.

Legacy single-Target variables remain a compatibility constructor. They cannot
be combined with the route registry, so an installation cannot silently have
two competing routing authorities.

## Consequences

- One customer-owned executor can serve isolated staging and production
  Targets with separate provider credentials.
- Route configuration is inspectable and exportable without exposing secrets.
- Missing secret bindings fail closed before provider invocation.
- The route registry does not claim that all Targets share one provider
  account or one Worker; each route remains independently scoped.
- A future encrypted Target configuration store can replace the JSON source
  without changing the Promotion protocol.

## Operator setup

Set the route JSON as a Wrangler variable, then bind one secret per route:

```sh
wrangler secret put ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN_STAGING
wrangler secret put ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN_PRODUCTION
```

The values are never placed in `ANYAM_PROMOTION_TARGET_ROUTES`, receipts, or
Authority state.
