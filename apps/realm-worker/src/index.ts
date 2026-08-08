/// <reference types="@cloudflare/workers-types" />

import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";

import { handleCustomerRealmRequest } from "../../../src/cloudflare/realm-worker.ts";
import { CREDENTIAL_AUDIENCES, RealmIdentityError, RealmIdentityPolicy, type CredentialClass, type RealmRecoverySnapshot } from "../../../src/identity/realm.ts";
import { createAnyamRealmOAuthProvider, type AnyamRealmOAuthEnv } from "./oauth-provider.ts";
import { handleAnyamRealmOwnerRequest } from "./passkey-owner.ts";

export type Env = AnyamRealmOAuthEnv;

const REALM_IDENTITY_SNAPSHOT_KEY = "anyam/realm-identity/snapshot/v1";
const REALM_COORDINATOR_PROTOCOL = "anyam.realm-coordinator/v1" as const;
const REALM_QUALIFICATION_PROJECT_ID = "project:realm-qualification";
const REALM_QUALIFICATION_SOURCE_SPACE_ID = "source:realm-qualification";
const REALM_QUALIFICATION_WORKSPACE_ID = "workspace:realm-qualification";
const REALM_QUALIFICATION_CHANGE_ID = "change:realm-qualification";
const REALM_QUALIFICATION_AGENT_ID = "agent:realm-qualification";
const REALM_QUALIFICATION_AGENT_CLIENT_ID = "client:agent:realm-qualification";
const REALM_QUALIFICATION_CREDENTIAL_CLASSES: readonly CredentialClass[] = ["git", "mcp"];
const REALM_QUALIFICATION_ACTIONS = ["source.read", "workspace.write", "change.publish_revision", "run.invoke", "agent.delegate"] as const;

type CoordinatorRequestBody = Record<string, unknown>;

function coordinatorJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function coordinatorBody(request: Request): Promise<CoordinatorRequestBody> {
  const value: unknown = await request.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be a JSON object");
  return value as CoordinatorRequestBody;
}

