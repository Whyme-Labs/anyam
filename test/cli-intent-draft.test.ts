import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../packages/create-anyam/src/cli.ts";

const connection = ["--realm", "https://realm.example", "--owner-session", "synthetic-owner", "--json"];
const key = "draft:owned-note";
const publish = (options: string[]) => ["intent", "comment", ...options, "intent:owned", "--idempotency-key", key, ...connection];

test("Intent CLI publishes a reopened multiline UTF-8 note through the existing explicit comment route", async t => {
  const root = await mkdtemp(join(tmpdir(), "anyam-intent-draft-"));
  const note = "Review basis: revision:original\n\nKeep the λ calculation.\n确认下一步。\n";
  const calls: { url: string; method: string; body: unknown; key: string | null }[] = [];
  const printed: string[] = [];
  t.mock.method(console, "log", (value: unknown) => printed.push(String(value)));
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("cookie"), "anyam_owner_session=synthetic-owner");
    assert.equal(options?.cache, "no-store");
    calls.push({ url: String(url), method: options?.method ?? "", body: JSON.parse(String(options?.body)), key: headers.get("idempotency-key") });
    return Response.json({ receipt: "intent=commented", comment: { id: "comment:owned" } });
  });
  try {
    const path = join(root, "review note.md");
    await writeFile(path, note);
    assert.equal((await readFile(path)).toString("utf8"), note);
    assert.equal(calls.length, 0, "saving and reopening an unpublished note sends no request");
    assert.equal(await main(publish(["--body-file", "review note.md", "--disclosure", "restricted"]), root), 0);
    assert.deepEqual(calls, [{ url: "https://realm.example/api/intents/intent%3Aowned/comment", method: "POST", body: { body: note, disclosure: "restricted" }, key }]);
    assert.equal(JSON.parse(printed[0]!).comment.id, "comment:owned");
    assert.equal((await readFile(path)).toString("utf8"), note, "publishing does not consume or rewrite the draft");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Intent CLI rejects missing, duplicate, mixed, empty, unreadable and invalid UTF-8 draft inputs before transport", async t => {
  const root = await mkdtemp(join(tmpdir(), "anyam-intent-draft-"));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("unexpected transport"); });
  try {
    await writeFile(join(root, "valid.md"), "PRIVATE draft content");
    await writeFile(join(root, "empty.md"), " \n\t");
    await writeFile(join(root, "invalid.md"), Buffer.from([0xff]));
    const invalid = [[], ["--body-file"], ["--body-file", "--json"], ["--body-file", "valid.md", "--body", "PRIVATE inline"],
      ["--body-file", "valid.md", "--body-file", "valid.md"], ["--body", "PRIVATE one", "--body", "PRIVATE two"],
      ["--body-file", "empty.md"], ["--body-file", "missing.md"], ["--body-file", "."], ["--body-file", "invalid.md"]];
    for (const options of invalid) {
      await assert.rejects(() => main(["intent", "comment", "intent:owned", ...options, ...connection], root), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /no comment was sent/);
        assert.doesNotMatch(error.message, /PRIVATE/);
        return true;
      });
    }
    assert.equal(calls, 0);
    assert.equal(await readFile(join(root, "valid.md"), "utf8"), "PRIVATE draft content");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Intent CLI keeps the draft after a lost response and retries only an explicit same-key invocation", async t => {
  const root = await mkdtemp(join(tmpdir(), "anyam-intent-draft-"));
  const calls: { key: string; body: string }[] = [];
  const accepted = new Map<string, string>();
  t.mock.method(console, "log", () => undefined);
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, options?: RequestInit) => {
    const requestKey = new Headers(options?.headers).get("idempotency-key")!;
    const body = String(options?.body);
    calls.push({ key: requestKey, body });
    if (!accepted.has(requestKey)) { accepted.set(requestKey, body); throw new TypeError("lost response after admission"); }
    assert.equal(accepted.get(requestKey), body);
    return Response.json({ receipt: "intent=commented; replay=true", comment: { id: "comment:original" } });
  });
  try {
    const path = join(root, "draft.md");
    await writeFile(path, "Retained unpublished note\n");
    const before = await readFile(path);
    await assert.rejects(() => main(publish(["--body-file", "draft.md"]), root), /lost response/);
    assert.equal(calls.length, 1, "the CLI does not retry an ambiguous response automatically");
    assert.deepEqual(await readFile(path), before);
    assert.equal(await main(publish(["--body-file", "draft.md"]), root), 0);
    assert.equal(accepted.size, 1, "the provider double admits one command identity");
    assert.deepEqual(calls[0], calls[1]);
    assert.deepEqual(await readFile(path), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fresh Intent inspection remains online and a connection failure preserves the local note", async t => {
  const root = await mkdtemp(join(tmpdir(), "anyam-intent-draft-"));
  const responses: unknown[] = [];
  const methods: string[] = [];
  let connected = false;
  t.mock.method(console, "log", (value: unknown) => responses.push(JSON.parse(String(value))));
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, options?: RequestInit) => {
    methods.push(options?.method ?? "");
    assert.equal(options?.cache, "no-store");
    if (!connected) throw new TypeError("offline");
    return Response.json({ intent: { id: "intent:owned", updatedAt: "current-server-observation" }, comments: [] });
  });
  try {
    const path = join(root, "draft.md");
    await writeFile(path, "Basis recorded before disconnect\n");
    const before = await readFile(path);
    const inspect = ["intent", "inspect", "intent:owned", ...connection];
    await assert.rejects(() => main(inspect, root), /offline/);
    assert.deepEqual(await readFile(path), before);
    connected = true;
    assert.equal(await main(inspect, root), 0);
    assert.deepEqual(methods, ["GET", "GET"]);
    assert.deepEqual(responses, [{ intent: { id: "intent:owned", updatedAt: "current-server-observation" }, comments: [] }]);
    assert.deepEqual(await readFile(path), before, "refetch does not publish or change a saved draft");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a saved Intent note cannot be supplied to a Pull Request approval or another command", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("unexpected transport"); });
  for (const prefix of [["pr", "review", "pr:owned"], ["intent", "create"], ["realm", "run", "request"]]) {
    await assert.rejects(() => main([...prefix, "--body-file", "unread-draft.md", ...connection]), /supported only by intent comment/);
  }
  assert.equal(calls, 0);
});

test("the existing inline Intent comment path preserves text and explicit idempotency", async t => {
  t.mock.method(console, "log", () => undefined);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, options?: RequestInit) => {
    assert.equal(new Headers(options?.headers).get("idempotency-key"), key);
    calls.push(String(options?.body));
    return Response.json({ receipt: "intent=commented" });
  });
  const body = "-- Original inline note\n";
  assert.equal(await main(publish(["--body", body])), 0);
  assert.deepEqual(calls, [JSON.stringify({ body })]);
});
