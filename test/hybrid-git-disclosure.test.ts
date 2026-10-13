import assert from "node:assert/strict";
import test from "node:test";
import { disclosureFixture, fetchKnownObject, gitBytes, gitText } from "./fixtures/git-disclosure.ts";

test("public upload-pack advertises only curated public refs and tags", async () => {
  const f = await disclosureFixture();
  try {
    const advertised = await gitBytes(f.publicRepository, ["upload-pack", "--advertise-refs", "."]);
    assert.equal(advertised.code, 0);
    const refs = advertised.stdout.toString();
    assert.match(refs, /refs\/heads\/main/); assert.match(refs, /refs\/tags\/public-v1/);
    assert.doesNotMatch(refs, /private-internal|private-release|private-tag-sentinel|revision:private-canonical/);
    for (const oid of f.privateObjectIds) assert.equal(refs.includes(oid), false);
    const names = (await gitText(f.publicRepository, ["for-each-ref", "--format=%(refname)"])).split("\n");
    assert.deepEqual(names, ["refs/heads/main", "refs/tags/public-v1"]);
  } finally { await f.dispose(); }
});

test("public commits, trees, tags and complete cloned history have no private graph edges", async () => {
  const f = await disclosureFixture();
  try {
    assert.equal(await gitText(f.publicRepository, ["rev-list", "--count", "--all"]), "1");
    const commit = await gitText(f.publicRepository, ["cat-file", "-p", f.published.commitId]);
    assert.doesNotMatch(commit, /^parent /m);
    const files = (await gitText(f.publicRepository, ["ls-tree", "-r", "--name-only", "HEAD"])).split("\n");
    assert.deepEqual(files, ["README.md", "player.ts"]);
    const clone = f.root + "/public-clone";
    await gitText(f.root, ["clone", "--no-local", f.publicRepository, clone]);
    const graph = await gitText(clone, ["rev-list", "--all", "--objects"]);
    assert.doesNotMatch(graph, /private-codec|private-release/);
    for (const oid of f.privateObjectIds) {
      assert.equal(graph.includes(oid), false);
      assert.notEqual((await gitBytes(clone, ["cat-file", "-e", oid])).code, 0);
    }
    for (const line of graph.split("\n")) {
      const oid = line.split(" ")[0]; assert.ok(oid);
      const object = await gitBytes(clone, ["cat-file", "-p", oid]); assert.equal(object.code, 0);
      assert.doesNotMatch(object.stdout.toString(), /synthetic-private-codec-sentinel|private-only-parent|private-tag-sentinel|revision:private-canonical/);
    }
  } finally { await f.dispose(); }
});

test("crafted fetch requests cannot retrieve known private commit, tree, blob or tag IDs", async () => {
  const f = await disclosureFixture();
  try {
    const authorized = await fetchKnownObject(f.publicRepository, f.published.commitId);
    assert.equal(authorized.code, 0); assert.ok(authorized.stdout.includes(Buffer.from("PACK")));
    for (const oid of f.privateObjectIds) {
      const denied = await fetchKnownObject(f.publicRepository, oid);
      assert.notEqual(denied.code, 0); assert.equal(denied.stdout.includes(Buffer.from("PACK")), false);
      assert.match(denied.stderr, /not our ref|not a valid object|bad object/);
    }
  } finally { await f.dispose(); }
});

test("known-bad hidden refs and a public tip do not conceal shared private ancestry or objects", async () => {
  const f = await disclosureFixture();
  try {
    const hidden = ["-c", "transfer.hideRefs=refs/heads/private-internal", "-c", "transfer.hideRefs=refs/tags/private-release"];
    const advertised = await gitBytes(f.canonical, [...hidden, "upload-pack", "--advertise-refs", "."]);
    assert.equal(advertised.code, 0); assert.doesNotMatch(advertised.stdout.toString(), /private-internal|private-release/);
    const history = await gitText(f.canonical, ["rev-list", "--objects", "main"]);
    assert.match(history, /private-codec.ts/); assert.ok(history.includes(f.privateCommit));
    for (const oid of f.privateObjectIds) {
      const exposed = await fetchKnownObject(f.canonical, oid, hidden);
      assert.equal(exposed.code, 0); assert.ok(exposed.stdout.includes(Buffer.from("PACK")));
      const receiver = `${f.root}/received-${oid}`;
      await gitText(f.root, ["init", "--bare", receiver]);
      const pack = exposed.stdout.subarray(exposed.stdout.indexOf(Buffer.from("PACK")));
      assert.equal((await gitBytes(receiver, ["index-pack", "--stdin"], pack)).code, 0);
      assert.equal((await gitBytes(receiver, ["cat-file", "-e", oid])).code, 0, "known-bad control must actually deliver the requested object");
      if (oid === f.privateBlob) assert.match(await gitText(receiver, ["cat-file", "-p", oid]), /synthetic-private-codec-sentinel/);
    }
  } finally { await f.dispose(); }
});
