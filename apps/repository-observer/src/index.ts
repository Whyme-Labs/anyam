/// <reference types="@cloudflare/workers-types" />

import {
  parseRepositoryObservationRequest,
  parseRepositoryObservationServiceResponse,
  REPOSITORY_OBSERVATION_PROTOCOL,
  verifyRepositoryObservation,
  type RepositoryObservationRequest,
} from "../../../src/portability/repository-observation.ts";

export const REPOSITORY_OBSERVER_PROTOCOL = "anyam.repository-observer/v1" as const;

export type Env = {
  /** Customer-owned provider adapter that reads the exact repository state. */
  REPOSITORY_DRIVER?: Fetcher;
  REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT?: string;
  REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT?: string;
};

type ObserverFailure = {
  status: "blocked" | "unavailable";
  code: string;
  message?: string;
  recoveryAction: string;
  receipt: string;
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function safeReceipt(value: unknown, _field: string): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  if (/(?:token|secret|password|authorization|private[_ -]?key)\s*[:=]/iu.test(value) || /\bBearer\s+\S+/iu.test(value) || /-----BEGIN [^-]+ PRIVATE KEY-----/u.test(value)) return undefined;
  return value.trim();
}

function configuration(env: Env): { limit: number; receipt: string } {
  const limit = Number(env.REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT);
  const receipt = safeReceipt(env.REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT, "configuration_receipt");
  if (!Number.isSafeInteger(limit) || limit < 1 || !receipt || !/(?:receipt|measure|qualification)/iu.test(receipt)) throw new Error("repository_observer_configuration_invalid");
  return { limit, receipt };
}

