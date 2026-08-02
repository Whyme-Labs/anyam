# Anyam Evidence lifecycle prototype

Throwaway Wayfinder prototype for issue #21. It tests whether Runs, Evidence,
approvals, provenance, disclosure projections, policy explanations, and cached
Evidence can remain reproducible when source, policy, Target, or effects change.

## Run

Interactive TUI:

```bash
node prototypes/evidence-lifecycle/cli.ts
```

Scripted walkthrough:

```bash
node prototypes/evidence-lifecycle/cli.ts --demo
```

The pure reducer is in `model.ts`; the terminal shell is disposable.
