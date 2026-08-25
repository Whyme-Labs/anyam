import assert from "node:assert/strict";
import test from "node:test";

import { handleAnyamRealmMcpRequest, type AnyamRealmMcpEnv, type AnyamRealmMcpProps } from "../apps/realm-worker/src/mcp-handler.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";

type JsonRpcBody = Record<string, unknown>;

function env(): { env: AnyamRealmMcpEnv; calls: Array<{ path: string; body: Record<string, unknown> }> } {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const idempotency = new Map<string, { fingerprint: string; result: Record<string, unknown> }>();
  const intents = new Map<string, Record<string, unknown>>();
  const intentComments = new Map<string, Record<string, unknown>>();
  const namespace = {
    idFromName: (name: string): string => name,
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        const body = await request.json() as Record<string, unknown>;
        calls.push({ path, body });
        if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return new Response(JSON.stringify({ code: "internal_binding_required" }), { status: 403 });
        if (body.sessionId !== "kernel-session:owner" && body.sessionId !== "kernel-session:agent") return new Response(JSON.stringify({ code: "session.invalid", receipt: "session=invalid; project=not-disclosed" }), { status: 403 });
        if (path === "/identity/oauth-grant/validate-delivery") {
          if (body.grantId === "grant:mcp:revoked") return new Response(JSON.stringify({ code: "oauth.delivery_grant_inactive", receipt: "oauthGrant=taskGrant-invalid-or-stale; credentialFree=true; canonicalWrite=false" }), { status: 403 });
          if (body.grantId === "grant:mcp:expired") return new Response(JSON.stringify({ code: "oauth.delivery_grant_inactive", receipt: "oauthGrant=expired; credentialFree=true; canonicalWrite=false" }), { status: 403 });
          if (body.grantId === "grant:mcp:stale-epoch") return new Response(JSON.stringify({ code: "oauth.delivery_grant_inactive", receipt: "oauthGrant=authorization-epoch-stale; credentialFree=true; canonicalWrite=false" }), { status: 403 });
          if ((body.payload as Record<string, unknown> | undefined)?.projectId === "project:cross") return new Response(JSON.stringify({ code: "oauth.delivery_resource_denied", receipt: "mcpDelivery=project-mismatch; discoverable=false; canonicalWrite=false" }), { status: 404 });
          if (body.grantId === "grant:mcp:denied") return new Response(JSON.stringify({ code: "oauth.delivery_action_denied", receipt: "oauthGrant=action-denied; credentialFree=true; canonicalWrite=false" }), { status: 403 });
          return new Response(JSON.stringify({ protocol: "anyam.realm-coordinator/v1", status: "delivery-grant-valid", credentialFree: true, canonicalWrite: false, providerExecution: "not-performed", receipt: "mcpDelivery=task-grant-live; oauthGrant=resource-bound; sourceSpaces=1; canonicalWrite=false" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path === "/authority/intents/internal") {
          const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
          const intentId = typeof body.intentId === "string" ? body.intentId : undefined;
          const matches = [...intents.values()].filter((intent) => (projectId === undefined || intent.projectId === projectId) && (intentId === undefined || intent.id === intentId));
          if (intentId !== undefined && matches.length === 0) return new Response(JSON.stringify({ code: "not_found", receipt: "intent=hidden; discoverable=false" }), { status: 404 });
          const summary = (intent: Record<string, unknown>): Record<string, unknown> => ({ intent, comments: [...intentComments.values()].filter((comment) => comment.intentId === intent.id), project: { protocol: "anyam.project/v1", id: intent.projectId, name: "MCP Project", referenceType: "git" } });
          if (intentId !== undefined) return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", ...summary(matches[0]!), receipt: "authority=coordinator; operation=intent.inspect; readOnly=true; credentialFree=true; canonicalWrite=false" }), { status: 200, headers: { "content-type": "application/json" } });
          const listed = matches.sort((left, right) => String(left.id).localeCompare(String(right.id))).map((intent) => ({ ...summary(intent), commentCount: [...intentComments.values()].filter((comment) => comment.intentId === intent.id).length }));
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", intents: listed, receipt: `authority=coordinator; operation=intent.list; intentCount=${listed.length}; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path === "/authority/command/internal" || path === "/authority/mcp-command/internal") {
          if (body.protocol !== "anyam.authority-command/v1" || typeof body.command !== "string" || typeof body.idempotencyKey !== "string" || body.payload === null || typeof body.payload !== "object" || Array.isArray(body.payload)) return new Response(JSON.stringify({ code: "invalid_request", receipt: "command=typed-required; credentialFree=true" }), { status: 422 });
          const key = `${String(body.command)}:${String(body.idempotencyKey)}`;
          const fingerprint = JSON.stringify({ command: body.command, payload: body.payload, expectedVersion: body.expectedVersion });
          const prior = idempotency.get(key);
          if (prior) {
            if (prior.fingerprint !== fingerprint) return new Response(JSON.stringify({ code: "idempotency_conflict", recoveryAction: "reuse the original idempotency payload", receipt: "idempotency=conflict; credentialFree=true; canonicalWrite=false" }), { status: 409 });
            return new Response(JSON.stringify(prior.result), { status: 200, headers: { "content-type": "application/json" } });
          }
          const payload = body.payload as Record<string, unknown>;
          let value: Record<string, unknown>;
          if (body.command === "project.create") {
            value = {
              project: { protocol: "anyam.project/v1", id: typeof payload.projectId === "string" ? payload.projectId : "project:mcp", name: "MCP Project", referenceType: "git", sourceSpaceIds: ["source:mcp-public"] },
              canonicalRevision: { protocol: "anyam.kernel/v1", id: "project-revision:mcp:1", projectId: "project:mcp", sourceSpaceSnapshots: { "source:mcp-public": "git:mcp-base" } },
              sourceSpaces: [{ protocol: "anyam.source-space/v1", id: "source:mcp-public", name: "public", classification: "public", snapshotId: "git:mcp-base" }],
            };
          } else if (body.command === "workspace.create") {
            if (payload.projectId === "project:missing") return new Response(JSON.stringify({ code: "not_found", receipt: "workspace=hidden; discoverable=false" }), { status: 404 });
            value = {
              workspace: { protocol: "anyam.workspace/v1", id: "workspace:mcp", projectId: String(payload.projectId), projectRevisionId: String(payload.projectRevisionId), projectViewId: "project-view:mcp:1", state: "active", changeId: payload.changeId },
              view: { protocol: "anyam.project-view/v1", id: "project-view:mcp:1", projectId: String(payload.projectId), projectRevisionId: String(payload.projectRevisionId), projectionId: "projection:mcp:1", classification: "public", visibleSourceSpaceIds: ["source:mcp-public"], mounts: payload.mounts },
            };
          } else if (body.command === "change.create") {
            value = {
              change: { protocol: "anyam.change/v1", id: typeof payload.changeId === "string" ? payload.changeId : "change:mcp", projectId: String(payload.projectId), intentId: String(payload.intentId), baseProjectRevisionId: typeof payload.baseProjectRevisionId === "string" ? payload.baseProjectRevisionId : "project-revision:mcp:1", status: "active", latestRevisionId: null, workspaceId: payload.workspaceId, author: { id: "owner:private" } },
            };
          } else if (body.command === "revision.publish") {
            if (payload.projectId === "project:missing") return new Response(JSON.stringify({ code: "not_found", receipt: "revision=hidden; discoverable=false" }), { status: 404 });
            value = {
              revision: { protocol: "anyam.change/v1", id: typeof payload.revisionId === "string" ? payload.revisionId : "change-revision:mcp:1", changeId: String(payload.changeId), projectRevisionId: String(payload.projectRevisionId), projectViewId: String(payload.projectViewId), sequence: 1, parentRevisionId: undefined, baseProjectRevisionId: "project-revision:mcp:1", workspaceId: String(payload.workspaceId), declaredEffects: payload.declaredEffects, sourceSpaceSnapshots: payload.sourceSpaceSnapshots, affectedSourceSpaceIds: Object.keys(payload.sourceSpaceSnapshots as Record<string, unknown>), author: { id: "owner:private" }, kind: payload.kind ?? "implementation" },
                change: { protocol: "anyam.change/v1", id: String(payload.changeId), projectId: String(payload.projectId), intentId: "intent:mcp", baseProjectRevisionId: "project-revision:mcp:1", status: "submitted", latestRevisionId: typeof payload.revisionId === "string" ? payload.revisionId : "change-revision:mcp:1", workspaceId: String(payload.workspaceId), author: { id: "owner:private" } },
            };
          } else if (body.command === "intent.create") {
            const intentId = typeof payload.intentId === "string" ? payload.intentId : `intent:mcp:${intents.size + 1}`;
            const intent = { protocol: "anyam.intent/v1", id: intentId, projectId: String(payload.projectId), title: String(payload.title), description: typeof payload.description === "string" ? payload.description : "", status: "open", author: { principalId: "principal:agent", actorId: "agent:mcp", sessionId: String(body.sessionId), clientId: "client:mcp" }, assigneePrincipalIds: Array.isArray(payload.assigneePrincipalIds) ? payload.assigneePrincipalIds : [], labels: Array.isArray(payload.labels) ? payload.labels : [], disclosure: typeof payload.disclosure === "string" ? payload.disclosure : "project", createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z", receipt: "intent=created; credentialFree=true" };
            intents.set(intentId, intent);
            value = { intent };
          } else if (body.command === "intent.assign" || body.command === "intent.comment" || body.command === "intent.close" || body.command === "intent.reopen") {
            const intentId = String(payload.intentId);
            const existing = intents.get(intentId);
            if (!existing) return new Response(JSON.stringify({ code: "not_found", receipt: "intent=hidden; discoverable=false" }), { status: 404 });
            if (body.command === "intent.assign") {
              const updated = { ...existing, assigneePrincipalIds: Array.isArray(payload.assigneePrincipalIds) ? payload.assigneePrincipalIds : [], updatedAt: "2026-08-25T00:01:00.000Z", receipt: "intent=assigned; credentialFree=true" };
              intents.set(intentId, updated);
              value = { intent: updated };
            } else if (body.command === "intent.comment") {
              const commentId = typeof payload.commentId === "string" ? payload.commentId : `intent-comment:mcp:${intentComments.size + 1}`;
              const comment = { protocol: "anyam.intent-comment/v1", id: commentId, intentId, projectId: String(existing.projectId), author: existing.author, body: String(payload.body), disclosure: typeof payload.disclosure === "string" ? payload.disclosure : existing.disclosure, createdAt: "2026-08-25T00:02:00.000Z", receipt: "intent=commented; credentialFree=true" };
              intentComments.set(commentId, comment);
              value = { intent: existing, comment };
            } else {
              const updated = { ...existing, status: body.command === "intent.close" ? "closed" : "open", updatedAt: "2026-08-25T00:03:00.000Z", receipt: `intent=${body.command === "intent.close" ? "closed" : "reopened"}; credentialFree=true` };
              intents.set(intentId, updated);
              value = { intent: updated };
            }
          } else if (body.command === "run.request") {
            if (payload.projectId === "project:missing") return new Response(JSON.stringify({ code: "not_found", receipt: "run=hidden; discoverable=false" }), { status: 404 });
            value = {
              run: { protocol: "anyam.run/v1", id: typeof payload.runId === "string" ? payload.runId : "run:mcp:1", actionId: String(payload.actionId), projectRevisionId: String(payload.projectRevisionId), projectViewId: String(payload.projectViewId), runnerId: "runner:unassigned", status: "queued", changeRevisionId: payload.changeRevisionId, workspaceId: payload.workspaceId, inputDigests: payload.inputDigests, outputDigests: payload.outputDigests, actionContractDigest: payload.actionContractDigest, verifierId: payload.verifierId, verifierContractDigest: payload.verifierContractDigest },
            };
          } else if (body.command === "landing.apply") {
            if (payload.projectId === "project:missing") return new Response(JSON.stringify({ code: "not_found", receipt: "landing=hidden; discoverable=false" }), { status: 404 });
            value = {
              landing: { protocol: "anyam.landing/v1", id: typeof payload.landingId === "string" ? payload.landingId : "landing:mcp:1", projectId: String(payload.projectId), changeId: String(payload.changeId), changeRevisionId: String(payload.changeRevisionId), previousProjectRevisionId: "project-revision:mcp:1", projectRevisionId: String(payload.projectRevisionId ?? "project-revision:mcp:2") },
              canonicalRevision: { protocol: "anyam.kernel/v1", id: String(payload.projectRevisionId ?? "project-revision:mcp:2"), projectId: String(payload.projectId) },
              change: { protocol: "anyam.change/v1", id: String(payload.changeId), projectId: String(payload.projectId), intentId: "intent:mcp", baseProjectRevisionId: "project-revision:mcp:1", status: "landed", latestRevisionId: String(payload.changeRevisionId) },
            };
          } else if (body.command === "release.create") {
            if (payload.projectId === "project:missing") return new Response(JSON.stringify({ code: "not_found", receipt: "release=hidden; discoverable=false" }), { status: 404 });
            value = {
              release: { protocol: "anyam.release/v1", id: typeof payload.releaseId === "string" ? payload.releaseId : "release:mcp:1", projectId: String(payload.projectId), projectRevisionId: String(payload.projectRevisionId), artifactIds: payload.artifactIds, evidenceIds: payload.evidenceIds, policyVersion: String(payload.policyVersion), status: "ready", name: payload.name, changeRevisionId: payload.changeRevisionId },
            };
          } else if (body.command === "target.configure") {
            if (payload.projectId === "project:missing") return new Response(JSON.stringify({ code: "not_found", receipt: "target=hidden; discoverable=false" }), { status: 404 });
            value = {
              target: { protocol: "anyam.target/v1", id: typeof payload.targetId === "string" ? payload.targetId : "target:mcp:1", projectId: String(payload.projectId), name: String(payload.name), adapterId: String(payload.adapterId), acceptedArtifactTypes: payload.acceptedArtifactTypes, requiredEvidenceKeys: payload.requiredEvidenceKeys ?? [], state: "configured" },
            };
          } else if (body.command === "promotion.request") {
            if (payload.projectId === "project:missing") return new Response(JSON.stringify({ code: "not_found", receipt: "promotion=hidden; discoverable=false" }), { status: 404 });
            value = {
              promotion: { protocol: "anyam.promotion/v1", id: typeof payload.promotionId === "string" ? payload.promotionId : "promotion:mcp:1", projectId: String(payload.projectId), targetId: String(payload.targetId), releaseId: String(payload.releaseId), releaseDigest: String(payload.releaseDigest ?? "sha256:mcp-release"), previousReleaseId: null, expectedCurrentReleaseId: payload.expectedCurrentReleaseId ?? null, state: "requested", attempt: 1, kind: "request" },
              target: { protocol: "anyam.target/v1", id: String(payload.targetId), projectId: String(payload.projectId), name: "MCP Target", adapterId: "fixture", state: "configured" },
              release: { protocol: "anyam.release/v1", id: String(payload.releaseId), projectRevisionId: "project-revision:mcp:2", status: "ready" },
            };
          } else return new Response(JSON.stringify({ code: "invalid_request", receipt: "command=unsupported; credentialFree=true" }), { status: 422 });
          const result = { protocol: "anyam.authority-plane/v1", status: "succeeded", version: 1, value, receipt: `authority=coordinator; operation=${String(body.command)}; credentialFree=true; canonicalWrite=false` };
          idempotency.set(key, { fingerprint, result });
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path === "/authority/runs/internal") return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", run: { protocol: "anyam.run/v1", id: String(body.runId), actionId: "action:unit", projectRevisionId: "candidate:mcp:1", projectViewId: "project-view:mcp:1", runnerId: "runner:unassigned", status: "queued" }, receipt: "authority=coordinator; operation=run.inspect; readOnly=true; credentialFree=true; canonicalWrite=false" }), { status: 200, headers: { "content-type": "application/json" } });
        if (path === "/authority/projects/internal") return new Response(JSON.stringify({
          protocol: "anyam.authority-plane/v1",
          status: "ready",
          projects: [
            {
              project: { protocol: "anyam.project/v1", id: "project:alpha", name: "Alpha", referenceType: "git", sourceSpaceIds: ["source:public"] },
              canonicalRevision: { protocol: "anyam.kernel/v1", id: "project-revision:alpha:1", projectId: "project:alpha", sourceSpaceSnapshots: { "source:public": "git:alpha-1" } },
              sourceSpaces: [{ protocol: "anyam.source-space/v1", id: "source:public", name: "public", classification: "public" }],
              counts: { workspaces: 0, changes: 0, revisions: 0, runs: 0, evidence: 0, artifacts: 0, releases: 0, targets: 0, promotions: 0 },
            },
            {
              project: { protocol: "anyam.project/v1", id: "project:video-player", name: "Video Player", referenceType: "git", sourceSpaceIds: ["source:public"] },
              canonicalRevision: { protocol: "anyam.kernel/v1", id: "project-revision:video-player:1", projectId: "project:video-player", sourceSpaceSnapshots: { "source:public": "git:public-1" } },
              sourceSpaces: [{ protocol: "anyam.source-space/v1", id: "source:public", name: "public", classification: "public" }],
              counts: { workspaces: 1, changes: 2, revisions: 3, runs: 4, evidence: 4, artifacts: 1, releases: 1, targets: 1, promotions: 1 },
            },
          ],
          receipt: "authority=coordinator; operation=project.list; projectCount=2; ordering=project-id-code-unit-ascending; readOnly=true; credentialFree=true; canonicalWrite=false",
        }), { status: 200, headers: { "content-type": "application/json" } });
        if (path === "/authority/workspaces/internal") {
          const workspaces = [
            {
              workspace: { protocol: "anyam.workspace/v1", id: "workspace:alpha", projectId: "project:alpha", projectRevisionId: "project-revision:alpha:1", projectViewId: "project-view:alpha:1", state: "active" },
              project: { protocol: "anyam.project/v1", id: "project:alpha", name: "Alpha", referenceType: "git" },
              mountCount: 1,
            },
            {
              workspace: { protocol: "anyam.workspace/v1", id: "workspace:video-player", projectId: "project:video-player", projectRevisionId: "project-revision:video-player:1", projectViewId: "project-view:video-player:1", state: "active", changeId: "change:video-player" },
              project: { protocol: "anyam.project/v1", id: "project:video-player", name: "Video Player", referenceType: "git" },
              mountCount: 1,
            },
          ];
          if (body.workspaceId !== undefined) {
            const found = workspaces.find((entry) => entry.workspace.id === body.workspaceId);
            if (!found) return new Response(JSON.stringify({ code: "not_found", receipt: "workspace=hidden; discoverable=false" }), { status: 404 });
            if (body.projectId !== undefined && found.workspace.projectId !== body.projectId) return new Response(JSON.stringify({ code: "not_found", receipt: "workspace=hidden; discoverable=false" }), { status: 404 });
            return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", ...found, receipt: `authority=coordinator; operation=workspace.inspect; workspace=${found.workspace.id}; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
          }
          const filtered = body.projectId === undefined ? workspaces : workspaces.filter((entry) => entry.workspace.projectId === body.projectId);
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", workspaces: filtered, receipt: `authority=coordinator; operation=workspace.list; workspaceCount=${filtered.length}; ordering=workspace-id-code-unit-ascending; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path === "/authority/changes/internal") {
          const changes = [
            {
              change: { protocol: "anyam.change/v1", id: "change:alpha", projectId: "project:alpha", intentId: "intent:alpha", baseProjectRevisionId: "project-revision:alpha:1", status: "active", latestRevisionId: null },
              project: { protocol: "anyam.project/v1", id: "project:alpha", name: "Alpha", referenceType: "git" },
              revisionCount: 0,
            },
            {
              change: { protocol: "anyam.change/v1", id: "change:video-player", projectId: "project:video-player", intentId: "intent:codec", baseProjectRevisionId: "project-revision:video-player:1", status: "submitted", latestRevisionId: "change-revision:video-player:2", workspaceId: "workspace:video-player" },
              project: { protocol: "anyam.project/v1", id: "project:video-player", name: "Video Player", referenceType: "git" },
              revisionCount: 2,
            },
          ];
          if (body.changeId !== undefined) {
            const found = changes.find((entry) => entry.change.id === body.changeId);
            if (!found) return new Response(JSON.stringify({ code: "not_found", receipt: "change=hidden; discoverable=false" }), { status: 404 });
            const revisions = found.change.id === "change:video-player" ? [
              { protocol: "anyam.change/v1", id: "change-revision:video-player:1", changeId: "change:video-player", projectRevisionId: "candidate:video-player:1", projectViewId: "project-view:video-player:1", sequence: 1, baseProjectRevisionId: "project-revision:video-player:1", workspaceId: "workspace:video-player", declaredEffects: ["source.modify", "api.modify"], kind: "implementation" },
              { protocol: "anyam.change/v1", id: "change-revision:video-player:2", changeId: "change:video-player", projectRevisionId: "candidate:video-player:2", projectViewId: "project-view:video-player:1", sequence: 2, parentRevisionId: "change-revision:video-player:1", baseProjectRevisionId: "project-revision:video-player:1", workspaceId: "workspace:video-player", declaredEffects: ["source.modify"], kind: "rebase" },
            ] : [];
            if (body.projectId !== undefined && found.change.projectId !== body.projectId) return new Response(JSON.stringify({ code: "not_found", receipt: "change=hidden; discoverable=false" }), { status: 404 });
            if (body.workspaceId !== undefined && found.change.workspaceId !== body.workspaceId) return new Response(JSON.stringify({ code: "not_found", receipt: "change=hidden; discoverable=false" }), { status: 404 });
            return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", ...found, revisions, receipt: `authority=coordinator; operation=change.inspect; change=${found.change.id}; revisionCount=${found.revisionCount}; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
          }
          const filtered = changes.filter((entry) => (body.projectId === undefined || entry.change.projectId === body.projectId) && (body.workspaceId === undefined || entry.change.workspaceId === body.workspaceId));
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", changes: filtered, receipt: `authority=coordinator; operation=change.list; changeCount=${filtered.length}; ordering=change-id-code-unit-ascending; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path !== "/authority/project/internal") return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
        if (body.projectId !== "project:video-player") return new Response(JSON.stringify({ code: "not_found", receipt: `project=${String(body.projectId)}; discoverable=false` }), { status: 404 });
        return new Response(JSON.stringify({
          protocol: "anyam.authority-plane/v1",
          status: "ready",
          project: { protocol: "anyam.project/v1", id: "project:video-player", name: "Video Player", referenceType: "git", sourceSpaceIds: ["source:public"] },
          canonicalRevision: { protocol: "anyam.kernel/v1", id: "project-revision:video-player:1", projectId: "project:video-player", sourceSpaceSnapshots: { "source:public": "git:public-1" } },
          sourceSpaces: [{ protocol: "anyam.source-space/v1", id: "source:public", name: "public", classification: "public" }],
          counts: { workspaces: 1, changes: 2, revisions: 3, runs: 4, evidence: 4, artifacts: 1, releases: 1, targets: 1, promotions: 1 },
          receipt: "authority=coordinator; operation=project.inspect; project=project:video-player; readOnly=true; credentialFree=true; canonicalWrite=false",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  };
  return {
    env: {
      ANYAM_INSTALLATION_ID: "mcp-test",
      REALM_COORDINATOR: namespace,
    },
    calls,
  };
}

const props: AnyamRealmMcpProps = {
  scopes: ["project.read", "workspace.inspect", "change.inspect"],
  kernelSessionId: "kernel-session:owner",
};

async function body(response: Response): Promise<JsonRpcBody> {
  return await response.json() as JsonRpcBody;
}

function post(value: unknown): Request {
  return new Request("https://realm.example/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}

test("remote MCP exposes an authenticated read-only project tool through the coordinator", async () => {
  const fixture = env();
  const initialized = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), fixture.env, props);
  assert.equal(initialized.status, 200);
  assert.equal(((await body(initialized)).result as Record<string, unknown>).protocolVersion, "2025-06-18");

  const listed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }), fixture.env, props);
  const listedBody = await body(listed);
  const tools = (listedBody.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((tool) => tool.name), ["project.list", "project.inspect", "workspace.list", "workspace.inspect", "change.list", "change.inspect"]);

  const discovered = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "project.list", arguments: {} } }), fixture.env, props);
  const discoveredBody = await body(discovered);
  const discoveredResult = discoveredBody.result as Record<string, unknown>;
  const discoveredContent = discoveredResult.structuredContent as Record<string, unknown>;
  assert.equal(discoveredResult.isError, false);
  assert.deepEqual((discoveredContent.projects as Array<Record<string, unknown>>).map((entry) => (entry.project as Record<string, unknown>).id), ["project:alpha", "project:video-player"]);
  assert.match(String(discoveredContent.receipt), /projectCount=2/);
  assert.equal(JSON.stringify(discoveredBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(discoveredBody).includes("credential:"), false);
  assert.equal(fixture.calls[0]?.path, "/authority/projects/internal");
  assert.equal(fixture.calls[0]?.body.sessionId, "kernel-session:owner");

  const workspaces = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "workspaces", method: "tools/call", params: { name: "workspace.list", arguments: { projectId: "project:video-player" } } }), fixture.env, props);
  const workspacesBody = await body(workspaces);
  const workspacesResult = workspacesBody.result as Record<string, unknown>;
  const workspaceContent = workspacesResult.structuredContent as Record<string, unknown>;
  assert.equal(workspacesResult.isError, false);
  assert.deepEqual((workspaceContent.workspaces as Array<Record<string, unknown>>).map((entry) => (entry.workspace as Record<string, unknown>).id), ["workspace:video-player"]);
  assert.match(String(workspaceContent.receipt), /workspaceCount=1/);
  assert.equal(JSON.stringify(workspacesBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(workspacesBody).includes("credential:"), false);
  assert.equal(JSON.stringify(workspacesBody).includes("sourceSpace"), false);
  assert.equal(fixture.calls[1]?.path, "/authority/workspaces/internal");
  assert.deepEqual(fixture.calls[1]?.body, { sessionId: "kernel-session:owner", projectId: "project:video-player" });

  const changes = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "changes", method: "tools/call", params: { name: "change.list", arguments: { projectId: "project:video-player", workspaceId: "workspace:video-player" } } }), fixture.env, props);
  const changesBody = await body(changes);
  const changesResult = changesBody.result as Record<string, unknown>;
  const changesContent = changesResult.structuredContent as Record<string, unknown>;
  assert.equal(changesResult.isError, false);
  assert.deepEqual((changesContent.changes as Array<Record<string, unknown>>).map((entry) => (entry.change as Record<string, unknown>).id), ["change:video-player"]);
  assert.match(String(changesContent.receipt), /changeCount=1/);
  assert.equal(JSON.stringify(changesBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(changesBody).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(changesBody).includes("credential:"), false);
  assert.equal(fixture.calls[2]?.path, "/authority/changes/internal");
  assert.deepEqual(fixture.calls[2]?.body, { sessionId: "kernel-session:owner", projectId: "project:video-player", workspaceId: "workspace:video-player" });

  const inspected = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "project.inspect", arguments: { projectId: "project:video-player" } } }), fixture.env, props);
  const inspectedBody = await body(inspected);
  const result = inspectedBody.result as Record<string, unknown>;
  assert.equal(result.isError, false);
  assert.equal((result.structuredContent as Record<string, unknown>).project && ((result.structuredContent as Record<string, unknown>).project as Record<string, unknown>).id, "project:video-player");
  assert.match(String((result.structuredContent as Record<string, unknown>).receipt), /read-only/);
  assert.equal(JSON.stringify(inspectedBody).includes("kernel-session"), false);
  assert.equal(fixture.calls[3]?.path, "/authority/project/internal");
  assert.equal(fixture.calls[3]?.body.sessionId, "kernel-session:owner");

  const workspace = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "workspace.inspect", arguments: { workspaceId: "workspace:video-player" } } }), fixture.env, props);
  const workspaceBody = await body(workspace);
  const workspaceResult = workspaceBody.result as Record<string, unknown>;
  assert.equal(workspaceResult.isError, false);
  assert.equal(((workspaceResult.structuredContent as Record<string, unknown>).workspace as Record<string, unknown>).id, "workspace:video-player");
  assert.equal(((workspaceResult.structuredContent as Record<string, unknown>).workspace as Record<string, unknown>).mounts, undefined);
  assert.equal(JSON.stringify(workspaceBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(workspaceBody).includes("credential:"), false);
  assert.equal(fixture.calls[4]?.path, "/authority/workspaces/internal");
  assert.deepEqual(fixture.calls[4]?.body, { sessionId: "kernel-session:owner", workspaceId: "workspace:video-player" });

  const change = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "change.inspect", arguments: { changeId: "change:video-player" } } }), fixture.env, props);
  const changeBody = await body(change);
  const changeResult = changeBody.result as Record<string, unknown>;
  const changeContent = changeResult.structuredContent as Record<string, unknown>;
  assert.equal(changeResult.isError, false);
  assert.equal((changeContent.change as Record<string, unknown>).id, "change:video-player");
  assert.deepEqual((changeContent.revisions as Array<Record<string, unknown>>).map((revision) => revision.sequence), [1, 2]);
  assert.equal(JSON.stringify(changeBody).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(changeBody).includes("\"author\":"), false);
  assert.equal(JSON.stringify(changeBody).includes("credential:"), false);
  assert.equal(fixture.calls[5]?.path, "/authority/changes/internal");
  assert.deepEqual(fixture.calls[5]?.body, { sessionId: "kernel-session:owner", changeId: "change:video-player" });
});

