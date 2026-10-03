import type { ArtifactsCommit, ArtifactsNamespace, ArtifactsRepository, ArtifactsRepositoryInfo, ArtifactsWorkspaceSelection } from "../../src/cloudflare/artifacts-workspace.ts";

export const artifactsClock = Date.parse("2026-10-02T12:00:00Z");
export const artifactsSelection: ArtifactsWorkspaceSelection = {
  projectId: "project:test", projectRevisionId: "revision:base", projectViewId: "view:a", workspaceId: "workspace:a", sourceSpaceId: "source:app",
  sourceRepository: { accountId: "account-a", namespace: "private", repositoryId: "uuid-source", name: "source" },
  targetName: "workspace-a", baseCommitOid: "1".repeat(40), baseTreeOid: "2".repeat(40),
};
export function artifactsBindingFixture() {
  const events: string[] = [];
  const infos = new Map<string, ArtifactsRepositoryInfo>();
  const commits = new Map<string, ArtifactsCommit | null>();
  const heads = new Map<string, ArtifactsCommit[]>();
  const activeTokens = new Set<string>();
  const fixture = {
    events, infos, commits, heads, activeTokens,
    afterFork: undefined as (() => void) | undefined,
    afterMint: undefined as (() => void) | undefined,
    revokeSucceeds: true,
    forkFails: false,
    forkedRepositoryId: undefined as string | undefined,
    mintFails: false,
    unavailableName: undefined as string | undefined,
    mintedCount: 0,
    returnedScope: undefined as "read" | "write" | undefined,
    tokenExpiresAt: undefined as string | undefined,
    granted: true,
    now: artifactsClock,
    async authorize() { events.push("authorize"); if (!fixture.granted) throw new Error("grant revoked"); return { expiresAt: new Date(artifactsClock + 600_000).toISOString() }; },
    binding: undefined as unknown as ArtifactsNamespace,
  };
  const remote = (name: string) => `https://account-a.artifacts.cloudflare.net/git/private/${name}.git`;
  infos.set("source", { id: "uuid-source", name: "source", defaultBranch: "main", remote: remote("source"), readOnly: true });
  const base = { hash: artifactsSelection.baseCommitOid, treeHash: artifactsSelection.baseTreeOid };
  commits.set("source", base); heads.set("source", [base]);
  fixture.binding = { async get(name) {
    events.push(`get:${name}`);
    if (fixture.unavailableName === name) throw new Error("provider error contains usable-secret");
    if (!infos.has(name)) throw new Error("NOT_FOUND");
    const repo: ArtifactsRepository = {
      [Symbol.dispose]() { events.push(`dispose:${name}`); },
      async info() { events.push(`info:${name}`); return { ...infos.get(name)! }; },
      async fork(target, options) {
        events.push(`fork:${name}:${target}:${options.defaultBranchOnly}:${options.readOnly}`);
        if (fixture.forkFails) throw new Error("lost provider reply with secret data");
        const info = { id: fixture.forkedRepositoryId ?? `uuid-${target}`, name: target, defaultBranch: "main", remote: remote(target), readOnly: options.readOnly };
        infos.set(target, info); commits.set(target, commits.get(name)!); heads.set(target, [...heads.get(name)!]);
        const token = `initial-secret-${target}`; activeTokens.add(token);
        const result = { ...info, token };
        fixture.afterFork?.();
        return result;
      },
      async readCommit(hash) { events.push(`commit:${name}:${hash}`); return commits.get(name) ?? null; },
      async log(options) { events.push(`head:${name}:${options.ref}:${options.limit}`); return heads.get(name) ?? []; },
      async createToken(scope, ttl) {
        events.push(`mint:${name}:${scope}:${ttl}`);
        const id = `token-id-${fixture.mintedCount++}`; activeTokens.add(id);
        const result = { id, plaintext: `usable-secret-${id}`, scope: fixture.returnedScope ?? scope, expiresAt: fixture.tokenExpiresAt ?? new Date(fixture.now + ttl * 1000).toISOString() };
        fixture.afterMint?.();
        if (fixture.mintFails) throw new Error("unknown token effect with usable-secret");
        return result;
      },
      async revokeToken(value) { events.push(`revoke:${name}`); if (!fixture.revokeSucceeds) return false; return activeTokens.delete(value); },
    };
    return repo;
  } };
  return fixture;
}
