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
object format, base ancestry, Repository identity, and manifest digest, then
returns only the credential-free observation.

## Install

1. Deploy the driver adapter and expose its internal `POST /observe` service
   binding. It must return the existing
   `anyam.repository-observation/v1` response shape.
2. Set the observer request budget and its measurement receipt in the observer
   Wrangler configuration:

   ```text
   REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT
   REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT
   ```

   The limit is a qualification tripwire, not a universal Anyam limit. Measure
   the real request envelope for the customer driver before changing it.
3. Replace the `REPOSITORY_DRIVER` service binding in
   `apps/repository-observer/wrangler.example.jsonc` with the customer driver
   Worker and deploy:

   ```bash
   npm run build:repository-observer
   npx wrangler deploy --config apps/repository-observer/wrangler.example.jsonc
   ```

4. Bind the deployed observer as `ANYAM_REPOSITORY_OBSERVER` in the customer
   Realm Wrangler configuration and redeploy the Realm.
5. Check `GET /health`. It is ready only when the driver service binding and
   measured request receipt are present.

Provider credentials belong exclusively to the driver adapter or its
credential broker. Never put a token, private key, or bearer value in the
observer `vars`, request, response, receipt, export, or Authority state.

## Driver response contract

The driver receives the exact observation request and returns one of:

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
or credential-bearing responses before returning them to the Realm.

## Recovery

- `repository_driver_unconfigured`: bind the driver service; no Authority
  mutation was attempted.
- `repository_driver_response_invalid`: repair the driver response shape and
  retry the same immutable observation.
- `repository_observation_binding_mismatch`: inspect the exact Workspace and
  provider object; do not widen the request or substitute a different commit.
- `request_budget_exceeded`: measure the real envelope and update the local
  tripwire with a new receipt before retrying.

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
missing-driver blocking, bounded request handling, credential-free receipts,
and exact no-mutation cleanup. It is a local adapter qualification and does
not claim live provider availability, GitHub access, or production capacity.
