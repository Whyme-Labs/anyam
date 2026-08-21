import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubActionsBridgeAuthority,
  MemoryGitHubActionsBridgeReplayLedger,
  type GitHubActionsBridgeConnectionInput,
  type GitHubActionsOidcClaims,
  type GitHubActionsOidcVerifier,
} from "../src/portability/github-actions-bridge.ts";

const now = "2026-08-22T00:00:00.000Z";

function connectionInput(overrides: Partial<GitHubActionsBridgeConnectionInput> = {}): GitHubActionsBridgeConnectionInput {
  return {
    realmId: "realm:customer",
    projectId: "project:atlas",
    sourceSpaceId: "source:private",
    repositoryOwner: "acme",
    repositoryOwnerId: "774812",
    repository: "acme/private-platform",
    repositoryId: "92834123",
    mirrorId: "mirror:github",
    outboundSigningKeyId: "key:outbound",
    outboundSigningPublicKey: "public-key",
    workflowRef: "acme/private-platform/.github/workflows/anyam-bridge.yml@refs/heads/main",
    expectedJobWorkflowRef: null,
    ref: "refs/heads/main",
    audience: "https://source.acme.com/integrations/github",
    allowedEvents: ["push", "workflow_dispatch"],
    allowedOperations: ["inbound", "outbound"],
    expiresAt: "2026-08-22T01:00:00.000Z",
    ...overrides,
  };
}

function claims(overrides: Partial<GitHubActionsOidcClaims> = {}): GitHubActionsOidcClaims {
  return {
    issuer: "https://token.actions.githubusercontent.com",
    subject: "repo:acme/private-platform:ref:refs/heads/main",
    audience: "https://source.acme.com/integrations/github",
    repositoryOwner: "acme",
    repositoryOwnerId: "774812",
    repository: "acme/private-platform",
    repositoryId: "92834123",
    workflowRef: "acme/private-platform/.github/workflows/anyam-bridge.yml@refs/heads/main",
    workflowSha: "workflow-sha-1",
    ref: "refs/heads/main",
    eventName: "push",
    jti: "jti-1",
    runId: "run-1",
    issuedAt: "2026-08-21T23:59:00.000Z",
    expiresAt: "2026-08-22T00:05:00.000Z",
    notBefore: "2026-08-21T23:59:00.000Z",
    jobWorkflowRef: undefined,
    jobWorkflowSha: undefined,
    ...overrides,
  };
}

function verifier(value: GitHubActionsOidcClaims): GitHubActionsOidcVerifier {
  const claims = {
    iss: value.issuer,
    sub: value.subject,
    aud: value.audience,
    repository_owner: value.repositoryOwner,
    repository_owner_id: value.repositoryOwnerId,
    repository: value.repository,
    repository_id: value.repositoryId,
    workflow_ref: value.workflowRef,
    workflow_sha: value.workflowSha,
    ref: value.ref,
    event_name: value.eventName,
    jti: value.jti,
    run_id: value.runId,
    iat: value.issuedAt,
    exp: value.expiresAt,
    ...(value.notBefore === undefined ? {} : { nbf: value.notBefore }),
    ...(value.jobWorkflowRef === undefined ? {} : { job_workflow_ref: value.jobWorkflowRef }),
    ...(value.jobWorkflowSha === undefined ? {} : { job_workflow_sha: value.jobWorkflowSha }),
  };
  return { verify: async () => ({ status: "verified", claims, receipt: "fixture=github-oidc; signature=verified; liveProvider=not-qualified" }) };
}

function authority(clock: { value: string } = { value: now }): GitHubActionsBridgeAuthority {
  return new GitHubActionsBridgeAuthority({ now: () => clock.value, replayLedger: new MemoryGitHubActionsBridgeReplayLedger(() => clock.value) });
}

