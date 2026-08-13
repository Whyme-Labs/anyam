# Anyam credible-team control room prototype

Throwaway UI prototype for Wayfinder ticket **Prototype the credible-team control room and adoption workflow**.

It answers one question: which control-room shape helps a technical team move from Project creation through Change, review, verified Release, Promotion, recovery, and export without hiding canonical authority or public/private disclosure?

Run it with one command from the repository root:

```bash
npm run prototype:control-room
```

Open [http://127.0.0.1:4321/?variant=A&role=team](http://127.0.0.1:4321/?variant=A&role=team).

Variants are deliberately structural:

- `variant=A` — Change room: narrative work surface centred on the active Change.
- `variant=B` — Operations board: dense source-to-Target pipeline for a team operator.
- `variant=C` — Project graph: authority and disclosure traced through the state transition.

Use `role=solo` or `role=team` to compare progressive ceremony. The fixed bottom switcher supports arrows and keyboard `←` / `→`; the URL is shareable. Buttons mutate only in-memory prototype state and expose receipts, failures, rollback, mirror state, agent capabilities, and disclosure boundaries. Reloading resets the state. No provider, credential, repository, or deployment is touched.

The local port is a developer convenience for the prototype, not an Anyam product limit or support claim.
