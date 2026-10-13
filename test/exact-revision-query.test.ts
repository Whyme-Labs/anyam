import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SmartHttpCredentialAuthority } from "../src/portability/smart-http.ts";
import { changedPaths, handleExactRevisionQuery, type ExactQueryConfig } from "../scripts/experiments/exact-revision-query.ts";
import { disclosureFixture, gitText } from "./fixtures/git-disclosure.ts";
import { isolatedGitEnvironment } from "../scripts/experiments/git-environment.ts";

async function fixture() {
  const f = await disclosureFixture();
  const base = f.published.commitId;
  await writeFile(join(f.publicRepository, "player.ts"), "export const publicPlayer = 'changed';\n");
  await writeFile(join(f.publicRepository, "line\nbreak.ts"), "newline filename\n");
  await gitText(f.publicRepository, ["add", "."]); await gitText(f.publicRepository, ["commit", "-m", "public change"]);
  const head = await gitText(f.publicRepository, ["rev-parse", "HEAD"]);
  const authority = new SmartHttpCredentialAuthority({ now: () => Date.parse("2026-10-13T00:00:00Z") });
  const credential = await authority.issue({ repositoryId: "public", sourceSpaceId: "public-player", operation: "read", expiresAt: "2026-10-14T00:00:00Z" });
  const config: ExactQueryConfig = { credentials: authority, repositories: [{ repositoryId: "public", sourceSpaceId: "public-player", directory: f.publicRepository }, { repositoryId: "private", sourceSpaceId: "private-codec", directory: f.canonical }], authorizeCurrentRead: async r => r.sourceSpaceId === "public-player" };
  const request = (overrides: Record<string, unknown> = {}) => new Request("http://127.0.0.1/changed-paths", { method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" }, body: JSON.stringify({ repositoryId: "public", base, head, ...overrides }) });
  return { ...f, base, head, authority, credential, config, request };
}

test("query equals local exact-revision Git diff and survives a moving branch", async () => {
  const f = await fixture();
  try {
    const first = await handleExactRevisionQuery(f.request(), f.config); assert.equal(first.status, 200);
    const body = await first.json(); assert.deepEqual(body.changedPaths, await changedPaths(f.publicRepository, f.base, f.head));
    assert.deepEqual(body.changedPaths.map((p: string) => Buffer.from(p, "base64").toString()), ["line\nbreak.ts", "player.ts"]);
    assert.equal(body.base, f.base); assert.equal(body.head, f.head); assert.equal(first.headers.get("cache-control"), "no-store");
    await gitText(f.publicRepository, ["commit", "--allow-empty", "-m", "branch moved"]);
    assert.deepEqual(await (await handleExactRevisionQuery(f.request(), f.config)).json(), body);
  } finally { await f.dispose(); }
});

test("branches, abbreviated IDs and revision expressions never become immutable query inputs", async () => {
  const f = await fixture();
  try { for (const base of ["main", f.base.slice(0, 12), `${f.base}^{commit}`, "--help"]) assert.equal((await handleExactRevisionQuery(f.request({ base }), f.config)).status, 400); }
  finally { await f.dispose(); }
});

test("known private objects, absent commits, hidden Sources and absent repositories have the same unavailable projection", async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all([f.request({ base: f.privateCommit }), f.request({ base: "f".repeat(40) }), f.request({ repositoryId: "private", base: f.privateCommit }), f.request({ repositoryId: "missing" }), f.request({ base: f.privateBlob })].map(r => handleExactRevisionQuery(r, f.config)));
    for (const response of responses) { assert.equal(response.status, 404); assert.deepEqual(await response.json(), { status: "not_found" }); }
  } finally { await f.dispose(); }
});

test("warm query results do not survive current Source denial or credential revocation", async () => {
  const f = await fixture();
  try {
    assert.equal((await handleExactRevisionQuery(f.request(), f.config)).status, 200);
    assert.equal((await handleExactRevisionQuery(f.request(), { ...f.config, authorizeCurrentRead: async () => false })).status, 404);
    await f.authority.revoke(f.credential.token);
    assert.equal((await handleExactRevisionQuery(f.request(), f.config)).status, 404);
  } finally { await f.dispose(); }
});

test("an exact private repository credential does not override current Source authority", async () => {
  const f = await fixture();
  try {
    const privateCredential = await f.authority.issue({ repositoryId: "private", sourceSpaceId: "private-codec", operation: "read", expiresAt: "2026-10-14T00:00:00Z" });
    const request = f.request({ repositoryId: "private", base: f.privateCommit, head: f.privateCommit });
    request.headers.set("authorization", `Bearer ${privateCredential.token}`);
    const response = await handleExactRevisionQuery(request, f.config); assert.equal(response.status, 404); assert.deepEqual(await response.json(), { status: "not_found" });
  } finally { await f.dispose(); }
});

test("revocation while the query is running withholds the result", async () => {
  const f = await fixture();
  try {
    const config = { ...f.config, authorizeCurrentRead: async () => { await f.authority.revoke(f.credential.token); return true; } };
    const response = await handleExactRevisionQuery(f.request(), config); assert.equal(response.status, 404); assert.deepEqual(await response.json(), { status: "not_found" });
  } finally { await f.dispose(); }
});

test("inherited Git selectors and object/config injections cannot substitute a foreign repository", async () => {
  const f = await fixture();
  try {
    const script = `import {readGit} from ${JSON.stringify(new URL("../scripts/experiments/exact-revision-query.ts", import.meta.url).href)};
      const result=await readGit(process.argv[1],['cat-file','-t',process.argv[2]]);process.stdout.write(String(result.code));`;
    const status = await new Promise<string>((done, reject) => {
      const child = spawn(process.execPath, ["--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href, "--input-type=module", "--eval", script, f.publicRepository, f.privateBlob], {
        cwd: f.root, env: { ...isolatedGitEnvironment(), GIT_DIR: join(f.canonical, ".git"), GIT_WORK_TREE: f.canonical, GIT_OBJECT_DIRECTORY: join(f.canonical, ".git/objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(f.canonical, ".git/objects"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: f.canonical },
      });
      let output = ""; child.stdout.on("data", (b: Buffer) => { output += b.toString(); }); child.stderr.resume(); child.once("error", reject);
      child.once("close", code => code === 0 ? done(output) : reject(new Error("isolated selector regression failed"))); child.stdin.end();
    });
    assert.match(status, /^\d+$/); assert.notEqual(status, "0", "foreign private object must remain absent from the mapped public repository");
  } finally { await f.dispose(); }
});

test("replacement refs cannot change the meaning of exact immutable commit IDs", async () => {
  const f = await fixture();
  try {
    const original = await (await handleExactRevisionQuery(f.request(), f.config)).json();
    await gitText(f.publicRepository, ["replace", f.head, f.base]);
    const replaced = await (await handleExactRevisionQuery(f.request(), f.config)).json();
    assert.deepEqual(replaced, original);
  } finally { await f.dispose(); }
});
