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

From the Anyam checkout, `npm run verify:package` qualifies the packed package
through the npm-exec, npx, pnpm, and Bun offline lanes. Literal `npm create
anyam`, `pnpm create anyam`, and `bun create anyam` registry resolution is a
release qualification after this package is published.
