import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Public Gateway moderation has no static administrator-token path", async () => {
  const source = await readFile(new URL("../apps/public-gateway-worker/src/index.ts", import.meta.url), "utf8");
  const config = await readFile(new URL("../apps/public-gateway-worker/wrangler.example.jsonc", import.meta.url), "utf8");
  assert.equal(source.includes("ADMIN_TOKEN"), false);
  assert.equal(config.includes("PUBLIC_GATEWAY_REALM_AUTHORITY"), true);
  assert.equal(source.includes("x-anyam-realm-session"), true);
  assert.equal(source.includes("PUBLIC_GATEWAY_REALM_SERVICE_SECRET"), true);
});
