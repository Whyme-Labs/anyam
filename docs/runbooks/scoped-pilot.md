# Run a scoped customer-operated pilot

The scoped pilot uses one customer-operated Realm, isolated human and agent
Workspaces, exact candidate review, declared verification, trusted Landing,
one Worker Release and an owner recovery path. It starts as a private alpha.
Local qualification prepares that pilot; it does not complete the
[real-team adoption gate](real-team-adoption-gate.md).

## Pin the implementation and use its CLI

Use the reviewed Git commit and its locked dependencies. Record the complete
commit, tree, tool versions and normal repository-gate result:

```sh
git rev-parse HEAD HEAD^{tree}
git status --short
npm ci --ignore-scripts
npm run build
task_anyam_cli="$PWD/packages/create-anyam/dist/anyam.js"
anyam() { node "$task_anyam_cli" "$@"; }
anyam --help
```

The local package is the source-pinned entrypoint. The published package may
precede the reviewed commit. Keep pilot Projects, agent state and operator
checkpoints outside this implementation checkout. Do not copy another
installation's credentials or unreviewed qualification configuration.

## Prepare and exercise the local workflow

Follow the [local CLI review walkthrough](../qualification/local-cli-review-packet.md)
in disposable Project and state directories. It exercises scaffolding,
committed candidate publication, declared verification and the exact review
packet through the actual CLI/MCP broker. A newer candidate makes prior
source observations stale; a failed verifier stays failed. Revoke the selected
session to prove the other Workspace remains independent. A dead broker cannot
be resumed from a persisted session ID; start a fresh scoped session.

For restricted source, use the existing enforceable Workspace lane with
explicit permitted paths and Actions. The supervised walkthrough is an
owner-local convenience and does not enforce Source isolation. Configure
Codex and Claude independently with `anyam agent setup codex` and
`anyam agent setup claude` in the intended disposable Project; inspect their
generated MCP settings and resolve `anyam` to the pinned CLI. A shell function
alone is not an executable available to a coding harness. Override its MCP
command with the absolute Node binary and pinned `anyam.js` arguments when
using a source checkout. Select enforceable mode and the intended Source/Action
scope before connecting restricted work. Setup creates instructions/config,
not proof of model execution or remote delegation. Use the customer's
approved model authentication and network boundary when the human pilot starts;
do not substitute an unrestricted process for a denied boundary.

The existing bounded local qualifiers cover the rest of the reference workflow:

| Journey | Command | Evidence boundary |
| --- | --- | --- |
| Human disclosed-selector CLI and two delegated Agents | `npm run qualification:selector-clients-local` | Actual CLI/HTTP MCP/Coordinator/SQLite; fixture auth and repository observation; requested Runs remain queued |
| Exact verifier → signed Evidence → two Cohort Landings, interrupted ref repair and reopen | `npm run qualification:cohort-local-verifier` | Actual enforceable Node verifier processes and real isolated Git refs; fixture governance/provider fencing; internal Landing seam |
| Git clone/fetch/Workspace push, canonical-push denial, Worker Release health/rollback and export/quarantine/activation | `npm run qualification:private-alpha-journey` | Local Git and process execution; installation, health/provider and governance fixtures |
| Operator signed Authority checkpoint and failure/retry | `node_modules/.bin/tsx --test --test-name-pattern 'actual operator CLI' test/authority-disclosure-runtime.test.mjs` | Actual Node CLI, public HTTP recovery routes, Coordinator/SQLite restart; synthetic pre-existing owner session and recovery key; no live writes |

Run one local qualifier at a time. Retain its actual status, scope, exact source
and failed/blocked receipts. Reuse still-applicable qualified evidence when
the relevant source and inputs have not changed. These commands do not invoke
native coding models or live provider resources. The internal offline Cohort
adapter is not a public Landing route or a production provider fence.

For the hosted human/Agent sequence, use
[disclosed selectors](../qualification/cli-mcp-disclosed-selectors.md):
Project read → Workspace creation → Intent-bound Change → observed Revision
publication → queued Run. Inspect the selected immutable Revision after
reconnecting; verify its exact Source snapshots, latest/older indicator and
Run/Evidence associations. Use accepted signed owner Run detail separately.
Completion is Runner-authoritative; a client cannot declare a passing result.
Review and Landing must use current policy and exact candidate-bound Evidence.
Do not promote fixture-recorded success, a queued Run, or a read-only review
packet into an approval or Landing authority.

## Keep the three recovery boundaries distinct

`anyam realm export --path …` and `realm restore --path …` handle the local
installation lifecycle record. They do not back up the hosted Authority,
identity, source bytes or provider state. For hosted Authority use the explicit
`realm recovery` commands below. Identity/passkeys/Sessions/Grants and provider
repositories, Artifacts, Runner bytes, Queues and Targets need their existing
separate recovery procedures.

Supply an **existing active human host Session** through your installation's
trusted helper on stdin. `trusted-human-session-helper` below names that
operator-owned helper; it is not an Anyam login command. No Session is saved
or adapted from OAuth, argv or an environment variable by these commands.

