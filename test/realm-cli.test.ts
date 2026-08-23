import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { realmDestroy, realmDoctor, realmExport, realmInstall, realmPlan, realmRestore, realmUpgrade, readRealmState } from "../packages/create-anyam/src/realm.ts";

test("customer Realm plan is read-only and names permissions, resources, and unmeasured cost", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-realm-cli-plan-"));
  try {
    const result = realmPlan({ directory, installationId: "installation:plan", accountId: "account:customer", resources: ["d1", "r2"], domains: ["source.example.com"] });
    assert.equal(result.status, "planned");
    assert.equal(result.plan?.cost.status, "not-estimated");
    assert.equal(result.plan?.secrets.every((secret) => secret.materialStored === false), true);
    assert.equal(result.plan?.permissions.includes("D1 Edit"), true);
    await assert.rejects(readFile(join(directory, ".anyam", "realm.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("customer Realm lifecycle writes resumable install/upgrade checkpoints and doctor receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-realm-cli-lifecycle-"));
  const exportDirectory = await mkdtemp(join(tmpdir(), "anyam-realm-cli-export-"));
  const restoredDirectory = await mkdtemp(join(tmpdir(), "anyam-realm-cli-restored-"));
  try {
    const installed = await realmInstall({ directory, installationId: "installation:lifecycle", accountId: "account:customer", resources: ["d1", "r2"], desiredVersion: "0.0.0" });
    assert.equal(installed.status, "blocked");
    assert.equal(installed.state?.phase, "provider-pending");
    const state = await readRealmState(directory);
    assert.equal(state?.credentialFree, true);
    assert.equal(state?.providerMutation, false);
    const doctor = await realmDoctor(directory);
    assert.equal(doctor.status, "blocked");
    assert.equal(doctor.state?.phase, "provider-pending");
    const upgraded = await realmUpgrade({ directory, desiredVersion: "0.0.1" });
    assert.equal(upgraded.status, "blocked");
    assert.equal(upgraded.state?.phase, "upgrade-pending");
    const exported = await realmExport(directory, join(exportDirectory, "realm.json"));
    assert.equal(exported.status, "succeeded");
    const restored = await realmRestore(restoredDirectory, exported.exportPath!);
    assert.equal(restored.status, "succeeded");
    assert.equal(restored.state?.phase, "recovery-pending");
    const destroyed = await realmDestroy(directory);
    assert.equal(destroyed.status, "blocked");
    assert.equal(destroyed.state?.phase, "destroy-pending");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(exportDirectory, { recursive: true, force: true });
    await rm(restoredDirectory, { recursive: true, force: true });
  }
});

