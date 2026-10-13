# Git disclosure and exact-revision changed-path experiment

This slice qualifies the existing independent public Git object graph and measures one local server-side changed-path query. It follows the metadata-query idea in [Anthropic's source-control account](https://www.anthropic.com/engineering/redesigning-source-control), without inferring that Anyam has Anthropic's workload or needs its VCS architecture.

## Git disclosure proof

`npm run qualification:git-disclosure` includes the existing public identity and private-source exclusion regressions plus real Git checks of upload-pack advertisement, branches, annotated tags, root commit parents, trees, every object in complete cloned history, and crafted stateless requests for known private commit/tree/blob/tag IDs. The independent public repository rejects those requests even when the owned fixture server deliberately permits known-OID wants. An authorized public commit request succeeds.

The known-bad control uses a mixed canonical repository with private history, a public tip that deletes the private file, hidden private refs/tags, and deliberately permissive `uploadpack.allowAnySHA1InWant`. Advertisement and crafted fetch use the same hiding configuration. Returned packs are actually indexed in new owned bare receivers, and `cat-file` verifies the requested objects, including the synthetic private blob. This demonstrates the unsafe control; it is not a reproduced vulnerability in the current independent-public-repository implementation. Packet requests follow [Git's pack protocol](https://git-scm.com/docs/gitprotocol-pack).

The fixture's public snapshot identity derives from the authorized public tree, rather than a mixed canonical commit whose ancestry can change with private activity. Git children use isolated environments, and actual public materialization runs through the existing materializer/driver in an isolated Node child. All repositories and object receivers are synthetic owned temporary directories.

## Read experiment boundary

The prototype is under `scripts/experiments/`. Its local endpoint accepts one enrolled repository and two full immutable commit object IDs, checks repository/Source-bound read credentials and current Source authority before reading and again before releasing the response, and reports changed paths using byte-preserving base64 of Git `-z` output. Branch names, abbreviated IDs, revision expressions and non-commit objects are rejected. Moving a branch or adding replacement refs cannot alter an exact query. Inherited repository, object and config selectors are removed; replacement-object interpretation is disabled. External diff/textconv and rename inference do not execute.

Hidden Sources, absent repositories, absent commits and known private object IDs return the same HTTP 404 `not_found` body. Warm queries revalidate Source policy and credential revocation; revocation during a query withholds its result. Responses use `Cache-Control: no-store`, with no CPU/timing data or result cache. This qualifies response shape and authorization behavior, not constant-time noninterference. Current Realm integration, durable credential qualification and live providers remain outside this local experiment. Previously disclosed Git clones remain readable after prospective distribution revocation.

Production SmartHttpRepositoryDriver continues to clone/fetch and compute local diffs. The experiment is not exported by the product entry point or wired into a production route. Change/Evidence/Landing behavior is unchanged.

## Measurement

The [raw receipt](receipts/2026-10-13-exact-revision-query.json) contains all fifteen observations, exact fixture commits/trees, Git/Node versions, and SHA256 hashes of the benchmark, query and Git-environment source files. Inputs are base `8468763de1d7201d06b99a3736e3590619866b16`, head `b5a33bad5f0a6f1f39697de730c5b8df7fddebb8`, tree `93b06b8eec3a13e7ee7793553388ba446570966a`. The synthetic workload starts with 64 files totaling 262144 bytes, makes 8 commits affecting 8 files, and has 9 commits in all.

Real HTTP loopback uses the existing Smart HTTP gateway and `git http-backend`. There are 3 observations per row, with alternating method order. “Fresh” means no client clone. OS/server filesystem caches were not flushed and were likely warm from fixture construction. Host scheduling was not isolated from other approved tasks on this Mac; these wall-time samples include that uncontrolled contention. “Existing” retains the clone; both optional fetch+diff and already-local immutable diff are reported. The query has no result cache. These are bounded local observations, not scale, WAN, cloud-cost or production throughput results.

| Condition / operation | Median latency ms | Request / response body bytes | Median combined Node CPU ms | Median client / server Git CPU ms |
|---|---:|---:|---:|---:|
| fresh-client / clone-local-diff | 177.74 | 406 / 154162 | 8.896 | 30 / 40 |
| fresh-client / server-query | 38.55 | 126 / 482 | 2.738 | 0 / 0 |
| existing-clone / fetch-local-diff | 107.96 | 213 / 283 | 5.975 | 20 / 0 |
| existing-clone / local-only-diff | 43.70 | 0 / 0 | 1.842 | 0 / 0 |
| existing-clone / server-query | 56.38 | 126 / 482 | 2.529 | 0 / 0 |

Bytes count HTTP entity bodies only, excluding headers, TCP/TLS overhead and checkout disk size. Client and server Node CPU share one process and are reported together. Git child CPU uses `/usr/bin/time -p`, whose centisecond rounding means reported 0 is not zero CPU; these samples do not justify a precise CPU speedup claim.

The query avoids repository transfer for a fresh review-only client. An existing clone already containing both exact revisions computes the same result locally with zero network transfer and slightly lower latency here. Fetch+local diff has different freshness/authority work, so it is shown separately. The evidence supports retaining a narrow query prototype, not replacing Git clients or adding a VCS/index framework.

To reproduce, run `npm run experiment:exact-query -- /tmp/anyam-exact-query-new.json` with a new owned output path. It uses only synthetic loopback resources, writes with exclusive creation, and removes its temporary repositories and owned servers. No paid Artifacts trial, deployment, new live credentials, external model call or canonical mutation is involved.
