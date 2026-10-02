import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const repository = resolve(".");
const examples = ["worker-app", "typescript-cli", "hybrid-video-player"];
const receipts = [];
const temporaryRoot = await mkdtemp("/tmp/anyam-example-smoke-");
const commandPath = resolve(repository, "packages/create-anyam/dist/anyam.js");
const commandEnvironment = { ...process.env, PATH: `${resolve(repository, "node_modules/.bin")}:${process.env.PATH ?? ""}` };

try {
  for (const name of examples) {
    const sourceDirectory = resolve(repository, "examples", name);
    const output = execFileSync("npm", ["run", "check"], { cwd: sourceDirectory, encoding: "utf8", env: commandEnvironment });
    const doctorDirectory = resolve(temporaryRoot, name);
    await cp(sourceDirectory, doctorDirectory, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: doctorDirectory });
    const doctor = execFileSync("node", [commandPath, "check", "."], { cwd: doctorDirectory, encoding: "utf8", env: commandEnvironment });
    if (!doctor.includes("Project doctor passed.")) throw new Error(`Anyam doctor did not pass for ${name}`);
    receipts.push({ name, git: "temporary-repository", check: "passed", doctor: "passed", outputBytes: Buffer.byteLength(output, "utf8") });
  }

  const projection = await readFile(resolve(repository, "examples/hybrid-video-player/dist/public-player.js"), "utf8");
  if (/privateCodec|private-codec/.test(projection)) throw new Error("hybrid public projection contains private codec content");

  console.log(JSON.stringify({
    protocol: "anyam.examples-smoke/v1",
    status: "succeeded",
    examples: receipts,
    hybridProjection: "selected-entrypoint-private-markers-absent",
    receipt: "examples=3; git=temporary-repositories; check=typecheck-build-test; doctor=passed; hybrid=two-marker-checks-only; provider=not-run",
  }, null, 2));

} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
