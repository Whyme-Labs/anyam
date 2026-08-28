import assert from "node:assert/strict";
import test from "node:test";

import {
  MIRROR_HANDOFF_AUDIENCE,
  MIRROR_HANDOFF_TTL_MS,
  MIRROR_REPOSITORY_OBSERVATION_PROTOCOL,
  mirrorObservationDigest,
  parseMirrorRepositoryObservation,
  signMirrorIngestionHandoff,
  verifyMirrorIngestionHandoff,
  verifyMirrorRepositoryObservation,
  type MirrorIngestionCommand,
  type MirrorObservationClaims,
} from "../src/portability/mirror-observation.ts";

function observation(): MirrorObservationClaims {
  const claims: MirrorObservationClaims = {
    protocol: MIRROR_REPOSITORY_OBSERVATION_PROTOCOL,
    repositoryId: "repository:github:video-player",
    sourceSpaceId: "source:community",
    mirrorId: "mirror:github",
    proposalKey: "42",
    deliveryId: "delivery:42",
    provider: "github",
    remoteRepository: "acme/video-player",
    projectViewId: "project-view:public",
    objectFormat: "sha1",
    symbolicRef: "refs/heads/feature/codec",
    commitOid: "1".repeat(40),
    treeOid: "2".repeat(40),
    baseCommitOid: "3".repeat(40),
    ancestryVerified: true,
    observedAt: "2026-08-27T00:00:00.000Z",
    receipt: "provider=github; ancestry=verified; credentialMaterialStored=false",
  };
  return claims;
}

function command(): MirrorIngestionCommand {
  return {
    protocol: "anyam.authority-command/v1",
    command: "mirror.sync",
    idempotencyKey: "mirror:handoff:42",
    payload: {
      mirrorId: "mirror:github",
      delivery: { provider: "github", installationId: "installation:github-app", remoteRepository: "acme/video-player", deliveryId: "delivery:42", proposalKey: "42" },
      externalProposal: { provider: "github", installationId: "installation:github-app", remoteRepository: "acme/video-player", proposalKey: "42" },
      mirrorRepositoryObservations: { "source:community": { ...observation(), manifestDigest: mirrorObservationDigest(observation()) } },
    },
  };
}

test("mirror observations bind provider proposal identity and digest", () => {
  const claims = observation();
  const value = { ...claims, manifestDigest: mirrorObservationDigest(claims) };
  assert.equal(parseMirrorRepositoryObservation(value).valid, true);
  const verified = verifyMirrorRepositoryObservation({ observation: value, repositoryId: claims.repositoryId, sourceSpaceId: claims.sourceSpaceId, mirrorId: claims.mirrorId, proposalKey: claims.proposalKey, deliveryId: claims.deliveryId, provider: claims.provider, remoteRepository: claims.remoteRepository, projectViewId: claims.projectViewId, expectedCommitOid: claims.commitOid, expectedBaseCommitOid: claims.baseCommitOid });
  assert.equal(verified.valid, true);
  const forged = verifyMirrorRepositoryObservation({ observation: { ...value, commitOid: "4".repeat(40) }, repositoryId: claims.repositoryId, sourceSpaceId: claims.sourceSpaceId, mirrorId: claims.mirrorId, proposalKey: claims.proposalKey, deliveryId: claims.deliveryId, provider: claims.provider, remoteRepository: claims.remoteRepository, projectViewId: claims.projectViewId, expectedCommitOid: claims.commitOid, expectedBaseCommitOid: claims.baseCommitOid });
  assert.equal(forged.valid, false);
});

