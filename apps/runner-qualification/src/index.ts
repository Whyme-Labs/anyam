/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

type JsonObject = Record<string, unknown>;

type JobStatus = "running" | "succeeded" | "failed" | "indeterminate";

type StoredOutput = {
  path: string;
  kind: "log" | "artifact" | "evidence";
  disclosure: "public" | "project" | "restricted";
  digest: string;
  bytes: number;
  key: string;
};

type JobRecord = {
  protocol: "anyam.external-runner-qualification/v1";
  jobId: string;
  attemptId: string;
  runnerId: string;
  actionId: string;
  inputManifestDigest: string;
  sourceSnapshotDigest: string;
  outputRoot: string;
  leaseExpiresAt: string;
  publicKey: string;
  challengeDigest: string;
  credentialDigest: string;
  credentialExpiresAt: string;
  status: JobStatus;
  outputs: StoredOutput[];
  resultDigest?: string;
  resultReceipt?: string;
  createdAt: string;
  updatedAt: string;
};

export interface Env {
  COORDINATOR: DurableObjectNamespace;
  OUTPUTS: R2Bucket;
  COHORT_ID: string;
  PROTOCOL_VERSION: string;
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(value, null, 2), { status, headers: responseHeaders });
}

function text(value: string, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return new Response(value, { status, headers: responseHeaders });
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function bodyObject(request: Request): Promise<JsonObject> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new Error("request body must be JSON");
  }
  if (!isRecord(value)) throw new Error("request body must be a JSON object");
  return value;
}

