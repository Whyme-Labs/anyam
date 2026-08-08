import {
  PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL,
  type PublicGatewayReplayArchiveReceipt,
  type PublicGatewayRequestTombstone,
} from "./public-gateway.ts";

export type PublicGatewayReplayArchiveObject = {
  protocol: typeof PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL;
  requestId: string;
  tombstone: PublicGatewayRequestTombstone;
  digest: string;
  bytes: number;
  receipt: string;
};

export type PublicGatewayReplayArchiveBucket = {
  put(key: string, value: string, options?: { customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
};

export class PublicGatewayReplayArchiveError extends Error {
  readonly code: "invalid-request" | "unavailable" | "integrity-mismatch";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: PublicGatewayReplayArchiveError["code"]; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "PublicGatewayReplayArchiveError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PublicGatewayReplayArchiveError({
      code: "invalid-request",
      message: `${field} is required for exact replay archive access.`,
      recoveryAction: `provide a non-empty ${field} and retry without changing the stored tombstone`,
      receipt: `field=${field}; replayArchive=invalid-request`,
    });
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stableValue(nested)]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function archiveKey(projectId: string, requestId: string): Promise<string> {
  const identityDigest = await digest({ projectId, requestId });
  return `anyam/public-gateway/replay-index/v1/${identityDigest.slice("sha256:".length)}.json`;
}

function unsignedObject(object: PublicGatewayReplayArchiveObject): Omit<PublicGatewayReplayArchiveObject, "digest"> {
  const { digest: _digest, ...unsigned } = object;
  return unsigned;
}

function invalidStoredObject(message: string, receipt: string): PublicGatewayReplayArchiveError {
  return new PublicGatewayReplayArchiveError({
    code: "integrity-mismatch",
    message,
    recoveryAction: "retain the coordinator export, quarantine the archive object, and restore a verified exact replay object before reopening intake",
    receipt,
  });
}

/**
 * Customer-owned, immutable one-request-per-object archive. The coordinator
 * remains the source of accepted lineage; this adapter is only an exact replay
 * projection used after the local Durable Object tombstone tripwire.
 */
export class CloudflarePublicGatewayReplayArchive {
  constructor(private readonly bucket: PublicGatewayReplayArchiveBucket, private readonly projectId: string) {
    required(projectId, "projectId");
  }

  async put(tombstone: PublicGatewayRequestTombstone): Promise<PublicGatewayReplayArchiveReceipt> {
    required(tombstone.requestId, "tombstone.requestId");
    required(tombstone.payloadDigest, "tombstone.payloadDigest");
    const key = await archiveKey(this.projectId, tombstone.requestId);
    const unsigned: Omit<PublicGatewayReplayArchiveObject, "digest"> = {
      protocol: PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL,
      requestId: tombstone.requestId,
      tombstone: clone(tombstone),
      bytes: 0,
      receipt: `replayArchive=${PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL}; projectId=${this.projectId}; requestId=${tombstone.requestId}; exact=true; authority=coordinator-replay-projection; compactedAt=${tombstone.compactedAt}`,
    };
    const payloadWithoutSize = stableJson(unsigned);
    const bytes = new TextEncoder().encode(payloadWithoutSize).byteLength;
    const object: PublicGatewayReplayArchiveObject = { ...unsigned, bytes, digest: await digest({ ...unsigned, bytes }) };
    const existing = await this.bucket.get(key);
    if (existing) {
      const verified = await this.readObject(key, existing);
      if (verified.tombstone.payloadDigest !== tombstone.payloadDigest || verified.tombstone.contributionId !== tombstone.contributionId || verified.tombstone.originalStatus !== tombstone.originalStatus) {
        throw invalidStoredObject("An existing replay archive object has a different exact request identity.", `key=${key}; requestId=${tombstone.requestId}; existingDigest=${verified.digest}; requestedDigest=${object.digest}; immutable=false`);
      }
      return {
        protocol: PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL,
        requestId: tombstone.requestId,
        digest: verified.digest,
        bytes: verified.bytes,
        key,
        idempotent: true,
        receipt: `${verified.receipt}; idempotent=true; archiveWrite=false`,
      };
    }
    await this.bucket.put(key, stableJson(object), { customMetadata: { protocol: PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL, digest: object.digest, requestId: tombstone.requestId } });
    const persisted = await this.bucket.get(key);
    if (!persisted) throw new PublicGatewayReplayArchiveError({ code: "unavailable", message: "The replay archive did not return the object after a successful write.", recoveryAction: "retry the same export-before-compaction operation after the customer-owned archive recovers", receipt: `key=${key}; requestId=${tombstone.requestId}; readBack=false` });
    const verified = await this.readObject(key, persisted);
    if (verified.digest !== object.digest) throw invalidStoredObject("The replay archive read-back digest does not match the written object.", `key=${key}; requestId=${tombstone.requestId}; writtenDigest=${object.digest}; readBackDigest=${verified.digest}; immutable=false`);
    return {
      protocol: PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL,
      requestId: tombstone.requestId,
      digest: verified.digest,
      bytes: verified.bytes,
      key,
      idempotent: false,
      receipt: `${verified.receipt}; idempotent=false; archiveWrite=true`,
    };
  }

  async get(requestId: string): Promise<PublicGatewayRequestTombstone | undefined> {
    required(requestId, "requestId");
    const key = await archiveKey(this.projectId, requestId);
    let object: { arrayBuffer(): Promise<ArrayBuffer> } | null;
    try {
      object = await this.bucket.get(key);
    } catch (error) {
      throw new PublicGatewayReplayArchiveError({
        code: "unavailable",
        message: "The customer-owned replay archive is unavailable.",
        recoveryAction: "restore the archive provider and retry; do not accept a request whose exact replay identity cannot be checked",
        receipt: `key=${key}; requestId=${requestId}; archiveRead=false; cause=${error instanceof Error ? error.name : "unknown"}`,
      });
    }
    if (!object) return undefined;
    const parsed = await this.readObject(key, object);
    if (parsed.requestId !== requestId || parsed.tombstone.requestId !== requestId) throw invalidStoredObject("The replay archive object does not match the requested request identity.", `key=${key}; requestId=${requestId}; storedRequestId=${parsed.requestId}; replay=false`);
    return clone(parsed.tombstone);
  }

  private async readObject(key: string, object: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<PublicGatewayReplayArchiveObject> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
    } catch (error) {
      throw invalidStoredObject("The replay archive object is not readable JSON.", `key=${key}; parse=false; cause=${error instanceof Error ? error.name : "unknown"}`);
    }
    if (!parsed || typeof parsed !== "object") throw invalidStoredObject("The replay archive object is not an object.", `key=${key}; object=invalid`);
    const candidate = parsed as Partial<PublicGatewayReplayArchiveObject>;
    if (candidate.protocol !== PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL || typeof candidate.requestId !== "string" || !candidate.tombstone || typeof candidate.digest !== "string" || typeof candidate.bytes !== "number") throw invalidStoredObject("The replay archive object has an unsupported shape.", `key=${key}; protocol=${String(candidate.protocol ?? "missing")}; shape=invalid`);
    const calculatedDigest = await digest(unsignedObject(candidate as PublicGatewayReplayArchiveObject));
    if (calculatedDigest !== candidate.digest) throw invalidStoredObject("The replay archive object failed content-digest verification.", `key=${key}; recordedDigest=${candidate.digest}; calculatedDigest=${calculatedDigest}; integrity=false`);
    return candidate as PublicGatewayReplayArchiveObject;
  }
}
