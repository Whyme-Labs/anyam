# P3-8 customer-operated installation control path qualification

Date: 2026-08-03
Issue: [Implement the customer-operated install and owner-claim control path](https://github.com/Whyme-Labs/anyam/issues/88)
Protocol: `anyam.customer-realm-control-qualification/v1`
Status: passed with a provider-neutral, customer-operated control boundary

## Question

Can a customer-operated installation be driven through a versioned command and
route contract while keeping provider credentials outside Anyam state, making
provider propagation explicit, requiring adapter-verified owner enrollment,
and keeping recovery quarantined until fresh external activation?

## Qualification receipt

```text
protocol=anyam.customer-realm-control-qualification/v1
status=passed-with-bounded-provider-adapters
control=anyam.customer-realm-control/v1
installation=installation:control
install=authenticated-customer-command
providerAuthorization=receipt-and-digest-only
providerCredentialStoredByAnyam=false
readiness=retryable-propagation-receipt-then-ready
ownerPasskey=adapter-verified
ownerOidc=adapter-verified
recoveryRestore=recovery-pending
recoveryActivation=fresh-external-receipt-required
unauthorizedMutation=401; no-state-transition
unboundWorkerMutation=404; no-control-adapter
```

The route test persisted the installation through the in-memory store (the
same `CustomerRealmInstallationStore` contract used by the Durable Object
adapter). It captured the provider authorization object at the adapter edge;
the persisted state and response contained neither the authorization digest
nor the bearer/session value.

The first deployment readiness probe returned:

```text
provider=cloudflare; deployment=propagation-pending; retryable=true
```

The command remained the same (`operation:deployment-ready`) while the state
entered `degraded` with a new Recovery Checkpoint. The next probe returned:

```text
provider=cloudflare; deployment=ready; bindings=verified
```

and the state returned to `realm-ready` with the same command marked
`succeeded`.

The passkey adapter returned a verified credential identity and external
receipt; the OIDC adapter returned a verified issuer/subject/client identity
and external receipt. The installation state contains only the resulting
identity metadata and `materialStoredInInstallation=false`. Neither proof was
persisted or returned.

Recovery restore was exercised through the control plane. The restored state
was `recovery-pending`, customer credentials remained absent, and restored
sessions were revoked. Owner activation remains a separate command requiring a
fresh external recovery receipt and provider reconciliation.

## Commands run

```text
npx tsx --test test/customer-realm-control.test.ts — 4 passed
npm run check — 99 passed; TypeScript clean
npm run build:realm — Worker typecheck and Wrangler dry-run passed
```

The Worker dry-run receipt observed an upload of `5.56 KiB` and gzip output of
`1.82 KiB` for this source revision. These are build observations, not product
limits or performance guarantees.

## Boundary and residual risk

This qualification proves the portable command, storage, policy, and adapter
contracts. It does not claim that Anyam has already implemented a live
Cloudflare WebAuthn verifier, OIDC issuer integration, or provider API token
broker. It also intentionally leaves the deployed foundation Worker mutation
routes absent until a customer-owned coordinator binds a qualified policy and
provider adapter. Those provider-specific receipts remain the next operational
qualification lane.
