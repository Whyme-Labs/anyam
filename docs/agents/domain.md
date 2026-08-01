# Domain docs

This repository uses a single-context domain-documentation layout.

## Before exploring, read these

- Read `CONTEXT.md` at the repository root.
- Read ADRs under `docs/adr/` that affect the area being changed.

If either location does not exist, proceed silently. Do not create speculative domain documentation. The `domain-modeling` skill creates or updates it when terminology or decisions are actually resolved.

## File structure

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-example-decision.md
│       └── 0002-another-decision.md
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept—in an issue title, design, test, refactor proposal, or implementation—use the term defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If a needed concept is absent, first reconsider whether it is established project language. If it represents a real model gap, record it for `domain-modeling`.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding the decision.
