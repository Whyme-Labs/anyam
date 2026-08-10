/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

type JsonObject = Record<string, unknown>;

type JobStatus = "running" | "succeeded" | "failed" | "indeterminate" | "cancelled" | "revoked";
type Disclosure = "public" | "project" | "restricted";

type JobManifest = {
  inputManifestDigest: string;
  sourceSnapshotDigest: string;
  projectViewId: string;
  outputRoot: string;
  outputPaths: string[];
  disclosure: Disclosure;
};

type StoredOutput = {
  path: string;
  kind: "log" | "artifact" | "evidence";
  disclosure: Disclosure;
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
  credentialRevokedAt?: string;
  manifest: JobManifest;
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
  QUALIFICATION_CONTROL_TOKEN?: string;
  REQUIRE_MANIFEST_BINDING?: string;
  MAX_OUTPUT_DISCLOSURE?: Disclosure;
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

function disclosureRank(value: Disclosure): number {
  return value === "public" ? 0 : value === "project" ? 1 : 2;
}

function disclosureAllows(outer: Disclosure, inner: Disclosure): boolean {
  return disclosureRank(inner) <= disclosureRank(outer);
}

function disclosure(value: string, field: string): Disclosure {
  if (value !== "public" && value !== "project" && value !== "restricted") throw new Error(`${field} must be public, project, or restricted`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) throw new Error(`${field} must be a non-empty string array`);
  return value.map((item) => safePath(item as string));
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

function decodeJobId(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) throw new Error("job id must not be empty");
    return decoded;
  } catch {
    throw new Error("job id path segment is not valid URL encoding");
  }
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
    manifest: record.manifest,
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

  private async readManifest(jobId: string): Promise<JobManifest | undefined> {
    return await this.ctx.storage.get<JobManifest>(`manifest:${jobId}`);
  }

  private async controlAuthorized(request: Request): Promise<void> {
    const configured = this.env.QUALIFICATION_CONTROL_TOKEN?.trim();
    const value = request.headers.get("authorization");
    if (!configured || !value?.startsWith("Bearer ") || !(await constantTimeEqual(value.slice("Bearer ".length).trim(), configured))) {
      throw new Error("qualification control credential is invalid or unavailable");
    }
  }

  private async write(record: JobRecord): Promise<void> {
    await this.ctx.storage.put(`job:${record.jobId}`, record);
  }

  private async authorized(request: Request, job: JobRecord): Promise<string> {
    const token = bearer(request);
    const tokenDigest = await digest(token);
    if (!(await constantTimeEqual(tokenDigest, job.credentialDigest))) throw new Error("credential is invalid or revoked");
    if (job.credentialRevokedAt) throw new Error("credential is invalid or revoked");
    if (Date.parse(job.credentialExpiresAt) <= Date.now()) throw new Error("credential is expired");
    return token;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const encodedJobId = url.pathname.split("/")[2];
    if (!encodedJobId) return json({ code: "job_id_required", recoveryAction: "include a job id in the qualification route" }, 422);
    let jobId: string;
    try {
      jobId = decodeJobId(encodedJobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "job id path segment is invalid";
      return json({ code: "invalid_job_id", message, recoveryAction: "use the URL-encoded job id emitted by the qualification Runner" }, 422);
    }
    try {
      if (request.method === "GET" && url.pathname.endsWith("/status")) {
        const record = await this.read(jobId);
        return record ? json(credentialFree(record)) : json({ code: "job_not_found", recoveryAction: "submit the signed claim for the immutable Queue job first" }, 404);
      }

      if (request.method === "POST" && url.pathname.endsWith("/bind")) {
        await this.controlAuthorized(request);
        if (await this.read(jobId)) return json({ code: "job_already_claimed", recoveryAction: "inspect the existing credential-free status and do not replace the immutable manifest", receipt: `job=${jobId}; manifest=already-claimed` }, 409);
        const body = await bodyObject(request);
        const manifest: JobManifest = {
          inputManifestDigest: requiredString(body, "inputManifestDigest"),
          sourceSnapshotDigest: requiredString(body, "sourceSnapshotDigest"),
          projectViewId: requiredString(body, "projectViewId"),
          outputRoot: safePath(requiredString(body, "outputRoot")),
          outputPaths: stringArray(body.outputPaths, "outputPaths"),
          disclosure: disclosure(requiredString(body, "disclosure"), "disclosure"),
        };
        const existing = await this.readManifest(jobId);
        if (existing && stableJson(existing) !== stableJson(manifest)) return json({ code: "manifest_conflict", recoveryAction: "reuse the exact Queue job manifest or choose a new immutable job id", receipt: `job=${jobId}; manifest=conflict` }, 409);
        await this.ctx.storage.put(`manifest:${jobId}`, manifest);
        return json({ jobId, manifest, receipt: `manifest=bound; job=${jobId}; credentialMaterialStored=false; canonicalWrite=false` });
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
        const projectViewId = requiredString(body, "projectViewId");
        const outputPaths = stringArray(body.outputPaths, "outputPaths");
        const requestedDisclosure = disclosure(requiredString(body, "disclosure"), "disclosure");
        const leaseExpiresAt = requiredString(body, "leaseExpiresAt");
        const publicKey = requiredString(body, "publicKey");
        const challenge = requiredString(body, "challenge");
        const signature = requiredString(body, "signature");
        const manifest: JobManifest = { inputManifestDigest, sourceSnapshotDigest, projectViewId, outputRoot, outputPaths, disclosure: requestedDisclosure };
        const boundManifest = await this.readManifest(jobId);
        if (this.env.REQUIRE_MANIFEST_BINDING === "true" && !boundManifest) return json({ code: "manifest_not_bound", recoveryAction: "bind the owner-approved Queue manifest before claiming the Runner Attempt", receipt: `job=${jobId}; manifest=missing` }, 409);
        if (boundManifest && stableJson(boundManifest) !== stableJson(manifest)) return json({ code: "manifest_mismatch", recoveryAction: "claim only the exact Project View and input manifest bound by the coordinator", receipt: `job=${jobId}; manifest=mismatch` }, 422);
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
          manifest: boundManifest ?? manifest,
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

      if (request.method === "POST" && (url.pathname.endsWith("/cancel") || url.pathname.endsWith("/revoke"))) {
        await this.controlAuthorized(request);
        const body = await bodyObject(request);
        const reason = requiredString(body, "reason");
        if (record.status !== "running") return json({ code: "control_state_invalid", recoveryAction: "cancel or revoke only an active Attempt, then create a fresh Attempt for retry", receipt: `job=${jobId}; status=${record.status}` }, 409);
        const nextStatus: JobStatus = url.pathname.endsWith("/cancel") ? "cancelled" : "revoked";
        const now = new Date().toISOString();
        const resultEnvelope = { jobId, status: nextStatus, reason };
        const next: JobRecord = {
          ...record,
          status: nextStatus,
          resultDigest: await digest(stableJson(resultEnvelope)),
          resultReceipt: `control=${nextStatus}; reason=${reason}; credentialRevoked=true; canonicalWrite=false`,
          credentialRevokedAt: now,
          updatedAt: now,
        };
        await this.write(next);
        return json({ status: credentialFree(next), receipt: next.resultReceipt });
      }

      if (request.method === "POST" && url.pathname.endsWith("/outputs")) {
        await this.authorized(request, record);
        if (record.status !== "running") return json({ code: "job_not_running", recoveryAction: "upload outputs only while the current Attempt is running", receipt: `job=${jobId}; status=${record.status}` }, 409);
        const body = await bodyObject(request);
        const attemptId = requiredString(body, "attemptId");
        if (attemptId !== record.attemptId) throw new Error("attemptId does not match the current Attempt");
        const path = safePath(requiredString(body, "path"));
        const kind = requiredString(body, "kind");
        if (kind !== "log" && kind !== "artifact" && kind !== "evidence") throw new Error("kind must be log, artifact, or evidence");
        const outputDisclosure = disclosure(optionalString(body, "disclosure") ?? "project", "disclosure");
        const maximumDisclosure = disclosure(this.env.MAX_OUTPUT_DISCLOSURE ?? record.manifest.disclosure, "MAX_OUTPUT_DISCLOSURE");
        if (!disclosureAllows(maximumDisclosure, outputDisclosure) || !disclosureAllows(record.manifest.disclosure, outputDisclosure)) return json({ code: "output_disclosure_forbidden", recoveryAction: "return an output at or below the bound Project View disclosure", receipt: `job=${jobId}; jobDisclosure=${record.manifest.disclosure}; maximumDisclosure=${maximumDisclosure}; outputDisclosure=${outputDisclosure}` }, 422);
        if (!record.manifest.outputPaths.includes(path)) return json({ code: "output_path_forbidden", recoveryAction: "upload only a path declared in the owner-bound output manifest", receipt: `job=${jobId}; path=${path}; declaredPaths=${record.manifest.outputPaths.join(",")}` }, 422);
        const content = base64ToBytes(requiredString(body, "contentBase64"));
        const contentDigest = await digest(content);
        const declaredDigest = requiredString(body, "digest");
        if (!(await constantTimeEqual(contentDigest, declaredDigest))) throw new Error("declared digest does not match uploaded bytes");
        const key = `${record.outputRoot}/${path}`;
        await this.env.OUTPUTS.put(key, content, { httpMetadata: { contentType: "application/octet-stream" } });
        const output: StoredOutput = { path, kind, disclosure: outputDisclosure, digest: contentDigest, bytes: content.byteLength, key };
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
        if (outputs.length !== record.outputs.length) return json({ code: "result_output_manifest_mismatch", recoveryAction: "sign exactly the output references accepted by the coordinator before submitting the Result", receipt: `job=${jobId}; acceptedOutputs=${record.outputs.length}; resultOutputs=${outputs.length}` }, 422);
        const maximumDisclosure = disclosure(this.env.MAX_OUTPUT_DISCLOSURE ?? record.manifest.disclosure, "MAX_OUTPUT_DISCLOSURE");
        for (const item of outputs) {
          if (!isRecord(item)) return json({ code: "result_output_manifest_mismatch", recoveryAction: "return structured output references matching the accepted output manifest", receipt: `job=${jobId}; output=not-object` }, 422);
          const path = typeof item.path === "string" ? safePath(item.path) : "";
          const accepted = record.outputs.find((output) => output.path === path);
          const itemDisclosure = typeof item.disclosure === "string" ? disclosure(item.disclosure, "outputs.disclosure") : "project";
          if (!accepted || item.kind !== accepted.kind || item.digest !== accepted.digest || item.bytes !== accepted.bytes || !disclosureAllows(maximumDisclosure, itemDisclosure) || !disclosureAllows(record.manifest.disclosure, itemDisclosure)) return json({ code: "result_output_manifest_mismatch", recoveryAction: "return only the exact, disclosure-safe outputs accepted for this Attempt", receipt: `job=${jobId}; path=${path}; manifest=not-matched` }, 422);
        }
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
        const next: JobRecord = { ...record, status: nextStatus, resultDigest, resultReceipt: `result=accepted; outputReadBack=verified; queueAck=not-performed; canonicalWrite=false`, credentialRevokedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
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
    const encodedJobId = match[1];
    if (!encodedJobId) return json({ code: "job_id_required", recoveryAction: "include a job id" }, 422);
    let jobId: string;
    try {
      jobId = decodeJobId(encodedJobId);
    } catch {
      return json({ code: "invalid_job_id", recoveryAction: "use a URL-encoded job id in the qualification route" }, 422);
    }
    return routeToCoordinator(env, jobId, request);
  },
};

export { QualificationCoordinator };
