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
import {
  anyamPasskeyOwnerAuthorization,
  handleAnyamRealmOwnerRequest,
} from "./passkey-owner.ts";

export const ANYAM_REALM_OAUTH_PROTOCOL = "anyam.realm-oauth/v1" as const;
export const ANYAM_REALM_OAUTH_RESOURCE_PATH = "/mcp" as const;
export const ANYAM_REALM_OAUTH_SCOPES = [
  "project.read",
  "source.read",
  "change.write",
  "run.invoke",
] as const;

export type AnyamRealmOAuthProps = {
  readonly protocol: typeof ANYAM_REALM_OAUTH_PROTOCOL;
  readonly userId: string;
  readonly displayName: string;
  readonly realmId: string;
  readonly scopes: readonly string[];
  readonly authorizationReceipt: string;
};

export type AnyamRealmOAuthEnv = CustomerRealmWorkerEnv & {
  OAUTH_KV: KVNamespace;
  ANYAM_METADATA_DB: D1Database;
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

async function authorizeRequest(request: Request, env: AnyamRealmOAuthEnv, adapter: AnyamRealmOAuthAuthorizationAdapter): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER!.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return oauthErrorRedirect(error);
    throw error;
  }

  const client = await env.OAUTH_PROVIDER!.lookupClient(oauthRequest.clientId);
  if (!client) return jsonResponse({ code: "oauth_client_not_found", recoveryAction: "Register the MCP client through CIMD or the configured registration endpoint.", receipt: "client=missing; authorization=not-completed" }, 400);

  const decision = await adapter({ request: oauthRequest, client, rawRequest: request, env });
  if (decision.status !== "authorized") {
    return jsonResponse({
      code: decision.code,
      recoveryAction: decision.recoveryAction,
      receipt: `${decision.receipt}; oauthGrant=not-created`,
    }, decision.status === "retryable" ? 503 : 403);
  }

  const grantedScopes = oauthRequest.scope.filter((scope) => decision.scopes.includes(scope));
  if (grantedScopes.length === 0) return jsonResponse({ code: "oauth_scope_denied", recoveryAction: "Authenticate the Realm owner and approve at least one requested Anyam scope.", receipt: "scope=empty; oauthGrant=not-created" }, 403);

  const completed = await env.OAUTH_PROVIDER!.completeAuthorization({
    request: oauthRequest,
    // Anyam principal IDs are colon-delimited. The provider's authorization
    // code envelope also uses `:`, so keep the canonical ID in encrypted props
    // and use an unambiguous wire subject for the provider grant.
    userId: toOAuthSubject(decision.userId),
    metadata: { clientName: client.clientName, realmId: decision.realmId },
    scope: grantedScopes,
    props: {
      protocol: ANYAM_REALM_OAUTH_PROTOCOL,
      userId: decision.userId,
      displayName: decision.displayName,
      realmId: decision.realmId,
      scopes: grantedScopes,
      authorizationReceipt: decision.authorizationReceipt,
      ...(decision.props ?? {}),
    } satisfies AnyamRealmOAuthProps,
  });
  return Response.redirect(completed.redirectTo, 302);
}

/**
 * This is intentionally an authenticated qualification handler, not the full
 * Anyam MCP tool surface. The OAuth provider owns bearer validation and
 * audience checks; Anyam still owns the operation-level capability policy.
 */
export class AnyamRealmOAuthQualificationHandler extends WorkerEntrypoint<AnyamRealmOAuthEnv, AnyamRealmOAuthProps> {
  override async fetch(): Promise<Response> {
    return jsonResponse({
      protocol: ANYAM_REALM_OAUTH_PROTOCOL,
      status: "authenticated",
      userId: this.ctx.props.userId,
      displayName: this.ctx.props.displayName,
      realmId: this.ctx.props.realmId,
      scopes: this.ctx.props.scopes,
      authorizationReceipt: this.ctx.props.authorizationReceipt,
      receipt: "oauthProvider=validated; audience=validated; operationPolicy=next-boundary",
    });
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
