# ADR 0039: Customer-operated installation control path

- Status: Accepted
- Date: 2026-08-03
- Issue: [Implement the customer-operated install and owner-claim control path](https://github.com/Whyme-Labs/anyam/issues/88)
- Depends on: [ADR 0031](./0031-customer-operated-realm-installation-and-recovery.md)

## Context

The customer Realm installation state machine already knew how to inspect a
customer account, provision customer-owned resources, persist operation
identities, and recover from a credential-free export. It was only reachable
as a local kernel fixture. The shipped Worker exposed health and bootstrap
metadata but no customer command protocol, protected route, adapter-verified
owner claim, or explicit provider propagation readiness record.

The missing boundary must not turn a provider token into Anyam state or make a
provider acknowledgement into Anyam authority. It also must not enable public
mutation routes before an authentication and capability policy adapter is
bound.

## Decision

`src/installation/customer-realm-control.ts` owns a portable command/control
boundary around `CustomerRealmInstallation`.

### Command contract

The versioned protocol is `anyam.customer-realm-control/v1`. It exposes:

- `installation.status`
- `installation.install`
- `installation.owner-claim`
- `installation.readiness`
- `installation.recover`
- `installation.recovery-restore`
- `installation.recovery-activate`

The HTTP projection is:

- `GET /api/install/:installationId`
- `POST /api/install`
- `POST /api/install/:installationId/owner-claim`
- `POST /api/install/:installationId/readiness`
- `POST /api/install/:installationId/recover`
- `POST /api/install/:installationId/recovery/restore`
- `POST /api/install/:installationId/recovery/activate`

Every command is authorized by an injected customer Realm authorization
adapter. A command must present the capability appropriate to its operation;
the route returns `401` or `403` without invoking the installation state
machine when authorization is absent or mismatched. If no qualified control
adapter is bound to the Worker, `/api/install` remains `404` and no mutation
route exists.

### Provider authorization

The control protocol accepts only a receipt-only provider authorization with
the provider, account, audience, authorization digest, expiry, and receipt.
The raw Cloudflare/OIDC/CLI credential is held by the customer provider
adapter or broker and is passed only during the in-memory provider call. The
installation state, command, checkpoint, audit event, HTTP response, and
recovery bundle never contain that credential. The control boundary rejects
fields named like tokens, passwords, secrets, or credentials.

### Owner authentication adapters

The control boundary has separate `verifyPasskey` and `verifyOidc` adapter
methods. They receive a transient proof and return only verified identity
metadata plus an external verification receipt. `CustomerRealmInstallation`
then registers the passkey or OIDC identity and creates the owner relationship.
No default administrator, password, session, or bearer credential is created.

The adapter contract is provider-neutral. A WebAuthn implementation may use a
customer-owned browser origin and an OIDC implementation may use the
customer's issuer; those provider-specific integrations remain qualification
work, not implicit claims of the kernel fixture.

### Readiness and recovery

Provider propagation is represented by a durable `deployment.readiness`
command and `deploymentReadiness` state. A transient provider result records
`status=retryable`, its operation identity, provider receipt, recovery action,
and a new Recovery Checkpoint. The next probe reuses the operation identity; a
ready receipt returns the installation to its prior phase. A blocked result
fails closed.

Recovery restore remains two-phase:

```text
verified Recovery bundle → recovery-pending → fresh provider reconciliation
→ fresh external owner activation → active/project-ready/owner-ready
```

The control route exposes restore and activation separately. Restoring a valid
bundle never restores active sessions or grants and never activates authority.

### Worker boundary

The Worker health module accepts a structural control-route interface without
importing the Node-backed installation kernel into the Cloudflare bundle. This
keeps the edge foundation deployable while allowing a customer-owned
coordinator to bind a qualified control route later.

## Consequences

- A customer CLI, local controller, or customer-owned Worker coordinator can
  use one versioned command contract.
- Durable Object/store implementations remain the authority for installation
  state and compare-and-swap checkpoints.
- Provider credentials are never part of Anyam state or exports.
- Readiness failures are visible and actionable rather than silent retries or
  false success.
- Passkey and OIDC integrations are replaceable adapters with an explicit
  receipt boundary.
- The default deployed Worker still exposes only credential-free health until
  a real Realm policy and provider adapter are qualified.

## Rejected alternatives

- **Put a Cloudflare API token in installation state:** violates customer
  ownership and makes a recovery export a credential vault.
- **Accept `passkeyVerified: true` on the public route:** a boolean is not an
  authentication proof; only an adapter receipt may cross the owner boundary.
- **Treat the first successful deploy response as ready:** Cloudflare
  propagation can be transient; readiness needs a retryable receipt.
- **Enable `/api/install` without a policy adapter:** creates an unauthenticated
  mutation surface before capability semantics are qualified.
- **Restore and activate in one command:** a valid export is not fresh owner
  authority; recovery must remain quarantined until external activation.
