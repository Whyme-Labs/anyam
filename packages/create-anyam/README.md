# create-anyam

Package-manager-neutral TypeScript scaffolding for Anyam Projects, with the
local `anyam` command for inspection and Changes.

Hosted human commands now also expose `realm project|workspace|change|revision|run
inspect`, `realm workspace create`, `realm change create`, `realm revision
publish` and `realm run request` using disclosed selectors, JSON payload files,
stable idempotency keys and an existing human Session through stdin. See the
[CLI and delegated MCP selector workflow](https://github.com/Whyme-Labs/anyam/blob/main/docs/qualification/cli-mcp-disclosed-selectors.md)
for authentication, payloads, native delegation and local qualification limits.

`realm revision inspect` recovers a selected Change Revision's exact disclosed
Source snapshots, latest marker, coarse Runs and recorded Evidence outcomes.
Recorded outcomes are separate from signed execution proof.

An active human Realm-wide owner can use `realm run detail --realm <url>
--id <run-id> --session-stdin --json` to inspect the existing
`anyam.owner-run-detail/v1` accepted signed-context contract. Complete current
Source access and Run `evidence.read` authority still apply. The server verifies
the enrolled signature and producing context on each read; this CLI does not
independently verify execution or manifest/artifact bytes. Ordinary Run inspection
and delegated MCP retain their coarse disclosure.

Start with the [Anyam Quickstart](https://github.com/Whyme-Labs/anyam/blob/main/docs/guides/quickstart.md). Read the
[documentation index](https://github.com/Whyme-Labs/anyam/blob/main/docs/README.md) for the design, Realm, and example guides.

## Scaffold a Project

All of these forms use the same package and produce the same local template:

```bash
npm create anyam demo
npx create-anyam demo
pnpm create anyam demo
bun create anyam demo
```

Choose the reference type explicitly when needed:

```bash
npm create anyam demo -- --type library
```

The scaffold is local-only. It does not create a Realm, authenticate, provision
Cloudflare resources, or store credentials. It initializes a local Git
repository when the target does not already have one.

## Inspect and start local work

Install the generated Project dependencies to make the `anyam` binary available
locally:

```bash
cd demo
npm install
npx create-anyam check
npx create-anyam change start "Describe the next Change"
git status
```

If you do not want a global install, the creator package exposes the same
commands through its package-manager runner:

```bash
npx create-anyam check
npx create-anyam change start "Describe the next Change"
```

For a globally available command instead, install the package once:

```bash
npm install --global create-anyam
```

Preview the manifest without writing files:

```bash
anyam init --dry-run --type worker --name demo
```

The local workflow uses familiar Git vocabulary. Anyam adds the Project
manifest, checks, and Change metadata without replacing normal Git editing.

## Start a scoped local MCP broker

Run the broker as a trusted host-side process. Each CLI broker connection
creates its own session; its declared Actions run in the selected Workspace
boundary. For a Project with `src/` and a declared `action:check`:

```bash
anyam mcp serve --stdio --agent codex --mode enforceable \
  --allow-path src --allow-path package.json --allow-path tsconfig.json \
  --allow-action action:check
```

Repeat `--allow-path` and `--allow-action` for explicitly permitted inputs and
Actions. The Project manifest is common metadata in every projection. Ensure
the selected projection contains the Action's declared inputs and runtime
dependencies. File entry points may need their package metadata. Omitting an
Action allowlist permits all declared Project Actions; omitting path selection
clones the full source. `--mode supervised` remains non-enforcing and refuses
path restrictions. An enforceable Linux backend still requires its separately
qualified resource policy; this command does not bypass that requirement.

Capture the session ID from `workspace.inspect` and revoke that exact session
when it is no longer needed:

```bash
anyam agent revoke --session '<session ID>'
```

Enforceable commands use a trusted host-side process custodian. It waits for
durable session process registration before releasing the sandboxed command.
An exclusive parent pipe ties the owned process group to the broker's lifetime,
including interruption before registration. The workload does not inherit this
control pipe. Only the actual command's completion can establish passed Evidence.

Closing or interrupting a broker does not establish successful Evidence or
remove session metadata and disposable Workspace files. After interruption,
explicitly revoke its session and start
a fresh broker with the intended scopes. `mcp serve --session '<session ID>'`
fails closed when this process has no live boundary for that session; it never
borrows the current peer session or silently recreates a boundary. Repeated
initialization on one connection is rejected.

The local process tests use synthetic Commands through real CLI/MCP stdio and
macOS sandbox execution. They qualify source projection, peer-read denial,
Action allowlists, attribution, revocation, expiry and interrupted restart,
including broker death and revocation before durable process registration.
They do not qualify real Codex/Claude model execution, connecting those clients
from inside a sandbox, restricted metadata disclosure, Linux execution, or
provider readiness, hostile process-group escape, or independent custodian
failure. The custodian changes process and resource overhead; Linux resource
qualification must be rerun before claiming Linux readiness. No native agent
or paid model is run by these tests.

## Use the hosted Intent lifecycle

Issues are represented by a first-class hosted Intent. The Intent identity is
stable when a Change is created from it, and the lifecycle is idempotent across
the Realm REST surface, remote MCP, and this CLI:

```bash
export ANYAM_OWNER_SESSION='<owner session value>'
anyam intent create \
  --realm https://source.acme.com \
  --project project:atlas \
  --id intent:atlas:invoice-export \
  --title "Add invoice export" \
  --description "Export one invoice as a PDF" \
  --disclosure project \
  --label billing
anyam intent assign intent:atlas:invoice-export \
  --realm https://source.acme.com \
  --assignee principal:wei
anyam intent comment intent:atlas:invoice-export \
  --realm https://source.acme.com \
  --body "Acceptance criteria are ready for review."
anyam intent close intent:atlas:invoice-export --realm https://source.acme.com
anyam intent reopen intent:atlas:invoice-export --realm https://source.acme.com
```

Pass `--owner-session` instead of `ANYAM_OWNER_SESSION` when the session is
held outside the environment. The CLI requires an explicit Realm and does not
persist the session or any bearer credential. Public projections omit
restricted Intents rather than returning metadata-bearing placeholders.

## Use the Git-compatible Pull Request projection

Anyam also exposes familiar Pull Request vocabulary over its Change and
Revision authority. A Pull Request is a projection, not a second canonical
branch authority; `pr merge` is accepted only after the mapped Change lands:

```bash
anyam pr open \
  --realm https://source.acme.com \
  --project project:atlas \
  --change change:atlas:invoice-export \
  --pull-request pr:atlas:invoice-export \
  --provider local \
  --head-ref refs/heads/feature/invoice-export \
  --base-ref refs/heads/main \
  --head-commit <rebased-head-commit> \
  --base-commit <base-commit> \
  --title "Add invoice export"
anyam pr review pr:atlas:invoice-export \
  --realm https://source.acme.com \
  --review-state approved \
  --review-digest sha256:<review-receipt>
anyam pr merge pr:atlas:invoice-export --realm https://source.acme.com
```

`pr update` retains the same Pull Request ID across branch updates and
rebases. `pr close`, `pr reopen`, and `pr block` preserve the Change and
Revision history. Public projections omit provider repository identity and
private Change identifiers.

## Connect a private GitHub repository without a GitHub App

For a customer-operated Realm, the Actions Bridge is the default GitHub
connection path. Anyam generates a reviewable workflow; it does not create a
GitHub App, receive a private key, store a PAT, or push to the repository.

From the existing GitHub checkout:

```bash
anyam connect github \
  --method actions \
  --realm https://source.acme.com \
  --project project:atlas \
  --connection github-bridge:pending \
  --action-ref acme/anyam-bridge-action@<immutable-commit-sha>
```

Use `--dry-run` to inspect the generated workflow without writing it. The
command detects the `origin` GitHub remote and current branch, writes
`.github/workflows/anyam-bridge.yml` only when the path is absent, and refuses
to overwrite a different existing workflow. Review and commit the generated
file through the normal GitHub process, then return to Anyam for OIDC
verification and history reconciliation.

Outbound synchronization is manual until a measured schedule is selected:

```bash
anyam connect github ... --schedule "<customer-approved-cron>"
```

The workflow uses job-scoped GitHub permissions and a customer-owned Realm
connection. For outbound projection it retrieves a signed exact bundle, pushes
with `GITHUB_TOKEN`, and reports mapped-ref read-back to the Realm. Protected
branch refusal becomes a visible mirror-branch/Pull Request recovery rather
than false success. Anyam remains canonical; GitHub is a mirror and
contribution surface. Live GitHub OIDC/JWKS, protected-branch, and outbound
provider qualification remain separate receipts.

## Connect a local coding agent

From an initialized Project with an active Change, configure the agent you want
to use:

```bash
anyam agent setup codex    # or claude, cursor, cli
anyam agent start codex
```

For the private-alpha restricted-source path, launch the agent through the
qualified host boundary instead of attaching it to the ambient developer
process:

```bash
anyam agent exec codex -- codex
```

`agent exec` defaults to `--mode enforceable`. It creates a disposable Git
Workspace (or an authorized projection), removes ambient credential
environment and SSH configuration, applies the host sandbox's explicit
network policy, and keeps canonical Git refs outside the child boundary. If
the host has no qualified sandbox backend, the command fails closed rather
than silently falling back.

`anyam agent start` is the convenient supervised local lane. It is labelled
`mode=supervised; enforcement=none` in the session and receipt, and must not
be used as restricted-source isolation.

The setup writes only local broker configuration and shared instructions. It
does not put a token in `.mcp.json`, `AGENTS.md`, Git config, or the Project.
The broker exposes semantic Project, Change, Workspace, run, evidence, review,
and revision tools over stdio MCP. Git remains the source-object transport.

`change.inspect` includes an additive `reviewPacket` summary for the selected
session. It shows the recorded candidate commit/tree and declared effects,
scoped Run/Evidence references, and missing, stale, failed, blocked, or passed
local Action observations. A result matches the candidate's source and current
Action/Verifier contracts; it is not a complete Evidence validity or Landing
policy decision. Local Runs identify Git commits without recording a Change
Revision or declared-effect binding; the packet exposes that limitation.
Peer-session records are excluded from the packet. The
existing raw inspection fields retain their prior owner-local behavior.

Rationale, concrete behavior examples, diff contents, authoritative decisions,
and current working-tree/provider state are explicitly unknown or not recorded
when no corresponding artifact exists. Local findings have no immutable
revision binding, so the packet labels them accordingly. Inspecting the packet
changes only the existing tool audit; it does not publish, approve, Land,
recover, or run an Action.

The agent receives a task-scoped capability tied to the active Workspace and
Change. Its Git credential is short-lived and Workspace-only; canonical source
write, secret-value reads, Change approval, policy administration, and
production promotion are explicitly denied.

```bash
anyam agent status
anyam agent handoff claude
anyam agent revoke
anyam mcp serve --stdio --agent codex
```

The local adapter is intentionally owner-operated: it records a local session,
grant, Context Manifest, credential digest, and audit events under
`.anyam/agents/state.json`, but never stores the bearer credential itself.

From the Anyam checkout, `npm run verify:package` qualifies the packed package
through the npm-exec, npx, pnpm, and Bun offline lanes. Literal `npm create
anyam`, `pnpm create anyam`, and `bun create anyam` registry resolution is a
release qualification after this package is published.

## Owner-controlled npm release

The intended package identity is the unscoped public package `create-anyam`,
owned by the logged-in npm publisher. Confirm that identity and enable account
2FA before the first live publish; a package name and version are immutable
once published.

This checkout retains version `0.0.0`. Select and approve a release version and
signed tag separately after the repository gate passes. No package publication
is implied by building these examples.

### First-time npm account setup

Configure a new second factor from the npm website, not by trying to enroll a
new TOTP secret through the CLI:

1. Sign in at <https://www.npmjs.com/> as the package owner.
2. Open the profile menu, choose **Account**, then **Enable 2FA**.
3. Select a supported security-key/WebAuthn method such as macOS Touch ID,
   Windows Hello, Face ID, or a physical security key.
4. Save the recovery codes in a password manager separate from the security
   key.

The registry no longer accepts the old CLI TOTP-enrollment request; it returns
`E404 Adding a new TOTP 2FA is no longer supported`. Do not treat that error as
a package or publisher failure.

The repository includes a tag- or manually-triggered GitHub Actions workflow at
`.github/workflows/publish-create-anyam.yml`. Configure npm Trusted Publishing
for:

```text
Provider:       GitHub Actions
Owner:          Whyme-Labs
Repository:     anyam
Workflow:       publish-create-anyam.yml
Environment:    npm-publish
Action:         npm publish
```

The workflow uses OIDC and does not read an npm token. Keep the GitHub
environment protected and restrict package publishing to the trusted publisher;
do not add `NODE_AUTH_TOKEN` to this workflow. The first package creation and
the npm Trusted Publisher setting are owner actions on npmjs.com. npm's trust
configuration requires the package to exist and account 2FA to be enabled. After
the first owner-approved publish, the equivalent CLI setup is:

```bash
npx --yes npm@11.15.0 trust github create-anyam \
  --repository Whyme-Labs/anyam \
  --file publish-create-anyam.yml \
  --environment npm-publish \
  --allow-publish
```

If staged publishing is chosen instead, change the workflow to `npm stage
publish`, configure `--allow-stage-publish`, and keep final approval as a
separate maintainer 2FA action. Do not silently mix the two modes.