test("remote MCP exposes the complete Intent lifecycle with the intent.write capability", async () => {
  const fixture = env();
  const props: AnyamRealmMcpProps = {
    scopes: ["intent.inspect", "intent.write"],
    realmId: "realm:mcp-test",
    kernelSessionId: "kernel-session:agent",
    agentId: "agent:mcp",
    taskId: "task:mcp-intent",
    capabilityGrantId: "grant:mcp-intent",
    resource: { realmId: "realm:mcp-test", projectId: "project:mcp" },
    sourceSpaceIds: ["source:mcp-public"],
  };
  const listed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), fixture.env, props);
  const tools = ((await body(listed)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((tool) => tool.name), ["intent.list", "intent.inspect", "intent.create", "intent.assign", "intent.comment", "intent.close", "intent.reopen"]);

  const create = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "intent.create", arguments: { idempotencyKey: "mcp-intent-create", projectId: "project:mcp", intentId: "intent:mcp-lifecycle", title: "MCP Intent", description: "Exercise every transition.", disclosure: "project", labels: ["qualification"] } } }), fixture.env, props);
  const createResult = (await body(create)).result as Record<string, unknown>;
  assert.equal(createResult.isError, false);
  assert.equal(((createResult.structuredContent as Record<string, unknown>).value as Record<string, unknown>).intent && (((createResult.structuredContent as Record<string, unknown>).value as Record<string, unknown>).intent as Record<string, unknown>).id, "intent:mcp-lifecycle");
  const createCall = fixture.calls.at(-1)!;
  assert.equal(createCall.path, "/authority/mcp-command/internal");
  assert.equal(createCall.body.capability, "intent.write");

  const assigned = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "intent.assign", arguments: { idempotencyKey: "mcp-intent-assign", intentId: "intent:mcp-lifecycle", assigneePrincipalIds: ["principal:reviewer"] } } }), fixture.env, props);
  const assignedBody = await body(assigned);
  assert.equal((assignedBody.result as Record<string, unknown>).isError, false);
  const commented = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "intent.comment", arguments: { idempotencyKey: "mcp-intent-comment", intentId: "intent:mcp-lifecycle", body: "Review this Intent." } } }), fixture.env, props);
  const commentContent = ((await body(commented)).result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  assert.equal((commentContent.value as Record<string, unknown>).comment && ((commentContent.value as Record<string, unknown>).comment as Record<string, unknown>).body, "Review this Intent.");
  const closed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "intent.close", arguments: { idempotencyKey: "mcp-intent-close", intentId: "intent:mcp-lifecycle" } } }), fixture.env, props);
  const closedContent = ((await body(closed)).result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  assert.equal(((closedContent.value as Record<string, unknown>).intent as Record<string, unknown>).status, "closed");
  const reopened = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "intent.reopen", arguments: { idempotencyKey: "mcp-intent-reopen", intentId: "intent:mcp-lifecycle" } } }), fixture.env, props);
  const reopenedContent = ((await body(reopened)).result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  assert.equal(((reopenedContent.value as Record<string, unknown>).intent as Record<string, unknown>).status, "open");

  const inspected = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "intent.inspect", arguments: { intentId: "intent:mcp-lifecycle" } } }), fixture.env, props);
  const inspectedContent = ((await body(inspected)).result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  assert.equal(((inspectedContent.intent as Record<string, unknown>).id), "intent:mcp-lifecycle");
  assert.equal((inspectedContent.comments as Array<Record<string, unknown>>).length, 1);
  const all = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "intent.list", arguments: { projectId: "project:mcp" } } }), fixture.env, props);
  const allContent = ((await body(all)).result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  assert.deepEqual((allContent.intents as Array<Record<string, unknown>>).map((entry) => (entry.intent as Record<string, unknown>).id), ["intent:mcp-lifecycle"]);
});

