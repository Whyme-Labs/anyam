# ADR 0103: Strict TypeScript boundary for Worker-facing tests

Status: Accepted

Issue: [#293](https://github.com/Whyme-Labs/anyam/issues/293)

## Context

`test/pull-request-rest.test.ts` drives the Realm Worker authority edge and
imports Cloudflare Worker bindings. The root Node-oriented `tsconfig.json`
cannot typecheck that dependency graph because it intentionally does not load
the Worker runtime declarations. Excluding the test from every strict project
would leave a repository-gate blind spot.

## Decision

Keep Worker-facing entrypoint tests in `tsconfig.worker-tests.json`, whose
compiler boundary includes `@cloudflare/workers-types`, DOM types, and
`skipLibCheck` for provider declarations. Add
`test/pull-request-rest.test.ts` to that project's explicit include list while
leaving the root Node project boundary unchanged.

The repository gate runs both the normal Worker-test typecheck and
`qualification:worker-test-boundary`. The qualifier copies the exact REST test
to a temporary probe, injects one intentional type error, and requires the
Worker-test compiler to reject that named error before deleting the probe.
This proves inclusion without committing a failing fixture or weakening the
strict project.

## Consequences

- The Pull Request REST test is covered by a strict repository-gate tsc path.
- Node-only tests retain their existing module/type boundary.
- New Worker-facing tests must be added to `tsconfig.worker-tests.json` and
  receive the same intentional-error boundary qualification.

## Receipt

- Baseline `typecheck:worker-tests` and the intentional-error probe both pass.
- Full tests, package smoke, and Worker smoke remain repository-gate checks.
