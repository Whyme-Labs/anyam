# Disclosed writes and owner Run detail

`POST /api/authority/view-command` accepts human-authenticated Source operations
using the current disclosed Project/Workspace/Change Revision selector. A
selector expresses intent; it never grants authority. The Coordinator resolves
exact canonical IDs internally and requires a current Task, Capability Grant,
role and explicit Source-policy allow for `source.read` and the actual write
capability on every contributing Source. A cached acceptance receives these
checks again. A restricted human does not need an owner recovery export.

Send `{command, idempotencyKey, payload}`. The host Session comes from the
authenticated cookie. The optional `protocol` is `anyam.authority-command/v1`.
Creation IDs are server-assigned. Incoming Source writes are credential-scanned
and matched against retained Realm token digests, including opaque string/key
aliases and one URI/base64 encoding layer (valid encoded spans remain checked
amid malformed surrounding URI text; native Base64 ASCII whitespace is allowed),
after current authorization and before persistence. Canonical/View IDs, `expectedVersion`, caller
Task/Grant IDs and unknown fields are rejected. The supported payload fields are:

| Command | Required selectors | Optional inputs | Capability |
| --- | --- | --- | --- |
| `workspace.create` | `projectId`, `projectViewRevisionId` from Project read | `sourceSpaceIds` (defaults to readable Sources), `mounts`, `classification` | `workspace.write` |
| `change.create` | `projectId`, `workspaceId`, `baseProjectViewRevisionId` from Workspace read, currently disclosed `intentId` | none | `change.publish_revision` |
| `revision.publish` | `projectId`, `workspaceId`, `changeId`, `baseProjectViewRevisionId`, exact selected `sourceSpaceSnapshots` map | `declaredEffects`, `kind`, `expectedSymbolicRef` | `change.publish_revision` |
| `run.request` | `projectId`, `workspaceId`, `changeRevisionId`, `projectViewRevisionId` from the published Revision, `actionId` | `actionContractDigest`, `verifierId`, `verifierContractDigest`, `inputDigests`, `effectDigests`, `dependencyDigest`, `toolchainDigest`, `environmentDigest` | `run.invoke` |

Replies use the current ordinary disclosure DTO. Workspace and Change return
their read DTO; publication returns `{change, revision}`; Run request returns
`{run}`. No global version, canonical/View ID, raw receipt, private Source
count, grant or Session is returned. Missing and inaccessible resources share a
constant 404. Invalid fields return 422; stale visible context or a changed
accepted payload returns a safe 409. Observer/storage failure returns a safe
503. Read the disclosed context again to recover from visible staleness.

Audience-safe revisions can represent several exact canonical revisions.
Fresh requests resolve the current canonical revision when visible state
matches. Hidden-only changes do not affect the public selector or response.
Accepted retries keep the original exact resolution; they skip repository
observation and persist no new Task/Grant or Authority state. Their replies
remain current disclosure projections, so later visible lifecycle changes may
appear. Revocation always takes precedence over a prior acceptance. Caller
idempotency keys are internally scoped to principal, operation, Project,
Workspace, visible Source scope and incoming selector. Denied writes cannot
probe payload conflicts. SQL, identity KV and in-memory policy roll back on a
failed first acceptance. In-memory rollback retains unrelated live credential
digests; credential-free recovery exports remain a distinct hydration boundary.

`GET /api/authority/run-details/{encodedRunId}` has a fixed versioned
`anyam.owner-run-detail/v1` contract. Its audience is an active human Realm-wide
owner with complete current Source access and current Run `evidence.read`
authority. A Project owner or a reader of all Project Sources is insufficient.
Unsigned legacy records, malformed/tampered proof and inaccessible/nonexistent
records return the same 404. Unexpected verification/storage failure returns a
coordinate-free 503.

The detail is created only when Authority accepts a trusted Runner completion.
Acceptance closes exact producing View/Revision Source snapshots and verifies
the enrolled signature, attempt context, output binding and result digest.
SQLite stores the signed result, Job, Attempt and enrolled public profile. Each
detail read verifies current bindings and signature again. The response emits
signed action/verifier identities and contracts, Job/Attempt/Runner identity,
input-manifest digest reference, Source snapshots, input/output digests and
verified result digest. Actor/Session/Grant/credential handles, public key,
unsigned environment/dependency/toolchain metadata, raw logs, provider receipts
and network-boundary receipt are omitted. The common credential scanner rejects
credential material before accepted proof is stored and before detail is
projected. The Coordinator also matches known opaque Realm token aliases before
request/proof persistence and detail projection without validating or modifying
those credentials. Unknown arbitrary secret strings cannot be recognized by
these checks. Direct, embedded and single URI/base64-layer aliases of known Session handles in
otherwise typed strings are denied as well, including known Grant/passkey
handles and Runner credential digests. Ordinary REST/MCP Run reads remain
coarse even when an accepted detail exists.

This is accepted signed context for an owner. It does not recompute the body
behind the opaque input-manifest digest, prove artifact bytes, attest a real
process/network sandbox, publish a Sealed Verifier, implement external
invocation/opt-in/appeal, or approve a private Intent/Mirror/Promotion projection.
Public Sealed Verifier contracts from ADR 0004/0032 remain a separate product
gap. Raw legacy commands for the four Source operations are owner-only and now
also require current per-Source kernel read/write authorization over the full
Project/Workspace/Change/Run context derived from Authority records. Omitting a
caller binding never removes a scoped deny.
Workspace-less Changes authorize every Source in their actual base revision;
an unused caller View cannot narrow that scope. Their first
acceptance commits identity and SQL together, and cached results are checked
under current permissions without persisting a new Task/Grant or repeating
repository observation. The first accepted prepared command and original
request digest are retained. Older unmarked fingerprints cannot prove an
unnormalized pre-observation request; only their exact prepared envelope is
replayable, otherwise a safe conflict requires a fresh request. This
exact replay derives older generated Workspace/Change/Run IDs from the accepted
result while retaining the original fingerprint unchanged. This
qualification does not claim disclosure-safe output for every legacy mutation.
Signed recovery includes the new proof collection. Previously signed snapshots
that lack that additive collection verify unchanged before normalization to an
empty collection; this does not fabricate proof for older Runs.

## Local qualification

- `npm run qualification:disclosed-writes-local` runs selector property checks,
  signed-completion regressions and the actual public API lifecycle in local
  workerd/Coordinator SQLite.
- `npm run qualification:disclosure-local` retains ordinary REST/MCP read,
  projection and current-revocation coverage.
- `npm run typecheck:worker-tests` covers the exact Worker fixture;
  `npm run qualification:worker-test-boundary` verifies that boundary by
  intentional failing source-copy probes.
- `npm test` includes the Node orchestration harness and all these regressions.

The runtime uses owned temporary storage, synthetic authenticated contexts and
repository observation, actual kernel authorization and SQL/KV transactions,
real Ed25519 signatures, synthetic Runner results, denied outbound requests and
disabled telemetry. It verifies a public single-Source lifecycle inside a
two-Source Project, accepted retries after hidden canonical activity, denied
cached writes, rollback after actual SQL/KV writes, owner detail revocation,
proof tampering, credential strings and known opaque request/signed-proof aliases,
scoped denies with caller IDs omitted, timestamp-changing legacy publication
retries, signed protected-handle aliases, retention
of unrelated live credential digests, signed current/legacy recovery and
authorized multi-Source Workspace
creation with public observation unchanged. Node orchestration `.mjs` is run,
not covered by Worker TypeScript. No live credential ceremony, Git provider,
paid model, deployment or production write is qualified by this fixture.
