import type { RunnerJob, RunnerAttempt } from "../kernel/contracts.ts";

/**
 * Portable parts of the Runner Result protocol.
 *
 * This module deliberately has no Node-only imports. The same canonical
 * message is used by the local Runner coordinator and by the Cloudflare
 * Authority boundary when it consumes a signed completion.
 */

export type RunnerResultMessageInput = {
  context: unknown;
  status: string;
  output: unknown;
  outputs: readonly unknown[];
  recoveryAction?: string;
};

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/** Shared credential-free signed context; callers must verify the enrolled
 * network boundary before issuing or accepting it. */
export function runnerResultContextClaims(input: { job: RunnerJob; attempt: RunnerAttempt }) {
  const { job, attempt } = input;
  return {
    protocol: "anyam.runner-result-context/v1" as const,
    replayId: `${job.id}:${attempt.id}`,
    jobId: job.id,
    attemptId: attempt.id,
    runnerId: attempt.runnerId ?? job.currentRunnerId ?? "runner:unassigned",
    leaseExpiresAt: attempt.leaseExpiresAt,
    inputManifestDigest: job.inputManifestDigest,
    sourceSpaceSnapshots: { ...job.sourceSpaceSnapshots },
    actionId: job.actionId,
    actionContractDigest: job.actionContractDigest,
    ...(job.verifierId ? { verifierId: job.verifierId } : {}),
    ...(job.verifierContractDigest ? { verifierContractDigest: job.verifierContractDigest } : {}),
    projectRevisionId: job.projectRevisionId,
    projectViewId: job.projectViewId,
    ...(job.changeRevisionId ? { changeRevisionId: job.changeRevisionId } : {}),
    ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
    policyVersion: job.policyVersion,
    authorizationEpoch: job.authorizationEpoch,
    capabilityGrantId: job.capabilityGrantId,
    networkEnforcement: job.networkEnforcement,
    networkBoundaryReceipt: job.networkBoundaryReceipt,
  };
}

export function runnerResultMessage(input: RunnerResultMessageInput): string {
  return `anyam.runner-result/v1|${stableJson({
    context: input.context,
    status: input.status,
    output: input.output,
    outputs: input.outputs,
    recoveryAction: input.recoveryAction,
  })}`;
}

export async function runnerResultDigest(input: { jobId: string; attemptId: string; result: unknown }): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson({ jobId: input.jobId, attemptId: input.attemptId, result: input.result }));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodePem(value: string): Uint8Array {
  const body = value.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  return decodeBase64Url(body);
}

/** Verify an Ed25519 signature using the Web Crypto API available in Workers and Node. */
export async function verifyRunnerResultSignature(input: { publicKey: string; message: string; signature: string }): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", decodePem(input.publicKey).buffer as ArrayBuffer, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, decodeBase64Url(input.signature).buffer as ArrayBuffer, new TextEncoder().encode(input.message).buffer as ArrayBuffer);
  } catch {
    return false;
  }
}
