# Cloudflare Worker Target adapter

Status: Accepted

Issue: [#150](https://github.com/Whyme-Labs/anyam/issues/150)

## Context

The private-alpha vertical slice can create and verify an immutable Anyam
Release, but it must still deliver that Release to a customer-owned Cloudflare
Worker without rebuilding source or allowing a coding agent to mutate the
canonical state. Cloudflare exposes Worker versions and deployments as two
different provider operations: uploading a version creates an immutable
candidate, while a deployment chooses the version receiving traffic. Preview
URLs are also provider-specific and must not be guessed by the kernel.

Anyam therefore needs a real provider adapter, not an in-memory deployment
facade. The adapter must preserve the existing `WorkerPromotionCoordinator`
state machine: a Target changes only after a successful health observation, and
an unhealthy candidate must roll back to the previous known-good Release.

## Decision

`CloudflareWorkerTargetAdapter` owns only Cloudflare Workers API mechanics:

```text
verified Worker Artifact
        -> digest-checked reader
        -> Cloudflare Worker Version upload
        -> provider preview URL and health observation
        -> 100% Version Deployment
        -> verified Target transition in Anyam coordinator
```

The adapter uses the Workers Versions and Deployments APIs:

- `POST /accounts/{account_id}/workers/scripts/{script_name}/versions`
  uploads a multipart version with `main_module` and an immutable Anyam
  Release digest tag. Uploading does not deploy traffic.
- `POST /accounts/{account_id}/workers/scripts/{script_name}/deployments`
  deploys the selected version with a 100% traffic allocation.
- `GET .../versions` resolves an already-uploaded version by the digest tag so
  a retry does not create another version for the same Release.
- A configured preview URL and health URL are observed through `fetch`; URL
  construction remains outside the kernel because the customer owns the
  `workers.dev` subdomain or custom domain.
- A caller may provide an explicit, measured route-readiness policy for
  preview and production observations. The qualification uses a 404-only
  retry tripwire because the live provider can return a route-not-ready 404
  just after a successful version upload or deployment. The final observation
  is still the real provider URL; this policy never turns a non-2xx response
  into healthy.

Rollback is another provider deployment to the previous Release's tagged
version. It does not rewrite source or change the Anyam Target by itself. The
coordinator records the rollback and restores Target state only after rollback
health succeeds.

## Credential boundary

The adapter receives a `CloudflareWorkerCredentialBroker`, not a long-lived
token. The broker issues an operation-scoped credential for version reads,
preview/version upload, or promotion/rollback. The raw token exists only while
the provider request is being made. It is not copied into a Release, Target,
receipt, Evidence object, error, or qualification output. MCP and deployment
credentials are not passed through to the provider; a customer installation
must implement the broker with its own Realm/secret-broker boundary.

## Artifact boundary

The adapter accepts exactly one verified `worker.bundle` Artifact. The injected
Artifact reader must return bytes for the digest already sealed in the Release.
The filesystem reader rejects paths outside the declared workspace (including
`.git`) and checks SHA-256 before any provider mutation. R2 or another object
store can implement the same interface without changing the adapter.

## Failure and retry semantics

Every provider result includes the provider version/deployment identity and a
receipt binding the operation to the Release and Artifact digests. Transport
failure during a mutation is classified as indeterminate: the caller must
inspect the provider by the immutable Release tag before retrying. Provider
errors never silently advance Anyam state. Missing version lookup may proceed
to one digest-checked upload; a repeated upload is prevented by the tag lookup
and in-process cache.

The `per_page=100` version-list query is a Cloudflare provider observation for
the documented recent-version window. It is not an Anyam capacity limit. Anyam
must remeasure and qualify a pagination strategy before treating a larger
provider history as supported.

## Qualification

`npm run qualification:worker-target` is a disposable live qualification. It
requires an account ID, a customer-owned API token with the Workers Scripts
Write permission, a script name beginning with
`anyam-worker-target-qualification-`, and the account's preview subdomain. It:

1. seeds a disposable Worker;
2. uploads and previews a healthy Release;
3. promotes it and observes healthy production health;
4. uploads a candidate whose health returns 503;
5. verifies the coordinator records rollback and preserves the first Release;
6. deletes the disposable Worker in a `finally` cleanup path.

The script prints credential-free receipts and never claims production SLOs,
provider limits, or universal Cloudflare support. Its route-readiness values
are qualification-only observations and must be remeasured before becoming a
production policy. The deterministic test in
`test/cloudflare-worker-target.test.ts` exercises the same adapter and
coordinator path with a Worker-level API fixture, including digest checks,
credential audience separation, preview, promotion, failed health, and
rollback.

## Consequences

- A customer can use Anyam's existing promotion state machine with a real
  Cloudflare Worker provider.
- Source remains immutable and promotion remains Landing/coordinator-only.
- The adapter can move from Cloudflare Artifacts or a filesystem/R2 reader to
  another repository provider without changing delivery contracts.
- Preview URL and provider version identity are explicit rather than inferred.
- Provider facts are kept separate from Anyam policy and must carry receipts.
- A live qualification still depends on customer-owned Cloudflare credentials
  and is not evidence that Anyam is production-ready.

## References

- [Cloudflare Upload Version API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)
- [Cloudflare Create Deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/)
- [Cloudflare Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [Cloudflare Preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)
- [Cloudflare Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
