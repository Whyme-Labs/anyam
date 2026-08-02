# Anyam end-to-end developer experience prototype

Throwaway Wayfinder prototype for issue #18. It explores how a Project feels
from active Change through preview, review, landing, release, Promotion, and
rollback without making Source Spaces, grants, or Evidence top-level clutter.

## Run

From the repository root:

```bash
node prototypes/end-to-end-dx/server.ts
```

Open:

```text
http://127.0.0.1:4321/prototype/end-to-end-dx?variant=A&role=team
```

The port can be changed for local use with `ANYAM_PROTOTYPE_PORT`. This is a
local prototype setting, not a product limit.

## Compare the variants

- `variant=A` — Control room: dense project rail, active Change, attention, and
  production state.
- `variant=B` — Lifecycle timeline: Intent → Workspace → Candidate → Release →
  Target, with the next transition made obvious.
- `variant=C` — Terminal-first: familiar command history for technical users,
  with release and governance state beside it.

Use the fixed bottom switcher, or the left/right arrow keys. Choose a role with
`role=solo`, `team`, `contributor`, `maintainer`, `reviewer`, or `operations`.

The buttons are intentionally non-mutating. The prototype is for choosing the
information architecture and ceremony, not testing the production API.
