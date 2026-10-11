import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { disclosureFixture } from "./fixtures/authority-disclosure-state.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";
import { emptyAuthorityPlaneSnapshot, normalizeAuthorityPlaneSnapshot } from "../src/cloudflare/authority-plane.ts";
import { createAuthorityRecoveryBundle, verifyAuthorityRecoveryBundle } from "../src/cloudflare/authority-recovery.ts";

test("actual local Coordinator SQLite REST and MCP enforce current Source disclosure, stable projections and owner recovery boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-disclosure-runtime-"));
  let runtime;
  try {
    const bundle = await build({ entryPoints: ["test/fixtures/authority-disclosure-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    const options = convertV4MiniflareOptions({ name: "disclosure-owned-local", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-02", compatibilityFlags: ["nodejs_compat"], durableObjects: { REALM_COORDINATOR: { className: "LocalDisclosureRealm", useSQLite: true } }, outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false }; options.resourcePersistencePath = join(directory, "storage");
    runtime = new Miniflare(options);
    const invoke = async (path, body, member = "public") => {
      const response = await runtime.dispatchFetch(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-fixture-member": member, [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const f = disclosureFixture();
    assert.equal((await invoke("/fixture/seed", f)).status, 200);
    const readPaths = ["/api/projects", "/api/projects/project%3Afixture", "/api/workspaces", "/api/workspaces/workspace%3Apublic", "/api/changes", "/api/changes/change%3Apublic", "/api/intents", "/api/intents/intent%3Acollaboration", "/api/pull-requests", "/api/pull-requests/pr%3Apublic", "/api/mirrors", "/api/mirrors/mirror%3Apublic", "/api/promotions/promotion%3Apublic"];
    const baseline = [];
    for (const path of readPaths) {
      const result = await invoke(path); assert.equal(result.status, 200, path);
      assert.doesNotMatch(JSON.stringify(result.value), /PRIVATE-|canonical:|candidate:|source:hidden|run:hidden|run:mixed/u, path);
      baseline.push(result);
    }
    const run = await invoke("/authority/runs/internal", { sessionId: f.members.public.session.id, runId: "run:public" });
    assert.equal(run.status, 200); assert.equal(run.value.run.status, "succeeded"); assert.doesNotMatch(JSON.stringify(run.value), /PRIVATE-|Digest|runnerId|verifierId/u);
    const tool = async (name, args, member = "public") => invoke("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, member);
    for (const [name, args] of [["project.inspect", { projectId: "project:fixture" }], ["workspace.inspect", { workspaceId: "workspace:public" }], ["change.inspect", { changeId: "change:public" }], ["intent.inspect", { intentId: "intent:collaboration" }], ["pullRequest.inspect", { pullRequestId: "pr:public" }], ["run.inspect", { runId: "run:public" }]]) {
      const result = await tool(name, args); assert.equal(result.status, 200); assert.ok(result.value.result, JSON.stringify(result)); assert.equal(result.value.error, undefined);
      assert.doesNotMatch(JSON.stringify(result.value), /PRIVATE-|canonical:|candidate:|source:hidden/u, name);
    }
    for (const kind of ["hidden", "mixed"]) {
      for (const [route, prefix] of [["workspaces", "workspace"], ["changes", "change"], ["pull-requests", "pr"], ["promotions", "promotion"]]) {
        const hidden = await invoke(`/api/${route}/${prefix}%3A${kind}`); const absent = await invoke(`/api/${route}/${prefix}%3Aabsent`);
        assert.equal(hidden.status, 404, `${route} ${kind}`); assert.deepEqual(hidden, absent, `${route} hidden and absent errors`);
      }
      const hidden = await invoke("/authority/runs/internal", { sessionId: f.members.public.session.id, runId: `run:${kind}` });
      const absent = await invoke("/authority/runs/internal", { sessionId: f.members.public.session.id, runId: "run:absent" });
      assert.equal(hidden.status, 404); assert.deepEqual(hidden, absent);
      const mcp = await tool("run.inspect", { runId: `run:${kind}` }); const unknown = await tool("run.inspect", { runId: "run:absent" });
      assert.deepEqual(mcp, unknown); assert.ok(mcp.value.error);
    }
    assert.equal((await invoke("/api/projects", undefined, "unrelated")).value.projects.length, 0);
    assert.equal((await invoke("/api/projects/project%3Afixture", undefined, "unrelated")).status, 404);
    assert.equal((await invoke("/authority/runs/internal", { sessionId: f.members.private.session.id, runId: "run:mixed" })).status, 200);
    const ownerState = await invoke("/authority/state/internal", { sessionId: f.members.owner.session.id }); assert.equal(ownerState.status, 200);
    const projectOwnerState = await invoke("/authority/state/internal", { sessionId: f.members.projectOwner.session.id }); assert.equal(projectOwnerState.status, 422);
    const projectOwnerExport = await invoke("/authority/recovery/export/internal", { sessionId: f.members.projectOwner.session.id }); assert.equal(projectOwnerExport.status, 422); assert.equal(projectOwnerExport.value.code, "authority.owner_denied");
    const altered = structuredClone(f); altered.state.version += 100; altered.state.sourceSpaces["source:hidden"].name = "PRIVATE-altered";
    altered.state.projectRevisions["canonical:base"].sourceSpaceSnapshots["source:hidden"] = "PRIVATE-new-snapshot";
    altered.state.projectViews[altered.state.workspaces["workspace:hidden"].projectViewId].projectionId = altered.state.projectViews[altered.state.workspaces["workspace:public"].projectViewId].projectionId;
    altered.state.intentComments["comment:hidden"].body = "PRIVATE-new-comment"; altered.state.intents["intent:collaboration"].updatedAt = "2099-01-01";
    await invoke("/fixture/seed", altered);
    for (let i = 0; i < readPaths.length; i++) assert.deepEqual(await invoke(readPaths[i]), baseline[i], readPaths[i]);
    assert.deepEqual(await invoke("/authority/runs/internal", { sessionId: f.members.public.session.id, runId: "run:public" }), run);
    const deniedOwner = structuredClone(f); deniedOwner.identity.sourceSpacePolicies["source:hidden"].readerPrincipalIds = [f.members.private.principal.id];
    await invoke("/fixture/seed", deniedOwner);
    const limitedState = await invoke("/authority/state/internal", { sessionId: f.members.owner.session.id }); assert.equal(limitedState.status, 200); assert.doesNotMatch(JSON.stringify(limitedState.value), /PRIVATE-|snapshotVersion|sql|rowCount|version/u);
    assert.equal((await invoke("/authority/recovery/export/internal", { sessionId: f.members.owner.session.id })).status, 404);
    const revoked = structuredClone(f); revoked.identity.sourceSpacePolicies["source:public"].readerPrincipalIds = [f.members.owner.principal.id];
    await invoke("/fixture/seed", revoked);
    assert.equal((await invoke("/api/workspaces/workspace%3Apublic")).status, 404);
    assert.equal((await tool("run.inspect", { runId: "run:public" })).value.error.code, -32004);
    assert.equal((await invoke("/api/projects/project%3Afixture")).value.counts.runs, 0);
    await invoke("/fixture/seed", f); await invoke("/fixture/revoke", { sessionId: f.members.public.session.id });
    assert.notEqual((await invoke("/api/projects/project%3Afixture")).status, 200);
    assert.ok((await tool("run.inspect", { runId: "run:public" })).value.error);
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("signed legacy recovery preserves current additive collections only at an identical Authority baseline", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-legacy-recovery-")); let runtime;
  const paused = Promise.withResolvers(); const release = Promise.withResolvers(); const dispatched = Promise.withResolvers();
  try {
    const bundle = await build({ entryPoints: ["test/fixtures/authority-disclosure-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    const control = async request => {
      const url = new URL(request.url);
      if (url.pathname === "/legacy-digest") { paused.resolve(url.searchParams.get("gateActive")); await release.promise; }
      else if (url.pathname === "/competing-dispatched") dispatched.resolve();
      else return new Response("unknown fixture barrier", { status: 404 });
      return new Response("owned barrier released");
    };
    const options = convertV4MiniflareOptions({ name: "legacy-recovery-owned-local", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-27", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"], bindings: { ANYAM_AUTHORITY_RECOVERY_KEY_ID: "synthetic-key", ANYAM_AUTHORITY_RECOVERY_SECRET: "synthetic-local-only" }, durableObjects: { REALM_COORDINATOR: { className: "LocalDisclosureRealm", useSQLite: true } }, serviceBindings: { FIXTURE_RECOVERY_CONTROL: control }, outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false }; options.resourcePersistencePath = join(directory, "storage"); runtime = new Miniflare(options);
    const invoke = async (path, body = {}) => { const response = await runtime.dispatchFetch(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE }, body: JSON.stringify(body) }); return { status: response.status, value: await response.json() }; };
    // Generated by the exact Aug31 exporter, not by deleting fields from a
    // current export. Its v1 schema has no signed producer/schema revision.
    const fixture = JSON.parse(await readFile(new URL("./fixtures/authority-recovery-pre-additive-v1.json", import.meta.url), "utf8"));
    assert.equal(fixture.exporterSourceSha, "188e1d64b294c0eb8d8ecbabfad947e2eee24164");
    const legacy = fixture.signedBundle; const originalBytes = JSON.stringify(legacy);
    assert.equal(Object.hasOwn(legacy.snapshot, "runDetails"), false); assert.equal(Object.hasOwn(legacy.snapshot, "canonicalRefProjections"), false);
    assert.equal((await verifyAuthorityRecoveryBundle({ value: legacy, realmId: legacy.realmId, recoveryKeyId: "synthetic-key", secret: "synthetic-local-only" })).valid, true);
    assert.equal(JSON.stringify(legacy), originalBytes);
    const f = disclosureFixture(); f.state = normalizeAuthorityPlaneSnapshot(legacy.snapshot);
    // Opaque retention sentinels test custody, not provider seal qualification.
    f.state.runDetails["run:retained"] = { outputReferences: [{ digest: "sha256:retained" }] };
    f.state.canonicalRefProjections["project:legacy"] = { protocol: "anyam.canonical-ref-projection/v1", id: "projection:retained", state: "pending", receipt: "owned retention sentinel" };
    const seed = async (state = f.state) => { assert.equal((await invoke("/fixture/seed", { ...f, state })).status, 200); return (await invoke("/fixture/checkpoint")).value; };
    const restore = signed => invoke("/authority/recovery/restore/internal", { sessionId: f.members.owner.session.id, idempotencyKey: `restore-${signed.bundleId}`, bundle: signed });
    const sign = (snapshot, bundleId) => createAuthorityRecoveryBundle({ snapshot: structuredClone(snapshot), bundleId, recoveryKeyId: "synthetic-key", secret: "synthetic-local-only" });
    const before = await seed(); const accepted = await restore(legacy);
    assert.equal(accepted.status, 200, JSON.stringify(accepted)); assert.match(accepted.value.receipt, /backupFieldSet=v1-pre-canonical-and-run-detail; stateVersion=matched; normalizedStateDigest=matched; additiveCollections=preserved-current/u);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value.authority, before.authority); assert.equal(JSON.stringify(legacy), originalBytes);
    assert.equal((await restore(legacy)).value.status, "recovery-quarantined");
    const current = await sign(before.authority, "complete-current"); assert.equal((await restore(current)).status, 200);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value.authority, before.authority);
    const preRun = structuredClone(before.authority); delete preRun.runDetails;
    const preRunAccepted = await restore(await sign(preRun, "pre-run-detail")); assert.equal(preRunAccepted.status, 200); assert.match(preRunAccepted.value.receipt, /backupFieldSet=v1-pre-run-detail.*additiveCollections=preserved-current/u);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value.authority, before.authority);
    for (const [kind, snapshot] of [["legacy", legacy.snapshot], ["current", before.authority]]) {
      const signed = await sign(snapshot, `bad-signature-${kind}`); signed.signature = "invalid";
      const checkpoint = await seed(); const refused = await restore(signed); assert.equal(refused.status, 422); assert.match(refused.value.receipt, /signature-invalid/u); assert.deepEqual((await invoke("/fixture/checkpoint")).value, checkpoint);
    }
    for (const kind of ["missing-protocol", "unknown-protocol", "unknown-version-field", "missing-key", "missing-version", "missing-audit"]) {
      const signed = await sign(before.authority, `invalid-envelope-${kind}`);
      if (kind === "missing-protocol") delete signed.protocol;
      else if (kind === "unknown-protocol") signed.protocol = "anyam.authority-recovery/v999";
      else if (kind === "unknown-version-field") signed.schemaVersion = 999;
      else if (kind === "missing-key") delete signed.recoveryKeyId;
      else if (kind === "missing-version") delete signed.expectedVersion;
      else delete signed.snapshot.audit;
      const checkpoint = await seed(); assert.equal((await restore(signed)).status, 422); assert.deepEqual((await invoke("/fixture/checkpoint")).value, checkpoint);
    }
    for (const [field, value] of [["canonicalRefProjections", null], ["canonicalRefProjections", []], ["runDetails", null], ["projects", "malformed"], ["idempotency", []]]) {
      const malformed = structuredClone(before.authority); malformed[field] = value;
      const signed = await sign(malformed, `malformed-${field}-${String(value)}`); const checkpoint = await seed(); const refused = await restore(signed);
      assert.equal(refused.status, 422, JSON.stringify(refused)); assert.match(refused.value.receipt, /collection-invalid/u); assert.deepEqual((await invoke("/fixture/checkpoint")).value, checkpoint);
    }
    for (const field of ["projects", "idempotency", "canonicalRefProjections"]) {
      const incomplete = structuredClone(before.authority); delete incomplete[field];
      const checkpoint = await seed(); const refused = await restore(await sign(incomplete, `missing-${field}`));
      assert.equal(refused.status, 422); assert.match(refused.value.receipt, /complete-required/u); assert.deepEqual((await invoke("/fixture/checkpoint")).value, checkpoint);
    }
    for (const kind of ["same-version-different-state", "advanced-version", "lost-state"]) {
      const changed = structuredClone(f.state);
      if (kind === "same-version-different-state") changed.projects["project:legacy"].name = "Different authoritative state";
      else if (kind === "advanced-version") changed.version++;
      else { changed.projects = {}; changed.sourceSpaces = {}; changed.projectRevisions = {}; changed.canonicalByProject = {}; changed.idempotency = {}; changed.audit = []; }
      const checkpoint = await seed(changed); const refused = await restore(await sign(legacy.snapshot, `mismatched-${kind}`));
      assert.equal(refused.status, 409); assert.match(refused.value.receipt, kind === "advanced-version" ? /authorityRecovery=stale/u : /legacy-baseline-mismatch/u); assert.deepEqual((await invoke("/fixture/checkpoint")).value, checkpoint);
    }
    const changed = structuredClone(f.state); changed.version++;
    const qualificationCheckpoint = await seed(changed);
    const bypass = await invoke("/authority/recovery/restore/internal", { sessionId: f.members.owner.session.id, idempotencyKey: "legacy-qualification-bypass", qualificationId: "owned-synthetic-qualification", bundle: await sign(legacy.snapshot, "legacy-qualification-bypass") });
    assert.equal(bypass.status, 409); assert.deepEqual((await invoke("/fixture/checkpoint")).value, qualificationCheckpoint);
    // Satisfy the existing disposable qualification cleanup exception itself:
    // empty export, audit prefix and only qualification-named new replay keys.
    // Legacy omission still cannot bypass the exact state/version requirement.
    const cleanupBaseline = structuredClone(f.state);
    cleanupBaseline.idempotency = { "owned-synthetic-qualification:project.create": Object.values(f.state.idempotency)[0] };
    const emptyLegacy = emptyAuthorityPlaneSnapshot(legacy.realmId); delete emptyLegacy.runDetails; delete emptyLegacy.canonicalRefProjections;
    const cleanupCheckpoint = await seed(cleanupBaseline);
    const cleanupBypass = await invoke("/authority/recovery/restore/internal", { sessionId: f.members.owner.session.id, idempotencyKey: "legacy-disposable-cleanup-bypass", qualificationId: "owned-synthetic-qualification", bundle: await sign(emptyLegacy, "legacy-disposable-cleanup-bypass") });
    assert.equal(cleanupBypass.status, 409); assert.match(cleanupBypass.value.receipt, /legacy-baseline-mismatch/u); assert.deepEqual((await invoke("/fixture/checkpoint")).value, cleanupCheckpoint);
    await seed(); await invoke("/fixture/remove-authority-meta", legacy.snapshot);
    const lostBaseline = (await invoke("/fixture/checkpoint")).value;
    assert.equal(lostBaseline.authority, undefined); assert.ok(lostBaseline.sqlRows.entities.length > 0);
    const refusedMissing = await restore(await sign(legacy.snapshot, "missing-sql-meta"));
    assert.equal(refusedMissing.status, 409); assert.match(refusedMissing.value.receipt, /legacy-baseline-missing/u);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value, lostBaseline);
    // Pause the actual normalized-state SHA after verification. Trace actual
    // blockConcurrencyWhile entry, then submit a real competing command while
    // that non-storage await is pending; no timing-only scheduling assertion.
    const concurrencyCheckpoint = await seed();
    assert.equal((await invoke("/fixture/pause-legacy-digest-once")).status, 200);
    const pendingRestore = restore(await sign(legacy.snapshot, "concurrent-legacy-restore"));
    assert.equal(await paused.promise, "true", "legacy digest awaits must hold the actual DO concurrency gate");
    const command = { sessionId: f.members.owner.session.id, command: "project.create", idempotencyKey: "competing-project", payload: { projectId: "project:competing", name: "Competing accepted mutation", referenceType: "git", projectRevisionId: "revision:competing", sourceSpaces: [{ id: "source:competing", name: "Competing", classification: "public", repositoryId: "repository:competing", snapshotId: "2222222222222222222222222222222222222222" }] } };
    const pendingCommand = invoke("/fixture/competing-authority-command", command);
    await dispatched.promise; release.resolve();
    assert.equal((await pendingRestore).status, 200);
    const competing = await pendingCommand; assert.equal(competing.status, 409, JSON.stringify(competing)); assert.match(competing.value.receipt, /quarantined/u);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value.authority, concurrencyCheckpoint.authority);
  } finally { release.resolve(); await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
