# Anyam project manifest, Action, and Verifier contract prototype

Throwaway Wayfinder prototype for issue #19. It tests the smallest portable
contract that can describe modules, Actions, inputs, outputs, network,
resources, Verifiers, Artifacts, and Targets without making an explicit YAML
manifest mandatory.

The prototype compares two reference Projects:

- a Cloudflare Worker, detected from `package.json`, `wrangler.jsonc`, and
  `src/index.ts`;
- a Rust CLI, detected from `Cargo.toml`, `Cargo.lock`, and `src/main.rs`.

It exercises zero-config detection, explicit overrides, identical local and
remote Action plans, Verifier results, Target adapters, and migration from a
small `anyam.project/v0` shape into `anyam.project/v1`.

## Run

Interactive TUI:

```bash
node prototypes/project-manifest-contract/cli.ts
```

Non-interactive walkthrough:

```bash
node prototypes/project-manifest-contract/cli.ts --demo
```

The model is in `model.ts`; the terminal shell is intentionally disposable.
