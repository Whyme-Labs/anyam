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
rejected qualification or registration cannot leave an observed start. A persisted
Session without its live broker boundary still fails closed: a separate
`workspace exec --session ...` CLI process cannot resume that Workspace. This
existing path remains unqualified and requires authorized live broker selection.
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
