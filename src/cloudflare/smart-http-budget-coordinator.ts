import type { SmartHttpBudgetCoordinator, SmartHttpBudgetLease, SmartHttpOperation } from "../portability/smart-http.ts";

export const SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL = "anyam.smart-http-budget-coordinator/v1" as const;

export type SmartHttpBudgetCoordinatorFetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

function json(value: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class DurableSmartHttpBudgetCoordinator implements SmartHttpBudgetCoordinator {
  constructor(private readonly fetcher: SmartHttpBudgetCoordinatorFetcher, private readonly coordinatorPath = "/acquire") {}

  async acquire(input: { operation: SmartHttpOperation; limit: number; leaseTtlMs: number; receipt: string }): Promise<SmartHttpBudgetLease | undefined> {
    const leaseId = `git-lease:${crypto.randomUUID()}`;
    const response = await this.fetcher.fetch(`https://anyam-smart-http-budget${this.coordinatorPath}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL, operation: input.operation, limit: input.limit, leaseTtlMs: input.leaseTtlMs, leaseId, receipt: input.receipt }) });
    if (response.status === 429) return undefined;
    if (!response.ok) throw new Error(`Smart HTTP durable concurrency coordinator returned HTTP ${response.status}`);
    const payload = record(await response.json().catch(() => undefined));
    if (!payload || payload.status !== "acquired" || payload.leaseId !== leaseId) throw new Error("Smart HTTP durable concurrency coordinator returned an invalid lease receipt");
    let released = false;
    return {
      id: leaseId,
      release: () => {
        if (released) return;
        released = true;
        void this.fetcher.fetch("https://anyam-smart-http-budget/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL, leaseId }) }).catch(() => undefined);
      },
    };
  }
}

export type SmartHttpBudgetLeaseRecord = {
  protocol: typeof SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL;
  leaseId: string;
  operation: SmartHttpOperation;
  expiresAt: string;
  receipt: string;
};

export type SmartHttpBudgetCoordinatorState = {
  protocol: typeof SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL;
  leases: Record<string, SmartHttpBudgetLeaseRecord>;
};

export function emptySmartHttpBudgetCoordinatorState(): SmartHttpBudgetCoordinatorState {
  return { protocol: SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL, leases: {} };
}

export async function handleSmartHttpBudgetCoordinatorRequest(input: {
  request: Request;
  state: SmartHttpBudgetCoordinatorState;
  now?: () => number;
}): Promise<{ response: Response; state: SmartHttpBudgetCoordinatorState }> {
  const now = input.now ?? (() => Date.now());
  const state = input.state.protocol === SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL ? input.state : emptySmartHttpBudgetCoordinatorState();
  for (const [leaseId, lease] of Object.entries(state.leases)) if (Date.parse(lease.expiresAt) <= now()) delete state.leases[leaseId];
  if (input.request.method !== "POST") return { response: json({ protocol: SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL, status: "blocked", code: "method_not_allowed", receipt: "coordinator=lease; mutation=not-accepted" }, 405), state };
  const body = record(await input.request.json().catch(() => undefined));
  if (!body || body.protocol !== SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL) return { response: json({ protocol: SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL, status: "blocked", code: "protocol_invalid", receipt: "coordinator=lease; protocol=invalid; mutation=not-accepted" }, 422), state };
  const path = new URL(input.request.url).pathname;
  const leaseId = typeof body.leaseId === "string" ? body.leaseId.trim() : "";
  if (path === "/release") {
    if (!leaseId) return { response: json({ protocol: SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL, status: "blocked", code: "lease_id_required", receipt: "coordinator=release; lease=missing" }, 422), state };
    delete state.leases[leaseId];
    return { response: json({ protocol: SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL, status: "released", leaseId, receipt: "coordinator=release; idempotent=true" }, 200), state };
  }
  if (path !== "/acquire") return { response: json({ protocol: SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL, status: "blocked", code: "not_found", receipt: "coordinator=route-not-found" }, 404), state };
  const operation = body.operation === "read" || body.operation === "write" ? body.operation : undefined;
  const limit = typeof body.limit === "number" ? body.limit : Number(body.limit);
  const leaseTtlMs = typeof body.leaseTtlMs === "number" ? body.leaseTtlMs : Number(body.leaseTtlMs);
  const receipt = typeof body.receipt === "string" ? body.receipt.trim() : "";
  if (!operation || !Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0 || !leaseId || !/(?:receipt|measure|qualification)/iu.test(receipt)) return { response: json({ protocol: SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL, status: "blocked", code: "lease_request_invalid", recoveryAction: "send operation, positive limit, positive leaseTtlMs, leaseId, and a measured receipt", receipt: "coordinator=acquire; budget=lease-request; limit=positive-safe-integer; asked=invalid" }, 422), state };
  const active = Object.values(state.leases).filter((lease) => lease.operation === operation).length;
  if (active >= limit) return { response: json({ protocol: SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL, status: "blocked", code: "concurrency_exceeded", recoveryAction: "retry after an existing Smart HTTP stream closes or is released", receipt: `coordinator=acquire; operation=${operation}; budget=concurrentRequests; limit=${limit}; asked=${active + 1}; scope=durable-coordinator; ${receipt}` }, 429), state };
  const expiresAt = new Date(now() + leaseTtlMs).toISOString();
  state.leases[leaseId] = { protocol: SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL, leaseId, operation, expiresAt, receipt };
  return { response: json({ protocol: SMART_HTTP_BUDGET_COORDINATOR_PROTOCOL, status: "acquired", leaseId, operation, expiresAt, receipt: `coordinator=acquire; scope=durable-coordinator; active=${active + 1}; ${receipt}` }, 201), state };
}
