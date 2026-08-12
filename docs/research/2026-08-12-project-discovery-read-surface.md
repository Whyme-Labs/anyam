# Project discovery read-surface qualification

This note records the private-alpha boundary implemented for [Wayfinder ticket
157](https://github.com/Whyme-Labs/anyam/issues/157).

`GET /api/projects` is an owner-authenticated, read-only discovery route. The
edge forwards the validated kernel session to the dedicated Coordinator
`project.list` query rather than reading `/authority/state`. The Coordinator
sorts Project identifiers using deterministic code-unit ordering and returns
the same summary shape as `GET /api/projects/{projectId}`: Project, canonical
Project Revision, visible Source Spaces, and project-scoped counts.

No pagination or quota number is claimed before a representative workload
receipt exists. The response contains no kernel sessions, tokens, credentials,
or hidden resources. Missing authentication and unsupported methods fail
closed with typed receipts.

`test/worker-entrypoint.test.ts` covers owner authentication ordering,
Coordinator binding, stable ordering, credential-free output, and unsupported
methods. The route is also included in the deployable Realm Worker bundle
contract.

REST mutations, source transfer, task grants, public discovery, search, and
the web console remain separate Wayfinder boundaries.
