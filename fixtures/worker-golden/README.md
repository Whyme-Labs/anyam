# Golden Cloudflare Worker Reference Fixture

This fixture is intentionally small in source size but complete in provider
shape. It contains:

- two JavaScript modules;
- static assets;
- a D1 binding;
- an R2 binding;
- a KV binding;
- a Queue producer and consumer;
- a service binding;
- a Durable Object class and migration;
- a scheduled trigger; and
- an Anyam Action that produces one sealed module/asset/migration set.

`wrangler.jsonc` uses placeholder resource identities. A live qualification
must replace them with disposable customer-owned resources and record the
exact read-back identities; this fixture does not claim that provider state is
created by a local check.

Use `live-config.example.json` as the non-secret input for
`npm run qualification:cloudflare-golden-path`. The qualifier creates only the
three prefixed disposable Worker scripts; the D1, R2, KV, Queue, Workflow,
service, and Durable Object resources must already exist in the customer
account.
