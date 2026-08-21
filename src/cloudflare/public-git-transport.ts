import { PUBLIC_GATEWAY_PROTOCOL } from "./public-gateway.ts";
import {
  handleSmartHttpRequest,
  type SmartHttpBudgetPolicy,
  type SmartHttpBudgetCoordinator,
  type SmartHttpBudgetTracker,
  type SmartHttpCredentialValidation,
  type SmartHttpGatewayConfig,
} from "../portability/smart-http.ts";

export type PublicGitTransportConfig = {
  upstreamBase: string;
  publicSourceSpaceId: string;
  budget: SmartHttpBudgetPolicy;
  budgetTracker?: SmartHttpBudgetTracker;
  budgetCoordinator?: SmartHttpBudgetCoordinator;
};

const anonymousReadOnlyCredentials = {
  validate: async (): Promise<SmartHttpCredentialValidation> => ({
    valid: false,
    code: "operation-denied",
    recoveryAction: "public Git is anonymous read-only; use the contribution envelope for a public proposal",
    receipt: "publicGit=anonymous-read-only; canonicalWrite=false; credentialMaterialStored=false",
  }),
};

function json(value: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function blocked(code: string, recoveryAction: string, receipt: string, status: number): Response {
  return json({
    protocol: PUBLIC_GATEWAY_PROTOCOL,
    code,
    recoveryAction,
    receipt,
    canonicalWrite: false,
    privateMetadata: "not-disclosed",
  }, status);
}

/**
 * Public Git is a disclosure adapter, not a second transport implementation.
 * It rewrites the public vanity route into the shared Smart HTTP route, which
 * owns stream counting, deadlines, upstream validation, and lifecycle cleanup.
 */
export async function handlePublicGitRequest(request: Request, config: PublicGitTransportConfig): Promise<Response | undefined> {
  const url = new URL(request.url);
  const prefix = "/projects/public/source.git/";
  if (!url.pathname.startsWith(prefix)) return undefined;
  const suffix = url.pathname.slice(prefix.length);
  if (suffix.length === 0 || suffix.includes("..") || suffix.includes("\\") || suffix.includes("\0")) {
    return blocked("not_found", "use the configured public Source Space Git URL", "publicGitPath=invalid; privateMetadata=not-disclosed", 404);
  }
  const receiveAdvertisement = suffix === "info/refs" && url.searchParams.get("service") === "git-receive-pack";
  const receivePack = suffix === "git-receive-pack";
  if (receiveAdvertisement || receivePack) {
    return blocked("canonical_write_denied", "create a public Change contribution envelope; anonymous Git receive-pack is never enabled", `publicGitOperation=${receiveAdvertisement ? "receive-advertisement" : "receive-pack"}; canonicalWrite=false; materialized=false`, 403);
  }
  if (request.method !== "GET" && request.method !== "HEAD" && !(request.method === "POST" && suffix === "git-upload-pack")) {
    return blocked("method_not_allowed", "use public Git upload-pack reads or the contribution envelope endpoint", `publicGitOperation=${request.method}; canonicalWrite=false`, 405);
  }

  const internalUrl = new URL(request.url);
  internalUrl.pathname = `/git/public.git/${suffix}`;
  const requestInit: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: request.headers,
    ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body, duplex: "half" }),
  };
  const boundedRequest = new Request(internalUrl, requestInit);
  const transportConfig: SmartHttpGatewayConfig = {
    upstreamBase: config.upstreamBase,
    upstreamPath: ({ suffix: upstreamSuffix }) => upstreamSuffix,
    credentials: anonymousReadOnlyCredentials,
    sourceSpaceIdForRepository: ({ repositoryId }) => repositoryId === "public" ? config.publicSourceSpaceId : undefined,
    anonymousReadForRepository: ({ repositoryId, sourceSpaceId }) => repositoryId === "public" && sourceSpaceId === config.publicSourceSpaceId,
    budgets: { read: config.budget },
    ...(config.budgetTracker ? { budgetTracker: config.budgetTracker } : {}),
    ...(config.budgetCoordinator ? { budgetCoordinator: config.budgetCoordinator } : {}),
  };
  const response = await handleSmartHttpRequest(boundedRequest, transportConfig);
  if (!response) return blocked("not_found", "use the configured public Source Space Git URL", "publicGitRoute=not-found; privateMetadata=not-disclosed", 404);
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("x-anyam-public-projection", "true");
  responseHeaders.set("x-anyam-canonical-write", "false");
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}
