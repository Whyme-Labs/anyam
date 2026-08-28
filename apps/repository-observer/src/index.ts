/// <reference types="@cloudflare/workers-types" />

import {
  parseRepositoryObservationRequest,
  parseRepositoryObservationServiceResponse,
  REPOSITORY_OBSERVATION_PROTOCOL,
  verifyRepositoryObservation,
} from "../../../src/portability/repository-observation.ts";
import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, scanCredentialMaterial } from "../../../src/security/credential-material.ts";

export const REPOSITORY_OBSERVER_PROTOCOL = "anyam.repository-observer/v1" as const;

export type Env = {
  /** Customer-owned provider adapter that reads the exact repository state. */
  REPOSITORY_DRIVER?: Fetcher;
  REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT?: string;
  REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT?: string;
  REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_MS?: string;
  REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_RECEIPT?: string;
};

type ObserverConfiguration = {
  requestBytesLimit: number;
  requestBytesReceipt: string;
  transportTimeoutMs: number;
  transportTimeoutReceipt: string;
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
  if (scanCredentialMaterial(value)) return undefined;
  return value.trim();
}

function configuration(env: Env): ObserverConfiguration {
  const requestBytesLimit = Number(env.REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT);
  const requestBytesReceipt = safeReceipt(env.REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT, "request_bytes_receipt");
  const transportTimeoutMs = Number(env.REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_MS);
  const transportTimeoutReceipt = safeReceipt(env.REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_RECEIPT, "transport_timeout_receipt");
  if (!Number.isSafeInteger(requestBytesLimit) || requestBytesLimit < 1 || !requestBytesReceipt || !/(?:receipt|measure|qualification)/iu.test(requestBytesReceipt)) throw new Error("repository_observer_request_budget_configuration_invalid");
  if (!Number.isSafeInteger(transportTimeoutMs) || transportTimeoutMs < 1 || !transportTimeoutReceipt || !/(?:receipt|measure|qualification)/iu.test(transportTimeoutReceipt)) throw new Error("repository_observer_transport_timeout_configuration_invalid");
  return { requestBytesLimit, requestBytesReceipt, transportTimeoutMs, transportTimeoutReceipt };
}

function sizingReceipt(config: ObserverConfiguration): string {
  return `requestBudget=${config.requestBytesLimit}; sizingReceipt=${config.requestBytesReceipt}; transportTimeoutMs=${config.transportTimeoutMs}; timeoutSizingReceipt=${config.transportTimeoutReceipt}; credentialScanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}`;
}

function timeoutError(timeoutMs: number, bytes: number): Error {
  return new Error(`repository_observer_transport_timeout:timeoutMs=${timeoutMs}:bytes=${bytes}`);
}

