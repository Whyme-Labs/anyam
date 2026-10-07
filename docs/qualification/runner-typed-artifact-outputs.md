# Typed Runner Artifact outputs

Actions can declare a versioned, path-specific Artifact contract:

```json
{
  "outputs": ["dist/worker.js"],
  "artifactOutputContract": {
    "protocol": "anyam.action-artifact-outputs/v1",
    "outputs": [{ "path": "dist/worker.js", "type": "worker.bundle" }]
  }
}
```

Each typed path must be an exact canonical relative Action output path. A
contract may select a subset of the Action outputs; only those paths produce
Artifacts. Types are extensible lowercase identifiers such as `worker.bundle`,
`worker.module`, `worker.wasm` and `package.archive`. Target adapters continue
to decide which types they can consume. New project scaffolds declare the
build Artifact path and type explicitly. Legacy Actions retain their existing
local module-type mapping and remote `runner.output` behavior.

`realm run request --input` and `run.request_from_view` accept the same optional
`artifactOutputContract` object. It is stored on the queued Run under the
current Source, Task and Grant checks. The Runner Job must carry that exact
contract from its normalized Action. The declaration enters the Action and
input-manifest digests and the signed Runner Result context.

A submitted Artifact reference carries `outputPath` as its logical Action
path, separately from `location` as its Run/Attempt storage key. The signed
Artifact digest must equal the normalized Action output digest for that path.
A succeeded Result supplies exactly one Artifact for each typed path; failed
and indeterminate Results may supply a partial set but never passed Evidence.
The Realm rejects contract drift, unsigned path changes, aliases, missing or
duplicate Artifact paths and digest mismatches before storage access. It then
independently retains and hashes the actual bytes using the existing trusted
Runner-output and promotion-Artifact bucket bindings.

Artifact type comes from the queued/signed declaration. Worker Release modules
use the logical path and retained digest, without rebuilding or treating an R2
key as a module filename. Release creation still requires the current canonical
Revision and passed Evidence. Sealing still enforces Target types and Evidence
requirements. A declaration or Runner signature grants no completion, Landing
or Promotion permission.

Local qualification exercises the real Realm handler, workerd, SQLite and
Miniflare R2, plus native CLI/MCP selector requests and offline Release-to-Worker
manifest continuity. Synthetic enrolled signing and provider substitutes do
not qualify a live Runner, Cloudflare storage, deployment or health result.
The library API without trusted custody bindings remains runner-attested;
production Realm completion requires byte custody before accepting an Artifact.

Reproduce the focused checks from a fresh checkout with `npm ci`, then:

```sh
node --import ./node_modules/tsx/dist/loader.mjs --test test/action-artifact-output.test.ts test/runner-typed-output.test.mjs test/execution-local.test.ts test/agent-cli.test.ts
node --import ./node_modules/tsx/dist/loader.mjs --test test/realm-artifact-handoff-runtime.test.mjs test/selector-cli-mcp-runtime.test.mjs
npm run check
```

Fixtures use owned temporary storage and dispose local runtimes. They deny
outbound provider access. Live qualification remains a separate customer-owned
operation with exact source, resource and provider receipts.
