import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { main } from "../packages/create-anyam/src/cli.ts";

const connection = ["--realm", "https://realm.example", "--owner-session", "synthetic-owner"];

test("inline Intent comment values equal to option names remain unchanged text", async t => {
  const requests: { body: unknown; key: string | null }[] = [];
  const printed: string[] = [];
  t.mock.method(console, "log", (value: unknown) => printed.push(String(value)));
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, input?: RequestInit) => {
    requests.push({ body: JSON.parse(String(input?.body)), key: new Headers(input?.headers).get("idempotency-key") });
    return Response.json({ receipt: "intent=commented", comment: { id: "comment:owned" } });
  });
  for (const body of ["--body", "--body-file", "--resource-policy", "--json", "--dry-run", "--idempotency-key", "--realm"]) {
    const key = `comment:${requests.length}`;
    assert.equal(await main(["intent", "comment", "intent:owned", "--body", body, "--idempotency-key", key, ...connection]), 0);
    assert.deepEqual(requests.at(-1), { body: { body }, key });
    assert.equal(printed.at(-1), "COMMENT Intent: intent=commented", "a value equal to --json does not select JSON output");
  }
  assert.equal(requests.length, 7);
});

test("an option-valued idempotency key preceding a real body is preserved as the key", async t => {
  t.mock.method(console, "log", () => undefined);
  const requests: { body: unknown; key: string | null }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, input?: RequestInit) => {
    requests.push({ body: JSON.parse(String(input?.body)), key: new Headers(input?.headers).get("idempotency-key") });
    return Response.json({ receipt: "intent=commented" });
  });
  for (const key of ["--body", "--body-file", "--resource-policy", "--json"]) {
    assert.equal(await main(["intent", "comment", "--idempotency-key", key, "intent:owned", "--body", "Actual note\n", ...connection, "--json"]), 0);
    assert.deepEqual(requests.at(-1), { body: { body: "Actual note\n" }, key });
  }
  assert.equal(requests.length, 4);
});

test("an option-valued key does not duplicate or replace a real draft-file option", async t => {
  const root = await mkdtemp(join(tmpdir(), "anyam-option-values-"));
  const body = "Keep this saved note.\n";
  const requests: { body: unknown; key: string | null }[] = [];
  t.mock.method(console, "log", () => undefined);
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, input?: RequestInit) => {
    requests.push({ body: JSON.parse(String(input?.body)), key: new Headers(input?.headers).get("idempotency-key") });
    return Response.json({ receipt: "intent=commented" });
  });
  try {
    await writeFile(join(root, "note.md"), body);
    assert.equal(await main(["intent", "comment", "--idempotency-key", "--body-file", "--body-file", "note.md", "intent:owned", ...connection, "--json"], root), 0);
    assert.deepEqual(requests, [{ body: { body }, key: "--body-file" }]);
    assert.equal(await readFile(join(root, "note.md"), "utf8"), body);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Intent title, description and repeated labels preserve option names as values", async t => {
  t.mock.method(console, "log", () => undefined);
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, input?: RequestInit) => {
    assert.equal(String(url), "https://realm.example/api/intents");
    requests.push(JSON.parse(String(input?.body)));
    return Response.json({ receipt: "intent=created" });
  });
  assert.equal(await main(["intent", "create", "--project", "project:owned", "--title", "--body-file", "--description", "--resource-policy", "--label", "--label", "--label", "review", ...connection, "--json"]), 0);
  assert.deepEqual(requests, [{ projectId: "project:owned", title: "--body-file", description: "--resource-policy", labels: ["--label", "review"] }]);
});

test("real duplicate, mixed and unsupported draft options still fail before transport", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests += 1; throw new Error("unexpected transport"); });
  const prefixes = [
    ["intent", "comment", "intent:owned", "--idempotency-key", "--body", "--body", "one", "--body", "two"],
    ["intent", "comment", "intent:owned", "--idempotency-key", "--body-file", "--body-file", "one.md", "--body-file", "two.md"],
    ["intent", "comment", "intent:owned", "--idempotency-key", "--body-file", "--body", "one", "--body-file", "note.md"],
  ];
  for (const args of prefixes) await assert.rejects(() => main([...args, ...connection]), /exactly one.*no comment was sent/);
  await assert.rejects(() => main(["pr", "review", "pr:owned", "--title", "--body-file", "--body-file", "note.md", ...connection]), /supported only by intent comment/);
  assert.equal(requests, 0);
});

test("the actual CLI process chooses error format from root options rather than text or child arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-option-errors-"));
  const cli = fileURLToPath(new URL("../packages/create-anyam/src/anyam.ts", import.meta.url));
  const createCli = fileURLToPath(new URL("../packages/create-anyam/src/create-anyam.ts", import.meta.url));
  const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const run = (args: string[], entrypoint = cli) => spawnSync(process.execPath, ["--import", loader, entrypoint, ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, ANYAM_STATE_HOME: join(root, "state"), ANYAM_OWNER_SESSION: "" },
  });
  try {
    const plain = run(["intent", "comment", "intent:owned", "--body", "--json"]);
    assert.equal(plain.status, 1);
    assert.equal(plain.stdout, "");
    assert.match(plain.stderr, /^intent requires --realm/);
    const json = run(["intent", "comment", "intent:owned", "--body", "--json", "--json"]);
    assert.equal(json.status, 1);
    assert.equal(JSON.parse(json.stderr).code, "cli.error");
    assert.match(JSON.parse(json.stderr).message, /^intent requires --realm/);
    const child = run(["agent", "exec", "cli", "--session", "session:missing", "--", "unused-command", "--json", "--body-file", "--resource-policy"]);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.ok(child.stderr.length > 0);
    assert.doesNotMatch(child.stderr, /^\{|supported only by intent comment|new-session option/);
    const explicit = run(["agent", "exec", "cli", "--session", "session:missing", "--json", "--", "unused-command", "--body-file"]);
    assert.equal(explicit.status, 1);
    assert.equal(JSON.parse(explicit.stderr).status, "error");
    const scaffoldPlain = run(["--name", "--json", "--type", "invalid"], createCli);
    assert.equal(scaffoldPlain.status, 1);
    assert.match(scaffoldPlain.stderr, /^--type must be worker or library/);
    const scaffoldJson = run(["--name", "--json", "--type", "invalid", "--json"], createCli);
    assert.equal(scaffoldJson.status, 1);
    assert.equal(JSON.parse(scaffoldJson.stderr).code, "cli.error");
  } finally { await rm(root, { recursive: true, force: true }); }
});
