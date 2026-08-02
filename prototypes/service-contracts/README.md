# PROTOTYPE — service contracts

This throwaway TypeScript prototype answers one narrow question:

> Can REST, SDK, MCP, CLI, and webhook consumers share one normalized request,
> response, event, error, idempotency, optimistic-concurrency, and cursor-page
> contract without hiding stale or duplicate state?

The pure model is in `model.ts`; `cli.ts` is only a terminal driver. It keeps
state in memory and is not production code.

Run the interactive TUI:

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' ts-node --transpile-only prototypes/service-contracts/cli.ts
```

Run the deterministic sequence:

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' ts-node --transpile-only prototypes/service-contracts/cli.ts --demo
```

Shortcuts: `n` creates a Change, `r` publishes a revision, `l` lands it, `d`
replays the last mutation, `s` sends a stale expected version, `p` advances a
cursor page, `x` resets the cursor, and `q` quits.
