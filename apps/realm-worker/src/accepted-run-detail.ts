import type { AuthorityPlaneSnapshot } from "../../../src/cloudflare/authority-plane.ts";
import { runnerResultContextClaims, runnerResultDigest, runnerResultMessage, verifyRunnerResultSignature } from "../../../src/execution/runner-proof.ts";
import { AuthorityDisclosure } from "./authority-disclosure.ts";
import { scanCredentialMaterial } from "../../../src/security/credential-material.ts";

const same = (a: unknown, b: unknown): boolean => {
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, normalize(entry)])) : value;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
};

/** Fixed sealed detail contract. Only an active Realm-wide human owner with
 * complete current Source access may read the accepted signed context. This
 * does not prove the body behind an opaque input-manifest digest or disclose
 * unsigned Job metadata, raw logs, provider receipts or credential handles. */
export async function acceptedOwnerRunDetail(state: AuthorityPlaneSnapshot, disclosure: AuthorityDisclosure, runId: string) {
  if (!disclosure.ownerDetails()) return undefined;
  const visibleRun = disclosure.run(runId); const run = state.runs[runId]; const detail = state.runDetails[runId];
  if (!run || !visibleRun || !detail || detail.protocol !== "anyam.accepted-run-detail/v1" || detail.audience !== "realm-owner" || detail.runId !== runId) return undefined;
  try {
    const { job, attempt, result, runnerProfile } = detail;
    const enrolled = state.runnerProfiles[runnerProfile.id]; const storedAttempt = state.runnerAttempts[attempt.id];
    const view = state.projectViews[run.projectViewId];
    const revision = run.changeRevisionId ? state.changeRevisions[run.changeRevisionId] : undefined;
    const snapshots = revision?.sourceSpaceSnapshots ?? state.projectRevisions[run.projectRevisionId]?.sourceSpaceSnapshots;
    if (!enrolled || enrolled.publicKey !== runnerProfile.publicKey || enrolled.profileDigest !== runnerProfile.profileDigest || !storedAttempt || !same(storedAttempt, attempt)
      || !view || job.projectId !== view.projectId || job.runId !== runId || attempt.runId !== runId || attempt.jobId !== job.id || run.attemptId !== attempt.id || run.runnerId !== runnerProfile.id
      || job.currentAttemptId !== attempt.id || job.currentRunnerId !== runnerProfile.id || attempt.runnerId !== runnerProfile.id || attempt.resultDigest !== detail.resultDigest
      || job.state !== result.status || attempt.state !== result.status || run.status !== result.status
      || job.projectRevisionId !== run.projectRevisionId || job.projectViewId !== run.projectViewId || job.workspaceId !== run.workspaceId || job.changeRevisionId !== run.changeRevisionId
      || job.actionId !== run.actionId || job.actionContractDigest !== run.actionContractDigest || job.verifierId !== run.verifierId || job.verifierContractDigest !== run.verifierContractDigest
      || job.policyVersion !== run.policyVersion || job.capabilityGrantId !== run.capabilityGrantId || !job.networkEnforcement || !job.networkBoundaryReceipt || !snapshots
      || new Set(view.visibleSourceSpaceIds).size !== view.visibleSourceSpaceIds.length || Object.keys(job.sourceSpaceSnapshots).length !== view.visibleSourceSpaceIds.length || view.visibleSourceSpaceIds.some(id => job.sourceSpaceSnapshots[id] !== snapshots[id])
      || run.outputDigest !== result.output.outputDigest || !same(run.inputDigests, result.output.inputDigests) || !same(run.outputDigests, result.output.outputDigests)
      || !same(job.inputDigests, result.output.inputDigests) || !same(result.context, runnerResultContextClaims({ job, attempt }))) return undefined;
    const message = runnerResultMessage({ context: result.context, status: result.status, output: result.output, outputs: result.outputs, ...(result.recoveryAction ? { recoveryAction: result.recoveryAction } : {}) });
    if (!await verifyRunnerResultSignature({ publicKey: enrolled.publicKey, message, signature: result.signature }) || await runnerResultDigest({ jobId: job.id, attemptId: attempt.id, result }) !== detail.resultDigest) return undefined;
    const value = { protocol: "anyam.owner-run-detail/v1", audience: "realm-owner", disclosure: "authorized-detail", run: visibleRun,
      context: { jobId: job.id, attemptId: attempt.id, runnerId: runnerProfile.id, actionId: job.actionId, actionContractDigest: job.actionContractDigest,
        ...(job.verifierId ? { verifierId: job.verifierId } : {}), ...(job.verifierContractDigest ? { verifierContractDigest: job.verifierContractDigest } : {}),
        inputManifestDigest: job.inputManifestDigest, sourceSpaceSnapshots: { ...job.sourceSpaceSnapshots }, inputDigests: [...result.output.inputDigests], outputDigests: [...result.output.outputDigests], outputDigest: result.output.outputDigest },
      proof: { resultDigest: detail.resultDigest, signatureVerified: true }, receipt: "authority=coordinator; detail=accepted-signed-context; audience=realm-owner; currentSourcePolicy=required; rawLogs=not-disclosed; inputManifestBody=not-qualified" };
    return scanCredentialMaterial(value, "runDetail") ? undefined : value;
  } catch (error) {
    // Malformed stored proof is unavailable; operational failures propagate
    // to the endpoint's distinct, coordinate-free 503 response.
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}
