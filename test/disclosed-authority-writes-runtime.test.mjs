import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { disclosureFixture } from "./fixtures/authority-disclosure-state.ts";
import { repositoryObservationDigest } from "../src/portability/repository-observation.ts";
import { RealmIdentityPolicy } from "../src/identity/realm.ts";
import { runnerResultDigest } from "../src/execution/runner-proof.ts";
import { CONTRACT_VERSIONS } from "../src/kernel/contracts.ts";
import { ExternalRunnerCoordinator, runnerResultContext, runnerResultMessage } from "../src/execution/runner.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";
import { createAuthorityRecoveryBundle } from "../src/cloudflare/authority-recovery.ts";

test("public disclosed write lifecycle, atomic retries and sealed owner detail use actual local Coordinator SQLite and current kernel policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-disclosed-writes-runtime-")); let runtime;
  try {
    const bundle = await build({ entryPoints: ["test/fixtures/authority-disclosure-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    let observationCalls = 0;
    const observer = async request => {
      observationCalls++; const body = await request.json();
      const claims = { protocol: "anyam.repository-observation/v1", repositoryId: body.repositoryId, sourceSpaceId: body.sourceSpaceId, workspaceId: body.workspaceId, projectViewId: body.projectViewId, objectFormat: "sha1", symbolicRef: body.expectedSymbolicRef ?? "refs/heads/candidate", commitOid: body.expectedCommitOid, treeOid: "c".repeat(40), baseCommitOid: body.expectedBaseCommitOid, ancestryVerified: true, observedAt: new Date(Date.parse("2026-10-02T12:00:00.000Z") + observationCalls).toISOString(), receipt: "synthetic RepositoryDriver readback; no real Git provider" };
      return Response.json({ protocol: claims.protocol, status: "succeeded", observation: { ...claims, manifestDigest: await repositoryObservationDigest(claims) }, receipt: "fixture=synthetic-observer; providerClaim=false" });
    };
    const options = convertV4MiniflareOptions({ name: "disclosed-writes-owned-local", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-02", compatibilityFlags: ["nodejs_compat"], bindings: { ANYAM_AUTHORITY_RECOVERY_KEY_ID: "key:synthetic-runtime-only", ANYAM_AUTHORITY_RECOVERY_SECRET: "synthetic-runtime-recovery-only" }, durableObjects: { REALM_COORDINATOR: { className: "LocalDisclosureRealm", useSQLite: true } }, serviceBindings: { ANYAM_REPOSITORY_OBSERVER: observer }, outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false }; options.resourcePersistencePath = join(directory, "storage"); runtime = new Miniflare(options);
    const invoke = async (path, body, member = "public") => {
      const response = await runtime.dispatchFetch(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-fixture-member": member, ...(path.startsWith("/authority/") ? { [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      try { return { status: response.status, value: JSON.parse(text) }; }
      catch { throw new Error(`non-JSON fixture response at ${path}: status=${response.status}; ${text}`); }
    };
    const fixture = disclosureFixture();
    for (const relationship of Object.values(fixture.identity.relationships)) if (relationship.principalId === fixture.members.public.principal.id) relationship.role = "contributor";
    fixture.identity.sourceSpacePolicies["source:public"].allowedCapabilities = ["source.read", "workspace.write", "change.publish_revision", "run.invoke"];
    const baseOid = "a".repeat(40); const candidateOid = "b".repeat(40);
    fixture.state.projectRevisions["canonical:base"].sourceSpaceSnapshots["source:public"] = baseOid;
    for (const view of Object.values(fixture.state.projectViews)) if (view.disclosedSourceSpaceSnapshots["source:public"]) view.disclosedSourceSpaceSnapshots["source:public"] = baseOid;
    for (const workspace of Object.values(fixture.state.workspaces)) for (const mount of workspace.mounts) if (mount.sourceSpaceId === "source:public") mount.snapshotId = baseOid;
    assert.equal((await invoke("/fixture/seed", fixture)).status, 200);
    const project = await invoke("/api/projects/project%3Afixture"); assert.equal(project.status, 200);
    const result = await invoke("/api/authority/view-command", { command: "workspace.create", idempotencyKey: "fresh-workspace", payload: { projectId: project.value.project.id, projectViewRevisionId: project.value.projectViewRevision.id, sourceSpaceIds: ["source:public"] } });
    assert.equal(result.status, 200, JSON.stringify(result)); const workspaceId = result.value.value.workspace.id; assert.match(workspaceId, /^workspace:/u);
    assert.doesNotMatch(JSON.stringify(result.value), /PRIVATE-|canonical:|candidate:|source:hidden|projectRevisionId|projectViewId|version/u);
    assert.equal((await invoke(`/api/workspaces/${encodeURIComponent(workspaceId)}`)).status, 200);
    const command = async (name, key, payload) => invoke("/api/authority/view-command", { command: name, idempotencyKey: key, payload });
    const baseProjectViewRevisionId = result.value.value.workspace.projectViewRevisionId;
    const change = await command("change.create", "fresh-change", { projectId: "project:fixture", workspaceId, baseProjectViewRevisionId, intentId: "intent:collaboration" });
    assert.equal(change.status, 200, JSON.stringify(change)); const changeId = change.value.value.change.id;
    const publishPayload = { projectId: "project:fixture", workspaceId, changeId, baseProjectViewRevisionId, sourceSpaceSnapshots: { "source:public": candidateOid }, declaredEffects: ["source.propose"], kind: "implementation" };
    const revision = await command("revision.publish", "fresh-revision", publishPayload); assert.equal(revision.status, 200, JSON.stringify(revision)); assert.equal(observationCalls, 1);
    const runPayload = { projectId: "project:fixture", workspaceId, changeRevisionId: revision.value.value.revision.id, projectViewRevisionId: revision.value.value.revision.projectViewRevisionId, actionId: "action:public-check", actionContractDigest: "sha256:synthetic-action", inputDigests: ["src/main.ts=sha256:synthetic-input"] };
    const run = await command("run.request", "fresh-run", runPayload); assert.equal(run.status, 200, JSON.stringify(run)); assert.equal(run.value.value.run.status, "queued");
    for (const response of [change, revision, run]) assert.doesNotMatch(JSON.stringify(response), /PRIVATE-|canonical:|candidate:|source:hidden|projectRevisionId|projectViewId|"version"/u);
    const firstCheckpoint = (await invoke("/fixture/checkpoint", {})).value;
    const next = { ...fixture, state: structuredClone(firstCheckpoint.authority), identity: structuredClone(firstCheckpoint.identity) };
    next.state.projectRevisions["PRIVATE-new-canonical"] = { ...next.state.projectRevisions["canonical:base"], id: "PRIVATE-new-canonical", sourceSpaceSnapshots: { "source:public": baseOid, "source:hidden": "PRIVATE-next" } };
    next.state.canonicalByProject["project:fixture"] = "PRIVATE-new-canonical"; next.state.version += 100;
    await invoke("/fixture/seed", next);
    const beforeReplay = (await invoke("/fixture/checkpoint", {})).value;
    assert.deepEqual(await command("revision.publish", "fresh-revision", publishPayload), revision); assert.equal(observationCalls, 1, "accepted retry must not repeat observation");
    assert.deepEqual(await command("run.request", "fresh-run", runPayload), run);
    assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, beforeReplay, "retries must not persist new Tasks, Grants or Authority state");
    for (const deniedCapability of ["source.read", "workspace.write", "change.publish_revision", "run.invoke"]) {
      const denied = structuredClone(next); denied.identity.sourceSpacePolicies["source:public"].deniedCapabilities = [deniedCapability]; await invoke("/fixture/seed", denied);
      const before = (await invoke("/fixture/checkpoint", {})).value;
      const name = deniedCapability === "workspace.write" ? "workspace.create" : deniedCapability === "change.publish_revision" ? "revision.publish" : "run.request";
      const payload = name === "workspace.create" ? { projectId: "project:fixture", projectViewRevisionId: project.value.projectViewRevision.id, sourceSpaceIds: ["source:public"] } : name === "revision.publish" ? publishPayload : runPayload;
      const deniedResult = await command(name, "denied-capability", payload); assert.equal(deniedResult.status, 404, JSON.stringify(deniedResult));
      const replayKey = name === "workspace.create" ? "fresh-workspace" : name === "revision.publish" ? "fresh-revision" : "fresh-run";
      assert.equal((await command(name, replayKey, payload)).status, 404, "cached acceptance cannot override current Source write denial");
      assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, before, deniedCapability);
    }
    await invoke("/fixture/seed", next);
    const credential = (await invoke("/fixture/issue-synthetic-credential", {})).value;
    assert.equal((await invoke("/fixture/validate-synthetic-credential", { token: credential.token })).value.valid, true);
    const credentialBefore = (await invoke("/fixture/checkpoint", {})).value;
    for (const alias of [credential.token, `input=${credential.token}`, `prefix${credential.token}suffix`, Buffer.from(credential.token).toString("base64")]) {
      const before = (await invoke("/fixture/checkpoint", {})).value;
      assert.equal((await command("run.request", "opaque-credential-input", { ...runPayload, inputDigests: [alias] })).status, 422, "known opaque credential alias is rejected before persistence");
      assert.ok(isDeepStrictEqual((await invoke("/fixture/checkpoint", {})).value, before), "opaque rejection preserves all state without printing material");
    }

    assert.deepEqual(await command("run.request", "fresh-run", runPayload), run);
    assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, credentialBefore, "accepted replay retains unrelated credential digest records");
    assert.equal((await invoke("/fixture/validate-synthetic-credential", { token: credential.token })).value.valid, true);
    for (const sourceSpaceId of ["source:hidden", "source:absent"]) {
      const unavailable = await command("workspace.create", "bad-scope", { projectId: "project:fixture", projectViewRevisionId: project.value.projectViewRevision.id, sourceSpaceIds: [sourceSpaceId] });
      assert.equal(unavailable.status, 404); assert.doesNotMatch(JSON.stringify(unavailable), /source:hidden|source:absent|PRIVATE-/u);
      assert.equal((await invoke("/fixture/validate-synthetic-credential", { token: credential.token })).value.valid, true, "denial does not revoke unrelated credential");
    }
    const raw = await invoke("/api/authority/command", { command: "workspace.create", idempotencyKey: "raw-private-probe", payload: { projectId: "project:fixture", projectRevisionId: "PRIVATE-new-canonical", sourceSpaceIds: ["source:hidden"] } });
    assert.notEqual(raw.status, 200, "ordinary contributor must not bypass safe projection through raw owner commands");

    const faultBefore = (await invoke("/fixture/checkpoint", {})).value;
    await invoke("/fixture/fail-identity-write-once", {});
    const faultPayload = { projectId: "project:fixture", projectViewRevisionId: project.value.projectViewRevision.id, sourceSpaceIds: ["source:public"] };
    assert.equal((await command("workspace.create", "atomic-fault", faultPayload)).status, 503);
    assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, faultBefore, "actual SQL, identity KV and in-memory policy must roll back together");
    assert.equal((await invoke("/fixture/validate-synthetic-credential", { token: credential.token })).value.valid, true, "rollback retains the unrelated live credential");
    assert.equal((await command("workspace.create", "atomic-fault", faultPayload)).status, 200, "same request can recover after rolled-back persistence fault");
    const credentialInputBefore = (await invoke("/fixture/checkpoint", {})).value;
    const credentialInput = await command("run.request", "credential-input", { ...runPayload, inputDigests: ["input=Bearer SYNTHETIC-TEST-ONLY"] });
    assert.equal(credentialInput.status, 422); assert.doesNotMatch(JSON.stringify(credentialInput), /SYNTHETIC-TEST-ONLY/u);
    assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, credentialInputBefore, "credential material cannot enter a queued Run or idempotency history");

    const checkpoint = (await invoke("/fixture/checkpoint", {})).value;
    const queuedRun = checkpoint.authority.runs[run.value.value.run.id];
    const input = {
      action: { protocol: CONTRACT_VERSIONS.action, id: queuedRun.actionId, moduleId: "module:synthetic", moduleRoot: ".", dependencyIds: [], command: "synthetic-result-only", inputGlobs: [], outputPaths: ["result.txt"], network: [], resources: { profile: "linux-amd64" }, contractDigest: queuedRun.actionContractDigest },
      projectRevisionId: queuedRun.projectRevisionId, projectViewId: queuedRun.projectViewId, changeRevisionId: queuedRun.changeRevisionId, workspaceId: queuedRun.workspaceId,
      sourceSpaceSnapshots: { ...checkpoint.authority.changeRevisions[queuedRun.changeRevisionId].sourceSpaceSnapshots }, inputDigests: queuedRun.inputDigests, effectDigests: queuedRun.effectDigests ?? [],
      dependencyDigest: "unsigned-dependency", toolchainDigest: "unsigned-toolchain", environmentDigest: "unsigned-environment", policyVersion: queuedRun.policyVersion,
      authorizationEpoch: String(checkpoint.identity.realm.authorizationEpoch), disclosure: { projectionId: queuedRun.projectViewId, classification: "project" }, actor: queuedRun.actor, capabilityGrantId: queuedRun.capabilityGrantId, runnerId: "runner:unassigned",
    };
    // Real enrollment/claim/result cryptography, synthetic execution and auth
    // contexts. No process, model, repository or provider execution is claimed.
    const pair = generateKeyPairSync("ed25519");
    const signMessage = message => sign(null, Buffer.from(message), pair.privateKey).toString("base64url");
    const runner = new ExternalRunnerCoordinator({ realmId: fixture.identity.realm.id, projectId: "project:fixture", now: () => "2026-10-02T12:00:00.000Z" });
    const profile = runner.enrollRunner({ id: "runner:synthetic-local", provider: "internal-runner", publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), platform: { operatingSystem: "linux", architecture: "amd64", isolation: "container" }, capabilities: ["os:linux", "arch:amd64", "isolation:container"], networkDestinations: [], networkEnforcement: "deny-all", networkBoundaryReceipt: "qualification=synthetic; networkEnforcement=deny-all; processExecution=false", secretUse: "none", canUploadArtifacts: true, canUploadEvidence: true, approvedBy: input.actor, enrollmentReceipt: "synthetic enrollment; signing qualified" });
    runner.activateRunner(profile.id, input.actor);
    const enrolled = runner.getRunner(profile.id);
    assert.equal((await invoke("/authority/runner-profile/internal", { runnerProfile: enrolled })).status, 200);
    const complete = async (runId, suffix, outputDigest = "sha256:synthetic-output", expectedStatus = 200) => {
      const current = (await invoke("/fixture/checkpoint", {})).value.authority.runs[runId];
      const actionInput = { ...input, capabilityGrantId: current.capabilityGrantId, policyVersion: current.policyVersion, actor: current.actor };
      const job = runner.enqueue({ runId, idempotencyKey: `synthetic-job:${suffix}`, actionInput, runnerRequirements: ["os:linux", "arch:amd64", "isolation:container"], outputLocations: { logs: "synthetic/logs", artifacts: "synthetic/artifacts", evidence: "synthetic/evidence" }, leaseExpiresAt: "2026-10-02T13:00:00.000Z" });
      const offer = runner.pull(profile.id); assert.ok(offer);
      const lease = runner.claim({ runnerId: profile.id, jobId: job.job.id, attemptId: offer.attempt.id, challenge: offer.challenge, signature: signMessage(`anyam.runner-claim/v1|${offer.challenge}`) });
      const context = runnerResultContext({ job: lease.job, attempt: lease.attempt });
      const result = { context, status: "succeeded", output: { status: "succeeded", exitCode: 0, inputDigests: [...job.job.inputDigests], outputDigests: [`result.txt=${outputDigest}`], outputDigest, stdoutDigest: "sha256:synthetic-stdout", stderrDigest: "sha256:synthetic-stderr" }, outputs: [] };
      result.signature = signMessage(runnerResultMessage(result));
      const completion = runner.submit({ credential: lease.credential, result });
      const beforeAcceptance = (await invoke("/fixture/checkpoint", {})).value;
      const accepted = await invoke("/authority/runner-complete/internal", { idempotencyKey: `synthetic-completion:${suffix}`, completion });
      assert.equal(accepted.status, expectedStatus);
      if (expectedStatus !== 200) assert.ok(isDeepStrictEqual((await invoke("/fixture/checkpoint", {})).value, beforeAcceptance), "rejected signed credential alias persists no proof or state");
      return completion;
    };
    const completion = await complete(queuedRun.id, "first");
    const path = `/api/authority/run-details/${encodeURIComponent(queuedRun.id)}`;
    const rich = await invoke(path, undefined, "owner"); assert.equal(rich.status, 200, JSON.stringify(rich));
    assert.equal(rich.value.proof.signatureVerified, true); assert.equal(rich.value.proof.resultDigest, completion.resultDigest);
    assert.deepEqual(rich.value.context.sourceSpaceSnapshots, { "source:public": candidateOid });
    assert.doesNotMatch(JSON.stringify(rich), /sessionId|capabilityGrantId|publicKey|privateKey|credentialId|unsigned-|source:hidden|PRIVATE-|projectRevisionId|projectViewId|networkBoundaryReceipt/u);
    const knownProofCredential = (await invoke("/fixture/issue-synthetic-credential", {})).value;
    const opaqueRun = await command("run.request", "opaque-proof-run", runPayload); assert.equal(opaqueRun.status, 200);
    await complete(opaqueRun.value.value.run.id, "opaque-proof", knownProofCredential.token, 422);
    assert.equal((await invoke(`/api/authority/run-details/${encodeURIComponent(opaqueRun.value.value.run.id)}`, undefined, "owner")).status, 404);
    const aliasState = structuredClone((await invoke("/fixture/checkpoint", {})).value.authority);
    const aliasDetail = aliasState.runDetails[queuedRun.id];
    aliasDetail.result.output.outputDigest = knownProofCredential.token;
    aliasDetail.result.output.outputDigests = [`result.txt=${knownProofCredential.token}`];
    aliasDetail.result.signature = signMessage(runnerResultMessage(aliasDetail.result));
    aliasDetail.resultDigest = await runnerResultDigest({ jobId: aliasDetail.job.id, attemptId: aliasDetail.attempt.id, result: aliasDetail.result });
    aliasDetail.attempt.resultDigest = aliasDetail.resultDigest;
    aliasState.runnerAttempts[aliasDetail.attempt.id].resultDigest = aliasDetail.resultDigest;
    aliasState.runs[queuedRun.id].outputDigest = aliasDetail.result.output.outputDigest;
    aliasState.runs[queuedRun.id].outputDigests = aliasDetail.result.output.outputDigests;
    const proofState = (await invoke("/fixture/checkpoint", {})).value.authority;
    await invoke("/fixture/replace-authority", aliasState);
    assert.equal((await invoke(path, undefined, "owner")).status, 404, "otherwise valid signed proof cannot project a known opaque credential");
    await invoke("/fixture/replace-authority", proofState);
    assert.equal((await invoke("/fixture/validate-synthetic-credential", { token: knownProofCredential.token })).value.valid, true);
    const sealedCheckpoint = (await invoke("/fixture/checkpoint", {})).value;
    assert.equal(sealedCheckpoint.authority.runDetails[queuedRun.id].resultDigest, completion.resultDigest, "accepted proof persisted in actual SQLite");
    const exported = await invoke("/authority/recovery/export/internal", { sessionId: fixture.members.owner.session.id }); assert.equal(exported.status, 200);
    assert.deepEqual(exported.value.bundle.snapshot.runDetails[queuedRun.id], sealedCheckpoint.authority.runDetails[queuedRun.id]);
    const restore = async bundle => {
      const restored = await invoke("/authority/recovery/restore/internal", { sessionId: fixture.members.owner.session.id, idempotencyKey: `restore:${bundle.bundleId}`, bundle }); assert.equal(restored.status, 200, JSON.stringify(restored));
      const activated = await invoke("/authority/recovery/activate/internal", { sessionId: fixture.members.owner.session.id, idempotencyKey: `activate:${bundle.bundleId}`, bundleId: bundle.bundleId, bundleDigest: bundle.bundleDigest }); assert.equal(activated.status, 200, JSON.stringify(activated));
    };
    await restore(exported.value.bundle); assert.deepEqual(await invoke(path, undefined, "owner"), rich, "signed detail survives actual recovery restore");
    const legacy = structuredClone(sealedCheckpoint.authority); delete legacy.runDetails;
    const legacyBundle = await createAuthorityRecoveryBundle({ snapshot: legacy, bundleId: "bundle:synthetic-legacy", recoveryKeyId: "key:synthetic-runtime-only", secret: "synthetic-runtime-recovery-only" });
    await restore(legacyBundle);
    assert.deepEqual((await invoke("/fixture/checkpoint", {})).value.authority.runDetails, {}, "old signed bytes verify before new additive collection is defaulted");
    assert.equal((await invoke(path, undefined, "owner")).status, 404, "legacy restore cannot fabricate accepted detail");
    await invoke("/fixture/seed", { ...fixture, state: sealedCheckpoint.authority, identity: sealedCheckpoint.identity });
    for (const member of ["public", "private", "projectOwner", "unrelated"]) {
      const denied = await invoke(path, undefined, member); assert.equal(denied.status, 404, member);
      assert.deepEqual(denied, await invoke("/api/authority/run-details/run%3Aabsent", undefined, member), `${member} cannot discover detail presence`);
    }
    const reseed = (state, identity = sealedCheckpoint.identity) => invoke("/fixture/seed", { ...fixture, state, identity });
    const tampered = structuredClone(sealedCheckpoint.authority); tampered.runDetails[queuedRun.id].result.signature = "tampered";
    await reseed(tampered); assert.equal((await invoke(path, undefined, "owner")).status, 404);
    const coarse = await invoke("/authority/runs/internal", { sessionId: fixture.members.public.session.id, runId: queuedRun.id }); assert.equal(coarse.value.run.status, "succeeded");
    assert.doesNotMatch(JSON.stringify(coarse), /Digest|runnerId|verifierId|source:hidden/u);
    for (const kind of ["source-read", "scoped-evidence"]) {
      const deniedIdentity = structuredClone(sealedCheckpoint.identity);
      if (kind === "source-read") deniedIdentity.sourceSpacePolicies["source:hidden"].readerPrincipalIds = [fixture.members.private.principal.id];
      else for (const relationship of Object.values(deniedIdentity.relationships)) if (relationship.principalId === fixture.members.owner.principal.id) relationship.deniedCapabilities = ["evidence.read"];
      await reseed(sealedCheckpoint.authority, deniedIdentity); assert.equal((await invoke(path, undefined, "owner")).status, 404, kind);
    }
    await reseed(sealedCheckpoint.authority); await invoke("/fixture/revoke", { sessionId: fixture.members.owner.session.id });
    assert.notEqual((await invoke(path, undefined, "owner")).status, 200);
    await reseed(sealedCheckpoint.authority);
    assert.equal((await invoke("/api/authority/run-details/run%3Apublic", undefined, "owner")).status, 404, "unsigned legacy Run cannot fabricate accepted rich detail");
    for (const [kind, handle] of [["session", fixture.members.private.session.id], ["grant", queuedRun.capabilityGrantId], ["passkey", "synthetic-private-passkey"]]) {
      const aliasRun = await command("run.request", `${kind}-alias`, runPayload); assert.equal(aliasRun.status, 200);
      await complete(aliasRun.value.value.run.id, `alias:${kind}`, handle);
      assert.equal((await invoke(`/api/authority/run-details/${encodeURIComponent(aliasRun.value.value.run.id)}`, undefined, "owner")).status, 404, `signed digest alias cannot disclose ${kind} handle`);
    }

    const multiCheckpoint = (await invoke("/fixture/checkpoint", {})).value;
    const multiIdentity = structuredClone(multiCheckpoint.identity);
    for (const relationship of Object.values(multiIdentity.relationships)) if (relationship.principalId === fixture.members.private.principal.id) relationship.role = "contributor";
    multiIdentity.sourceSpacePolicies["source:hidden"].allowedCapabilities = ["source.read", "workspace.write", "change.publish_revision", "run.invoke"];
    const multiState = structuredClone(multiCheckpoint.authority);
    multiState.projectRevisions[multiState.canonicalByProject["project:fixture"]].sourceSpaceSnapshots["source:hidden"] = "e".repeat(40);
    await reseed(multiState, multiIdentity);
    const publicBefore = await invoke("/api/projects/project%3Afixture");
    const privateProject = await invoke("/api/projects/project%3Afixture", undefined, "private");
    const multiPayload = { projectId: "project:fixture", projectViewRevisionId: privateProject.value.projectViewRevision.id, sourceSpaceIds: ["source:public", "source:hidden"] };
    const multi = await invoke("/api/authority/view-command", { command: "workspace.create", idempotencyKey: "multi-source", payload: multiPayload }, "private");
    assert.equal(multi.status, 200, JSON.stringify(multi));
    assert.equal(multi.value.value.mountCount, 2);
    const multiId = multi.value.value.workspace.id;
    assert.deepEqual(await invoke(`/api/workspaces/${encodeURIComponent(multiId)}`), await invoke("/api/workspaces/workspace%3Aabsent"), "mixed-source workspace is not discoverable to public reader");
    assert.deepEqual(await invoke("/api/projects/project%3Afixture"), publicBefore, "private write does not alter public Project counts or revision identity");
    const multiDeniedCheckpoint = (await invoke("/fixture/checkpoint", {})).value;
    const multiDeniedIdentity = structuredClone(multiDeniedCheckpoint.identity); multiDeniedIdentity.sourceSpacePolicies["source:hidden"].deniedCapabilities = ["workspace.write"];
    await reseed(multiDeniedCheckpoint.authority, multiDeniedIdentity);
    const multiDeniedBefore = (await invoke("/fixture/checkpoint", {})).value;
    const multiDenied = await invoke("/api/authority/view-command", { command: "workspace.create", idempotencyKey: "multi-source", payload: multiPayload }, "private");
    assert.equal(multiDenied.status, 404); assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, multiDeniedBefore, "every contributing Source must authorize a cached multi-source write");
    const legacyOwnerIdentity = structuredClone(multiDeniedCheckpoint.identity);
    legacyOwnerIdentity.sourceSpacePolicies["source:public"].deniedCapabilities = ["workspace.write"];
    await reseed(multiDeniedCheckpoint.authority, legacyOwnerIdentity);
    const legacyBefore = (await invoke("/fixture/checkpoint", {})).value;
    const legacyBody = { command: "workspace.create", idempotencyKey: "legacy-owner-scope", payload: { projectId: "project:fixture", projectRevisionId: multiState.canonicalByProject["project:fixture"], sourceSpaceIds: ["source:public"], workspaceId: "workspace:legacy-owner" } };
    assert.equal((await invoke("/api/authority/command", legacyBody, "owner")).status, 404, "raw owner route cannot bypass explicit Source write denial");
    assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, legacyBefore);
    await reseed(multiDeniedCheckpoint.authority, multiDeniedCheckpoint.identity);
    const legacyAccepted = await invoke("/api/authority/command", legacyBody, "owner"); assert.equal(legacyAccepted.status, 200);
    const legacyCredentialInputBefore = (await invoke("/fixture/checkpoint", {})).value;
    assert.equal((await invoke("/api/authority/command", { ...legacyBody, idempotencyKey: "legacy-secret-input", payload: { ...legacyBody.payload, mounts: ["Bearer SYNTHETIC-TEST-ONLY"] } }, "owner")).status, 422);
    assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, legacyCredentialInputBefore);
    const legacyCredential = (await invoke("/fixture/issue-synthetic-credential", {})).value;
    const legacyReplayBefore = (await invoke("/fixture/checkpoint", {})).value;
    assert.deepEqual(await invoke("/api/authority/command", legacyBody, "owner"), legacyAccepted);
    assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, legacyReplayBefore);
    assert.equal((await invoke("/fixture/validate-synthetic-credential", { token: legacyCredential.token })).value.valid, true);
    const legacyDenied = (await invoke("/fixture/checkpoint", {})).value;
    legacyDenied.identity.sourceSpacePolicies["source:public"].deniedCapabilities = ["workspace.write"];
    await reseed(legacyDenied.authority, legacyDenied.identity);
    const revokedLegacyBefore = (await invoke("/fixture/checkpoint", {})).value;
    assert.equal((await invoke("/api/authority/command", legacyBody, "owner")).status, 404, "raw cached acceptance cannot bypass current Source denial");
    assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, revokedLegacyBefore);
    const legacyViewId = multiDeniedCheckpoint.authority.workspaces["workspace:public"].projectViewId;
    for (const [name, capability, payload] of [
      ["change.create", "change.publish_revision", { projectId: "project:fixture", workspaceId: "workspace:public", intentId: "intent:collaboration", baseProjectRevisionId: "canonical:base" }],
      ["revision.publish", "change.publish_revision", { projectId: "project:fixture", workspaceId: "workspace:public", changeId: "change:public", projectViewId: legacyViewId, sourceSpaceSnapshots: { "source:public": candidateOid } }],
      ["run.request", "run.invoke", { projectId: "project:fixture", workspaceId: "workspace:public", projectViewId: legacyViewId, projectRevisionId: "candidate:public", changeRevisionId: "revision:public", actionId: "action:synthetic-denied" }],
    ]) {
      const deniedIdentity = structuredClone(multiDeniedCheckpoint.identity); deniedIdentity.sourceSpacePolicies["source:public"].deniedCapabilities = [capability];
      await reseed(multiDeniedCheckpoint.authority, deniedIdentity); const before = (await invoke("/fixture/checkpoint", {})).value;
      assert.equal((await invoke("/api/authority/command", { command: name, idempotencyKey: `legacy-denied:${name}`, payload }, "owner")).status, 404, name);
      assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, before, name);
    }

    // The retained owner route must derive omitted binding IDs from records.
    // Current scoped denies outrank caller payload omissions and cached intent.
    for (const [name, capability, scoped, payload] of [
      ["run.request", "run.invoke", { changeId: "change:public" }, { projectId: "project:fixture", workspaceId: "workspace:public", projectViewId: legacyViewId, projectRevisionId: "candidate:public", changeRevisionId: "revision:public", actionId: "action:derived-context", policyVersion: multiDeniedCheckpoint.identity.realm.policyVersion, capabilityGrantId: "synthetic-caller-grant" }],
      ["revision.publish", "change.publish_revision", { workspaceId: "workspace:public" }, { projectId: "project:fixture", changeId: "change:public", projectViewId: legacyViewId, sourceSpaceSnapshots: { "source:public": candidateOid } }],
    ]) {
      const scopedPolicy = new RealmIdentityPolicy({ realmId: fixture.identity.realm.id, relyingPartyId: fixture.identity.realm.relyingPartyId, now: () => new Date("2026-10-02T12:00:00.000Z") });
      scopedPolicy.restoreOperationalSnapshot(multiDeniedCheckpoint.identity);
      scopedPolicy.addRelationship({ principalId: fixture.members.owner.principal.id, kind: "organization-member", subjectId: "synthetic-scoped-deny", role: "owner", resource: { realmId: fixture.identity.realm.id, projectId: "project:fixture", ...scoped }, deniedCapabilities: [capability] });
      await reseed(multiDeniedCheckpoint.authority, scopedPolicy.getRecoverySnapshot());
      const before = (await invoke("/fixture/checkpoint", {})).value; const observationsBefore = observationCalls;
      assert.equal((await invoke("/api/authority/command", { command: name, idempotencyKey: `derived-deny:${name}`, payload }, "owner")).status, 404, name);
      assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, before);
      assert.equal(observationCalls, observationsBefore, "a scoped deny precedes repository observation");
    }
    await reseed(multiDeniedCheckpoint.authority, multiDeniedCheckpoint.identity);
    const rawPublish = { command: "revision.publish", idempotencyKey: "raw-dynamic-observation", payload: { projectId: "project:fixture", changeId: "change:public", sourceSpaceSnapshots: { "source:public": candidateOid } } };
    const observationsBefore = observationCalls;
    const rawPublished = await invoke("/api/authority/command", rawPublish, "owner"); assert.equal(rawPublished.status, 200, JSON.stringify(rawPublished));
    assert.equal(observationCalls, observationsBefore + 1);
    const rawCredential = (await invoke("/fixture/issue-synthetic-credential", {})).value;
    const rawBeforeRetry = (await invoke("/fixture/checkpoint", {})).value;
    for (let attempt = 0; attempt < 2; attempt++) assert.deepEqual(await invoke("/api/authority/command", rawPublish, "owner"), rawPublished);
    assert.equal(observationCalls, observationsBefore + 1, "timestamp-changing observer is not called by accepted legacy retries");
    assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, rawBeforeRetry);
    const changedRaw = { ...rawPublish, payload: { ...rawPublish.payload, kind: "review" } };
    assert.equal((await invoke("/api/authority/command", changedRaw, "owner")).status, 409);
    assert.equal(observationCalls, observationsBefore + 1);
    assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, rawBeforeRetry);
    const rawOpaque = { command: "run.request", idempotencyKey: "raw-opaque-input", payload: { projectId: "project:fixture", workspaceId: "workspace:public", projectViewId: legacyViewId, projectRevisionId: "candidate:public", changeRevisionId: "revision:public", actionId: "action:opaque", inputDigests: [`input=${rawCredential.token}`] } };
    assert.equal((await invoke("/api/authority/command", rawOpaque, "owner")).status, 422);
    assert.ok(isDeepStrictEqual((await invoke("/fixture/checkpoint", {})).value, rawBeforeRetry));
    assert.equal((await invoke("/fixture/validate-synthetic-credential", { token: rawCredential.token })).value.valid, true);
    const rawRevoked = (await invoke("/fixture/checkpoint", {})).value;
    rawRevoked.identity.sourceSpacePolicies["source:public"].deniedCapabilities = ["change.publish_revision"];
    await reseed(rawRevoked.authority, rawRevoked.identity);
    const rawRevokedBefore = (await invoke("/fixture/checkpoint", {})).value;
    assert.equal((await invoke("/api/authority/command", changedRaw, "owner")).status, 404, "original scope revocation outranks a changed accepted payload");
    assert.equal(observationCalls, observationsBefore + 1);
    assert.deepEqual((await invoke("/fixture/checkpoint", {})).value, rawRevokedBefore);

  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
