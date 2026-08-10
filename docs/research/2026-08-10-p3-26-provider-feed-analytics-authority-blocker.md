# Provider-feed analytics authority blocker

**Issue:** [Qualify live provider-feed reconciliation and per-surface reliability](https://github.com/wms2537/anyam/issues/127)  
**Protocol:** `anyam.p3-26-provider-feed-analytics-authority/v1`  
**Status:** blocked before live feed reconciliation  
**Observed:** 2026-08-10

## Decision boundary

The disposable customer-provider cohort is owner-authorized and remains live, but the current command-line credential cannot read the provider analytics feeds required by the #127 receipt. This is a credential-bound observation blocker. It is not evidence of provider outage, Anyam unreliability, a quota, an SLO, a cost, or universal provider support.

## Named qualification scope

| Field | Value |
|---|---|
| Cloudflare account | `swmengappdev` (`1e0170aaabc90ec9a295faad8e519458`) |
| Live Worker | `anyam-p3-24-live-20260810` |
| Target Worker | `anyam-p3-24-target-20260810` |
| D1 database | `anyam-p3-24-live-20260810-metadata` (`19ebda9a-ed35-4009-877b-198d84e08f99`) |
| R2 bucket | `anyam-p3-24-live-20260810-exports` |
| Queue | `anyam-p3-24-live-20260810-events` |
| Workflow | `anyam-p3-24-live-20260810-workflow` |
| Build revision | `0954dc2` |
| Cleanup | pending; no resource deletion performed |

## Observations

### Wrangler D1 Insights

The one-hour query returned an empty JSON result:

```text
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ec9a295faad8e519458 \
  npx wrangler d1 insights anyam-p3-24-live-20260810-metadata \
  --time-period 1h --json --limit 100
→ []
```

The twenty-four-hour query returned Cloudflare API authentication error `10000`.

The empty result is not treated as a current feed or a zero-usage claim; the longer query demonstrates that the read path is not authorized with the current credential.

### Cloudflare GraphQL Analytics

Workers Metrics and R2 Operations queries were sent to the Cloudflare GraphQL endpoint for the named account and cohort resources. Both returned HTTP `200` with GraphQL authorization error `not authorized for that account`.

The current Wrangler OAuth scope receipt contains account/resource write scopes and Workers Tail access, but no `Account Analytics Read` scope.

### Temporary token verification

An owner supplied a temporary token for the named account. It was used only in memory for the bounded read-only probes and was not written to the repository, shell output, or receipt. Cloudflare returned HTTP `401` with error `1000` (`Invalid API Token`) from `/user/tokens/verify`; the Workers and R2 GraphQL probes consequently returned `not authorized for that account`.

The supplied token must not be reused. Revoke it and create a fresh account-scoped token before retrying. This result is an authentication observation, not a provider outage or an Anyam reliability result.

## Required recovery action

Create a temporary account-scoped API token with **Account Analytics Read** only, set it in the local qualification environment without committing or printing it, and rerun the bounded observation window. Cloudflare documents this permission in the [API token permission reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

The follow-up receipt must bind:

- the exact token permission and account resource;
- the observation start/end and feed currentness state;
- the named Anyam operation identities and provider operation IDs;
- Workers, D1, R2, Queue, and Workflow observations;
- Anyam coordinator checkpoint and digest reconciliation;
- failure/recovery evidence and exact cleanup verification.

## Cleanup boundary

Do not delete the named cohort while #127 remains a possible continuation: it is the existing owner-authorized cohort for the feed measurement. If the owner instead chooses cleanup without granting analytics authority, close the qualification as an explicit unqualified residual and state that no live provider-feed claim was made.

No credential value, refresh token, bearer token, or secret-bearing request body is stored in this receipt.
