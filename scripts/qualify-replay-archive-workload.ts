import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

type JsonObject = Record<string, unknown>;

const protocol = "anyam.replay-archive-workload-qualification/v1" as const;
const projectId = "project:anyam-p3-28-replay-workload-20260811";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function timestamp(index: number): string {
  return `2026-08-11T00:${String(index).padStart(2, "0")}:00.000Z`;
}

function sample(category: string, index: number, options?: { longFields?: boolean; retryable?: boolean; provider?: boolean }): JsonObject {
  const suffix = String(index).padStart(4, "0");
  const requestId = options?.longFields
    ? `request:replay-workload:${category}:${suffix}:${"r".repeat(96)}`
    : `request:replay-workload:${category}:${suffix}`;
  const contributionId = options?.longFields
    ? `contribution:replay-workload:${category}:${suffix}:${"c".repeat(96)}`
    : `contribution:replay-workload:${category}:${suffix}`;
  const recordedAt = timestamp(index);
  const receipt = options?.longFields
    ? `ledger=anyam.public-gateway-ledger/v1; retentionClass=${options.retryable ? "retryable-window" : "terminal-denial"}; provider=${options.provider ? "customer-abuse-adapter" : "customer-gateway"}; detail=${"x".repeat(256)}`
    : `ledger=anyam.public-gateway-ledger/v1; retentionClass=${options?.retryable ? "retryable-window" : "terminal-denial"}; provider=${options?.provider ? "customer-abuse-adapter" : "customer-gateway"}; request=${requestId}; replayIndex=retained`;
  return {
    category,
    tombstone: {
      requestId,
      payloadDigest: digest(`payload:${category}:${index}`),
      contributionId,
      originalStatus: "denied",
      recordedAt,
      compactedAt: "2026-08-11T00:30:00.000Z",
      exportDigest: digest(`export:${category}:${index}`),
      receipt,
    },
  };
}

function samples(): JsonObject[] {
  const result: JsonObject[] = [];
  for (let index = 1; index <= 6; index += 1) result.push(sample("terminal-denial", index));
  for (let index = 1; index <= 6; index += 1) result.push(sample("retryable-window", index, { retryable: true }));
  for (let index = 1; index <= 6; index += 1) result.push(sample("provider-outcome", index, { provider: true }));
  for (let index = 1; index <= 6; index += 1) result.push(sample("long-field-contract-shape", index, { longFields: true }));
  return result;
}

function sourceSnapshot(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

async function call(input: { url: string; token: string; path: string; body: JsonObject }): Promise<{ httpStatus: number; body: JsonObject }> {
  const response = await fetch(`${input.url.replace(/\/$/, "")}${input.path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.body),
  });
  return { httpStatus: response.status, body: json(await response.json()) };
}

async function run(): Promise<void> {
  const url = required("ANYAM_REPLAY_ARCHIVE_WORKLOAD_URL");
  const token = required("ANYAM_REPLAY_ARCHIVE_QUALIFICATION_TOKEN");
  const bucket = required("ANYAM_REPLAY_ARCHIVE_BUCKET");
  const population = samples();
  const startedAt = new Date().toISOString();
  let measurement: { httpStatus: number; body: JsonObject } | undefined;
  let cleanup: { httpStatus: number; body: JsonObject } | undefined;

  try {
    measurement = await call({ url, token, path: "/measure", body: { samples: population } });
  } finally {
    cleanup = await call({ url, token, path: "/cleanup", body: { samples: population } });
  }

  const measurementSucceeded = measurement.httpStatus >= 200 && measurement.httpStatus < 300 && measurement.body.status === "succeeded";
  const cleanupSucceeded = cleanup.httpStatus >= 200 && cleanup.httpStatus < 300 && cleanup.body.status === "succeeded";
  const status = measurementSucceeded && cleanupSucceeded ? "succeeded" : "blocked";
  console.log(JSON.stringify({
    protocol,
    status,
    bucket,
    projectId,
    sourceSnapshot: sourceSnapshot(),
    startedAt,
    finishedAt: new Date().toISOString(),
    populationMethod: "contract-shaped-stratified-sample-v1; four explicit classes; six samples per class; sample is not production traffic",
    measurement: { httpStatus: measurement.httpStatus, body: measurement.body },
    cleanup: { httpStatus: cleanup.httpStatus, body: cleanup.body },
    providerFactsAreNotAnyamLimits: true,
    credentialValues: "not-printed",
    recoveryAction: status === "succeeded" ? "No recovery action is currently required." : "inspect the named response and reconcile the disposable bucket before retrying the same population",
  }, null, 2));
  if (status !== "succeeded") process.exitCode = 2;
}

try {
  await run();
} catch (error) {
  console.error(JSON.stringify({
    protocol,
    status: "blocked",
    error: error instanceof Error ? error.message : "replay archive workload qualification failed",
    credentialValues: "not-printed",
    recoveryAction: "set the named qualification inputs and retry only after reconciling the disposable bucket",
  }, null, 2));
  process.exitCode = 2;
}
