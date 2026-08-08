# create-anyam

Package-manager-neutral TypeScript scaffolding for Anyam Projects, with the
local `anyam` command for inspection and Changes.

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

## Connect a local coding agent

From an initialized Project with an active Change, configure the agent you want
to use:

```bash
anyam agent setup codex    # or claude, cursor, cli
anyam agent start codex
```

The setup writes only local broker configuration and shared instructions. It
does not put a token in `.mcp.json`, `AGENTS.md`, Git config, or the Project.
The broker exposes semantic Project, Change, Workspace, run, evidence, review,
and revision tools over stdio MCP. Git remains the source-object transport.

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

The repository includes a tag- or manually-triggered GitHub Actions workflow at
`.github/workflows/publish-create-anyam.yml`. Configure npm Trusted Publishing
for:

```text
Provider:       GitHub Actions
Owner:          wms2537
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
  --repository wms2537/anyam \
  --file publish-create-anyam.yml \
  --environment npm-publish \
  --allow-publish
```

If staged publishing is chosen instead, change the workflow to `npm stage
publish`, configure `--allow-stage-publish`, and keep final approval as a
separate maintainer 2FA action. Do not silently mix the two modes.