test("remote MCP exposes scope-filtered typed bootstrap mutations with idempotency and safe projections", async () => {
  const fixture = env();
  const writeProps: AnyamRealmMcpProps = { scopes: ["project.write", "workspace.write", "change.write"], realmId: "realm:mcp-test", kernelSessionId: "kernel-session:agent", agentId: "agent:mcp", taskId: "task:mcp", capabilityGrantId: "grant:mcp", resource: { realmId: "realm:mcp-test", projectId: "project:mcp" }, sourceSpaceIds: ["source:mcp-public"] };
  const ownerWriteProps: AnyamRealmMcpProps = { scopes: ["project.write"], realmId: "realm:mcp-test", kernelSessionId: "kernel-session:owner" };
  const listed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), fixture.env, writeProps);
  const listedTools = ((await body(listed)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(listedTools.map((tool) => tool.name), ["workspace.create", "change.create", "change.publish_revision"]);
  const agentDeliveryListed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 1.1, method: "tools/list" }), fixture.env, { ...writeProps, scopes: ["project.read", "landing.request"], anyamGrantId: "grant:mcp:delivery", mcpResource: "https://realm.example/mcp/projects/project:mcp?sourceSpaceId=source:mcp-public" });
  const agentDeliveryTools = ((await body(agentDeliveryListed)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.equal(agentDeliveryTools.some((tool) => tool.name === "landing.apply"), false);

  const projectArguments = { idempotencyKey: "mcp-project-1", projectId: "project:mcp", name: "MCP Project", referenceType: "git", sourceSpaces: [{ id: "source:mcp-public", name: "public", classification: "public", snapshotId: "git:mcp-base" }] };
  const createdProject = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "project.create", arguments: projectArguments } }), fixture.env, ownerWriteProps);
  const projectBody = await body(createdProject);
  const projectResult = projectBody.result as Record<string, unknown>;
  const projectContent = projectResult.structuredContent as Record<string, unknown>;
  assert.equal(projectResult.isError, false);
  assert.equal(projectContent.protocol, "anyam.remote-mcp/v1");
  assert.equal(projectContent.canonicalWrite, "initialization-only");
  assert.equal(((projectContent.project as Record<string, unknown>).id), "project:mcp");
  assert.equal(JSON.stringify(projectBody).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(projectBody).includes("git:mcp-base"), false);
  assert.equal(JSON.stringify(projectBody).includes("coordinatorReceipt"), false);
  assert.equal(JSON.stringify(projectBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(projectBody).includes("credential:"), false);
  assert.equal(fixture.calls.at(-1)?.path, "/authority/command/internal");
  assert.equal(fixture.calls.at(-1)?.body.protocol, "anyam.authority-command/v1");
  assert.equal(fixture.calls.at(-1)?.body.command, "project.create");
  assert.equal((fixture.calls.at(-1)?.body.payload as Record<string, unknown>).name, "MCP Project");
  assert.equal((fixture.calls.at(-1)?.body as Record<string, unknown>).command && JSON.stringify(fixture.calls.at(-1)?.body).includes("mcp-project-1"), true);

  const replay = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "project.create", arguments: projectArguments } }), fixture.env, ownerWriteProps);
  const replayBody = await body(replay);
  assert.equal((replayBody.result as Record<string, unknown>).isError, false);
  assert.deepEqual((replayBody.result as Record<string, unknown>).structuredContent, projectContent);

  const conflict = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "project.create", arguments: { ...projectArguments, name: "Different" } } }), fixture.env, ownerWriteProps);
  const conflictError = (await body(conflict)).error as Record<string, unknown>;
  assert.equal(conflictError.code, -32009);
  assert.equal((conflictError.data as Record<string, unknown>).code, "mcp.bootstrap_conflict");
  assert.equal(JSON.stringify(conflictError).includes("Different"), false);

  const createdWorkspace = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "workspace.create", arguments: { idempotencyKey: "mcp-workspace-1", projectId: "project:mcp", projectRevisionId: "project-revision:mcp:1", sourceSpaceIds: ["source:mcp-public"], mounts: ["private-codec"] } } }), fixture.env, writeProps);
  const workspaceBody = await body(createdWorkspace);
  const workspaceContent = (workspaceBody.result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  assert.equal((workspaceBody.result as Record<string, unknown>).isError, false);
  assert.equal((workspaceContent.workspace as Record<string, unknown>).id, "workspace:mcp");
  assert.equal((workspaceContent.workspace as Record<string, unknown>).mounts, undefined);
  assert.equal((workspaceContent.view as Record<string, unknown>).mounts, undefined);
  assert.equal(JSON.stringify(workspaceBody).includes("private-codec"), false);

  const createdChange = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "change.create", arguments: { idempotencyKey: "mcp-change-1", projectId: "project:mcp", intentId: "intent:mcp", baseProjectRevisionId: "project-revision:mcp:1", workspaceId: "workspace:mcp" } } }), fixture.env, writeProps);
  const changeBody = await body(createdChange);
  const changeContent = (changeBody.result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  assert.equal((changeBody.result as Record<string, unknown>).isError, false);
  assert.equal((changeContent.change as Record<string, unknown>).id, "change:mcp");
  assert.equal((changeContent.change as Record<string, unknown>).author, undefined);
  assert.equal(JSON.stringify(changeBody).includes("owner:private"), false);

  const revisionArguments = { idempotencyKey: "mcp-revision-1", projectId: "project:mcp", changeId: "change:mcp", workspaceId: "workspace:mcp", projectViewId: "project-view:mcp:1", projectRevisionId: "candidate:mcp:1", sourceSpaceSnapshots: { "source:mcp-public": "git:mcp-candidate" }, declaredEffects: ["source.modify"], kind: "implementation" };
  const published = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.1, method: "tools/call", params: { name: "change.publish_revision", arguments: revisionArguments } }), fixture.env, writeProps);
  const publishedBody = await body(published);
  const publishedResult = publishedBody.result as Record<string, unknown>;
  const publishedContent = publishedResult.structuredContent as Record<string, unknown>;
  assert.equal(publishedResult.isError, false);
  assert.equal(publishedContent.protocol, "anyam.remote-mcp/v1");
  assert.equal(publishedContent.canonicalWrite, false);
  assert.equal(((publishedContent.revision as Record<string, unknown>).id), "change-revision:mcp:1");
  assert.equal(((publishedContent.change as Record<string, unknown>).status), "submitted");
  assert.equal(JSON.stringify(publishedBody).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(publishedBody).includes("git:mcp-candidate"), false);
  assert.equal(JSON.stringify(publishedBody).includes("owner:private"), false);
  assert.equal(fixture.calls.at(-1)?.body.command, "revision.publish");

  const publishedReplay = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.2, method: "tools/call", params: { name: "change.publish_revision", arguments: revisionArguments } }), fixture.env, writeProps);
  assert.deepEqual(((await body(publishedReplay)).result as Record<string, unknown>).structuredContent, publishedContent);
  const publishedConflict = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.3, method: "tools/call", params: { name: "change.publish_revision", arguments: { ...revisionArguments, projectRevisionId: "candidate:other" } } }), fixture.env, writeProps);
  assert.equal((((await body(publishedConflict)).error as Record<string, unknown>).code), -32009);

  const revisionReadOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.4, method: "tools/list" }), fixture.env, props);
  assert.equal((((await body(revisionReadOnly)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>).some((tool) => tool.name === "change.publish_revision"), false);
  const revisionScopeDenied = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.45, method: "tools/call", params: { name: "change.publish_revision", arguments: revisionArguments } }), fixture.env, props);
  assert.equal((((await body(revisionScopeDenied)).error as Record<string, unknown>).code), -32001);
  const revisionHidden = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.46, method: "tools/call", params: { name: "change.publish_revision", arguments: { ...revisionArguments, idempotencyKey: "mcp-revision-hidden", projectId: "project:missing" } } }), fixture.env, writeProps);
  const revisionHiddenError = (await body(revisionHidden)).error as Record<string, unknown>;
  assert.equal(revisionHiddenError.code, -32004);
  assert.equal(JSON.stringify(revisionHiddenError).includes("project:missing"), false);
  const beforeRevisionInvalid = fixture.calls.length;
  const revisionInvalid = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.5, method: "tools/call", params: { name: "change.publish_revision", arguments: { ...revisionArguments, unsupported: true } } }), fixture.env, writeProps);
  assert.equal((((await body(revisionInvalid)).error as Record<string, unknown>).code), -32602);
  assert.equal(fixture.calls.length, beforeRevisionInvalid);

  const beforeInvalid = fixture.calls.length;
  const malformed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "project.create", arguments: { ...projectArguments, command: "raw" } } }), fixture.env, writeProps);
  const malformedError = (await body(malformed)).error as Record<string, unknown>;
  assert.equal(malformedError.code, -32601);
  assert.equal(fixture.calls.length, beforeInvalid);

  const missingKey = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "change.create", arguments: { projectId: "project:mcp", intentId: "intent:mcp" } } }), fixture.env, writeProps);
  assert.equal(((await body(missingKey)).error as Record<string, unknown>).code, -32602);
  assert.equal(fixture.calls.length, beforeInvalid);

  const hidden = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "workspace.create", arguments: { idempotencyKey: "mcp-hidden", projectId: "project:missing", projectRevisionId: "project-revision:hidden", sourceSpaceIds: ["source:hidden"] } } }), fixture.env, writeProps);
  const hiddenError = (await body(hidden)).error as Record<string, unknown>;
  assert.equal(hiddenError.code, -32004);
  assert.equal(JSON.stringify(hiddenError).includes("project:missing"), false);

  const readOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 10, method: "tools/list" }), fixture.env, props);
  const readOnlyTools = ((await body(readOnly)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(readOnlyTools.map((tool) => tool.name), ["project.list", "project.inspect", "workspace.list", "workspace.inspect", "change.list", "change.inspect"]);
  const projectWriteOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 11, method: "tools/list" }), fixture.env, { ...writeProps, scopes: ["project.write"] });
  const projectWriteOnlyBody = await body(projectWriteOnly);
  assert.equal((projectWriteOnlyBody.error as Record<string, unknown>).code, -32001);
  assert.match(String(((projectWriteOnlyBody.error as Record<string, unknown>).data as Record<string, unknown>).receipt), /delegatedAgent=true/);
  const changeWriteOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 12, method: "tools/list" }), fixture.env, { ...writeProps, scopes: ["change.write"] });
  assert.deepEqual((((await body(changeWriteOnly)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>).map((tool) => tool.name), ["change.create", "change.publish_revision"]);
});

