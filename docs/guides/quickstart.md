# Build and check a local Project

This tutorial creates a TypeScript Worker Project, checks it, and starts a
Change. It does not create a Realm or contact Cloudflare.

## Create the Project

Run the scaffold command in a directory where you keep source code:

```bash
npm create anyam demo
cd demo
npm install
```

The command creates a Git repository, an `anyam.json` Project manifest,
TypeScript source, a test, and a README. The scaffold does not create provider
resources or store credentials.

## Run the local checks

Run the doctor, compiler, test, and build commands:

```bash
npx create-anyam doctor
npm run typecheck
npm test
npm run build
```

You should see a passing Project doctor, a successful TypeScript compilation, a
passing Node test, and a `dist/index.js` output file.

If the doctor reports a blocker, read the `budget`, `limit`, `asked`, `receipt`,
and `fix` fields. The error names the boundary that needs attention.

## Start a Change

Create a stable Change before editing the next feature:

```bash
npx create-anyam change start "Add a health route"
git status
```

Edit the files with your preferred editor or coding agent. Use ordinary Git for
the source edits. Use the Anyam CLI or MCP boundary when you publish a Change,
request review, run a verifier, create a Release, or promote a Target.

## Connect a Realm later

When a customer-operated Realm is ready, authenticate the CLI without placing
a bearer token in the Project:

```bash
anyam auth login --realm https://source.example.com --client-id customer-oauth-client-id
```

The hosted lifecycle is explicit:

```text
Intent → Workspace → Change → Revision → Evidence → Landing → Release → Target
```

The local loop remains useful when the Realm is unavailable. Shared review,
canonical Landing, and external delivery happen through the Realm policy.

## Choose an agent

Configure the agent you already use:

```bash
anyam agent setup codex
anyam agent start codex
```

For restricted source, use the enforceable Workspace boundary:

```bash
anyam agent exec codex -- codex
```

Replace `codex` with `claude`, `cursor`, or `cli` when you use another agent.
The agent receives a task-scoped Workspace credential. It cannot write the
canonical repository, read secret values, approve its own Change, or promote a
production Target.

## What this tutorial proves

This tutorial proves the local scaffold and check path. It does not prove a
Cloudflare deployment, provider capacity, production data safety, or a complete
team adoption gate. Run the [golden-path qualification](../examples/README.md)
when you have customer-owned disposable resources.