function requiredString(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(body: JsonObject, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string when provided`);
  return value.trim();
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stable(value)) ?? "null";
}

async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let result = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) result |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return result === 0;
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function verifyEd25519(publicKey: string, message: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", base64ToBytes(publicKey).buffer as ArrayBuffer, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, base64ToBytes(signature).buffer as ArrayBuffer, new TextEncoder().encode(message).buffer as ArrayBuffer);
  } catch {
    return false;
  }
}

async function challengeDigest(challenge: string): Promise<string> {
  return digest(challenge);
}

function safePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("path must be relative and traversal-free");
  return normalized;
}

function bearer(request: Request): string {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) throw new Error("Bearer credential required");
  const token = value.slice("Bearer ".length).trim();
  if (!token) throw new Error("Bearer credential required");
  return token;
}

function credentialFree(record: JobRecord): Record<string, unknown> {
  return {
    protocol: record.protocol,
    jobId: record.jobId,
    attemptId: record.attemptId,
    runnerId: record.runnerId,
    actionId: record.actionId,
    inputManifestDigest: record.inputManifestDigest,
    sourceSnapshotDigest: record.sourceSnapshotDigest,
    outputRoot: record.outputRoot,
    leaseExpiresAt: record.leaseExpiresAt,
    status: record.status,
    outputs: record.outputs,
    ...(record.resultDigest ? { resultDigest: record.resultDigest } : {}),
    ...(record.resultReceipt ? { resultReceipt: record.resultReceipt } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    credentialMaterialStored: false,
    canonicalWrite: false,
  };
}

class QualificationCoordinator extends DurableObject<Env> {
  private async read(jobId: string): Promise<JobRecord | undefined> {
    return await this.ctx.storage.get<JobRecord>(`job:${jobId}`);
  }

  private async write(record: JobRecord): Promise<void> {
    await this.ctx.storage.put(`job:${record.jobId}`, record);
  }

  private async authorized(request: Request, job: JobRecord): Promise<string> {
    const token = bearer(request);
    const tokenDigest = await digest(token);
    if (!(await constantTimeEqual(tokenDigest, job.credentialDigest))) throw new Error("credential is invalid or revoked");
    if (Date.parse(job.credentialExpiresAt) <= Date.now()) throw new Error("credential is expired");
    return token;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const jobId = url.pathname.split("/")[2];
    if (!jobId) return json({ code: "job_id_required", recoveryAction: "include a job id in the qualification route" }, 422);
    try {
      if (request.method === "GET" && url.pathname.endsWith("/status")) {
        const record = await this.read(jobId);
        return record ? json(credentialFree(record)) : json({ code: "job_not_found", recoveryAction: "submit the signed claim for the immutable Queue job first" }, 404);
      }

      if (request.method === "POST" && url.pathname.endsWith("/claim")) {
        const body = await bodyObject(request);
        const existing = await this.read(jobId);
        if (existing) return json({ code: "job_already_claimed", recoveryAction: "inspect the existing credential-free status and do not replay the claim", receipt: `job=${jobId}; status=${existing.status}` }, 409);
        const attemptId = requiredString(body, "attemptId");
        const runnerId = requiredString(body, "runnerId");
        const actionId = requiredString(body, "actionId");
        const inputManifestDigest = requiredString(body, "inputManifestDigest");
        const sourceSnapshotDigest = requiredString(body, "sourceSnapshotDigest");
        const outputRoot = safePath(requiredString(body, "outputRoot"));
        const leaseExpiresAt = requiredString(body, "leaseExpiresAt");
        const publicKey = requiredString(body, "publicKey");
        const challenge = requiredString(body, "challenge");
        const signature = requiredString(body, "signature");
        if (!Number.isFinite(Date.parse(leaseExpiresAt)) || Date.parse(leaseExpiresAt) <= Date.now()) throw new Error("leaseExpiresAt must be in the future");
        const valid = await verifyEd25519(publicKey, `anyam.runner-claim/v1|${challenge}`, signature);
        if (!valid) return json({ code: "runner_proof_invalid", recoveryAction: "sign the exact claim challenge with the enrolled Runner key", receipt: `job=${jobId}; proof=invalid` }, 422);
        const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
        const token = bytesToBase64(tokenBytes);
        const now = new Date().toISOString();
        const record: JobRecord = {
          protocol: "anyam.external-runner-qualification/v1",
          jobId,
          attemptId,
          runnerId,
          actionId,
          inputManifestDigest,
          sourceSnapshotDigest,
          outputRoot,
          leaseExpiresAt,
          publicKey,
          challengeDigest: await challengeDigest(challenge),
          credentialDigest: await digest(token),
          credentialExpiresAt: leaseExpiresAt,
          status: "running",
          outputs: [],
          createdAt: now,
          updatedAt: now,
        };
        await this.write(record);
        return json({ credential: { audience: "anyam-runner-job", jobId, attemptId, expiresAt: leaseExpiresAt, token }, status: credentialFree(record), receipt: `claim=accepted; job=${jobId}; attempt=${attemptId}; credentialMaterialStored=false; canonicalWrite=false` });
      }

      const record = await this.read(jobId);
      if (!record) return json({ code: "job_not_found", recoveryAction: "submit the signed claim for the immutable Queue job first" }, 404);

      if (request.method === "POST" && url.pathname.endsWith("/outputs")) {
        await this.authorized(request, record);
        if (record.status !== "running") return json({ code: "job_not_running", recoveryAction: "upload outputs only while the current Attempt is running", receipt: `job=${jobId}; status=${record.status}` }, 409);
        const body = await bodyObject(request);
        const attemptId = requiredString(body, "attemptId");
        if (attemptId !== record.attemptId) throw new Error("attemptId does not match the current Attempt");
        const path = safePath(requiredString(body, "path"));
        const kind = requiredString(body, "kind");
        if (kind !== "log" && kind !== "artifact" && kind !== "evidence") throw new Error("kind must be log, artifact, or evidence");
        const disclosure = optionalString(body, "disclosure") ?? "project";
        if (disclosure !== "public" && disclosure !== "project" && disclosure !== "restricted") throw new Error("disclosure must be public, project, or restricted");
        const content = base64ToBytes(requiredString(body, "contentBase64"));
        const contentDigest = await digest(content);
        const declaredDigest = requiredString(body, "digest");
        if (!(await constantTimeEqual(contentDigest, declaredDigest))) throw new Error("declared digest does not match uploaded bytes");
        const key = `${record.outputRoot}/${path}`;
        await this.env.OUTPUTS.put(key, content, { httpMetadata: { contentType: "application/octet-stream" } });
        const output: StoredOutput = { path, kind, disclosure, digest: contentDigest, bytes: content.byteLength, key };
        const next: JobRecord = { ...record, outputs: [...record.outputs.filter((item) => item.path !== path), output], updatedAt: new Date().toISOString() };
        await this.write(next);
        return json({ output, receipt: `output=stored; job=${jobId}; attempt=${record.attemptId}; credentialMaterialStored=false` });
      }

      if (request.method === "GET" && url.pathname.endsWith("/output")) {
        await this.authorized(request, record);
        const path = safePath(url.searchParams.get("path") ?? "");
        const output = record.outputs.find((item) => item.path === path);
        if (!output) return json({ code: "output_not_found", recoveryAction: "request a path already accepted in the Attempt output manifest" }, 404);
        const object = await this.env.OUTPUTS.get(output.key);
        if (!object) return json({ code: "output_missing", recoveryAction: "mark the Attempt indeterminate and reconcile the R2 object before retrying", receipt: `job=${jobId}; path=${path}; object=missing` }, 503);
        return new Response(object.body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-anyam-output-digest": output.digest } });
      }

      if (request.method === "POST" && url.pathname.endsWith("/result")) {
        await this.authorized(request, record);
        if (record.status !== "running") return json({ code: "result_replay", recoveryAction: "inspect the accepted Result and create a fresh Attempt for a retry", receipt: `job=${jobId}; status=${record.status}` }, 409);
        const body = await bodyObject(request);
        const attemptId = requiredString(body, "attemptId");
        if (attemptId !== record.attemptId) throw new Error("attemptId does not match the current Attempt");
        const status = requiredString(body, "status");
        if (status !== "succeeded" && status !== "failed" && status !== "indeterminate") throw new Error("status must be succeeded, failed, or indeterminate");
        const signature = requiredString(body, "signature");
        const outputs = body.outputs;
        if (!Array.isArray(outputs)) throw new Error("outputs must be an array");
        const recoveryAction = optionalString(body, "recoveryAction");
        const resultEnvelope = { jobId, attemptId, status, outputs, ...(recoveryAction ? { recoveryAction } : {}) };
        const resultMessage = `anyam.runner-result/v1|${stableJson(resultEnvelope)}`;
        if (!(await verifyEd25519(record.publicKey, resultMessage, signature))) return json({ code: "result_signature_invalid", recoveryAction: "sign the exact result envelope with the enrolled Runner key", receipt: `job=${jobId}; attempt=${attemptId}; result=invalid-signature` }, 422);
        for (const item of record.outputs) {
          const object = await this.env.OUTPUTS.get(item.key);
          if (!object) return json({ code: "output_missing", recoveryAction: "reconcile the R2 object before accepting the Result", receipt: `job=${jobId}; path=${item.path}; object=missing` }, 503);
          const bytes = new Uint8Array(await object.arrayBuffer());
          const readBackDigest = await digest(bytes);
          if (!(await constantTimeEqual(readBackDigest, item.digest))) return json({ code: "output_digest_mismatch", recoveryAction: "quarantine the Attempt and reconcile the R2 object before retrying", receipt: `job=${jobId}; path=${item.path}; declared=${item.digest}; readBack=${readBackDigest}` }, 422);
        }
        const resultDigest = await digest(stableJson(resultEnvelope));
        const nextStatus = status === "succeeded" ? "succeeded" : status;
        const next: JobRecord = { ...record, status: nextStatus, resultDigest, resultReceipt: `result=accepted; outputReadBack=verified; queueAck=not-performed; canonicalWrite=false`, updatedAt: new Date().toISOString() };
        await this.write(next);
        return json({ status: credentialFree(next), ackRequired: true, resultDigest, receipt: next.resultReceipt });
      }

      return json({ code: "not_found", recoveryAction: "use /jobs/:jobId/status, /claim, /outputs, /output, or /result" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "qualification coordinator request failed";
      const status = message.includes("credential") ? 401 : 422;
      return json({ protocol: "anyam.external-runner-qualification/v1", code: "invalid_request", message, recoveryAction: "inspect the visible error and retry only the same immutable Attempt when safe", receipt: `job=${jobId}; operation=not-accepted; credentialMaterialStored=false` }, status);
    }
  }
}

function routeToCoordinator(env: Env, jobId: string, request: Request): Promise<Response> {
  const id = env.COORDINATOR.idFromName(jobId);
  return env.COORDINATOR.get(id).fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ protocol: "anyam.external-runner-qualification/v1", status: "ready", cohortId: env.COHORT_ID, credentialFree: true, canonicalWrite: false, queueAckAuthority: "external-pull-consumer", receipt: `cohort=${env.COHORT_ID}; coordinator=durable-object; outputs=r2-direct-read-back` });
    }
    const match = url.pathname.match(/^\/jobs\/([^/]+)(\/.*)?$/);
    if (!match) return json({ protocol: "anyam.external-runner-qualification/v1", code: "not_found", recoveryAction: "use GET /health or the documented /jobs/:jobId routes", receipt: "path=not-found" }, 404);
    const jobId = match[1];
    if (!jobId) return json({ code: "job_id_required", recoveryAction: "include a job id" }, 422);
    return routeToCoordinator(env, jobId, request);
  },
};

export { QualificationCoordinator };
