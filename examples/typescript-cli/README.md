# Anyam example TypeScript CLI

This Project is a small non-web TypeScript library with a command-line entry
point. It shows that Anyam Releases do not require a web runtime.

## Run it

```bash
npm install
npm run check
node dist/cli.js greet Anyam
node dist/cli.js version
```

The build writes a package archive shape under `dist/`. The tests import the
compiled library and check its stable output.

The example uses the `generic.release-assets` Target in `anyam.json`. A package
registry or binary publisher can replace that Target without changing the
Project, Change, Evidence, or Release model.