function coordinatorString(body: CoordinatorRequestBody, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} is required`);
  return value.trim();
}

function coordinatorOptionalString(body: CoordinatorRequestBody, key: string, fallback: string): string {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function identitySummary(identity: RealmIdentityPolicy): Record<string, unknown> {
  const snapshot = identity.getRecoverySnapshot();
  const ownerRelationships = Object.values(snapshot.relationships).filter((relationship) => relationship.role === "owner" && relationship.status === "active");
  return {
    realmId: snapshot.realm.id,
    policyVersion: snapshot.realm.policyVersion,
    authorizationEpoch: snapshot.realm.authorizationEpoch,
    principalCount: Object.keys(snapshot.principals).length,
    passkeyCount: Object.keys(snapshot.passkeys).length,
    activeOwnerCount: ownerRelationships.length,
    activeSessionCount: Object.values(snapshot.sessions).filter((session) => session.status === "active").length,
    activeGrantCount: Object.values(snapshot.grants).filter((grant) => grant.status === "active").length,
    credentialFree: snapshot.credentialFree,
  };
}

function coordinatorError(error: unknown): Response {
  if (error instanceof RealmIdentityError) {
    const status = error.code.endsWith(".exists") ? 409 : error.code.includes("not_found") ? 404 : 422;
    return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, code: error.code, recoveryAction: error.recoveryAction, receipt: error.receipt ?? "realm-identity=operation-failed" }, status);
  }
  const message = error instanceof Error ? error.message : "realm coordinator operation failed";
  return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, code: "realm.coordinator.invalid_request", recoveryAction: "inspect the coordinator input and retry; no partial identity transition was accepted", receipt: `coordinator=exception; message=${message}` }, 422);
}

/**
 * The coordinator is exported so Wrangler can provision the SQLite-backed
 * Durable Object namespace. Its routes are intentionally narrow: they only
 * hydrate and transition Realm identity state required by the owner adapter.
 * Project, Git, Landing, and Promotion authority remain separate boundaries.
 */
export class AnyamRealmCoordinator extends DurableObject<Env> {
  private readonly initialized: Promise<void>;
  private identity: RealmIdentityPolicy | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      const snapshot = await ctx.storage.get<RealmRecoverySnapshot>(REALM_IDENTITY_SNAPSHOT_KEY);
      const realmId = snapshot?.realm.id ?? `realm:${env.ANYAM_INSTALLATION_ID ?? "unconfigured"}`;
      this.identity = new RealmIdentityPolicy({
        realmId,
        relyingPartyId: snapshot?.realm.relyingPartyId ?? env.ANYAM_REALM_RP_ID ?? "anyam.local",
      });
      if (snapshot) this.identity.restoreOperationalSnapshot(snapshot);
    });
  }

  private requireIdentity(): RealmIdentityPolicy {
    if (!this.identity) throw new Error("realm identity is not hydrated");
    return this.identity;
  }

  private async persistIdentity(): Promise<void> {
    await this.ctx.storage.put(REALM_IDENTITY_SNAPSHOT_KEY, this.requireIdentity().getRecoverySnapshot());
  }

  private async transitionIdentity<T>(operation: (identity: RealmIdentityPolicy) => Promise<T> | T): Promise<T> {
    const identity = this.requireIdentity();
    const before = identity.getRecoverySnapshot();
    try {
      const result = await operation(identity);
      await this.persistIdentity();
      return result;
    } catch (error) {
      identity.restoreOperationalSnapshot(before);
      throw error;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/identity/status") {
        return coordinatorJson({
          protocol: REALM_COORDINATOR_PROTOCOL,
          status: "ready",
          identity: identitySummary(this.requireIdentity()),
          receipt: "authority=realm-coordinator; persistence=durable-object-storage; credentialFree=true",
        });
      }
      if (request.method !== "POST") return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, code: "method_not_allowed", recoveryAction: "use GET for identity status or POST for a bounded identity transition", receipt: "coordinator=method-not-allowed" }, 405);
      const body = await coordinatorBody(request);
      const identity = this.requireIdentity();

      if (url.pathname === "/identity/owner-enroll") {
        const principalId = coordinatorString(body, "principalId");
        const displayName = coordinatorString(body, "displayName");
        const credentialId = coordinatorString(body, "credentialId");
        const relyingPartyId = coordinatorString(body, "relyingPartyId");
        const current = identity.getRecoverySnapshot();
        if (relyingPartyId !== current.realm.relyingPartyId) throw new RealmIdentityError({ code: "realm.rp_id_mismatch", message: "The passkey relying-party ID does not match this Realm's configured authentication origin.", recoveryAction: `use the configured Realm origin ${current.realm.relyingPartyId} or update the customer-owned Realm configuration before beginning a new ceremony`, receipt: `configured=${current.realm.relyingPartyId}; presented=${relyingPartyId}` });
        const existing = current.passkeys[credentialId];
        if (existing) {
          if (existing.relyingPartyId !== relyingPartyId || existing.principalId !== principalId) throw new RealmIdentityError({ code: "passkey.exists", message: "The passkey is already bound to a different Realm principal or relying party.", recoveryAction: "use the original owner enrollment or begin a deliberate Realm migration", receipt: "passkey idempotency mismatch" });
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "owner-already-enrolled", realmId: current.realm.id, principalId, credentialId, identity: identitySummary(identity), receipt: "kernelMembership=verified; ownerEnrollment=idempotent; credentialMaterialStored=false" });
        }
        return await this.transitionIdentity((next) => {
          const principal = next.createPrincipal({ id: principalId, displayName });
          next.registerPasskey({ principalId: principal.id, credentialId, relyingPartyId });
          next.addRelationship({ principalId: principal.id, kind: "organization-member", subjectId: principal.id, role: "owner", resource: { realmId: current.realm.id } });
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "owner-enrolled", realmId: current.realm.id, principalId: principal.id, credentialId, identity: identitySummary(next), receipt: "kernelMembership=verified; ownerEnrollment=durable; credentialMaterialStored=false" });
        });
      }

      if (url.pathname === "/identity/passkey-auth") {
        const credentialId = coordinatorString(body, "credentialId");
        const relyingPartyId = coordinatorString(body, "relyingPartyId");
        const challenge = coordinatorString(body, "challenge");
        return await this.transitionIdentity((next) => {
          const session = next.authenticatePasskey({ credentialId, relyingPartyId, challenge, verified: body.verified === true, clientId: typeof body.clientId === "string" ? body.clientId : "client:anyam-web" });
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "session-issued", session, identity: identitySummary(next), receipt: "kernelMembership=verified; session=durable; authentication=passkey" });
        });
      }

      if (url.pathname === "/identity/qualification/delegate") {
        const humanSessionId = coordinatorString(body, "humanSessionId");
        const agentName = coordinatorOptionalString(body, "agentName", "Anyam qualification agent");
        const runtime = coordinatorOptionalString(body, "runtime", "qualification-runtime");
        const modelProvider = coordinatorOptionalString(body, "modelProvider", "qualification-model");
        return await this.transitionIdentity((next) => {
          const humanSession = next.validateSession(humanSessionId);
          const current = next.getRecoverySnapshot();
          const resource = {
            realmId: current.realm.id,
            projectId: REALM_QUALIFICATION_PROJECT_ID,
            sourceSpaceId: REALM_QUALIFICATION_SOURCE_SPACE_ID,
            workspaceId: REALM_QUALIFICATION_WORKSPACE_ID,
            changeId: REALM_QUALIFICATION_CHANGE_ID,
          };
          const existingPolicy = current.sourceSpacePolicies[REALM_QUALIFICATION_SOURCE_SPACE_ID];
          if (existingPolicy && !existingPolicy.readerPrincipalIds.includes(humanSession.principalId)) throw new RealmIdentityError({ code: "qualification.source_space_denied", message: "The qualification Source Space is already owned by another Realm Principal.", recoveryAction: "use a fresh disposable Realm or explicitly reset the qualification state before retrying", receipt: "qualification-source-space=principal-bound" });
          if (!existingPolicy) next.setSourceSpacePolicy({ sourceSpaceId: REALM_QUALIFICATION_SOURCE_SPACE_ID, classification: "restricted", allowedCapabilities: [...REALM_QUALIFICATION_ACTIONS], readerPrincipalIds: [humanSession.principalId], allowedModelProviders: [modelProvider] });

          const afterPolicy = next.getRecoverySnapshot();
          const existingAgent = afterPolicy.agents[REALM_QUALIFICATION_AGENT_ID];
          const agent = existingAgent ?? next.registerAgent({ id: REALM_QUALIFICATION_AGENT_ID, principalId: humanSession.principalId, name: agentName, runtime, modelProvider, clientId: REALM_QUALIFICATION_AGENT_CLIENT_ID, allowedCredentialClasses: REALM_QUALIFICATION_CREDENTIAL_CLASSES });
          if (agent.principalId !== humanSession.principalId || agent.modelProvider !== modelProvider || agent.clientId !== REALM_QUALIFICATION_AGENT_CLIENT_ID) throw new RealmIdentityError({ code: "qualification.agent_mismatch", message: "The disposable qualification agent is already bound to different identity or runtime metadata.", recoveryAction: "use the original qualification agent metadata or reset the disposable Realm", receipt: `agent=${agent.id}; principal=${agent.principalId === humanSession.principalId}; model=${agent.modelProvider === modelProvider}` });

          const beforeDelegation = next.getRecoverySnapshot();
          const activeChildGrant = Object.values(beforeDelegation.grants).find((grant) => grant.status === "active" && grant.agentId === agent.id && grant.resource.workspaceId === REALM_QUALIFICATION_WORKSPACE_ID && grant.resource.changeId === REALM_QUALIFICATION_CHANGE_ID);
          let childSessionId: string;
          let childTaskId: string;
          let childGrantId: string;
          let delegationStatus: "delegated" | "already-delegated" = "delegated";
          if (activeChildGrant) {
            childSessionId = activeChildGrant.sessionId;
            childTaskId = activeChildGrant.taskId;
            childGrantId = activeChildGrant.id;
            delegationStatus = "already-delegated";
          } else {
            const parentTask = Object.values(beforeDelegation.tasks).find((task) => task.status === "active" && task.sessionId === humanSession.id && task.workspaceId === REALM_QUALIFICATION_WORKSPACE_ID && task.changeId === REALM_QUALIFICATION_CHANGE_ID && !task.agentId);
            const task = parentTask ?? next.createTask({ principalId: humanSession.principalId, actorId: humanSession.actorId, sessionId: humanSession.id, purpose: "Qualify bounded agent credentials for an isolated workspace", workspaceId: REALM_QUALIFICATION_WORKSPACE_ID, changeId: REALM_QUALIFICATION_CHANGE_ID });
            const latest = next.getRecoverySnapshot();
            const parentGrant = Object.values(latest.grants).find((grant) => grant.status === "active" && grant.taskId === task.id && grant.sessionId === humanSession.id);
            const usableParentGrant = parentGrant ?? next.createCapabilityGrant({ principalId: humanSession.principalId, actorId: humanSession.actorId, clientId: humanSession.clientId, sessionId: humanSession.id, taskId: task.id, resource, sourceSpaceIds: [REALM_QUALIFICATION_SOURCE_SPACE_ID], actions: [...REALM_QUALIFICATION_ACTIONS], effects: ["source.read", "workspace.write", "run.invoke"], allowedModelProviders: [modelProvider], allowedCredentialClasses: [...REALM_QUALIFICATION_CREDENTIAL_CLASSES] });
            const delegated = next.delegateAgent({ humanSessionId: humanSession.id, parentGrantId: usableParentGrant.id, agentId: agent.id, purpose: "Qualify bounded agent credentials for an isolated workspace", resource, sourceSpaceIds: [REALM_QUALIFICATION_SOURCE_SPACE_ID], actions: ["source.read", "workspace.write", "change.publish_revision", "run.invoke"], effects: ["source.read", "workspace.write", "run.invoke"], allowedCredentialClasses: [...REALM_QUALIFICATION_CREDENTIAL_CLASSES], workspaceId: REALM_QUALIFICATION_WORKSPACE_ID, changeId: REALM_QUALIFICATION_CHANGE_ID });
            childSessionId = delegated.session.id;
            childTaskId = delegated.task.id;
            childGrantId = delegated.grant.id;
          }
          const finalState = next.getRecoverySnapshot();
          const childSession = finalState.sessions[childSessionId];
          const childTask = finalState.tasks[childTaskId];
          const childGrant = finalState.grants[childGrantId];
          if (!childSession || !childTask || !childGrant) throw new RealmIdentityError({ code: "qualification.delegation_missing", message: "The qualification delegation did not produce a complete Session, Task, and Grant chain.", recoveryAction: "reset the disposable Realm and retry the bounded delegation operation", receipt: "principal-actor-session-task-grant chain incomplete" });
          const credentials = REALM_QUALIFICATION_CREDENTIAL_CLASSES.map((credentialClass) => next.issueCredential({ class: credentialClass, principalId: humanSession.principalId, actorId: childSession.actorId, clientId: childSession.clientId, sessionId: childSession.id, taskId: childTask.id, grantId: childGrant.id, resource }));
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: delegationStatus, agent, session: childSession, task: childTask, grant: childGrant, credentials: credentials.map((credential) => ({ id: credential.id, class: credential.class, audience: CREDENTIAL_AUDIENCES[credential.class], token: credential.token, expiresAt: credential.expiresAt })), identity: identitySummary(next), receipt: `kernelMembership=verified; delegation=${delegationStatus}; workspace=${REALM_QUALIFICATION_WORKSPACE_ID}; credentials=git,mcp; canonicalWrite=false; credentialMaterialStored=false` });
        });
      }

      if (url.pathname === "/identity/qualification/revoke") {
        const humanSessionId = coordinatorString(body, "humanSessionId");
        const agentId = coordinatorOptionalString(body, "agentId", REALM_QUALIFICATION_AGENT_ID);
        return await this.transitionIdentity((next) => {
          const humanSession = next.validateSession(humanSessionId);
          const agent = next.getAgent(agentId);
          if (!agent || agent.principalId !== humanSession.principalId) throw new RealmIdentityError({ code: "qualification.agent_denied", message: "The requested qualification agent is not owned by the authenticated human Principal.", recoveryAction: "revoke only the agent returned by the current Realm delegation operation", receipt: "agent-principal-bound" });
          const before = next.getRecoverySnapshot();
          const result = next.revokeAgent(agentId);
          const after = next.getRecoverySnapshot();
          const affectedWorkspaceTasks = Object.values(before.tasks).filter((task) => task.agentId === agentId && task.workspaceId === REALM_QUALIFICATION_WORKSPACE_ID).length;
          const closedWorkspaceTasks = Object.values(after.tasks).filter((task) => task.agentId === agentId && task.workspaceId === REALM_QUALIFICATION_WORKSPACE_ID && task.status === "closed").length;
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "delegation-revoked", ...result, identity: identitySummary(next), receipt: `${result.receipt}; workspaceTasks=${closedWorkspaceTasks}/${affectedWorkspaceTasks}; parentHumanSession=${humanSession.id}; credentialMaterialStored=false` });
        });
      }

      if (url.pathname === "/identity/session/validate") {
        const sessionId = coordinatorString(body, "sessionId");
        const session = identity.validateSession(sessionId);
        return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "session-valid", session, identity: identitySummary(identity), receipt: "kernelMembership=verified; session=active; authorizationEpoch=checked" });
      }

      if (url.pathname === "/identity/session/revoke") {
        const sessionId = coordinatorString(body, "sessionId");
        return await this.transitionIdentity((next) => {
          const revoked = next.revokeSession(sessionId);
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "session-revoked", ...revoked, identity: identitySummary(next), receipt: "kernelMembership=verified; session=revoked; delegatedAuthority=closed" });
        });
      }

      return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, code: "not_found", recoveryAction: "use one of the bounded identity coordinator routes", receipt: `coordinator=route-not-found; path=${url.pathname}` }, 404);
    } catch (error) {
      return coordinatorError(error);
    }
  }
}

/**
 * The Workflow binding is present to make the orchestration boundary explicit;
 * this ticket does not start or mutate a Workflow instance.
 */
export class AnyamRealmWorkflow extends WorkflowEntrypoint<Env, { readonly operation: "foundation-probe" }> {
  override async run(): Promise<{ readonly status: "blocked"; readonly recoveryAction: string; readonly receipt: string }> {
    return {
      status: "blocked",
      recoveryAction: "Implement a bounded Run/Workflow operation before invoking this binding.",
      receipt: "workflowAuthority=not-enabled; credentialFree=true",
    };
  }
}

function isAnyamOAuthPath(pathname: string): boolean {
  return pathname === "/mcp"
    || pathname === "/authorize"
    || pathname === "/oauth/token"
    || pathname === "/oauth/register"
    || pathname.startsWith("/.well-known/oauth-")
    || pathname === "/.well-known/openid-configuration";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Owner ceremony routes do not need the OAuth provider to be constructed.
    // This keeps local HTTP development useful while the provider correctly
    // enforces HTTPS issuer metadata for MCP/OAuth requests.
    const ownerResponse = await handleAnyamRealmOwnerRequest(request, env);
    if (ownerResponse) return ownerResponse;

    const url = new URL(request.url);
    if (!isAnyamOAuthPath(url.pathname)) return handleCustomerRealmRequest(request, env);

    const origin = url.origin;
    const oauthProvider = createAnyamRealmOAuthProvider({
      resource: `${origin}/mcp`,
      issuer: origin,
    });
    return oauthProvider.fetch(request, env, ctx);
  },
};
