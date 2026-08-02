# PROTOTYPE — bootstrap and onboarding

This throwaway TypeScript prototype answers one narrow question:

> Can a low-friction first-run path make Realm bootstrap, owner recovery,
> GitHub/GitLab/generic-Git import, Source Space selection, agent connection,
> preview, and Promotion explicit and recoverable when import or deployment
> fails halfway through?

The state machine is pure in `model.ts`; `cli.ts` is a disposable terminal
driver. State is in memory and this is not production code.

Run the interactive TUI:

```bash
bun prototypes/bootstrap-onboarding/cli.ts
```

Run the deterministic happy-path plus two damaging recovery cases:

```bash
bun prototypes/bootstrap-onboarding/cli.ts --demo
```

The demo proves that import failure preserves a checkpoint and partial effects
without activating the Project, and that Promotion failure leaves the verified
Release recoverable without pretending production changed.