```sh
task_realm_url="https://your-realm.example"
task_checkpoint_dir="$(mktemp -d /tmp/anyam-owner-checkpoint.XXXXXX)"
trusted-human-session-helper | anyam realm recovery export \
  --realm "$task_realm_url" --output "$task_checkpoint_dir/authority.json" \
  --session-stdin --json
```

Export writes the unchanged signed Authority recovery v1 or v2 bundle into a
new private file, reports its file digest and bundle identity, and omits the
snapshot/signature from terminal output. The CLI preserves signed fields and
does not verify the HMAC without the customer recovery key. Retain that key
through its existing customer-owned secret recovery path; never add it to the
checkpoint. A Realm-wide owner needs complete current Source access. Project
ownership does not grant this export.

**The following restore and activation are intended for an isolated rehearsal
or a separately approved real recovery, never as a production smoke test:**

```sh
trusted-human-session-helper | anyam realm recovery restore \
  --realm "$task_realm_url" --input "$task_checkpoint_dir/authority.json" \
  --output "$task_checkpoint_dir/restore.json" \
  --idempotency-key owner-recovery-restore-1 --session-stdin --json
trusted-human-session-helper | anyam realm recovery inspect \
  --realm "$task_realm_url" --session-stdin --json
```

Reconcile the existing provider state while Authority remains quarantined, then
activate only its exact restore receipt:

```sh
trusted-human-session-helper | anyam realm recovery activate \
  --realm "$task_realm_url" --input "$task_checkpoint_dir/restore.json" \
  --idempotency-key owner-recovery-activate-1 --session-stdin --json
```

Restore saves the exact returned receipt and leaves quarantine in place.
Activation reads the bundle ID/digest from that receipt, requires the existing
passkey owner policy, and checks the currently quarantined recovery generation
and normalized SQL snapshot. An export bundle is not an activation receipt.
A superseded receipt cannot activate a later restore. Active current replay
does not erase legitimate subsequent changes.

The output file must be new; existing files and symlinks are not overwritten.
Keep checkpoint files in an owner-controlled directory, with its established
backup/retention controls. Inputs must be regular UTF-8 JSON files. On an
unconfirmed response or failed receipt write, the server operation may have
completed. Retain the original bundle and idempotency key, inspect state,
and retry only the identical request using a new output filename. The CLI does
not automatically retry or activate. It never edits the signed input to repair
an old bundle. See the [recovery qualification](../qualification/authority-recovery.md)
for supported historical omissions and the intact-SQL requirement. An old
unbound quarantine needs a fresh signed owner export/restore; selecting a
historical receipt is unsafe.

## Stage the existing Realm cutover

Before execution, keep a reviewed source/config/payload packet with:

1. The complete source commit/tree and normal gate receipt; compiled module
   digest; current account, Worker, deployment/version and traffic.
2. Fresh existing binding/resource identifiers, required inherited secret
   names, vars, compatibility and applied DO migration tag. Preserve queue
   consumer settings, routes and other non-versioned controls. A qualification
   example with placeholder vars is not a production configuration.
3. A signed pre-cutover owner Authority checkpoint and the existing separate
   identity/source/provider recovery material. Do not generate replacement
   credentials or use an Authority restore as a release check.
4. A `versions upload` dry-run multipart bound to the reviewed source, using
   `--no-experimental-provision --no-experimental-auto-create`. Plan actual
   upload → returned-version read-back → deploy that verified version at 100%.
   Verify the resolved DO namespace as well as names/classes on read-back;
   a dry-run payload alone does not observe the assigned namespace.
5. The first supported Authority load boundary. Current code records logical
   SQLite schema 2; owner inspection and queued delivery can reach it. Schema-1
   production cannot serve as a subsequent rollback. Use supported-code
   fix-forward; never remove the marker to force an old writer.
6. A complete current-code signed owner checkpoint after schema-2
   initialization and before further intended mutations, plus exact-version
   health and authenticated readiness read-back. `/health` is not proof of
   owner, binding, recovery, Runner or provider readiness.

Staging this checklist does not authorize activation. A pending cutover decision
must remain pending. Adding hosted Artifacts or Runner-output storage is a
separate reviewed binding/owner-enrollment scope, rather than an implicit side
effect of this source rollout.

## Start human acceptance only with the offered path qualified

Record named consenting participants, both actual coding-agent products,
owner-approved source/model policy, the Realm/version, retention decision and
the exact UTC start. Complete ordinary and failure/recovery journeys through
the actual installed CLI/MCP, RepositoryDriver/Runner, review/Landing and
Worker Release/Target path. Keep native candidate recordings, independent
verification and provider receipts bound to the exact revisions. Real
Artifacts transport success does not qualify the bound Workspace adapter,
canonical-writer exclusion or provider fencing.

The [real-team gate](real-team-adoption-gate.md) requires its full human
trial and operational/security evidence. It cannot be closed by simulations,
local green checks, a demo or this runbook. Missing installed-path/cutover
receipts and a named human cohort remain explicit launch/acceptance blockers.