test("remote MCP exposes authenticated typed delivery mutations with grant-bound safe projections", async () => {
  const fixture = env();
  const deliveryProps: AnyamRealmMcpProps = {
    scopes: ["landing.request", "release.create", "target.configure", "promotion.request"],
    realmId: "realm:mcp-test",
    kernelSessionId: "kernel-session:owner",
    resource: { realmId: "realm:mcp-test", projectId: "project:mcp" },
    sourceSpaceIds: ["source:public"],
    anyamGrantId: "grant:mcp:delivery",
    mcpResource: "https://realm.example/mcp/projects/project:mcp?sourceSpaceId=source:public",
  };
  const listed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), fixture.env, deliveryProps);
  const tools = ((await body(listed)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((tool) => tool.name), ["landing.apply", "release.create", "target.configure", "promotion.request"]);

  const cases = [
    {
      name: "landing.apply",
      args: { idempotencyKey: "mcp-landing-1", projectId: "project:mcp", changeId: "change:mcp", changeRevisionId: "change-revision:mcp:1", expectedCanonicalProjectRevisionId: "project-revision:mcp:1", projectRevisionId: "project-revision:mcp:2" },
      resource: "landing",
    },
    {
      name: "release.create",
      args: { idempotencyKey: "mcp-release-1", projectId: "project:mcp", releaseId: "release:mcp:1", projectRevisionId: "project-revision:mcp:2", artifactIds: ["artifact:mcp:1"], evidenceIds: ["evidence:mcp:1"], policyVersion: "policy:mcp" },
      resource: "release",
    },
    {
      name: "target.configure",
      args: { idempotencyKey: "mcp-target-1", projectId: "project:mcp", targetId: "target:mcp:1", name: "MCP Target", adapterId: "fixture", acceptedArtifactTypes: ["cli.archive"] },
      resource: "target",
    },
    {
      name: "promotion.request",
      args: { idempotencyKey: "mcp-promotion-1", projectId: "project:mcp", promotionId: "promotion:mcp:1", releaseId: "release:mcp:1", targetId: "target:mcp:1", releaseDigest: "sha256:mcp-release" },
      resource: "promotion",
    },
  ] as const;

  for (const [index, entry] of cases.entries()) {
    const response = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name: entry.name, arguments: entry.args } }), fixture.env, deliveryProps);
    const result = (await body(response)).result as Record<string, unknown>;
    const content = result.structuredContent as Record<string, unknown>;
    assert.equal(result.isError, false);
    assert.equal(content.protocol, "anyam.remote-mcp/v1");
    assert.equal(content.canonicalWrite, false);
    assert.equal(content.credentialFree, true);
    assert.ok(content[entry.resource]);
    assert.match(String(content.receipt), /typedSurface=mcp/);
    assert.match(String(content.receipt), /grant=validated/);
    assert.match(String(content.receipt), /providerExecution=not-performed/);
    assert.equal(fixture.calls.at(-1)?.path, "/authority/command/internal");
    assert.equal(fixture.calls.at(-1)?.body.sessionId, "kernel-session:owner");
    assert.equal(JSON.stringify(result).includes("grant:mcp:delivery"), false);
    assert.equal(JSON.stringify(result).includes("kernel-session"), false);
    assert.equal(fixture.calls.at(-1)?.body.command, entry.name);

    const replay = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: index + 10, method: "tools/call", params: { name: entry.name, arguments: entry.args } }), fixture.env, deliveryProps);
    assert.deepEqual(((await body(replay)).result as Record<string, unknown>).structuredContent, content);
  }

  const conflict = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "release.create", arguments: { ...cases[1].args, policyVersion: "policy:other" } } }), fixture.env, deliveryProps);
  const conflictError = (await body(conflict)).error as Record<string, unknown>;
  assert.equal(conflictError.code, -32009);
  assert.equal((conflictError.data as Record<string, unknown>).code, "mcp.release_create_conflict");
  assert.equal(JSON.stringify(conflictError).includes("policy:other"), false);

  const hidden = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "target.configure", arguments: { ...cases[2].args, idempotencyKey: "mcp-target-hidden", projectId: "project:missing" } } }), fixture.env, deliveryProps);
  const hiddenError = (await body(hidden)).error as Record<string, unknown>;
  assert.equal(hiddenError.code, -32004);
  assert.equal(JSON.stringify(hiddenError).includes("project:missing"), false);

  const malformedBefore = fixture.calls.length;
  const malformed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "landing.apply", arguments: { ...cases[0].args, unsupported: true } } }), fixture.env, deliveryProps);
  assert.equal((((await body(malformed)).error as Record<string, unknown>).code), -32602);
  assert.equal(fixture.calls.length, malformedBefore);

  const missingGrant = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "landing.apply", arguments: cases[0].args } }), fixture.env, { scopes: deliveryProps.scopes, kernelSessionId: "kernel-session:owner" });
  const missingGrantError = (await body(missingGrant)).error as Record<string, unknown>;
  assert.equal(missingGrantError.code, -32001);
  assert.match(String((missingGrantError.data as Record<string, unknown>).receipt), /grant=missing/);

  for (const [id, receipt] of [["grant:mcp:revoked", /taskGrant=not-live/], ["grant:mcp:expired", /taskGrant=not-live/], ["grant:mcp:stale-epoch", /taskGrant=not-live/], ["grant:mcp:denied", /taskGrant=not-live/]] as const) {
    const blocked = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: `blocked-${id}`, method: "tools/call", params: { name: "landing.apply", arguments: { ...cases[0].args, idempotencyKey: `mcp-${id}` } } }), fixture.env, { ...deliveryProps, anyamGrantId: id });
    const blockedBody = await body(blocked);
    assert.equal((blockedBody.error as Record<string, unknown>).code, -32001);
    assert.match(String(((blockedBody.error as Record<string, unknown>).data as Record<string, unknown>).receipt), receipt);
    assert.equal(fixture.calls.at(-1)?.path, "/identity/oauth-grant/validate-delivery");
  }
  const crossProject = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 29, method: "tools/call", params: { name: "landing.apply", arguments: { ...cases[0].args, idempotencyKey: "mcp-cross-project", projectId: "project:cross" } } }), fixture.env, deliveryProps);
  assert.equal(((await body(crossProject)).error as Record<string, unknown>).code, -32004);

  const noScope = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 24, method: "tools/list" }), fixture.env, { ...deliveryProps, scopes: ["project.read"] });
  assert.deepEqual((((await body(noScope)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>).map((tool) => tool.name), ["project.list", "project.inspect"]);
});

