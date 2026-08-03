# P3-12 live provider-path qualification receipt

Date: 2026-08-03

Issue: [Qualify live provider paths for the P3 public-beta cohort](https://github.com/wms2537/anyam/issues/100)

Protocol: `anyam.p3-live-provider-qualification/v1`

Status: bounded provider receipts passed; live Anyam auth, npm, external Runner, and universal reliability remain explicit advisories

## Question

Using the provisioned cohort, what live receipts qualify the identity and token
path, GitHub bidirectional mirror, external pull Runner, TypeScript package or
release Target, and customer-operated Cloudflare install for the bounded
P3/public-beta journey?

## Qualification boundary

The qualification used only disposable GitHub repositories, a synthetic README,
an empty GitHub Release Target, and a customer-owned Cloudflare fixture. No
Anyam SaaS credential, customer source, production secret, or production Target
was used. Provider receipts below qualify provider transport and adapter seams;
they do not claim universal provider support.

## Identity and token path

| Path | Live observation | Decision |
| --- | --- | --- |
| GitHub API identity | `gh api user` returned login `wms2537`, id `51080539`, type `User` | passed for the disposable GitHub cohort |
| GitHub authenticated Git | SSH `git ls-remote` read private `main=abb58a0d09968ad50b58416c3ef7b2fa6daca753` | passed for operator credential path |
| GitHub anonymous Git | HTTPS `git ls-remote` read public `main=42b46185112f9c93692fcb490e90fb5406999109` | passed for public projection read path |
| Cloudflare account identity | Wrangler OAuth listed account `1e0170aaabc90ecf5f466128d1f0466a` | passed for customer-owned resource operations |
| Anyam install auth | `GET /api/install` returned `404 not_found` because the deployed foundation has no control adapter | not qualified; no live WebAuthn/OIDC owner claim |
| Anyam MCP auth | `GET /mcp` returned `404 not_found` | not qualified; no live MCP OAuth endpoint is deployed |

No provider token value was printed, stored in the repository, or passed to an
Anyam Worker. GitHub API rate receipt after the exercise was:

```text
core.limit=5000
core.remaining=4804
graphql.limit=5000
graphql.remaining=4832
```

These are provider observations, not customer-facing quotas or SLOs.

## GitHub bidirectional transport

The public fixture was used as the disposable remote. All qualification commits
were empty commits with synthetic messages; no source content was disclosed.

```text
publicRepo=wms2537/anyam-p3-cohort-public-20260803
privateRepo=wms2537/anyam-p3-cohort-private-20260803
outboundCommit=85d3bc265639d20ecc9ad3c591bf5f0ca982e291
outboundFetched=85d3bc265639d20ecc9ad3c591bf5f0ca982e291
inboundCommit=cc7f41d34a40e8bd8f7796c30c5600ca9a8273b2
inboundFetched=cc7f41d34a40e8bd8f7796c30c5600ca9a8273b2
timedOutboundPush=3.204s
timedOutboundFetch=2.984s
coarseInboundPush=3s
coarseInboundFetch=3s
remoteCleanup=p3-live-outbound,p3-live-inbound,p3-live-outbound-timed deleted
```

The remote `main` refs were not force-pushed or rewritten. The private and
public visibility boundaries were independently verified through GitHub API
metadata. This qualifies live Git transport, authenticated public/private
visibility, fast-forward-shaped branch publication, and fetch recovery. It
does not qualify the Anyam mirror coordinator, webhook delivery, provider App
installation, or rate-limit recovery as a live end-to-end service because that
control plane is not deployed in the foundation Worker.

## GitHub Release Target

The disposable private fixture had Release `p3-cohort-20260803`, id
`364210136`. A synthetic 530-byte `.tgz` Artifact was uploaded as asset
`anyam-p3-cohort-0.0.0.tgz`, asset id `500059402`, and downloaded through the
authenticated GitHub CLI.

```text
sourceSha256=e8cab22369486282020f6b0829953d23ad1ff87dad35623273cba1f33291e77a
downloadSha256=e8cab22369486282020f6b0829953d23ad1ff87dad35623273cba1f33291e77a
shaMatch=true
anonymousPrivateAssetFetch=404
duplicateUploadExit=1
duplicateUploadMessage=asset under the same name already exists
```

The asset was not silently replaced or duplicated. This qualifies a live
GitHub Release asset publication/read path and a provider duplicate tripwire.
It does not qualify npm publication, billing reconciliation, or an Anyam
Target coordinator's immutable Release/rollback state machine. The existing
local TypeScript Release/Target fixture remains the only package semantics
receipt until npm or another registry is authenticated.

## Customer-operated Cloudflare install surface

The provisioned Worker was exercised at
`https://anyam-p3-cohort-20260803.swmengappdev.workers.dev`:

```text
health=20/20 HTTP 200 in the current sample
metadata=HTTP 200
install=HTTP 404 not_found (control adapter intentionally absent)
mcp=HTTP 404 not_found (endpoint not deployed)
healthReceipt=status=ready; credentialFree=true; authority=customer-owned; configured=5; missing=0
d1=SELECT 1 AS cohort_probe, 0 AS writes; APAC/KIX; sql_duration_ms=0.1825; total_attempts=1
r2=qualification/README.md; sha256=556de854482a433c7311353c5ebf75f5af815237843906b7b0e8f7bf3e1f7ed5
workflow=93ae8fc0-f526-4821-937b-6725127adddb; completed
```

The earlier provisioning receipt recorded one transient warm-up `500` in a
five-request sample followed by `20/20` successful responses. The combined
observation is a provider/reliability advisory, not an uptime claim. No
failure injection was performed against the customer-owned D1, R2, Queue,
Workflow, or Worker because the current foundation surface has no qualified
mutation or recovery route. `npx wrangler deploy --dry-run` remained clean.

## External Runner and npm paths

The external Runner path remains unavailable: no operator-enrolled external
host, workload identity, private network, or live pull profile exists. The
bounded local fixture still passes:

```text
npx tsx --test test/runner.test.ts
4 passed
```

This is fixture evidence only. `npm whoami` returned HTTP 401, so no npm
credential, package publication, billing, or registry rollback claim is made.

## Cost, quota, and recovery boundary

GitHub API rate observations are recorded above. Cloudflare billing/usage feed
was not available through the authenticated qualification surface, so the
receipt is `providerFeed=unavailable` rather than an invented invoice. No
provider limit is promoted to an Anyam tripwire from this run.

Observed recovery/cleanup behavior:

- GitHub remote qualification branches were deleted after their SHAs were
  fetched and recorded.
- GitHub duplicate asset publication failed explicitly instead of replacing
  the existing asset.
- Public and private Git refs remained separate and unchanged on `main`.
- Cloudflare health, D1, R2, and Workflow resources were reachable before the
  disposable resource set was deleted; final deletion and absence are verified
  below.

## Cleanup verification

The disposable cohort was deleted after the live receipts were captured. The
first public-repository delete had already completed before its shell wrapper
reported the provider's expected `404`; the final inventory confirms the same
end state for both repositories.

```text
githubPublic=absent (REST 404)
githubPrivate=absent (REST 404)
cloudflareWorker=absent (Wrangler code 10007: Worker does not exist)
cloudflareWorkflow=deleted
cloudflareQueue=deleted
cloudflareD1=deleted
cloudflareR2Object=deleted
cloudflareR2Exports=deleted
cloudflareR2Preview=deleted
inventoryNameMatches=d1:0;r2:0;queues:0;workflows:0
cleanupVerified=2026-08-03T12:59:32Z
```

No production resource was targeted. The checked-in Wrangler fixture remains a
historical qualification configuration and now points at deleted disposable
names; it is not a live deployment manifest.

## Decision

```text
protocol=anyam.p3-live-provider-qualification/v1
status=passed-with-bounded-advisories
identity=github+cloudflare provider auth passed; Anyam WebAuthn/OIDC/MCP auth absent
mirror=live public/private Git transport round-trip passed
releaseTarget=live GitHub Release asset upload/read/duplicate tripwire passed
customerInstall=health/binding/D1/R2/Workflow provider surface passed; control route absent
externalRunner=unavailable; fixture-only
npm=unavailable; HTTP 401
providerFeed=unavailable; no invoice invented
universalSupport=false
```

This receipt is sufficient to unblock the P3 route's next decision, but it is
not a production-launch or universal-provider-support claim.
