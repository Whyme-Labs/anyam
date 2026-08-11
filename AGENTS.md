# Anyam agent instructions

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `Whyme-Labs/anyam`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain layout. See `docs/agents/domain.md`.

## Working vocabulary

Use these terms consistently when evaluating designs and implementations:

- **Landmine**: a decision that costs nothing now and blows up later. By the time it detonates, it is load-bearing. Examples include an unmeasured limit or a silent catch.
- **Receipt**: the measurement behind a number. No receipt, no number.
- **Tripwire**: a limit placed beyond where any healthy workload should go, so only broken behavior touches it. Healthy workloads never feel that it exists.
- **Simple**: how cleanly the logic breaks down. Each step follows from the last, with no step doing two jobs.
- **Obvious**: the next reader never asks, “Why is this here?” Obviousness is measured by the reader. It is not always the same as simple; an obvious design may have more parts.

## Engineering philosophy

### Boil the ocean

When planning, do not be afraid to suggest seemingly insane solutions. Anyam is rethinking what it means to build a source-control and software-delivery platform. It must be cross-platform and provide an exceptional developer and agent experience. Prefer familiar Git, TypeScript, and web conventions where they fit so developers and agents can transition easily. Aim for very high efficiency with low memory and CPU usage without trading away the developer experience.

### Every number needs a receipt

A limit without a measurement is a landmine. Before writing any number—such as a node count, byte cap, timeout, quota, or concurrency limit—measure the real thing, record the receipt, and size the limit as a tripwire.

Capacity is free until touched when the underlying system allows it: reserve generously, commit lazily, and never zero an arena eagerly. If a healthy workload hits a budget, the budget is wrong. Remeasure and update the receipt.

### A limit developers can hit is a limit they must see

Developers will not read our code. Their agents will read our errors. An agent can fix `max_nodes=128, asked for 129`; it cannot fix a blank window or silent failure.

Every budget failure must name the budget, the configured limit, and the requested amount. Report it during `anyam check` when knowable there, and loudly at runtime otherwise. A silent budget is worse than no budget.

### Fight for the obvious solution

Measure twice, cut once. Understand the problem fully before building, because cleverness is what gets written when the problem is not yet understood. The biggest simplicity win is refusing to solve problems we do not have.

Good code is the simplest thing that delivers the full required functionality and performance: nothing traded away and nothing bolted on. Push back when there is a more obvious solution.

### Make long-term architectural decisions

Do not accept a stopgap that only works for now and is intended to be replaced later. Isolate uncertain dependencies behind honest boundaries, qualify them, and choose designs that can remain load-bearing.

### Grow the system in layers

Start with the smallest version that works end to end, then add each capability on top of a product that still works. Never trade a working product for unfinished complexity.
