# Customer-operated Realm Worker qualification

This package is the first deployable edge slice for a customer-operated Anyam
Realm. It exposes credential-free health and bootstrap metadata plus the
official Cloudflare Workers OAuth Provider boundary for an MCP resource. The
qualification Worker now verifies and durably enrolls a first owner through a
customer-controlled passkey adapter. It does not yet issue an Anyam Capability
Grant, transfer Git objects, perform Landing, or mutate a Target.

Cloudflare Access Managed OAuth is optional. The Worker owns the OAuth/MCP
protocol surface; Anyam owns the Realm identity, consent, capability policy,
and owner-authentication adapter. See [ADR 0048](../../docs/adr/0048-native-workers-oauth-and-optional-access.md)
for the boundary and the conditions under which Access may be added at the
perimeter.

## Local qualification

From the repository root:

```bash
npm run check:realm
```

The command runs the repository checks and Wrangler's local dry-run bundle
qualification using `wrangler.example.jsonc`. It does not contact a customer
Cloudflare account and is not a deployment receipt.

To exercise the browser owner ceremony or OAuth/MCP routes locally, use a
secure local origin because the OAuth provider rejects non-HTTPS issuer
metadata:

```bash
npx wrangler dev --local-protocol https \
  --var ANYAM_REALM_RP_ID:localhost \
  --config wrangler.passkey-qualification.jsonc
```

The `--var` override is required because the checked-in qualification config
uses the deployed `workers.dev` hostname as its WebAuthn relying-party ID.
The credential-free `/health` and owner ceremony routes also remain available
over ordinary `http://localhost` during local development. This is a local
transport convenience only; it does not weaken the deployed HTTPS contract.

## Customer deployment

1. Create or choose the customer's Cloudflare resources for the Realm's
   coordinator, OAuth KV, metadata read model, Project Export/recovery objects,
   event queue, and Workflow.
2. Copy `wrangler.example.jsonc` to `wrangler.jsonc`.
3. Replace every `replace-with-customer-*` value and the installation/build
   variables with customer-owned values. Do not put API tokens, passkeys,
   refresh tokens, or secret values in this file.
   Set `ANYAM_REALM_RP_ID` to the exact hostname that serves the owner
   passkey ceremony (for example, `source.customer.example`; do not include a
   scheme or port). The hostname must remain stable for that Realm.
4. Set the one-time first-owner bootstrap secret with
   `npx wrangler secret put ANYAM_OWNER_BOOTSTRAP_TOKEN --config wrangler.jsonc`.
   The secret is held by the customer Worker and is never written to source,
   D1, KV, logs, or an Anyam receipt.
5. Authenticate Wrangler using the customer's own Cloudflare account and run
   `npx wrangler deploy --config wrangler.jsonc`.
6. Check `GET /health`. A `ready` response proves only that the configured
   foundation bindings and customer-owned mode variables are present. It does
   not prove account ownership, owner authentication, Git, Artifacts, durable
   persistence, or Worker Promotion.

The current Wrangler configuration uses a SQLite-backed Durable Object export,
which is the current Cloudflare configuration shape for new Durable Object
classes. D1, R2, Queue, and Workflow entries are provider bindings; Anyam's
Realm and Project coordinators remain the source of authority above them.

## Binding contract

| Binding/variable | Role in this foundation | Authority |
| --- | --- | --- |
| `REALM_COORDINATOR` | Realm/project coordination adapter boundary | Anyam Realm/Project coordinator |
| `OAUTH_KV` | OAuth provider client, authorization-code, token, and grant state | Cloudflare Workers OAuth Provider, governed by Anyam policy |
| `ANYAM_METADATA_DB` | Rebuildable query/read model | Anyam events and exports |
| `ANYAM_EXPORTS` | Customer-owned Project Export and recovery object store | Anyam export manifest and digests |
| `ANYAM_EVENTS` | At-least-once event transport | Anyam authoritative event/state transition |
| `ANYAM_WORKFLOW` | Durable orchestration adapter boundary | Anyam Run/Release/Promotion state |
| `ANYAM_HOSTING_MODE` | Must be `customer-operated` | Realm policy |
| `ANYAM_INSTALLATION_ID` | Non-secret installation identity | Installation state |
| `ANYAM_PROTOCOL_VERSION` | Must match the Worker protocol | Contract compatibility |
| `ANYAM_REALM_RP_ID` | Exact hostname used for WebAuthn ceremonies; no scheme or port | Realm identity policy |

Configured bindings are reported by name only. The health response never
returns binding values or credentials.

## Owner passkey qualification surface

The Worker exposes a customer-owned WebAuthn adapter boundary:

| Route | Purpose |
| --- | --- |
| `POST /api/owner/passkey/register/options` | First-owner registration challenge; requires the bootstrap secret header |
| `POST /api/owner/passkey/register/verify` | Verifies the browser registration response, enrolls durable Realm membership, and writes the D1 owner projection |
| `POST /api/owner/passkey/auth/options` | Authentication challenge for an enrolled owner |
| `POST /api/owner/passkey/auth/verify` | Verifies the assertion and issues an opaque host-only owner session |
| `POST /api/owner/session/revoke` | Revokes the current opaque owner session and expires its cookie |
| `POST /api/owner/qualification/delegate` | Owner-session-protected qualification delegation for an isolated agent Workspace; credentials are not issued implicitly |
| `POST /api/owner/qualification/credentials` | Explicitly exchanges the exact delegated agent Session/Task/Grant for short-lived Git and/or MCP credentials |
| `POST /api/owner/qualification/revoke` | Revokes the qualification agent, delegated Sessions, Tasks, Grants, credentials, and Workspace task |
| `POST /api/owner/qualification/recovery/export` | Exports the current credential-free identity snapshot for the disposable recovery drill |
| `POST /api/owner/qualification/recovery/restore` | Restores that snapshot quarantined, revokes authority, and clears the host session until passkey re-activation |
| `GET /owner/claim` | Serves the browser first-owner WebAuthn ceremony (use `?format=json` for the machine contract) |
| `GET /owner/login` | Serves the browser authentication ceremony (use `?format=json` for the machine contract) |

The qualification surface now includes a minimal browser ceremony and retains
the JSON contract for automation. The server-side verifier uses
`@simplewebauthn/server`, stores only public credential material and the
counter in customer D1, and stores short-lived challenges/session handles in
customer KV. It never stores a passkey private key or bootstrap secret.

The verified owner is enrolled through the customer Realm Durable Object before
the D1 projection is written. The live receipt keeps provider and kernel
evidence distinct: `ownerRecord=verified` describes the WebAuthn/D1 adapter,
while `kernelMembership=verified` describes the durable Realm identity
transition. Authentication creates a kernel session first and then an opaque
host-only session; OAuth authorization revalidates the kernel session before
granting the provider's authorization request. Delegation and credential
exchange are separate operations: delegation names the exact child
Session/Task/Grant and available credential classes; explicit exchange returns
Git and/or MCP token values once. The durable snapshot stores only credential
digests. The recovery drill exports a credential-free snapshot, restores it
with all Sessions and Grants revoked, and requires a fresh passkey
authentication before the Realm returns to active status. This is a disposable
proof surface, not yet the production Git Smart HTTP gateway or the complete
agent API.
