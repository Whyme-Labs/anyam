import type { GitObjectFormat, RepositoryObservation } from "../kernel/contracts.ts";

export const REPOSITORY_OBSERVATION_PROTOCOL = "anyam.repository-observation/v1" as const;

export type RepositoryObservationClaims = Omit<RepositoryObservation, "manifestDigest">;

export type RepositoryObservationRequest = {
  protocol: typeof REPOSITORY_OBSERVATION_PROTOCOL;
  operation: "observe";
  repositoryId: string;
  sourceSpaceId: string;
  workspaceId: string;
  projectViewId: string;
  expectedCommitOid: string;
  expectedTreeOid?: string;
  expectedBaseCommitOid: string;
  expectedObjectFormat?: GitObjectFormat;
};

export type RepositoryObservationServiceResponse = {
  protocol: typeof REPOSITORY_OBSERVATION_PROTOCOL;
  status: "succeeded" | "blocked" | "unavailable";
  observation?: RepositoryObservation;
  code?: string;
  recoveryAction?: string;
  receipt: string;
};

export type ParsedRepositoryObservationServiceResponse =
  | { valid: true; response: RepositoryObservationServiceResponse }
  | { valid: false; code: string; recoveryAction: string; receipt: string };

export type ParsedRepositoryObservationRequest =
  | { valid: true; request: RepositoryObservationRequest }
  | { valid: false; code: string; message: string; recoveryAction: string; receipt: string };

export function repositoryObservationManifest(input: RepositoryObservationClaims): string {
  return JSON.stringify({
    protocol: input.protocol,
    repositoryId: input.repositoryId,
    sourceSpaceId: input.sourceSpaceId,
    workspaceId: input.workspaceId,
    projectViewId: input.projectViewId,
    objectFormat: input.objectFormat,
    symbolicRef: input.symbolicRef,
    commitOid: input.commitOid,
    treeOid: input.treeOid,
    baseCommitOid: input.baseCommitOid,
    ancestryVerified: input.ancestryVerified,
    observedAt: input.observedAt,
    receipt: input.receipt,
  });
}

export async function repositoryObservationDigest(input: RepositoryObservationClaims): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(repositoryObservationManifest(input)));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function parseRepositoryObservationRequest(value: unknown): ParsedRepositoryObservationRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { valid: false, code: "repository_observation_request_malformed", message: "The RepositoryDriver observation request must be a JSON object.", recoveryAction: "send one anyam.repository-observation/v1 request object", receipt: "repositoryObservationRequest=object-required; transition=not-applied" };
  const body: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const protocol = requiredString(body.protocol, "protocol");
  const operation = body.operation === "observe" ? body.operation : undefined;
  const repositoryId = requiredString(body.repositoryId, "repositoryId");
  const sourceSpaceId = requiredString(body.sourceSpaceId, "sourceSpaceId");
  const workspaceId = requiredString(body.workspaceId, "workspaceId");
  const projectViewId = requiredString(body.projectViewId, "projectViewId");
  const expectedCommitOid = requiredString(body.expectedCommitOid, "expectedCommitOid");
  const expectedTreeOid = body.expectedTreeOid === undefined ? undefined : requiredString(body.expectedTreeOid, "expectedTreeOid");
  const expectedBaseCommitOid = requiredString(body.expectedBaseCommitOid, "expectedBaseCommitOid");
  const expectedObjectFormat = body.expectedObjectFormat === undefined ? undefined : body.expectedObjectFormat === "sha1" || body.expectedObjectFormat === "sha256" ? body.expectedObjectFormat : undefined;
  if (protocol !== REPOSITORY_OBSERVATION_PROTOCOL || operation !== "observe" || !repositoryId || !sourceSpaceId || !workspaceId || !projectViewId || !expectedCommitOid || !expectedBaseCommitOid || (body.expectedTreeOid !== undefined && !expectedTreeOid) || (body.expectedObjectFormat !== undefined && !expectedObjectFormat)) return { valid: false, code: "repository_observation_request_malformed", message: "The RepositoryDriver observation request is incomplete or unsupported.", recoveryAction: "send protocol, operation=observe, identities, expected commit/base, and an optional valid object format", receipt: "repositoryObservationRequest=complete-v1-required; transition=not-applied" };
  if (expectedObjectFormat && (!validOid(expectedCommitOid, expectedObjectFormat) || !validOid(expectedBaseCommitOid, expectedObjectFormat) || (expectedTreeOid !== undefined && !validOid(expectedTreeOid, expectedObjectFormat)))) return { valid: false, code: "repository_observation_request_oid_invalid", message: "The RepositoryDriver observation request contains an invalid Git object ID for its declared object format.", recoveryAction: "send lowercase hexadecimal Git object IDs with the exact declared object format", receipt: "repositoryObservationRequest=oid-invalid; transition=not-applied" };
  return { valid: true, request: { protocol, operation, repositoryId, sourceSpaceId, workspaceId, projectViewId, expectedCommitOid, ...(expectedTreeOid ? { expectedTreeOid } : {}), expectedBaseCommitOid, ...(expectedObjectFormat ? { expectedObjectFormat } : {}) } };
}

