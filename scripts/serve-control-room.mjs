import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// PROTOTYPE ONLY: local static server for the Wayfinder control-room prototype.
const root = fileURLToPath(new URL("../prototype/credible-team-control-room/", import.meta.url));
const port = Number(process.env.PORT ?? "4321");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (request, response) => {
  const requested = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const file = normalize(join(root, relative));
  if (!file.startsWith(root)) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("invalid prototype path");
    return;
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, {
      "content-type": mime[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("prototype file not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Anyam control-room prototype: http://127.0.0.1:${port}/?variant=A&role=team`);
});