async function readBoundedText(bodySource: Request | Response, limit: number): Promise<string> {
  const reader = bodySource.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error(`repository_observer_request_budget_exceeded:limit=${limit}:asked=${bytes}`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function failure(input: ObserverFailure, httpStatus: number): Response {
  return json({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: input.status, code: input.code, ...(input.message ? { message: input.message } : {}), recoveryAction: input.recoveryAction, receipt: input.receipt, credentialValues: "not-printed", canonicalWrite: false }, httpStatus);
}

function requestFailure(code: string, message: string, recoveryAction: string, receipt: string): Response {
  return failure({ status: "blocked", code, message, recoveryAction, receipt: `${receipt}; credentialMaterialStored=false` }, 422);
}

async function observe(request: Request, env: Env, config: { limit: number; receipt: string }): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedText(request, config.limit)) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "request-body-invalid";
    const budget = message.startsWith("repository_observer_request_budget_exceeded:");
    return requestFailure(budget ? "request_budget_exceeded" : "request_malformed", budget ? "The RepositoryDriver observation request exceeded the configured request budget." : "The RepositoryDriver observation request is not valid JSON.", budget ? "reduce the request to the measured observer budget or remeasure the tripwire before changing it" : "send one JSON observation request object", `${message}; requestBudget=${config.limit}; sizingReceipt=${config.receipt}`);
  }
  const parsedRequest = parseRepositoryObservationRequest(body);
  if (!parsedRequest.valid) return requestFailure(parsedRequest.code, parsedRequest.message, parsedRequest.recoveryAction, parsedRequest.receipt);
  const driver = env.REPOSITORY_DRIVER;
  if (!driver || typeof driver.fetch !== "function") return failure({ status: "unavailable", code: "repository_driver_unconfigured", recoveryAction: "bind the customer-owned RepositoryDriver service before enabling hosted Change Revision publication", receipt: "repositoryObserver=driver-unconfigured; providerInvocation=false; credentialMaterialStored=false" }, 503);
  let driverResponse: Response;
  try {
    driverResponse = await driver.fetch(new Request("https://anyam-repository-driver/observe", { method: "POST", headers: { "content-type": "application/json", "x-anyam-repository-observer-protocol": REPOSITORY_OBSERVER_PROTOCOL }, body: JSON.stringify(body) }));
  } catch (error) {
    return failure({ status: "unavailable", code: "repository_driver_unavailable", recoveryAction: "retry the same immutable observation after the customer RepositoryDriver service is reachable", receipt: `repositoryObserver=driver-unavailable; providerInvocation=indeterminate; error=${error instanceof Error ? error.message : "transport-error"}; credentialMaterialStored=false` }, 503);
  }
  let driverBody: unknown;
  try {
    driverBody = JSON.parse(await readBoundedText(driverResponse, config.limit)) as unknown;
  } catch {
    return failure({ status: "unavailable", code: "repository_driver_response_invalid", recoveryAction: "repair the customer-owned RepositoryDriver response and retry the same immutable observation", receipt: `repositoryObserver=driver-response-invalid; httpStatus=${driverResponse.status}; providerInvocation=true; credentialMaterialStored=false` }, 502);
  }
  const parsedResponse = parseRepositoryObservationServiceResponse(driverBody);
  if (!parsedResponse.valid) return failure({ status: "unavailable", code: parsedResponse.code, recoveryAction: parsedResponse.recoveryAction, receipt: `${parsedResponse.receipt}; providerInvocation=true; credentialMaterialStored=false` }, 502);
  const providerReceipt = safeReceipt(parsedResponse.response.receipt, "driver_receipt");
  if (!providerReceipt) return failure({ status: "unavailable", code: "repository_driver_receipt_missing", recoveryAction: "return a credential-free provider receipt from the customer-owned RepositoryDriver", receipt: "repositoryObserver=driver-receipt-missing; providerInvocation=true; credentialMaterialStored=false" }, 502);
  if (parsedResponse.response.status === "blocked") return failure({ status: "blocked", code: parsedResponse.response.code ?? "repository_driver_observation_blocked", recoveryAction: parsedResponse.response.recoveryAction ?? "inspect the customer-owned RepositoryDriver checkpoint and retry the same immutable observation", receipt: `${providerReceipt}; providerInvocation=true; credentialMaterialStored=false` }, 409);
  if (parsedResponse.response.status === "unavailable") return failure({ status: "unavailable", code: parsedResponse.response.code ?? "repository_driver_observation_unavailable", recoveryAction: parsedResponse.response.recoveryAction ?? "inspect the customer-owned RepositoryDriver checkpoint and retry the same immutable observation", receipt: `${providerReceipt}; providerInvocation=true; credentialMaterialStored=false` }, 503);
  if (!parsedResponse.response.observation) return failure({ status: "unavailable", code: "repository_driver_observation_missing", recoveryAction: "return the exact verified RepositoryDriver observation", receipt: `${providerReceipt}; providerInvocation=true; credentialMaterialStored=false` }, 502);
  const observationReceipt = safeReceipt(parsedResponse.response.observation.receipt, "observation_receipt");
  if (!observationReceipt) return failure({ status: "unavailable", code: "repository_driver_observation_receipt_unsafe", recoveryAction: "return a credential-free observation receipt from the customer-owned RepositoryDriver", receipt: "repositoryObserver=observation-receipt-unsafe; providerInvocation=true; credentialMaterialStored=false" }, 502);
  const verified = await verifyRepositoryObservation({ observation: parsedResponse.response.observation, ...parsedRequest.request });
  if (!verified.valid) return failure({ status: "blocked", code: verified.code, recoveryAction: verified.recoveryAction, receipt: `${verified.receipt}; providerInvocation=true; credentialMaterialStored=false` }, 409);
  return json({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "succeeded", observation: { ...verified.observation, receipt: observationReceipt }, receipt: `repositoryObserver=${REPOSITORY_OBSERVER_PROTOCOL}; driverReceipt=${providerReceipt}; providerInvocation=true; requestBudget=${config.limit}; sizingReceipt=${config.receipt}; credentialMaterialStored=false`, credentialValues: "not-printed", canonicalWrite: false });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      const config = configuration(env);
      if (url.pathname === "/health" && request.method === "GET") {
        const ready = env.REPOSITORY_DRIVER !== undefined && typeof env.REPOSITORY_DRIVER.fetch === "function";
        return json({ protocol: REPOSITORY_OBSERVER_PROTOCOL, status: ready ? "ready" : "blocked", driver: ready ? "bound" : "unconfigured", credentialValues: "not-printed", canonicalWrite: false, receipt: `repositoryObserver=${REPOSITORY_OBSERVER_PROTOCOL}; driver=${ready ? "bound" : "unconfigured"}; requestBudget=${config.limit}; sizingReceipt=${config.receipt}; credentialMaterialStored=false` }, ready ? 200 : 503);
      }
      if (url.pathname !== "/observe") return json({ protocol: REPOSITORY_OBSERVER_PROTOCOL, status: "blocked", code: "not_found", recoveryAction: "use GET /health or POST /observe", receipt: "repositoryObserver=route-not-found; credentialMaterialStored=false", credentialValues: "not-printed", canonicalWrite: false }, 404);
      if (request.method !== "POST") return json({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: "use POST /observe", receipt: "repositoryObserver=post-required; credentialMaterialStored=false", credentialValues: "not-printed", canonicalWrite: false }, 405);
      return await observe(request, env, config);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "repository-observer-failed";
      return failure({ status: "blocked", code: "configuration_invalid", recoveryAction: "repair the customer-owned observer configuration and retry the same immutable request", receipt: `repositoryObserver=blocked; error=${detail}; credentialMaterialStored=false` }, 503);
    }
  },
};
