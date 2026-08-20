# ADR 0061: Separate project diagnosis from Release verification

- Status: Accepted
- Date: 2026-08-20
- Scope: `create-anyam` scaffolds and local Project Actions

## Context

The generated `action:check` previously ran `anyam check`, which only inspected
manifest shape, a source entrypoint, and Git metadata. Treating that diagnostic
as Release Evidence made a syntactically shaped but uncompilable project look
verified.

## Decision

Generated Projects expose `anyam doctor` for metadata diagnosis. `anyam check`
remains a compatibility alias, but it is not a Release verifier.

Every new TypeScript Project declares separate Actions for:

- metadata diagnosis;
- TypeScript typechecking;
- tests;
- build output.

Only the typecheck, test, and build Actions are required for Release Evidence.
Generated tests and build output provide a real, runnable baseline without
assuming a web-only deployment target.

Local runtime state under `.anyam/` is ignored by generated projects. The
versioned Project manifest remains at the repository root.

## Consequences

- A doctor pass is useful feedback but cannot satisfy a Release gate.
- Unsupported project conventions must produce an explicit Action/configuration
  error rather than silently falling back to diagnosis-only verification.
- Existing manifests remain readable; migration to real Actions is explicit.

## Verification

- Scaffold tests assert distinct doctor/typecheck/test/build Actions.
- Generated `.gitignore` excludes `.anyam/`.
- Full repository gates pass with the generated-project fixtures.