function requiredString(value: unknown, field: string): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validOid(value: string, objectFormat: GitObjectFormat): boolean {
  const expectedLength = objectFormat === "sha256" ? 64 : 40;
  return value.length === expectedLength && /^[0-9a-f]+$/u.test(value);
}

export type ParsedRepositoryObservation =
  | { valid: true; observation: RepositoryObservation }
  | { valid: false; code: string; recoveryAction: string; receipt: string };

export function parseRepositoryObservationServiceResponse(value: unknown): ParsedRepositoryObservationServiceResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { valid: false, code: "repository_observation_service_malformed", recoveryAction: "return one credential-free RepositoryDriver observation service response", receipt: "repositoryObservationService=object-required; transition=not-applied" };
  const body: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const protocol = requiredString(body.protocol, "protocol");
  const status = body.status === "succeeded" || body.status === "blocked" || body.status === "unavailable" ? body.status : undefined;
  const receipt = requiredString(body.receipt, "receipt");
  if (protocol !== REPOSITORY_OBSERVATION_PROTOCOL || !status || !receipt) return { valid: false, code: "repository_observation_service_malformed", recoveryAction: "return status succeeded, blocked, or unavailable with a credential-free receipt", receipt: "repositoryObservationService=complete-v1-required; transition=not-applied" };
  if (status === "succeeded") {
    const parsed = parseRepositoryObservation(body.observation);
    if (!parsed.valid) return parsed;
    return { valid: true, response: { protocol, status, observation: parsed.observation, receipt } };
  }
  const code = requiredString(body.code, "code");
  const recoveryAction = requiredString(body.recoveryAction, "recoveryAction");
  if (!code || !recoveryAction) return { valid: false, code: "repository_observation_service_malformed", recoveryAction: "return code and recoveryAction for a blocked or unavailable observation", receipt: "repositoryObservationService=error-shape-required; transition=not-applied" };
  return { valid: true, response: { protocol, status, code, recoveryAction, receipt } };
}

export type RepositoryObservationBinding = {
  readonly observation: unknown;
  readonly repositoryId: string;
  readonly sourceSpaceId: string;
  readonly workspaceId: string;
  readonly projectViewId: string;
  readonly expectedCommitOid: string;
  readonly expectedTreeOid?: string;
  readonly expectedBaseCommitOid: string;
  readonly expectedObjectFormat?: GitObjectFormat;
};

export type RepositoryObservationVerificationResult =
  | { valid: true; observation: RepositoryObservation }
  | { valid: false; code: string; message: string; recoveryAction: string; receipt: string };

