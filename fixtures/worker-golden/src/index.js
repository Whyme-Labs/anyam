import { helperValue } from "./helper.js";

export class GoldenObject {
  constructor(state) {
    this.state = state;
  }

  async fetch() {
    const count = (await this.state.storage.get("count")) ?? 0;
    const next = count + 1;
    await this.state.storage.put("count", next);
    return new Response(JSON.stringify({ object: "golden", count: next }));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "healthy", releaseId: env.ANYAM_RELEASE_ID ?? "missing", helper: helperValue }));
    }
    return new Response(JSON.stringify({ fixture: "worker-golden", path: url.pathname }));
  },

  async queue(batch, env) {
    for (const message of batch.messages) await env.DB.prepare("INSERT INTO golden_events (id) VALUES (?)").bind(message.id).run();
  },

  async scheduled(_controller, env) {
    await env.CACHE.put("last-scheduled", new Date().toISOString());
  },
};
