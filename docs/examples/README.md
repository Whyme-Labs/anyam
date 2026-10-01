# Anyam examples

The examples are small Projects that a developer can clone, install, check,
test, build, and inspect. They demonstrate product workflows. The `fixtures/`
directory remains reserved for deterministic contract and provider
qualification inputs.

## Runnable examples

| Example | What it shows | Start here |
| --- | --- | --- |
| [Worker app](../../examples/worker-app/README.md) | TypeScript Worker source, a test, a build, and a Worker Target | `cd examples/worker-app && npm install && npm run check` |
| [TypeScript CLI](../../examples/typescript-cli/README.md) | A non-web command-line Project with a compiled release asset | `cd examples/typescript-cli && npm install && npm run check` |
| [Hybrid video player](../../examples/hybrid-video-player/README.md) | Local entry-point projection with private-code marker checks | `cd examples/hybrid-video-player && npm install && npm run check` |

Every example keeps credentials and provider identifiers out of source. The
commands prove local behavior. They do not claim a live Cloudflare deployment.

## Qualification fixtures

These inputs belong to the repository gate and the team simulation:

- [`fixtures/worker`](../../fixtures/worker/README.md) is a minimal Worker
  contract fixture.
- [`fixtures/typescript-library`](../../fixtures/typescript-library/README.md)
  is a minimal non-web contract fixture.
- [`fixtures/hybrid`](../../fixtures/hybrid/README.md) is a disclosure fixture.
- [`fixtures/worker-golden`](../../fixtures/worker-golden/README.md) is a
  provider-shape fixture with D1, R2, KV, Queue, Workflow, service binding,
  Durable Object, migration, assets, and scheduled execution.

The golden fixture requires customer-owned disposable resources for live
qualification. Run it only with the owner-operated configuration described in
its README. A local build or HTTP response does not prove provider fidelity.

## Team simulation

Run the local multi-actor simulation from the repository root:

```bash
npm run qualification:team-simulation
```

The simulation uses temporary Git repositories and covers Worker and CLI
Projects, branch conflicts and rebases, reviews, Landing, hybrid disclosure,
bidirectional mirror proposals, Intent and Pull Request lifecycle, and
export/restore. It reports `cloudflare=not-run` by design.
