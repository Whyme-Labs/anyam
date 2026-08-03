# P3-11 live provider cohort provisioning receipt

Date: 2026-08-03

Issue: [Provision the live provider cohort for P3 qualification](https://github.com/wms2537/anyam/issues/99)

Protocol: `anyam.p3-provider-cohort-provisioning/v1`
Status: provisioned with explicit gaps; held for the dependent live-path qualification

## Question

Which real provider accounts, external GitHub repositories, pull-Runner
profiles, package/release Targets, and safe test data are available for a
bounded P3/public-beta qualification cohort, and how can each be provisioned
and recovered without Anyam SaaS credentials or invented cost receipts?

## Authority and credential boundary

All resources below are owned by the operator accounts, not by an Anyam SaaS
account. Anyam did not receive or persist a provider credential.

| Provider | Authenticated identity | Credential location | Receipt |
| --- | --- | --- | --- |
| GitHub | `wms2537` | local GitHub CLI keyring; token value not recorded | `gh auth status` passed on 2026-08-03; Git transport is SSH |
| Cloudflare | `Swmengappdev@gmail.com's Account` (`1e0170aaabc90ecf5f466128d1f0466a`) | local Wrangler OAuth profile; token value not recorded | `npx wrangler whoami` passed; resource operations succeeded with `CLOUDFLARE_ACCOUNT_ID` set explicitly |
| npm | unavailable | none | `npm whoami` returned HTTP 401; no npm credential or billing claim is invented |
| External pull Runner | unavailable | none | no external host/profile was enrolled; the fixture protocol receipt from the prior Runner qualification remains the only evidence |

## GitHub fixtures

Both repositories are disposable and contain only a synthetic README fixture.

| Purpose | Repository | GitHub id | Visibility | `main` receipt |
| --- | --- | ---: | --- | --- |
| public Source Space/mirror | [anyam-p3-cohort-public-20260803](https://github.com/wms2537/anyam-p3-cohort-public-20260803) | `1321765830` | public | `42b46185112f9c93692fcb490e90fb5406999109` |
| private Source Space/provider auth | [anyam-p3-cohort-private-20260803](https://github.com/wms2537/anyam-p3-cohort-private-20260803) | `1321765880` | private | `abb58a0d09968ad50b58416c3ef7b2fa6daca753` |

The private fixture also has a disposable GitHub Release Target:

```text
release=p3-cohort-20260803
releaseId=364210136
targetCommit=main
assets=0
url=https://github.com/wms2537/anyam-p3-cohort-private-20260803/releases/tag/p3-cohort-20260803
```

This is a Target fixture, not a production release or a package-registry
qualification. The dependent live-path ticket must publish only a synthetic
Artifact and must preserve the release idempotency and cleanup receipt.

## Cloudflare customer-operated fixture

The disposable resource set is in account
`1e0170aaabc90ecf5f466128d1f0466a`, with APAC placement requested for D1 and
R2. Creation receipts came from Wrangler on 2026-08-03:

| Resource | Provider identity | Receipt |
| --- | --- | --- |
| D1 | `anyam-p3-cohort-20260803-metadata` | UUID `ef94b85a-c8e8-424b-afaa-cd08a085a4f8`; created `2026-08-03T12:39:18.840Z`; remote `SELECT 1 AS cohort_probe` succeeded in APAC/KIX; `sql_duration_ms=0.1525`; `changes=0` |
| R2 | `anyam-p3-cohort-20260803-exports` | created `2026-08-03T12:39:22.811Z`; Standard storage; APAC location hint |
| R2 preview | `anyam-p3-cohort-20260803-exports-preview` | created `2026-08-03T12:39:26.638Z`; Standard storage; APAC location hint |
| Queue | `anyam-p3-cohort-20260803-events` | id `a303c08ac3b94879abb6d7298203e478`; created `2026-08-03T12:39:30.850777Z`; one producer (`worker:anyam-p3-cohort-20260803`); zero consumers |
| Workflow | `anyam-p3-cohort-20260803-workflow` | trigger instance `93ae8fc0-f526-4821-937b-6725127adddb`; version `8ea3d5f5-1d2d-4691-ba73-8c81b02241c1`; completed successfully; no authority-bearing steps |
| Durable Object | `AnyamRealmCoordinator` export | created during Worker deployment; the current foundation implementation returns a credential-free blocked coordinator response |

The R2 round trip uploaded the safe public README as
`qualification/README.md` and fetched it back with SHA-256:

```text
556de854482a433c7311353c5ebf75f5af815237843906b7b0e8f7bf3e1f7ed5
```

The Worker deployment is:

```text
worker=anyam-p3-cohort-20260803
url=https://anyam-p3-cohort-20260803.swmengappdev.workers.dev
deployment=3898496c-7b04-4505-809d-3d84da9d949b
version=2de6e3a2-c827-40fb-b7d0-60bb0e4a6f6b
created=2026-08-03T12:40:29.649636Z
buildRevision=6e9bca5119b3e6f80f3c8085ebc5a686adb42af2
bindings=REALM_COORDINATOR,ANYAM_WORKFLOW,ANYAM_EVENTS,ANYAM_METADATA_DB,ANYAM_EXPORTS
```

The live health response was:

```text
protocol=anyam.customer-realm-worker/v1
status=ready
credentialFree=true
authority=customer-owned
hostingMode=customer-operated
configured=5
missing=0
capabilities=health;bootstrap-metadata
```

The method and route tripwires are visible: `POST /health` returned `405`
with a recovery action, and `GET /unknown` returned `404` with the supported
surface named. A five-request warm-up sample observed four `200` responses and
one transient `500`; a later twenty-request sample observed `20/20` `200`
responses. This is an observation receipt, not a reliability SLO. The transient
error remains an open qualification question for the dependent live-path
ticket; no uptime number is claimed.

## Runner and package gaps

No external pull-Runner host, workload identity, or private network profile is
available in this cohort. The existing local runner fixture can be replayed,
but it is not live external-provider evidence. The dependent qualification
must either add an operator-enrolled runner or record the provider path as
explicitly unavailable.

npm is not authenticated, so no npm package Target, billing receipt, or
registry-side credential has been created. The disposable GitHub Release above
is the currently available package/release-adjacent Target.

## Cleanup and recovery

The cohort remains provisioned for the dependent qualification ticket. After
its receipt is recorded, delete only these exact resources and verify absence:

```text
gh repo delete wms2537/anyam-p3-cohort-public-20260803 --yes
gh repo delete wms2537/anyam-p3-cohort-private-20260803 --yes
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler delete anyam-p3-cohort-20260803
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler workflows delete anyam-p3-cohort-20260803-workflow
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler queues delete anyam-p3-cohort-20260803-events
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler d1 delete anyam-p3-cohort-20260803-metadata --skip-confirmation
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler r2 object delete anyam-p3-cohort-20260803-exports/qualification/README.md --remote
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler r2 bucket delete anyam-p3-cohort-20260803-exports
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler r2 bucket delete anyam-p3-cohort-20260803-exports-preview
```

The account id in the cleanup example must be checked against the resource
inventory before execution; it is intentionally not a credential. The
dependent ticket owns cleanup verification so this provisioning ticket does
not delete resources required for the next receipt.

## Decision

The P3 cohort is provisioned and bounded:

```text
github=public+private fixtures; release target available
cloudflare=customer-owned D1+R2+Queue+Workflow+health-only Worker available
identity=GitHub and Cloudflare CLI access available; no Anyam SaaS authority
npm=unavailable; no credential or billing claim
externalRunner=unavailable; fixture-only
safeData=synthetic README; no secrets or customer data
cleanup=exact commands recorded; deferred to dependent qualification
status=ready-for-dependent-live-provider-qualification
```

This receipt provisions resources; it does not qualify live bidirectional
mirroring, external execution, package publication, WebAuthn/OIDC, MCP OAuth,
or tenant isolation. Those remain the responsibility of the dependent ticket.
