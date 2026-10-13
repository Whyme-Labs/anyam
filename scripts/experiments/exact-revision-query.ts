/** Local read experiment only. No production route or RepositoryDriver change. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { SmartHttpCredentialValidator } from "../../src/portability/smart-http.ts";
import { isolatedGitEnvironment } from "./git-environment.ts";

class ExactCommit {
  private constructor(readonly value: string) {}
  static parse(value: unknown): ExactCommit | undefined {
    return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ? new ExactCommit(value) : undefined;
  }
}

export type QueryRepository = { repositoryId: string; sourceSpaceId: string; directory: string };
export type ExactQueryConfig = {
  repositories: readonly QueryRepository[];
  credentials: SmartHttpCredentialValidator;
  /** Current Source authority; a historical exact revision grants no access. */
  authorizeCurrentRead: (repository: QueryRepository) => Promise<boolean>;
  /** Operator-only benchmark instrumentation; never part of the response. */
  runGit?: typeof readGit;
};

export async function readGit(directory: string, args: readonly string[]) {
  return new Promise<{ code: number; stdout: Buffer }>((resolve, reject) => {
    const p = spawn("git", [...args], { cwd: directory, env: isolatedGitEnvironment() });
    const chunks: Buffer[] = []; p.stdout.on("data", (b: Buffer) => chunks.push(b));
    p.stderr.resume(); p.once("error", reject); p.once("close", code => resolve({ code: code ?? 1, stdout: Buffer.concat(chunks) })); p.stdin.end();
  });
}

/** -z paths remain byte-exact even for non-UTF8 Git filenames. No rename
 * inference, patch generation, attributes, external diff or textconv executes. */
export async function changedPaths(directory: string, base: string, head: string, git = readGit): Promise<readonly string[] | undefined> {
  const from = ExactCommit.parse(base), to = ExactCommit.parse(head);
  if (!from || !to || from.value.length !== to.value.length) return undefined;
  for (const commit of [from, to]) {
    const type = await git(directory, ["cat-file", "-t", commit.value]);
    if (type.code !== 0 || type.stdout.toString().trim() !== "commit") return undefined;
  }
  const diff = await git(directory, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", from.value, to.value, "--"]);
  if (diff.code !== 0) return undefined;
  if (diff.stdout.length === 0) return [];
  if (diff.stdout.at(-1) !== 0) return undefined;
  const paths: string[] = []; let start = 0;
  for (let i = 0; i < diff.stdout.length; i++) {
    if (diff.stdout[i] === 0) { paths.push(diff.stdout.subarray(start, i).toString("base64")); start = i + 1; }
  }
  return paths;
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const unavailable = () => json({ status: "not_found" }, 404);

export async function handleExactRevisionQuery(request: Request, config: ExactQueryConfig): Promise<Response> {
  if (request.method !== "POST") return json({ status: "invalid_request" }, 405);
  let value: unknown;
  try { value = await request.json(); } catch { return json({ status: "invalid_request" }, 400); }
  if (!value || typeof value !== "object" || !("repositoryId" in value) || typeof value.repositoryId !== "string" || !("base" in value) || !("head" in value)) return json({ status: "invalid_request" }, 400);
  const base = ExactCommit.parse(value.base), head = ExactCommit.parse(value.head);
  if (!base || !head || base.value.length !== head.value.length) return json({ status: "invalid_request" }, 400);
  const repository = config.repositories.find(r => r.repositoryId === value.repositoryId);
  if (!repository) return unavailable();
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return unavailable();
  const token = authorization.slice(7);
  const currentAuthority = async () => {
    const grant = await config.credentials.validate(token, { repositoryId: repository.repositoryId, sourceSpaceId: repository.sourceSpaceId, operation: "read" });
    return grant.valid && await config.authorizeCurrentRead(repository);
  };
  try {
    if (!await currentAuthority()) return unavailable();
    const paths = await changedPaths(repository.directory, base.value, head.value, config.runGit);
    // Revalidate before releasing a result, including warm/repeated reads.
    if (!await currentAuthority() || paths === undefined) return unavailable();
    const result = { protocol: "anyam.experiment.changed-paths/v1", repositoryId: repository.repositoryId, sourceSpaceId: repository.sourceSpaceId, base: base.value, head: head.value, pathEncoding: "base64", changedPaths: paths };
    return json({ ...result, digest: `sha256:${createHash("sha256").update(JSON.stringify(result)).digest("hex")}` }, 200);
  } catch { return unavailable(); }
}
