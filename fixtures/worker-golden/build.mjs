import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist/assets", { recursive: true });
await mkdir("dist/migrations", { recursive: true });
await copyFile("src/index.js", "dist/index.js");
await copyFile("src/helper.js", "dist/helper.js");
await copyFile("assets/index.html", "dist/assets/index.html");
await copyFile("migrations/0001-add-region.sql", "dist/migrations/0001-add-region.sql");
