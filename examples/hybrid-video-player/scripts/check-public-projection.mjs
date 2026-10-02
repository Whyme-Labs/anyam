import { readFile } from "node:fs/promises";

const publicSource = await readFile("public-player/src/index.ts", "utf8");
const privateSource = await readFile("private-codec/src/codec.ts", "utf8");
if (!publicSource.includes("playerLabel")) throw new Error("public player entrypoint is missing");
if (!privateSource.includes("privateCodecLabel")) throw new Error("private codec entrypoint is missing");
if (publicSource.includes("privateCodec") || publicSource.includes("private-codec")) {
  throw new Error("public source names the private codec");
}
