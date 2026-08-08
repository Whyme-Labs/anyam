# Anyam post-P3 control-plane prototype

Throwaway UI prototype for [Prototype the post-P3 customer control-plane and onboarding journey](https://github.com/wms2537/anyam/issues/125).

Run it from the repository root:

```bash
npm run prototype:control-plane
```

Then open <http://127.0.0.1:4321/>.

The prototype explores one technical-user-first journey:

```text
Connect Realm → Create Project → Configure Source/Target
→ Connect Agent → Review Change → Release/Deploy
```

The **Technical** and **Agent-assisted** modes change the language and entry
point without creating separate product models. State is intentionally held in
memory and resets when the page is refreshed. This branch is disposable; no
production UI or API contract should be inferred from it without a follow-up
decision.
