import { CONTRACT_VERSIONS } from "../kernel/contracts.ts";

export const PUBLIC_GATEWAY_ABUSE_PROTOCOL = CONTRACT_VERSIONS.publicGatewayAbuse;

/** Cloudflare documents a maximum Turnstile token length of 2048 characters. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

export type PublicGatewayAbuseMode = "edge-only" | "turnstile-required";
export type PublicGatewayAbuseOutcome = "allowed" | "challenge" | "denied" | "unavailable";

export type PublicGatewayAbuseInput = {
  requestId: string;
  token?: string;
  clientIp?: string;
};

export type PublicGatewayAbuseDecision = {
  protocol: typeof PUBLIC_GATEWAY_ABUSE_PROTOCOL;
  provider: "none" | "cloudflare-turnstile";
  outcome: PublicGatewayAbuseOutcome;
  retryable: boolean;
  materialized: false;
  resultOnly: true;
  reason: "disabled" | "token-missing" | "token-too-long" | "token-rejected" | "token-mismatch" | "provider-timeout" | "provider-unavailable" | "provider-malformed" | "validated";
  nextAction: string;
  receipt: string;
};

export type PublicGatewayAbuseProvider = {
  evaluate(input: PublicGatewayAbuseInput): Promise<PublicGatewayAbuseDecision>;
};

export type TurnstileSiteverifyResponse = {
  success?: unknown;
  action?: unknown;
  hostname?: unknown;
  "error-codes"?: unknown;
};

export type TurnstileProviderConfig = {
  secretKey: string;
  timeoutMs: number;
  timeoutReceipt: string;
  expectedAction?: string;
  expectedHostname?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
};

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value;
}

function safeErrorCodes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((code): code is string => typeof code === "string").map((code) => {
    if (code === "timeout-or-duplicate") return "token-reused-or-expired";
    if (code === "missing-input-response" || code === "invalid-input-response") return "token-invalid";
    if (code === "internal-error") return "provider-internal-error";
    return "provider-rejected";
  });
}

function safeProviderFailureClass(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "abort";
  if (error instanceof Error && error.name === "TypeError") return "network-or-runtime";
  if (error instanceof Error && error.name.length > 0) return "provider-call-error";
  return "unknown";
}

function decision(input: Omit<PublicGatewayAbuseDecision, "protocol" | "materialized" | "resultOnly">): PublicGatewayAbuseDecision {
  return {
    protocol: PUBLIC_GATEWAY_ABUSE_PROTOCOL,
    materialized: false,
    resultOnly: true,
    ...input,
  };
}

/**
 * A disabled provider is explicit rather than an accidental allow. The edge
 * Rate Limit binding still runs separately; this adapter only covers bot
 * verification and never grants canonical or private-source authority.
 */
export class DisabledPublicGatewayAbuseProvider implements PublicGatewayAbuseProvider {
  async evaluate(input: PublicGatewayAbuseInput): Promise<PublicGatewayAbuseDecision> {
    required(input.requestId, "requestId");
    return decision({
      provider: "none",
      outcome: "allowed",
      retryable: false,
      reason: "disabled",
      nextAction: "continue to the customer-owned edge tripwire and Durable Object Public Intake ledger",
      receipt: `provider=none; request=${input.requestId}; resultOnly=true; materialized=false; logicalLedger=authoritative`,
    });
  }
}

/**
 * Server-side Turnstile Siteverify adapter. The secret is only sent to the
 * provider and is never included in a decision, receipt, or downstream call.
 * Provider failure is fail-closed and asks for a fresh token because a timed
 * out validation may have been consumed by the provider.
 */