async function readBoundedText(bodySource: Request | Response, limit: number, timeoutMs: number): Promise<string> {
  const reader = bodySource.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const consume = (async (): Promise<string> => {
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
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel();
      reject(timeoutError(timeoutMs, bytes));
    }, timeoutMs);
  });
  try {
    return await Promise.race([consume, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withTransportTimeout<T>(operation: () => Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(timeoutError(timeoutMs, 0));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function failure(input: ObserverFailure, httpStatus: number): Response {
  return json({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: input.status, code: input.code, ...(input.message ? { message: input.message } : {}), recoveryAction: input.recoveryAction, receipt: `${input.receipt}; credentialScanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; credentialMaterialStored=false`, credentialValues: "not-printed", canonicalWrite: false }, httpStatus);
}

function requestFailure(code: string, message: string, recoveryAction: string, receipt: string): Response {
  return failure({ status: "blocked", code, message, recoveryAction, receipt }, 422);
}

async function observe(request: Request, env: Env, config: ObserverConfiguration): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedText(request, config.requestBytesLimit, config.transportTimeoutMs)) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "request-body-invalid";
    const budget = message.startsWith("repository_observer_request_budget_exceeded:");
    const timedOut = message.startsWith("repository_observer_transport_timeout:");
    return requestFailure(timedOut ? "request_timeout" : budget ? "request_budget_exceeded" : "request_malformed", timedOut ? "The RepositoryDriver observation request exceeded the configured transport timeout." : budget ? "The RepositoryDriver observation request exceeded the configured request budget." : "The RepositoryDriver observation request is not valid JSON.", timedOut ? "retry the same immutable observation within the configured transport timeout or remeasure the tripwire" : budget ? "reduce the request to the measured observer budget or remeasure the tripwire before changing it" : "send one JSON observation request object", `${message}; ${sizingReceipt(config)}`);
  }
  const parsedRequest = parseRepositoryObservationRequest(body);
  if (!parsedRequest.valid) return requestFailure(parsedRequest.code, parsedRequest.message, parsedRequest.recoveryAction, `${parsedRequest.receipt}; ${sizingReceipt(config)}`);
  const driver = env.REPOSITORY_DRIVER;
  if (!driver || typeof driver.fetch !== "function") return failure({ status: "unavailable", code: "repository_driver_unconfigured", recoveryAction: "bind the customer-owned RepositoryDriver service before enabling hosted Change Revision publication", receipt: `repositoryObserver=driver-unconfigured; providerInvocation=false; ${sizingReceipt(config)}` }, 503);
  let driverResponse: Response;
  const driverController = new AbortController();
  try {
    driverResponse = await withTransportTimeout(() => driver.fetch(new Request("https://anyam-repository-driver/observe", { method: "POST", headers: { "content-type": "application/json", "x-anyam-repository-observer-protocol": REPOSITORY_OBSERVER_PROTOCOL }, body: JSON.stringify(parsedRequest.request), signal: driverController.signal })), config.transportTimeoutMs, () => driverController.abort());
  } catch (error) {
    const timedOut = error instanceof Error && error.message.startsWith("repository_observer_transport_timeout:");
    return failure({ status: "unavailable", code: timedOut ? "repository_driver_timeout" : "repository_driver_unavailable", recoveryAction: timedOut ? "retry the same immutable observation after the customer RepositoryDriver responds within the configured transport timeout" : "retry the same immutable observation after the customer RepositoryDriver service is reachable", receipt: `repositoryObserver=driver-${timedOut ? "timeout" : "unavailable"}; providerInvocation=indeterminate; ${sizingReceipt(config)}` }, 503);
  }
  let driverBody: unknown;
  try {
    driverBody = JSON.parse(await readBoundedText(driverResponse, config.requestBytesLimit, config.transportTimeoutMs)) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "repository-driver-response-invalid";
    const budget = message.startsWith("repository_observer_request_budget_exceeded:");
    const timedOut = message.startsWith("repository_observer_transport_timeout:");
    return failure({ status: "unavailable", code: timedOut ? "repository_driver_response_timeout" : budget ? "repository_driver_response_budget_exceeded" : "repository_driver_response_invalid", recoveryAction: timedOut ? "repair the customer-owned RepositoryDriver response stream and retry within the configured transport timeout" : budget ? "reduce the customer-owned RepositoryDriver response to the configured observer budget or remeasure the tripwire" : "repair the customer-owned RepositoryDriver response and retry the same immutable observation", receipt: `repositoryObserver=driver-response-${timedOut ? "timeout" : budget ? "budget-exceeded" : "invalid"}; httpStatus=${driverResponse.status}; providerInvocation=true; ${sizingReceipt(config)}` }, 502);
  }
  if (scanCredentialMaterial(driverBody)) return failure({ status: "unavailable", code: "repository_driver_response_credential_material", recoveryAction: "remove credential material from the customer-owned RepositoryDriver response and retry the same immutable observation", receipt: `repositoryObserver=driver-response-credential-material; httpStatus=${driverResponse.status}; providerInvocation=true; ${sizingReceipt(config)}` }, 502);
  const parsedResponse = parseRepositoryObservationServiceResponse(driverBody);
  if (!parsedResponse.valid) return failure({ status: "unavailable", code: parsedResponse.code, recoveryAction: parsedResponse.recoveryAction, receipt: `${parsedResponse.receipt}; providerInvocation=true; ${sizingReceipt(config)}` }, 502);
  const providerReceipt = safeReceipt(parsedResponse.response.receipt, "driver_receipt");
  if (!providerReceipt) return failure({ status: "unavailable", code: "repository_driver_receipt_unsafe", recoveryAction: "return a credential-free provider receipt from the customer-owned RepositoryDriver", receipt: `repositoryObserver=driver-receipt-unsafe; httpStatus=${driverResponse.status}; providerInvocation=true; ${sizingReceipt(config)}` }, 502);
  if (driverResponse.status < 200 || driverResponse.status >= 300) {
    if (parsedResponse.response.status === "succeeded") return failure({ status: "unavailable", code: "repository_driver_transport_failure", recoveryAction: "return a 2xx transport response for a successful RepositoryDriver observation and retry the same immutable request", receipt: `repositoryObserver=driver-non-2xx-success-body; httpStatus=${driverResponse.status}; responseStatus=succeeded; providerInvocation=indeterminate; ${sizingReceipt(config)}` }, 502);
    const semanticStatus = parsedResponse.response.status === "blocked" ? "blocked" : "unavailable";
    return failure({ status: semanticStatus, code: parsedResponse.response.code ?? "repository_driver_transport_failure", recoveryAction: parsedResponse.response.recoveryAction ?? "inspect the customer-owned RepositoryDriver transport and retry the same immutable observation", receipt: `${providerReceipt}; httpStatus=${driverResponse.status}; transport=non-2xx; providerInvocation=true; ${sizingReceipt(config)}` }, semanticStatus === "blocked" ? 409 : 503);
  }
  if (parsedResponse.response.status === "blocked") return failure({ status: "blocked", code: parsedResponse.response.code ?? "repository_driver_observation_blocked", recoveryAction: parsedResponse.response.recoveryAction ?? "inspect the customer-owned RepositoryDriver checkpoint and retry the same immutable observation", receipt: `${providerReceipt}; providerInvocation=true; ${sizingReceipt(config)}` }, 409);
  if (parsedResponse.response.status === "unavailable") return failure({ status: "unavailable", code: parsedResponse.response.code ?? "repository_driver_observation_unavailable", recoveryAction: parsedResponse.response.recoveryAction ?? "inspect the customer-owned RepositoryDriver checkpoint and retry the same immutable observation", receipt: `${providerReceipt}; providerInvocation=true; ${sizingReceipt(config)}` }, 503);
  if (!parsedResponse.response.observation) return failure({ status: "unavailable", code: "repository_driver_observation_missing", recoveryAction: "return the exact verified RepositoryDriver observation", receipt: `${providerReceipt}; providerInvocation=true; ${sizingReceipt(config)}` }, 502);
  const observationReceipt = safeReceipt(parsedResponse.response.observation.receipt, "observation_receipt");
  if (!observationReceipt) return failure({ status: "unavailable", code: "repository_driver_observation_receipt_unsafe", recoveryAction: "return a credential-free observation receipt from the customer-owned RepositoryDriver", receipt: `repositoryObserver=observation-receipt-unsafe; providerInvocation=true; ${sizingReceipt(config)}` }, 502);
  const verified = await verifyRepositoryObservation({ observation: parsedResponse.response.observation, ...parsedRequest.request });
  if (!verified.valid) return failure({ status: "blocked", code: verified.code, recoveryAction: verified.recoveryAction, receipt: `${verified.receipt}; providerInvocation=true; ${sizingReceipt(config)}` }, 409);
  return json({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "succeeded", observation: { ...verified.observation, receipt: observationReceipt }, receipt: `repositoryObserver=${REPOSITORY_OBSERVER_PROTOCOL}; driverReceipt=${providerReceipt}; providerInvocation=true; ${sizingReceipt(config)}; credentialMaterialStored=false`, credentialValues: "not-printed", canonicalWrite: false });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      const config = configuration(env);
      if (url.pathname === "/health" && request.method === "GET") {
        const ready = env.REPOSITORY_DRIVER !== undefined && typeof env.REPOSITORY_DRIVER.fetch === "function";
        return json({ protocol: REPOSITORY_OBSERVER_PROTOCOL, status: ready ? "ready" : "blocked", driver: ready ? "bound" : "unconfigured", credentialValues: "not-printed", canonicalWrite: false, receipt: `repositoryObserver=${REPOSITORY_OBSERVER_PROTOCOL}; driver=${ready ? "bound" : "unconfigured"}; ${sizingReceipt(config)}; credentialMaterialStored=false` }, ready ? 200 : 503);
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
