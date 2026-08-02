# Extension and ecosystem prototype

PROTOTYPE — throwaway code for issue [#33](https://github.com/wms2537/anyam/issues/33), not production Anyam.

Question: can third-party Repository Drivers, Actions, Verifiers, Target
adapters, project experiences, IDE integrations, agent skills, and installed
Apps be discovered and governed without becoming kernel authority or requiring
a marketplace?

Run the deterministic walkthrough:

```bash
bun prototypes/extension-ecosystem/cli.ts --demo
```

Or drive it interactively:

```bash
bun prototypes/extension-ecosystem/cli.ts
```

The prototype tests a signed/digested manifest, project-scoped installation,
narrow grants, proposal-only Target authority, and deprecation/revocation. It
keeps distribution as an installable package/reference rather than assuming a
marketplace.
