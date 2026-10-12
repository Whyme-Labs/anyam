import type { AuthorityPlaneSnapshot } from "./authority-plane.ts";
import type { AuthoritySqlHost } from "./authority-sqlite.ts";
import { ARTIFACTS_WORKSPACE_SCHEMA_SQL } from "./artifacts-workspace-store.ts";
import { assertArtifactsWorkspaceSelection, type ArtifactsWorkspaceSelection } from "./artifacts-workspace.ts";
import { parseRepositoryDriverSnapshotManifest, repositoryDriverSnapshotIndexKey } from "../portability/repository-snapshot.ts";
import { scanCredentialMaterial } from "../security/credential-material.ts";

export const ARTIFACTS_RECOVERY_PROTOCOL = "anyam.artifacts-recovery/v1" as const;
export const ARTIFACTS_OBSERVATION_SCHEMA_SQL = "CREATE TABLE IF NOT EXISTS anyam_artifacts_observations (row_key TEXT PRIMARY KEY, manifest TEXT NOT NULL)";
export type ArtifactWorkspaceRecoveryRow = { rowKey: string; accountId: string; namespace: string; targetName: string; repositoryId: string | null; payload: string };
export type ArtifactObservationRecoveryRow = { rowKey: string; manifest: string };
export type ArtifactsRecoverySnapshot = { protocol: typeof ARTIFACTS_RECOVERY_PROTOCOL; schemaVersion: 1; workspaces: ArtifactWorkspaceRecoveryRow[]; observations: ArtifactObservationRecoveryRow[] };
export class ArtifactsRecoveryError extends Error {
  constructor(readonly code: "invalid_snapshot" | "conflict" | "schema_unsupported") { super(`artifact recovery ${code}; retain the complete checkpoint and reconcile metadata before retrying`); }
}
function fail(): never { throw new ArtifactsRecoveryError("invalid_snapshot"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return Object.fromEntries(Object.entries(value));
}
function fields(value: Record<string, unknown>, names: string[]) { if (Object.keys(value).some(key => !names.includes(key))) fail(); }
function text(value: unknown): string { if (typeof value !== "string" || !value || value.trim() !== value) return fail(); return value; }
function decoded(value: string): Record<string, unknown> { return object(JSON.parse(value)); }
function selection(value: unknown): ArtifactsWorkspaceSelection {
  const record = object(value); fields(record, ["projectId", "projectRevisionId", "projectViewId", "workspaceId", "sourceSpaceId", "sourceRepository", "targetName", "baseCommitOid", "baseTreeOid"]);
  const source = object(record.sourceRepository); fields(source, ["accountId", "namespace", "repositoryId", "name"]);
  const result = { projectId: text(record.projectId), projectRevisionId: text(record.projectRevisionId), projectViewId: text(record.projectViewId), workspaceId: text(record.workspaceId), sourceSpaceId: text(record.sourceSpaceId),
    sourceRepository: { accountId: text(source.accountId), namespace: text(source.namespace), repositoryId: text(source.repositoryId), name: text(source.name) }, targetName: text(record.targetName), baseCommitOid: text(record.baseCommitOid), baseTreeOid: text(record.baseTreeOid) };
  assertArtifactsWorkspaceSelection(result, result.sourceRepository.accountId, result.sourceRepository.namespace);
  return result;
}
function canonical(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = object(value); return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function validateBinding(selected: ArtifactsWorkspaceSelection, authority: AuthorityPlaneSnapshot) {
  const workspace = authority.workspaces[selected.workspaceId]; const source = authority.sourceSpaces[selected.sourceSpaceId];
  const project = authority.projects[selected.projectId]; const revision = authority.projectRevisions[selected.projectRevisionId]; const view = authority.projectViews[selected.projectViewId];
  if (!workspace || !source || !project || !revision || !view || workspace.projectId !== selected.projectId || workspace.projectRevisionId !== selected.projectRevisionId || workspace.projectViewId !== selected.projectViewId || revision.projectId !== selected.projectId || view.projectId !== selected.projectId || view.projectRevisionId !== selected.projectRevisionId || !project.sourceSpaceIds.includes(selected.sourceSpaceId) || !view.visibleSourceSpaceIds.includes(selected.sourceSpaceId) || revision.sourceSpaceSnapshots[selected.sourceSpaceId] !== selected.baseCommitOid || view.disclosedSourceSpaceSnapshots[selected.sourceSpaceId] !== selected.baseCommitOid || !workspace.mounts.some(mount => mount.sourceSpaceId === selected.sourceSpaceId && mount.snapshotId === selected.baseCommitOid) || source.repositoryId !== `repository:artifacts:${selected.sourceRepository.accountId}:${selected.sourceRepository.namespace}:${selected.sourceRepository.repositoryId}`) fail();
}
function workspaceRow(value: unknown, authority: AuthorityPlaneSnapshot, containsKnownCredentialMaterial: (value: unknown) => boolean): { row: ArtifactWorkspaceRecoveryRow; selected: ArtifactsWorkspaceSelection; bindingId?: string } {
  const row = object(value); fields(row, ["rowKey", "accountId", "namespace", "targetName", "repositoryId", "payload"]);
  const repositoryId = row.repositoryId === null ? null : text(row.repositoryId);
  const result = { rowKey: text(row.rowKey), accountId: text(row.accountId), namespace: text(row.namespace), targetName: text(row.targetName), repositoryId, payload: text(row.payload) };
  const record = decoded(result.payload); fields(record, ["selection", "context", "tokenIds", "blocked", "unknownTokenInventory", "pendingOperation"]);
  if (scanCredentialMaterial(record) || containsKnownCredentialMaterial(record) || !Array.isArray(record.tokenIds) || record.tokenIds.some(id => typeof id !== "string" || !id) || new Set(record.tokenIds).size !== record.tokenIds.length || typeof record.blocked !== "boolean" || typeof record.unknownTokenInventory !== "boolean" || typeof record.pendingOperation !== "string" || !["none", "fork", "mint"].includes(record.pendingOperation)) fail();
  const selected = selection(record.selection); validateBinding(selected, authority);
  if (result.rowKey !== JSON.stringify([selected.sourceRepository.accountId, selected.sourceRepository.namespace, selected.workspaceId, selected.sourceSpaceId]) || result.accountId !== selected.sourceRepository.accountId || result.namespace !== selected.sourceRepository.namespace || result.targetName !== selected.targetName) fail();
  if (record.context === undefined) {
    if (repositoryId !== null || record.pendingOperation === "mint") fail();
    return { row: result, selected };
  }
  const context = object(record.context); fields(context, ["selection", "repository", "binding", "storage", "canonicalPublication"]);
  const repo = object(context.repository); fields(repo, ["accountId", "namespace", "repositoryId", "name", "remote"]);
  const binding = object(context.binding); fields(binding, ["source", "repositoryId", "sourceSpaceId", "workspaceId"]);
  const uuid = text(repo.repositoryId); const remote = `https://${result.accountId}.artifacts.cloudflare.net/git/${result.namespace}/${result.targetName}.git`;
  const bindingId = `repository:artifacts:${[result.accountId, result.namespace, uuid].map(encodeURIComponent).join(":")}`;
  if (canonical(selection(context.selection)) !== canonical(selected) || repo.accountId !== result.accountId || repo.namespace !== result.namespace || repo.name !== result.targetName || uuid === selected.sourceRepository.repositoryId || repo.remote !== remote || binding.source !== remote || binding.repositoryId !== bindingId || binding.sourceSpaceId !== selected.sourceSpaceId || binding.workspaceId !== selected.workspaceId || repositoryId !== bindingId || context.storage !== "sqlite-contract" || context.canonicalPublication !== "unqualified") fail();
  return { row: result, selected, bindingId };
}
/** Validate decoded metadata as well as its raw SQL bytes. Raw JSON is retained
 * so an immutable journal generation cannot be reformatted during recovery. */
export function parseArtifactsRecoverySnapshot(value: unknown, authority: AuthorityPlaneSnapshot, containsKnownCredentialMaterial: (value: unknown) => boolean = () => false): ArtifactsRecoverySnapshot | undefined {
  try {
    const input = object(value); fields(input, ["protocol", "schemaVersion", "workspaces", "observations"]);
    if (input.protocol !== ARTIFACTS_RECOVERY_PROTOCOL || input.schemaVersion !== 1 || !Array.isArray(input.workspaces) || !Array.isArray(input.observations) || scanCredentialMaterial(input) || containsKnownCredentialMaterial(input)) return undefined;
    const workspaces = input.workspaces.map(row => workspaceRow(row, authority, containsKnownCredentialMaterial));
    for (const keys of [workspaces.map(item => item.row.rowKey), workspaces.map(item => JSON.stringify([item.row.accountId, item.row.namespace, item.row.targetName])), workspaces.flatMap(item => item.bindingId ? [item.bindingId] : [])]) if (new Set(keys).size !== keys.length) fail();
    const observations: ArtifactObservationRecoveryRow[] = [];
    for (const value of input.observations) {
      const row = object(value); fields(row, ["rowKey", "manifest"]);
      const rowKey = text(row.rowKey); const manifestText = text(row.manifest); const raw = decoded(manifestText);
      fields(raw, ["protocol", "repositoryId", "sourceSpaceId", "context", "objectFormat", "symbolicRef", "commitOid", "treeOid", "baseCommitOid", "ancestorCommitOids", "generation", "state", "observedAt", "expiresAt", "receipt"]);
      const context = object(raw.context); fields(context, ["kind", "workspaceId", "projectViewId", "workspaceRef"]);
      const manifest = parseRepositoryDriverSnapshotManifest(raw);
      if (!manifest || scanCredentialMaterial(raw) || containsKnownCredentialMaterial(raw) || manifest.context.kind !== "workspace" || manifest.objectFormat !== "sha1" || new Set(manifest.ancestorCommitOids).size !== manifest.ancestorCommitOids.length || !manifest.ancestorCommitOids.includes(manifest.commitOid) || !manifest.ancestorCommitOids.includes(manifest.baseCommitOid)) fail();
      const workspaceContext = manifest.context;
      const bound = workspaces.find(item => item.selected.workspaceId === workspaceContext.workspaceId && item.selected.sourceSpaceId === manifest.sourceSpaceId && item.selected.projectViewId === workspaceContext.projectViewId);
      if (!bound?.bindingId || manifest.repositoryId !== authority.sourceSpaces[manifest.sourceSpaceId]?.repositoryId || manifest.baseCommitOid !== bound.selected.baseCommitOid || !manifest.receipt.split(";").some(part => part.trim() === `workspaceRepository=${bound.bindingId}`)) fail();
      const key: unknown = JSON.parse(rowKey);
      if (!Array.isArray(key) || key.length !== 3 || typeof key[0] !== "string" || key[1] !== manifest.sourceSpaceId || key[2] !== manifest.generation || rowKey !== JSON.stringify(key)) fail();
      const suffix = repositoryDriverSnapshotIndexKey("", manifest.repositoryId, manifest.context).slice(1);
      if (!key[0].endsWith(suffix)) fail();
      const prefix = key[0].slice(0, -suffix.length);
      if (!prefix || !prefix.endsWith("/") || repositoryDriverSnapshotIndexKey(prefix, manifest.repositoryId, manifest.context) !== key[0]) fail();
      observations.push({ rowKey, manifest: manifestText });
    }
    if (new Set(observations.map(row => row.rowKey)).size !== observations.length) fail();
    const sort = <T extends { rowKey: string }>(rows: T[]) => rows.sort((a, b) => a.rowKey < b.rowKey ? -1 : a.rowKey > b.rowKey ? 1 : 0);
    return { protocol: ARTIFACTS_RECOVERY_PROTOCOL, schemaVersion: 1, workspaces: sort(workspaces.map(item => item.row)), observations: sort(observations) };
  } catch { return undefined; }
}
export async function artifactsRecoverySnapshotDigest(snapshot: ArtifactsRecoverySnapshot): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(snapshot)));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
export class ArtifactsRecoveryStore {
  constructor(private readonly host: AuthoritySqlHost, private readonly containsKnownCredentialMaterial: (value: unknown) => boolean = () => false) {}
  capture(authority: AuthorityPlaneSnapshot): ArtifactsRecoverySnapshot {
    const exists = (table: string, expected: string[], unique: string[][]) => {
      if (!this.host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length) return false;
      const columns = this.host.sql.exec<{ name: string; type: string; pk: number; required: number }>('SELECT name, type, pk, "notnull" AS required FROM pragma_table_info(?)', table).toArray();
      const names = columns.map(row => row.name).sort();
      if (JSON.stringify(names) !== JSON.stringify([...expected].sort()) || columns.some(row => row.type.toUpperCase() !== "TEXT" || row.pk !== (row.name === "row_key" ? 1 : 0) || row.required !== (["row_key", "repository_id"].includes(row.name) ? 0 : 1))) throw new ArtifactsRecoveryError("schema_unsupported");
      const indices = this.host.sql.exec<{ name: string; partial: number }>('SELECT name, partial FROM pragma_index_list(?) WHERE "unique" = 1', table).toArray();
      if (indices.some(index => index.partial !== 0)) throw new ArtifactsRecoveryError("schema_unsupported");
      const actual = indices.map(index => this.host.sql.exec<{ name: string }>('SELECT name FROM pragma_index_info(?) ORDER BY seqno', index.name).toArray().map(row => row.name).sort());
      if (canonical(actual.sort((a, b) => canonical(a).localeCompare(canonical(b)))) !== canonical(unique.map(columns => [...columns].sort()).sort((a, b) => canonical(a).localeCompare(canonical(b))))) throw new ArtifactsRecoveryError("schema_unsupported");
      return true;
    };
    const workspaces = exists("anyam_artifacts_workspaces", ["row_key", "account_id", "namespace", "target_name", "repository_id", "payload"], [["row_key"], ["repository_id"], ["account_id", "namespace", "target_name"]]) ? this.host.sql.exec<ArtifactWorkspaceRecoveryRow>("SELECT row_key AS rowKey, account_id AS accountId, namespace, target_name AS targetName, repository_id AS repositoryId, payload FROM anyam_artifacts_workspaces ORDER BY row_key").toArray() : [];
    const observations = exists("anyam_artifacts_observations", ["row_key", "manifest"], [["row_key"]]) ? this.host.sql.exec<ArtifactObservationRecoveryRow>("SELECT row_key AS rowKey, manifest FROM anyam_artifacts_observations ORDER BY row_key").toArray() : [];
    const result = parseArtifactsRecoverySnapshot({ protocol: ARTIFACTS_RECOVERY_PROTOCOL, schemaVersion: 1, workspaces, observations }, authority, this.containsKnownCredentialMaterial);
    if (!result) throw new ArtifactsRecoveryError("invalid_snapshot");
    return result;
  }
  restore(value: unknown, options: { currentAuthority: AuthorityPlaneSnapshot; targetAuthority: AuthorityPlaneSnapshot }): void {
    const incoming = parseArtifactsRecoverySnapshot(value, options.targetAuthority, this.containsKnownCredentialMaterial);
    if (!incoming) throw new ArtifactsRecoveryError("invalid_snapshot");
    this.host.transactionSync(() => {
      const current = this.capture(options.currentAuthority);
      // Artifact operations do not increment Authority version. Never erase a
      // newer reservation, revocation, pending effect or immutable generation.
      for (const field of ["workspaces", "observations"] as const) for (const row of current[field]) {
        const target = incoming[field].find(candidate => candidate.rowKey === row.rowKey);
        if (!target || canonical(target) !== canonical(row)) throw new ArtifactsRecoveryError("conflict");
      }
      if (incoming.workspaces.length) this.host.sql.exec(ARTIFACTS_WORKSPACE_SCHEMA_SQL);
      if (incoming.observations.length) this.host.sql.exec(ARTIFACTS_OBSERVATION_SCHEMA_SQL);
      for (const row of incoming.workspaces) this.host.sql.exec("INSERT INTO anyam_artifacts_workspaces (row_key, account_id, namespace, target_name, repository_id, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", row.rowKey, row.accountId, row.namespace, row.targetName, row.repositoryId, row.payload);
      for (const row of incoming.observations) this.host.sql.exec("INSERT INTO anyam_artifacts_observations (row_key, manifest) VALUES (?, ?) ON CONFLICT DO NOTHING", row.rowKey, row.manifest);
      if (canonical(this.capture(options.targetAuthority)) !== canonical(incoming)) throw new ArtifactsRecoveryError("conflict");
    });
  }
}
