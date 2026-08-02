# Phased delivery program prototype

**Throwaway prototype — not production Anyam code.**

Question being tested:

> Can a dependency-ordered Anyam delivery program be explained and advanced by explicit evidence and retired risk spikes, without speculative calendar commitments?

Run it with one command from the repository root:

```bash
bun run prototypes/phased-delivery/index.ts
```

Try this small path:

```text
start K0
evidence K0:local-loop
evidence K0:git-roundtrip
evidence K0:agent-loop
risk K0:r-kernel-model
risk K0:r-provider-boundary
promote K0
```

The frame shows the current status, gate blockers, owner, staffing assumption,
workstreams, integrations, evidence, risks, and critical path after every
action. The prototype intentionally keeps state in memory and has no dates,
provider calls, or persistence.
