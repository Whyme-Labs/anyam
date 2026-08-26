import assert from "node:assert/strict";
import test from "node:test";

import {
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
      externalProposal: { proposalKey: "42" },
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
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const handoff = await signMirrorIngestionHandoff({ command: command(), keyId: "mirror-key-v1", nonce: "nonce:42", expiresAt, secret: "fixture-mirror-secret" });
  const verified = await verifyMirrorIngestionHandoff({ value: handoff, keyId: "mirror-key-v1", secret: "fixture-mirror-secret" });
  assert.equal(verified.valid, true);
  const tampered = await verifyMirrorIngestionHandoff({ value: { ...handoff, command: { ...handoff.command, idempotencyKey: "mirror:tampered" } }, keyId: "mirror-key-v1", secret: "fixture-mirror-secret" });
  assert.equal(tampered.valid, false);
  const expired = await verifyMirrorIngestionHandoff({ value: handoff, keyId: "mirror-key-v1", secret: "fixture-mirror-secret", now: Date.parse(expiresAt) + 1 });
  assert.equal(expired.valid, false);
});
