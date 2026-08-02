# Acceptance and validation prototype

PROTOTYPE — this is throwaway code for issue [#29](https://github.com/wms2537/anyam/issues/29), not production Anyam.

Question: can one evidence-backed acceptance model describe the journeys and
stage gates for solo developers, teams, public contributors, multiple coding
agents, public/private source, recovery, portability, security, accessibility,
performance, and operations?

Run the deterministic walkthrough:

```bash
bun prototypes/acceptance-validation/cli.ts --demo
```

Or drive it interactively:

```bash
bun prototypes/acceptance-validation/cli.ts
```

The prototype intentionally keeps state in memory. It demonstrates that a
stage gate is blocked by missing, failed, or stale Evidence and that a recovery
scenario can become green only after an explicit resume. Performance is a
receipt criterion, not an arbitrary quota: the prototype records that healthy
reference runs were measured before a limit would be declared.
