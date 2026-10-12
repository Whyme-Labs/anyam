import { parseRepositoryDriverSnapshotIndex, parseRepositoryDriverSnapshotManifest, repositoryDriverSnapshotDigest, repositoryDriverSnapshotIndexKey, repositoryDriverSnapshotManifestKey, REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL, type RepositoryDriverSnapshotManifest } from "../../repository-driver/src/index.ts";
import type { AuthoritySqlHost } from "../../../src/cloudflare/authority-sqlite.ts";
import { scanCredentialMaterial } from "../../../src/security/credential-material.ts";

export class ArtifactsObservationPublicationError extends Error {
  constructor(readonly code: "conflict" | "unavailable") { super(`Artifact observation publication ${code}; inspect the exact generation before retrying`); }
}
function immutableClaims(value: RepositoryDriverSnapshotManifest) {
  const { observedAt: _at, expiresAt: _expiry, ...claims } = value;
  return JSON.stringify(claims);
}
/** One immutable generation journal and the existing R2 driver index. Provider
 * observation precedes reservation; all R2 effects are outside SQL transactions. */
export class ArtifactsObservationPublisher {
  constructor(private readonly options: { sql: AuthoritySqlHost; bucket: R2Bucket; prefix: string; now?: () => number }) {}
  async publish(fresh: RepositoryDriverSnapshotManifest, recheck: () => Promise<void>) {
    const fail: (code: "conflict" | "unavailable") => never = code => { throw new ArtifactsObservationPublicationError(code); };
    const indexKey = repositoryDriverSnapshotIndexKey(this.options.prefix, fresh.repositoryId, fresh.context);
    const manifestKey = repositoryDriverSnapshotManifestKey(this.options.prefix, fresh.repositoryId, fresh.context, fresh.generation);
    const key = JSON.stringify([indexKey, fresh.sourceSpaceId, fresh.generation]);
    this.options.sql.transactionSync(() => {
      this.options.sql.sql.exec("CREATE TABLE IF NOT EXISTS anyam_artifacts_observations (row_key TEXT PRIMARY KEY, manifest TEXT NOT NULL)");
      this.options.sql.sql.exec("INSERT INTO anyam_artifacts_observations (row_key, manifest) VALUES (?, ?) ON CONFLICT DO NOTHING", key, JSON.stringify(fresh));
    });
    const stored = this.options.sql.sql.exec<{ manifest: string }>("SELECT manifest FROM anyam_artifacts_observations WHERE row_key = ?", key).toArray()[0];
    const storedValue: unknown = stored ? JSON.parse(stored.manifest) : undefined;
    const manifest = parseRepositoryDriverSnapshotManifest(storedValue);
    const now = (this.options.now ?? Date.now)();
    if (!manifest || scanCredentialMaterial(storedValue) || immutableClaims(manifest) !== immutableClaims(fresh) || Date.parse(manifest.expiresAt) <= now || Date.parse(manifest.expiresAt) > Date.parse(fresh.expiresAt)) fail("conflict");
    const digest = await repositoryDriverSnapshotDigest(manifest);
    const object = await this.options.bucket.get(indexKey);
    const value: unknown = object ? await object.json() : undefined;
    const current = object ? parseRepositoryDriverSnapshotIndex(value) : undefined;
    if (object && (!current || scanCredentialMaterial(value) || current.repositoryId !== manifest.repositoryId || current.sourceSpaceId !== manifest.sourceSpaceId || current.context.kind !== "workspace" || manifest.context.kind !== "workspace" || current.context.workspaceId !== manifest.context.workspaceId || current.context.projectViewId !== manifest.context.projectViewId || current.latestGeneration > manifest.generation)) fail("conflict");
    if (current?.latestGeneration === manifest.generation && (current.latestManifestKey !== manifestKey || current.latestManifestDigest !== digest)) fail("conflict");
    await recheck();
    if (Date.parse(manifest.expiresAt) <= (this.options.now ?? Date.now)()) fail("conflict");
    const created = await this.options.bucket.put(manifestKey, JSON.stringify(manifest), { onlyIf: { etagDoesNotMatch: "*" } });
    if (!created) {
      const existing = await this.options.bucket.get(manifestKey);
      const existingValue: unknown = existing ? await existing.json() : undefined;
      const existingManifest = parseRepositoryDriverSnapshotManifest(existingValue);
      if (!existingManifest || scanCredentialMaterial(existingValue) || await repositoryDriverSnapshotDigest(existingManifest) !== digest) fail("conflict");
    }
    await recheck();
    if (Date.parse(manifest.expiresAt) <= (this.options.now ?? Date.now)()) fail("conflict");
    if (current?.latestGeneration !== manifest.generation) {
      const index = { protocol: REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL, repositoryId: manifest.repositoryId, sourceSpaceId: manifest.sourceSpaceId, context: manifest.context,
        latestGeneration: manifest.generation, previousGeneration: current?.latestGeneration ?? null, latestManifestKey: manifestKey, latestManifestDigest: digest,
        updatedAt: new Date((this.options.now ?? Date.now)()).toISOString(), receipt: "provider=artifacts; index=conditional-monotonic; credentialMaterialStored=false" };
      const activated = await this.options.bucket.put(indexKey, JSON.stringify(index), { onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" } });
      if (!activated) fail("conflict");
    }
    const verifiedObject = await this.options.bucket.get(indexKey);
    const verifiedValue: unknown = verifiedObject ? await verifiedObject.json() : undefined;
    const verified = parseRepositoryDriverSnapshotIndex(verifiedValue);
    if (!verified || scanCredentialMaterial(verifiedValue) || verified.latestGeneration !== manifest.generation || verified.latestManifestDigest !== digest || verified.latestManifestKey !== manifestKey || verified.repositoryId !== manifest.repositoryId || verified.sourceSpaceId !== manifest.sourceSpaceId || JSON.stringify(verified.context) !== JSON.stringify(manifest.context)) fail("conflict");
    return { manifest, manifestDigest: digest };
  }
}
