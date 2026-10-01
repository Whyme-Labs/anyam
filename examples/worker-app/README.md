# Anyam example Worker app

This Project is a small TypeScript Worker with a health route. It shows the
local source, test, build, and Target path without requiring a Cloudflare
account.

## Run it

```bash
npm install
npm run check
```

The build writes `dist/index.js`. The test invokes the compiled Worker and
checks both `/health` and `/`.

To run it locally with Wrangler, install Wrangler in your project and use the
checked-in `wrangler.jsonc`:

```bash
npx wrangler dev --local
```

The configuration disables public `workers.dev` deployment by default. Add a
customer-owned route only when you are ready to run a provider qualification.

This example proves local behavior. It does not provide D1, R2, Queue, or
Durable Object bindings, and it does not claim a live Cloudflare release.
