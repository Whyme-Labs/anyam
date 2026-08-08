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
4. Authenticate Wrangler using the customer's own Cloudflare account and run
   `npx wrangler deploy --config wrangler.jsonc`.
5. Check `GET /health`. A `ready` response proves only that the configured
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