export class TurnstilePublicGatewayAbuseProvider implements PublicGatewayAbuseProvider {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: TurnstileProviderConfig) {
    required(config.secretKey, "secretKey");
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
    required(config.timeoutReceipt, "timeoutReceipt");
    this.endpoint = config.endpoint ?? "https://challenges.cloudflare.com/turnstile/v0/siteverify";
    const endpoint = new URL(this.endpoint);
    if (endpoint.protocol !== "https:") throw new Error("Turnstile Siteverify endpoint must use HTTPS");
    this.fetcher = config.fetcher ?? ((input, init) => fetch(input, init));
  }

  async evaluate(input: PublicGatewayAbuseInput): Promise<PublicGatewayAbuseDecision> {
    required(input.requestId, "requestId");
    const token = input.token?.trim();
    if (!token) {
      return decision({
        provider: "cloudflare-turnstile",
        outcome: "challenge",
        retryable: true,
        reason: "token-missing",
        nextAction: "complete the public contribution challenge and retry with a fresh Turnstile token",
        receipt: `provider=cloudflare-turnstile; request=${input.requestId}; token=missing; materialized=false; failClosed=true`,
      });
    }
    if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) {
      return decision({
        provider: "cloudflare-turnstile",
        outcome: "challenge",
        retryable: true,
        reason: "token-too-long",
        nextAction: "request a fresh Turnstile token within the provider's documented token length and lifetime",
        receipt: `provider=cloudflare-turnstile; request=${input.requestId}; tokenLength=${token.length}; tokenMax=${TURNSTILE_TOKEN_MAX_LENGTH}; materialized=false`,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: this.config.secretKey,
          response: token,
          ...(input.clientIp ? { remoteip: input.clientIp } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return decision({
          provider: "cloudflare-turnstile",
          outcome: "unavailable",
          retryable: true,
          reason: "provider-unavailable",
          nextAction: "retry with a fresh Turnstile token after the provider recovers; no contribution was materialized",
          receipt: `provider=cloudflare-turnstile; request=${input.requestId}; providerStatus=${response.status}; materialized=false; failClosed=true; retryable=true; timeout=${this.config.timeoutMs}; timeoutReceipt=${this.config.timeoutReceipt}`,
        });
      }
      let body: TurnstileSiteverifyResponse;
      try {
        body = await response.json() as TurnstileSiteverifyResponse;
      } catch {
        return decision({
          provider: "cloudflare-turnstile",
          outcome: "unavailable",
          retryable: true,
          reason: "provider-malformed",
          nextAction: "retry with a fresh Turnstile token after inspecting the provider response; no contribution was materialized",
          receipt: `provider=cloudflare-turnstile; request=${input.requestId}; response=malformed; materialized=false; failClosed=true; retryable=true`,
        });
      }
      if (body.success !== true) {
        const codes = safeErrorCodes(body["error-codes"]);
        return decision({
          provider: "cloudflare-turnstile",
          outcome: "challenge",
          retryable: true,
          reason: "token-rejected",
          nextAction: "request a fresh Turnstile token and retry; provider error details remain result-only",
          receipt: `provider=cloudflare-turnstile; request=${input.requestId}; validation=failed; reason=${codes[0] ?? "provider-rejected"}; rawProviderError=not-disclosed; materialized=false`,
        });
      }
      if (this.config.expectedAction && body.action !== this.config.expectedAction || this.config.expectedHostname && body.hostname !== this.config.expectedHostname) {
        return decision({
          provider: "cloudflare-turnstile",
          outcome: "challenge",
          retryable: true,
          reason: "token-mismatch",
          nextAction: "use the configured public contribution widget and retry with a fresh token",
          receipt: `provider=cloudflare-turnstile; request=${input.requestId}; actionOrHostname=unexpected; rawProviderFields=not-disclosed; materialized=false`,
        });
      }
      return decision({
        provider: "cloudflare-turnstile",
        outcome: "allowed",
        retryable: false,
        reason: "validated",
        nextAction: "continue to the customer-owned edge tripwire and Durable Object Public Intake ledger",
        receipt: `provider=cloudflare-turnstile; request=${input.requestId}; validation=passed; resultOnly=true; materialized=false`,
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "AbortError";
      return decision({
        provider: "cloudflare-turnstile",
        outcome: "unavailable",
        retryable: true,
        reason: timedOut ? "provider-timeout" : "provider-unavailable",
        nextAction: "retry with a fresh Turnstile token after the provider recovers; no contribution was materialized",
        receipt: `provider=cloudflare-turnstile; request=${input.requestId}; provider=${timedOut ? "timeout" : "unavailable"}; failureClass=${safeProviderFailureClass(error)}; materialized=false; failClosed=true; retryable=true; timeout=${this.config.timeoutMs}; timeoutReceipt=${this.config.timeoutReceipt}`,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createPublicGatewayAbuseProvider(input: {
  mode: PublicGatewayAbuseMode;
  turnstile?: TurnstileProviderConfig;
}): PublicGatewayAbuseProvider {
  if (input.mode === "edge-only") return new DisabledPublicGatewayAbuseProvider();
  if (!input.turnstile) throw new Error("turnstile configuration is required when PUBLIC_ABUSE_MODE=turnstile-required");
  return new TurnstilePublicGatewayAbuseProvider(input.turnstile);
}
