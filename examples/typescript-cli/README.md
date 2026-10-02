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

The build writes compiled JavaScript release files under `dist/`. The tests
import the compiled library and check its stable output. This example does not
create a package archive; archive packaging remains unimplemented.

The manifest declares a `generic.release-assets` Target accepting the
`package.archive` Artifact type as a planned delivery contract. The compiled
files do not satisfy that archive contract, and no registry or release upload
is qualified by this example.