test("mirror ingestion handoff is signed, expiring, and command-scoped", async () => {
  const issuedAt = "2026-08-27T00:00:00.000Z";
  const expiresAt = new Date(Date.parse(issuedAt) + 60_000).toISOString();
  const now = Date.parse(issuedAt);
  const binding = { realmId: "realm:test", installationId: "installation:github-app", issuer: "github-app:installation:github-app", provider: "github", remoteRepository: "acme/video-player", mirrorId: "mirror:github", deliveryId: "delivery:42", proposalKey: "42", issuedAt, expiresAt, now } as const;
  const handoff = await signMirrorIngestionHandoff({ command: command(), keyId: "mirror-key-v1", nonce: "nonce:42", secret: "fixture-mirror-secret", ...binding });
  const verified = await verifyMirrorIngestionHandoff({ value: handoff, keyId: "mirror-key-v1", secret: "fixture-mirror-secret", expectedRealmId: binding.realmId, expectedInstallationId: binding.installationId, expectedAudience: MIRROR_HANDOFF_AUDIENCE, expectedIssuer: binding.issuer, expectedProvider: binding.provider, expectedRemoteRepository: binding.remoteRepository, expectedMirrorId: binding.mirrorId, expectedDeliveryId: binding.deliveryId, expectedProposalKey: binding.proposalKey, now });
  assert.equal(verified.valid, true);
  assert.equal(verified.valid && verified.keyRole, "active");
  const tampered = await verifyMirrorIngestionHandoff({ value: { ...handoff, command: { ...handoff.command, idempotencyKey: "mirror:tampered" } }, keyId: "mirror-key-v1", secret: "fixture-mirror-secret", now });
  assert.equal(tampered.valid, false);
  const audienceTampered = await verifyMirrorIngestionHandoff({ value: { ...handoff, audience: "wrong-audience" }, keyId: "mirror-key-v1", secret: "fixture-mirror-secret", now });
  assert.equal(audienceTampered.valid, false);
  assert.equal(!audienceTampered.valid && audienceTampered.code, "mirror_handoff_audience_invalid");
  for (const [field, value, expected] of [
    ["realmId", "realm:other", binding.realmId],
    ["installationId", "installation:other", binding.installationId],
    ["issuer", "github-app:other", binding.issuer],
    ["provider", "gitlab", binding.provider],
    ["remoteRepository", "other/video-player", binding.remoteRepository],
    ["mirrorId", "mirror:other", binding.mirrorId],
    ["deliveryId", "delivery:other", binding.deliveryId],
    ["proposalKey", "other", binding.proposalKey],
  ] as const) {
    const result = await verifyMirrorIngestionHandoff({ value: { ...handoff, [field]: value }, keyId: "mirror-key-v1", secret: "fixture-mirror-secret", [`expected${field[0]!.toUpperCase()}${field.slice(1)}`]: expected, now } as Parameters<typeof verifyMirrorIngestionHandoff>[0]);
    assert.equal(result.valid, false);
    assert.equal(!result.valid && result.code, "mirror_handoff_binding_mismatch");
  }
  const expired = await verifyMirrorIngestionHandoff({ value: handoff, keyId: "mirror-key-v1", secret: "fixture-mirror-secret", now: Date.parse(expiresAt) + 1 });
  assert.equal(expired.valid, false);
  assert.equal(!expired.valid && expired.code, "mirror_handoff_expired");
  const future = await verifyMirrorIngestionHandoff({ value: { ...handoff, issuedAt: "2026-08-27T00:00:31.000Z" }, keyId: "mirror-key-v1", secret: "fixture-mirror-secret", now });
  assert.equal(future.valid, false);
  assert.equal(!future.valid && future.code, "mirror_handoff_issued_in_future");
  const reversed = await verifyMirrorIngestionHandoff({ value: { ...handoff, expiresAt: issuedAt }, keyId: "mirror-key-v1", secret: "fixture-mirror-secret", now });
  assert.equal(reversed.valid, false);
  assert.equal(!reversed.valid && reversed.code, "mirror_handoff_time_reversed");
  const overlong = await verifyMirrorIngestionHandoff({ value: { ...handoff, expiresAt: "2026-08-27T00:10:00.000Z" }, keyId: "mirror-key-v1", secret: "fixture-mirror-secret", now });
  assert.equal(overlong.valid, false);
  assert.equal(!overlong.valid && overlong.code, "mirror_handoff_lifetime_exceeded");
  const credential = await verifyMirrorIngestionHandoff({ value: { ...handoff, command: { ...handoff.command, payload: { ...handoff.command.payload, externalProposal: { ...(handoff.command.payload.externalProposal as Record<string, unknown>), secret: "should-not-appear" } } } }, keyId: "mirror-key-v1", secret: "fixture-mirror-secret", now });
  assert.equal(credential.valid, false);
  assert.equal(!credential.valid && credential.code, "mirror_handoff_credential_material");
  assert.equal(JSON.stringify(credential).includes("should-not-appear"), false);
  const rotated = await signMirrorIngestionHandoff({ command: command(), keyId: "mirror-key-v0", nonce: "nonce:rotation", secret: "fixture-old-secret", ...binding });
  const rotation = await verifyMirrorIngestionHandoff({ value: rotated, keys: [{ id: "mirror-key-v1", secret: "fixture-mirror-secret", role: "active" }, { id: "mirror-key-v0", secret: "fixture-old-secret", role: "previous" }], now });
  assert.equal(rotation.valid, true);
  assert.equal(rotation.valid && rotation.keyRole, "previous");
  const unknown = await verifyMirrorIngestionHandoff({ value: rotated, keys: [{ id: "mirror-key-v1", secret: "fixture-mirror-secret", role: "active" }], now });
  assert.equal(unknown.valid, false);
  assert.equal(!unknown.valid && unknown.code, "mirror_handoff_key_unknown");
  assert.equal(MIRROR_HANDOFF_TTL_MS, 300_000);
});
