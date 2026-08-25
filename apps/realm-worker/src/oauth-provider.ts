import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
  type ClientInfo,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  handleCustomerRealmRequest,
  type CustomerRealmWorkerEnv,
} from "../../../src/cloudflare/realm-worker.ts";
import { toOAuthSubject } from "../../../src/identity/oauth-subject.ts";
import { intersectOAuthScopes, isOAuthConsentDecision } from "../../../src/identity/oauth-consent.ts";
import {
  anyamPasskeyOwnerAuthorization,
  anyamRealmOwnerSessionId,
  requestAnyamRealmCoordinator,
  handleAnyamRealmOwnerRequest,
} from "./passkey-owner.ts";
import { handleAnyamRealmMcpRequest } from "./mcp-handler.ts";

export const ANYAM_REALM_OAUTH_PROTOCOL = "anyam.realm-oauth/v1" as const;
export const ANYAM_REALM_OAUTH_RESOURCE_PATH = "/mcp" as const;
export const ANYAM_REALM_OAUTH_SCOPES = [
  "project.read",
  "project.write",
  "workspace.inspect",
  "workspace.write",
  "change.inspect",
  "intent.inspect",
  "intent.write",
  "pullRequest.inspect",
  "pullRequest.write",
  "source.read",
  "change.write",
  "run.invoke",
  "landing.request",
  "release.create",
  "target.configure",
  "promotion.request",
] as const;

export type AnyamRealmOAuthProps = {
  readonly protocol: typeof ANYAM_REALM_OAUTH_PROTOCOL;
  readonly userId: string;
  readonly displayName: string;
  readonly realmId: string;
  readonly scopes: readonly string[];
  /** Opaque kernel session used by the authenticated MCP handler to cross the
   * Durable Object boundary. It is encrypted inside the provider grant and is
   * never returned as credential material. */
  readonly kernelSessionId?: string;
  /** Opaque local grant handle used to bind delivery mutations to the live OAuth grant. */
  readonly anyamGrantId?: string;
  /** The canonical OAuth resource indicator; delivery grants require a project-scoped path. */
  readonly mcpResource?: string;
  readonly authorizationReceipt: string;
};

export type AnyamRealmOAuthEnv = CustomerRealmWorkerEnv & {
  OAUTH_KV: KVNamespace;
  ANYAM_METADATA_DB: D1Database;
  ANYAM_EXPORTS: R2Bucket;
  ANYAM_EVENTS: Queue<Record<string, unknown>>;
  ANYAM_WORKFLOW: Workflow<Record<string, unknown>>;
  ANYAM_PROVIDER_WORKER?: Fetcher;
  ANYAM_PROVIDER_WORKER_URL?: string;
  /** Internal service binding for the qualified Target execution plane. */
  ANYAM_PROMOTION_EXECUTOR?: Fetcher;
  /** Shared secret used only to sign Authority-to-executor handoffs. */
  ANYAM_PROMOTION_HANDOFF_KEY_ID?: string;
  ANYAM_PROMOTION_HANDOFF_SECRET?: string;
  /** Customer-owned independent Authority recovery signing key material. */
  ANYAM_AUTHORITY_RECOVERY_SECRET?: string;
  /** Non-secret key identifier used to select the active recovery key. */
  ANYAM_AUTHORITY_RECOVERY_KEY_ID?: string;
  /** Shared only with the bound Public Gateway service; never a user credential. */
  ANYAM_PUBLIC_GATEWAY_SERVICE_SECRET?: string;
  /** Customer-owned verifier for GitHub Actions OIDC assertions. The token is
   * forwarded only to this binding and never stored in Realm state. */
  ANYAM_GITHUB_OIDC_VERIFIER?: Fetcher;
  /** Customer-owned RepositoryDriver/import boundary for Bridge bundles. */
  ANYAM_GITHUB_BRIDGE_IMPORTER?: Fetcher;
  /** Customer-owned Authority cutover boundary for an owner-confirmed empty Project. */
  ANYAM_GITHUB_BRIDGE_CUTOVER?: Fetcher;
  /** Customer-owned Change proposal boundary for GitHub-ahead history. */
  ANYAM_GITHUB_BRIDGE_PROPOSAL?: Fetcher;
  /** Customer-owned signed outbound bundle/read-back Mirror boundary. */
  ANYAM_GITHUB_BRIDGE_OUTBOUND?: Fetcher;
  ANYAM_OWNER_BOOTSTRAP_TOKEN?: string;
  ANYAM_REALM_RP_ID?: string;
  OAUTH_PROVIDER?: OAuthHelpers;
};