test("remote MCP exposes Runner request/inspect and rejects caller-authoritative completion mutations", async () => {
  const fixture = env();
  const runProps: AnyamRealmMcpProps = { scopes: ["run.invoke"], realmId: "realm:mcp-test", kernelSessionId: "kernel-session:agent", agentId: "agent:mcp", taskId: "task:mcp", capabilityGrantId: "grant:mcp", resource: { realmId: "realm:mcp-test", projectId: "project:mcp", workspaceId: "workspace:mcp", changeId: "change:mcp" }, sourceSpaceIds: ["source:mcp-public"] };
  const listed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), fixture.env, runProps);
  const tools = ((await body(listed)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((tool) => tool.name), ["run.request", "run.inspect"]);
  const runArguments = { idempotencyKey: "mcp-run-request-1", projectId: "project:mcp", runId: "run:mcp:1", actionId: "action:unit", actionContractDigest: "sha256:action", verifierId: "verifier:unit", verifierContractDigest: "sha256:verifier", projectRevisionId: "candidate:mcp:1", projectViewId: "project-view:mcp:1", changeRevisionId: "change-revision:mcp:1", workspaceId: "workspace:mcp", inputDigests: ["sha256:input"], outputDigests: ["dist/cli.archive=sha256:output"], policyVersion: "policy:mcp", authorizationEpoch: "1", capabilityGrantId: "grant:mcp" };
  const requested = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run.request", arguments: runArguments } }), fixture.env, runProps);
  const requestedBody = await body(requested);
  const requestedContent = ((requestedBody.result as Record<string, unknown>).structuredContent) as Record<string, unknown>;
  assert.equal(((requestedContent.run as Record<string, unknown>).status), "queued");
  assert.equal(((requestedContent.run as Record<string, unknown>).runnerId), "runner:unassigned");
  assert.equal(fixture.calls.at(-1)?.path, "/authority/mcp-command/internal");
  assert.equal(fixture.calls.at(-1)?.body.taskId, "task:mcp");
  assert.equal(fixture.calls.at(-1)?.body.capabilityGrantId, "grant:mcp");
  const inspected = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run.inspect", arguments: { runId: "run:mcp:1" } } }), fixture.env, runProps);
  assert.equal(((await body(inspected)).result as Record<string, unknown>).isError, false);
  assert.equal(fixture.calls.at(-1)?.path, "/authority/runs/internal");
  for (const [id, name] of [[4, "run.record"], [5, "evidence.record"], [6, "artifact.record"]] as const) {
    const before = fixture.calls.length;
    const rejected = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: runArguments } }), fixture.env, runProps);
    const error = (await body(rejected)).error as Record<string, unknown>;
    assert.equal(error.code, -32601);
    assert.equal((error.data as Record<string, unknown>).code, "mcp.runner_completion_only");
    assert.equal(fixture.calls.length, before);
  }
});

