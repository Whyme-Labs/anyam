import type { AuthoritySqlHost } from "./authority-sqlite.ts";
import type { ArtifactsWorkspaceContext, ArtifactsWorkspaceSelection } from "./artifacts-workspace.ts";

export type ArtifactsWorkspaceRecord = {
  selection: ArtifactsWorkspaceSelection;
  context?: ArtifactsWorkspaceContext;
  tokenIds: string[];
  blocked: boolean;
  unknownTokenInventory: boolean;
  pendingOperation: "none" | "fork" | "mint";
};
export type ArtifactsWorkspaceKey = Pick<ArtifactsWorkspaceSelection, "workspaceId" | "sourceSpaceId"> & { sourceRepository: Pick<ArtifactsWorkspaceSelection["sourceRepository"], "accountId" | "namespace"> };

/** Internal metadata custody. Every change is one synchronous transaction. */
export type ArtifactsWorkspaceStore = {
  readonly storage: "process-local-contract" | "sqlite-contract";
  reserve(selection: ArtifactsWorkspaceSelection): boolean;
  read(selection: ArtifactsWorkspaceKey): ArtifactsWorkspaceRecord | undefined;
  repository(repositoryId: string): ArtifactsWorkspaceRecord | undefined;
  change(selection: ArtifactsWorkspaceSelection, update: (record: ArtifactsWorkspaceRecord) => void): void;
  /** Release a pre-effect reservation only when it has not been revoked. */
  release(selection: ArtifactsWorkspaceSelection): void;
};

function key(selection: ArtifactsWorkspaceKey): string {
  return JSON.stringify([selection.sourceRepository.accountId, selection.sourceRepository.namespace, selection.workspaceId, selection.sourceSpaceId]);
}

export class MemoryArtifactsWorkspaceStore implements ArtifactsWorkspaceStore {
  readonly storage = "process-local-contract";
  private readonly records = new Map<string, ArtifactsWorkspaceRecord>();

  reserve(selection: ArtifactsWorkspaceSelection): boolean {
    if (this.records.has(key(selection)) || [...this.records.values()].some(record =>
      record.selection.sourceRepository.accountId === selection.sourceRepository.accountId &&
      record.selection.sourceRepository.namespace === selection.sourceRepository.namespace && record.selection.targetName === selection.targetName)) return false;
    this.records.set(key(selection), structuredClone({ selection, tokenIds: [], blocked: false, unknownTokenInventory: false, pendingOperation: "none" }));
    return true;
  }
  read(selection: ArtifactsWorkspaceKey): ArtifactsWorkspaceRecord | undefined { return this.copy(this.records.get(key(selection))); }
  repository(repositoryId: string): ArtifactsWorkspaceRecord | undefined { return this.copy([...this.records.values()].find(record => record.context?.binding.repositoryId === repositoryId)); }
  change(selection: ArtifactsWorkspaceSelection, update: (record: ArtifactsWorkspaceRecord) => void): void {
    const record = this.read(selection);
    if (!record) throw new Error("artifacts.workspace_custody_missing");
    update(record);
    this.records.set(key(selection), structuredClone(record));
  }
  release(selection: ArtifactsWorkspaceSelection): void { if (!this.records.get(key(selection))?.blocked) this.records.delete(key(selection)); }
  private copy(record: ArtifactsWorkspaceRecord | undefined): ArtifactsWorkspaceRecord | undefined { return record && structuredClone(record); }
}

/** Local SQLite qualification uses the same synchronous host shape as a DO.
 * A Realm must supply and qualify the actual durable host; this is no deployment. */
export class SQLiteArtifactsWorkspaceStore implements ArtifactsWorkspaceStore {
  readonly storage = "sqlite-contract";
  constructor(private readonly host: AuthoritySqlHost) {}
  reserve(selection: ArtifactsWorkspaceSelection): boolean {
    return this.host.transactionSync(() => {
      this.host.sql.exec("CREATE TABLE IF NOT EXISTS anyam_artifacts_workspaces (row_key TEXT PRIMARY KEY, account_id TEXT NOT NULL, namespace TEXT NOT NULL, target_name TEXT NOT NULL, repository_id TEXT UNIQUE, payload TEXT NOT NULL, UNIQUE(account_id, namespace, target_name))");
      return this.host.sql.exec(
        "INSERT INTO anyam_artifacts_workspaces (row_key, account_id, namespace, target_name, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING row_key",
        key(selection), selection.sourceRepository.accountId, selection.sourceRepository.namespace, selection.targetName, JSON.stringify({ selection, tokenIds: [], blocked: false, unknownTokenInventory: false, pendingOperation: "none" }),
      ).toArray().length === 1;
    });
  }
  read(selection: ArtifactsWorkspaceKey): ArtifactsWorkspaceRecord | undefined { return this.load("row_key", key(selection)); }
  repository(repositoryId: string): ArtifactsWorkspaceRecord | undefined { return this.load("repository_id", repositoryId); }
  change(selection: ArtifactsWorkspaceSelection, update: (record: ArtifactsWorkspaceRecord) => void): void {
    this.host.transactionSync(() => {
      const record = this.read(selection);
      if (!record) throw new Error("artifacts.workspace_custody_missing");
      update(record);
      this.host.sql.exec("UPDATE anyam_artifacts_workspaces SET repository_id = ?, payload = ? WHERE row_key = ?", record.context?.binding.repositoryId ?? null, JSON.stringify(record), key(selection));
    });
  }
  release(selection: ArtifactsWorkspaceSelection): void {
    if (!this.hasTable()) return;
    this.host.transactionSync(() => {
      if (!this.read(selection)?.blocked) this.host.sql.exec("DELETE FROM anyam_artifacts_workspaces WHERE row_key = ?", key(selection));
    });
  }
  private load(column: "row_key" | "repository_id", value: string): ArtifactsWorkspaceRecord | undefined {
    if (!this.hasTable()) return undefined;
    const row = this.host.sql.exec<{ payload: string }>(`SELECT payload FROM anyam_artifacts_workspaces WHERE ${column} = ?`, value).toArray()[0];
    return row ? JSON.parse(row.payload) as ArtifactsWorkspaceRecord : undefined;
  }
  private hasTable(): boolean {
    return this.host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'anyam_artifacts_workspaces'").toArray().length > 0;
  }
}
