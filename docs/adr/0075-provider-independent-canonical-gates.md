---
status: accepted
---

# Provider-independent canonical gates

GitHub branch protection and rulesets are provider capabilities, not Anyam's
source-of-truth boundary. Some private GitHub repositories cannot enable those
features on their current plan, so requiring every customer to upgrade or make
their source public would make the product depend on a provider policy that
Anyam does not control.

Anyam therefore has one supported canonical mode: the Realm's Project Revision
and Landing authority remain canonical, while GitHub, GitLab, Codeberg, or a
generic Git remote is an explicit `RepositoryMirror` projection and
contribution surface. A Mirror records `canonicalAuthority=anyam`; provider
branch protection is `not-required` for that mode. Remote commits, direct
pushes, force-pushes, deletions, and provider pull requests are untrusted
inputs that become Changes, Revisions, divergence, or reconciliation work.
They never advance the canonical Project Revision by themselves.

The Authority and provider adapters reject a provider-authoritative Mirror
request rather than silently accepting a second authority. Anyam's own Git
Gateway continues to deny canonical `receive-pack`; only trusted Landing can
advance canonical source. A future provider-authoritative mode would require a
separate contract and a live provider governance receipt for every required
control, but it is not a fallback for an unavailable GitHub plan.

This closes the product limitation without weakening private repositories. The
GitHub ruleset work in #212 remains an operational hardening task for the
open-source Anyam repository or any installation that elects to use GitHub
branch protection; it is not a prerequisite for private customer Projects.
