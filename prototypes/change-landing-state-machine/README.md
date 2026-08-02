# Change, Landing, and Integration state-machine prototype

> **THROWAWAY PROTOTYPE — do not import this directory into production Anyam.**

This prototype answers one question:

> Can stable `Change` identities and immutable `Change Revision`s make concurrent work, review, `Integration Cohort`s, atomic `Landing`, rebase, and revert unambiguous without rewriting history or allowing a stale `Workspace` to overwrite a newer canonical `Project Revision`?

The pure reducer in `model.ts` is the part worth studying. `cli.ts` is only a disposable terminal driver. State is in memory, and there is no persistence, repository provider, verifier, or test suite by design.

## Run

From the repository root:

```sh
node --experimental-strip-types prototypes/change-landing-state-machine/cli.ts
```

## Drive the concurrency case

The following sequence creates two Changes from the same canonical revision. The second Change becomes stale after the first lands, then rebases into a new immutable revision while preserving its stable Change ID:

```text
intent change-player "Add player controls"
workspace change-player alice
claim change-player alice src/player
intent change-codec "Improve codec"
workspace change-codec bob
claim change-codec bob src/player
revise change-player alice community:player
revise change-codec bob community:player
review change-player reviewer-a approve
review change-codec reviewer-b approve
cohort change-player,change-codec
cohort change-player
land cohort-02
cohort change-codec
land cohort-03
rebase change-codec bob
review change-codec reviewer-b approve
cohort change-codec
land cohort-04
revert change-player alice
review change-revert-change-player reviewer-c approve
cohort change-revert-change-player
land cohort-05
```

Watch for these design moments:

- `change-player` and `change-codec` keep their identities while each receives several immutable revisions.
- The overlapping claims are a coordination warning, not an automatic lock.
- Effect overlap is a blocking `Conflict` in an `Integration Cohort`.
- Landing advances one canonical `Project Revision` atomically; it does not merge a stale Workspace.
- A stale cohort fails explicitly and requires `rebase`, which creates a new revision rather than rewriting the old one.
- Revert creates a new Change and revision; it never deletes or rewrites the landed history.
