export function handle(request: Request): Response {
  const url = new URL(request.url);
  return new Response(JSON.stringify({ fixture: "worker", path: url.pathname }), {
    headers: { "content-type": "application/json" },
  });
}
