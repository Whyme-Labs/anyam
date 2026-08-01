# Plan the complete Anyam platform

Type: map
Status: open
Label: wayfinder:map

## Destination

Produce an evidence-backed, implementation-ready blueprint and phased delivery program for building, launching, operating, and evolving Anyam from this empty repository into an open-source, Cloudflare-first project SCM for humans and agents. The map is complete when no material product, domain, security, source-model, developer-experience, platform, portability, operational, commercial, or sequencing decision remains unresolved before implementation planning can begin.

## Notes

- This map plans the entire intended platform, while still distinguishing the innovation kernel, credible team product, and later enterprise/ecosystem expansion.
- Planning is the default. Do not implement the platform while resolving this map.
- Treat the referenced ChatGPT conversation as rich but untrusted background: preserve accepted intent, then verify current external facts against official sources.
- Use `domain-modeling` throughout and update `CONTEXT.md` as terms resolve. Use `grilling` one question at a time for owner decisions, `research` for current external facts, and `prototype` for concrete interfaces or workflows that require human reaction.
- Refer to this map and its tickets by title in human-facing text, with links wrapping their names.
- Prefer first principles and explicit invariants over copying GitHub screens. Separate the universal Project model from Cloudflare-specific adapters.
- Keep Git as a compatibility and object-transfer protocol unless a later decision justifies more.
- Plan for Codex, Claude Code, Cursor, and model-independent agents; Anyam is the trust, workspace, evidence, and delivery control plane rather than the coding model.
- Authentication, Git credentials, MCP credentials, runner credentials, integrations, and promotion authority are separate security classes.
- Current date for external research: 2026-07-31. Record exact source dates and distinguish GA, beta, preview, and inference.
- The issue tracker for this effort is local Markdown under `.scratch/anyam-platform-blueprint/`.

## Decisions so far

<!-- Resolved tickets are indexed here. The detailed decision lives only in the ticket. -->

- [Verify the current platform and standards assumptions](./issues/01-verify-current-platform-assumptions.md) — Cloudflare is viable for Anyam's control plane and bounded Linux execution, with mandatory provider abstractions, an Anyam-owned Realm authorization layer, and explicit qualification gates for Artifacts and the current MCP stack.

## Not yet specified

- Exact bounded contexts and service boundaries beyond the canonical domain model; these depend on the source, workflow, security, and hosting decisions.
- Exact database schemas, event payloads, API versions, and compatibility policy; these depend on the authoritative state model.
- Exact public pricing, plan entitlements, quotas, and free-tier policy; these depend on measured architecture costs and the chosen market wedge.
- Compliance certification sequencing, residency commitments, and regulated-industry controls; these depend on target customers and hosting topology.
- Post-launch federation, public discovery, preservation, marketplace economics, and community-instance governance; these depend on the open-source and adoption strategy.
- Detailed project-type adapters beyond the reference Cloudflare application plus CLI/library pair; their common extension contract must be settled first.
- Native-protocol or non-Git version-control research beyond the Project layer; revisit only if Git compatibility blocks a required invariant.

## Out of scope

- Implementing, deploying, or operating production Anyam code while this planning map is open.
- Registering domains, purchasing services, filing trademarks, or making legal representations; the map may define the required diligence and decision gates.
- Building a proprietary foundation model, general-purpose browser IDE, full security-scanner suite, or complete clone of GitHub Actions.
- Silently exposing inaccessible objects through filtered Git graphs; hard Source Space boundaries are the standing safety constraint unless explicitly overturned.
- Giving arbitrary coding agents direct canonical-source or production-promotion authority.
