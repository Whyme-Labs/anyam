import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTRACT_VERSIONS, createProject, createProjectRevision } from "../../src/kernel/contracts.ts";
import { createPublicProjection } from "../../src/disclosure/hybrid.ts";
import { isolatedGitEnvironment } from "../../scripts/experiments/git-environment.ts";

export async function gitBytes(directory: string, args: readonly string[], input?: Uint8Array) {
  return new Promise<{ code: number; stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn("git", [...args], { cwd: directory, env: {
      ...isolatedGitEnvironment(),
      GIT_AUTHOR_NAME: "Disclosure fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Disclosure fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "2026-10-13T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-13T00:00:00Z",
    } });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b)); child.stderr.on("data", (b: Buffer) => err.push(b));
    child.once("error", reject); child.stdin.on("error", reject);
    child.once("close", code => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(input);
  });
}

export async function gitText(directory: string, args: readonly string[]) {
  const r = await gitBytes(directory, args);
  if (r.code !== 0) throw new Error(`fixture Git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.toString().trim();
}

export function packet(value: string): Buffer {
  const b = Buffer.from(value); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, "0")), b]);
}

/** Real stateless upload-pack request; deliberately permits known-OID requests
 * in owned fixtures so object separation, rather than server hiding, is tested. */
export function fetchKnownObject(directory: string, oid: string, serverConfiguration: readonly string[] = []) {
  return gitBytes(directory, [...serverConfiguration, "-c", "uploadpack.allowAnySHA1InWant=true", "upload-pack", "--stateless-rpc", "."],
    Buffer.concat([packet(`want ${oid}\n`), Buffer.from("0000"), packet("done\n")]));
}

export async function disclosureFixture() {
  const root = await mkdtemp(join(tmpdir(), "anyam-git-disclosure-"));
  const canonical = join(root, "canonical"), publicRepository = join(root, "public");
  try {
    await gitText(root, ["init", "--initial-branch=main", canonical]);
    const publicFiles = { "player.ts": "export const publicPlayer = true;\n", "README.md": "Public fixture\n" };
    for (const [name, content] of Object.entries(publicFiles)) await writeFile(join(canonical, name), content);
    await writeFile(join(canonical, "private-codec.ts"), "synthetic-private-codec-sentinel\n");
    await gitText(canonical, ["add", "."]); await gitText(canonical, ["commit", "-m", "private-only-parent"]);
    const privateCommit = await gitText(canonical, ["rev-parse", "HEAD"]);
    const privateTree = await gitText(canonical, ["rev-parse", "HEAD^{tree}"]);
    const privateBlob = await gitText(canonical, ["rev-parse", "HEAD:private-codec.ts"]);
    await gitText(canonical, ["tag", "-a", "private-release", "-m", "private-tag-sentinel"]);
    const privateTag = await gitText(canonical, ["rev-parse", "refs/tags/private-release"]);
    await gitText(canonical, ["branch", "private-internal", privateCommit]);
    await rm(join(canonical, "private-codec.ts")); await gitText(canonical, ["add", "-u"]);
    await gitText(canonical, ["commit", "-m", "canonical-public-tip"]);
    // Public snapshot identity is content-derived, not the mixed canonical
    // commit whose parent graph contains private history.
    const publicSnapshot = await gitText(canonical, ["rev-parse", "HEAD^{tree}"]);
    const project = createProject({ id: "project:git-disclosure", name: "Public fixture", referenceType: "hybrid-public-private", sourceSpaceIds: ["public-player", "private-codec"] });
    const canonicalRevision = createProjectRevision({ id: "revision:private-canonical", projectId: project.id, sourceSpaceSnapshots: { "public-player": publicSnapshot, "private-codec": privateCommit } });
    const projection = createPublicProjection({ project, canonicalRevision,
      sourceSpaces: [{ protocol: CONTRACT_VERSIONS.sourceSpace, id: "public-player", name: "Player", classification: "public" }, { protocol: CONTRACT_VERSIONS.sourceSpace, id: "private-codec", name: "Private codec", classification: "restricted" }],
      publicSourceSpaceIds: ["public-player"], sources: [{ sourceSpaceId: "public-player", snapshotId: publicSnapshot, files: publicFiles }, { sourceSpaceId: "private-codec", snapshotId: privateCommit, files: { "private-codec.ts": "synthetic-private-codec-sentinel\n" } }],
    });
    // Exercise the actual materializer/driver in an isolated child: the driver
    // inherits its process environment, which must not select another repo.
    const commitId = await new Promise<string>((done, reject) => {
      const code = `import {materializePublicProjection} from ${JSON.stringify(new URL("../../src/disclosure/hybrid.ts", import.meta.url).href)};
        import {LocalGitRepositoryDriver} from ${JSON.stringify(new URL("../../src/portability/local-git.ts", import.meta.url).href)};
        let text='';for await(const chunk of process.stdin)text+=chunk;
        const input=JSON.parse(text);const result=await materializePublicProjection({projection:input.projection,driver:new LocalGitRepositoryDriver(input.root),destination:input.destination,author:{name:'Public fixture',email:'public@example.invalid'}});
        process.stdout.write(result.commitId);`;
      const child = spawn(process.execPath, ["--import", new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href, "--input-type=module", "--eval", code], { cwd: root, env: { ...isolatedGitEnvironment(), GIT_AUTHOR_DATE: "2026-10-13T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-13T00:00:00Z" } });
      let output = ""; child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); }); child.stderr.resume(); child.once("error", reject); child.stdin.on("error", reject);
      child.once("close", status => status === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(output) ? done(output) : reject(new Error("isolated public materializer failed")));
      child.stdin.end(JSON.stringify({ projection, root, destination: publicRepository }));
    });
    const published = { commitId };
    await gitText(publicRepository, ["branch", "-M", "main"]);
    await gitText(publicRepository, ["tag", "-a", "public-v1", "-m", "curated public release"]);
    return { root, canonical, publicRepository, published, privateCommit, privateTree, privateBlob, privateTag, privateObjectIds: [privateCommit, privateTree, privateBlob, privateTag], dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
