export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return new Response(JSON.stringify({ service: "anyam-example-worker", status: "ok" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Anyam example Worker\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