export type AnyamRealmOAuthAuthorization = {
  readonly request: AuthRequest;
  readonly client: ClientInfo;
  readonly rawRequest: Request;
  readonly env: AnyamRealmOAuthEnv;
};

export type AnyamRealmOAuthAuthorizationDecision =
  | {
      readonly status: "authorized";
      readonly userId: string;
      readonly displayName: string;
      readonly realmId: string;
      readonly scopes: readonly string[];
      readonly authorizationReceipt: string;
      /** Serialized Realm session used to bind the explicit consent record. */
      readonly sessionId?: string;
      readonly props?: Record<string, unknown>;
    }
  | {
      readonly status: "blocked" | "retryable";
      readonly code: string;
      readonly recoveryAction: string;
      readonly receipt: string;
    };

export type AnyamRealmOAuthAuthorizationAdapter = (
  input: AnyamRealmOAuthAuthorization,
) => Promise<AnyamRealmOAuthAuthorizationDecision>;

export type AnyamRealmOAuthConfiguration = {
  readonly provider: "cloudflare-workers-oauth-provider";
  readonly protocol: typeof ANYAM_REALM_OAUTH_PROTOCOL;
  readonly resource: string;
  readonly issuer: string;
  readonly scopes: readonly string[];
  readonly plainPkce: false;
  readonly implicitFlow: false;
  readonly tokenExchange: false;
  readonly ownerAuthentication: "adapter-required";
  readonly receipt: string;
};

export type AnyamRealmOAuthProviderOptions = {
  readonly resource: string;
  readonly issuer: string;
};

export const ANYAM_REALM_OAUTH_CONSENT_TTL_SECONDS = 5 * 60;
export const ANYAM_REALM_OAUTH_CONSENT_RECEIPT = "oauthConsent=explicit; csrf=durable-session-bound; sizing=qualification-tripwire; remeasure-before-production" as const;

