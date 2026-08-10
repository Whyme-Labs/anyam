/// <reference types="@cloudflare/workers-types" />

const PROTOCOL = "anyam.customer-provider-operation/v1" as const;

function response(operationId: string): Response {
  return new Response(JSON.stringify({ protocol: PROTOCOL, operationId, status: "accepted", target: "disposable-worker" }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const operationId = request.method === "GET" ? url.searchParams.get("operationId") : undefined;
    if (request.method === "GET" && operationId) return response(operationId);
    if (request.method !== "POST") return new Response("method_not_allowed", { status: 405 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || body.protocol !== PROTOCOL || typeof body.operationId !== "string" || body.operationId.length === 0) return new Response("invalid_qualification_request", { status: 422 });
    return response(body.operationId);
  },
};
