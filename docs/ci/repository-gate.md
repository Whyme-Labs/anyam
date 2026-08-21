# Repository gate

The repository gate is a provider-replaceable CI projection. Anyam's canonical
authority is in the repository and customer-operated control plane, not in a
GitHub or Blacksmith runner.

## Local gate

Run the same checks that the remote workflow runs:

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` begins with:

- `npm run check:ci-hygiene`, which rejects workflow actions that are not pinned
  to full commit SHAs and requires an explicit top-level permissions block.
- `npm run check:dependencies`, which runs `npm audit --audit-level=high`.

The dependency receipt must be kept with the gate result. Do not replace a
failed audit with a silent allow-list or a production-only scan.

## Remote provider selection

The default is GitHub-hosted `ubuntu-latest`. If the organization has installed
the Blacksmith GitHub integration, set this repository variable:

```text
ANYAM_REPOSITORY_GATE_PROVIDER=blacksmith
```

The workflow then uses the fixed Blacksmith label
`blacksmith-2vcpu-ubuntu-2404`. A manual `workflow_dispatch` run can select
`blacksmith` without changing repository state. No Blacksmith credential is
stored in the repository.

Blacksmith requires an organization integration; it is not available for
personal repositories. If the integration is absent, a Blacksmith run is a
provider setup failure, not evidence that the Anyam gate is broken.

## Receipts

Every remote run records:

- the selected provider and runner identity;
- the exact `GITHUB_SHA` checked;
- the run id and operating system/architecture; and
- `credentialMaterialStored=false`.

When a job is rejected before it starts, capture the check annotation and keep
it separate from source/test results. On 2026-08-20, the GitHub provider
returned a billing/spending-limit rejection before any step ran. That explains
the old red check; it does not establish a repository failure.

## Bounded review stacks

Future authority-bearing work follows the stack map in
[`ADR 0071`](../adr/0071-bounded-repository-gates.md). The historical PR #135
is already merged, so the map is enforced prospectively rather than by
rewriting published history.