test("verified bridge exchange activates one connection and issues an operation-scoped capability", async () => {
  const value = authority();
  const pending = value.createPendingConnection(connectionInput());
  assert.equal(pending.status, "succeeded");
  if (pending.status !== "succeeded") return;

  const exchanged = await value.exchange({ connectionId: pending.value.id, operation: "inbound", token: "oidc-token-never-stored", verifier: verifier(claims()) });
  assert.equal(exchanged.status, "succeeded");
  if (exchanged.status !== "succeeded") return;
  assert.equal(exchanged.value.capability.operation, "inbound");
  assert.equal(exchanged.value.capability.canonicalWrite, false);
  assert.equal(exchanged.value.connection.status, "active");
  assert.equal(exchanged.value.connection.workflowSha, "workflow-sha-1");
  assert.equal(JSON.stringify(exchanged).includes("oidc-token-never-stored"), false);
  assert.match(exchanged.receipt, /credentialMaterialStored=false/);
});

test("replay and operation widening fail without issuing a second capability", async () => {
  const value = authority();
  const pending = value.createPendingConnection(connectionInput({ allowedOperations: ["inbound"] }));
  assert.equal(pending.status, "succeeded");
  if (pending.status !== "succeeded") return;
  const first = await value.exchange({ connectionId: pending.value.id, operation: "inbound", token: "token-1", verifier: verifier(claims()) });
  assert.equal(first.status, "succeeded");

  const replay = await value.exchange({ connectionId: pending.value.id, operation: "inbound", token: "token-2", verifier: verifier(claims()) });
  assert.equal(replay.status, "failed");
  if (replay.status === "failed") assert.equal(replay.code, "oidc_replay");

  const widened = await value.exchange({ connectionId: pending.value.id, operation: "outbound", token: "token-3", verifier: verifier(claims({ jti: "jti-3" })) });
  assert.equal(widened.status, "failed");
  if (widened.status === "failed") assert.equal(widened.code, "operation_denied");
});

test("workflow drift blocks the connection and invalidates an earlier capability", async () => {
  const value = authority();
  const pending = value.createPendingConnection(connectionInput());
  assert.equal(pending.status, "succeeded");
  if (pending.status !== "succeeded") return;
  const first = await value.exchange({ connectionId: pending.value.id, operation: "inbound", token: "token-1", verifier: verifier(claims()) });
  assert.equal(first.status, "succeeded");
  if (first.status !== "succeeded") return;

  const changed = await value.exchange({ connectionId: pending.value.id, operation: "inbound", token: "token-2", verifier: verifier(claims({ jti: "jti-2", workflowSha: "workflow-sha-changed" })) });
  assert.equal(changed.status, "failed");
  if (changed.status === "failed") assert.equal(changed.code, "workflow_changed");
  assert.equal(value.snapshot().connections[pending.value.id]?.status, "blocked");

  const authorization = value.authorize(first.value.capability.id, "inbound");
  assert.equal(authorization.status, "failed");
  if (authorization.status === "failed") assert.equal(authorization.code, "connection_blocked");
});

test("repository transfer, wrong audience, and wrong event are rejected without state mutation", async () => {
  const cases: Array<{ name: string; claim: Partial<GitHubActionsOidcClaims>; code: string }> = [
    { name: "repository transfer", claim: { repositoryOwnerId: "981247", jti: "jti-transfer" }, code: "repository_mismatch" },
    { name: "audience", claim: { audience: "https://other.example/mcp", jti: "jti-audience" }, code: "audience_mismatch" },
    { name: "event", claim: { eventName: "pull_request", jti: "jti-event" }, code: "event_denied" },
  ];
  for (const item of cases) {
    const value = authority();
    const pending = value.createPendingConnection(connectionInput());
    assert.equal(pending.status, "succeeded", item.name);
    if (pending.status !== "succeeded") continue;
    const result = await value.exchange({ connectionId: pending.value.id, operation: "inbound", token: `token-${item.name}`, verifier: verifier(claims(item.claim)) });
    assert.equal(result.status, "failed", item.name);
    if (result.status === "failed") assert.equal(result.code, item.code, item.name);
    assert.equal(value.snapshot().connections[pending.value.id]?.status, "pending", item.name);
  }
});

