import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AuthoritySQLiteStore, type AuthoritySqlHost } from "../../src/cloudflare/authority-sqlite.ts";
import { emptyAuthorityPlaneSnapshot, normalizeAuthorityPlaneSnapshot } from "../../src/cloudflare/authority-plane.ts";

export function cohortStore(database: DatabaseSync, afterRow?: (collection: unknown) => void): AuthoritySQLiteStore {
  const host: AuthoritySqlHost = {
    sql: {
      exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
        const rows = database.prepare(query).all(...bindings as SQLInputValue[]) as unknown as readonly T[];
        if (query.startsWith("INSERT INTO anyam_authority_entities")) afterRow?.(bindings[0]);
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(closure: () => T): T {
      database.exec("BEGIN");
      try {
        const result = closure();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return new AuthoritySQLiteStore(host, { empty: emptyAuthorityPlaneSnapshot, normalize: normalizeAuthorityPlaneSnapshot });
}
