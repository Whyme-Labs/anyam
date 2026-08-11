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
  metadata?: unknown;
};

type DecodedPulledMessage = Omit<PulledMessage, "body"> & {
  body: Json;
  bodyEncoding: "object" | "json-text" | "base64-json";
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

async function pushQueue(queueUrl: string, queueToken: string, body: Json, label: string): Promise<Json> {
  return requestJson(`${queueUrl}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${queueToken}`, "content-type": "application/json" },
    body: JSON.stringify({ body, content_type: "json" }),
  }, label);
}

async function pullQueue(queueUrl: string, queueToken: string, visibilityTimeoutMs: number, jobId: string, label: string): Promise<DecodedPulledMessage> {
  const pulledResponse = await requestJson(`${queueUrl}/messages/pull`, {
    method: "POST",
    headers: { authorization: `Bearer ${queueToken}`, "content-type": "application/json" },
    body: JSON.stringify({ visibility_timeout_ms: visibilityTimeoutMs, batch_size: 10 }),
  }, label);
  const result = jsonObject(pulledResponse.result, `${label} result`);
  const messages = result.messages;
  if (!Array.isArray(messages)) throw new Error(`${label} returned no messages array`);
  const decodedMessages = messages.map((value): DecodedPulledMessage => {
    const message = jsonObject(value, "Queue message") as unknown as PulledMessage;
    const decoded = decodeQueueMessageBody(message.body);
    return { ...message, body: decoded.body, bodyEncoding: decoded.encoding };
  });
  const pulled = decodedMessages.find((value) => value.id && value.body.jobId === jobId);
  if (!pulled) throw new Error(`${label} did not return the expected job ${jobId}; leave the queue message for redelivery and inspect the cohort before retrying`);
  return pulled;
}

async function ackQueue(queueUrl: string, queueToken: string, leaseId: string, label: string): Promise<Json> {
  return requestJson(`${queueUrl}/messages/ack`, {
    method: "POST",
    headers: { authorization: `Bearer ${queueToken}`, "content-type": "application/json" },
    body: JSON.stringify({ acks: [{ lease_id: leaseId }], retries: [] }),
  }, label);
}

