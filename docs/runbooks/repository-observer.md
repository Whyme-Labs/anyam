# Customer-operated Repository Observer

The repository observer is the service-binding boundary used by the Realm
Worker for hosted Change Revision publication.

```text
Realm Worker
    │ ANYAM_REPOSITORY_OBSERVER
    ▼
repository-observer Worker
    │ REPOSITORY_DRIVER
    ▼
customer RepositoryDriver adapter
    │
    ├─ Anyam-native Git boundary
    ├─ GitHub App / REST adapter
    └─ Smart HTTP or another qualified provider
```

The observer Worker does not own provider credentials and does not decide
which Repository to inspect. The Realm supplies an authoritative
`anyam.repository-observation/v1` request. The observer forwards that exact
request to the customer-owned driver, verifies the returned commit, tree, ref,
object format, base ancestry, Repository identity, context, expiry, and
manifest digest, then returns only the credential-free observation.

## Install

1. Create a customer-owned R2 bucket for RepositoryDriver snapshot manifests.
   The stock driver is an Anyam-native, provider-neutral adapter: a trusted
   provider synchronizer writes one context-specific immutable generation per
   Repository/Workspace (or Mirror), and the Worker verifies the exact head,
   tree, base, object format, ref, ancestry, expiry, and generation index before
   returning an observation. Workspace snapshots are stored below
   `repositories/<encodeURIComponent(repositoryId)>/workspace/<workspaceId>/<projectViewId>/`;
   the index points to an immutable generation object:

   ```json
   {
     "protocol": "anyam.repository-driver-snapshot/v2",
     "repositoryId": "repo:customer",
     "sourceSpaceId": "source:customer",
     "context": {
       "kind": "workspace",
       "workspaceId": "workspace:change",
       "projectViewId": "view:change",
       "workspaceRef": "refs/heads/feature/refund"
     },
     "objectFormat": "sha1",
     "symbolicRef": "refs/heads/feature/refund",
     "commitOid": "…",
     "treeOid": "…",
     "baseCommitOid": "…",
     "ancestorCommitOids": ["…"],
     "generation": 42,
     "state": "active",
     "observedAt": "2026-08-26T00:00:00.000Z",
     "expiresAt": "2026-08-26T01:00:00.000Z",
     "receipt": "provider=customer; ancestry=verified; credentialMaterialStored=false"
   }
   ```

   The corresponding `index.json` uses protocol
   `anyam.repository-driver-snapshot-index/v1` and contains the same context,
   `latestGeneration`, `previousGeneration`, the exact immutable generation
   key, its `latestManifestDigest`, and an `updatedAt` timestamp. Generation
   objects must be write-once and retained; the synchronizer advances the index
   with an R2 conditional write. A lower or repeated generation is never
   accepted as the active snapshot. For example:

   ```json
   {
     "protocol": "anyam.repository-driver-snapshot-index/v1",
     "repositoryId": "repo:customer",
     "sourceSpaceId": "source:customer",
     "context": {
       "kind": "workspace",
       "workspaceId": "workspace:change",
       "projectViewId": "view:change",
       "workspaceRef": "refs/heads/feature/refund"
     },
     "latestGeneration": 42,
     "previousGeneration": 41,
     "latestManifestKey": "repositories/repo%3Acustomer/workspace/workspace%3Achange/view%3Achange/generations/42.json",
     "latestManifestDigest": "sha256:…",
     "updatedAt": "2026-08-26T00:00:30.000Z",
     "receipt": "provider=customer; index=monotonic; credentialMaterialStored=false"
   }
   ```

   Mirror contexts use the same manifest protocol with
   `context.kind="mirror"`, `mirrorId`, `proposalKey`, and `deliveryId`; the
   generic Workspace observation route does not reinterpret a Mirror context.
   The synchronizer remains provider-specific and may be a GitHub App,
   Smart-HTTP, or Anyam-native adapter; it never runs inside the Realm or
   Observer Worker and never writes provider credentials to a manifest.
2. Fill in `apps/repository-driver/wrangler.example.jsonc` with the bucket
   name, then deploy the private driver Worker:

   ```bash
   npm run build:repository-driver
   npx wrangler deploy --config apps/repository-driver/wrangler.example.jsonc
   ```

3. Set the observer request-body budget, transport timeout, and measurement
   receipts in the observer Wrangler configuration:

   ```text
   REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT
   REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT
   REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_MS
   REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_RECEIPT
   ```

   These are qualification tripwires, not universal Anyam limits. Measure the
   real request and response envelopes and driver transport latency for the
   customer installation before changing them. A new value requires a new
   receipt.
4. Bind `REPOSITORY_DRIVER` in
   `apps/repository-observer/wrangler.example.jsonc` to
   `anyam-repository-driver`, then deploy the observer:

   ```bash
   npm run build:repository-observer
   npx wrangler deploy --config apps/repository-observer/wrangler.example.jsonc
   ```

5. Bind the deployed observer as `ANYAM_REPOSITORY_OBSERVER` in the customer
   Realm Wrangler configuration and redeploy the Realm.
