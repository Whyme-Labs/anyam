export const WORKSPACE_REPOSITORY_PROTOCOL = "anyam.workspace-repository/v1" as const;
export type WorkspaceRepositoryInput = {
  workspaceId: string; sourceSpaceId: string; taskId: string; grantId: string;
  sourceRepositoryName: string; targetName: string; baseTreeOid: string;
};
export type WorkspaceRepositoryPath = { workspaceId: string; sourceSpaceId: string } | { malformed: true };
export class WorkspaceRepositoryInputError extends Error {
  constructor() { super("Use the documented Workspace repository identifiers, names, exact SHA-1 tree and current Task/Grant."); }
}
export function workspaceRepositoryPath(pathname: string): WorkspaceRepositoryPath | undefined {
  const parts = pathname.split("/");
  if (parts[1] !== "api" || parts[2] !== "workspaces" || parts[4] !== "repositories") return undefined;
  if (parts.length !== 6) return { malformed: true };
  try {
    const workspaceId = decodeURIComponent(parts[3]!); const sourceSpaceId = decodeURIComponent(parts[5]!);
    if ([workspaceId, sourceSpaceId].some(id => !id.trim() || id === "." || id === ".." || /[/\\\x00-\x20\x7f]/u.test(id))) return { malformed: true };
    return { workspaceId, sourceSpaceId };
  } catch { return { malformed: true }; }
}
export function workspaceRepositoryInput(value: unknown, path?: { workspaceId: string; sourceSpaceId: string }): WorkspaceRepositoryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceRepositoryInputError();
  const body: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const fields = ["taskId", "grantId", "sourceRepositoryName", "targetName", "baseTreeOid", ...(path ? [] : ["workspaceId", "sourceSpaceId"])];
  if (Object.keys(body).some(key => !fields.includes(key))) throw new WorkspaceRepositoryInputError();
  const string = (key: string): string => { const v = body[key]; if (typeof v !== "string" || !v.trim()) throw new WorkspaceRepositoryInputError(); return v.trim(); };
  const request = { workspaceId: path?.workspaceId ?? string("workspaceId"), sourceSpaceId: path?.sourceSpaceId ?? string("sourceSpaceId"), taskId: string("taskId"), grantId: string("grantId"), sourceRepositoryName: string("sourceRepositoryName"), targetName: string("targetName"), baseTreeOid: string("baseTreeOid") };
  if (!/^[0-9a-f]{40}$/u.test(request.baseTreeOid) || [request.sourceRepositoryName, request.targetName].some(name => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(name) || name.includes("..")) || request.sourceRepositoryName === request.targetName) throw new WorkspaceRepositoryInputError();
  return Object.freeze(request);
}

export type WorkspaceObservationInput = { workspaceId: string; sourceSpaceId: string; generation: number; taskId: string; grantId: string; expectedSymbolicRef: string; expectedCommitOid: string; expectedTreeOid?: string };
export type WorkspaceObservationPath = Pick<WorkspaceObservationInput, "workspaceId" | "sourceSpaceId" | "generation"> | { malformed: true };
export function workspaceObservationPath(pathname: string): WorkspaceObservationPath | undefined {
  const parts = pathname.split("/");
  if (parts[1] !== "api" || parts[2] !== "workspaces" || parts[4] !== "repositories" || parts[6] !== "observations") return undefined;
  const base = workspaceRepositoryPath(parts.slice(0, 6).join("/"));
  const generation = Number(parts[7]);
  if (!base || "malformed" in base || parts.length !== 8 || !Number.isSafeInteger(generation) || generation < 1 || String(generation) !== parts[7]) return { malformed: true };
  return { ...base, generation };
}
export function workspaceObservationInput(value: unknown, path?: Pick<WorkspaceObservationInput, "workspaceId" | "sourceSpaceId" | "generation">): WorkspaceObservationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceRepositoryInputError();
  const body: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const fields = ["taskId", "grantId", "expectedSymbolicRef", "expectedCommitOid", "expectedTreeOid", ...(path ? [] : ["workspaceId", "sourceSpaceId", "generation"])];
  if (Object.keys(body).some(key => !fields.includes(key))) throw new WorkspaceRepositoryInputError();
  const string = (key: string): string => { const v = body[key]; if (typeof v !== "string" || !v.trim()) throw new WorkspaceRepositoryInputError(); return v.trim(); };
  const generation = path?.generation ?? body.generation;
  const expectedSymbolicRef = string("expectedSymbolicRef"); const expectedCommitOid = string("expectedCommitOid");
  const expectedTreeOid = body.expectedTreeOid === undefined ? undefined : string("expectedTreeOid");
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 || !/^[0-9a-f]{40}$/u.test(expectedCommitOid) || expectedTreeOid !== undefined && !/^[0-9a-f]{40}$/u.test(expectedTreeOid) || !expectedSymbolicRef.startsWith("refs/heads/") || expectedSymbolicRef.endsWith(".") || expectedSymbolicRef.includes("..") || expectedSymbolicRef.includes("@{") || /[\x00-\x20\x7f~^:?*[\]\\]/u.test(expectedSymbolicRef) || expectedSymbolicRef.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))) throw new WorkspaceRepositoryInputError();
  return Object.freeze({ workspaceId: path?.workspaceId ?? string("workspaceId"), sourceSpaceId: path?.sourceSpaceId ?? string("sourceSpaceId"), generation, taskId: string("taskId"), grantId: string("grantId"), expectedSymbolicRef, expectedCommitOid, ...(expectedTreeOid ? { expectedTreeOid } : {}) });
}
