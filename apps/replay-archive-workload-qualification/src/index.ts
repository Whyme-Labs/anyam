/// <reference types="@cloudflare/workers-types" />

import {
  CloudflarePublicGatewayReplayArchive,
  publicGatewayReplayArchiveKey,
} from "../../../src/cloudflare/public-gateway-replay-archive.ts";
import type { PublicGatewayRequestTombstone } from "../../../src/cloudflare/public-gateway.ts";

const PROTOCOL = "anyam.replay-archive-workload-qualification/v1" as const;
const ARCHIVE_PREFIX = "anyam/public-gateway/replay-index/v1/";

export interface Env {
  PUBLIC_GATEWAY_REPLAY_ARCHIVE: R2Bucket;
  PROJECT_ID: string;
  QUALIFICATION_TOKEN: string;
}

type Sample = {
  category: string;
  tombstone: PublicGatewayRequestTombstone;
};

type JsonObject = Record<string, unknown>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function unauthorized(): Response {
  return json({
    protocol: PROTOCOL,
    status: "blocked",
    code: "unauthorized",
    recoveryAction: "use the owner-issued qualification credential; no archive mutation was accepted",
    credentialValues: "not-printed",
  }, 401);
}

function authorized(request: Request, env: Env): boolean {
  const expected = env.QUALIFICATION_TOKEN;
  return typeof expected === "string" && expected.length > 0 && request.headers.get("authorization") === `Bearer ${expected}`;
}

function bodyObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be a JSON object");
  return value as JsonObject;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function parseSample(value: unknown, index: number): Sample {
  const object = bodyObject(value);
  const category = requiredString(object.category, `samples[${index}].category`);
  const tombstoneValue = bodyObject(object.tombstone);
  const originalStatus = requiredString(tombstoneValue.originalStatus, `samples[${index}].tombstone.originalStatus`);
  if (originalStatus !== "denied" && originalStatus !== "accepted" && originalStatus !== "approval_required") {
    throw new Error(`samples[${index}].tombstone.originalStatus is not a supported decision status`);
  }
  const tombstone: PublicGatewayRequestTombstone = {
    requestId: requiredString(tombstoneValue.requestId, `samples[${index}].tombstone.requestId`),
    payloadDigest: requiredString(tombstoneValue.payloadDigest, `samples[${index}].tombstone.payloadDigest`),
    contributionId: requiredString(tombstoneValue.contributionId, `samples[${index}].tombstone.contributionId`),
    originalStatus,
    recordedAt: requiredString(tombstoneValue.recordedAt, `samples[${index}].tombstone.recordedAt`),
    compactedAt: requiredString(tombstoneValue.compactedAt, `samples[${index}].tombstone.compactedAt`),
    exportDigest: requiredString(tombstoneValue.exportDigest, `samples[${index}].tombstone.exportDigest`),
    receipt: requiredString(tombstoneValue.receipt, `samples[${index}].tombstone.receipt`),
  };
  return { category, tombstone };
}

function parseSamples(value: unknown): Sample[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("samples must be a non-empty array");
  return value.map(parseSample);
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const rank = Math.max(1, Math.ceil(sorted.length * percentile));
  const value = sorted[rank - 1];
  if (value === undefined) throw new Error(`nearest-rank percentile=${percentile} has no measured sample`);
  return value;
}

function summary(bytes: readonly number[]): JsonObject {
  const sorted = [...bytes].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    totalBytes: total,
    minBytes: sorted[0],
    maxBytes: sorted[sorted.length - 1],
    meanBytes: total / sorted.length,
    p50NearestRankBytes: nearestRank(sorted, 0.5),
    p90NearestRankBytes: nearestRank(sorted, 0.9),
    p95NearestRankBytes: nearestRank(sorted, 0.95),
    p99NearestRankBytes: nearestRank(sorted, 0.99),
    quantileMethod: "nearest-rank; rank=ceil(count*percentile); one-based rank",
  };
}

