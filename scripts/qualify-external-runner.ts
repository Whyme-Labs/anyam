import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { arch, freemem, platform, release, totalmem } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;

type PulledMessage = {
  body: unknown;
  id: string;
  attempts: number;
  lease_id: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; set it in the same terminal that runs this qualification`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Json).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stable(value)) ?? "null";
}

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function base64Url(value: Uint8Array | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function numberEnv(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer; received ${JSON.stringify(process.env[name])}`);
  return value;
}

function jsonObject(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} was not a JSON object`);
  return value as Json;
}

async function requestJson(url: string, init: RequestInit, label: string): Promise<Json> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return jsonObject(body, label);
}

function diskAvailableBytes(): number | undefined {
  try {
    const output = execFileSync("df", ["-k", "."], { encoding: "utf8" }).trim().split("\n").at(-1)?.trim().split(/\s+/);
    const availableKiB = Number(output?.at(-3));
    return Number.isFinite(availableKiB) ? availableKiB * 1024 : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const queueId = required("ANYAM_QUALIFICATION_QUEUE_ID");
  const queueToken = required("ANYAM_QUALIFICATION_CF_API_TOKEN");
  const coordinatorUrl = required("ANYAM_QUALIFICATION_COORDINATOR_URL").replace(/\/$/, "");
  const leaseExpiresAt = required("ANYAM_QUALIFICATION_LEASE_EXPIRES_AT");
  const visibilityTimeoutMs = numberEnv("ANYAM_QUALIFICATION_VISIBILITY_TIMEOUT_MS");
  if (!Number.isFinite(Date.parse(leaseExpiresAt)) || Date.parse(leaseExpiresAt) <= Date.now()) throw new Error("ANYAM_QUALIFICATION_LEASE_EXPIRES_AT must be a future ISO timestamp");

  const startedAt = new Date().toISOString();
  const processBefore = process.resourceUsage();
  const memoryBefore = process.memoryUsage();
  const freeMemoryBefore = freemem();
  const runnerId = `runner:mac-${randomUUID()}`;
  const jobId = `job:live-${randomUUID()}`;
  const attemptId = `attempt:${randomUUID()}`;
  const actionId = "action:cli-archive";
  const outputRoot = `outputs/${jobId}`;
  const sourceSnapshotDigest = digest("anyam-live-qualification-source/v1");
  const inputManifestDigest = digest(stableJson({ actionId, sourceSnapshotDigest, outputRoot, runnerId }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyEncoded = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const challenge = base64Url(Buffer.from(randomUUID()));
  const claimMessage = `anyam.runner-claim/v1|${challenge}`;
  const claimSignature = base64Url(sign(null, Buffer.from(claimMessage), privateKey));
  const queueUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}`;
  const coordinatorJobUrl = `${coordinatorUrl}/jobs/${encodeURIComponent(jobId)}`;
  const jobMessage = {
    protocol: "anyam.external-runner-qualification/v1",
    jobId,
    attemptId,
    runnerId,
    actionId,
    inputManifestDigest,
    sourceSnapshotDigest,
    outputRoot,
    leaseExpiresAt,
    receipt: "synthetic-input; canonicalWrite=false; outputDisclosure=project",
  };

  await requestJson(`${queueUrl}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${queueToken}`, "content-type": "application/json" },
    body: JSON.stringify({ body: jobMessage, content_type: "json" }),
  }, "Queue push");

  const pulledResponse = await requestJson(`${queueUrl}/messages/pull`, {
    method: "POST",
    headers: { authorization: `Bearer ${queueToken}`, "content-type": "application/json" },
    body: JSON.stringify({ visibility_timeout_ms: visibilityTimeoutMs, batch_size: 1 }),
  }, "Queue pull");
  const result = jsonObject(pulledResponse.result, "Queue pull result");
  const messages = result.messages;
  if (!Array.isArray(messages)) throw new Error("Queue pull returned no messages array");
  const pulled = messages.map((value) => jsonObject(value, "Queue message") as unknown as PulledMessage).find((value) => value.id && jsonObject(value.body, "Queue message body").jobId === jobId);
  if (!pulled) throw new Error(`Queue pull did not return the expected job ${jobId}; leave the queue message for redelivery and inspect the cohort before retrying`);
  const pulledBody = jsonObject(pulled.body, "Queue message body");

  const claimResponse = await requestJson(`${coordinatorJobUrl}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      attemptId,
      runnerId,
      actionId,
      inputManifestDigest,
      sourceSnapshotDigest,
      outputRoot,
      leaseExpiresAt,
      publicKey: publicKeyEncoded,
      challenge,
      signature: claimSignature,
    }),
  }, "Runner claim");
  const credentialEnvelope = jsonObject(claimResponse.credential, "Runner claim credential");
  const credential = requiredString(credentialEnvelope, "token");

  const artifactBytes = Buffer.from(`Anyam external Runner qualification\njob=${jobId}\nattempt=${attemptId}\n`);
  const artifactPath = "artifact/anyam-live-runner.txt";
  const artifactDigest = digest(artifactBytes);
  const outputResponse = await requestJson(`${coordinatorJobUrl}/outputs`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ attemptId, path: artifactPath, kind: "artifact", disclosure: "project", digest: artifactDigest, contentBase64: artifactBytes.toString("base64url") }),
  }, "Runner output upload");
  const storedOutput = jsonObject(outputResponse.output, "Runner output response");

  const resultEnvelope = {
    jobId,
    attemptId,
    status: "succeeded",
    outputs: [{ path: artifactPath, kind: "artifact", disclosure: "project", digest: artifactDigest, bytes: artifactBytes.byteLength }],
  };
  const resultMessage = `anyam.runner-result/v1|${stableJson(resultEnvelope)}`;
  const resultSignature = base64Url(sign(null, Buffer.from(resultMessage), privateKey));
  const completeResponse = await requestJson(`${coordinatorJobUrl}/result`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ ...resultEnvelope, signature: resultSignature }),
  }, "Runner result");
  const resultStatus = jsonObject(completeResponse.status, "Runner completion status");
  if (resultStatus.status !== "succeeded") throw new Error(`Coordinator did not accept a succeeded Result: ${JSON.stringify(resultStatus)}`);

  const readBackResponse = await fetch(`${coordinatorJobUrl}/output?path=${encodeURIComponent(artifactPath)}`, { headers: { authorization: `Bearer ${credential}` } });
  if (!readBackResponse.ok) throw new Error(`R2 read-back returned HTTP ${readBackResponse.status}`);
  const readBackBytes = Buffer.from(await readBackResponse.arrayBuffer());
  const readBackDigest = digest(readBackBytes);
  if (readBackDigest !== artifactDigest) throw new Error(`R2 read-back digest mismatch: declared=${artifactDigest}; readBack=${readBackDigest}`);

  const ackResponse = await requestJson(`${queueUrl}/messages/ack`, {
    method: "POST",
    headers: { authorization: `Bearer ${queueToken}`, "content-type": "application/json" },
    body: JSON.stringify({ acks: [{ lease_id: pulled.lease_id }], retries: [] }),
  }, "Queue acknowledgement");

  const statusResponse = await requestJson(`${coordinatorJobUrl}/status`, { method: "GET" }, "Coordinator status");
  const targetRepository = optional("ANYAM_GITHUB_TARGET_REPOSITORY");
  const targetTag = optional("ANYAM_GITHUB_RELEASE_TAG");
  const targetReceipt = targetRepository && targetTag
    ? await publishGitHubTarget({ repository: targetRepository, tag: targetTag, bytes: readBackBytes, digest: readBackDigest })
    : { status: "not-run", reason: "set ANYAM_GITHUB_TARGET_REPOSITORY and ANYAM_GITHUB_RELEASE_TAG for the disposable GitHub Release Target" };

  const finishedAt = new Date().toISOString();
  const processAfter = process.resourceUsage();
  const memoryAfter = process.memoryUsage();
  console.log(JSON.stringify({
    protocol: "anyam.external-runner-qualification/v1",
    status: "succeeded",
    cohort: optional("ANYAM_COHORT_ID") ?? "anyam-p3-14-live-20260809",
    jobId,
    attemptId,
    runnerId,
    queue: { messageId: pulled.id, messageIdDigest: digest(pulled.id), attempts: pulled.attempts, leaseId: "[redacted]", leaseIdDigest: digest(pulled.lease_id), ack: jsonObject(ackResponse.result ?? ackResponse, "Queue acknowledgement result") },
    input: { actionId, inputManifestDigest, sourceSnapshotDigest, queueBodyJobId: pulledBody.jobId },
    output: { path: artifactPath, digest: artifactDigest, readBackDigest, bytes: artifactBytes.byteLength, coordinatorStored: storedOutput },
    coordinator: { status: resultStatus.status, resultDigest: completeResponse.resultDigest, receipt: completeResponse.receipt },
    target: targetReceipt,
    host: { platform: platform(), arch: arch(), release: release(), totalMemoryBytes: totalmem(), freeMemoryBeforeBytes: freeMemoryBefore, freeMemoryAfterBytes: freemem(), rssBeforeBytes: memoryBefore.rss, rssAfterBytes: memoryAfter.rss, processUserMicros: processAfter.userCPUTime - processBefore.userCPUTime, processSystemMicros: processAfter.systemCPUTime - processBefore.systemCPUTime, diskAvailableBeforeBytes: diskAvailableBytes(), diskAvailableAfterBytes: diskAvailableBytes(), networkBytes: "not-observed" },
    timing: { startedAt, finishedAt, elapsedMs: Date.parse(finishedAt) - Date.parse(startedAt), visibilityTimeoutMs, leaseExpiresAt },
    cleanup: { required: true, resources: ["Queue", "R2 output prefix", "qualification Worker", ...(targetRepository ? ["GitHub repository/release"] : [])], authority: "owner" },
    credentialFree: true,
    canonicalWrite: false,
    providerFactsAreNotAnyamLimits: true,
  }, null, 2));
}

function requiredString(value: Json, field: string): string {
  const item = value[field];
  if (typeof item !== "string" || item.length === 0) throw new Error(`${field} missing from coordinator response`);
  return item;
}

async function publishGitHubTarget(input: { repository: string; tag: string; bytes: Buffer; digest: string }): Promise<Json> {
  const directory = mkdtempSync(join(tmpdir(), "anyam-target-"));
  const filename = "anyam-live-runner.txt";
  const artifactPath = join(directory, filename);
  writeFileSync(artifactPath, input.bytes, { mode: 0o600 });
  try {
    const create = runGh(["release", "create", input.tag, "--repo", input.repository, "--title", input.tag, "--notes", "Disposable Anyam external Runner qualification Target."]);
    const upload = runGh(["release", "upload", input.tag, artifactPath, "--repo", input.repository]);
    const downloadDirectory = mkdtempSync(join(tmpdir(), "anyam-target-download-"));
    try {
      runGh(["release", "download", input.tag, "--repo", input.repository, "--pattern", filename, "--dir", downloadDirectory]);
      const downloaded = readFileSync(join(downloadDirectory, filename));
      const downloadedDigest = digest(downloaded);
      let duplicateUpload = "not-tested";
      try {
        runGh(["release", "upload", input.tag, artifactPath, "--repo", input.repository]);
        duplicateUpload = "unexpected-success";
      } catch {
        duplicateUpload = "rejected";
      }
      return { status: downloadedDigest === input.digest && duplicateUpload === "rejected" ? "succeeded" : "failed", repository: input.repository, tag: input.tag, sourceDigest: input.digest, downloadedDigest, duplicateUpload, createReceipt: create, uploadReceipt: upload };
    } finally {
      rmSync(downloadDirectory, { recursive: true, force: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runGh(args: readonly string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "external Runner qualification failed";
  console.error(JSON.stringify({ protocol: "anyam.external-runner-qualification/v1", status: "blocked", error: message, credentialValues: "not-printed", recoveryAction: "inspect the named provider operation and retry only after reconciling the Queue lease and coordinator status" }, null, 2));
  process.exitCode = 1;
});