export async function verifyRepositoryObservation(input: RepositoryObservationBinding): Promise<RepositoryObservationVerificationResult> {
  const parsed = parseRepositoryObservation(input.observation);
  if (!parsed.valid) return { valid: false, code: parsed.code, message: "The RepositoryDriver observation is malformed.", recoveryAction: parsed.recoveryAction, receipt: parsed.receipt };
  const observation = parsed.observation;
  const mismatches: string[] = [];
  if (observation.repositoryId !== input.repositoryId) mismatches.push("repositoryId");
  if (observation.sourceSpaceId !== input.sourceSpaceId) mismatches.push("sourceSpaceId");
  if (observation.workspaceId !== input.workspaceId) mismatches.push("workspaceId");
  if (observation.projectViewId !== input.projectViewId) mismatches.push("projectViewId");
  if (observation.commitOid !== input.expectedCommitOid) mismatches.push("commitOid");
  if (input.expectedTreeOid !== undefined && observation.treeOid !== input.expectedTreeOid) mismatches.push("treeOid");
  if (observation.baseCommitOid !== input.expectedBaseCommitOid) mismatches.push("baseCommitOid");
  if (input.expectedObjectFormat !== undefined && observation.objectFormat !== input.expectedObjectFormat) mismatches.push("objectFormat");
  const { manifestDigest: _manifestDigest, ...claims } = observation;
  const expectedDigest = await repositoryObservationDigest(claims);
  if (observation.manifestDigest !== expectedDigest) mismatches.push("manifestDigest");
  if (mismatches.length > 0) return { valid: false, code: "repository_observation_binding_mismatch", message: "The RepositoryDriver observation does not match the authoritative hosted revision (" + mismatches.join(", ") + ").", recoveryAction: "inspect the exact Workspace through the configured RepositoryDriver and publish a fresh observation for the same Project View", receipt: "repositoryObservation=binding-mismatch; fields=" + mismatches.join(",") + "; transition=not-applied" };
  return { valid: true, observation };
}

export function parseRepositoryObservation(value: unknown): ParsedRepositoryObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { valid: false, code: "repository_observation_malformed", recoveryAction: "return one repository observation object from the trusted RepositoryDriver boundary", receipt: "repositoryObservation=object-required; transition=not-applied" };
  const body: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const protocol = requiredString(body.protocol, "protocol");
  const repositoryId = requiredString(body.repositoryId, "repositoryId");
  const sourceSpaceId = requiredString(body.sourceSpaceId, "sourceSpaceId");
  const workspaceId = requiredString(body.workspaceId, "workspaceId");
  const projectViewId = requiredString(body.projectViewId, "projectViewId");
  const objectFormat = body.objectFormat === "sha1" || body.objectFormat === "sha256" ? body.objectFormat : undefined;
  const symbolicRef = requiredString(body.symbolicRef, "symbolicRef");
  const commitOid = requiredString(body.commitOid, "commitOid");
  const treeOid = requiredString(body.treeOid, "treeOid");
  const baseCommitOid = requiredString(body.baseCommitOid, "baseCommitOid");
  const manifestDigest = requiredString(body.manifestDigest, "manifestDigest");
  const observedAt = requiredString(body.observedAt, "observedAt");
  const receipt = requiredString(body.receipt, "receipt");
  if (protocol !== REPOSITORY_OBSERVATION_PROTOCOL || !repositoryId || !sourceSpaceId || !workspaceId || !projectViewId || !objectFormat || !symbolicRef || !commitOid || !treeOid || !baseCommitOid || body.ancestryVerified !== true || !manifestDigest || !/^sha256:[0-9a-f]{64}$/u.test(manifestDigest) || !observedAt || !receipt || !validOid(commitOid, objectFormat) || !validOid(treeOid, objectFormat) || !validOid(baseCommitOid, objectFormat)) return { valid: false, code: "repository_observation_malformed", recoveryAction: "return a complete credential-free RepositoryDriver observation with verified Git commit, tree, ref, ancestry, and digest fields", receipt: "repositoryObservation=complete-v1-required; transition=not-applied" };
  return {
    valid: true,
    observation: { protocol, repositoryId, sourceSpaceId, workspaceId, projectViewId, objectFormat, symbolicRef, commitOid, treeOid, baseCommitOid, ancestryVerified: true, manifestDigest, observedAt, receipt },
  };
}
