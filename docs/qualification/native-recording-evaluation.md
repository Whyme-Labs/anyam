# Inspect a recorded native Codex session

The local CLI can compare a preserved Codex `exec --json` recording with one
explicitly selected thread and a committed Git candidate:

```sh
anyam agent evaluate-recording \
  --recording /owned/evidence/codex-events.jsonl \
  --thread '<recorded thread ID>' \
  --base-commit '<full baseline commit ID>' \
  --candidate-commit '<full candidate commit ID>' \
  --directory /owned/candidate-checkout \
  --json
```

The candidate checkout must be clean and its HEAD must equal the selected
candidate. The baseline must be an ancestor. Keep the recording outside that
checkout, or in its ignored metadata directory. If the checkout moved, add
`--recording-root /original/workspace/path` to resolve recorded absolute file
paths against the original workspace rather than the new checkout.

The report binds the exact recording byte digest, selected/observed thread
digests, candidate commit/tree and observed Git diff paths. It requires one
thread and one completed turn, rejects replayed or incomplete events and
requires every committed changed path to have a completed file-change event.
Intermediate logged edits may have been reverted before commit, so extra
logged paths remain visible without being treated as committed edits. Edits
made through shell commands without file-change events remain unrecorded and
block the match; inspect those separately rather than inventing file events.

A truncated, failed, peer-thread, dirty-source, wrong-HEAD or unrecorded-change
result is `blocked` with exit code 1. A structurally consistent observation is
`matched` with exit code 0. Nonfatal item warnings and failed commands remain
explicit counts: a completed model turn does not mean every command passed.
Unknown top-level event formats block until their adapter semantics are
understood. Raw messages, commands, outputs and warning/error bodies are not
copied into the report.

This is read-only inspection. It does not start a harness, create an Anyam
session, consume model quota or change Git refs. It does not authenticate the
recording, prove model origin or establish that logged edits produced the
candidate bytes. Candidate correctness still needs the declared Verifier and
exact Run/Evidence provenance. Git state is checked at the inspection
boundaries; hostile concurrent filesystem replacement is not isolated.

Recorded-session inspection can support the receipts collected for
[#286](https://github.com/Whyme-Labs/anyam/issues/286). It cannot satisfy the
real-team adoption gate, native MCP integration, a concurrent two-product
cohort, live provider qualification or production readiness. The command
currently interprets the single-turn Codex JSONL format; other native harness
formats require their own measured adapter and tests.