async function parseJson(request: Request): Promise<JsonObject> {
  try {
    return bodyObject(await request.json());
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "request body must be JSON");
  }
}

async function measure(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const samples = parseSamples(body.samples);
  const archive = new CloudflarePublicGatewayReplayArchive(env.PUBLIC_GATEWAY_REPLAY_ARCHIVE, env.PROJECT_ID);
  const objects: JsonObject[] = [];
  const bytes: number[] = [];

  for (const sample of samples) {
    const first = await archive.put(sample.tombstone);
    const retry = await archive.put(sample.tombstone);
    const lookup = await archive.get(sample.tombstone.requestId);
    if (!lookup || lookup.payloadDigest !== sample.tombstone.payloadDigest) {
      throw new Error(`archive read-back did not preserve ${sample.tombstone.requestId}`);
    }
    if (first.bytes < 1 || retry.bytes !== first.bytes || first.digest !== retry.digest || !retry.idempotent) {
      throw new Error(`archive receipt was not stable for ${sample.tombstone.requestId}`);
    }
    bytes.push(first.bytes);
    objects.push({
      category: sample.category,
      requestId: sample.tombstone.requestId,
      key: first.key,
      bytes: first.bytes,
      digest: first.digest,
      initialWriteIdempotent: first.idempotent,
      retryIdempotent: retry.idempotent,
      lookupVerified: true,
      receipt: first.receipt,
    });
  }

  const categoryCounts = Object.fromEntries([...new Set(samples.map((sample) => sample.category))].map((category) => [category, samples.filter((sample) => sample.category === category).length]));
  return json({
    protocol: PROTOCOL,
    status: "succeeded",
    projectId: env.PROJECT_ID,
    population: {
      count: samples.length,
      categoryCounts,
      construction: "caller-supplied deterministic contract-shaped tombstone corpus; not a claim of production traffic representativeness",
    },
    distribution: summary(bytes),
    objects,
    providerFactsAreNotAnyamLimits: true,
    credentialValues: "not-printed",
  });
}

async function cleanup(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const samples = parseSamples(body.samples);
  const keys = await Promise.all(samples.map((sample) => publicGatewayReplayArchiveKey(env.PROJECT_ID, sample.tombstone.requestId)));
  if (keys.some((key) => !key.startsWith(ARCHIVE_PREFIX))) throw new Error("cleanup key escaped the replay archive prefix");
  await env.PUBLIC_GATEWAY_REPLAY_ARCHIVE.delete(keys);
  const remaining: string[] = [];
  for (const key of keys) if (await env.PUBLIC_GATEWAY_REPLAY_ARCHIVE.head(key)) remaining.push(key);
  return json({
    protocol: PROTOCOL,
    status: remaining.length === 0 ? "succeeded" : "blocked",
    cleanup: {
      requestedKeys: keys.length,
      deletedKeys: keys.length - remaining.length,
      remainingKeys: remaining,
      exact: remaining.length === 0,
      prefix: ARCHIVE_PREFIX,
    },
    providerFactsAreNotAnyamLimits: true,
    credentialValues: "not-printed",
    recoveryAction: remaining.length === 0 ? "No recovery action is currently required." : "retry exact-key deletion after reconciling the disposable bucket inventory",
  }, remaining.length === 0 ? 200 : 503);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env)) return unauthorized();
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/measure") return await measure(request, env);
      if (request.method === "POST" && url.pathname === "/cleanup") return await cleanup(request, env);
      return json({ protocol: PROTOCOL, status: "blocked", code: "not_found", recoveryAction: "use POST /measure or POST /cleanup", credentialValues: "not-printed" }, 404);
    } catch (error) {
      return json({
        protocol: PROTOCOL,
        status: "blocked",
        error: error instanceof Error ? error.message : "qualification operation failed",
        recoveryAction: "inspect the visible error and retry only the same disposable qualification after reconciling the bucket",
        credentialValues: "not-printed",
      }, 422);
    }
  },
};
