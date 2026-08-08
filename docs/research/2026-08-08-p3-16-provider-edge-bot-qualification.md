# P3-16 provider-specific Public Gateway bot and edge qualification

Date: 2026-08-08  
Issue: [Qualify provider-specific public Gateway bot and edge controls](https://github.com/wms2537/anyam/issues/109)  
Protocol: `anyam.public-gateway-abuse/v1`  
Status: passed with bounded provider residuals

## Question

Can a customer-owned Public Git Gateway add provider-specific edge/bot
controls while keeping the Durable Object Public Intake ledger authoritative,
keeping provider errors disclosure-safe, and preserving the invariant that no
anonymous caller can write canonical or private source?

## Implementation receipt

The reusable boundary is implemented in:

- `src/cloudflare/public-gateway-abuse.ts` — provider-neutral result-only
  contract, disabled edge-only provider, and server-side Turnstile adapter;
- `src/cloudflare/public-gateway.ts` — provider outcome parsing, fail-closed
  malformed-provider handling, and authoritative abuse denial ledgering;
- `apps/public-gateway-worker/src/index.ts` — customer-owned Worker wiring,
  secret binding, timeout receipt, disclosure-safe HTTP mapping, and no-token
  payload digest;
- `apps/public-gateway-worker/wrangler.example.jsonc` — non-production binding
  shape;
- `test/public-gateway-abuse.test.ts` — deterministic Turnstile success,
  rejection, mismatch, HTTP failure, timeout, token-size, and disclosure tests;
- `test/public-gateway.test.ts` — coordinator retry/ledger behavior and
  malformed-provider fail-closed parsing.

The adapter never persists or returns the Turnstile token, provider secret, raw
provider error code, private Source Space identifier, or provider URL. The
Durable Object receives only a result-only provider outcome.

## Static provider receipts

The official Cloudflare contracts reviewed for this qualification state that:

- Turnstile tokens must be validated server-side, are single-use, and expire
  after the documented short lifetime. The documented maximum token length is
  2048 characters.
- Workers Rate Limit bindings are coarse and eventually consistent; they are
  not an exact accounting ledger.
- WAF rate-limiting rules have provider-specific counter scope, period, action,
  and overload/fail-open behavior.
- Bot Management bot scores are plan-dependent and are exposed only where the
  customer's Bot Management capability provides them.

Official references:

- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Turnstile testing](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
- [Workers Rate Limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [WAF rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [WAF request rate characteristics](https://developers.cloudflare.com/waf/rate-limiting-rules/request-rate/)
- [WAF troubleshooting and fail-open behavior](https://developers.cloudflare.com/waf/rate-limiting-rules/troubleshooting/)
- [Bot score](https://developers.cloudflare.com/bots/concepts/bot-score/)
- [Bot Management variables](https://developers.cloudflare.com/bots/reference/bot-management-variables/)

### Turnstile timeout receipt

The local preflight used five requests to the documented Siteverify endpoint:

```text
sample=1 0.230841s  HTTP 200
sample=2 0.068194s  HTTP 200
sample=3 0.063395s  HTTP 200
sample=4 0.057149s  HTTP 200
sample=5 0.246690s  HTTP 200
maximum=0.246690s
configured timeout=5000ms
receipt=receipt:turnstile-siteverify-five-sample-max-0.247s-configured-5s-20260808
```

This is a local preflight receipt, not a provider SLA and not a substitute for
the Worker-origin live result below.

## Disposable customer-owned fixture

```text
Cloudflare account: 1e0170aaabc90ecf5f466128d1f0466a
Upstream fixture: https://github.com/wms2537/anyam-p3-public-gateway-bot-20260808
Fixture commit: a4bd9c626f2f029b8429d3181fef3ea022ab89a7
Fixture archive digest: sha256:320efa394e2ef78db0828116e204b058bdc91f1e91d7b5b927f4725ac6429e84
Final Worker: anyam-p3-public-gateway-bot-final4-20260808
Final Worker version: 9dc96530-2c5e-4e70-8968-46a0bd0699ac
Final Worker URL: customer-owned URL recorded in the live operator log;
                  not included in public Gateway responses
```

The fixture repository contained only a public README and no hosted Anyam
dependency. The disposable provider repository, Worker, bindings, and secret
values are not part of this repository or this receipt. Teardown is required
before closing the ticket; no production credential or private Source Space
was used.

## Live Worker-origin receipt

The final Worker was configured with:

```text
PUBLIC_ABUSE_MODE=turnstile-required
provider=cloudflare-turnstile
timeoutMs=5000
timeoutReceipt=receipt:turnstile-siteverify-five-sample-max-0.247s-configured-5s-20260808
failOpen=false
edgeLimit=100 public-gateway-edge-requests
edgeReceipt=receipt:p3-16-edge-tripwire-20260808
logicalLimit=8 public-contribution-requests
logicalReceipt=receipt:p3-16-logical-tripwire-20260808
```

Owner opening was authenticated with the customer-owned qualification secret:

```text
open=200
receipt=p3-16-final4-open-20260808
status=open
```

Using Cloudflare's documented Turnstile test path, a Worker-origin validation
success reached the Siteverify endpoint and then the authoritative ledger:

```text
request=request:valid-probe
http=200
abuse.outcome=allowed
abuse.reason=validated
abuse.materialized=false
providerUrl=not-disclosed
decision.status=accepted
decision.disposition=quarantined
landingAuthority=false
accepted=1
preservedContributionIds=contribution:valid-probe
```

A missing token took the fail-closed challenge path:

```text
request=request:missing-probe
http=403
abuse.outcome=challenge
abuse.reason=token-missing
abuse.retryable=true
abuse.materialized=false
decision.status=denied
decision.disposition=not-materialized
accepted=1
denied=1
recoveryCheckpoint=checkpoint:public-gateway:abuse:challenge:2
```

The token was not included in the payload digest, response, or ledger receipt.
The challenge recovery action requires a fresh token; the adapter makes no
same-token retry claim because the provider may have consumed a token before a
timeout or response loss.

## WAF and Bot Management residual

The customer can add WAF rate-limiting rules or Bot Management rules in front
of the Worker, but this qualification does not claim an exact universal WAF
quota or universal Bot Management availability. Provider counters, periods,
plans, data-center scope, and overload behavior must be measured for the
customer's traffic shape. The Anyam edge result remains advisory and the
Durable Object remains authoritative.

The exact residual is:

> A customer that needs a WAF-specific block/challenge receipt or a
> Bot-Management-score policy must run a separate plan- and rule-specific
> qualification. The current Anyam adapter is not a substitute for that
> provider receipt and does not make a public-beta readiness claim on its
> behalf.

## Security and recovery exit evidence

- No canonical write route was exposed; `git-receive-pack` remains rejected.
- No private Source Space was read, materialized, or named in public responses.
- No provider secret, token, raw provider error, or provider URL was returned
  or stored in the ledger.
- Provider success is result-only and still produces a quarantined request.
- Provider challenge/unavailable results are recorded as retryable or
  fail-closed denials with recovery checkpoints.
- Malformed provider payloads fail closed rather than being silently treated as
  an allowed request.
- The edge Rate Limit binding remains non-authoritative; no 429/burst result is
  promoted to a universal quota.

## Exit decision

The provider-specific abuse boundary is qualified for a bounded P3 route:
Turnstile server validation can allow a result-only contribution path on a
customer-owned Worker, missing-token and provider-failure paths do not
materialize contributions, and the authoritative Durable Object ledger
preserves request identity and recovery.

This receipt does **not** claim universal WAF enforcement, universal Bot
Management coverage, an exact Cloudflare Rate Limiting quota, or anonymous
public-intake readiness for every customer. The next frontier is bounded
ledger retention and recovery export.