6. Check `GET /health`. It is ready only when the driver service binding and
   both measured transport receipts are present.

Provider credentials belong exclusively to the provider synchronizer or its
credential broker. Never put a token, private key, or bearer value in the
driver `vars`, snapshot manifest, observer `vars`, request, response, receipt,
export, or Authority state.

## Driver response contract

The driver receives the sanitized observation request (including the optional
`expectedSymbolicRef`) and returns one of:

```json
{
  "protocol": "anyam.repository-observation/v1",
  "status": "succeeded",
  "observation": {
    "protocol": "anyam.repository-observation/v1",
    "repositoryId": "repo:customer",
    "sourceSpaceId": "source:customer",
    "workspaceId": "workspace:change",
    "projectViewId": "view:change",
    "objectFormat": "sha1",
    "symbolicRef": "refs/heads/main",
    "commitOid": "…",
    "treeOid": "…",
    "baseCommitOid": "…",
    "ancestryVerified": true,
    "manifestDigest": "sha256:…",
    "observedAt": "2026-08-26T00:00:00.000Z",
    "receipt": "provider=customer-driver; credentialMaterialStored=false"
  },
  "receipt": "provider=customer-driver; exact=true; credentialMaterialStored=false"
}
```

`blocked` and `unavailable` responses must include a recovery action and a
credential-free receipt. The observer rejects malformed, forged, mismatched,
non-2xx success-shaped, or credential-bearing responses before returning them
to the Realm. Request and response bodies, as well as the driver call itself,
are bounded by the configured transport timeout; a timeout is
unavailable/indeterminate evidence.

## Recovery

- `repository_driver_unconfigured`: bind the driver service; no Authority
  mutation was attempted.
- `repository_driver_response_invalid`: repair the driver response shape and
  retry the same immutable observation.
- `repository_driver_response_budget_exceeded`: reduce the driver response to
  the measured observer body budget or remeasure the tripwire.
- `repository_driver_response_credential_material`: remove credentials from
  the driver response; the observer never forwards or echoes them.
- `repository_driver_timeout` and `repository_driver_response_timeout`: retry
  the same immutable observation after the driver responds within the measured
  transport timeout.
- `repository_driver_snapshot_index_missing`: publish the context-specific
  `index.json` before observing a Workspace; a legacy repository-only manifest
  is not sufficient.
- `repository_driver_snapshot_index_invalid` and
  `repository_driver_snapshot_index_mismatch`: repair the index's context,
  monotonic generation, immutable key, and manifest digest.
- `repository_driver_context_mismatch`: do not reuse a snapshot from another
  Workspace, Project View, or Mirror context.
- `repository_driver_snapshot_future`: republish using the provider's actual
  observation time, not a future timestamp.
- `repository_driver_snapshot_expired`: re-inspect the provider and publish a
  fresh generation with a future `expiresAt`.
- `repository_driver_snapshot_digest_mismatch`: rebuild the index from the
  exact immutable generation object; no observation is returned until the
  digest agrees.
- `repository_observation_binding_mismatch`: inspect the exact Workspace and
  provider object; do not widen the request or substitute a different commit.
- `repository_driver_snapshot_mismatch`: the provider head, tree, base,
  object-format, or ancestry changed (including a force-push); re-inspect the
  provider and publish a new immutable snapshot manifest.
- `repository_driver_installation_revoked`: restore the provider installation
  before publishing another snapshot.
- `repository_driver_snapshot_stale`: re-inspect the provider and publish a
  fresh active snapshot; stale state is never used as a hosted observation.
- `repository_driver_snapshot_missing`: the indexed immutable Repository
  snapshot is deleted or has not been synchronized; restore that exact
  generation object and retry the same observation.
- A timeout or lost response is unavailable/indeterminate evidence. Reconcile
  the exact generation and request identity before retrying; never substitute a
  new head in the same Change Revision.
- `request_budget_exceeded`: measure the real envelope and update the local
  tripwire with a new receipt before retrying.
- `request_timeout`: retry the same immutable observation within the measured
  transport timeout or remeasure the tripwire.

The observer performs no provider mutation and has no cleanup resource of its
own. Destroy the Worker and its driver binding only through the customer Realm
installation ledger after exporting the credential-free configuration and
receipt history.

## Qualification

Run the deterministic local boundary qualification:

```bash
npm run qualification:repository-observer
```

It verifies health, valid delegated observation, forged-observation rejection,
non-2xx success rejection, malformed/oversized/credential-bearing response
rejection, timeout handling, missing-driver blocking, bounded request handling,
credential-free receipts, and exact no-mutation cleanup. It is a local adapter qualification and does
not claim live provider availability, GitHub access, or production capacity.

The RepositoryDriver qualification composes the stock driver and Observer
against an in-memory R2-compatible fixture. A successful result proves the
customer-owned service boundary; a live customer receipt additionally requires
the real R2 bucket, provider synchronizer, and Realm service bindings.

```bash
npm run qualification:repository-driver
```
