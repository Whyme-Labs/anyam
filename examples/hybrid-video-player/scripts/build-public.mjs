import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as ts from "typescript";

const source = await readFile("public-player/src/index.ts", "utf8");
if (source.includes("private-codec") || source.includes("privateCodec")) {
  throw new Error("public projection contains private codec content");
}

await mkdir("dist", { recursive: true });
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
await writeFile("dist/public-player.js", output, "utf8");
