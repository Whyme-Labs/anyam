# Release input closure

Status: Accepted

Issue: [#246](https://github.com/Whyme-Labs/anyam/issues/246)

## Context

An immutable Artifact digest alone does not explain how a Release was built.
The same Project Revision can produce different output when its build
definition, dependency lock state, toolchain, or environment changes. Anyam
must preserve the distinction between source identity and build identity while
still allowing a Release to move between Targets without rebuilding.

## Decision

`anyam.release-input/v1` records:

- the build-definition digest;
- dependency and lock-state digest;
- toolchain digest;
- environment digest;
- the ordered Artifact digest set; and
- a closure digest over all of the above.

Local Release assembly creates the input set from the manifest and execution
context. Authority Release creation derives the same closure from the exact
Artifacts and passed Evidence, or validates an explicitly supplied input set.
Evidence with mismatched dependency, toolchain, or environment inputs cannot
form one ready Release.

`sealVerifiedRelease` verifies the closure before computing the immutable
Target-bound Release digest. Promotion receives that sealed Release and never
rebuilds it.

Legacy detached provider fixtures that do not carry Evidence remain outside
the reproducible Release path. They must not be presented as build-qualified
Releases; new Authority and local Release paths require the closure.

## Consequences

- Release reuse and Promotion can distinguish unchanged build inputs from a
  moving source or provider branch.
- Export and safe projections carry digest metadata without credential values.
- A later migration-compatibility contract can bind schema/data state to this
  same Release input boundary.

## Rejected alternatives

- **Commit hash only:** does not capture lockfiles, toolchains, environment
  inputs, or generated Artifacts.
- **Caller-supplied provenance string:** a free-form string cannot prove that
  all Artifacts and Evidence share one input closure.
- **Rebuild during Promotion:** would break the exact preview-to-production
  Artifact invariant.
- **Universal reproducibility claim:** Projects remain responsible for their
  own Verifiers; Anyam records the closure it actually observed.