export function inspectAnyamRealmOAuthConfiguration(options: AnyamRealmOAuthProviderOptions): AnyamRealmOAuthConfiguration {
  return {
    provider: "cloudflare-workers-oauth-provider",
    protocol: ANYAM_REALM_OAUTH_PROTOCOL,
    resource: options.resource,
    issuer: options.issuer,
    scopes: [...ANYAM_REALM_OAUTH_SCOPES],
    plainPkce: false,
    implicitFlow: false,
    tokenExchange: false,
    ownerAuthentication: "adapter-required",
    receipt: "provider=cloudflare-workers-oauth-provider; resource=path-pinned-per-request-origin; pkce=S256-only; implicit=false; tokenExchange=false; ownerAuth=adapter-required",
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function oauthErrorRedirect(error: AuthorizationError): Response {
  if (!error.redirectUri) return jsonResponse({ code: "invalid_authorization_request", recoveryAction: "Use a registered OAuth client and exact redirect URI.", receipt: `oauthError=${error.code}; redirect=false` }, 400);
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect.toString(), 302);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function oauthAuthRequestRecord(request: AuthRequest): Record<string, unknown> {
  return {
    responseType: request.responseType,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    scope: [...request.scope],
    state: request.state,
    ...(request.codeChallenge ? { codeChallenge: request.codeChallenge } : {}),
    ...(request.codeChallengeMethod ? { codeChallengeMethod: request.codeChallengeMethod } : {}),
    ...(request.resource ? { resource: request.resource } : {}),
    ...(request.issuer ? { issuer: request.issuer } : {}),
  };
}

function singularOAuthResource(resource: AuthRequest["resource"]): string | undefined {
  if (typeof resource === "string" && resource.trim().length > 0) return resource.trim();
  if (Array.isArray(resource) && resource.length === 1 && typeof resource[0] === "string" && resource[0].trim().length > 0) return resource[0].trim();
  return undefined;
}

function oauthConsentPage(input: { consentId: string; csrfToken: string; clientName: string; requestedScopes: readonly string[]; allowedScopes: readonly string[] }): Response {
  const allowed = new Set(input.allowedScopes);
  const scopeRows = input.requestedScopes.map((scope) => `<li><code>${escapeHtml(scope)}</code>${allowed.has(scope) ? "" : " <em>(not available)</em>"}</li>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize ${escapeHtml(input.clientName)}</title><style>body{font:16px system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#17202a}main{border:1px solid #d6dbe1;border-radius:12px;padding:2rem}code{background:#f4f6f8;padding:.1rem .3rem;border-radius:4px}button{font:inherit;padding:.7rem 1rem;border:0;border-radius:6px;cursor:pointer;margin-right:.5rem}.approve{background:#14532d;color:#fff}.deny{background:#e5e7eb;color:#17202a}li{margin:.5rem 0}em{color:#6b7280}</style></head><body><main><h1>Authorize ${escapeHtml(input.clientName)}</h1><p>This application is requesting access to your Anyam Realm. Review the scopes before continuing.</p><ul>${scopeRows}</ul><form method="post" action="/authorize"><input type="hidden" name="consentId" value="${escapeHtml(input.consentId)}"><input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}"><button class="approve" name="decision" value="approve" type="submit">Approve access</button><button class="deny" name="decision" value="deny" type="submit">Deny</button></form></main></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" } });
}

function oauthConsentDenied(request: { redirectUri: string; state: string; issuer?: string }): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", "The Realm owner denied the requested scopes.");
  redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  return Response.redirect(redirect.toString(), 302);
}

function oauthConsentRecord(value: unknown): { authRequest: AuthRequest; realmId: string; principalId: string; sessionId: string; clientId: string; clientName: string; requestedScopes: string[]; allowedScopes: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("oauth_consent_record_malformed");
  const record = value as Record<string, unknown>;
  const auth = record.authRequest as Record<string, unknown> | undefined;
  if (!auth || typeof auth.responseType !== "string" || typeof auth.clientId !== "string" || typeof auth.redirectUri !== "string" || typeof auth.state !== "string" || !Array.isArray(auth.scope)) throw new Error("oauth_consent_record_malformed");
  const authRequest: AuthRequest = {
    responseType: auth.responseType,
    clientId: auth.clientId,
    redirectUri: auth.redirectUri,
    state: auth.state,
    scope: auth.scope.filter((item): item is string => typeof item === "string"),
    ...(typeof auth.codeChallenge === "string" ? { codeChallenge: auth.codeChallenge } : {}),
    ...(typeof auth.codeChallengeMethod === "string" ? { codeChallengeMethod: auth.codeChallengeMethod } : {}),
    ...(typeof auth.resource === "string" || Array.isArray(auth.resource) ? { resource: auth.resource as string | string[] } : {}),
    ...(typeof auth.issuer === "string" ? { issuer: auth.issuer } : {}),
  };
  const requiredString = (key: string): string => typeof record[key] === "string" && (record[key] as string).length > 0 ? record[key] as string : (() => { throw new Error("oauth_consent_record_malformed"); })();
  const scopes = (key: string): string[] => Array.isArray(record[key]) && (record[key] as unknown[]).every((item) => typeof item === "string") ? [...(record[key] as string[])] : (() => { throw new Error("oauth_consent_record_malformed"); })();
  return { authRequest, realmId: requiredString("realmId"), principalId: requiredString("principalId"), sessionId: requiredString("sessionId"), clientId: requiredString("clientId"), clientName: requiredString("clientName"), requestedScopes: scopes("requestedScopes"), allowedScopes: scopes("allowedScopes") };
}

function oauthDecisionFailure(decision: Exclude<AnyamRealmOAuthAuthorizationDecision, { status: "authorized" }>): Response {
  return jsonResponse({ code: decision.code, recoveryAction: decision.recoveryAction, receipt: `${decision.receipt}; oauthGrant=not-created` }, decision.status === "retryable" ? 503 : 403);
}

function oauthForm(request: Request): Promise<URLSearchParams> {
  return request.clone().text().then((body) => new URLSearchParams(body));
}

async function authorizeRequest(request: Request, env: AnyamRealmOAuthEnv, adapter: AnyamRealmOAuthAuthorizationAdapter): Promise<Response> {
  const provider = env.OAUTH_PROVIDER!;
  if (request.method === "POST") {
    const form = await oauthForm(request);
    const consentId = form.get("consentId")?.trim() ?? "";
    const csrfToken = form.get("csrfToken")?.trim() ?? "";
    const decisionValue = form.get("decision")?.trim() ?? "";
    if (!consentId || !csrfToken || !isOAuthConsentDecision(decisionValue)) return jsonResponse({ code: "oauth_consent_submission_invalid", recoveryAction: "Submit the consent form without changing its hidden consentId, csrfToken, or decision value.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; submission=invalid; grant=not-created` }, 400);
    const sessionId = await anyamRealmOwnerSessionId(request, env);
    if (!sessionId) return jsonResponse({ code: "owner_authentication_required", recoveryAction: "Authenticate the Realm owner at /owner/login before submitting OAuth consent.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; ownerSession=missing; grant=not-created` }, 401);

    let inspected: Record<string, unknown>;
    try {
      inspected = await requestAnyamRealmCoordinator(env, "/identity/oauth-consent/inspect", { consentId, sessionId });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
      return jsonResponse({ code: "oauth_consent_invalid", recoveryAction: "Restart authorization and submit the current consent page through the same authenticated session.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; inspect=failed; detail=${detail}` }, 403);
    }
    let consent: ReturnType<typeof oauthConsentRecord>;
    try {
      consent = oauthConsentRecord(inspected.consent);
    } catch {
      return jsonResponse({ code: "oauth_consent_record_invalid", recoveryAction: "Restart authorization after the coordinator has been checked; no grant was created.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; record=malformed; grant=not-created` }, 503);
    }
    const client = await provider.lookupClient(consent.authRequest.clientId);
    if (!client || client.clientId !== consent.clientId) return jsonResponse({ code: "oauth_client_not_found", recoveryAction: "Register the MCP client and restart authorization.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; client=missing; grant=not-created` }, 400);
    const authorization = await adapter({ request: consent.authRequest, client, rawRequest: request, env });
    if (authorization.status !== "authorized") return oauthDecisionFailure(authorization);
    if (!authorization.sessionId || authorization.sessionId !== consent.sessionId || authorization.userId !== consent.principalId || authorization.realmId !== consent.realmId) {
      return jsonResponse({ code: "oauth_consent_session_mismatch", recoveryAction: "Re-authenticate the Realm owner and restart OAuth authorization; the consent session was not accepted.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; session=principal-binding-failed; grant=not-created` }, 403);
    }
    let consumed: ReturnType<typeof oauthConsentRecord>;
    try {
      const result = await requestAnyamRealmCoordinator(env, "/identity/oauth-consent/consume", { consentId, csrfToken, sessionId });
      consumed = oauthConsentRecord(result.consent);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
      return jsonResponse({ code: "oauth_consent_invalid", recoveryAction: "Restart authorization and submit the current consent page; the prior submission was not accepted.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; consume=failed; detail=${detail}` }, 403);
    }
    if (decisionValue === "deny") return oauthConsentDenied(consumed.authRequest);

    const grantedScopes = intersectOAuthScopes(consumed.authRequest.scope, intersectOAuthScopes(authorization.scopes, consumed.allowedScopes));
    if (grantedScopes.length === 0) return oauthConsentDenied(consumed.authRequest);
    const mcpResource = singularOAuthResource(consumed.authRequest.resource);
    const localGrantId = `grant:${crypto.randomUUID()}`;
    const userSubject = toOAuthSubject(authorization.userId);
    let completed: { redirectTo: string };
    try {
      completed = await provider.completeAuthorization({
        request: consumed.authRequest,
        userId: userSubject,
        metadata: { clientName: client.clientName, realmId: authorization.realmId, anyamGrantId: localGrantId },
        scope: grantedScopes,
        props: {
          protocol: ANYAM_REALM_OAUTH_PROTOCOL,
          userId: authorization.userId,
          displayName: authorization.displayName,
          realmId: authorization.realmId,
          scopes: grantedScopes,
          ...(authorization.props ?? {}),
          authorizationReceipt: authorization.authorizationReceipt,
          anyamGrantId: localGrantId,
          ...(mcpResource ? { mcpResource } : {}),
        } satisfies AnyamRealmOAuthProps & { anyamGrantId: string },
        revokeExistingGrants: false,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "provider_authorization_failed";
      return jsonResponse({ code: "oauth_grant_creation_failed", recoveryAction: "Retry the same OAuth client authorization request after inspecting the provider error.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; providerGrant=not-created; detail=${detail}` }, 503);
    }
    const providerGrant = (await provider.listUserGrants(userSubject)).items.find((grant) => grant.metadata?.anyamGrantId === localGrantId);
    if (!providerGrant) return jsonResponse({ code: "oauth_grant_persistence_unverified", recoveryAction: "Provider authorization completed without a discoverable grant mapping; retry only after checking provider grant storage.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; providerGrant=unmapped; localGrant=${localGrantId}` }, 503);
    try {
      const authorizationProps = authorization.props ?? {};
      await requestAnyamRealmCoordinator(env, "/identity/oauth-grant/record", { sessionId: typeof authorizationProps.kernelSessionId === "string" ? authorizationProps.kernelSessionId : authorization.sessionId, grantId: localGrantId, providerGrantId: providerGrant.id, clientId: client.clientId, scopes: grantedScopes, ...(mcpResource ? { resource: mcpResource } : {}), ...(typeof authorizationProps.agentId === "string" ? { agentId: authorizationProps.agentId } : {}), ...(typeof authorizationProps.taskId === "string" ? { taskId: authorizationProps.taskId } : {}), ...(typeof authorizationProps.capabilityGrantId === "string" ? { capabilityGrantId: authorizationProps.capabilityGrantId } : {}), ...(Array.isArray(authorizationProps.sourceSpaceIds) ? { sourceSpaceIds: authorizationProps.sourceSpaceIds } : {}) });
    } catch (error) {
      await provider.revokeGrant(providerGrant.id, userSubject).catch(() => undefined);
      const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
      return jsonResponse({ code: "oauth_grant_record_failed", recoveryAction: "The provider grant was revoked because durable Anyam grant recording failed; retry authorization after checking the coordinator.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; providerGrant=revoked-on-record-failure; detail=${detail}` }, 503);
    }
    return Response.redirect(completed.redirectTo, 302);
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await provider.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return oauthErrorRedirect(error);
    throw error;
  }
  const client = await provider.lookupClient(oauthRequest.clientId);
  if (!client) return jsonResponse({ code: "oauth_client_not_found", recoveryAction: "Register the MCP client through CIMD or the configured registration endpoint.", receipt: "client=missing; authorization=not-completed" }, 400);
  const decision = await adapter({ request: oauthRequest, client, rawRequest: request, env });
  if (decision.status !== "authorized") return oauthDecisionFailure(decision);
  if (!decision.sessionId) return jsonResponse({ code: "oauth_session_binding_missing", recoveryAction: "Use the passkey owner adapter that returns an opaque authenticated session identifier before creating consent.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; session=missing; grant=not-created` }, 503);
  const allowedScopes = intersectOAuthScopes(oauthRequest.scope, decision.scopes);
  if (allowedScopes.length === 0) return jsonResponse({ code: "oauth_scope_denied", recoveryAction: "Authenticate the Realm owner and request at least one supported Anyam scope.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; scope=empty; grant=not-created` }, 403);
  const consentId = `consent:${crypto.randomUUID()}`;
  const csrfToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ANYAM_REALM_OAUTH_CONSENT_TTL_SECONDS * 1000).toISOString();
  try {
    await requestAnyamRealmCoordinator(env, "/identity/oauth-consent/create", { consentId, csrfToken, realmId: decision.realmId, principalId: decision.userId, sessionId: decision.sessionId, clientId: client.clientId, clientName: client.clientName, requestedScopes: oauthRequest.scope, allowedScopes, authRequest: oauthAuthRequestRecord(oauthRequest), expiresAt });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    return jsonResponse({ code: "oauth_consent_creation_failed", recoveryAction: "Restart authorization after checking the durable Realm coordinator; no provider grant was created.", receipt: `${ANYAM_REALM_OAUTH_CONSENT_RECEIPT}; consent=not-created; detail=${detail}` }, 503);
  }
  return oauthConsentPage({ consentId, csrfToken, clientName: client.clientName ?? client.clientId, requestedScopes: oauthRequest.scope, allowedScopes });
}

export class AnyamRealmOAuthQualificationHandler extends WorkerEntrypoint<AnyamRealmOAuthEnv, AnyamRealmOAuthProps> {
  override async fetch(request: Request): Promise<Response> {
    return handleAnyamRealmMcpRequest(request, this.env, this.ctx.props);
  }
}

export function createAnyamRealmOAuthProvider(
  options: AnyamRealmOAuthProviderOptions,
  ownerAuthorization: AnyamRealmOAuthAuthorizationAdapter = anyamPasskeyOwnerAuthorization,
): OAuthProvider<AnyamRealmOAuthEnv> {
  const defaultHandler = {
    async fetch(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
      const ownerResponse = await handleAnyamRealmOwnerRequest(request, env);
      if (ownerResponse) return ownerResponse;
      const url = new URL(request.url);
      if (url.pathname === "/authorize") return authorizeRequest(request, env, ownerAuthorization);
      return handleCustomerRealmRequest(request, env);
    },
  };

  return new OAuthProvider<AnyamRealmOAuthEnv>({
    apiRoute: "/mcp",
    apiHandler: AnyamRealmOAuthQualificationHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    allowPlainPKCE: false,
    allowImplicitFlow: false,
    allowTokenExchangeGrant: false,
    scopesSupported: [...ANYAM_REALM_OAUTH_SCOPES],
    resourceMetadata: {
      resource: options.resource,
      authorization_servers: [options.issuer],
      scopes_supported: [...ANYAM_REALM_OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Anyam Realm qualification MCP resource",
    },
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: "/oauth/register",
  });
}
