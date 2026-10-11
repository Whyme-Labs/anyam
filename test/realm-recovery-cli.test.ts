import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { runRealmRecoveryCommand } from "../packages/create-anyam/src/realm-recovery-command.ts";

const signed = { protocol: "anyam.authority-recovery/v1", bundleId: "bundle:fixture", bundleDigest: "sha256:fixture", signature: "synthetic-signature", snapshot: { privateFixture: "PRIVATE-snapshot" } };
const restored = { protocol: "anyam.authority-plane/v1", status: "recovery-quarantined", bundleId: signed.bundleId, bundleDigest: signed.bundleDigest, snapshotVersion: 7, recoveryStatus: "quarantined", credentialFree: true, canonicalWrite: false, receipt: "authorityRecovery=restored; state=quarantined" };
const args = (operation: string, ...extra: string[]) => ["realm", "recovery", operation, "--realm", "https://realm.example", "--session-stdin", "--json", ...extra];
const stdin = () => Readable.from(["synthetic-owner\n"]);

test("Authority checkpoint export saves the unchanged signed bundle in a new private file without printing its snapshot", async t => {
  const root = await mkdtemp(join(tmpdir(), "anyam-recovery-cli-export-"));
  try {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
      calls++; assert.equal(String(url), "https://realm.example/api/authority/recovery/export");
      assert.equal(new Headers(options.headers).get("cookie"), "anyam_owner_session=synthetic-owner");
      return Response.json({ protocol: restored.protocol, status: "recovery-exported", bundle: signed, snapshotVersion: 7, credentialFree: true, canonicalWrite: false, receipt: "authorityRecovery=exported" });
    });
    const path = join(root, "checkpoint.json");
    const result = await runRealmRecoveryCommand(args("export", "--output", path), stdin());
    assert.equal(calls, 1); assert.deepEqual(JSON.parse(await readFile(path, "utf8")), signed);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(result.bundleId, signed.bundleId); assert.match(String(result.fileDigest), /^sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-snapshot|synthetic-owner|synthetic-signature/u);
    const untouched = stdin(); await assert.rejects(runRealmRecoveryCommand(args("export", "--output", path), untouched), /output_unavailable/u);
    assert.equal(untouched.readableDidRead, false); assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), signed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restore saves the exact receipt and activation uses only its ID/digest with the operator's stable key", async t => {
  const root = await mkdtemp(join(tmpdir(), "anyam-recovery-cli-restore-"));
  try {
    const checkpoint = join(root, "checkpoint.json"); const receipt = join(root, "restore.json");
    await writeFile(checkpoint, JSON.stringify(signed));
    const calls: { url: string; key: string | null; body: unknown }[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
      calls.push({ url: String(url), key: new Headers(options.headers).get("idempotency-key"), body: JSON.parse(String(options.body)) });
      return Response.json(String(url).endsWith("restore") ? restored : { protocol: restored.protocol, status: "recovery-activated", bundleId: signed.bundleId, snapshotVersion: 7, recoveryStatus: "active", credentialFree: true, canonicalWrite: false, receipt: "authorityRecovery=activated" });
    });
    await runRealmRecoveryCommand(args("restore", "--input", checkpoint, "--output", receipt, "--idempotency-key", "restore-stable"), stdin());
    assert.equal(calls.length, 1, "restore never activates automatically");
    assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), restored); assert.equal((await stat(receipt)).mode & 0o777, 0o600);
    await runRealmRecoveryCommand(args("activate", "--input", receipt, "--idempotency-key", "activate-stable"), stdin());
    assert.deepEqual(calls, [
      { url: "https://realm.example/api/authority/recovery/restore", key: "restore-stable", body: { bundle: signed } },
      { url: "https://realm.example/api/authority/recovery/activate", key: "activate-stable", body: { bundleId: signed.bundleId, bundleDigest: signed.bundleDigest } },
    ]);
    assert.deepEqual(JSON.parse(await readFile(checkpoint, "utf8")), signed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid recovery options, missing inputs, symlinks and a signed export used as an activation receipt refuse before session input or network", async t => {
  const root = await mkdtemp(join(tmpdir(), "anyam-recovery-cli-invalid-"));
  try {
    let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected request"); });
    const checkpoint = join(root, "checkpoint.json"); await writeFile(checkpoint, JSON.stringify(signed));
    const symbolic = join(root, "symlink.json"); await symlink(checkpoint, symbolic);
    const malformed = join(root, "malformed.json"); await writeFile(malformed, '{"PRIVATE-syntax":');
    const cases = [
      args("export", "--output", join(root, "out"), "--owner-session", "PRIVATE-session"),
      args("export", "--output", join(root, "out"), "--output", "PRIVATE-duplicate"),
      args("restore", "--input", checkpoint, "--output", join(root, "out")),
      args("restore", "--input", symbolic, "--output", join(root, "out"), "--idempotency-key", "same"),
      args("restore", "--input", malformed, "--output", join(root, "out"), "--idempotency-key", "same"),
      args("restore", "--input", root, "--output", join(root, "out"), "--idempotency-key", "same"),
      args("activate", "--input", checkpoint, "--idempotency-key", "same"),
    ];
    for (const command of cases) {
      const input = stdin(); await assert.rejects(runRealmRecoveryCommand(command, input), error => { assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE-/u); return true; });
      assert.equal(input.readableDidRead, false);
    }
    assert.equal(calls, 0); await assert.rejects(stat(join(root, "out")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unconfirmed or malformed recovery responses leave no false checkpoint and never retry or activate", async t => {
  const root = await mkdtemp(join(tmpdir(), "anyam-recovery-cli-failure-"));
  try {
    const checkpoint = join(root, "checkpoint.json"); await writeFile(checkpoint, JSON.stringify(signed));
    for (const response of [Response.json({ code: "indeterminate", recoveryAction: "inspect the receipt", receipt: "outcome=unconfirmed", secret: "PRIVATE-error-payload" }, { status: 503 }), Response.json({ ...restored, bundleId: "wrong" }), Response.json({ ...restored, status: "error" })]) {
      let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return response; });
      const output = join(root, "failed.json");
      await assert.rejects(runRealmRecoveryCommand(args("restore", "--input", checkpoint, "--output", output, "--idempotency-key", "stable"), stdin()), error => { assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE-error-payload/u); return true; });
      assert.equal(calls, 1); await assert.rejects(stat(output), { code: "ENOENT" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a concurrent destination creation is preserved and cannot be reported as the saved checkpoint", async t => {
  const root = await mkdtemp(join(tmpdir(), "anyam-recovery-cli-race-"));
  try {
    const output = join(root, "checkpoint.json");
    t.mock.method(globalThis, "fetch", async () => {
      await writeFile(output, "concurrent-owner-file");
      return Response.json({ protocol: restored.protocol, status: "recovery-exported", bundle: signed, credentialFree: true, canonicalWrite: false, receipt: "authorityRecovery=exported" });
    });
    await assert.rejects(runRealmRecoveryCommand(args("export", "--output", output), stdin()), /output_unconfirmed/u);
    assert.equal(await readFile(output, "utf8"), "concurrent-owner-file");
  } finally { await rm(root, { recursive: true, force: true }); }
});