test("remote MCP fails closed for malformed requests, unknown methods, mutations, and undiscoverable projects", async () => {
  const fixture = env();
  const malformed = await handleAnyamRealmMcpRequest(new Request("https://realm.example/mcp", { method: "POST", body: "{" }), fixture.env, props);
  const malformedBody = await body(malformed);
  assert.equal((malformedBody.error as Record<string, unknown>).code, -32700);

  const unknown = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "unknown", method: "secrets.read" }), fixture.env, props);
  assert.equal(((await body(unknown)).error as Record<string, unknown>).code, -32601);

  const mutation = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "mutate", method: "tools/call", params: { name: "landing.apply", arguments: {} } }), fixture.env, props);
  const mutationError = (await body(mutation)).error as Record<string, unknown>;
  assert.equal(mutationError.code, -32001);
  assert.match(String(mutationError.data && (mutationError.data as Record<string, unknown>).receipt), /scope=missing/);

  const hidden = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "hidden", method: "tools/call", params: { name: "project.inspect", arguments: { projectId: "project:private" } } }), fixture.env, props);
  const hiddenError = (await body(hidden)).error as Record<string, unknown>;
  assert.equal(hiddenError.code, -32004);
  assert.match(JSON.stringify(hiddenError), /not available/);
  assert.equal(JSON.stringify(hiddenError).includes("project:private"), false);

  const hiddenWorkspace = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "hidden-workspace", method: "tools/call", params: { name: "workspace.inspect", arguments: { workspaceId: "workspace:private" } } }), fixture.env, props);
  const hiddenWorkspaceError = (await body(hiddenWorkspace)).error as Record<string, unknown>;
  assert.equal(hiddenWorkspaceError.code, -32004);
  assert.equal(JSON.stringify(hiddenWorkspaceError).includes("workspace:private"), false);

  const malformedWorkspace = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "malformed-workspace", method: "tools/call", params: { name: "workspace.inspect", arguments: {} } }), fixture.env, props);
  assert.equal(((await body(malformedWorkspace)).error as Record<string, unknown>).code, -32602);

  const hiddenChange = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "hidden-change", method: "tools/call", params: { name: "change.inspect", arguments: { changeId: "change:private" } } }), fixture.env, props);
  const hiddenChangeError = (await body(hiddenChange)).error as Record<string, unknown>;
  assert.equal(hiddenChangeError.code, -32004);
  assert.equal(JSON.stringify(hiddenChangeError).includes("change:private"), false);

  const malformedChange = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "malformed-change", method: "tools/call", params: { name: "change.inspect", arguments: {} } }), fixture.env, props);
  assert.equal(((await body(malformedChange)).error as Record<string, unknown>).code, -32602);

  const noScope = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "scope", method: "tools/list" }), fixture.env, { ...props, scopes: ["source.read"] });
  assert.equal(((await body(noScope)).error as Record<string, unknown>).code, -32001);

  const workspaceOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "workspace-scope", method: "tools/list" }), fixture.env, { ...props, scopes: ["workspace.inspect"] });
  const workspaceOnlyTools = ((await body(workspaceOnly)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(workspaceOnlyTools.map((tool) => tool.name), ["workspace.list", "workspace.inspect"]);
  const deniedProject = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "denied-project", method: "tools/call", params: { name: "project.list", arguments: {} } }), fixture.env, { ...props, scopes: ["workspace.inspect"] });
  assert.equal(((await body(deniedProject)).error as Record<string, unknown>).code, -32001);

  const changeOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "change-scope", method: "tools/list" }), fixture.env, { ...props, scopes: ["change.inspect"] });
  const changeOnlyTools = ((await body(changeOnly)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(changeOnlyTools.map((tool) => tool.name), ["change.list", "change.inspect"]);
  const deniedWorkspace = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "denied-workspace", method: "tools/call", params: { name: "workspace.list", arguments: {} } }), fixture.env, { ...props, scopes: ["change.inspect"] });
  assert.equal(((await body(deniedWorkspace)).error as Record<string, unknown>).code, -32001);
});

test("remote MCP requires POST and treats initialized notification as a no-content acknowledgement", async () => {
  const fixture = env();
  const get = await handleAnyamRealmMcpRequest(new Request("https://realm.example/mcp"), fixture.env, props);
  assert.equal(get.status, 405);
  const notification = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", method: "notifications/initialized" }), fixture.env, props);
  assert.equal(notification.status, 202);
});