function jsonObject(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} was not a JSON object`);
  return value as Json;
}

function decodeQueueMessageBody(value: unknown): { body: Json; encoding: DecodedPulledMessage["bodyEncoding"] } {
  if (value && typeof value === "object" && !Array.isArray(value)) return { body: value as Json, encoding: "object" };
  if (typeof value !== "string") throw new Error("Queue message body was not a JSON object or encoded JSON string");

  try {
    return { body: jsonObject(JSON.parse(value), "Queue message body"), encoding: "json-text" };
  } catch {
    // Cloudflare's HTTP pull consumer returns JSON-content messages as RFC 4648
    // base64 text. Decode at this boundary so the rest of the qualification
    // protocol works with the original structured job envelope.
    for (const encoding of ["base64", "base64url"] as const) {
      try {
        const decoded = Buffer.from(value, encoding).toString("utf8");
        return { body: jsonObject(JSON.parse(decoded), "Queue message body"), encoding: "base64-json" };
      } catch {
        // Try the other supported base64 spelling before reporting the shape error.
      }
    }
  }

  throw new Error("Queue message body was not a JSON object or encoded JSON string");
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

async function requestExpectedFailure(url: string, init: RequestInit, expectedStatus: number, label: string): Promise<Json> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
  }
  if (response.status !== expectedStatus) throw new Error(`${label} returned HTTP ${response.status}; expected ${expectedStatus}: ${JSON.stringify(body)}`);
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
  const controlToken = required("ANYAM_QUALIFICATION_CONTROL_TOKEN");
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
  const projectViewId = "project-view:external-runner-qualification";
  const outputPaths = ["artifact/anyam-live-runner.txt"];
  const outputDisclosure = "project" as const;
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
    projectViewId,
    outputPaths,
    disclosure: outputDisclosure,
    leaseExpiresAt,
    receipt: "synthetic-input; canonicalWrite=false; outputDisclosure=project",
  };

  await requestJson(`${coordinatorJobUrl}/bind`, {
    method: "POST",
    headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
    body: JSON.stringify({ inputManifestDigest, sourceSnapshotDigest, projectViewId, outputRoot, outputPaths, disclosure: outputDisclosure }),
  }, "Owner manifest bind");

  await requestJson(`${queueUrl}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${queueToken}`, "content-type": "application/json" },
    body: JSON.stringify({ body: jobMessage, content_type: "json" }),
  }, "Queue push");

  const pulledResponse = await requestJson(`${queueUrl}/messages/pull`, {
    method: "POST",
    headers: { authorization: `Bearer ${queueToken}`, "content-type": "application/json" },
    body: JSON.stringify({ visibility_timeout_ms: visibilityTimeoutMs, batch_size: 10 }),
  }, "Queue pull");
  const result = jsonObject(pulledResponse.result, "Queue pull result");
  const messages = result.messages;
  if (!Array.isArray(messages)) throw new Error("Queue pull returned no messages array");
  const decodedMessages = messages.map((value): DecodedPulledMessage => {
    const message = jsonObject(value, "Queue message") as unknown as PulledMessage;
    const decoded = decodeQueueMessageBody(message.body);
    return { ...message, body: decoded.body, bodyEncoding: decoded.encoding };
  });
  const pulled = decodedMessages.find((value) => value.id && value.body.jobId === jobId);
  if (!pulled) throw new Error(`Queue pull did not return the expected job ${jobId}; leave the queue message for redelivery and inspect the cohort before retrying`);
  const pulledBody = pulled.body;

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
      projectViewId,
      outputPaths,
      disclosure: outputDisclosure,
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
  const disclosureRejection = await requestExpectedFailure(`${coordinatorJobUrl}/outputs`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ attemptId, path: artifactPath, kind: "artifact", disclosure: "restricted", digest: artifactDigest, contentBase64: artifactBytes.toString("base64url") }),
  }, 422, "Unauthorized disclosure output");
  const outputResponse = await requestJson(`${coordinatorJobUrl}/outputs`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ attemptId, path: artifactPath, kind: "artifact", disclosure: "project", digest: artifactDigest, contentBase64: artifactBytes.toString("base64url") }),
  }, "Runner output upload");
  const storedOutput = jsonObject(outputResponse.output, "Runner output response");

  const readBackResponse = await fetch(`${coordinatorJobUrl}/output?path=${encodeURIComponent(artifactPath)}`, { headers: { authorization: `Bearer ${credential}` } });
  if (!readBackResponse.ok) throw new Error(`R2 read-back returned HTTP ${readBackResponse.status}`);
  const readBackBytes = Buffer.from(await readBackResponse.arrayBuffer());
  const readBackDigest = digest(readBackBytes);
  if (readBackDigest !== artifactDigest) throw new Error(`R2 read-back digest mismatch: declared=${artifactDigest}; readBack=${readBackDigest}`);

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

  const revokedOutput = await requestExpectedFailure(`${coordinatorJobUrl}/outputs`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ attemptId, path: artifactPath, kind: "artifact", disclosure: outputDisclosure, digest: artifactDigest, contentBase64: artifactBytes.toString("base64url") }),
  }, 401, "Revoked credential output");

  const ackResponse = await requestJson(`${queueUrl}/messages/ack`, {
    method: "POST",
    headers: { authorization: `Bearer ${queueToken}`, "content-type": "application/json" },
    body: JSON.stringify({ acks: [{ lease_id: pulled.lease_id }], retries: [] }),
  }, "Queue acknowledgement");

  await pushQueue(queueUrl, queueToken, jobMessage, "Duplicate Queue push");
  const duplicatePulled = await pullQueue(queueUrl, queueToken, visibilityTimeoutMs, jobId, "Duplicate Queue pull");
  const duplicateClaim = await requestExpectedFailure(`${coordinatorJobUrl}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attemptId, runnerId, actionId, inputManifestDigest, sourceSnapshotDigest, outputRoot, projectViewId, outputPaths, disclosure: outputDisclosure, leaseExpiresAt, publicKey: publicKeyEncoded, challenge, signature: claimSignature }),
  }, 409, "Duplicate Runner claim");
  const duplicateAck = await ackQueue(queueUrl, queueToken, duplicatePulled.lease_id, "Duplicate Queue acknowledgement");

  const createControlAttempt = async (label: string, withArtifact: boolean, retryOf?: string) => {
    const controlJobId = `job:${label}-${randomUUID()}`;
    const controlAttemptId = `attempt:${randomUUID()}`;
    const controlRunnerId = `runner:mac-${label}-${randomUUID()}`;
    const controlOutputRoot = `outputs/${controlJobId}`;
    const controlOutputPaths = [withArtifact ? "artifact/anyam-retry-runner.txt" : "control/none.txt"];
    const controlSourceSnapshotDigest = digest(`anyam-live-qualification-source/${label}/v1`);
    const controlInputManifestDigest = digest(stableJson({ actionId, controlSourceSnapshotDigest, controlOutputRoot, controlRunnerId, retryOf: retryOf ?? null }));
    const controlKeys = generateKeyPairSync("ed25519");
    const controlPublicKey = controlKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    const controlChallenge = base64Url(Buffer.from(randomUUID()));
    const controlSignature = base64Url(sign(null, Buffer.from(`anyam.runner-claim/v1|${controlChallenge}`), controlKeys.privateKey));
    const controlManifest = { inputManifestDigest: controlInputManifestDigest, sourceSnapshotDigest: controlSourceSnapshotDigest, projectViewId, outputRoot: controlOutputRoot, outputPaths: controlOutputPaths, disclosure: outputDisclosure };
    const controlJobMessage = { protocol: "anyam.external-runner-qualification/v1", jobId: controlJobId, attemptId: controlAttemptId, runnerId: controlRunnerId, actionId, inputManifestDigest: controlInputManifestDigest, sourceSnapshotDigest: controlSourceSnapshotDigest, outputRoot: controlOutputRoot, projectViewId, outputPaths: controlOutputPaths, disclosure: outputDisclosure, ...(retryOf ? { retryOf } : {}), leaseExpiresAt, receipt: `synthetic-${label}; canonicalWrite=false; outputDisclosure=project` };
    const controlJobUrl = `${coordinatorUrl}/jobs/${encodeURIComponent(controlJobId)}`;
    await requestJson(`${controlJobUrl}/bind`, { method: "POST", headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" }, body: JSON.stringify(controlManifest) }, `${label} owner manifest bind`);
    await pushQueue(queueUrl, queueToken, controlJobMessage, `${label} Queue push`);
    const controlPulled = await pullQueue(queueUrl, queueToken, visibilityTimeoutMs, controlJobId, `${label} Queue pull`);
    const controlClaim = await requestJson(`${controlJobUrl}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attemptId: controlAttemptId, runnerId: controlRunnerId, actionId, ...controlManifest, leaseExpiresAt, publicKey: controlPublicKey, challenge: controlChallenge, signature: controlSignature }) }, `${label} Runner claim`);
    const controlCredential = requiredString(jsonObject(controlClaim.credential, `${label} claim credential`), "token");
    return { jobId: controlJobId, attemptId: controlAttemptId, runnerId: controlRunnerId, outputRoot: controlOutputRoot, outputPaths: controlOutputPaths, sourceSnapshotDigest: controlSourceSnapshotDigest, inputManifestDigest: controlInputManifestDigest, publicKey: controlPublicKey, privateKey: controlKeys.privateKey, jobUrl: controlJobUrl, pulled: controlPulled, credential: controlCredential };
  };

  const firstOutputPath = (attempt: { outputPaths: readonly string[] }, label: string): string => {
    const path = attempt.outputPaths[0];
    if (!path) throw new Error(`${label} control Attempt has no declared output path`);
    return path;
  };

  const cancellationAttempt = await createControlAttempt("cancel", false);
  const cancellationPath = firstOutputPath(cancellationAttempt, "Cancellation");
  const cancellationResponse = await requestJson(`${cancellationAttempt.jobUrl}/cancel`, { method: "POST", headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "live-qualification-cancellation" }) }, "Runner cancellation");
  const cancellationStatus = jsonObject(cancellationResponse.status, "Runner cancellation status");
  if (cancellationStatus.status !== "cancelled") throw new Error(`Coordinator did not record cancellation: ${JSON.stringify(cancellationStatus)}`);
  const cancellationCredentialRejection = await requestExpectedFailure(`${cancellationAttempt.jobUrl}/outputs`, { method: "POST", headers: { authorization: `Bearer ${cancellationAttempt.credential}`, "content-type": "application/json" }, body: JSON.stringify({ attemptId: cancellationAttempt.attemptId, path: cancellationPath, kind: "artifact", disclosure: outputDisclosure, digest: digest("cancelled-output"), contentBase64: Buffer.from("cancelled-output").toString("base64url") }) }, 401, "Cancelled credential output");
  const cancellationAck = await ackQueue(queueUrl, queueToken, cancellationAttempt.pulled.lease_id, "Cancellation Queue acknowledgement");

  const revocationAttempt = await createControlAttempt("revoke", false);
  const revocationPath = firstOutputPath(revocationAttempt, "Revocation");
  const revocationResponse = await requestJson(`${revocationAttempt.jobUrl}/revoke`, { method: "POST", headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "live-qualification-revocation" }) }, "Runner credential revocation");
  const revocationStatus = jsonObject(revocationResponse.status, "Runner revocation status");
  if (revocationStatus.status !== "revoked") throw new Error(`Coordinator did not record revocation: ${JSON.stringify(revocationStatus)}`);
  const revocationCredentialRejection = await requestExpectedFailure(`${revocationAttempt.jobUrl}/outputs`, { method: "POST", headers: { authorization: `Bearer ${revocationAttempt.credential}`, "content-type": "application/json" }, body: JSON.stringify({ attemptId: revocationAttempt.attemptId, path: revocationPath, kind: "artifact", disclosure: outputDisclosure, digest: digest("revoked-output"), contentBase64: Buffer.from("revoked-output").toString("base64url") }) }, 401, "Revoked credential output");
  const revocationAck = await ackQueue(queueUrl, queueToken, revocationAttempt.pulled.lease_id, "Revocation Queue acknowledgement");

  const retryAttempt = await createControlAttempt("retry", true, cancellationAttempt.jobId);
  const retryBytes = Buffer.from(`Anyam external Runner retry qualification\nretryOf=${cancellationAttempt.jobId}\njob=${retryAttempt.jobId}\nattempt=${retryAttempt.attemptId}\n`);
  const retryPath = firstOutputPath(retryAttempt, "Retry");
  const retryDigest = digest(retryBytes);
  const retryOutput = await requestJson(`${retryAttempt.jobUrl}/outputs`, { method: "POST", headers: { authorization: `Bearer ${retryAttempt.credential}`, "content-type": "application/json" }, body: JSON.stringify({ attemptId: retryAttempt.attemptId, path: retryPath, kind: "artifact", disclosure: outputDisclosure, digest: retryDigest, contentBase64: retryBytes.toString("base64url") }) }, "Retry output upload");
  const retryReadBack = await fetch(`${retryAttempt.jobUrl}/output?path=${encodeURIComponent(retryPath)}`, { headers: { authorization: `Bearer ${retryAttempt.credential}` } });
  if (!retryReadBack.ok) throw new Error(`Retry R2 read-back returned HTTP ${retryReadBack.status}`);
  const retryReadBackBytes = Buffer.from(await retryReadBack.arrayBuffer());
  const retryReadBackDigest = digest(retryReadBackBytes);
  if (retryReadBackDigest !== retryDigest) throw new Error(`Retry R2 read-back digest mismatch: declared=${retryDigest}; readBack=${retryReadBackDigest}`);
  const retryResultEnvelope = { jobId: retryAttempt.jobId, attemptId: retryAttempt.attemptId, status: "succeeded", outputs: [{ path: retryPath, kind: "artifact", disclosure: outputDisclosure, digest: retryDigest, bytes: retryBytes.byteLength }] };
  const retryResultSignature = base64Url(sign(null, Buffer.from(`anyam.runner-result/v1|${stableJson(retryResultEnvelope)}`), retryAttempt.privateKey));
  const retryCompletion = await requestJson(`${retryAttempt.jobUrl}/result`, { method: "POST", headers: { authorization: `Bearer ${retryAttempt.credential}`, "content-type": "application/json" }, body: JSON.stringify({ ...retryResultEnvelope, signature: retryResultSignature }) }, "Retry Runner result");
  const retryStatus = jsonObject(retryCompletion.status, "Retry completion status");
  if (retryStatus.status !== "succeeded") throw new Error(`Coordinator did not accept the retry Result: ${JSON.stringify(retryStatus)}`);
  const retryAck = await ackQueue(queueUrl, queueToken, retryAttempt.pulled.lease_id, "Retry Queue acknowledgement");

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
    queue: { messageId: pulled.id, messageIdDigest: digest(pulled.id), attempts: pulled.attempts, batchSize: 10, bodyEncoding: pulled.bodyEncoding, leaseId: "[redacted]", leaseIdDigest: digest(pulled.lease_id), ack: jsonObject(ackResponse.result ?? ackResponse, "Queue acknowledgement result") },
    input: { actionId, inputManifestDigest, sourceSnapshotDigest, projectViewId, outputPaths, disclosure: outputDisclosure, queueBodyJobId: pulledBody.jobId },
    output: { path: artifactPath, digest: artifactDigest, readBackDigest, bytes: artifactBytes.byteLength, coordinatorStored: storedOutput },
    coordinator: { status: resultStatus.status, resultDigest: completeResponse.resultDigest, receipt: completeResponse.receipt, disclosureRejection, revokedCredentialRejection: revokedOutput },
    residuals: {
      duplicate: { messageId: duplicatePulled.id, attempts: duplicatePulled.attempts, claimRejection: duplicateClaim, ack: jsonObject(duplicateAck.result ?? duplicateAck, "Duplicate Queue acknowledgement result") },
      cancellation: { jobId: cancellationAttempt.jobId, status: cancellationStatus, credentialRejection: cancellationCredentialRejection, ack: jsonObject(cancellationAck.result ?? cancellationAck, "Cancellation Queue acknowledgement result") },
      revocation: { jobId: revocationAttempt.jobId, status: revocationStatus, credentialRejection: revocationCredentialRejection, ack: jsonObject(revocationAck.result ?? revocationAck, "Revocation Queue acknowledgement result") },
      retry: { jobId: retryAttempt.jobId, retryOf: cancellationAttempt.jobId, status: retryStatus, output: retryOutput, readBackDigest: retryReadBackDigest, ack: jsonObject(retryAck.result ?? retryAck, "Retry Queue acknowledgement result") },
    },
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
