# Try the local CLI and review packet

Use a clean source checkout with its locked dependencies installed. Build the
local package, then invoke its entrypoint directly so this walkthrough uses the
checked-out implementation rather than an unverified published package:

```sh
npm run build
task_anyam_cli="$PWD/packages/create-anyam/dist/anyam.js"
anyam() { node "$task_anyam_cli" "$@"; }
task_anyam_demo="$(mktemp -d /tmp/anyam-review-demo.XXXXXX)"
export ANYAM_STATE_HOME="$(mktemp -d /tmp/anyam-review-state.XXXXXX)"
anyam init "$task_anyam_demo" --type library
cd "$task_anyam_demo"
```

These commands create new disposable source and session-state directories.
The reference verifier needs only Node's built-in assertions:

```sh
node --input-type=module <<'NODE'
import {readFileSync, writeFileSync} from 'node:fs';
writeFileSync('src/value.mjs', 'export const value = (a,b) => a+b;\n');
writeFileSync('verify.mjs', "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value(2,3),5); assert.equal(value(-2,3),1);\n");
const manifest = JSON.parse(readFileSync('anyam.json', 'utf8'));
manifest.modules[0].actions = [{id:'action:verify', command:'node verify.mjs', inputs:['src/value.mjs','verify.mjs'], outputs:[], network:[], resources:{}}];
manifest.verifiers = [{id:'verifier:verify', actionId:'action:verify', disclosure:'full', requiredFor:['release']}];
writeFileSync('anyam.json', JSON.stringify(manifest,null,2)+'\n');
NODE
git add .
git -c core.hooksPath=/dev/null -c user.name="Anyam Reference User" -c user.email=fixture@anyam.invalid commit -m "Initial reference Project"
anyam doctor
anyam change start "Verify the local candidate" --json
anyam mcp serve --stdio --agent cli --mode supervised
```

Manifest configuration never grants execution authority. Commit the source
before starting the Change so publishing and verification bind an exact Git
revision.

The title is preserved exactly after trimming. A missing title is an error;
no Change metadata or agent session is created.

Send one JSON-RPC object per line to the broker's stdin:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"workspace.inspect","arguments":{}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"change.publish_revision","arguments":{"declaredEffects":["source.modify"]}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"run.start","arguments":{"actionId":"action:verify"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"change.inspect","arguments":{}}}
```

Inspect `result.structuredContent` in
each response. `change.inspect` includes `reviewPacket`, with exact recorded
candidate Git commit/tree, scoped Run/Evidence references, and local check
status. A newer published commit makes the prior source observation stale;
rerun the declared Action against the intended committed candidate. A failed
verifier remains failed. Neither outcome changes a canonical Git ref.

This fresh broker owns its live session boundary. A session persisted by an
earlier CLI process cannot be resumed by `mcp serve --session` if that broker
has no live boundary; it fails closed. Use `workspace.inspect`'s `sessionId`
to revoke this exact session after capturing the packet. Exit the broker with
EOF, then run this in the same shell, preserving its isolated state directory:

```sh
anyam agent revoke --session '<sessionId>' --directory "$task_anyam_demo"
```

Revocation also denies further calls if performed while that broker is live.
Afterward remove only the two disposable directories you created, and unset
`ANYAM_STATE_HOME` when finished. The local regression journey verifies live
revocation denial, failed verifier observations and stale-source rejection.

This walkthrough uses the supervised owner-local lane, which does not enforce
restricted-source isolation. It invokes no coding harness or hosted provider.
The local packet does not evaluate full Evidence validity, review policy or
Landing approval. The separately runnable
[Cohort verifier qualification](cohort-local-verifier.md) exercises enforceable
verifiers and durable internal Landing fixtures; it does not add a public
Landing route. Native coding harnesses, production provider fencing, live
Cloudflare Artifacts and human adoption remain independently unqualified.
