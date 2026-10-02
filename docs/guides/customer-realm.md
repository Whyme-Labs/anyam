# Operate a customer-owned Realm

This guide covers the customer-operated Hosting Mode. The Realm runs in your
Cloudflare account. The source is available for review; a distribution license remains to be
selected. Your Project history stays
exportable.

## Plan the installation

From the Anyam checkout, inspect the read-only plan:

```bash
anyam realm plan --account customer-account-id
```

The plan lists the resources, permissions, domains, secret locations,
migrations, rollback path, destruction checkpoint, and cost observations. A
plan does not create a provider resource.

## Prepare the Worker configuration

Copy the checked-in example configuration and replace every
customer-specific placeholder value:

```bash
cp apps/realm-worker/wrangler.example.jsonc apps/realm-worker/wrangler.jsonc
npm run realm:installation-manifest
```

Set the printed installation manifest digest in the Worker configuration. Keep
API tokens, passkeys, refresh credentials, and secret values out of the file.

Set the first-owner bootstrap secret through Wrangler:

```bash
npx wrangler secret put ANYAM_OWNER_BOOTSTRAP_TOKEN \
  --config apps/realm-worker/wrangler.jsonc
```

## Install and claim ownership

The local CLI records a resumable, credential-free checkpoint. Without a
customer-owned provider adapter it returns `blocked` with phase
`provider-pending`; it does not provision resources. Inspect that checkpoint
and complete the adapter installation before claiming readiness. The separate
Wrangler command below performs a real provider deployment and requires
explicit customer authorization:

```bash
anyam realm install --account customer-account-id
npx wrangler deploy --config apps/realm-worker/wrangler.jsonc
```

Open the owner claim route on the deployed hostname, enroll a passkey, and
authenticate. The owner session is opaque. The Worker does not export a bearer
cookie into the Project.

Inspect readiness after authentication:

```text
GET /api/operator/status
GET /api/operator/preflight
GET /owner/control-room
```

The control room stays indeterminate until the customer-owned operations ledger
contains verified receipts for the required production drills. A missing or
stale receipt is a visible readiness gap.

## Add a Project and Target

Import an existing Git repository or scaffold a new one. Keep the source
transfer in Git and use the Realm for the semantic operations:

```text
Project → Source Space → Workspace → Change → Revision → Landing
```

Configure each Target with a complete deployment profile before requesting a
Promotion. The Target record owns the provider identity. Callers do not submit
an account, script, or credential identifier.

## Upgrade safely

Run the read-only plan before an upgrade:

```bash
anyam realm plan --account customer-account-id
anyam realm upgrade
anyam realm doctor
```

The lifecycle stores a credential-free checkpoint and resumes after an
interruption. It never deletes Project history or customer resources as an
implicit side effect.

## Export and recover

Create an export before destructive maintenance:

```bash
anyam realm export --path /tmp/anyam-realm-export.json
anyam realm restore --path /tmp/anyam-realm-export.json
```

The local restore records a `recovery-pending` checkpoint. Owner
reauthentication and provider reconciliation remain separate steps. A restore receipt does not claim that
provider resources or production authority were restored.

## Production boundary

The local repository gate and disposable qualification Workers are not
production evidence. Before calling the Realm ready, record the sustained-load,
queue-recovery, Durable Object contention, backup/restore, key-rotation,
authentication-throttling, incident-alerting, and independent security-review
receipts required by the [operations control-room decision](../adr/0092-production-operations-control-room.md).
