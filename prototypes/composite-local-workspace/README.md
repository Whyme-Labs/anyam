# Composite local Workspace prototype

> **THROWAWAY PROTOTYPE — do not import this directory into production Anyam.**

This prototype answers one design question:

> Can a local `Workspace` present several authorized `Source Spaces` as one ordinary-looking filesystem while keeping the source boundaries explicit, taking automatic `Snapshot`s, showing one status/diff, undoing safely, and representing remote/local divergence as a durable `Conflict` instead of silently choosing a side?

It uses a tiny pure reducer in `model.ts` and a disposable terminal shell in `cli.ts`. State is in memory only. There is no package manager, persistence layer, network call, or test suite by design.

## Run

From the repository root:

```sh
node --experimental-strip-types prototypes/composite-local-workspace/cli.ts
```

Node 22's built-in type stripping is the only runtime dependency. The prototype intentionally has no `package.json` or installed library.

## Drive the important cases

Start with the `commercial` Project View. It materializes only two authorized spaces:

```text
community       → src/player
commercial-core → src/codec
```

The terminal re-renders the complete state after every line. Try this sequence:

```text
edit src/player/index.ts "export function play(source: string) { return source.trim(); }"
undo
remote-edit community src/player/index.ts "export function play(source: string) { return source.toLowerCase(); }"
edit src/player/index.ts "export function play(source: string) { return source.trim(); }"
sync
resolve src/player/index.ts local
publish
check-mount commercial-core src/player
```

The intended moments to react to are:

- `edit` creates an automatic `Snapshot` without a manual commit command.
- `undo` creates new state and leaves the earlier Snapshot and operation visible.
- `sync` preserves a divergent local/remote edit as a `Conflict`.
- `resolve` requires an explicit local or remote choice before `publish` can create a `Change Revision`.
- `publish` records per-Source-Space Git-compatible snapshots but explicitly does not write a canonical repository.
- `check-mount` refuses a colliding mount rather than silently merging two source trees.
