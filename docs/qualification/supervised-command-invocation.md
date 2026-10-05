# Direct command identity and supervised process custody

`runWorkspaceCommand` treats a direct executable and its argument array as
separate values. It never turns direct arguments into shell text. Spaces,
quotes, empty arguments, option-looking arguments and shell metacharacters
remain literal arguments. With configured enforceable executable paths, the
requested executable must resolve to one of those paths; another configured
executable is never substituted. This does not broaden existing sandbox mounts.

Explicit `shell: true` execution accepts one shell command string and rejects
separate arguments before starting a process. Results record the actual workload
interpreter and its arguments, `shell`, `commandMode` and the canonical invocation
digest. Host isolation wrappers are identified by the boundary receipt. Existing
stream fingerprints continue to hash their canonical JSON string representation.

The local CLI parses only options before the executable separator for `agent
exec` and `workspace exec`. Child options cannot select a different Anyam agent,
Project, Session or Workspace mode. Launch JSON omits the trusted runtime
environment, which can contain host credentials in supervised mode. This does
not redact arbitrary output deliberately printed by a developer's own command.

Agent launch snapshots command and arguments before asynchronous session setup.
Completion audit records use the observed invocation, rather than mutable caller
intent, and use the actual selected boundary mode. Start audit occurs after
successful process creation and registration, and labels requested invocation and
pre-release phase explicitly;
rejected qualification or registration cannot leave an observed start.
On POSIX hosts, `workspace exec --session ...` sends an owner-local command
request to the already running stdio broker for that exact Session. The broker
retains its live Workspace boundary and rechecks the binding, current Session,
Grant, expiry and mode; the CLI receives no runtime environment. The endpoint
locator is non-secret metadata, protected by owner-only filesystem permissions,
not a credential or a restored boundary. This owner CLI handoff adds no raw
execution tool to the semantic MCP surface. It inherits the command deadline
and provisional byte budget, without claiming measured production capacity.

A persisted Session without its live broker boundary still fails closed.
After broker death, revoke that interrupted Session and explicitly start a fresh
scoped broker; neither the CLI nor a restarted broker recreates execution
authority from saved metadata. Concurrent execution within one Session is
refused so that command custody cannot overwrite an existing process record.
Focused macOS subprocess qualification covers fresh owner CLI execution,
sibling denial, Session and Grant expiry, revocation, broker death, explicit
fresh-session recovery, rejected-frame cleanup and shared CLI/MCP process
custody. The enforceable handoff retains its Source projection and protects
canonical and sibling paths. Linux handoff was not exercised by this macOS
qualification; Windows local socket handoff remains unqualified.
POSIX supervised commands use the existing trusted custodian and their
own process group. Registration releases the workload; exit, timeout, output
overflow, revocation or parent-pipe loss cleans the owned group. Custody does not
upgrade filesystem, credential or network enforcement. Supervised mode remains
`enforcement=none`, `networkEnforcement=not-enforced` and
`credentials=ambient-host-not-enforced`. Windows remains on the direct-child
supervised lifecycle and is not qualified for POSIX group custody.

Run the harmless local checks from an isolated checkout:

```sh
npm ci --ignore-scripts
npm run typecheck
node --import tsx --test --test-concurrency=1 test/workspace-command.test.ts test/agent-cli.test.ts test/mcp-process-isolation.test.ts
npm run build
```

The command suite observes real Node/shell subprocesses, actual literal argv,
executable identity, exit status and stream fingerprints. It injects spawn and registration
failure, a deliberately short timeout and an overflow of the existing output
budget. Cancellation creates only owned fixture descendants and peers. CLI
integration uses synthetic Projects and a fake host credential; the default
enforceable mode cannot be downgraded by a child `--mode supervised` argument.
The existing enforceable hostile-process and revocation suites remain required.

These checks do not invoke a model, change login state, copy subscription auth,
configure live credentials or contact a Cloudflare account. A harmless process
success does not qualify a subscription-backed native Agent, model egress,
production resource sizing, hosted authority or live provider custody. The
existing timeout/output policies retain their provisional measurement receipts.
