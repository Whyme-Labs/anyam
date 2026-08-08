# Customer-operated Realm Worker qualification

This package is the first deployable edge slice for a customer-operated Anyam
Realm. It exposes credential-free health and bootstrap metadata plus the
official Cloudflare Workers OAuth Provider boundary for an MCP resource. The
qualification Worker deliberately leaves the owner-authentication adapter
blocked: it does not yet authenticate a principal, issue an Anyam Capability
Grant, transfer Git objects, perform Landing, or mutate a Target.

Cloudflare Access Managed OAuth is optional. The Worker owns the OAuth/MCP
protocol surface; Anyam owns the Realm identity, consent, capability policy,
and owner-authentication adapter.

## Local qualification

From the repository root:

```bash
npm run check:realm
```

The command runs the repository checks and Wrangler's local dry-run bundle
qualification using `wrangler.example.jsonc`. It does not contact a customer
Cloudflare account and is not a deployment receipt.

## Customer deployment

1. Create or choose the customer's Cloudflare resources for the Realm's
   coordinator, OAuth KV, metadata read model, Project Export/recovery objects,
   event queue, and Workflow.
2. Copy `wrangler.example.jsonc` to `wrangler.jsonc`.
3. Replace every `replace-with-customer-*` value and the installation/build
   variables with customer-owned values. Do not put API tokens, passkeys,
   refresh tokens, or secret values in this file.
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

Configured bindings are reported by name only. The health response never
returns binding values or credentials.

## Owner passkey qualification surface

The Worker exposes a customer-owned WebAuthn adapter boundary:

| Route | Purpose |
| --- | --- |
| `POST /api/owner/passkey/register/options` | First-owner registration challenge; requires the bootstrap secret header |
| `POST /api/owner/passkey/register/verify` | Verifies the browser registration response and creates the qualification owner record; binding this verified result into the portable Anyam identity kernel remains the next boundary |
| `POST /api/owner/passkey/auth/options` | Authentication challenge for an enrolled owner |
| `POST /api/owner/passkey/auth/verify` | Verifies the assertion and issues an opaque host-only owner session |
| `POST /api/owner/session/revoke` | Revokes the current opaque owner session and expires its cookie |
| `GET /owner/claim` | Serves the browser first-owner WebAuthn ceremony (use `?format=json` for the machine contract) |
| `GET /owner/login` | Serves the browser authentication ceremony (use `?format=json` for the machine contract) |

The qualification surface now includes a minimal browser ceremony and retains
the JSON contract for automation. The server-side verifier uses
`@simplewebauthn/server`, stores only public credential material and the
counter in customer D1, and stores short-lived challenges/session handles in
customer KV. It never stores a passkey private key or bootstrap secret.

This is deliberately an adapter qualification, not a claim that the edge D1
owner row is already the complete Anyam identity kernel. The live receipt must
keep `ownerRecord=verified` and `kernelMembership=adapter-bound-next` distinct
until the Worker calls the durable Realm identity/control authority.
