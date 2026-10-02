# Anyam site

This package builds the Anyam marketing, documentation, and example site.
It is a static asset bundle served by a small Cloudflare Worker. The Worker has
no application data, credentials, or provider authority.

## Build locally

From the repository root:

```bash
npm run build:site
```

The generated `dist/` directory contains the landing page, documentation,
examples, brand assets, and a 404 page. Guide and example articles render from
their Markdown files; edit those sources instead of duplicating article HTML.
The documentation and example index pages are curated summaries in
`src/build.ts`; reconcile their links when the canonical Markdown indexes change.
The small renderer supports headings, paragraphs, fenced code, lists, tables
and links, and escapes HTML. Run the site smoke check after the
build:

```bash
npm run verify:site
```

## Deploy in a customer account

The checked-in configuration keeps `workers_dev` disabled and expects a
customer-owned custom domain. Copy the example configuration, choose a
customer-owned Worker name, and deploy the already-built static bundle:

```bash
cp apps/site/wrangler.example.jsonc apps/site/wrangler.jsonc
npx wrangler deploy --config apps/site/wrangler.jsonc --domain anyam.whymelabs.com
```

The `whymelabs.com` zone must already be added to and proxied by the customer
Cloudflare account. Wrangler cannot attach a custom domain that is not in the
account.

For a temporary public preview before the custom domain is ready, copy
`wrangler.preview.example.jsonc` instead:

```bash
cp apps/site/wrangler.preview.example.jsonc apps/site/wrangler.preview.jsonc
npx wrangler deploy --config apps/site/wrangler.preview.jsonc
```

That deployment uses the account's `workers.dev` hostname. Treat the URL as a
preview receipt, not the product's canonical domain. Keep the site Worker
separate from the Realm Worker and from untrusted application previews.