test("revocation and expiry are visible at capability authorization", async () => {
  const clock = { value: now };
  const value = authority(clock);
  const pending = value.createPendingConnection(connectionInput());
  assert.equal(pending.status, "succeeded");
  if (pending.status !== "succeeded") return;
  const exchanged = await value.exchange({ connectionId: pending.value.id, operation: "inbound", token: "token-1", verifier: verifier(claims()) });
  assert.equal(exchanged.status, "succeeded");
  if (exchanged.status !== "succeeded") return;

  const revoked = value.revokeConnection(pending.value.id, "owner requested disconnect");
  assert.equal(revoked.status, "succeeded");
  const revokedCheck = value.authorize(exchanged.value.capability.id, "inbound");
  assert.equal(revokedCheck.status, "failed");
  if (revokedCheck.status === "failed") assert.equal(revokedCheck.code, "connection_revoked");

  const second = authority(clock);
  const secondPending = second.createPendingConnection(connectionInput());
  assert.equal(secondPending.status, "succeeded");
  if (secondPending.status !== "succeeded") return;
  const secondExchange = await second.exchange({ connectionId: secondPending.value.id, operation: "inbound", token: "token-2", verifier: verifier(claims({ jti: "jti-2" })) });
  assert.equal(secondExchange.status, "succeeded");
  if (secondExchange.status !== "succeeded") return;
  clock.value = "2026-08-22T00:06:00.000Z";
  const expired = second.authorize(secondExchange.value.capability.id, "inbound");
  assert.equal(expired.status, "failed");
  if (expired.status === "failed") assert.equal(expired.code, "capability_expired");
});

test("persisted Bridge snapshot rejects a replay after coordinator restart", async () => {
  const first = authority();
  const pending = first.createPendingConnection(connectionInput());
  assert.equal(pending.status, "succeeded");
  if (pending.status !== "succeeded") return;
  const exchanged = await first.exchange({ connectionId: pending.value.id, operation: "inbound", token: "token-1", verifier: verifier(claims()) });
  assert.equal(exchanged.status, "succeeded");
  const restored = new GitHubActionsBridgeAuthority({ now: () => now, snapshot: first.snapshot() });
  const verification = await verifier(claims()).verify({ token: "never-stored", audience: connectionInput().audience });
  const replay = await restored.exchangeVerified({ connectionId: pending.value.id, operation: "inbound", verification });
  assert.equal(replay.status, "failed");
  if (replay.status === "failed") assert.equal(replay.code, "oidc_replay");
  assert.equal(JSON.stringify(first.snapshot()).includes("token-1"), false);
});

test("proposal capability is independently bound from inbound and outbound", async () => {
  const value = authority();
  const pending = value.createPendingConnection(connectionInput({ id: "github-bridge:proposal", allowedOperations: ["proposal"] }));
  assert.equal(pending.status, "succeeded");
  if (pending.status !== "succeeded") return;
  const exchanged = await value.exchange({ connectionId: pending.value.id, operation: "proposal", token: "proposal-token-never-stored", verifier: verifier(claims({ jti: "jti-proposal" })) });
  assert.equal(exchanged.status, "succeeded");
  if (exchanged.status === "succeeded") assert.equal(exchanged.value.capability.operation, "proposal");
  const inbound = await value.exchange({ connectionId: pending.value.id, operation: "inbound", token: "inbound-token-never-stored", verifier: verifier(claims({ jti: "jti-inbound" })) });
  assert.equal(inbound.status, "failed");
  if (inbound.status === "failed") assert.equal(inbound.code, "operation_denied");
});

test("OIDC verifier receipts cannot carry credential-shaped material", async () => {
  const value = authority();
  const pending = value.createPendingConnection(connectionInput());
  assert.equal(pending.status, "succeeded");
  if (pending.status !== "succeeded") return;
  const result = await value.exchangeVerified({ connectionId: pending.value.id, operation: "inbound", verification: { status: "verified", claims: {}, receipt: "token=secret-material" } });
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.code, "receipt_credential_material");
  assert.equal(value.snapshot().connections[pending.value.id]?.status, "pending");
});
