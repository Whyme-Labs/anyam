import { readFile } from "node:fs/promises";

import { validateRealTeamGate } from "../src/qualification/real-team-gate.ts";

const evidencePath = process.argv[2];
if (!evidencePath) {
  console.log(JSON.stringify({ protocol: "anyam.real-team-adoption-gate/v1", status: "blocked", blockers: [{ key: "evidence.path", message: "No real-team evidence bundle was supplied.", nextAction: "run this command with the path to the owner-controlled evidence JSON" }], credentialValues: "not-printed", canonicalWrite: false, receipt: "evidence=missing; human-cohort=not-verified; production-operations=not-verified; credentialValues=not-printed; canonicalWrite=false" }, null, 2));
  process.exitCode = 2;
} else {
  try {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as unknown;
    const result = await validateRealTeamGate(evidence, {
      authoritySigningKeys: await loadSigningKeys(process.env.ANYAM_REAL_TEAM_AUTHORITY_KEY_FILE, "authority export"),
      attestationSigningKeys: await loadSigningKeys(process.env.ANYAM_REAL_TEAM_ATTESTATION_KEYS_FILE, "external attestation"),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ready") process.exitCode = 2;
  } catch (error) {
    console.log(JSON.stringify({ protocol: "anyam.real-team-adoption-gate/v1", status: "blocked", blockers: [{ key: "evidence.read", message: error instanceof Error ? error.message : String(error), nextAction: "provide one readable owner-controlled evidence JSON bundle and retry the same validation" }], credentialValues: "not-printed", canonicalWrite: false, receipt: "evidence=unreadable; transition=not-applied; credentialValues=not-printed; canonicalWrite=false" }, null, 2));
    process.exitCode = 2;
  }
}

async function loadSigningKeys(path: string | undefined, kind: string): Promise<Readonly<Record<string, string>>> {
  if (!path) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${kind} key file must contain a JSON object mapping signingKeyId to PEM public key`);
    const entries = Object.entries(parsed);
    const invalid = entries.find(([, value]) => typeof value !== "string" || value.trim().length === 0);
    if (invalid) throw new Error(`${kind} key file contains an empty public key for ${invalid[0]}`);
    return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
  } catch (error) {
    throw new Error(`${kind} signing key file is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
