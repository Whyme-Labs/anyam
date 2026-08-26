/// <reference types="@cloudflare/workers-types" />

import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { handleCustomerRealmRequest } from "../../../src/cloudflare/realm-worker.ts";
import {
  AUTHORITY_COMMAND_PROTOCOL,
  AUTHORITY_PLANE_PROTOCOL,
  AuthorityPlaneCoordinator,
  AuthorityPlaneError,
  authorityStateSummary,
  emptyAuthorityPlaneSnapshot,
  normalizeAuthorityPlaneSnapshot,
  type AuthorityCommand,
  type AuthorityCommandName,
  type AuthorityPlaneSnapshot,
  type AuthoritySession,
} from "../../../src/cloudflare/authority-plane.ts";
import { PROMOTION_EXECUTION_PROTOCOL, PROMOTION_HANDOFF_TTL_MS, signPromotionHandoff, type PromotionExecutionResult, type PromotionReconciliationRequest } from "../../../src/cloudflare/promotion-execution.ts";
import {
  CUSTOMER_PROVIDER_OPERATION_PROTOCOL,
  CustomerProviderDurableObjectOperationStore,
  CustomerProviderOperationError,
  CustomerProviderQualificationCoordinator,
  type CustomerProviderFailureMode,
  type CustomerProviderOwnerAuthorization,
  type CustomerProviderSurface,
  type CustomerProviderRecoveryBundle,
} from "../../../src/cloudflare/customer-provider-operation.ts";
import { CREDENTIAL_AUDIENCES, RealmIdentityError, RealmIdentityPolicy, type Capability, type CredentialClass, type RealmRecoverySnapshot } from "../../../src/identity/realm.ts";
import type { ResourceRef, RepositoryObservation } from "../../../src/kernel/contracts.ts";
import { oauthConsentBindingMatches } from "../../../src/identity/oauth-consent.ts";
import { createAnyamRealmOAuthProvider, type AnyamRealmOAuthEnv } from "./oauth-provider.ts";
import { handleAnyamRealmOwnerRequest, requestAnyamRealmCoordinator } from "./passkey-owner.ts";
import { createCloudflareCustomerProviderAdapters } from "./customer-provider-adapters.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "./coordinator-protocol.ts";
import { handleAuthorityRequest } from "./authority-edge.ts";
import { isMcpDeliveryOperation, mcpDeliveryScope, parseMcpDeliveryBinding, MCP_DELIVERY_OPERATIONS, type McpDeliveryOperation } from "./mcp-delivery-grant.ts";
import { AUTHORITY_RECOVERY_PROTOCOL, createAuthorityRecoveryBundle, verifyAuthorityRecoveryBundle, type AuthorityRecoveryBundle } from "../../../src/cloudflare/authority-recovery.ts";
import { GitHubActionsBridgeAuthority, type GitHubActionsBridgeConnectionInput, type GitHubActionsEventName, type GitHubActionsBridgeOperation, type GitHubActionsBridgeSnapshot, type GitHubActionsOidcVerification } from "../../../src/portability/github-actions-bridge.ts";
import { GitHubActionsBridgeImportCoordinator, MemoryGitHubActionsBridgeImportLedger, type GitHubActionsBridgeImportSnapshot, type GitHubActionsBridgeOwnerConfirmation, type GitHubActionsBridgeRepositoryImportReceipt } from "../../../src/portability/github-actions-bridge-import.ts";
import { GitHubActionsBridgeOutboundCoordinator, MemoryGitHubActionsBridgeOutboundReplayLedger, type GitHubActionsBridgeOutboundSnapshot } from "../../../src/portability/github-actions-bridge-outbound.ts";
import { encodeGitHubActionsBridgeHistory, encodeGitHubActionsBridgeOutboundBundle, encodeGitHubActionsBridgeSourcePackage, parseGitHubActionsBridgeHistory, parseGitHubActionsBridgeMode, parseGitHubActionsBridgeOutboundBundle, parseGitHubActionsBridgeOutboundPlan, parseGitHubActionsBridgeOutboundProvider, parseGitHubActionsBridgeOutboundRun, parseGitHubActionsBridgePlan, parseGitHubActionsBridgeSourcePackage } from "./github-actions-bridge-contract.ts";
import { handleGitHubActionsBridgeRequest } from "./github-actions-bridge-route.ts";
import { authorizeMcpCommandTarget } from "../../../src/cloudflare/mcp-command-target.ts";
import { parseRepositoryObservationServiceResponse, verifyRepositoryObservation, type RepositoryObservationRequest } from "../../../src/portability/repository-observation.ts";

export type Env = AnyamRealmOAuthEnv;

const REALM_IDENTITY_SNAPSHOT_KEY = "anyam/realm-identity/snapshot/v1";
const REALM_RECOVERY_STATUS_KEY = "anyam/realm-identity/recovery-status/v1";
const REALM_PASSKEY_CHALLENGE_PREFIX = "anyam/realm-passkey-challenge/v1:";
const REALM_OAUTH_CONSENT_PREFIX = "anyam/realm-oauth-consent/v1:";
const REALM_OAUTH_GRANT_PREFIX = "anyam/realm-oauth-grant/v1:";
const REALM_AUTHORITY_SNAPSHOT_KEY = "anyam/realm-authority/snapshot/v1";
const REALM_AUTHORITY_RECOVERY_STATUS_KEY = "anyam/realm-authority/recovery-status/v1";
const REALM_AUTHORITY_RECOVERY_RESTORE_PREFIX = "anyam/realm-authority/recovery-restore/v1:";
const REALM_GITHUB_ACTIONS_BRIDGE_SNAPSHOT_KEY = "anyam/github-actions-bridge/snapshot/v1";
const REALM_GITHUB_ACTIONS_BRIDGE_IMPORT_SNAPSHOT_KEY = "anyam/github-actions-bridge/import-snapshot/v1";
const REALM_GITHUB_ACTIONS_BRIDGE_OUTBOUND_SNAPSHOT_KEY = "anyam/github-actions-bridge/outbound-snapshot/v1";
const REALM_COORDINATOR_PROTOCOL = "anyam.realm-coordinator/v1" as const;
const REALM_QUALIFICATION_PROJECT_ID = "project:realm-qualification";
const REALM_QUALIFICATION_SOURCE_SPACE_ID = "source:realm-qualification";
const REALM_QUALIFICATION_WORKSPACE_ID = "workspace:realm-qualification";
const REALM_QUALIFICATION_CHANGE_ID = "change:realm-qualification";
const REALM_QUALIFICATION_AGENT_ID = "agent:realm-qualification";
const REALM_QUALIFICATION_AGENT_CLIENT_ID = "client:agent:realm-qualification";
const REALM_QUALIFICATION_CREDENTIAL_CLASSES: readonly CredentialClass[] = ["git", "mcp"];
const REALM_QUALIFICATION_ACTIONS = ["source.read", "workspace.write", "change.publish_revision", "run.invoke", "agent.delegate"] as const;
const GENERIC_AGENT_CREDENTIAL_CLASSES: readonly CredentialClass[] = ["realm-api", "git", "mcp"];
const GENERIC_AGENT_CAPABILITIES: readonly Capability[] = [
  "project.inspect",
  "source.read",
  "source.propose",
  "workspace.inspect",
  "workspace.write",
  "change.inspect",
  "change.publish_revision",
  "intent.inspect",
  "intent.write",
  "pullRequest.inspect",
  "pullRequest.write",
  "review.submit_finding",
  "run.invoke",
  "evidence.read",
  "secret.use",
];
const GENERIC_AGENT_DENIED_CAPABILITIES: readonly Capability[] = ["change.approve", "landing.request", "release.create", "target.configure", "promotion.request", "target.promote", "policy.manage", "identity.manage"];
const GENERIC_AGENT_DENIED_EFFECTS = ["canonical.write", "landing.apply", "production.deploy", "target.promote", "promotion.request"] as const;
type RealmRecoveryStatus = "active" | "recovery-pending";
type AuthorityRecoveryStatus = "active" | "quarantined";
const CUSTOMER_PROVIDER_SURFACES: readonly CustomerProviderSurface[] = ["d1", "r2", "queue", "workflow", "worker"];
const CUSTOMER_PROVIDER_FAILURE_MODES: readonly CustomerProviderFailureMode[] = ["none", "provider-outage", "authorization-revoked", "timeout", "duplicate-delivery", "partial-mutation", "stale-callback"];

type CoordinatorRequestBody = Record<string, unknown>;

type StoredAuthorityRecoveryRestore = {
  protocol: typeof AUTHORITY_RECOVERY_PROTOCOL;
  bundleId: string;
  bundleDigest: string;
  snapshotVersion: number;
  restoredAt: string;
  activatedAt?: string;
};

type StoredPasskeyChallenge = {
  protocol: "anyam.realm-passkey-challenge/v1";
  id: string;
  ceremony: "registration" | "authentication";
  challenge: string;
  realmId: string;
  userId?: string;
  displayName?: string;
  createdAt: string;
  expiresAt: string;
};

type StoredOAuthAuthRequest = {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string | string[];
  issuer?: string;
};

type StoredOAuthConsent = {
  protocol: "anyam.oauth-consent/v1";
  id: string;
  csrfToken: string;
  realmId: string;
  principalId: string;
  sessionId: string;
  clientId: string;
  clientName: string;
  requestedScopes: string[];
  allowedScopes: string[];
  authRequest: StoredOAuthAuthRequest;
  createdAt: string;
  expiresAt: string;
};

type StoredOAuthGrant = {
  protocol: "anyam.oauth-grant/v1";
  id: string;
  providerGrantId: string;
  realmId: string;
  principalId: string;
  clientId: string;
  scopes: string[];
  status: "active" | "revoked";
  createdAt: string;
  revokedAt?: string;
  sessionId: string;
  actorId: string;
  authorizationEpoch: number;
  expiresAt: string;
  mcpResource?: string;
  resource?: ResourceRef;
  sourceSpaceIds: string[];
  taskId?: string;
  capabilityGrantId?: string;
  deliveryActions: string[];
};

function coordinatorJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function coordinatorBody(request: Request): Promise<CoordinatorRequestBody> {
  const value: unknown = await request.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be a JSON object");
  return value as CoordinatorRequestBody;
}

function coordinatorString(body: CoordinatorRequestBody, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} is required`);
  return value.trim();
}

function bridgeOperation(body: CoordinatorRequestBody): GitHubActionsBridgeOperation {
  const operation = coordinatorString(body, "operation");
  if (operation !== "inbound" && operation !== "outbound" && operation !== "proposal") throw new RealmIdentityError({ code: "github_bridge.operation_invalid", message: `GitHub Actions Bridge operation ${operation} is unsupported.`, recoveryAction: "request inbound, proposal, or outbound for the exact owner-approved connection", receipt: `operation=${operation}; capability=not-issued; credentialMaterialStored=false` });
  return operation;
}

function bridgeConnectionInput(value: unknown): GitHubActionsBridgeConnectionInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RealmIdentityError({ code: "github_bridge.connection_invalid", message: "The Bridge connection request must be an object.", recoveryAction: "send the owner-approved repository, workflow, ref, audience, operation, and expiry fields", receipt: "connection=object-required; transition=not-applied; credentialMaterialStored=false" });
  const input = value as Record<string, unknown>;
  const required = (key: string): string => coordinatorString(input, key);
  const array = (key: string): string[] => coordinatorStringArray(input, key);
  const allowedEvents: GitHubActionsEventName[] = [];
  for (const event of array("allowedEvents")) {
    if (event !== "push" && event !== "pull_request" && event !== "workflow_dispatch") throw new RealmIdentityError({ code: "github_bridge.event_invalid", message: `Bridge event ${event} is unsupported.`, recoveryAction: "choose push, pull_request, or workflow_dispatch for the owner-approved connection", receipt: `event=${event}; transition=not-applied; credentialMaterialStored=false` });
    allowedEvents.push(event);
  }
  const allowedOperations: GitHubActionsBridgeOperation[] = [];
  for (const operation of array("allowedOperations")) {
    if (operation !== "inbound" && operation !== "outbound" && operation !== "proposal") throw new RealmIdentityError({ code: "github_bridge.operation_invalid", message: `Bridge operation ${operation} is unsupported.`, recoveryAction: "choose inbound, proposal, or outbound for the owner-approved connection", receipt: `operation=${operation}; transition=not-applied; credentialMaterialStored=false` });
    allowedOperations.push(operation);
  }
  const expectedJobWorkflowRef = input.expectedJobWorkflowRef === null || input.expectedJobWorkflowRef === undefined ? null : required("expectedJobWorkflowRef");
  return {
    ...(input.id === undefined ? {} : { id: required("id") }),
    realmId: required("realmId"),
    projectId: required("projectId"),
    sourceSpaceId: required("sourceSpaceId"),
    repositoryOwner: required("repositoryOwner"),
    repositoryOwnerId: required("repositoryOwnerId"),
    repository: required("repository"),
    repositoryId: required("repositoryId"),
    mirrorId: input.mirrorId === null || input.mirrorId === undefined ? null : required("mirrorId"),
    outboundSigningKeyId: input.outboundSigningKeyId === null || input.outboundSigningKeyId === undefined ? null : required("outboundSigningKeyId"),
    outboundSigningPublicKey: input.outboundSigningPublicKey === null || input.outboundSigningPublicKey === undefined ? null : required("outboundSigningPublicKey"),
    workflowRef: required("workflowRef"),
    expectedJobWorkflowRef,
    ref: required("ref"),
    audience: required("audience"),
    allowedEvents,
    allowedOperations,
    expiresAt: required("expiresAt"),
  };
}

function bridgeVerification(value: unknown): GitHubActionsOidcVerification {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RealmIdentityError({ code: "github_bridge.verification_invalid", message: "The customer-owned OIDC verifier did not return a verification object.", recoveryAction: "repair the bound OIDC verifier response and retry; no Bridge state changed", receipt: "verification=object-required; capability=not-issued; credentialMaterialStored=false" });
  const record = value as Record<string, unknown>;
  if (record.status === "verified") {
    if (typeof record.receipt !== "string" || record.receipt.trim().length === 0 || !("claims" in record)) throw new RealmIdentityError({ code: "github_bridge.verification_invalid", message: "The verified OIDC response is missing claims or a receipt.", recoveryAction: "return verified claims and a credential-free receipt from the bound OIDC verifier", receipt: "verification=verified-shape-invalid; capability=not-issued; credentialMaterialStored=false" });
    return { status: "verified", claims: record.claims, receipt: record.receipt };
  }
  if (record.status === "failed" && typeof record.code === "string" && typeof record.recoveryAction === "string" && typeof record.receipt === "string") return { status: "failed", code: record.code, recoveryAction: record.recoveryAction, receipt: record.receipt };
  throw new RealmIdentityError({ code: "github_bridge.verification_invalid", message: "The customer-owned OIDC verifier returned an unsupported result.", recoveryAction: "return status=verified with claims or status=failed with code, recoveryAction, and receipt", receipt: "verification=unsupported; capability=not-issued; credentialMaterialStored=false" });
}

function bridgeObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RealmIdentityError({ code: "github_bridge.service_response_invalid", message: `${field} must be an object.`, recoveryAction: "repair the customer-owned Bridge service response and retry the named checkpoint", receipt: `${field}=object-required; credentialMaterialStored=false` });
  return value as Record<string, unknown>;
}

function bridgeServiceText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new RealmIdentityError({ code: "github_bridge.service_response_invalid", message: `${field} must be a non-empty string.`, recoveryAction: "return a complete credential-free Bridge service receipt and retry the named checkpoint", receipt: `${field}=string-required; credentialMaterialStored=false` });
  return value.trim();
}

function bridgeServiceObjectFormat(value: unknown): "sha1" | "sha256" {
  const format = bridgeServiceText(value, "objectFormat");
  if (format !== "sha1" && format !== "sha256") throw new RealmIdentityError({ code: "github_bridge.service_response_invalid", message: "Bridge service object format is unsupported.", recoveryAction: "return sha1 or sha256 in the credential-free RepositoryDriver receipt", receipt: `objectFormat=${format}; credentialMaterialStored=false` });
  return format;
}

function bridgeServiceRefs(value: unknown): { name: string; oid: string }[] {
  if (!Array.isArray(value)) throw new RealmIdentityError({ code: "github_bridge.service_response_invalid", message: "Bridge service refs must be an array.", recoveryAction: "return the complete verified Git ref list and retry the named checkpoint", receipt: "refs=array-required; credentialMaterialStored=false" });
  return value.map((entry, index) => {
    const ref = bridgeObject(entry, `refs[${index}]`);
    return { name: bridgeServiceText(ref.name, `refs[${index}].name`), oid: bridgeServiceText(ref.oid, `refs[${index}].oid`) };
  });
}

function bridgeImportReceipt(value: unknown): GitHubActionsBridgeRepositoryImportReceipt {
  const result = bridgeObject(value, "repositoryImport");
  if (result.status !== "succeeded") throw new RealmIdentityError({ code: "github_bridge.service_response_invalid", message: "The RepositoryDriver service did not return a succeeded import receipt.", recoveryAction: "repair the customer-owned RepositoryDriver/import boundary and resume the named checkpoint", receipt: "repositoryImport=status-invalid; credentialMaterialStored=false" });
  const lfsState = bridgeServiceText(result.lfsState, "lfsState");
  if (lfsState !== "empty" && lfsState !== "complete") throw new RealmIdentityError({ code: "github_bridge.service_response_invalid", message: "The RepositoryDriver service returned an incomplete LFS state.", recoveryAction: "complete the declared LFS object set before activation", receipt: `lfsState=${lfsState}; credentialMaterialStored=false` });
  return { status: "succeeded", repositoryId: bridgeServiceText(result.repositoryId, "repositoryId"), sourceSnapshotId: bridgeServiceText(result.sourceSnapshotId, "sourceSnapshotId"), objectFormat: bridgeServiceObjectFormat(result.objectFormat), refs: bridgeServiceRefs(result.refs), bundleDigest: bridgeServiceText(result.bundleDigest, "bundleDigest"), lfsState, checkpointId: bridgeServiceText(result.checkpointId, "checkpointId"), receipt: bridgeServiceText(result.receipt, "receipt") };
}

function coordinatorOptionalString(body: CoordinatorRequestBody, key: string, fallback: string): string {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function coordinatorTimestamp(body: CoordinatorRequestBody, key: string): string {
  const value = coordinatorString(body, key);
  if (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) throw new RealmIdentityError({ code: "coordinator.timestamp_invalid", message: `${key} must be a future ISO timestamp.`, recoveryAction: "create a fresh bounded ceremony or consent record with an expiry in the future", receipt: `${key}=future-iso-required` });
  return value;
}

function coordinatorStringArray(body: CoordinatorRequestBody, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0)) throw new RealmIdentityError({ code: "coordinator.array_invalid", message: `${key} must be a non-empty array of strings.`, recoveryAction: `provide a non-empty ${key} array and retry`, receipt: `${key}=string-array-required` });
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function coordinatorCapabilityArray(body: CoordinatorRequestBody, key: string): Capability[] {
  const values = coordinatorStringArray(body, key);
  const known = new Set(GENERIC_AGENT_CAPABILITIES);
  const denied = new Set(GENERIC_AGENT_DENIED_CAPABILITIES);
  const unknown = values.find((value) => !known.has(value as Capability) && !denied.has(value as Capability));
  if (unknown) throw new RealmIdentityError({ code: "delegation.capability_invalid", message: `${key} contains an unsupported capability ${unknown}.`, recoveryAction: `choose a supported non-promotional agent capability; no delegation was created`, receipt: `${key}=unsupported; capability=${unknown}; delegation=not-created` });
  const deniedCapability = values.find((value) => denied.has(value as Capability));
  if (deniedCapability) throw new RealmIdentityError({ code: "delegation.capability_denied", message: `Agent delegation cannot include ${deniedCapability}.`, recoveryAction: `remove ${deniedCapability} and keep canonical landing, promotion, policy, and identity authority outside the agent`, receipt: `${key}=denied; capability=${deniedCapability}; canonicalWrite=false` });
  return values as Capability[];
}

function commandNameForMcp(body: CoordinatorRequestBody): string {
  return coordinatorString(body, "command");
}

function capabilityForMcpCommand(command: string): Capability | undefined {
  if (command === "workspace.create") return "workspace.write";
  if (command === "change.create" || command === "revision.publish") return "change.publish_revision";
  if (["intent.create", "intent.assign", "intent.comment", "intent.close", "intent.reopen"].includes(command)) return "intent.write";
  if (["pullRequest.open", "pullRequest.update", "pullRequest.review", "pullRequest.close", "pullRequest.reopen", "pullRequest.block", "pullRequest.merge"].includes(command)) return "pullRequest.write";
  if (command === "run.request") return "run.invoke";
  if (isMcpDeliveryOperation(command)) return mcpDeliveryScope(command);
  return undefined;
}

function capabilityForAuthorityCommand(command: AuthorityCommandName): Capability | undefined {
  switch (command) {
    case "project.create": return "identity.manage";
    case "intent.create":
    case "intent.assign":
    case "intent.comment":
    case "intent.close":
    case "intent.reopen": return "intent.write";
    case "pullRequest.open":
    case "pullRequest.update":
    case "pullRequest.review":
    case "pullRequest.close":
    case "pullRequest.reopen":
    case "pullRequest.block":
    case "pullRequest.merge": return "pullRequest.write";
    case "workspace.create": return "workspace.write";
    case "change.create":
    case "revision.publish": return "change.publish_revision";
    case "run.request": return "run.invoke";
    case "landing.apply": return "landing.request";
    case "release.create": return "release.create";
    case "target.configure": return "target.configure";
    case "promotion.request": return "promotion.request";
    case "mirror.configure":
    case "mirror.sync":
    case "mirror.reconcile": return "source.propose";
    default: return undefined;
  }
}

function delegationCredentialClasses(body: CoordinatorRequestBody): CredentialClass[] {
  const values = body.allowedCredentialClasses === undefined ? [...GENERIC_AGENT_CREDENTIAL_CLASSES] : coordinatorStringArray(body, "allowedCredentialClasses") as CredentialClass[];
  const allowed = new Set(GENERIC_AGENT_CREDENTIAL_CLASSES);
  const unsupported = values.find((value) => !allowed.has(value));
  if (unsupported) throw new RealmIdentityError({ code: "delegation.credential_class_denied", message: `Agent delegation cannot issue the ${unsupported} credential audience.`, recoveryAction: "request only realm-api, git, or mcp for a coding-agent Task; deployment and promotion credentials require separate authority", receipt: `credentialClass=${unsupported}; canonicalWrite=false; credentials=not-issued` });
  return [...new Set(values)];
}

function credentialExchangeClasses(body: CoordinatorRequestBody): CredentialClass[] {
  const values = coordinatorStringArray(body, "credentialClasses") as CredentialClass[];
  const allowed = new Set(GENERIC_AGENT_CREDENTIAL_CLASSES);
  const unsupported = values.find((value) => !allowed.has(value));
  if (unsupported) throw new RealmIdentityError({ code: "credential_exchange.class_denied", message: `The explicit exchange cannot issue the ${unsupported} credential audience.`, recoveryAction: "request only realm-api, git, or mcp classes already approved by the Agent and delegated Grant", receipt: `credentialClass=${unsupported}; credentialExchange=not-created; credentialMaterialStored=false` });
  return [...new Set(values)];
}

function rejectCredentialMaterial(body: CoordinatorRequestBody): void {
  const forbidden = ["token", "tokens", "credentials", "providerToken", "providerTokens", "accessToken", "refreshToken", "apiKey", "secret", "password"] as const;
  const field = Object.keys(body).find((key) => key !== "credentialClasses" && (forbidden.includes(key as typeof forbidden[number]) || /(?:token|secret|password|api[_-]?key|credential)/iu.test(key)));
  if (field) throw new RealmIdentityError({ code: "credential_exchange.material_rejected", message: "Credential exchange accepts credential classes, not provider credentials or token material.", recoveryAction: "remove token or provider-credential fields and request only the exact approved credential classes", receipt: `field=${field}; credentialMaterial=not-accepted; credentialExchange=not-created` });
}

function delegationBudget(body: CoordinatorRequestBody): Record<string, string | number> {
  const value = body.budget;
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RealmIdentityError({ code: "delegation.budget_invalid", message: "Agent delegation budget must be a JSON object.", recoveryAction: "provide named numeric or string budget dimensions; no delegation was created", receipt: "budget=object-required; delegation=not-created" });
  const budget: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || (typeof entry !== "number" && typeof entry !== "string") || (typeof entry === "number" && (!Number.isFinite(entry) || entry < 0)) || (typeof entry === "string" && entry.trim().length === 0)) throw new RealmIdentityError({ code: "delegation.budget_invalid", message: `Agent delegation budget dimension ${key || "<empty>"} must be a finite non-negative number or non-empty string.`, recoveryAction: "name each budget dimension and provide a measurable non-negative value", receipt: `budget=${key || "<empty>"}; value=invalid; delegation=not-created` });
    budget[key] = typeof entry === "string" ? entry.trim() : entry;
  }
  return budget;
}

function delegationEffects(body: CoordinatorRequestBody): string[] {
  if (body.effects === undefined) return [];
  const effects = coordinatorStringArray(body, "effects");
  const denied = effects.find((effect) => GENERIC_AGENT_DENIED_EFFECTS.includes(effect as typeof GENERIC_AGENT_DENIED_EFFECTS[number]) || /(?:^|[.:_-])(canonical|promotion|promote|production|landing)(?:$|[.:_-])/iu.test(effect));
  if (denied) throw new RealmIdentityError({ code: "delegation.effect_denied", message: `Agent delegation cannot include the effect ${denied}.`, recoveryAction: "declare only Workspace, source, test, review, or evidence effects; canonical landing and promotion remain separate", receipt: `effect=${denied}; canonicalWrite=false; delegation=not-created` });
  return effects;
}

function coordinatorAuthRequest(value: unknown): StoredOAuthAuthRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RealmIdentityError({ code: "oauth.consent_request_invalid", message: "OAuth consent requires the parsed authorization request object.", recoveryAction: "start a fresh OAuth authorization request and do not reconstruct it in the browser", receipt: "oauthRequest=object-required" });
  const request = value as Record<string, unknown>;
  const responseType = typeof request.responseType === "string" ? request.responseType.trim() : "";
  const clientId = typeof request.clientId === "string" ? request.clientId.trim() : "";
  const redirectUri = typeof request.redirectUri === "string" ? request.redirectUri.trim() : "";
  const state = typeof request.state === "string" ? request.state : "";
  const scope = Array.isArray(request.scope) && request.scope.every((item) => typeof item === "string" && item.trim().length > 0) ? [...new Set(request.scope.map((item) => (item as string).trim()))] : [];
  if (!responseType || !clientId || !redirectUri || scope.length === 0) throw new RealmIdentityError({ code: "oauth.consent_request_invalid", message: "The stored OAuth request is incomplete; no consent record was created.", recoveryAction: "restart the OAuth authorization-code request with a valid redirect URI and at least one scope", receipt: "oauthRequest=responseType,clientId,redirectUri,scope-required" });
  const optionalString = (key: string): string | undefined => typeof request[key] === "string" && (request[key] as string).length > 0 ? request[key] as string : undefined;
  const codeChallenge = optionalString("codeChallenge");
  const codeChallengeMethod = optionalString("codeChallengeMethod");
  const issuer = optionalString("issuer");
  const resource = typeof request.resource === "string" ? request.resource : Array.isArray(request.resource) && request.resource.every((item) => typeof item === "string") ? [...request.resource] as string[] : undefined;
  return {
    responseType,
    clientId,
    redirectUri,
    scope,
    state,
    ...(codeChallenge ? { codeChallenge } : {}),
    ...(codeChallengeMethod ? { codeChallengeMethod } : {}),
    ...(resource ? { resource } : {}),
    ...(issuer ? { issuer } : {}),
  };
}

function storageKey(prefix: string, id: string): string {
  return `${prefix}${id}`;
}

function recordExpired(expiresAt: string): boolean {
  return Date.parse(expiresAt) <= Date.now();
}

function storedOAuthGrantProjection(record: StoredOAuthGrant): Record<string, unknown> {
  return {
    protocol: record.protocol,
    id: record.id,
    clientId: record.clientId,
    scopes: [...record.scopes],
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
    delivery: record.taskId && record.capabilityGrantId && record.resource
      ? {
          bound: true,
          projectBound: record.resource.projectId !== undefined,
          workspaceBound: record.resource.workspaceId !== undefined,
          changeBound: record.resource.changeId !== undefined,
          sourceSpaceCount: record.sourceSpaceIds.length,
          actionCount: record.deliveryActions.length,
        }
      : { bound: false },
    credentialMaterialStored: false,
  };
}

function authorityString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new RealmIdentityError({ code: "mcp.delivery_payload_invalid", message: "The typed MCP delivery payload is incomplete.", recoveryAction: `send the documented ${field} and retry; no delivery transition was accepted`, receipt: `mcpDelivery=payload-invalid; field=${field}; canonicalWrite=false` });
  return value.trim();
}

function authorityPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RealmIdentityError({ code: "mcp.delivery_payload_invalid", message: "The typed MCP delivery payload is not an object.", recoveryAction: "send the documented typed delivery arguments; no delivery transition was accepted", receipt: "mcpDelivery=payload-invalid; canonicalWrite=false" });
  return value as Record<string, unknown>;
}

function changeForRevision(snapshot: AuthorityPlaneSnapshot, changeRevisionId: string): { id: string; projectId: string; workspaceId?: string } {
  const revision = snapshot.changeRevisions[changeRevisionId];
  const change = revision ? snapshot.changes[revision.changeId] : undefined;
  if (!revision || !change) throw new RealmIdentityError({ code: "mcp.delivery_lineage_not_found", message: "The requested delivery lineage is not available in this Realm.", recoveryAction: "use the exact Project, Change Revision, Release, and Target lineage bound to the MCP resource", receipt: "mcpDelivery=lineage-not-found; discoverable=false; canonicalWrite=false" });
  return { id: change.id, projectId: change.projectId, ...(change.workspaceId ? { workspaceId: change.workspaceId } : revision.workspaceId ? { workspaceId: revision.workspaceId } : {}) };
}

function validateMcpDeliveryLineage(snapshot: AuthorityPlaneSnapshot, operation: McpDeliveryOperation, binding: NonNullable<ReturnType<typeof parseMcpDeliveryBinding>>, payloadValue: unknown): void {
  const payload = authorityPayload(payloadValue);
  const projectId = authorityString(payload.projectId, "projectId");
  const project = snapshot.projects[binding.projectId];
  if (!project || projectId !== binding.projectId) throw new RealmIdentityError({ code: "mcp.delivery_resource_denied", message: "The delivery payload is outside the authorized Project resource.", recoveryAction: "use the Project identifier bound to this MCP resource; no delivery transition was accepted", receipt: "mcpDelivery=project-mismatch; discoverable=false; canonicalWrite=false" });
  const sourceSpaceIds = binding.sourceSpaceIds.length > 0 ? binding.sourceSpaceIds : project.sourceSpaceIds;
  if (sourceSpaceIds.length === 0 || sourceSpaceIds.some((sourceSpaceId) => !project.sourceSpaceIds.includes(sourceSpaceId))) throw new RealmIdentityError({ code: "mcp.delivery_source_space_denied", message: "The MCP resource does not disclose a current Project Source Space set.", recoveryAction: "reauthorize the MCP resource with Source Spaces that belong to the Project", receipt: "mcpDelivery=source-space-mismatch; discoverable=false; canonicalWrite=false" });
  if (binding.workspaceId) {
    const workspace = snapshot.workspaces[binding.workspaceId];
    if (!workspace || workspace.projectId !== binding.projectId) throw new RealmIdentityError({ code: "mcp.delivery_lineage_not_found", message: "The authorized Workspace is not available for this Project.", recoveryAction: "reauthorize against the current Project Workspace; no delivery transition was accepted", receipt: "mcpDelivery=workspace-mismatch; discoverable=false; canonicalWrite=false" });
  }
  if (binding.changeId) {
    const change = snapshot.changes[binding.changeId];
    if (!change || change.projectId !== binding.projectId || (binding.workspaceId !== undefined && change.workspaceId !== binding.workspaceId)) throw new RealmIdentityError({ code: "mcp.delivery_lineage_not_found", message: "The authorized Change is not available for this Project and Workspace.", recoveryAction: "reauthorize against the current Project Change lineage; no delivery transition was accepted", receipt: "mcpDelivery=change-mismatch; discoverable=false; canonicalWrite=false" });
  }
  const requireChangeLineage = (change: { id: string; projectId: string; workspaceId?: string }): void => {
    if (binding.changeId !== undefined && change.id !== binding.changeId) throw new RealmIdentityError({ code: "mcp.delivery_resource_denied", message: "The delivery payload is outside the authorized Change resource.", recoveryAction: "use the Change Revision bound to this MCP resource", receipt: "mcpDelivery=change-mismatch; discoverable=false; canonicalWrite=false" });
    if (binding.workspaceId !== undefined && change.workspaceId !== binding.workspaceId) throw new RealmIdentityError({ code: "mcp.delivery_resource_denied", message: "The delivery payload is outside the authorized Workspace resource.", recoveryAction: "use the Change Revision produced by the authorized Workspace", receipt: "mcpDelivery=workspace-mismatch; discoverable=false; canonicalWrite=false" });
  };
  if (operation === "landing.apply") {
    const changeId = authorityString(payload.changeId, "changeId");
    const change = snapshot.changes[changeId];
    if (!change || change.projectId !== binding.projectId) throw new RealmIdentityError({ code: "mcp.delivery_lineage_not_found", message: "The Landing Change is not available for this Project.", recoveryAction: "use the exact Change Revision lineage bound to the MCP resource", receipt: "mcpDelivery=landing-lineage-mismatch; discoverable=false; canonicalWrite=false" });
    requireChangeLineage({ id: change.id, projectId: change.projectId, ...(change.workspaceId ? { workspaceId: change.workspaceId } : {}) });
  } else if (operation === "release.create") {
    if (binding.changeId !== undefined || binding.workspaceId !== undefined) {
      const changeRevisionId = authorityString(payload.changeRevisionId, "changeRevisionId");
      requireChangeLineage(changeForRevision(snapshot, changeRevisionId));
    }
  } else if (operation === "target.configure") {
    if (binding.changeId !== undefined || binding.workspaceId !== undefined) throw new RealmIdentityError({ code: "mcp.delivery_resource_denied", message: "Target configuration is a Project-level operation and cannot use a Change- or Workspace-bound MCP resource.", recoveryAction: "authorize a Project-scoped MCP resource for target configuration", receipt: "mcpDelivery=target-resource-too-narrow; canonicalWrite=false" });
  } else if (operation === "promotion.request" && (binding.changeId !== undefined || binding.workspaceId !== undefined)) {
    const releaseId = authorityString(payload.releaseId, "releaseId");
    const release = snapshot.releases[releaseId];
    if (!release || release.changeRevisionId === undefined) throw new RealmIdentityError({ code: "mcp.delivery_lineage_not_found", message: "The Promotion Release does not preserve a Change Revision lineage for this resource.", recoveryAction: "create the Release with its exact Change Revision before requesting Promotion", receipt: "mcpDelivery=promotion-lineage-missing; discoverable=false; canonicalWrite=false" });
    requireChangeLineage(changeForRevision(snapshot, release.changeRevisionId));
  }
}

function providerSurface(body: CoordinatorRequestBody): CustomerProviderSurface {
  const value = coordinatorString(body, "surface");
  if (!CUSTOMER_PROVIDER_SURFACES.includes(value as CustomerProviderSurface)) {
    throw new CustomerProviderOperationError({
      code: "invalid-request",
      message: `surface must be one of ${CUSTOMER_PROVIDER_SURFACES.join(", ")}.`,
      recoveryAction: "choose one bounded customer-provider surface and retry without changing the operation identity",
      receipt: `surface=${value}; allowed=${CUSTOMER_PROVIDER_SURFACES.join(",")}; operation=not-created`,
    });
  }
  return value as CustomerProviderSurface;
}

function providerFailureMode(body: CoordinatorRequestBody): CustomerProviderFailureMode {
  const value = typeof body.failureMode === "string" && body.failureMode.trim().length > 0 ? body.failureMode.trim() : "none";
  if (!CUSTOMER_PROVIDER_FAILURE_MODES.includes(value as CustomerProviderFailureMode)) {
    throw new CustomerProviderOperationError({
      code: "invalid-request",
      message: `failureMode must be one of ${CUSTOMER_PROVIDER_FAILURE_MODES.join(", ")}.`,
      recoveryAction: "choose one named qualification failure mode or omit failureMode for a healthy operation",
      receipt: `failureMode=${value}; allowed=${CUSTOMER_PROVIDER_FAILURE_MODES.join(",")}; operation=not-created`,
    });
  }
  return value as CustomerProviderFailureMode;
}

function providerBundle(body: CoordinatorRequestBody): CustomerProviderRecoveryBundle {
  const value = body.bundle;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerProviderOperationError({
      code: "recovery-invalid",
      message: "Provider recovery restore requires the exact credential-free bundle returned by the coordinator.",
      recoveryAction: "export a fresh provider recovery bundle and submit it unchanged",
      receipt: "providerRecovery=bundle-required; authority=not-restored",
    });
  }
  return value as CustomerProviderRecoveryBundle;
}

function qualificationCredentialClasses(body: CoordinatorRequestBody): readonly CredentialClass[] {
  const requested = body.credentialClasses;
  if (requested === undefined) return [...REALM_QUALIFICATION_CREDENTIAL_CLASSES];
  if (!Array.isArray(requested) || requested.length === 0 || requested.some((value) => typeof value !== "string" || !REALM_QUALIFICATION_CREDENTIAL_CLASSES.includes(value as CredentialClass))) {
    throw new RealmIdentityError({ code: "qualification.credential_classes_invalid", message: "The qualification exchange accepts only the explicitly supported Git and MCP credential classes.", recoveryAction: "request one or both of the git and mcp credential classes", receipt: "credentialClasses=git,mcp-only" });
  }
  return [...new Set(requested as CredentialClass[])];
}

function recoverySnapshot(body: CoordinatorRequestBody): RealmRecoverySnapshot {
  const value = body.snapshot;
  if (value === null || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).credentialFree !== true || Object.prototype.hasOwnProperty.call(value, "credentials")) {
    throw new RealmIdentityError({ code: "recovery.snapshot_invalid", message: "Recovery restore requires a credential-free Realm snapshot produced by this coordinator.", recoveryAction: "export a fresh credential-free snapshot and submit it without credential fields", receipt: "recoverySnapshot=credential-free-required" });
  }
  return value as RealmRecoverySnapshot;
}

const AUTHORITY_RECOVERY_FIELDS = [
  "protocol",
  "realmId",
  "version",
  "projects",
  "sourceSpaces",
  "projectRevisions",
  "projectViews",
  "workspaces",
  "changes",
  "changeRevisions",
  "runs",
  "runnerProfiles",
  "runnerAttempts",
  "evidence",
  "artifacts",
  "landings",
  "releases",
  "targets",
  "promotions",
  "mirrors",
  "mirrorOperations",
  "mirrorCheckpoints",
  "externalProposals",
  "mirrorDeliveries",
  "canonicalByProject",
  "idempotency",
  "audit",
] as const;

function authorityRecoveryCredentialField(value: unknown): string | undefined {
  const pending: Array<{ value: unknown; path: string }> = [{ value, path: "snapshot" }];
  const forbidden = /^(?:access|refresh|provider|api)?token$|^(?:client)?secret$|^password$|^credentials?$|^private[_-]?key$|^authorization(?:[_-]?header)?$/iu;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.value === null || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((entry, index) => pending.push({ value: entry, path: `${current.path}[${index}]` }));
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      if (forbidden.test(key)) return `${current.path}.${key}`;
      pending.push({ value: child, path: `${current.path}.${key}` });
    }
  }
  return undefined;
}

function authorityRecoverySnapshot(body: CoordinatorRequestBody, realmId: string): AuthorityPlaneSnapshot {
  const value = body.snapshot;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: "Authority recovery restore requires a full Authority Plane snapshot object.",
      recoveryAction: "export a fresh Authority Plane snapshot and submit it without credential or identity-recovery fields",
      receipt: "authorityRecoverySnapshot=object-required; restore=not-applied; credentialMaterialStored=false",
    });
  }
  const raw = value as Record<string, unknown>;
  const unknownField = Object.keys(raw).find((key) => !(AUTHORITY_RECOVERY_FIELDS as readonly string[]).includes(key));
  if (unknownField) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: `Authority recovery snapshot contains unsupported field ${unknownField}.`,
      recoveryAction: "submit only the credential-free Authority Plane snapshot fields returned by the Authority recovery export",
      receipt: `authorityRecoverySnapshot=unsupported-field; field=${unknownField}; restore=not-applied; credentialMaterialStored=false`,
    });
  }
  const missingField = AUTHORITY_RECOVERY_FIELDS.find((field) => !Object.prototype.hasOwnProperty.call(raw, field));
  if (missingField) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: `Authority recovery snapshot is missing ${missingField}.`,
      recoveryAction: "export a fresh complete Authority Plane snapshot and retry; the existing Authority state is unchanged",
      receipt: `authorityRecoverySnapshot=complete-required; missing=${missingField}; restore=not-applied; credentialMaterialStored=false`,
    });
  }
  if (raw.protocol !== AUTHORITY_PLANE_PROTOCOL || raw.realmId !== realmId) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: "Authority recovery snapshot belongs to a different protocol or Realm.",
      recoveryAction: "restore only the snapshot exported by this customer Realm Authority",
      receipt: "authorityRecoverySnapshot=realm-or-protocol-mismatch; restore=not-applied; credentialMaterialStored=false",
    });
  }
  const credentialField = authorityRecoveryCredentialField(raw);
  if (credentialField) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: `Authority recovery snapshot contains credential field ${credentialField}.`,
      recoveryAction: "restore only the credential-free Authority Plane snapshot returned by the customer Realm",
      receipt: `authorityRecoverySnapshot=credential-field-rejected; field=${credentialField}; restore=not-applied; credentialMaterialStored=false`,
    });
  }
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 0) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: "Authority recovery snapshot version must be a non-negative safe integer.",
      recoveryAction: "export a fresh Authority Plane snapshot and retry; the existing Authority state is unchanged",
      receipt: "authorityRecoverySnapshot=version-invalid; restore=not-applied; credentialMaterialStored=false",
    });
  }
  try {
    return normalizeAuthorityPlaneSnapshot(raw as AuthorityPlaneSnapshot);
  } catch (error) {
    if (error instanceof AuthorityPlaneError) throw error;
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: "Authority recovery snapshot could not be normalized.",
      recoveryAction: "export a fresh complete Authority Plane snapshot and retry; the existing Authority state is unchanged",
      receipt: "authorityRecoverySnapshot=normalization-failed; restore=not-applied; credentialMaterialStored=false",
    });
  }
}

function identitySummary(identity: RealmIdentityPolicy): Record<string, unknown> {
  const snapshot = identity.getRecoverySnapshot();
  const ownerRelationships = Object.values(snapshot.relationships).filter((relationship) => relationship.role === "owner" && relationship.status === "active");
  return {
    realmId: snapshot.realm.id,
    policyVersion: snapshot.realm.policyVersion,
    authorizationEpoch: snapshot.realm.authorizationEpoch,
    principalCount: Object.keys(snapshot.principals).length,
    passkeyCount: Object.keys(snapshot.passkeys).length,
    activeOwnerCount: ownerRelationships.length,
    activeSessionCount: Object.values(snapshot.sessions).filter((session) => session.status === "active").length,
    activeGrantCount: Object.values(snapshot.grants).filter((grant) => grant.status === "active").length,
    credentialFree: snapshot.credentialFree,
  };
}

function coordinatorError(error: unknown): Response {
  if (error instanceof AuthorityPlaneError) {
    const status = error.code === "not_found" ? 404 : error.code === "stale_state" || error.code === "conflict" || error.code === "idempotency_conflict" ? 409 : error.code === "blocked" ? 409 : error.code === "indeterminate" ? 503 : 422;
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, code: error.code, message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt }, status);
  }
  if (error instanceof CustomerProviderOperationError) {
    const status = error.code === "not-found" ? 404 : error.code === "idempotency-conflict" || error.code === "stale-state" ? 409 : error.code === "unauthorized" ? 403 : 422;
    return coordinatorJson({ protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL, ...error.toJSON() }, status);
  }
  if (error instanceof RealmIdentityError) {
    const status = error.code.endsWith(".exists") ? 409 : error.code.includes("not_found") ? 404 : 422;
    return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, code: error.code, recoveryAction: error.recoveryAction, receipt: error.receipt ?? "realm-identity=operation-failed" }, status);
  }
  const message = error instanceof Error ? error.message : "realm coordinator operation failed";
  return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, code: "realm.coordinator.invalid_request", recoveryAction: "inspect the coordinator input and retry; no partial identity transition was accepted", receipt: `coordinator=exception; message=${message}` }, 422);
}

/**
 * The coordinator is exported so Wrangler can provision the SQLite-backed
 * Durable Object namespace. Its routes are intentionally narrow: they only
 * hydrate and transition Realm identity state required by the owner adapter.
 * Project, Git, Landing, and Promotion authority remain separate boundaries.
 */
export class AnyamRealmCoordinator extends DurableObject<Env> {
  private readonly initialized: Promise<void>;
  private identity: RealmIdentityPolicy | undefined;
  private githubActionsBridge!: GitHubActionsBridgeAuthority;
  private githubActionsBridgeImports!: GitHubActionsBridgeImportCoordinator;
  private githubActionsBridgeOutbound!: GitHubActionsBridgeOutboundCoordinator;
  private recoveryStatus: RealmRecoveryStatus = "active";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      const snapshot = await ctx.storage.get<RealmRecoverySnapshot>(REALM_IDENTITY_SNAPSHOT_KEY);
      const storedRecoveryStatus = await ctx.storage.get<RealmRecoveryStatus>(REALM_RECOVERY_STATUS_KEY);
      this.recoveryStatus = storedRecoveryStatus === "recovery-pending" ? storedRecoveryStatus : "active";
      const realmId = snapshot?.realm.id ?? `realm:${env.ANYAM_INSTALLATION_ID ?? "unconfigured"}`;
      this.identity = new RealmIdentityPolicy({
        realmId,
        relyingPartyId: snapshot?.realm.relyingPartyId ?? env.ANYAM_REALM_RP_ID ?? "anyam.local",
      });
      if (snapshot) this.identity.restoreOperationalSnapshot(snapshot);
      const bridgeSnapshot = await ctx.storage.get<GitHubActionsBridgeSnapshot>(REALM_GITHUB_ACTIONS_BRIDGE_SNAPSHOT_KEY);
      this.githubActionsBridge = new GitHubActionsBridgeAuthority(bridgeSnapshot ? { snapshot: bridgeSnapshot } : {});
      const importSnapshot = await ctx.storage.get<GitHubActionsBridgeImportSnapshot>(REALM_GITHUB_ACTIONS_BRIDGE_IMPORT_SNAPSHOT_KEY);
      this.githubActionsBridgeImports = new GitHubActionsBridgeImportCoordinator({ ledger: new MemoryGitHubActionsBridgeImportLedger(importSnapshot?.completedOperationIds ?? []) });
      const outboundSnapshot = await ctx.storage.get<GitHubActionsBridgeOutboundSnapshot>(REALM_GITHUB_ACTIONS_BRIDGE_OUTBOUND_SNAPSHOT_KEY);
      this.githubActionsBridgeOutbound = new GitHubActionsBridgeOutboundCoordinator({ ledger: new MemoryGitHubActionsBridgeOutboundReplayLedger(outboundSnapshot?.completedOperationIds ?? []) });
    });
  }

  private requireIdentity(): RealmIdentityPolicy {
    if (!this.identity) throw new Error("realm identity is not hydrated");
    return this.identity;
  }

  private requireGitHubActionsBridge(): GitHubActionsBridgeAuthority {
    if (!this.githubActionsBridge) throw new Error("github_actions_bridge_not_hydrated");
    return this.githubActionsBridge;
  }

  private requireGitHubActionsBridgeImports(): GitHubActionsBridgeImportCoordinator {
    if (!this.githubActionsBridgeImports) throw new Error("github_actions_bridge_import_not_hydrated");
    return this.githubActionsBridgeImports;
  }

  private async persistGitHubActionsBridge(): Promise<void> {
    await this.ctx.storage.put(REALM_GITHUB_ACTIONS_BRIDGE_SNAPSHOT_KEY, this.requireGitHubActionsBridge().snapshot());
  }

  private async persistGitHubActionsBridgeImports(): Promise<void> {
    await this.ctx.storage.put(REALM_GITHUB_ACTIONS_BRIDGE_IMPORT_SNAPSHOT_KEY, this.requireGitHubActionsBridgeImports().snapshot());
  }

  private requireGitHubActionsBridgeOutbound(): GitHubActionsBridgeOutboundCoordinator {
    if (!this.githubActionsBridgeOutbound) throw new Error("github_actions_bridge_outbound_not_hydrated");
    return this.githubActionsBridgeOutbound;
  }

  private async persistGitHubActionsBridgeOutbound(): Promise<void> {
    await this.ctx.storage.put(REALM_GITHUB_ACTIONS_BRIDGE_OUTBOUND_SNAPSHOT_KEY, this.requireGitHubActionsBridgeOutbound().snapshot());
  }

  private async persistIdentity(): Promise<void> {
    await this.ctx.storage.put(REALM_IDENTITY_SNAPSHOT_KEY, this.requireIdentity().getRecoverySnapshot());
    await this.ctx.storage.put(REALM_RECOVERY_STATUS_KEY, this.recoveryStatus);
  }

  private async transitionIdentity<T>(operation: (identity: RealmIdentityPolicy) => Promise<T> | T): Promise<T> {
    const identity = this.requireIdentity();
    const before = identity.getRecoverySnapshot();
    const beforeRecoveryStatus = this.recoveryStatus;
    try {
      const result = await operation(identity);
      await this.persistIdentity();
      return result;
    } catch (error) {
      identity.restoreOperationalSnapshot(before);
      this.recoveryStatus = beforeRecoveryStatus;
      throw error;
    }
  }

  private providerCoordinator(): CustomerProviderQualificationCoordinator {
    const snapshot = this.requireIdentity().getRecoverySnapshot();
    const installationId = this.env.ANYAM_INSTALLATION_ID?.trim() || "unconfigured";
    return new CustomerProviderQualificationCoordinator({
      realmId: snapshot.realm.id,
      installationId,
      store: new CustomerProviderDurableObjectOperationStore(
        this.ctx.storage as unknown as import("../../../src/cloudflare/customer-provider-operation.ts").CustomerProviderDurableObjectStorage,
        snapshot.realm.id,
        installationId,
      ),
      adapters: createCloudflareCustomerProviderAdapters({
        metadata: this.env.ANYAM_METADATA_DB,
        exports: this.env.ANYAM_EXPORTS,
        events: this.env.ANYAM_EVENTS,
        workflow: this.env.ANYAM_WORKFLOW,
        ...(this.env.ANYAM_PROVIDER_WORKER ? { worker: this.env.ANYAM_PROVIDER_WORKER } : {}),
        ...(this.env.ANYAM_PROVIDER_WORKER_URL ? { workerUrl: this.env.ANYAM_PROVIDER_WORKER_URL } : {}),
      }),
    });
  }

  private providerOwnerAuthorization(humanSessionId: string): CustomerProviderOwnerAuthorization {
    const identity = this.requireIdentity();
    const session = identity.validateSession(humanSessionId);
    const snapshot = identity.getRecoverySnapshot();
    const isOwner = Object.values(snapshot.relationships).some((relationship) => relationship.principalId === session.principalId && relationship.role === "owner" && relationship.status === "active");
    if (!isOwner) {
      throw new RealmIdentityError({
        code: "qualification.provider_owner_denied",
        message: "The bounded customer-provider operation is owner-only.",
        recoveryAction: "authenticate an active Realm owner session before invoking the provider qualification fixture",
        receipt: `principal=${session.principalId}; owner=false; providerOperation=not-created`,
      });
    }
    return {
      realmId: snapshot.realm.id,
      principalId: session.principalId,
      sessionId: session.id,
      capability: "provider.qualification",
      authorizationEpoch: String(snapshot.realm.authorizationEpoch),
      receipt: `owner=verified; realm=${snapshot.realm.id}; session=${session.id}; capability=provider.qualification; credentialMaterialStored=false`,
    };
  }

  private authorityOwnerSession(humanSessionId: string): AuthoritySession {
    const identity = this.requireIdentity();
    const session = identity.validateSession(humanSessionId);
    const snapshot = identity.getRecoverySnapshot();
    const isOwner = Object.values(snapshot.relationships).some((relationship) => relationship.principalId === session.principalId && relationship.role === "owner" && relationship.status === "active" && relationship.resource.realmId === snapshot.realm.id);
    if (!isOwner) {
      throw new RealmIdentityError({
        code: "authority.owner_denied",
        message: "The Authority Plane vertical slice is owner-only until project membership and capability policy are qualified.",
        recoveryAction: "authenticate an active Realm owner session before issuing an Authority command",
        receipt: `principal=${session.principalId}; owner=false; authorityCommand=not-accepted`,
      });
    }
    return {
      realmId: snapshot.realm.id,
      principalId: session.principalId,
      actorId: session.actorId,
      sessionId: session.id,
      clientId: session.clientId,
      authorizationEpoch: snapshot.realm.authorizationEpoch,
    };
  }

  private authorityCapabilitySession(humanSessionId: string, capability: Capability, resource: ResourceRef, requirePasskey = false): AuthoritySession {
    const identity = this.requireIdentity();
    const session = identity.validateSession(humanSessionId);
    const actor = identity.getRecoverySnapshot().actors[session.actorId];
    if (!actor || actor.kind !== "human") throw new RealmIdentityError({ code: "authority.human_session_required", message: "This hosted Authority operation requires a human Realm Session.", recoveryAction: "authenticate with a human Realm identity before requesting the operation", receipt: `capability=${capability}; actor=human-required; authorityCommand=not-accepted` });
    if (requirePasskey && session.strength !== "passkey") throw new RealmIdentityError({ code: "authority.passkey_required", message: `Capability ${capability} requires a recent passkey-authenticated session.`, recoveryAction: "authenticate the Realm owner or team member with a passkey and retry the protected operation", receipt: `capability=${capability}; authenticationStrength=${session.strength}; passkey=required; authorityCommand=not-accepted` });
    const capabilities = identity.activeCapabilitiesForPrincipal({ principalId: session.principalId, resource });
    if (!capabilities.includes(capability)) throw new RealmIdentityError({ code: "authority.capability_denied", message: `Capability ${capability} is not granted for this Authority resource.`, recoveryAction: "grant the Principal an active Team/Organization relationship with this capability, then re-authenticate and retry", receipt: `principal=${session.principalId}; capability=${capability}; resourceProject=${resource.projectId ?? "realm"}; authorityCommand=not-accepted` });
    return { realmId: session.realmId, principalId: session.principalId, actorId: session.actorId, sessionId: session.id, clientId: session.clientId, authorizationEpoch: identity.realm.authorizationEpoch, kind: "human" };
  }

  private authorityHumanSession(humanSessionId: string): AuthoritySession {
    const identity = this.requireIdentity();
    const session = identity.validateSession(humanSessionId);
    const actor = identity.getRecoverySnapshot().actors[session.actorId];
    if (!actor || actor.kind !== "human") throw new RealmIdentityError({ code: "authority.human_session_required", message: "This hosted Authority operation requires a human Realm Session.", recoveryAction: "authenticate with a human Realm identity before requesting the operation", receipt: "actor=human-required; authority=not-accepted" });
    return { realmId: session.realmId, principalId: session.principalId, actorId: session.actorId, sessionId: session.id, clientId: session.clientId, authorizationEpoch: identity.realm.authorizationEpoch, kind: "human" };
  }

  private async authoritySnapshot(): Promise<AuthorityPlaneSnapshot> {
    const stored = await this.ctx.storage.get<AuthorityPlaneSnapshot>(REALM_AUTHORITY_SNAPSHOT_KEY);
    return stored ? normalizeAuthorityPlaneSnapshot(stored) : emptyAuthorityPlaneSnapshot(this.requireIdentity().realm.id);
  }

  private async authorityRecoveryStatus(): Promise<AuthorityRecoveryStatus> {
    const stored = await this.ctx.storage.get<AuthorityRecoveryStatus>(REALM_AUTHORITY_RECOVERY_STATUS_KEY);
    return stored === "quarantined" ? stored : "active";
  }

  private async requireAuthorityActive(): Promise<void> {
    const status = await this.authorityRecoveryStatus();
    if (status === "quarantined") throw new AuthorityPlaneError({ code: "blocked", message: "Authority is quarantined after recovery and cannot accept normal mutations.", recoveryAction: "reconcile the restored snapshot and complete the passkey-authenticated Authority recovery activation ceremony", receipt: "authorityRecovery=quarantined; mutation=not-accepted; canonicalWrite=false" });
  }

  private authorityRecoveryKey(): { keyId: string; secret: string } {
    const keyId = this.env.ANYAM_AUTHORITY_RECOVERY_KEY_ID?.trim();
    const secret = this.env.ANYAM_AUTHORITY_RECOVERY_SECRET?.trim();
    if (!keyId || !secret) throw new AuthorityPlaneError({ code: "blocked", message: "Authority recovery is not configured with an independent customer-owned recovery key.", recoveryAction: "configure ANYAM_AUTHORITY_RECOVERY_KEY_ID and the secret ANYAM_AUTHORITY_RECOVERY_SECRET before enabling Authority recovery", receipt: `authorityRecovery=key-not-configured; keyId=${keyId ? "present" : "missing"}; secret=${secret ? "present" : "missing"}; restore=not-applied` });
    return { keyId, secret };
  }

  private delegationAuthority(body: CoordinatorRequestBody, snapshot: AuthorityPlaneSnapshot): { projectId: string; workspaceId: string; changeId: string; sourceSpaceIds: string[]; resource: { realmId: string; projectId: string; workspaceId: string; changeId: string; sourceSpaceId?: string }; sources: AuthorityPlaneSnapshot["sourceSpaces"] } {
    const projectId = coordinatorString(body, "projectId");
    const workspaceId = coordinatorString(body, "workspaceId");
    const changeId = coordinatorString(body, "changeId");
    const sourceSpaceIds = coordinatorStringArray(body, "sourceSpaceIds");
    const project = snapshot.projects[projectId];
    const workspace = snapshot.workspaces[workspaceId];
    const change = snapshot.changes[changeId];
    if (!project || !workspace || !change || workspace.projectId !== projectId || change.projectId !== projectId || change.workspaceId !== workspaceId || workspace.state !== "active" || change.status === "landed" || change.status === "abandoned") throw new AuthorityPlaneError({ code: "not_found", message: "The requested Project, Workspace, or Change is not available for this delegation.", recoveryAction: "select one active Project, its active Workspace, and the assigned non-terminal Change without probing hidden resources", receipt: "delegation=authority-resource-mismatch; discoverable=false; transition=not-applied" });
    const mountedSourceSpaceIds = new Set(workspace.mounts.map((mount) => mount.sourceSpaceId));
    const sources: AuthorityPlaneSnapshot["sourceSpaces"] = {};
    for (const sourceSpaceId of sourceSpaceIds) {
      const source = snapshot.sourceSpaces[sourceSpaceId];
      if (!source || !project.sourceSpaceIds.includes(sourceSpaceId) || !mountedSourceSpaceIds.has(sourceSpaceId)) throw new AuthorityPlaneError({ code: "not_found", message: "A requested Source Space is not available in the Project Workspace.", recoveryAction: "select only Source Spaces declared by the Project and mounted by the active Workspace", receipt: "delegation=source-space-mismatch; discoverable=false; transition=not-applied" });
      sources[sourceSpaceId] = source;
    }
    return { projectId, workspaceId, changeId, sourceSpaceIds, resource: { realmId: snapshot.realmId, projectId, workspaceId, changeId, ...(sourceSpaceIds.length === 1 ? { sourceSpaceId: sourceSpaceIds[0] } : {}) }, sources };
  }

  private safeDelegation(next: RealmIdentityPolicy, input: { agentId: string; sessionId: string; taskId: string; grantId: string; status: "delegated" | "already-delegated" }): Record<string, unknown> {
    const snapshot = next.getRecoverySnapshot();
    const agent = snapshot.agents[input.agentId];
    const session = snapshot.sessions[input.sessionId];
    const task = snapshot.tasks[input.taskId];
    const grant = snapshot.grants[input.grantId];
    if (!agent || !session || !task || !grant) throw new RealmIdentityError({ code: "delegation.incomplete", message: "The delegation did not produce a complete Agent, Session, Task, and Grant chain.", recoveryAction: "retry after reconciling the Realm identity snapshot; no credentials were issued", receipt: "agent-session-task-grant=complete-required; credentials=not-issued" });
    return {
      protocol: REALM_COORDINATOR_PROTOCOL,
      status: input.status,
      agent: { id: agent.id, name: agent.name, runtime: agent.runtime, modelProvider: agent.modelProvider, clientId: agent.clientId, allowedCredentialClasses: [...agent.allowedCredentialClasses], status: agent.status },
      session: { id: session.id, actorKind: session.actorKind, agentId: session.agentId, expiresAt: session.expiresAt, status: session.status },
      task: { id: task.id, purpose: task.purpose, workspaceId: task.workspaceId, changeId: task.changeId, modelProvider: task.modelProvider, agentId: task.agentId, createdAt: task.createdAt, status: task.status },
      grant: { id: grant.id, resource: grant.resource, sourceSpaceIds: [...grant.sourceSpaceIds], actions: [...grant.actions], effects: [...grant.effects], allowedCredentialClasses: [...grant.allowedCredentialClasses], budget: grant.budget, expiresAt: grant.expiresAt, status: grant.status, agentId: grant.agentId },
      credentialClasses: [...grant.allowedCredentialClasses],
      credentials: "not-issued",
      credentialExchange: "explicit-later",
      credentialExchangePath: "/api/owner/agent/delegations/credentials",
      canonicalWrite: false,
      credentialMaterialStored: false,
      receipt: `kernelMembership=verified; delegation=${input.status}; project=${grant.resource.projectId ?? "missing"}; workspace=${grant.resource.workspaceId ?? "missing"}; change=${grant.resource.changeId ?? "missing"}; credentials=not-issued; exchange=explicit; canonicalWrite=false; credentialMaterialStored=false`,
    };
  }

  private async authorityState(humanSessionId: string): Promise<Response> {
    const session = this.authorityOwnerSession(humanSessionId);
    const snapshot = await this.authoritySnapshot();
    const recoveryStatus = await this.authorityRecoveryStatus();
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: recoveryStatus === "active" ? "ready" : "quarantined", authority: authorityStateSummary(snapshot), recoveryStatus, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; persistence=durable-object-storage; version=${snapshot.version}; recoveryStatus=${recoveryStatus}; credentialFree=true; canonicalWrite=landing-only` });
  }

  private async authorityRecoveryExport(humanSessionId: string): Promise<Response> {
    // This exports only the Authority Plane. Identity recovery remains a
    // separate owner ceremony and is intentionally not touched here.
    const session = this.authorityOwnerSession(humanSessionId);
    const snapshot = await this.authoritySnapshot();
    const recoveryKey = this.authorityRecoveryKey();
    const bundle = await createAuthorityRecoveryBundle({ snapshot, bundleId: crypto.randomUUID(), recoveryKeyId: recoveryKey.keyId, secret: recoveryKey.secret });
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "recovery-exported", ownerPrincipalId: session.principalId, bundle, recoveryKeyId: recoveryKey.keyId, snapshotVersion: snapshot.version, credentialFree: true, canonicalWrite: false, receipt: `authorityRecovery=exported; protocol=${AUTHORITY_RECOVERY_PROTOCOL}; version=${snapshot.version}; auditChain=signed; recoveryKeyId=${recoveryKey.keyId}; credentialMaterialStored=false; canonicalWrite=false` });
  }

  private async authorityRecoveryRestore(body: CoordinatorRequestBody): Promise<Response> {
    // Restore only a signed, version-bound bundle. Owner identity, passkeys,
    // sessions, and grants remain outside this recovery boundary.
    const humanSessionId = coordinatorString(body, "sessionId");
    coordinatorString(body, "idempotencyKey");
    const session = this.authorityOwnerSession(humanSessionId);
    const recoveryKey = this.authorityRecoveryKey();
    const verification = await verifyAuthorityRecoveryBundle({ value: body.bundle, realmId: this.requireIdentity().realm.id, recoveryKeyId: recoveryKey.keyId, secret: recoveryKey.secret });
    if (!verification.valid) throw new AuthorityPlaneError({ code: verification.code === "bundle_digest_mismatch" ? "conflict" : "invalid_request", message: "Authority recovery bundle verification failed.", recoveryAction: verification.recoveryAction, receipt: `${verification.receipt}; credentialMaterialStored=false` });
    const bundle: AuthorityRecoveryBundle = verification.bundle;
    if (bundle.snapshot.version !== bundle.expectedVersion) throw new AuthorityPlaneError({ code: "invalid_request", message: "Authority recovery bundle version does not match its snapshot.", recoveryAction: "export a fresh recovery bundle and submit it unchanged", receipt: `authorityRecovery=version-mismatch; bundle=${bundle.expectedVersion}; snapshot=${bundle.snapshot.version}; restore=not-applied` });
    const restoreKey = `${REALM_AUTHORITY_RECOVERY_RESTORE_PREFIX}${bundle.bundleId}`;
    const existing = await this.ctx.storage.get<StoredAuthorityRecoveryRestore>(restoreKey);
    if (existing) {
      if (existing.bundleDigest !== bundle.bundleDigest) throw new AuthorityPlaneError({ code: "conflict", message: "Authority recovery bundle identity was already used with a different digest.", recoveryAction: "use a fresh export bundle identity; the existing quarantined state was not changed", receipt: `authorityRecovery=replay-conflict; bundleId=${bundle.bundleId}; restore=not-applied` });
      const recoveryStatus = await this.authorityRecoveryStatus();
      return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: recoveryStatus === "quarantined" ? "recovery-quarantined" : "recovery-already-active", ownerPrincipalId: session.principalId, bundleId: bundle.bundleId, snapshotVersion: existing.snapshotVersion, recoveryStatus, credentialFree: true, canonicalWrite: false, receipt: `authorityRecovery=replay-idempotent; bundleId=${bundle.bundleId}; recoveryStatus=${recoveryStatus}; state=unchanged; credentialMaterialStored=false` });
    }
    const current = await this.authoritySnapshot();
    if (current.version !== bundle.expectedVersion) throw new AuthorityPlaneError({ code: "stale_state", message: "Authority recovery bundle is stale for the current Authority version.", recoveryAction: "export a fresh bundle from the current Authority and retry; no snapshot was replaced", receipt: `authorityRecovery=stale; expectedVersion=${bundle.expectedVersion}; currentVersion=${current.version}; restore=not-applied` });
    const snapshot = authorityRecoverySnapshot({ snapshot: bundle.snapshot }, this.requireIdentity().realm.id);
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put(REALM_AUTHORITY_SNAPSHOT_KEY, snapshot);
      await this.ctx.storage.put(REALM_AUTHORITY_RECOVERY_STATUS_KEY, "quarantined" satisfies AuthorityRecoveryStatus);
      await this.ctx.storage.put(restoreKey, { protocol: AUTHORITY_RECOVERY_PROTOCOL, bundleId: bundle.bundleId, bundleDigest: bundle.bundleDigest, snapshotVersion: snapshot.version, restoredAt: new Date().toISOString() } satisfies StoredAuthorityRecoveryRestore);
    });
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "recovery-quarantined", ownerPrincipalId: session.principalId, bundleId: bundle.bundleId, snapshotVersion: snapshot.version, recoveryStatus: "quarantined", credentialFree: true, canonicalWrite: false, receipt: `authorityRecovery=restored; version=${snapshot.version}; state=quarantined; auditChain=signed; credentialMaterialStored=false; canonicalWrite=false` });
  }

  private async authorityRecoveryActivate(body: CoordinatorRequestBody): Promise<Response> {
    const humanSessionId = coordinatorString(body, "sessionId");
    coordinatorString(body, "idempotencyKey");
    const session = this.authorityOwnerSession(humanSessionId);
    const identitySession = this.requireIdentity().getRecoverySnapshot().sessions[humanSessionId];
    if (!identitySession || identitySession.strength !== "passkey") throw new AuthorityPlaneError({ code: "blocked", message: "Authority recovery activation requires a passkey-authenticated owner session.", recoveryAction: "authenticate the Realm owner with a passkey and retry activation", receipt: "authorityRecovery=activation-passkey-required; activation=not-applied" });
    const status = await this.authorityRecoveryStatus();
    if (status !== "quarantined") return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "already-active", ownerPrincipalId: session.principalId, recoveryStatus: "active", credentialFree: true, canonicalWrite: false, receipt: "authorityRecovery=activation-idempotent; recoveryStatus=active; state=unchanged; credentialMaterialStored=false" });
    const bundleId = coordinatorString(body, "bundleId");
    const bundleDigest = coordinatorString(body, "bundleDigest");
    const stored = await this.ctx.storage.get<StoredAuthorityRecoveryRestore>(`${REALM_AUTHORITY_RECOVERY_RESTORE_PREFIX}${bundleId}`);
    if (!stored || stored.bundleDigest !== bundleDigest) throw new AuthorityPlaneError({ code: "conflict", message: "Authority recovery activation does not match the quarantined bundle.", recoveryAction: "use the exact bundle ID and digest returned by the recovery restore receipt", receipt: `authorityRecovery=activation-bundle-mismatch; bundleId=${bundleId}; activation=not-applied` });
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put(REALM_AUTHORITY_RECOVERY_STATUS_KEY, "active" satisfies AuthorityRecoveryStatus);
      await this.ctx.storage.put(`${REALM_AUTHORITY_RECOVERY_RESTORE_PREFIX}${bundleId}`, { ...stored, activatedAt: new Date().toISOString() });
    });
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "recovery-activated", ownerPrincipalId: session.principalId, bundleId, snapshotVersion: stored.snapshotVersion, recoveryStatus: "active", credentialFree: true, canonicalWrite: false, receipt: `authorityRecovery=activated; bundleId=${bundleId}; recoveryStatus=active; passkey=verified; credentialMaterialStored=false; canonicalWrite=false` });
  }

  private authorityProjectSummary(snapshot: AuthorityPlaneSnapshot, projectId: string) {
    const project = snapshot.projects[projectId];
    if (!project) throw new AuthorityPlaneError({ code: "not_found", message: `Project ${projectId} is not available in this Realm.`, recoveryAction: "verify the Project identifier without probing undiscoverable resources", receipt: `project=${projectId}; operation=project.inspect; discoverable=false` });
    const canonicalId = snapshot.canonicalByProject[projectId];
    const canonicalRevision = canonicalId ? snapshot.projectRevisions[canonicalId] : undefined;
    if (!canonicalRevision) throw new AuthorityPlaneError({ code: "indeterminate", message: `Project ${projectId} has no readable canonical Project Revision.`, recoveryAction: "reconcile the Authority snapshot before exposing the Project summary", receipt: `project=${projectId}; canonicalRevision=missing; operation=project.inspect` });
    const sourceSpaces = project.sourceSpaceIds.map((sourceSpaceId) => snapshot.sourceSpaces[sourceSpaceId]).filter((sourceSpace): sourceSpace is NonNullable<typeof sourceSpace> => sourceSpace !== undefined);
    const projectIds = (value: { projectId?: string } | undefined): boolean => value?.projectId === projectId;
    const counts = {
      workspaces: Object.values(snapshot.workspaces).filter(projectIds).length,
      intents: Object.values(snapshot.intents).filter(projectIds).length,
      intentComments: Object.values(snapshot.intentComments).filter((comment) => comment.projectId === projectId).length,
      pullRequests: Object.values(snapshot.pullRequests).filter(projectIds).length,
      changes: Object.values(snapshot.changes).filter(projectIds).length,
      revisions: Object.values(snapshot.changeRevisions).filter((revision) => snapshot.changes[revision.changeId]?.projectId === projectId).length,
      runs: Object.values(snapshot.runs).filter((run) => snapshot.projectRevisions[run.projectRevisionId]?.projectId === projectId).length,
      evidence: Object.values(snapshot.evidence).filter((evidence) => snapshot.projectRevisions[evidence.projectRevisionId]?.projectId === projectId).length,
      artifacts: Object.values(snapshot.artifacts).filter((artifact) => snapshot.projectRevisions[artifact.projectRevisionId]?.projectId === projectId).length,
      releases: Object.values(snapshot.releases).filter((release) => snapshot.projectRevisions[release.projectRevisionId]?.projectId === projectId).length,
      targets: Object.values(snapshot.targets).filter(projectIds).length,
      promotions: Object.values(snapshot.promotions).filter(projectIds).length,
    };
    return { project, canonicalRevision, sourceSpaces, counts };
  }

  private authorityWorkspaceSummary(snapshot: AuthorityPlaneSnapshot, workspaceId: string) {
    const workspace = snapshot.workspaces[workspaceId];
    if (!workspace) throw new AuthorityPlaneError({ code: "not_found", message: `Workspace ${workspaceId} is not available in this Realm.`, recoveryAction: "verify the Workspace identifier without probing undiscoverable resources", receipt: `workspace=${workspaceId}; operation=workspace.inspect; discoverable=false` });
    const project = snapshot.projects[workspace.projectId];
    if (!project) throw new AuthorityPlaneError({ code: "indeterminate", message: `Workspace ${workspaceId} refers to a Project that is not readable.`, recoveryAction: "reconcile the Authority snapshot before exposing the Workspace summary", receipt: `workspace=${workspaceId}; project=missing; operation=workspace.inspect` });
    return {
      workspace: {
        protocol: workspace.protocol,
        id: workspace.id,
        projectId: workspace.projectId,
        projectRevisionId: workspace.projectRevisionId,
        projectViewId: workspace.projectViewId,
        state: workspace.state,
        ...(workspace.changeId ? { changeId: workspace.changeId } : {}),
      },
      project: {
        protocol: project.protocol,
        id: project.id,
        name: project.name,
        referenceType: project.referenceType,
      },
      mountCount: workspace.mounts.length,
    };
  }

  private authorityChangeRevisionSummary(revision: AuthorityPlaneSnapshot["changeRevisions"][string]) {
    return {
      protocol: revision.protocol,
      id: revision.id,
      changeId: revision.changeId,
      projectRevisionId: revision.projectRevisionId,
      projectViewId: revision.projectViewId,
      sequence: revision.sequence,
      ...(revision.parentRevisionId ? { parentRevisionId: revision.parentRevisionId } : {}),
      ...(revision.baseProjectRevisionId ? { baseProjectRevisionId: revision.baseProjectRevisionId } : {}),
      ...(revision.workspaceId ? { workspaceId: revision.workspaceId } : {}),
      declaredEffects: [...revision.declaredEffects],
      ...(revision.affectedModuleIds ? { affectedModuleIds: [...revision.affectedModuleIds] } : {}),
      ...(revision.affectedTargetIds ? { affectedTargetIds: [...revision.affectedTargetIds] } : {}),
      ...(revision.conflictIds ? { conflictIds: [...revision.conflictIds] } : {}),
      ...(revision.kind ? { kind: revision.kind } : {}),
    };
  }

  private authorityChangeSummary(snapshot: AuthorityPlaneSnapshot, changeId: string) {
    const change = snapshot.changes[changeId];
    if (!change) throw new AuthorityPlaneError({ code: "not_found", message: `Change ${changeId} is not available in this Realm.`, recoveryAction: "verify the Change identifier without probing undiscoverable resources", receipt: `change=${changeId}; operation=change.inspect; discoverable=false` });
    const project = snapshot.projects[change.projectId];
    if (!project) throw new AuthorityPlaneError({ code: "indeterminate", message: `Change ${changeId} refers to a Project that is not readable.`, recoveryAction: "reconcile the Authority snapshot before exposing the Change summary", receipt: `change=${changeId}; project=missing; operation=change.inspect` });
    const revisions = Object.values(snapshot.changeRevisions)
      .filter((revision) => revision.changeId === changeId)
      .sort((left, right) => left.sequence - right.sequence || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((revision) => this.authorityChangeRevisionSummary(revision));
    return {
      change: {
        protocol: change.protocol,
        id: change.id,
        projectId: change.projectId,
        intentId: change.intentId,
        baseProjectRevisionId: change.baseProjectRevisionId,
        status: change.status,
        latestRevisionId: change.latestRevisionId,
        ...(change.workspaceId ? { workspaceId: change.workspaceId } : {}),
        ...(change.revertsChangeRevisionId ? { revertsChangeRevisionId: change.revertsChangeRevisionId } : {}),
      },
      project: {
        protocol: project.protocol,
        id: project.id,
        name: project.name,
        referenceType: project.referenceType,
      },
      revisions,
    };
  }

  private authorityIntentSummary(snapshot: AuthorityPlaneSnapshot, intentId: string) {
    const intent = snapshot.intents[intentId];
    if (!intent) throw new AuthorityPlaneError({ code: "not_found", message: `Intent ${intentId} is not available in this Realm.`, recoveryAction: "verify the Intent identifier without probing undiscoverable resources", receipt: `intent=${intentId}; operation=intent.inspect; discoverable=false` });
    const project = snapshot.projects[intent.projectId];
    if (!project) throw new AuthorityPlaneError({ code: "indeterminate", message: `Intent ${intentId} refers to a Project that is not readable.`, recoveryAction: "reconcile the Authority snapshot before exposing the Intent summary", receipt: `intent=${intentId}; project=missing; operation=intent.inspect` });
    const comments = Object.values(snapshot.intentComments)
      .filter((comment) => comment.intentId === intentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return { intent, comments, project: { protocol: project.protocol, id: project.id, name: project.name, referenceType: project.referenceType } };
  }

  private async authorityProject(body: CoordinatorRequestBody): Promise<Response> {
    const projectId = coordinatorString(body, "projectId");
    const snapshot = await this.authoritySnapshot();
    const session = this.authorityCapabilitySession(coordinatorString(body, "sessionId"), "project.inspect", { realmId: this.requireIdentity().realm.id, projectId });
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", ...this.authorityProjectSummary(snapshot, projectId), session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=project.inspect; project=${projectId}; readOnly=true; credentialFree=true; canonicalWrite=false` });
  }

  private async authorityProjects(body: CoordinatorRequestBody): Promise<Response> {
    const session = this.authorityHumanSession(coordinatorString(body, "sessionId"));
    const snapshot = await this.authoritySnapshot();
    const projectIds = Object.keys(snapshot.projects).sort().filter((projectId) => this.requireIdentity().activeCapabilitiesForPrincipal({ principalId: session.principalId, resource: { realmId: this.requireIdentity().realm.id, projectId } }).includes("project.inspect"));
    const projects = projectIds.map((projectId) => this.authorityProjectSummary(snapshot, projectId));
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", projects, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=project.list; projectCount=${projects.length}; ordering=project-id-code-unit-ascending; readOnly=true; credentialFree=true; canonicalWrite=false` });
  }

  private async authorityWorkspaces(body: CoordinatorRequestBody): Promise<Response> {
    const session = this.authorityHumanSession(coordinatorString(body, "sessionId"));
    const projectId = body.projectId === undefined ? undefined : coordinatorString(body, "projectId");
    const workspaceId = body.workspaceId === undefined ? undefined : coordinatorString(body, "workspaceId");
    const snapshot = await this.authoritySnapshot();
    if (projectId !== undefined && !snapshot.projects[projectId]) throw new AuthorityPlaneError({ code: "not_found", message: `Project ${projectId} is not available in this Realm.`, recoveryAction: "verify the Project identifier without probing undiscoverable resources", receipt: `project=${projectId}; operation=workspace.list; discoverable=false` });
    if (workspaceId !== undefined) {
      const summary = this.authorityWorkspaceSummary(snapshot, workspaceId);
      this.authorityCapabilitySession(session.sessionId, "workspace.inspect", { realmId: this.requireIdentity().realm.id, projectId: summary.workspace.projectId, workspaceId });
      if (projectId !== undefined && summary.workspace.projectId !== projectId) throw new AuthorityPlaneError({ code: "not_found", message: `Workspace ${workspaceId} is not available for Project ${projectId}.`, recoveryAction: "verify the Workspace identifier within the requested Project without probing undiscoverable resources", receipt: `workspace=${workspaceId}; project=${projectId}; operation=workspace.inspect; discoverable=false` });
      return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", ...summary, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=workspace.inspect; workspace=${workspaceId}; readOnly=true; credentialFree=true; canonicalWrite=false` });
    }
    const workspaceIds = Object.keys(snapshot.workspaces).filter((id) => {
      const workspace = snapshot.workspaces[id];
      return workspace !== undefined && (projectId === undefined || workspace.projectId === projectId) && this.requireIdentity().activeCapabilitiesForPrincipal({ principalId: session.principalId, resource: { realmId: this.requireIdentity().realm.id, projectId: workspace.projectId, workspaceId: workspace.id } }).includes("workspace.inspect");
    }).sort();
    const workspaces = workspaceIds.map((id) => this.authorityWorkspaceSummary(snapshot, id));
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", workspaces, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=workspace.list; workspaceCount=${workspaces.length}; ordering=workspace-id-code-unit-ascending;${projectId ? ` project=${projectId};` : ""} readOnly=true; credentialFree=true; canonicalWrite=false` });
  }

  private async authorityChanges(body: CoordinatorRequestBody): Promise<Response> {
    const session = this.authorityHumanSession(coordinatorString(body, "sessionId"));
    const projectId = body.projectId === undefined ? undefined : coordinatorString(body, "projectId");
    const workspaceId = body.workspaceId === undefined ? undefined : coordinatorString(body, "workspaceId");
    const changeId = body.changeId === undefined ? undefined : coordinatorString(body, "changeId");
    const snapshot = await this.authoritySnapshot();
    if (projectId !== undefined && !snapshot.projects[projectId]) throw new AuthorityPlaneError({ code: "not_found", message: `Project ${projectId} is not available in this Realm.`, recoveryAction: "verify the Project identifier without probing undiscoverable resources", receipt: `project=${projectId}; operation=change.list; discoverable=false` });
    if (workspaceId !== undefined && !snapshot.workspaces[workspaceId]) throw new AuthorityPlaneError({ code: "not_found", message: `Workspace ${workspaceId} is not available in this Realm.`, recoveryAction: "verify the Workspace identifier without probing undiscoverable resources", receipt: `workspace=${workspaceId}; operation=change.list; discoverable=false` });
    if (changeId !== undefined) {
      const summary = this.authorityChangeSummary(snapshot, changeId);
      this.authorityCapabilitySession(session.sessionId, "change.inspect", { realmId: this.requireIdentity().realm.id, projectId: summary.change.projectId, ...(summary.change.workspaceId ? { workspaceId: summary.change.workspaceId } : {}), changeId });
      if (projectId !== undefined && summary.change.projectId !== projectId) throw new AuthorityPlaneError({ code: "not_found", message: `Change ${changeId} is not available for Project ${projectId}.`, recoveryAction: "verify the Change identifier within the requested Project without probing undiscoverable resources", receipt: `change=${changeId}; project=${projectId}; operation=change.inspect; discoverable=false` });
      if (workspaceId !== undefined && summary.change.workspaceId !== workspaceId) throw new AuthorityPlaneError({ code: "not_found", message: `Change ${changeId} is not available for Workspace ${workspaceId}.`, recoveryAction: "verify the Change identifier within the requested Workspace without probing undiscoverable resources", receipt: `change=${changeId}; workspace=${workspaceId}; operation=change.inspect; discoverable=false` });
      return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", ...summary, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=change.inspect; change=${changeId}; revisionCount=${summary.revisions.length}; readOnly=true; credentialFree=true; canonicalWrite=false` });
    }
    const changeIds = Object.keys(snapshot.changes)
      .filter((id) => {
        const change = snapshot.changes[id];
        return change !== undefined && (projectId === undefined || change.projectId === projectId) && (workspaceId === undefined || change.workspaceId === workspaceId) && this.requireIdentity().activeCapabilitiesForPrincipal({ principalId: session.principalId, resource: { realmId: this.requireIdentity().realm.id, projectId: change.projectId, ...(change.workspaceId ? { workspaceId: change.workspaceId } : {}), changeId: change.id } }).includes("change.inspect");
      })
      .sort();
    const changes = changeIds.map((id) => {
      const summary = this.authorityChangeSummary(snapshot, id);
      return { change: summary.change, project: summary.project, revisionCount: summary.revisions.length };
    });
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", changes, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=change.list; changeCount=${changes.length}; ordering=change-id-code-unit-ascending;${projectId ? ` project=${projectId};` : ""}${workspaceId ? ` workspace=${workspaceId};` : ""} readOnly=true; credentialFree=true; canonicalWrite=false` });
  }

  private async authorityIntents(body: CoordinatorRequestBody): Promise<Response> {
    const session = this.authorityHumanSession(coordinatorString(body, "sessionId"));
    const projectId = body.projectId === undefined ? undefined : coordinatorString(body, "projectId");
    const intentId = body.intentId === undefined ? undefined : coordinatorString(body, "intentId");
    const snapshot = await this.authoritySnapshot();
    if (projectId !== undefined && !snapshot.projects[projectId]) throw new AuthorityPlaneError({ code: "not_found", message: `Project ${projectId} is not available in this Realm.`, recoveryAction: "verify the Project identifier without probing undiscoverable resources", receipt: `project=${projectId}; operation=intent.list; discoverable=false` });
    if (intentId !== undefined) {
      const summary = this.authorityIntentSummary(snapshot, intentId);
      this.authorityCapabilitySession(session.sessionId, "intent.inspect", { realmId: this.requireIdentity().realm.id, projectId: summary.intent.projectId });
      if (projectId !== undefined && summary.intent.projectId !== projectId) throw new AuthorityPlaneError({ code: "not_found", message: `Intent ${intentId} is not available for Project ${projectId}.`, recoveryAction: "verify the Intent identifier within the requested Project", receipt: `intent=${intentId}; project=${projectId}; operation=intent.inspect; discoverable=false` });
      return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", ...summary, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=intent.inspect; intent=${intentId}; commentCount=${summary.comments.length}; readOnly=true; credentialFree=true; canonicalWrite=false` });
    }
    const intentIds = Object.keys(snapshot.intents).filter((id) => {
      const intent = snapshot.intents[id];
      return intent !== undefined && (projectId === undefined || intent.projectId === projectId) && this.requireIdentity().activeCapabilitiesForPrincipal({ principalId: session.principalId, resource: { realmId: this.requireIdentity().realm.id, projectId: intent.projectId } }).includes("intent.inspect");
    }).sort();
    const intents = intentIds.map((id) => {
      const summary = this.authorityIntentSummary(snapshot, id);
      return { intent: summary.intent, project: summary.project, commentCount: summary.comments.length };
    });
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", intents, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=intent.list; intentCount=${intents.length}; ordering=intent-id-code-unit-ascending;${projectId ? ` project=${projectId};` : ""} readOnly=true; credentialFree=true; canonicalWrite=false` });
  }

  private authorityPullRequestSummary(snapshot: AuthorityPlaneSnapshot, pullRequestId: string) {
    const pullRequest = snapshot.pullRequests[pullRequestId];
    if (!pullRequest) throw new AuthorityPlaneError({ code: "not_found", message: `Pull Request ${pullRequestId} is not available in this Realm.`, recoveryAction: "verify the Pull Request identifier without probing undiscoverable resources", receipt: `pullRequest=${pullRequestId}; operation=pullRequest.inspect; discoverable=false` });
    const project = snapshot.projects[pullRequest.projectId];
    const change = snapshot.changes[pullRequest.changeId];
    if (!project || !change || change.projectId !== pullRequest.projectId) throw new AuthorityPlaneError({ code: "indeterminate", message: `Pull Request ${pullRequestId} has incomplete Project or Change lineage.`, recoveryAction: "reconcile the Pull Request snapshot before exposing its compatibility projection", receipt: `pullRequest=${pullRequestId}; project=${pullRequest.projectId}; change=${pullRequest.changeId}; lineage=incomplete` });
    const revisions = pullRequest.revisionIds.map((revisionId) => snapshot.changeRevisions[revisionId]).filter((revision): revision is NonNullable<typeof revision> => revision !== undefined).map((revision) => ({ id: revision.id, sequence: revision.sequence, projectRevisionId: revision.projectRevisionId, kind: revision.kind }));
    return { pullRequest, change: { protocol: change.protocol, id: change.id, projectId: change.projectId, intentId: change.intentId, status: change.status, latestRevisionId: change.latestRevisionId }, project: { protocol: project.protocol, id: project.id, name: project.name, referenceType: project.referenceType }, revisions };
  }

  private async authorityPullRequests(body: CoordinatorRequestBody): Promise<Response> {
    const session = this.authorityHumanSession(coordinatorString(body, "sessionId"));
    const projectId = body.projectId === undefined ? undefined : coordinatorString(body, "projectId");
    const pullRequestId = body.pullRequestId === undefined ? undefined : coordinatorString(body, "pullRequestId");
    const snapshot = await this.authoritySnapshot();
    if (projectId !== undefined && !snapshot.projects[projectId]) throw new AuthorityPlaneError({ code: "not_found", message: `Project ${projectId} is not available in this Realm.`, recoveryAction: "verify the Project identifier without probing undiscoverable resources", receipt: `project=${projectId}; operation=pullRequest.list; discoverable=false` });
    if (pullRequestId !== undefined) {
      const summary = this.authorityPullRequestSummary(snapshot, pullRequestId);
      this.authorityCapabilitySession(session.sessionId, "project.inspect", { realmId: this.requireIdentity().realm.id, projectId: summary.pullRequest.projectId });
      if (projectId !== undefined && summary.pullRequest.projectId !== projectId) throw new AuthorityPlaneError({ code: "not_found", message: `Pull Request ${pullRequestId} is not available for Project ${projectId}.`, recoveryAction: "verify the Pull Request identifier within the requested Project", receipt: `pullRequest=${pullRequestId}; project=${projectId}; operation=pullRequest.inspect; discoverable=false` });
      return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", ...summary, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=pullRequest.inspect; pullRequest=${pullRequestId}; revisionCount=${summary.revisions.length}; readOnly=true; credentialFree=true; canonicalWrite=false` });
    }
    const pullRequestIds = Object.keys(snapshot.pullRequests).filter((id) => {
      const pullRequest = snapshot.pullRequests[id];
      return pullRequest !== undefined && (projectId === undefined || pullRequest.projectId === projectId) && this.requireIdentity().activeCapabilitiesForPrincipal({ principalId: session.principalId, resource: { realmId: this.requireIdentity().realm.id, projectId: pullRequest.projectId } }).includes("project.inspect");
    }).sort();
    const pullRequests = pullRequestIds.map((id) => {
      const summary = this.authorityPullRequestSummary(snapshot, id);
      return { pullRequest: summary.pullRequest, change: summary.change, project: summary.project, revisionCount: summary.revisions.length };
    });
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", pullRequests, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=pullRequest.list; pullRequestCount=${pullRequests.length}; ordering=pull-request-id-code-unit-ascending;${projectId ? ` project=${projectId};` : ""} readOnly=true; credentialFree=true; canonicalWrite=false` });
  }

  private async authorityRun(body: CoordinatorRequestBody): Promise<Response> {
    const runId = coordinatorString(body, "runId");
    const snapshot = await this.authoritySnapshot();
    const run = snapshot.runs[runId];
    if (!run) throw new AuthorityPlaneError({ code: "not_found", message: `Run ${runId} is not available in this Realm.`, recoveryAction: "verify the Run identifier without probing undiscoverable resources", receipt: `run=${runId}; operation=run.inspect; discoverable=false` });
    const projectId = snapshot.projectRevisions[run.projectRevisionId]?.projectId;
    if (!projectId) throw new AuthorityPlaneError({ code: "indeterminate", message: `Run ${runId} has incomplete Project lineage.`, recoveryAction: "reconcile the Run Project Revision before exposing its status", receipt: `run=${runId}; project=missing; operation=run.inspect` });
    const changeId = run.changeRevisionId ? snapshot.changeRevisions[run.changeRevisionId]?.changeId : undefined;
    const session = this.authorityCapabilitySession(coordinatorString(body, "sessionId"), "evidence.read", { realmId: this.requireIdentity().realm.id, projectId, ...(run.workspaceId ? { workspaceId: run.workspaceId } : {}), ...(changeId ? { changeId } : {}) });
    const safeRun = {
      protocol: run.protocol,
      id: run.id,
      actionId: run.actionId,
      projectRevisionId: run.projectRevisionId,
      projectViewId: run.projectViewId,
      runnerId: run.runnerId,
      status: run.status,
      ...(run.attemptId ? { attemptId: run.attemptId } : {}),
      ...(run.verifierId ? { verifierId: run.verifierId } : {}),
      ...(run.actionContractDigest ? { actionContractDigest: run.actionContractDigest } : {}),
      ...(run.verifierContractDigest ? { verifierContractDigest: run.verifierContractDigest } : {}),
      ...(run.changeRevisionId ? { changeRevisionId: run.changeRevisionId } : {}),
      ...(run.workspaceId ? { workspaceId: run.workspaceId } : {}),
      ...(run.outputDigest ? { outputDigest: run.outputDigest } : {}),
      ...(run.inputDigests ? { inputDigests: [...run.inputDigests] } : {}),
      ...(run.outputDigests ? { outputDigests: [...run.outputDigests] } : {}),
    };
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", run: safeRun, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=run.inspect; run=${run.id}; readOnly=true; completion=runner-only; credentialFree=true; canonicalWrite=false` });
  }

  private async authorityMirrors(body: CoordinatorRequestBody): Promise<Response> {
    const session = this.authorityHumanSession(coordinatorString(body, "sessionId"));
    const projectId = body.projectId === undefined ? undefined : coordinatorString(body, "projectId");
    const mirrorId = body.mirrorId === undefined ? undefined : coordinatorString(body, "mirrorId");
    const snapshot = await this.authoritySnapshot();
    if (projectId !== undefined && !snapshot.projects[projectId]) throw new AuthorityPlaneError({ code: "not_found", message: `Project ${projectId} is not available in this Realm.`, recoveryAction: "verify the Project identifier without probing undiscoverable resources", receipt: `project=${projectId}; operation=mirror.list; discoverable=false` });
    if (mirrorId !== undefined) {
      const mirror = snapshot.mirrors[mirrorId];
      if (!mirror || (projectId !== undefined && mirror.projectId !== projectId)) throw new AuthorityPlaneError({ code: "not_found", message: `Repository Mirror ${mirrorId} is not available for this Project.`, recoveryAction: "verify the Mirror identifier within the requested Project without probing undiscoverable resources", receipt: `mirror=${mirrorId}; project=${projectId ?? "not-supplied"}; operation=mirror.inspect; discoverable=false` });
      this.authorityCapabilitySession(session.sessionId, "project.inspect", { realmId: this.requireIdentity().realm.id, projectId: mirror.projectId });
      const operation = mirror.lastOperationId ? snapshot.mirrorOperations[mirror.lastOperationId] : undefined;
      const checkpoint = mirror.checkpointId ? snapshot.mirrorCheckpoints[mirror.checkpointId] : undefined;
      const proposals = Object.values(snapshot.externalProposals).filter((proposal) => proposal.mirrorId === mirror.id).map((proposal) => ({ ...proposal, observedHeadCommits: [...proposal.observedHeadCommits], changeRevisionIds: [...proposal.changeRevisionIds] }));
      const deliveries = Object.values(snapshot.mirrorDeliveries).filter((delivery) => delivery.mirrorId === mirror.id).map((delivery) => ({ ...delivery }));
      return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", mirror: { ...mirror, refMappings: mirror.refMappings.map((mapping) => ({ ...mapping })), canonicalRefs: mirror.canonicalRefs.map((ref) => ({ ...ref })), remoteRefs: mirror.remoteRefs.map((ref) => ({ ...ref })), pendingInboundChangeIds: [...mirror.pendingInboundChangeIds] }, ...(operation ? { operation } : {}), ...(checkpoint ? { checkpoint } : {}), proposals, deliveries, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=mirror.inspect; mirror=${mirror.id}; proposals=${proposals.length}; deliveries=${deliveries.length}; readOnly=true; credentialFree=true; canonicalWrite=false` });
    }
    const mirrors = Object.values(snapshot.mirrors).filter((mirror) => (projectId === undefined || mirror.projectId === projectId) && this.requireIdentity().activeCapabilitiesForPrincipal({ principalId: session.principalId, resource: { realmId: this.requireIdentity().realm.id, projectId: mirror.projectId } }).includes("project.inspect")).sort((left, right) => left.id.localeCompare(right.id)).map((mirror) => ({ id: mirror.id, projectId: mirror.projectId, sourceSpaceId: mirror.sourceSpaceId, provider: mirror.provider, remoteRepository: mirror.remoteRepository, disclosure: mirror.disclosure, state: mirror.state, canonicalProjectRevisionId: mirror.canonicalProjectRevisionId, remoteGeneration: mirror.remoteGeneration, pendingInboundChangeIds: [...mirror.pendingInboundChangeIds], ...(mirror.lastOperationId ? { lastOperationId: mirror.lastOperationId } : {}), ...(mirror.checkpointId ? { checkpointId: mirror.checkpointId } : {}) }));
    return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "ready", mirrors, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, receipt: `authority=coordinator; operation=mirror.list; mirrorCount=${mirrors.length}; readOnly=true; credentialFree=true; canonicalWrite=false` });
  }

  private async authorityPromotionExecute(body: CoordinatorRequestBody): Promise<Response> {
    await this.requireAuthorityActive();
    const promotionId = coordinatorString(body, "promotionId");
    const snapshot = await this.authoritySnapshot();
    const promotion = snapshot.promotions[promotionId];
    if (!promotion) throw new AuthorityPlaneError({ code: "not_found", message: `Promotion ${promotionId} is not available in this Realm.`, recoveryAction: "verify the Promotion identifier without probing undiscoverable resources", receipt: `promotion=${promotionId}; operation=promotion.execute; discoverable=false` });
    const target = snapshot.targets[promotion.targetId];
    if (!target) throw new AuthorityPlaneError({ code: "indeterminate", message: `Promotion ${promotionId} has no readable Target.`, recoveryAction: "reconcile the Target lineage before requesting provider execution", receipt: `promotion=${promotionId}; target=${promotion.targetId}; operation=promotion.execute; lineage=incomplete` });
    const session = this.authorityCapabilitySession(coordinatorString(body, "sessionId"), "target.promote", { realmId: this.requireIdentity().realm.id, projectId: promotion.projectId, targetId: target.id }, true);
    const executionIdempotencyKey = coordinatorString(body, "executionIdempotencyKey");
    const expectedVersion = body.expectedVersion === undefined ? undefined : typeof body.expectedVersion === "number" && Number.isSafeInteger(body.expectedVersion) && body.expectedVersion >= 0 ? body.expectedVersion : (() => { throw new AuthorityPlaneError({ code: "invalid_request", message: "expectedVersion must be a non-negative safe integer.", recoveryAction: "read the Authority version and retry with a safe expectedVersion", receipt: "expectedVersion=non-negative-safe-integer-required; promotionExecution=not-accepted" }); })();
    const executorBinding = this.env.ANYAM_PROMOTION_EXECUTOR;
    if (!executorBinding || typeof executorBinding.fetch !== "function") {
      throw new AuthorityPlaneError({ code: "blocked", message: "No trusted Promotion executor service is bound to this customer-operated Realm.", recoveryAction: "bind the qualified Target execution service before requesting provider Promotion execution", receipt: `promotion=${promotionId}; providerExecutor=not-bound; credentialFree=true; canonicalWrite=false` });
    }
    return await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.authoritySnapshot();
      const coordinator = new AuthorityPlaneCoordinator(current);
      const executor = {
        execute: async (context: Readonly<import("../../../src/cloudflare/promotion-execution.ts").PromotionExecutionContext>): Promise<PromotionExecutionResult> => {
          const handoffKeyId = this.env.ANYAM_PROMOTION_HANDOFF_KEY_ID?.trim();
          const handoffSecret = this.env.ANYAM_PROMOTION_HANDOFF_SECRET?.trim();
          if (!handoffKeyId || !handoffSecret) throw new Error("promotion-handoff-key-missing");
          const nonce = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + PROMOTION_HANDOFF_TTL_MS).toISOString();
          const handoff = await signPromotionHandoff({ context, nonce, expiresAt, secret: handoffSecret, keyId: handoffKeyId });
          const response = await executorBinding.fetch(new Request("https://anyam-promotion-executor/execute", {
            method: "POST",
            headers: { "content-type": "application/json", "x-anyam-promotion-protocol": PROMOTION_EXECUTION_PROTOCOL, "x-anyam-promotion-handoff": handoff, "x-anyam-promotion-key-id": handoffKeyId, "x-anyam-promotion-nonce": nonce, "x-anyam-promotion-expires-at": expiresAt },
            body: JSON.stringify(context),
          }));
          if (!response.ok) throw new Error(`promotion-executor-http-${response.status}`);
          const payload: unknown = await response.json().catch(() => undefined);
          if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("promotion-executor-result-not-object");
          return payload as PromotionExecutionResult;
        },
      };
      const result = await coordinator.executePromotion({ promotionId, executionIdempotencyKey, ...(expectedVersion === undefined ? {} : { expectedVersion }), executor, session });
      await this.ctx.storage.put(REALM_AUTHORITY_SNAPSHOT_KEY, coordinator.snapshot());
      return coordinatorJson({ ...result, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, credentialFree: true, canonicalWrite: false }, result.status === "succeeded" ? 200 : result.status === "blocked" ? 409 : 503);
    });
  }

  private async authorityPromotionReconcile(body: CoordinatorRequestBody): Promise<Response> {
    await this.requireAuthorityActive();
    const promotionId = coordinatorString(body, "promotionId");
    const snapshot = await this.authoritySnapshot();
    const promotion = snapshot.promotions[promotionId];
    if (!promotion) throw new AuthorityPlaneError({ code: "not_found", message: `Promotion ${promotionId} is not available in this Realm.`, recoveryAction: "verify the Promotion identifier without probing undiscoverable resources", receipt: `promotion=${promotionId}; operation=promotion.reconcile; discoverable=false` });
    const target = snapshot.targets[promotion.targetId];
    if (!target) throw new AuthorityPlaneError({ code: "indeterminate", message: `Promotion ${promotionId} has no readable Target.`, recoveryAction: "reconcile the Target lineage before reconciling provider execution", receipt: `promotion=${promotionId}; target=${promotion.targetId}; operation=promotion.reconcile; lineage=incomplete` });
    const session = this.authorityCapabilitySession(coordinatorString(body, "sessionId"), "target.promote", { realmId: this.requireIdentity().realm.id, projectId: promotion.projectId, targetId: target.id }, true);
    const reconciliationIdempotencyKey = coordinatorString(body, "reconciliationIdempotencyKey");
    const expectedVersion = body.expectedVersion === undefined ? undefined : typeof body.expectedVersion === "number" && Number.isSafeInteger(body.expectedVersion) && body.expectedVersion >= 0 ? body.expectedVersion : (() => { throw new AuthorityPlaneError({ code: "invalid_request", message: "expectedVersion must be a non-negative safe integer.", recoveryAction: "read the Authority version and retry with a safe expectedVersion", receipt: "expectedVersion=non-negative-safe-integer-required; promotionReconcile=not-accepted" }); })();
    const executorBinding = this.env.ANYAM_PROMOTION_EXECUTOR;
    if (!executorBinding || typeof executorBinding.fetch !== "function") {
      throw new AuthorityPlaneError({ code: "blocked", message: "No trusted Promotion executor service is bound to this customer-operated Realm.", recoveryAction: "bind the qualified Target execution service before reconciling provider Promotion execution", receipt: `promotion=${promotionId}; providerExecutor=not-bound; reconciliation=not-started; credentialFree=true; canonicalWrite=false` });
    }
    return await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.authoritySnapshot();
      const coordinator = new AuthorityPlaneCoordinator(current);
      const executor = {
        execute: async (context: Readonly<import("../../../src/cloudflare/promotion-execution.ts").PromotionExecutionContext>): Promise<PromotionExecutionResult> => {
          const handoffKeyId = this.env.ANYAM_PROMOTION_HANDOFF_KEY_ID?.trim();
          const handoffSecret = this.env.ANYAM_PROMOTION_HANDOFF_SECRET?.trim();
          if (!handoffKeyId || !handoffSecret) throw new Error("promotion-handoff-key-missing");
          const nonce = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + PROMOTION_HANDOFF_TTL_MS).toISOString();
          const handoff = await signPromotionHandoff({ context, nonce, expiresAt, secret: handoffSecret, keyId: handoffKeyId });
          const response = await executorBinding.fetch(new Request("https://anyam-promotion-executor/execute", {
            method: "POST",
            headers: { "content-type": "application/json", "x-anyam-promotion-protocol": PROMOTION_EXECUTION_PROTOCOL, "x-anyam-promotion-handoff": handoff, "x-anyam-promotion-key-id": handoffKeyId, "x-anyam-promotion-nonce": nonce, "x-anyam-promotion-expires-at": expiresAt },
            body: JSON.stringify(context),
          }));
          if (!response.ok) throw new Error(`promotion-executor-http-${response.status}`);
          const payload: unknown = await response.json().catch(() => undefined);
          if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("promotion-executor-result-not-object");
          return payload as PromotionExecutionResult;
        },
      };
      const result = await coordinator.reconcilePromotion({ promotionId, reconciliationIdempotencyKey, ...(expectedVersion === undefined ? {} : { expectedVersion }), executor, session } satisfies PromotionReconciliationRequest);
      await this.ctx.storage.put(REALM_AUTHORITY_SNAPSHOT_KEY, coordinator.snapshot());
      return coordinatorJson({ ...result, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, credentialFree: true, canonicalWrite: false }, result.status === "succeeded" ? 200 : result.status === "blocked" ? 409 : 503);
    });
  }

  private async authorityPromotionStatus(body: CoordinatorRequestBody): Promise<Response> {
    const promotionId = coordinatorString(body, "promotionId");
    const snapshot = await this.authoritySnapshot();
    const promotion = snapshot.promotions[promotionId];
    if (!promotion) throw new AuthorityPlaneError({ code: "not_found", message: `Promotion ${promotionId} is not available in this Realm.`, recoveryAction: "verify the Promotion identifier without probing undiscoverable resources", receipt: `promotion=${promotionId}; operation=promotion.status; discoverable=false` });
    const target = snapshot.targets[promotion.targetId];
    const release = snapshot.releases[promotion.releaseId];
    if (!target || !release) throw new AuthorityPlaneError({ code: "indeterminate", message: `Promotion ${promotionId} has incomplete Target or Release lineage.`, recoveryAction: "reconcile the Authority snapshot before exposing Promotion status", receipt: `promotion=${promotionId}; target=${promotion.targetId}; release=${promotion.releaseId}; operation=promotion.status; lineage=incomplete` });
    const session = this.authorityCapabilitySession(coordinatorString(body, "sessionId"), "target.read", { realmId: this.requireIdentity().realm.id, projectId: promotion.projectId, targetId: target.id });
    const safePromotion = {
      protocol: promotion.protocol,
      id: promotion.id,
      projectId: promotion.projectId,
      targetId: promotion.targetId,
      releaseId: promotion.releaseId,
      releaseDigest: promotion.releaseDigest,
      previousReleaseId: promotion.previousReleaseId,
      expectedCurrentReleaseId: promotion.expectedCurrentReleaseId,
      state: promotion.state,
      attempt: promotion.attempt,
      kind: promotion.kind,
      ...(promotion.previewId ? { previewId: promotion.previewId } : {}),
      ...(promotion.deploymentId ? { deploymentId: promotion.deploymentId } : {}),
      ...(promotion.providerOperationId ? { providerOperationId: promotion.providerOperationId } : {}),
      ...(promotion.rollbackDeploymentId ? { rollbackDeploymentId: promotion.rollbackDeploymentId } : {}),
      ...(promotion.rollbackProviderOperationId ? { rollbackProviderOperationId: promotion.rollbackProviderOperationId } : {}),
      ...(promotion.health ? { health: promotion.health } : {}),
      ...(promotion.rollbackHealth ? { rollbackHealth: promotion.rollbackHealth } : {}),
      ...(promotion.healthFailure ? { healthFailure: promotion.healthFailure } : {}),
      ...(promotion.recoveryAction ? { recoveryAction: promotion.recoveryAction } : {}),
      ...(promotion.executionIdempotencyKey ? { executionIdempotencyKey: promotion.executionIdempotencyKey } : {}),
      ...(promotion.reconciliationCheckpoint ? { reconciliationCheckpoint: promotion.reconciliationCheckpoint } : {}),
    };
    return coordinatorJson({
      protocol: AUTHORITY_PLANE_PROTOCOL,
      status: "ready",
      version: snapshot.version,
      promotion: safePromotion,
      target: { protocol: target.protocol, id: target.id, projectId: target.projectId, name: target.name, adapterId: target.adapterId, state: target.state, currentReleaseId: target.currentReleaseId ?? null, releaseHistory: [...(target.releaseHistory ?? [])], ...(target.lastPromotionId ? { lastPromotionId: target.lastPromotionId } : {}), ...(target.deploymentProfile ? { deploymentProfile: target.deploymentProfile } : {}) },
      release: { protocol: release.protocol, id: release.id, projectRevisionId: release.projectRevisionId, status: release.status },
      ...(promotion.reconciliationCheckpoint ? { checkpoint: promotion.reconciliationCheckpoint } : {}),
      session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch },
      receipt: `authority=coordinator; operation=promotion.status; promotion=${promotion.id}; state=${promotion.state}; readOnly=true; credentialFree=true; canonicalWrite=false`,
    });
  }

  private async authorityCommand(body: CoordinatorRequestBody): Promise<Response> {
    await this.requireAuthorityActive();
    const command = coordinatorString(body, "command") as AuthorityCommandName;
    const allowed: readonly AuthorityCommandName[] = ["project.create", "intent.create", "intent.assign", "intent.comment", "intent.close", "intent.reopen", "pullRequest.open", "pullRequest.update", "pullRequest.review", "pullRequest.close", "pullRequest.reopen", "pullRequest.block", "pullRequest.merge", "workspace.create", "change.create", "revision.publish", "run.request", "landing.apply", "release.create", "target.configure", "promotion.request", "mirror.configure", "mirror.sync", "mirror.reconcile"];
    if (!allowed.includes(command)) throw new AuthorityPlaneError({ code: "invalid_request", message: `Authority command ${command} is not supported by this vertical slice.`, recoveryAction: `use one of ${allowed.join(", ")} and retry; no authority transition was accepted`, receipt: `command=${command}; transition=not-applied` });
    const payload = body.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new AuthorityPlaneError({ code: "invalid_request", message: "Authority command payload must be a JSON object.", recoveryAction: "send the command-specific payload as an object; no authority transition was accepted", receipt: `command=${command}; payload=object-required; transition=not-applied` });
    const payloadRecord = payload as Record<string, unknown>;
    const resource: ResourceRef = {
      realmId: this.requireIdentity().realm.id,
      ...(typeof payloadRecord.projectId === "string" ? { projectId: payloadRecord.projectId } : {}),
      ...(typeof payloadRecord.workspaceId === "string" ? { workspaceId: payloadRecord.workspaceId } : {}),
      ...(typeof payloadRecord.changeId === "string" ? { changeId: payloadRecord.changeId } : {}),
      ...(typeof payloadRecord.pullRequestId === "string" ? { pullRequestId: payloadRecord.pullRequestId } : {}),
      ...(typeof payloadRecord.targetId === "string" ? { targetId: payloadRecord.targetId } : {}),
      ...(typeof payloadRecord.sourceSpaceId === "string" ? { sourceSpaceId: payloadRecord.sourceSpaceId } : {}),
    };
    const capability = capabilityForAuthorityCommand(command);
    const session = capability
      ? this.authorityCapabilitySession(coordinatorString(body, "sessionId"), capability, resource, command === "landing.apply" || command === "release.create" || command === "target.configure" || command === "promotion.request")
      : this.authorityOwnerSession(coordinatorString(body, "sessionId"));
    const envelope: AuthorityCommand = {
      protocol: body.protocol === undefined ? AUTHORITY_COMMAND_PROTOCOL : coordinatorString(body, "protocol") as typeof AUTHORITY_COMMAND_PROTOCOL,
      command,
      idempotencyKey: coordinatorString(body, "idempotencyKey"),
      ...(typeof body.expectedVersion === "number" ? { expectedVersion: body.expectedVersion } : {}),
      payload: payloadRecord,
    };
    return await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.authoritySnapshot();
      const coordinator = new AuthorityPlaneCoordinator(current);
      const result = coordinator.execute(envelope, session);
      await this.ctx.storage.put(REALM_AUTHORITY_SNAPSHOT_KEY, coordinator.snapshot());
      return coordinatorJson({ ...result, session: { principalId: session.principalId, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch }, credentialFree: true, canonicalWrite: "landing-only" }, result.status === "succeeded" ? 200 : result.status === "blocked" ? 409 : 503);
    });
  }

  /** Internal Runner-service enrollment sync. No public or MCP surface can
   * register a signing key; the bound Runner service must perform enrollment
   * and then mirror only the credential-free profile into Authority. */
  private async authorityRunnerProfile(body: CoordinatorRequestBody): Promise<Response> {
    await this.requireAuthorityActive();
    const profileValue = body.runnerProfile;
    if (profileValue === null || typeof profileValue !== "object" || Array.isArray(profileValue)) throw new AuthorityPlaneError({ code: "invalid_request", message: "runnerProfile must be an object.", recoveryAction: "send the credential-free enrolled Runner profile through the bound Runner service", receipt: "runnerProfile=object-required; enrollment=not-applied" });
    const profile = profileValue as import("../../../src/kernel/contracts.ts").RunnerProfile;
    if (profile.realmId !== this.requireIdentity().realm.id) throw new AuthorityPlaneError({ code: "invalid_request", message: "Runner profile Realm does not match this Authority Realm.", recoveryAction: "synchronize a Runner profile enrolled in this Realm", receipt: "runnerProfile=realm-mismatch; enrollment=not-applied" });
    return await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.authoritySnapshot();
      const coordinator = new AuthorityPlaneCoordinator(current);
      const identitySnapshot = this.requireIdentity().getRecoverySnapshot();
      coordinator.registerRunnerProfile(profile, { realmId: identitySnapshot.realm.id, principalId: `runner-service:${profile.id}`, actorId: profile.id, sessionId: `runner-service:${profile.id}`, clientId: "anyam-runner-coordinator", authorizationEpoch: identitySnapshot.realm.authorizationEpoch, kind: "runner" });
      await this.ctx.storage.put(REALM_AUTHORITY_SNAPSHOT_KEY, coordinator.snapshot());
      return coordinatorJson({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "succeeded", runner: { id: profile.id, profileDigest: profile.profileDigest, status: profile.status }, credentialFree: true, canonicalWrite: false, receipt: `runner=${profile.id}; enrollment=synchronized; profileDigest=${profile.profileDigest}; credentialMaterialStored=false; canonicalWrite=false` });
    });
  }

  /** Internal Runner-service completion route. The route constructs a
   * non-human session and delegates all proof, binding, replay, and atomic
   * state checks to AuthorityPlaneCoordinator.completeRunner(). */
  private async authorityRunnerComplete(body: CoordinatorRequestBody): Promise<Response> {
    await this.requireAuthorityActive();
    const completionValue = body.completion;
    if (completionValue === null || typeof completionValue !== "object" || Array.isArray(completionValue)) throw new AuthorityPlaneError({ code: "invalid_request", message: "completion must be an object.", recoveryAction: "send the exact credential-free Signed Runner completion envelope", receipt: "runnerCompletion=object-required; transition=not-applied" });
    const profileValue = (completionValue as Record<string, unknown>).runnerProfile;
    if (profileValue === null || typeof profileValue !== "object" || Array.isArray(profileValue)) throw new AuthorityPlaneError({ code: "invalid_request", message: "completion.runnerProfile must be an object.", recoveryAction: "synchronize the enrolled Runner profile before submitting completion", receipt: "runnerCompletion=runner-profile-missing; transition=not-applied" });
    const profile = profileValue as Record<string, unknown>;
    const runnerId = coordinatorString(profile, "id");
    const identitySnapshot = this.requireIdentity().getRecoverySnapshot();
    const session: AuthoritySession = { realmId: identitySnapshot.realm.id, principalId: `runner-service:${runnerId}`, actorId: runnerId, sessionId: `runner-service:${runnerId}`, clientId: "anyam-runner-coordinator", authorizationEpoch: identitySnapshot.realm.authorizationEpoch, kind: "runner" };
    const payload: Record<string, unknown> = { completion: completionValue };
    const command: AuthorityCommand = { protocol: body.protocol === undefined ? AUTHORITY_COMMAND_PROTOCOL : coordinatorString(body, "protocol") as typeof AUTHORITY_COMMAND_PROTOCOL, command: "runner.complete", idempotencyKey: coordinatorString(body, "idempotencyKey"), ...(typeof body.expectedVersion === "number" ? { expectedVersion: body.expectedVersion } : {}), payload };
    return await this.ctx.blockConcurrencyWhile(async () => {
      const coordinator = new AuthorityPlaneCoordinator(await this.authoritySnapshot());
      const result = await coordinator.completeRunner(command, session);
      await this.ctx.storage.put(REALM_AUTHORITY_SNAPSHOT_KEY, coordinator.snapshot());
      return coordinatorJson({ ...result, provenance: { runnerId, clientId: session.clientId, sessionId: session.sessionId, authorizationEpoch: session.authorizationEpoch }, credentialFree: true, canonicalWrite: false, receipt: `${result.receipt}; authority=runner-completion; runner=${runnerId}; canonicalWrite=false` }, result.status === "succeeded" ? 200 : result.status === "blocked" ? 409 : 503);
    });
  }

  private async observeHostedRepository(input: {
    readonly current: AuthorityPlaneSnapshot;
    readonly sourceSpaceId: string;
    readonly workspaceId: string;
    readonly projectViewId: string;
    readonly expectedCommitOid: string;
    readonly expectedBaseCommitOid: string;
  }): Promise<RepositoryObservation> {
    const sourceSpace = input.current.sourceSpaces[input.sourceSpaceId];
    const repositoryId = sourceSpace?.repositoryId;
    if (!sourceSpace || !repositoryId) throw new AuthorityPlaneError({ code: "blocked", message: "The hosted Source Space has no authoritative Repository identity.", recoveryAction: "bind the Source Space to a customer-owned RepositoryDriver identity before publishing a hosted Change Revision", receipt: "repositoryObservation=repository-identity-missing; transition=not-applied" });
    const binding = this.env.ANYAM_REPOSITORY_OBSERVER;
    if (!binding) throw new AuthorityPlaneError({ code: "blocked", message: "Hosted Change Revision publication is unavailable because the RepositoryDriver observer is not configured.", recoveryAction: "bind the qualified customer-owned RepositoryDriver observer service before publishing hosted revisions", receipt: "repositoryObservation=observer-unconfigured; transition=not-applied; credentialMaterialStored=false" });
    const request: RepositoryObservationRequest = {
      protocol: "anyam.repository-observation/v1",
      operation: "observe",
      repositoryId,
      sourceSpaceId: input.sourceSpaceId,
      workspaceId: input.workspaceId,
      projectViewId: input.projectViewId,
      expectedCommitOid: input.expectedCommitOid,
      expectedBaseCommitOid: input.expectedBaseCommitOid,
    };
    const response = await binding.fetch(new Request("https://anyam-repository-observer/observe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }));
    const value: unknown = await response.json().catch(() => undefined);
    const parsed = parseRepositoryObservationServiceResponse(value);
    if (!parsed.valid) throw new AuthorityPlaneError({ code: "indeterminate", message: "The RepositoryDriver observer returned an invalid response.", recoveryAction: "repair the customer-owned RepositoryDriver observer and retry the same idempotent revision publication", receipt: parsed.receipt });
    if (parsed.response.status !== "succeeded" || !parsed.response.observation) throw new AuthorityPlaneError({ code: parsed.response.status === "blocked" ? "blocked" : "indeterminate", message: "The RepositoryDriver observer did not verify the hosted Workspace.", recoveryAction: parsed.response.recoveryAction ?? "inspect the RepositoryDriver observer receipt and retry only the same immutable publication", receipt: parsed.response.receipt });
    const verified = await verifyRepositoryObservation({ observation: parsed.response.observation, repositoryId, sourceSpaceId: input.sourceSpaceId, workspaceId: input.workspaceId, projectViewId: input.projectViewId, expectedCommitOid: input.expectedCommitOid, expectedBaseCommitOid: input.expectedBaseCommitOid });
    if (!verified.valid) throw new AuthorityPlaneError({ code: "conflict", message: verified.message, recoveryAction: verified.recoveryAction, receipt: verified.receipt });
    return verified.observation;
  }

  private async authorityMcpCommand(body: CoordinatorRequestBody): Promise<Response> {
    await this.requireAuthorityActive();
    if (coordinatorString(body, "surface") !== "mcp") throw new AuthorityPlaneError({ code: "invalid_request", message: "The MCP Authority boundary requires surface=mcp.", recoveryAction: "send the mutation through the remote MCP handler; no transition was accepted", receipt: "authority=mcp; surface=mismatch; transition=not-applied" });
    const sessionId = coordinatorString(body, "sessionId");
    const taskId = coordinatorString(body, "taskId");
    const capabilityGrantId = coordinatorString(body, "capabilityGrantId");
    const agentId = coordinatorString(body, "agentId");
    const commandName = commandNameForMcp(body);
    const capability = coordinatorString(body, "capability") as Capability;
    const expectedCapability = capabilityForMcpCommand(commandName);
    if (!expectedCapability || capability !== expectedCapability) throw new AuthorityPlaneError({ code: "invalid_request", message: "The MCP command and capability do not match the declared mutation boundary.", recoveryAction: "use the documented Agent capability for this MCP command; no transition was accepted", receipt: `authority=mcp; command=${commandName}; capability=${capability}; expected=${expectedCapability ?? "unsupported"}; transition=not-applied` });
    const payload = body.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new AuthorityPlaneError({ code: "invalid_request", message: "Authority command payload must be a JSON object.", recoveryAction: "send the typed command payload as an object; no transition was accepted", receipt: "authority=mcp; payload=object-required; transition=not-applied" });
    const command: AuthorityCommand = { protocol: body.protocol === undefined ? AUTHORITY_COMMAND_PROTOCOL : coordinatorString(body, "protocol") as typeof AUTHORITY_COMMAND_PROTOCOL, command: commandName as AuthorityCommandName, idempotencyKey: coordinatorString(body, "idempotencyKey"), ...(typeof body.expectedVersion === "number" ? { expectedVersion: body.expectedVersion } : {}), payload: payload as Record<string, unknown> };
    const envelopeSourceSpaceIds = coordinatorStringArray(body, "sourceSpaceIds");
    const resourceValue = body.resource;
    if (resourceValue === null || typeof resourceValue !== "object" || Array.isArray(resourceValue)) throw new AuthorityPlaneError({ code: "invalid_request", message: "MCP mutation resource must be an object.", recoveryAction: "send the exact delegated Project, Workspace, Change, and Source Space resource; no transition was accepted", receipt: "authority=mcp; resource=object-required; transition=not-applied" });
    const resourceBody = resourceValue as Record<string, unknown>;
    const resource: ResourceRef = {
      realmId: this.requireIdentity().realm.id,
      ...(typeof resourceBody.organizationId === "string" ? { organizationId: resourceBody.organizationId } : {}),
      ...(typeof resourceBody.projectId === "string" ? { projectId: resourceBody.projectId } : {}),
      ...(typeof resourceBody.sourceSpaceId === "string" ? { sourceSpaceId: resourceBody.sourceSpaceId } : {}),
      ...(typeof resourceBody.workspaceId === "string" ? { workspaceId: resourceBody.workspaceId } : {}),
      ...(typeof resourceBody.changeId === "string" ? { changeId: resourceBody.changeId } : {}),
      ...(typeof resourceBody.pullRequestId === "string" ? { pullRequestId: resourceBody.pullRequestId } : {}),
      ...(typeof resourceBody.runId === "string" ? { runId: resourceBody.runId } : {}),
      ...(typeof resourceBody.releaseId === "string" ? { releaseId: resourceBody.releaseId } : {}),
      ...(typeof resourceBody.targetId === "string" ? { targetId: resourceBody.targetId } : {}),
    };
    const identity = this.requireIdentity();
    const session = identity.validateSession(sessionId);
    const identitySnapshot = identity.getRecoverySnapshot();
    const actor = identitySnapshot.actors[session.actorId];
    if (!actor || actor.kind !== "agent" || actor.agentId !== agentId) throw new RealmIdentityError({ code: "mcp.agent_identity_invalid", message: "The MCP mutation session is not the delegated Agent Actor named by the grant.", recoveryAction: "reauthorize the MCP client with the exact delegated Agent Session, Task, and Grant", receipt: "authority=mcp; agent-session=invalid; transition=not-applied" });
    const validation = identity.validateTaskGrant({ principalId: session.principalId, actorId: session.actorId, clientId: session.clientId, sessionId: session.id, taskId, grantId: capabilityGrantId, resource, sourceSpaceIds: envelopeSourceSpaceIds, action: capability, effects: Array.isArray(body.effects) ? body.effects.filter((value): value is string => typeof value === "string") : [] });
    if (!validation.valid) throw new RealmIdentityError({ code: validation.code, message: "The MCP Agent Task/Grant is not live for this mutation.", recoveryAction: validation.recoveryAction, receipt: `${validation.receipt}; authority=mcp; transition=not-applied` });
    const modelProvider = identitySnapshot.agents[agentId]?.modelProvider;
    const grant = identity.getGrant(capabilityGrantId);
    if (!grant) throw new RealmIdentityError({ code: "mcp.delivery_task_grant_invalid", message: "The MCP Agent Task/Grant disappeared during validation.", recoveryAction: "reauthorize the MCP client with a fresh delegated Agent Task and Capability Grant", receipt: "authority=mcp; grant=missing-after-validation; transition=not-applied" });
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.authoritySnapshot();
      let target = authorizeMcpCommandTarget({ snapshot: current, command, grantId: capabilityGrantId, grantResource: grant.resource, grantSourceSpaceIds: grant.sourceSpaceIds });
      if (!target.allowed) throw new AuthorityPlaneError({ code: target.code, message: target.message, recoveryAction: target.recoveryAction, receipt: target.receipt });
      if (commandName === "revision.publish") {
        const snapshotValue = target.command.payload.sourceSpaceSnapshots;
        if (snapshotValue === null || typeof snapshotValue !== "object" || Array.isArray(snapshotValue)) throw new AuthorityPlaneError({ code: "invalid_request", message: "Hosted revision publication requires a Source Space snapshot object.", recoveryAction: "publish one snapshot identifier for every Source Space disclosed by the Project View", receipt: "repositoryObservation=snapshot-object-required; transition=not-applied" });
        const sourceSnapshots: Record<string, string> = {};
        for (const [sourceSpaceId, snapshotValueForSource] of Object.entries(snapshotValue)) {
          if (typeof snapshotValueForSource !== "string" || snapshotValueForSource.trim().length === 0) throw new AuthorityPlaneError({ code: "invalid_request", message: "Hosted revision publication contains an invalid Source Space snapshot.", recoveryAction: "publish non-empty Git commit object IDs for every disclosed Source Space", receipt: "repositoryObservation=snapshot-invalid; transition=not-applied" });
          sourceSnapshots[sourceSpaceId] = snapshotValueForSource;
        }
        const workspaceId = target.resource.workspaceId;
        const changeId = target.resource.changeId;
        const projectViewId = typeof target.command.payload.projectViewId === "string" ? target.command.payload.projectViewId : undefined;
        const change = changeId ? current.changes[changeId] : undefined;
        const baseRevision = change ? current.projectRevisions[change.baseProjectRevisionId] : undefined;
        if (!workspaceId || !changeId || !projectViewId || !change || !baseRevision) throw new AuthorityPlaneError({ code: "conflict", message: "Hosted revision publication is missing its authoritative Workspace, Change, Project View, or base Project Revision.", recoveryAction: "publish through the exact delegated Workspace and Change context", receipt: "repositoryObservation=revision-context-incomplete; transition=not-applied" });
        const observations: Record<string, RepositoryObservation> = {};
        for (const sourceSpaceId of target.sourceSpaceIds) {
          const expectedCommitOid = sourceSnapshots[sourceSpaceId];
          const expectedBaseCommitOid = baseRevision.sourceSpaceSnapshots[sourceSpaceId];
          if (!expectedCommitOid || !expectedBaseCommitOid) throw new AuthorityPlaneError({ code: "conflict", message: "Hosted revision publication does not contain the complete Git base and candidate snapshot set.", recoveryAction: "refresh the Workspace from the exact Project View and publish every Source Space snapshot", receipt: "repositoryObservation=base-or-candidate-snapshot-missing; transition=not-applied" });
          observations[sourceSpaceId] = await this.observeHostedRepository({ current, sourceSpaceId, workspaceId, projectViewId, expectedCommitOid, expectedBaseCommitOid });
        }
        const verifiedSnapshots = Object.fromEntries(Object.entries(observations).map(([sourceSpaceId, observation]) => [sourceSpaceId, observation.commitOid]));
        const verifiedCommand: AuthorityCommand = { ...target.command, payload: { ...target.command.payload, sourceSpaceSnapshots: verifiedSnapshots, sourceSpaceObservations: observations } };
        const rebound = authorizeMcpCommandTarget({ snapshot: current, command: verifiedCommand, grantId: capabilityGrantId, grantResource: grant.resource, grantSourceSpaceIds: grant.sourceSpaceIds });
        if (!rebound.allowed) throw new AuthorityPlaneError({ code: rebound.code, message: rebound.message, recoveryAction: rebound.recoveryAction, receipt: rebound.receipt });
        target = rebound;
      }
      for (const sourceSpaceId of target.sourceSpaceIds) identity.authorize({ operation: commandNameForMcp(body), capability, principalId: session.principalId, actorId: session.actorId, clientId: session.clientId, sessionId: session.id, taskId, grantId: capabilityGrantId, resource: target.resource, sourceSpaceId, ...(modelProvider ? { modelProvider } : {}), ...(Array.isArray(body.effects) && typeof body.effects[0] === "string" ? { effect: body.effects[0] } : {}) });
      const coordinator = new AuthorityPlaneCoordinator(current);
      const delegatedBySessionId = typeof body.delegatedBySessionId === "string" && body.delegatedBySessionId.length > 0 ? body.delegatedBySessionId : undefined;
      const authoritySession: AuthoritySession = { realmId: session.realmId, principalId: session.principalId, actorId: session.actorId, sessionId: session.id, clientId: session.clientId, authorizationEpoch: validation.authorizationEpoch, taskId, capabilityGrantId, ...(delegatedBySessionId ? { delegatedBySessionId } : {}), ...(modelProvider ? { modelProvider } : {}) };
      const accepted = coordinator.execute(target.command, authoritySession);
      await this.ctx.storage.put(REALM_AUTHORITY_SNAPSHOT_KEY, coordinator.snapshot());
      return { accepted, targetReceipt: target.receipt };
    });
    const accepted = result.accepted;
    return coordinatorJson({ ...accepted, provenance: { principalId: session.principalId, actorId: session.actorId, clientId: session.clientId, sessionId: session.id, agentId, taskId, capabilityGrantId, authorizationEpoch: validation.authorizationEpoch }, credentialFree: true, canonicalWrite: false, receipt: `${accepted.receipt}; ${result.targetReceipt}; authority=mcp; taskGrant=validated; agent=${agentId}; task=${taskId}; grant=${capabilityGrantId}; canonicalWrite=false` }, accepted.status === "succeeded" ? 200 : accepted.status === "blocked" ? 409 : 503);
  }

  private providerInput(body: CoordinatorRequestBody, authorization: CustomerProviderOwnerAuthorization): {
    realmId: string;
    installationId: string;
    operationId: string;
    idempotencyKey: string;
    surface: CustomerProviderSurface;
    failureMode: CustomerProviderFailureMode;
    payloadDigest: string;
    resourceKey?: string;
    authorization: CustomerProviderOwnerAuthorization;
  } {
    const snapshot = this.requireIdentity().getRecoverySnapshot();
    const resourceKey = typeof body.resourceKey === "string" && body.resourceKey.trim().length > 0 ? body.resourceKey.trim() : undefined;
    return {
      realmId: snapshot.realm.id,
      installationId: this.env.ANYAM_INSTALLATION_ID?.trim() || "unconfigured",
      operationId: coordinatorString(body, "operationId"),
      idempotencyKey: coordinatorString(body, "idempotencyKey"),
      surface: providerSurface(body),
      failureMode: providerFailureMode(body),
      payloadDigest: coordinatorString(body, "payloadDigest"),
      ...(resourceKey ? { resourceKey } : {}),
      authorization,
    };
  }

  private async publicGatewayAuthorize(body: CoordinatorRequestBody): Promise<Response> {
    const sessionId = coordinatorString(body, "sessionId");
    const projectId = coordinatorString(body, "projectId");
    const operation = coordinatorString(body, "operation");
    const allowedOperations = ["state", "open", "suspend", "reopen", "cleanup", "ledger-export", "ledger-compact", "replay-archive-delete"] as const;
    if (!allowedOperations.includes(operation as typeof allowedOperations[number])) throw new RealmIdentityError({ code: "public_gateway.operation_denied", message: "The requested Public Gateway operation is not in the Realm moderation boundary.", recoveryAction: "request one of the documented Public Gateway moderation operations", receipt: `operation=${operation}; publicGateway=not-authorized` });
    const identity = this.requireIdentity();
    const session = identity.validateSession(sessionId);
    const identitySnapshot = identity.getRecoverySnapshot();
    const relationship = Object.values(identitySnapshot.relationships).find((candidate) => candidate.status === "active" && candidate.principalId === session.principalId && candidate.resource.realmId === identitySnapshot.realm.id && (candidate.resource.projectId === undefined || candidate.resource.projectId === projectId) && (candidate.role === "owner" || candidate.role === "moderator"));
    if (!relationship) throw new RealmIdentityError({ code: "public_gateway.moderation_denied", message: "The authenticated Realm session has no active owner or moderator relationship for this Public Gateway Project.", recoveryAction: "authenticate a Realm owner or grant the Principal the moderator relationship for this Project", receipt: `project=${projectId}; session=${session.id}; role=owner-or-moderator-required; publicGateway=not-authorized` });
    return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "authorized", projectId, operation, actor: { id: session.actorId, role: relationship.role }, realmId: identitySnapshot.realm.id, authorizationEpoch: identitySnapshot.realm.authorizationEpoch, receipt: `publicGateway=moderation-authorized; project=${projectId}; operation=${operation}; actor=${session.actorId}; role=${relationship.role}; authorizationEpoch=${identitySnapshot.realm.authorizationEpoch}; credentialMaterialStored=false` });
  }

  private async githubActionsBridgeAudience(body: CoordinatorRequestBody): Promise<Response> {
    const connectionId = coordinatorString(body, "connectionId");
    const connection = this.requireGitHubActionsBridge().snapshot().connections[connectionId];
    if (!connection) return coordinatorJson({ protocol: "anyam.github-actions-bridge/v1", status: "blocked", code: "connection_not_found", recoveryAction: "start a fresh owner-approved GitHub Actions Bridge connection", receipt: `connection=${connectionId}; audience=not-returned; credentialMaterialStored=false` }, 404);
    if (connection.status !== "pending" && connection.status !== "active") return coordinatorJson({ protocol: "anyam.github-actions-bridge/v1", status: "blocked", code: `connection_${connection.status}`, recoveryAction: "create a fresh Bridge connection after inspecting the owner-visible checkpoint", receipt: `connection=${connectionId}; status=${connection.status}; audience=not-returned; credentialMaterialStored=false` }, 409);
    return coordinatorJson({ protocol: "anyam.github-actions-bridge/v1", status: "succeeded", connectionId, audience: connection.audience, receipt: `connection=${connectionId}; audience=owner-configured; credentialMaterialStored=false` });
  }

  private async githubActionsBridgeCreateConnection(body: CoordinatorRequestBody): Promise<Response> {
    this.authorityOwnerSession(coordinatorString(body, "sessionId"));
    const input = bridgeConnectionInput(body.connection);
    if (input.realmId !== this.requireIdentity().getRecoverySnapshot().realm.id) throw new RealmIdentityError({ code: "github_bridge.realm_mismatch", message: "The Bridge connection Realm does not match this customer Realm.", recoveryAction: "create the connection through the customer Realm that owns the Project and Source Space", receipt: `connectionRealm=${input.realmId}; currentRealm=${this.requireIdentity().getRecoverySnapshot().realm.id}; transition=not-applied; credentialMaterialStored=false` });
    const authority = await this.authoritySnapshot();
    const project = authority.projects[input.projectId];
    if (!project || !project.sourceSpaceIds.includes(input.sourceSpaceId) || !authority.sourceSpaces[input.sourceSpaceId]) throw new RealmIdentityError({ code: "github_bridge.project_source_space_not_found", message: "The Bridge connection Project or Source Space is not available in this Realm.", recoveryAction: "create the Project and Source Space through the customer Authority before connecting GitHub Actions", receipt: `project=${input.projectId}; sourceSpace=${input.sourceSpaceId}; connection=not-created; discoverable=false; credentialMaterialStored=false` });
    const result = this.requireGitHubActionsBridge().createPendingConnection(input);
    await this.persistGitHubActionsBridge();
    return coordinatorJson(result, result.status === "succeeded" ? 200 : 422);
  }

  private async githubActionsBridgeRevokeConnection(body: CoordinatorRequestBody): Promise<Response> {
    this.authorityOwnerSession(coordinatorString(body, "sessionId"));
    const result = this.requireGitHubActionsBridge().revokeConnection(coordinatorString(body, "connectionId"), coordinatorString(body, "reason"));
    await this.persistGitHubActionsBridge();
    return coordinatorJson(result, result.status === "succeeded" ? 200 : 404);
  }

  private async githubActionsBridgeExchange(body: CoordinatorRequestBody): Promise<Response> {
    const result = await this.requireGitHubActionsBridge().exchangeVerified({ connectionId: coordinatorString(body, "connectionId"), operation: bridgeOperation(body), verification: bridgeVerification(body.verification) });
    await this.persistGitHubActionsBridge();
    return coordinatorJson(result, result.status === "succeeded" ? 200 : result.code === "connection_not_found" ? 404 : result.code === "operation_denied" ? 403 : 409);
  }

  private async githubActionsBridgePrepare(body: CoordinatorRequestBody): Promise<Response> {
    const sourcePackage = parseGitHubActionsBridgeSourcePackage(body.sourcePackage);
    const history = parseGitHubActionsBridgeHistory(body.history);
    const mode = parseGitHubActionsBridgeMode(body.mode);
    const operation: GitHubActionsBridgeOperation = mode === "proposal" ? "proposal" : "inbound";
    const authorized = this.requireGitHubActionsBridge().authorize(sourcePackage.capabilityId, operation);
    if (authorized.status === "failed") return coordinatorJson(authorized, 403);
    const prepared = await this.requireGitHubActionsBridgeImports().prepare({ capability: authorized.value, sourcePackage, history, mode });
    await this.persistGitHubActionsBridgeImports();
    return coordinatorJson(prepared, prepared.status === "succeeded" ? 200 : 422);
  }

  private async bridgeService(binding: Fetcher | undefined, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!binding) throw new RealmIdentityError({ code: "github_bridge.service_unconfigured", message: `Customer-owned GitHub Actions Bridge service ${path} is not configured.`, recoveryAction: "bind the qualified customer-owned Bridge service before accepting this operation", receipt: `service=${path}; configured=false; credentialMaterialStored=false` });
    const response = await binding.fetch(`https://anyam-github-actions-bridge${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new RealmIdentityError({ code: "github_bridge.service_rejected", message: `Customer-owned GitHub Actions Bridge service ${path} rejected the checkpoint.`, recoveryAction: "inspect the customer-owned service receipt and resume the same immutable checkpoint only when safe", receipt: `service=${path}; httpStatus=${response.status}; credentialMaterialStored=false` });
    return bridgeObject(value, `service.${path}`);
  }

  private async githubActionsBridgeOutboundBundle(body: CoordinatorRequestBody): Promise<Response> {
    const capabilityId = coordinatorString(body, "capabilityId");
    const run = parseGitHubActionsBridgeOutboundRun(body.run);
    const authorized = this.requireGitHubActionsBridge().authorize(capabilityId, "outbound");
    if (authorized.status === "failed") return coordinatorJson(authorized, 403);
    const service = await this.bridgeService(this.env.ANYAM_GITHUB_BRIDGE_OUTBOUND, "/bundle", { protocol: "anyam.github-actions-bridge-service/v1", operation: "signed-outbound-bundle", capability: authorized.value, run });
    const bundle = parseGitHubActionsBridgeOutboundBundle(service.bundle);
    const prepared = await this.requireGitHubActionsBridgeOutbound().prepare({ capability: authorized.value, bundle, run });
    await this.persistGitHubActionsBridgeOutbound();
    if (prepared.status !== "succeeded") return coordinatorJson(prepared, 409);
    return coordinatorJson({ protocol: "anyam.github-actions-bridge-outbound/v1", status: "succeeded", plan: prepared.value, bundle: encodeGitHubActionsBridgeOutboundBundle(bundle), run, receipt: `${prepared.receipt}; bundle=issued; credentialMaterialStored=false; canonicalWrite=false` });
  }

  private async githubActionsBridgeOutboundComplete(body: CoordinatorRequestBody): Promise<Response> {
    const bundle = parseGitHubActionsBridgeOutboundBundle(body.bundle);
    const plan = parseGitHubActionsBridgeOutboundPlan(body.plan);
    const run = parseGitHubActionsBridgeOutboundRun(body.run);
    const provider = parseGitHubActionsBridgeOutboundProvider(body.provider);
    const authorized = this.requireGitHubActionsBridge().authorize(bundle.capabilityId, "outbound");
    if (authorized.status === "failed") return coordinatorJson(authorized, 403);
    const result = await this.requireGitHubActionsBridgeOutbound().complete({ plan, capability: authorized.value, bundle, run, provider });
    await this.persistGitHubActionsBridgeOutbound();
    return coordinatorJson(result, result.status === "succeeded" ? 200 : result.status === "blocked" || result.status === "degraded" ? 409 : 422);
  }

  private async githubActionsBridgeActivate(body: CoordinatorRequestBody): Promise<Response> {
    const ownerSessionId = coordinatorString(body, "sessionId");
    const owner = this.authorityOwnerSession(ownerSessionId);
    const sourcePackage = parseGitHubActionsBridgeSourcePackage(body.sourcePackage);
    const history = parseGitHubActionsBridgeHistory(body.history);
    const plan = parseGitHubActionsBridgePlan(body.plan);
    const authorized = this.requireGitHubActionsBridge().authorize(sourcePackage.capabilityId, "inbound");
    if (authorized.status === "failed") return coordinatorJson(authorized, 403);
    const confirmation: GitHubActionsBridgeOwnerConfirmation = { status: "confirmed", principalId: owner.principalId, sessionId: owner.sessionId, receipt: `owner=verified; principal=${owner.principalId}; package=owner-confirmed; credentialMaterialStored=false` };
    const result = await this.requireGitHubActionsBridgeImports().activateInitialImport({
      plan,
      capability: authorized.value,
      sourcePackage,
      history,
      ownerConfirmation: confirmation,
      importer: { importQuarantined: async ({ sourcePackage: packageValue, checkpointId }) => bridgeImportReceipt(await this.bridgeService(this.env.ANYAM_GITHUB_BRIDGE_IMPORTER, "/import", { protocol: "anyam.github-actions-bridge-service/v1", operation: "quarantine", sourcePackage: encodeGitHubActionsBridgeSourcePackage(packageValue), checkpointId })) },
      cutover: { activateImportedRepository: async ({ sourcePackage: packageValue, imported, ownerConfirmation: ownerValue, checkpointId }) => {
        const value = await this.bridgeService(this.env.ANYAM_GITHUB_BRIDGE_CUTOVER, "/cutover", { protocol: "anyam.github-actions-bridge-service/v1", operation: "initialization-cutover", sourcePackage: encodeGitHubActionsBridgeSourcePackage(packageValue), imported, owner: { principalId: ownerValue.principalId, receipt: ownerValue.receipt }, checkpointId });
        return { status: "succeeded", projectRevisionId: bridgeServiceText(value.projectRevisionId, "projectRevisionId"), receipt: bridgeServiceText(value.receipt, "receipt") };
      } },
    });
    await this.persistGitHubActionsBridgeImports();
    return coordinatorJson(result, result.status === "succeeded" ? 200 : result.code === "owner_confirmation_required" ? 403 : 409);
  }

  private async githubActionsBridgeProposal(body: CoordinatorRequestBody): Promise<Response> {
    const sourcePackage = parseGitHubActionsBridgeSourcePackage(body.sourcePackage);
    const history = parseGitHubActionsBridgeHistory(body.history);
    const plan = parseGitHubActionsBridgePlan(body.plan);
    const authorized = this.requireGitHubActionsBridge().authorize(sourcePackage.capabilityId, "proposal");
    if (authorized.status === "failed") return coordinatorJson(authorized, 403);
    const result = await this.requireGitHubActionsBridgeImports().createProposal({
      plan,
      capability: authorized.value,
      sourcePackage,
      history,
      creator: { createProposal: async ({ sourcePackage: packageValue, history: historyValue, capability: capabilityValue, checkpointId }) => {
        const value = await this.bridgeService(this.env.ANYAM_GITHUB_BRIDGE_PROPOSAL, "/proposal", { protocol: "anyam.github-actions-bridge-service/v1", operation: "create-proposal", sourcePackage: encodeGitHubActionsBridgeSourcePackage(packageValue), history: historyValue, capability: capabilityValue, checkpointId });
        return { status: "succeeded", changeId: bridgeServiceText(value.changeId, "changeId"), checkpointId: bridgeServiceText(value.checkpointId, "checkpointId"), receipt: bridgeServiceText(value.receipt, "receipt") };
      } },
    });
    await this.persistGitHubActionsBridgeImports();
    return coordinatorJson(result, result.status === "succeeded" ? 200 : 409);
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/identity/status") {
        return coordinatorJson({
          protocol: REALM_COORDINATOR_PROTOCOL,
          status: "ready",
          identity: identitySummary(this.requireIdentity()),
          recoveryStatus: this.recoveryStatus,
          receipt: "authority=realm-coordinator; persistence=durable-object-storage; credentialFree=true",
        });
      }
      if (request.method !== "POST") return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, code: "method_not_allowed", recoveryAction: "use GET for identity status or POST for a bounded identity transition", receipt: "coordinator=method-not-allowed" }, 405);
      if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, code: "coordinator.internal_only", recoveryAction: "invoke the coordinator through the bound Realm Worker; direct mutation requests are not a public API", receipt: "coordinator=internal-binding-required; mutation=not-accepted" }, 403);
      const body = await coordinatorBody(request);
      const identity = this.requireIdentity();

      if (url.pathname === "/authority/state/internal") return await this.authorityState(coordinatorString(body, "sessionId"));
      if (url.pathname === "/authority/recovery/export/internal") return await this.authorityRecoveryExport(coordinatorString(body, "sessionId"));
      if (url.pathname === "/authority/recovery/restore/internal") return await this.authorityRecoveryRestore(body);
      if (url.pathname === "/authority/recovery/activate/internal") return await this.authorityRecoveryActivate(body);
      if (url.pathname === "/authority/project/internal") return await this.authorityProject(body);
      if (url.pathname === "/authority/projects/internal") return await this.authorityProjects(body);
      if (url.pathname === "/authority/workspaces/internal") return await this.authorityWorkspaces(body);
      if (url.pathname === "/authority/changes/internal") return await this.authorityChanges(body);
      if (url.pathname === "/authority/intents/internal") return await this.authorityIntents(body);
      if (url.pathname === "/authority/pull-requests/internal") return await this.authorityPullRequests(body);
      if (url.pathname === "/authority/runs/internal") return await this.authorityRun(body);
      if (url.pathname === "/authority/mirrors/internal") return await this.authorityMirrors(body);
      if (url.pathname === "/authority/promotion/execute/internal") return await this.authorityPromotionExecute(body);
      if (url.pathname === "/authority/promotion/reconcile/internal") return await this.authorityPromotionReconcile(body);
      if (url.pathname === "/github-actions-bridge/audience/internal") return await this.githubActionsBridgeAudience(body);
      if (url.pathname === "/github-actions-bridge/connection/create/internal") return await this.githubActionsBridgeCreateConnection(body);
      if (url.pathname === "/github-actions-bridge/connection/revoke/internal") return await this.githubActionsBridgeRevokeConnection(body);
      if (url.pathname === "/github-actions-bridge/exchange/internal") return await this.githubActionsBridgeExchange(body);
      if (url.pathname === "/github-actions-bridge/prepare/internal") return await this.githubActionsBridgePrepare(body);
      if (url.pathname === "/github-actions-bridge/outbound/bundle/internal") return await this.githubActionsBridgeOutboundBundle(body);
      if (url.pathname === "/github-actions-bridge/outbound/complete/internal") return await this.githubActionsBridgeOutboundComplete(body);
      if (url.pathname === "/github-actions-bridge/activate/internal") return await this.githubActionsBridgeActivate(body);
      if (url.pathname === "/github-actions-bridge/proposal/internal") return await this.githubActionsBridgeProposal(body);
      if (url.pathname === "/authority/promotion/status/internal") return await this.authorityPromotionStatus(body);
      if (url.pathname === "/authority/mcp-command/internal") return await this.authorityMcpCommand(body);
      if (url.pathname === "/authority/runner-profile/internal") return await this.authorityRunnerProfile(body);
      if (url.pathname === "/authority/runner-complete/internal") return await this.authorityRunnerComplete(body);
      if (url.pathname === "/public-gateway/authorize") return await this.publicGatewayAuthorize(body);
      if (url.pathname === "/authority/command/internal") return await this.authorityCommand(body);

      if (url.pathname === "/identity/passkey-challenge/issue") {
        return await this.ctx.blockConcurrencyWhile(async () => {
          const id = coordinatorString(body, "challengeId");
          const ceremony = coordinatorString(body, "ceremony");
          if (ceremony !== "registration" && ceremony !== "authentication") throw new RealmIdentityError({ code: "passkey.challenge_ceremony_invalid", message: "Passkey challenge ceremony must be registration or authentication.", recoveryAction: "issue a fresh challenge for one supported WebAuthn ceremony", receipt: `ceremony=${ceremony}; challenge=not-created` });
          const challenge = coordinatorString(body, "challenge");
          const realmId = coordinatorString(body, "realmId");
          if (realmId !== identity.realm.id) throw new RealmIdentityError({ code: "realm.id_mismatch", message: "The passkey challenge belongs to a different Realm.", recoveryAction: "issue the challenge through the coordinator bound to the current Realm", receipt: `configured=${identity.realm.id}; presented=${realmId}` });
          const expiresAt = coordinatorTimestamp(body, "expiresAt");
          const key = storageKey(REALM_PASSKEY_CHALLENGE_PREFIX, id);
          const existing = await this.ctx.storage.get<StoredPasskeyChallenge>(key);
          if (existing) throw new RealmIdentityError({ code: "passkey.challenge_exists", message: `Passkey challenge ${id} already exists; challenge identities are one-use.`, recoveryAction: "generate a new challenge identity and retry", receipt: `challenge=${id}; duplicate=true` });
          const createdAt = new Date().toISOString();
          const record: StoredPasskeyChallenge = {
            protocol: "anyam.realm-passkey-challenge/v1",
            id,
            ceremony,
            challenge,
            realmId,
            ...(typeof body.userId === "string" && body.userId.trim() ? { userId: body.userId.trim() } : {}),
            ...(typeof body.displayName === "string" && body.displayName.trim() ? { displayName: body.displayName.trim() } : {}),
            createdAt,
            expiresAt,
          };
          await this.ctx.storage.put(key, record);
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "challenge-issued", challengeId: id, ceremony, expiresAt, receipt: "challenge=durable-object; one-time-consumption=serialized; credentialMaterialStored=false" });
        });
      }

      if (url.pathname === "/identity/passkey-challenge/consume") {
        return await this.ctx.blockConcurrencyWhile(async () => {
          const id = coordinatorString(body, "challengeId");
          const ceremony = coordinatorString(body, "ceremony");
          const key = storageKey(REALM_PASSKEY_CHALLENGE_PREFIX, id);
          const record = await this.ctx.storage.get<StoredPasskeyChallenge>(key);
          if (!record || record.realmId !== identity.realm.id || record.ceremony !== ceremony || recordExpired(record.expiresAt)) {
            if (record) await this.ctx.storage.delete(key);
            throw new RealmIdentityError({ code: "passkey.challenge_expired", message: "The passkey challenge is missing, expired, or belongs to another ceremony.", recoveryAction: "start a fresh passkey ceremony; challenge consumption is one-use and serialized", receipt: `challenge=${id}; ceremony=${ceremony}; consumed=false` });
          }
          await this.ctx.storage.delete(key);
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "challenge-consumed", challenge: record, receipt: "challenge=consumed; one-time-consumption=serialized; replay=false" });
        });
      }

      if (url.pathname === "/identity/oauth-consent/create") {
        return await this.ctx.blockConcurrencyWhile(async () => {
          const id = coordinatorString(body, "consentId");
          const csrfToken = coordinatorString(body, "csrfToken");
          const realmId = coordinatorString(body, "realmId");
          const principalId = coordinatorString(body, "principalId");
          const sessionId = coordinatorString(body, "sessionId");
          const clientId = coordinatorString(body, "clientId");
          const clientName = coordinatorOptionalString(body, "clientName", clientId);
          const requestedScopes = coordinatorStringArray(body, "requestedScopes");
          const allowedScopes = coordinatorStringArray(body, "allowedScopes");
          const authRequest = coordinatorAuthRequest(body.authRequest);
          if (realmId !== identity.realm.id || authRequest.clientId !== clientId || authRequest.scope.length !== requestedScopes.length || !authRequest.scope.every((scope) => requestedScopes.includes(scope)) || !allowedScopes.every((scope) => requestedScopes.includes(scope))) throw new RealmIdentityError({ code: "oauth.consent_scope_mismatch", message: "The OAuth consent record does not match the parsed request and cannot be created.", recoveryAction: "restart authorization and let the coordinator receive the exact parsed request", receipt: "oauthConsent=scope-or-client-mismatch; grant=not-created" });
          const session = identity.validateSession(sessionId);
          if (session.principalId !== principalId) throw new RealmIdentityError({ code: "oauth.consent_session_mismatch", message: "The OAuth consent session does not belong to the authenticated Principal.", recoveryAction: "authenticate the Realm owner again and start a fresh authorization request", receipt: "oauthConsent=principal-session-mismatch; grant=not-created" });
          const expiresAt = coordinatorTimestamp(body, "expiresAt");
          const key = storageKey(REALM_OAUTH_CONSENT_PREFIX, id);
          if (await this.ctx.storage.get<StoredOAuthConsent>(key)) throw new RealmIdentityError({ code: "oauth.consent_exists", message: `OAuth consent record ${id} already exists; use a fresh authorization request.`, recoveryAction: "restart authorization to obtain a new CSRF-bound consent record", receipt: `consent=${id}; duplicate=true` });
          const record: StoredOAuthConsent = { protocol: "anyam.oauth-consent/v1", id, csrfToken, realmId, principalId, sessionId, clientId, clientName, requestedScopes, allowedScopes, authRequest, createdAt: new Date().toISOString(), expiresAt };
          await this.ctx.storage.put(key, record);
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "consent-created", consentId: id, clientId, clientName, requestedScopes, allowedScopes, expiresAt, receipt: "oauthConsent=durable-object; csrf=bound; one-time-consumption=serialized; grant=not-created" });
        });
      }

      if (url.pathname === "/identity/oauth-consent/consume") {
        return await this.ctx.blockConcurrencyWhile(async () => {
          const id = coordinatorString(body, "consentId");
          const csrfToken = coordinatorString(body, "csrfToken");
          const sessionId = coordinatorString(body, "sessionId");
          const session = identity.validateSession(sessionId);
          const key = storageKey(REALM_OAUTH_CONSENT_PREFIX, id);
          const record = await this.ctx.storage.get<StoredOAuthConsent>(key);
          if (!record || !oauthConsentBindingMatches(record, { realmId: identity.realm.id, principalId: session.principalId, sessionId, csrfToken }) || recordExpired(record.expiresAt)) {
            if (record && recordExpired(record.expiresAt)) await this.ctx.storage.delete(key);
            throw new RealmIdentityError({ code: "oauth.consent_invalid", message: "The OAuth consent is expired, replayed, or not bound to the current authenticated session.", recoveryAction: "restart authorization and approve it through the displayed consent page", receipt: `consent=${id}; csrf=session-binding=failed; grant=not-created` });
          }
          await this.ctx.storage.delete(key);
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "consent-consumed", consent: record, receipt: "oauthConsent=consumed; csrf=bound; replay=false" });
        });
      }

      if (url.pathname === "/identity/oauth-consent/inspect") {
        const id = coordinatorString(body, "consentId");
        const sessionId = coordinatorString(body, "sessionId");
        const session = identity.validateSession(sessionId);
        const key = storageKey(REALM_OAUTH_CONSENT_PREFIX, id);
        const record = await this.ctx.storage.get<StoredOAuthConsent>(key);
        if (!record || !oauthConsentBindingMatches(record, { realmId: identity.realm.id, principalId: session.principalId, sessionId }) || recordExpired(record.expiresAt)) {
          if (record && recordExpired(record.expiresAt)) await this.ctx.storage.delete(key);
          throw new RealmIdentityError({ code: "oauth.consent_invalid", message: "The OAuth consent is expired, missing, or not bound to the authenticated Principal and Session.", recoveryAction: "restart authorization and approve it through the displayed consent page", receipt: `consent=${id}; inspect=session-binding-failed; grant=not-created` });
        }
        return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "consent-inspected", consent: record, receipt: "oauthConsent=inspected; csrf=not-consumed; replay=false" });
      }

      if (url.pathname === "/identity/oauth-grant/record") {
        return await this.ctx.blockConcurrencyWhile(async () => {
          const sessionId = coordinatorString(body, "sessionId");
          const session = identity.validateSession(sessionId);
          const id = coordinatorString(body, "grantId");
          const providerGrantId = coordinatorString(body, "providerGrantId");
          const clientId = coordinatorString(body, "clientId");
          const scopes = coordinatorStringArray(body, "scopes");
          const key = storageKey(REALM_OAUTH_GRANT_PREFIX, id);
          const existing = await this.ctx.storage.get<StoredOAuthGrant>(key);
          const createdAt = new Date().toISOString();
          const deliveryOperations = MCP_DELIVERY_OPERATIONS.filter((operation) => scopes.includes(mcpDeliveryScope(operation)));
          const deliveryScopes = deliveryOperations.map((operation) => mcpDeliveryScope(operation)) as Capability[];
          const requestedResource = body.resource === undefined ? undefined : coordinatorString(body, "resource");
          const agentMutationScopes = ["workspace.write", "change.write", "run.invoke"];
          const agentMutationRequested = agentMutationScopes.some((scope) => scopes.includes(scope));
          const deliveryRequested = deliveryOperations.length > 0;
          if (agentMutationRequested && deliveryRequested) throw new RealmIdentityError({ code: "oauth.grant_scope_conflict", message: "An OAuth grant cannot combine delegated coding-agent mutations with human delivery mutations.", recoveryAction: "request either an Agent Task grant or an owner-created delivery grant, not both; no grant was recorded", receipt: "oauthGrant=agent-and-delivery-scope-conflict; taskGrant=not-created" });
          const binding = agentMutationRequested || deliveryRequested ? parseMcpDeliveryBinding(requestedResource, identity.realm.id) : undefined;
          if (agentMutationRequested && (!binding || !binding.agentId || !binding.agentSessionId || !binding.taskId || !binding.capabilityGrantId)) throw new RealmIdentityError({ code: "oauth.grant_agent_binding_required", message: "A delegated Agent mutation grant must name an owner-approved Agent Task, Session, Grant, Project, and Source Space resource.", recoveryAction: "authorize the MCP client with agentId, agentSessionId, taskId, capabilityGrantId, and Source Space disclosure in the project-scoped resource; no grant was recorded", receipt: "oauthGrant=agent-task-binding-required; taskGrant=not-created; canonicalWrite=false" });
          if (deliveryRequested && (!binding || binding.agentId || binding.agentSessionId || binding.taskId || binding.capabilityGrantId)) throw new RealmIdentityError({ code: "oauth.grant_delivery_binding_invalid", message: "A human delivery grant must use a project-scoped resource without delegated Agent identity fields.", recoveryAction: "authorize the delivery MCP resource without agentId, agentSessionId, taskId, or capabilityGrantId; no grant was recorded", receipt: "oauthGrant=owner-delivery-binding-invalid; taskGrant=not-created; canonicalWrite=false" });
          const authority = agentMutationRequested || deliveryRequested ? await this.authoritySnapshot() : undefined;
          let sourceSpaceIds: string[] = [];
          if (binding && authority) {
            const project = authority.projects[binding.projectId];
            if (!project) throw new RealmIdentityError({ code: "oauth.grant_delivery_resource_not_found", message: "The delivery MCP resource is not available in this Realm.", recoveryAction: "use a discoverable Project resource and restart OAuth authorization", receipt: "oauthGrant=delivery-project-not-found; discoverable=false; taskGrant=not-created" });
            sourceSpaceIds = binding.sourceSpaceIds.length > 0 ? [...binding.sourceSpaceIds] : [...project.sourceSpaceIds];
            if (sourceSpaceIds.length === 0 || sourceSpaceIds.some((sourceSpaceId) => !project.sourceSpaceIds.includes(sourceSpaceId))) throw new RealmIdentityError({ code: "oauth.grant_delivery_source_space_invalid", message: "The delivery MCP resource does not disclose a valid Project Source Space set.", recoveryAction: "authorize only Source Spaces that belong to the Project", receipt: "oauthGrant=source-space-disclosure-invalid; taskGrant=not-created; canonicalWrite=false" });
            const workspace = binding.workspaceId ? authority.workspaces[binding.workspaceId] : undefined;
            if (binding.workspaceId && (!workspace || workspace.projectId !== binding.projectId)) throw new RealmIdentityError({ code: "oauth.grant_delivery_resource_not_found", message: "The delivery MCP Workspace is not available for this Project.", recoveryAction: "use a discoverable Project Workspace resource and restart OAuth authorization", receipt: "oauthGrant=delivery-workspace-not-found; discoverable=false; taskGrant=not-created" });
            const change = binding.changeId ? authority.changes[binding.changeId] : undefined;
            if (binding.changeId && (!change || change.projectId !== binding.projectId || (binding.workspaceId !== undefined && change.workspaceId !== binding.workspaceId))) throw new RealmIdentityError({ code: "oauth.grant_delivery_resource_not_found", message: "The delivery MCP Change is not available for this Project and Workspace.", recoveryAction: "use a discoverable Project Change resource and restart OAuth authorization", receipt: "oauthGrant=delivery-change-not-found; discoverable=false; taskGrant=not-created" });
          }
          if (agentMutationRequested && binding) {
            const actor = identity.getRecoverySnapshot().actors[session.actorId];
            if (!actor || actor.kind !== "agent" || actor.agentId !== binding.agentId || session.id !== binding.agentSessionId) throw new RealmIdentityError({ code: "oauth.grant_agent_session_invalid", message: "The OAuth grant session is not the delegated Agent Session named by the resource.", recoveryAction: "reuse the exact delegated Agent Session and restart authorization", receipt: "oauthGrant=agent-session-mismatch; taskGrant=not-created" });
            if (!binding.taskId || !binding.capabilityGrantId) throw new RealmIdentityError({ code: "oauth.grant_agent_binding_incomplete", message: "The OAuth Agent delivery binding is missing its Task or Capability Grant.", recoveryAction: "restart delegation and authorize the exact Task/Grant resource", receipt: "oauthGrant=agent-binding-incomplete; taskGrant=not-created" });
            const capability: Capability = deliveryOperations[0] ? mcpDeliveryScope(deliveryOperations[0]) : scopes.includes("workspace.write") ? "workspace.write" : scopes.includes("change.write") ? "change.publish_revision" : "run.invoke";
            const validation = identity.validateTaskGrant({ principalId: session.principalId, actorId: session.actorId, clientId: session.clientId, sessionId: session.id, taskId: binding.taskId, grantId: binding.capabilityGrantId, resource: binding.resourceRef, sourceSpaceIds, action: capability });
            if (!validation.valid) throw new RealmIdentityError({ code: validation.code, message: "The delegated Agent Task/Grant is not live for this OAuth resource.", recoveryAction: validation.recoveryAction, receipt: validation.receipt });
          }
          if (deliveryRequested && binding) {
            const actor = identity.getRecoverySnapshot().actors[session.actorId];
            if (!actor || actor.kind !== "human") throw new RealmIdentityError({ code: "oauth.grant_delivery_owner_required", message: "Delivery OAuth grants must be created by an authenticated human Realm Session.", recoveryAction: "authenticate the human release owner and restart authorization", receipt: "oauthGrant=owner-delivery-session-required; taskGrant=not-created; canonicalWrite=false" });
          }
          const record: StoredOAuthGrant = { protocol: "anyam.oauth-grant/v1", id, providerGrantId, realmId: identity.realm.id, principalId: session.principalId, clientId, scopes, status: "active", createdAt, sessionId: session.id, actorId: session.actorId, authorizationEpoch: session.authorizationEpoch, expiresAt: session.expiresAt, ...(binding ? { mcpResource: binding.resource, resource: binding.resourceRef } : {}), sourceSpaceIds, deliveryActions: deliveryOperations, ...(agentMutationRequested && binding ? { taskId: binding.taskId, capabilityGrantId: binding.capabilityGrantId } : {}) };
          if (existing) {
            if (existing.providerGrantId !== providerGrantId || existing.principalId !== record.principalId || existing.clientId !== clientId || JSON.stringify(existing.scopes) !== JSON.stringify(scopes) || existing.mcpResource !== record.mcpResource || JSON.stringify(existing.sourceSpaceIds) !== JSON.stringify(record.sourceSpaceIds)) throw new RealmIdentityError({ code: "oauth.grant_conflict", message: `OAuth grant ${id} is already bound to different provider state.`, recoveryAction: "do not reuse a local grant identity; reconcile the provider grant before retrying", receipt: `grant=${id}; conflict=true; authority=unchanged` });
            return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "grant-recorded", grant: storedOAuthGrantProjection(existing), receipt: "oauthGrant=idempotent; revocable=true; credentialMaterialStored=false" });
          }
          if (binding && authority && deliveryRequested) {
            const created = await this.transitionIdentity(async (next) => {
              const ownerGrant = next.createOwnerTaskGrant({ sessionId: session.id, purpose: `Remote MCP delivery OAuth grant ${id}`, resource: binding.resourceRef, sourceSpaceIds, actions: deliveryScopes, effects: deliveryOperations.map((operation) => String(operation)), expiresAt: session.expiresAt });
              const boundRecord: StoredOAuthGrant = { ...record, taskId: ownerGrant.task.id, capabilityGrantId: ownerGrant.grant.id };
              await this.ctx.storage.put(key, boundRecord);
              return boundRecord;
            });
            return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "grant-recorded", grant: storedOAuthGrantProjection(created), receipt: "oauthGrant=persisted; taskGrant=owner-bound; resource=project-scoped; revocable=true; credentialMaterialStored=false; canonicalWrite=false" });
          }
          await this.ctx.storage.put(key, record);
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "grant-recorded", grant: storedOAuthGrantProjection(record), receipt: "oauthGrant=persisted; taskGrant=not-required; revocable=true; credentialMaterialStored=false" });
        });
      }

      if (url.pathname === "/identity/oauth-grant/validate-delivery") {
        const sessionId = coordinatorString(body, "sessionId");
        const session = identity.validateSession(sessionId);
        const id = coordinatorString(body, "grantId");
        const operation = coordinatorString(body, "operation");
        const scope = coordinatorString(body, "scope");
        const resource = coordinatorString(body, "resource");
        const record = await this.ctx.storage.get<StoredOAuthGrant>(storageKey(REALM_OAUTH_GRANT_PREFIX, id));
        if (!record || record.realmId !== identity.realm.id || record.principalId !== session.principalId || record.sessionId !== session.id || record.actorId !== session.actorId || record.status !== "active" || record.authorizationEpoch !== session.authorizationEpoch || record.authorizationEpoch !== identity.realm.authorizationEpoch || recordExpired(record.expiresAt) || !record.taskId || !record.capabilityGrantId || !record.resource || !record.mcpResource || record.mcpResource !== resource) throw new RealmIdentityError({ code: "oauth.delivery_grant_inactive", message: "The MCP delivery grant is not a live resource-bound Anyam Task/Grant for this Session.", recoveryAction: "reauthorize the MCP client with the current project-scoped MCP resource; no delivery transition was accepted", receipt: "oauthGrant=taskGrant-invalid-or-stale; credentialFree=true; canonicalWrite=false" });
        if (!isMcpDeliveryOperation(operation) || mcpDeliveryScope(operation) !== scope || !record.scopes.includes(scope) || !record.deliveryActions.includes(operation)) throw new RealmIdentityError({ code: "oauth.delivery_action_denied", message: "The MCP delivery grant does not authorize this operation-specific delivery action.", recoveryAction: "request the exact delivery scope for this MCP operation and retry", receipt: `oauthGrant=action-denied; operation=${operation}; credentialFree=true; canonicalWrite=false` });
        const binding = parseMcpDeliveryBinding(record.mcpResource, identity.realm.id);
        if (!binding || JSON.stringify(binding.resourceRef) !== JSON.stringify(record.resource)) throw new RealmIdentityError({ code: "oauth.delivery_resource_invalid", message: "The MCP delivery resource binding is malformed or stale.", recoveryAction: "reauthorize with a project-scoped MCP resource and retry", receipt: "oauthGrant=resource-binding-invalid; credentialFree=true; canonicalWrite=false" });
        const authority = await this.authoritySnapshot();
        validateMcpDeliveryLineage(authority, operation, binding, body.payload);
        const project = authority.projects[binding.projectId];
        if (!project || record.sourceSpaceIds.length === 0 || record.sourceSpaceIds.some((sourceSpaceId) => !project.sourceSpaceIds.includes(sourceSpaceId))) throw new RealmIdentityError({ code: "oauth.delivery_source_space_invalid", message: "The MCP delivery grant no longer discloses a current Project Source Space set.", recoveryAction: "reauthorize after reconciling the Project Source Space policy; no delivery transition was accepted", receipt: "oauthGrant=source-space-stale; credentialFree=true; canonicalWrite=false" });
        const validation = identity.validateTaskGrant({ principalId: session.principalId, actorId: session.actorId, clientId: session.clientId, sessionId: session.id, taskId: record.taskId, grantId: record.capabilityGrantId, resource: record.resource, sourceSpaceIds: record.sourceSpaceIds, action: mcpDeliveryScope(operation), effects: [operation] });
        if (!validation.valid) throw new RealmIdentityError({ code: validation.code, message: "The MCP delivery Task/Grant is not live for this operation.", recoveryAction: validation.recoveryAction, receipt: validation.receipt });
        return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "delivery-grant-valid", authorizationEpoch: validation.authorizationEpoch, sourceSpaceCount: validation.sourceSpaceCount, credentialFree: true, canonicalWrite: false, providerExecution: "not-performed", receipt: `${validation.receipt}; oauthGrant=resource-bound; operation=${operation}; scope=${scope}; providerExecution=not-performed` });
      }

      if (url.pathname === "/identity/oauth-grant/revoke") {
        const sessionId = coordinatorString(body, "sessionId");
        const session = identity.validateSession(sessionId);
        const id = coordinatorString(body, "grantId");
        const key = storageKey(REALM_OAUTH_GRANT_PREFIX, id);
        const record = await this.ctx.storage.get<StoredOAuthGrant>(key);
        if (!record || record.realmId !== identity.realm.id || record.principalId !== session.principalId) throw new RealmIdentityError({ code: "oauth.grant_not_found", message: "The requested OAuth grant is not owned by the authenticated Realm Principal.", recoveryAction: "list grants through the authenticated Realm session and revoke only one of those grants", receipt: `grant=${id}; owner=false; revocation=not-started` });
        if (record.status === "revoked") return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "grant-already-revoked", grant: record, receipt: "oauthGrant=already-revoked; providerRevocation=may-be-retried" });
        return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "grant-revocation-authorized", grant: record, receipt: "oauthGrant=owner-verified; providerRevocation=required" });
      }

      if (url.pathname === "/identity/oauth-grant/mark-revoked") {
        return await this.ctx.blockConcurrencyWhile(async () => {
          const sessionId = coordinatorString(body, "sessionId");
          const session = identity.validateSession(sessionId);
          const id = coordinatorString(body, "grantId");
          const key = storageKey(REALM_OAUTH_GRANT_PREFIX, id);
          const record = await this.ctx.storage.get<StoredOAuthGrant>(key);
          if (!record || record.principalId !== session.principalId) throw new RealmIdentityError({ code: "oauth.grant_not_found", message: "The OAuth grant cannot be marked revoked by this Principal.", recoveryAction: "re-read the authenticated grant list and retry the same grant identity", receipt: `grant=${id}; mark-revoked=denied` });
          if (record.status === "revoked") return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "grant-already-revoked", grant: storedOAuthGrantProjection(record), receipt: "oauthGrant=already-revoked; providerRevocation=confirmed; credentialMaterialStored=false" });
          const revoked: StoredOAuthGrant = { ...record, status: "revoked", revokedAt: new Date().toISOString() };
          await this.ctx.storage.put(key, revoked);
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "grant-revoked", grant: storedOAuthGrantProjection(revoked), receipt: "oauthGrant=revoked; providerRevocation=confirmed; credentialMaterialStored=false" });
        });
      }

      if (url.pathname === "/identity/oauth-grants/list") {
        const sessionId = coordinatorString(body, "sessionId");
        const session = identity.validateSession(sessionId);
        const entries = await this.ctx.storage.list<StoredOAuthGrant>({ prefix: REALM_OAUTH_GRANT_PREFIX });
        const grants = [...entries.values()].filter((grant) => grant.realmId === identity.realm.id && grant.principalId === session.principalId).map(storedOAuthGrantProjection);
        return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "grants-listed", grants, receipt: "oauthGrant=list; owner-session=validated; providerGrantTokens=not-returned" });
      }

      if (url.pathname === "/identity/owner-enroll") {
        const principalId = coordinatorString(body, "principalId");
        const displayName = coordinatorString(body, "displayName");
        const credentialId = coordinatorString(body, "credentialId");
        const relyingPartyId = coordinatorString(body, "relyingPartyId");
        const current = identity.getRecoverySnapshot();
        if (relyingPartyId !== current.realm.relyingPartyId) throw new RealmIdentityError({ code: "realm.rp_id_mismatch", message: "The passkey relying-party ID does not match this Realm's configured authentication origin.", recoveryAction: `use the configured Realm origin ${current.realm.relyingPartyId} or update the customer-owned Realm configuration before beginning a new ceremony`, receipt: `configured=${current.realm.relyingPartyId}; presented=${relyingPartyId}` });
        return await this.ctx.blockConcurrencyWhile(() => this.transitionIdentity((next) => {
          const latest = next.getRecoverySnapshot();
          const existingOwner = Object.values(latest.relationships).find((relationship) => relationship.status === "active" && relationship.role === "owner" && relationship.resource.realmId === latest.realm.id);
          if (existingOwner) {
            const existingOwnerPasskey = latest.passkeys[credentialId];
            if (existingOwnerPasskey?.principalId === existingOwner.principalId && existingOwnerPasskey.relyingPartyId === relyingPartyId) return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "owner-already-enrolled", realmId: latest.realm.id, principalId: existingOwner.principalId, credentialId, identity: identitySummary(next), receipt: "kernelMembership=verified; ownerEnrollment=idempotent; ownerUniqueness=serialized; credentialMaterialStored=false" });
            throw new RealmIdentityError({ code: "owner.exists", message: "This Realm already has an active owner; first-owner enrollment is unique.", recoveryAction: "authenticate the existing Realm owner or perform an explicit recovery/migration ceremony", receipt: `ownerPrincipal=${existingOwner.principalId}; ownerUniqueness=serialized; ownerEnrollment=not-applied` });
          }
          const existing = latest.passkeys[credentialId];
          if (existing) {
            if (existing.relyingPartyId !== relyingPartyId || existing.principalId !== principalId) throw new RealmIdentityError({ code: "passkey.exists", message: "The passkey is already bound to a different Realm principal or relying party.", recoveryAction: "use the original owner enrollment or begin a deliberate Realm migration", receipt: "passkey idempotency mismatch" });
            return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "owner-already-enrolled", realmId: latest.realm.id, principalId, credentialId, identity: identitySummary(next), receipt: "kernelMembership=verified; ownerEnrollment=idempotent; credentialMaterialStored=false" });
          }
          const principal = next.createPrincipal({ id: principalId, displayName });
          next.registerPasskey({ principalId: principal.id, credentialId, relyingPartyId });
          next.addRelationship({ principalId: principal.id, kind: "organization-member", subjectId: principal.id, role: "owner", resource: { realmId: latest.realm.id } });
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "owner-enrolled", realmId: latest.realm.id, principalId: principal.id, credentialId, identity: identitySummary(next), receipt: "kernelMembership=verified; ownerEnrollment=durable; ownerUniqueness=serialized; credentialMaterialStored=false" });
        }));
      }

      if (url.pathname === "/identity/passkey-auth") {
        const credentialId = coordinatorString(body, "credentialId");
        const relyingPartyId = coordinatorString(body, "relyingPartyId");
        const challenge = coordinatorString(body, "challenge");
        const signCount = body.signCount === undefined ? undefined : body.signCount;
        if (signCount !== undefined && (typeof signCount !== "number" || !Number.isSafeInteger(signCount) || signCount < 0)) throw new RealmIdentityError({ code: "auth.passkey_counter_invalid", message: "The verified passkey counter must be a non-negative integer.", recoveryAction: "complete a fresh WebAuthn authentication ceremony", receipt: "passkeyCounter=non-negative-safe-integer-required" });
        return await this.ctx.blockConcurrencyWhile(() => this.transitionIdentity((next) => {
          const session = next.authenticatePasskey({ credentialId, relyingPartyId, challenge, verified: true, ...(signCount === undefined ? {} : { signCount }), clientId: typeof body.clientId === "string" ? body.clientId : "client:anyam-web" });
          this.recoveryStatus = "active";
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "session-issued", session, identity: identitySummary(next), receipt: "kernelMembership=verified; session=durable; authentication=passkey; verification=worker-boundary; callerVerifiedFlag=ignored" });
        }));
      }

      if (url.pathname === "/identity/agent/delegation") {
        const humanSessionId = coordinatorString(body, "humanSessionId");
        const agentId = coordinatorString(body, "agentId");
        const agentName = coordinatorString(body, "agentName");
        const runtime = coordinatorString(body, "runtime");
        const modelProvider = coordinatorString(body, "modelProvider");
        const clientId = coordinatorOptionalString(body, "clientId", `client:agent:${agentId}`);
        const purpose = coordinatorString(body, "purpose");
        const actions = coordinatorCapabilityArray(body, "actions");
        const effects = delegationEffects(body);
        const allowedCredentialClasses = delegationCredentialClasses(body);
        const budget = delegationBudget(body);
        const expiresAt = coordinatorTimestamp(body, "expiresAt");
        return await this.ctx.blockConcurrencyWhile(async () => {
          const authority = await this.authoritySnapshot();
          const bounded = this.delegationAuthority(body, authority);
          return await this.transitionIdentity((next) => {
            const humanSession = next.validateSession(humanSessionId);
            const identityBefore = next.getRecoverySnapshot();
            const ownerRelationship = Object.values(identityBefore.relationships).some((relationship) => relationship.status === "active" && relationship.role === "owner" && relationship.principalId === humanSession.principalId && relationship.resource.realmId === identityBefore.realm.id);
            if (!ownerRelationship) throw new RealmIdentityError({ code: "delegation.owner_denied", message: "Generic agent delegation is restricted to an active Realm owner.", recoveryAction: "authenticate the Realm owner and retry the bounded Project delegation", receipt: "owner=required; delegation=not-created" });

            for (const sourceSpaceId of bounded.sourceSpaceIds) {
              const source = bounded.sources[sourceSpaceId]!;
              const existingPolicy = identityBefore.sourceSpacePolicies[sourceSpaceId];
              if (!existingPolicy) {
                next.setSourceSpacePolicy({ sourceSpaceId, classification: source.classification, allowedCapabilities: actions, readerPrincipalIds: source.classification === "public" ? [] : [humanSession.principalId], allowedModelProviders: source.classification === "public" ? [] : [modelProvider], discoverable: source.classification === "public" });
                continue;
              }
              if (existingPolicy.classification !== source.classification || (source.classification !== "public" && !existingPolicy.readerPrincipalIds.includes(humanSession.principalId)) || actions.some((action) => !existingPolicy.allowedCapabilities.includes(action)) || actions.some((action) => existingPolicy.deniedCapabilities.includes(action)) || (existingPolicy.allowedModelProviders.length > 0 && !existingPolicy.allowedModelProviders.includes(modelProvider))) throw new RealmIdentityError({ code: "delegation.source_space_denied", message: "The Source Space policy does not authorize this owner delegation, or its identity policy is stale.", recoveryAction: "update the Source Space policy through an explicit owner policy operation, then retry without widening the Task", receipt: `sourceSpace=${sourceSpaceId}; policy=not-satisfied; delegation=not-created` });
            }

            const current = next.getRecoverySnapshot();
            const existingAgent = current.agents[agentId];
            let agent = existingAgent;
            if (agent) {
              const sameAudience = agent.allowedCredentialClasses.length === allowedCredentialClasses.length && agent.allowedCredentialClasses.every((credentialClass) => allowedCredentialClasses.includes(credentialClass));
              if (agent.principalId !== humanSession.principalId || agent.status !== "active" || agent.name !== agentName || agent.runtime !== runtime || agent.modelProvider !== modelProvider || agent.clientId !== clientId || !sameAudience) throw new RealmIdentityError({ code: "delegation.agent_mismatch", message: "The enrolled agent identity does not match the requested owner, client, runtime, model provider, or credential audiences.", recoveryAction: "reuse the exact enrolled agent metadata or choose a new agent identity; provider credentials are never accepted here", receipt: `agent=${agentId}; metadata-match=false; credentials=not-issued` });
            } else {
              agent = next.registerAgent({ id: agentId, principalId: humanSession.principalId, name: agentName, runtime, modelProvider, clientId, allowedCredentialClasses });
            }

            const beforeDelegation = next.getRecoverySnapshot();
            const sameResource = (grant: typeof beforeDelegation.grants[string]): boolean => grant.resource.realmId === bounded.resource.realmId && grant.resource.projectId === bounded.resource.projectId && grant.resource.workspaceId === bounded.resource.workspaceId && grant.resource.changeId === bounded.resource.changeId && (grant.resource.sourceSpaceId ?? undefined) === (bounded.resource.sourceSpaceId ?? undefined);
            const sameList = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((value) => right.includes(value));
            const sameBudget = (left: Readonly<Record<string, string | number>>, right: Readonly<Record<string, string | number>>): boolean => JSON.stringify(left) === JSON.stringify(right);
            const grantIsLive = (grant: typeof beforeDelegation.grants[string]): boolean => grant.status === "active" && Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now();
            const activeChild = Object.values(beforeDelegation.grants).find((grant) => {
              if (!grantIsLive(grant) || grant.agentId !== agent!.id || !sameResource(grant) || !sameList(grant.sourceSpaceIds, bounded.sourceSpaceIds)) return false;
              const task = beforeDelegation.tasks[grant.taskId];
              return task?.status === "active" && task.agentId === agent!.id && task.purpose === purpose;
            });
            if (activeChild) {
              const matches = sameList(activeChild.actions, actions) && sameList(activeChild.effects, effects) && sameList(activeChild.allowedCredentialClasses, allowedCredentialClasses) && sameBudget(activeChild.budget, budget) && activeChild.expiresAt === expiresAt;
              if (!matches) throw new RealmIdentityError({ code: "delegation.idempotency_conflict", message: "An active delegation already exists for this owner, Agent, Project, Workspace, Change, and purpose with different authority.", recoveryAction: "reuse the existing delegation or revoke it explicitly before requesting a different capability set", receipt: `agent=${agent.id}; purpose=${purpose}; activeDelegation=conflict; transition=not-applied` });
              return coordinatorJson({ ...this.safeDelegation(next, { agentId: agent!.id, sessionId: activeChild.sessionId, taskId: activeChild.taskId, grantId: activeChild.id, status: "already-delegated" }), identity: identitySummary(next) });
            }

            const parentTask = Object.values(beforeDelegation.tasks).find((task) => task.status === "active" && !task.agentId && task.sessionId === humanSession.id && task.workspaceId === bounded.workspaceId && task.changeId === bounded.changeId && task.purpose === purpose);
            const task = parentTask ?? next.createTask({ principalId: humanSession.principalId, actorId: humanSession.actorId, sessionId: humanSession.id, purpose, workspaceId: bounded.workspaceId, changeId: bounded.changeId });
            const afterTask = next.getRecoverySnapshot();
            const parentGrant = Object.values(afterTask.grants).find((grant) => grantIsLive(grant) && grant.taskId === task.id && grant.sessionId === humanSession.id);
            const parentActions = [...new Set<Capability>(["agent.delegate", ...actions])];
            const usableParentGrant = parentGrant ?? next.createCapabilityGrant({ principalId: humanSession.principalId, actorId: humanSession.actorId, clientId: humanSession.clientId, sessionId: humanSession.id, taskId: task.id, resource: bounded.resource, sourceSpaceIds: bounded.sourceSpaceIds, actions: parentActions, effects, allowedModelProviders: [modelProvider], allowedCredentialClasses, budget, expiresAt });
            const delegated = next.delegateAgent({ humanSessionId: humanSession.id, parentGrantId: usableParentGrant.id, agentId: agent!.id, purpose, resource: bounded.resource, sourceSpaceIds: bounded.sourceSpaceIds, actions, effects, allowedCredentialClasses, budget, expiresAt, workspaceId: bounded.workspaceId, changeId: bounded.changeId, consentAt: new Date().toISOString() });
            return coordinatorJson({ ...this.safeDelegation(next, { agentId: agent!.id, sessionId: delegated.session.id, taskId: delegated.task.id, grantId: delegated.grant.id, status: "delegated" }), identity: identitySummary(next) });
          });
        });
      }

      if (url.pathname === "/identity/agent/delegation/credentials") {
        const humanSessionId = coordinatorString(body, "humanSessionId");
        const agentId = coordinatorString(body, "agentId");
        const agentSessionId = coordinatorString(body, "agentSessionId");
        const taskId = coordinatorString(body, "taskId");
        const grantId = coordinatorString(body, "grantId");
        rejectCredentialMaterial(body);
        const classes = credentialExchangeClasses(body);
        return await this.ctx.blockConcurrencyWhile(async () => {
          const authority = await this.authoritySnapshot();
          const bounded = this.delegationAuthority(body, authority);
          return await this.transitionIdentity((next) => {
            const humanSession = next.validateSession(humanSessionId);
            const identityState = next.getRecoverySnapshot();
            const ownerRelationship = Object.values(identityState.relationships).some((relationship) => relationship.status === "active" && relationship.role === "owner" && relationship.principalId === humanSession.principalId && relationship.resource.realmId === identityState.realm.id);
            const agent = identityState.agents[agentId];
            const agentSession = next.validateSession(agentSessionId);
            const state = next.getRecoverySnapshot();
            const task = state.tasks[taskId];
            const grant = state.grants[grantId];
            const parentGrant = grant?.parentGrantId ? state.grants[grant.parentGrantId] : undefined;
            const parentTask = parentGrant ? state.tasks[parentGrant.taskId] : undefined;
            const sameList = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((value) => right.includes(value));
            const sameResource = (left: Record<string, unknown>, right: Record<string, unknown>): boolean => ["realmId", "organizationId", "projectId", "sourceSpaceId", "workspaceId", "changeId", "runId", "releaseId", "targetId"].every((key) => (left[key] ?? undefined) === (right[key] ?? undefined));
            const grantResource = grant ? grant.resource as Record<string, unknown> : {};
            const exactResource = sameResource(grantResource, bounded.resource as Record<string, unknown>);
            const exactChain = ownerRelationship
              && agent !== undefined
              && agent.principalId === humanSession.principalId
              && agent.status === "active"
              && agentSession.actorKind === "agent"
              && agentSession.agentId === agentId
              && agentSession.principalId === humanSession.principalId
              && agentSession.clientId === agent.clientId
              && agentSession.delegatedByActorId === humanSession.actorId
              && agentSession.delegatedBySessionId === humanSession.id
              && task !== undefined
              && task.status === "active"
              && task.principalId === humanSession.principalId
              && task.actorId === agentSession.actorId
              && task.sessionId === agentSession.id
              && task.agentId === agentId
              && task.workspaceId === bounded.workspaceId
              && task.changeId === bounded.changeId
              && grant !== undefined
              && grant.status === "active"
              && grant.principalId === humanSession.principalId
              && grant.actorId === agentSession.actorId
              && grant.clientId === agent.clientId
              && grant.sessionId === agentSession.id
              && grant.taskId === task.id
              && grant.agentId === agentId
              && sameList(grant.sourceSpaceIds, bounded.sourceSpaceIds)
              && exactResource
              && parentGrant !== undefined
              && parentGrant.status === "active"
              && parentGrant.principalId === humanSession.principalId
              && parentGrant.actorId === humanSession.actorId
              && parentGrant.clientId === humanSession.clientId
              && parentGrant.sessionId === humanSession.id
              && parentTask !== undefined
              && parentTask.status === "active"
              && parentTask.principalId === humanSession.principalId
              && parentTask.actorId === humanSession.actorId
              && parentTask.sessionId === humanSession.id;
            if (!exactChain) throw new RealmIdentityError({ code: "credential_exchange.chain_invalid", message: "Credential exchange requires the exact active owner-to-Agent Session, Task, Grant, Project, Workspace, Change, and Source Space chain returned by delegation.", recoveryAction: "reuse the exact delegation identifiers and resource without changing the audience or scope; no credential was issued", receipt: "credentialExchange=delegated-chain-required; transition=not-applied; credentialMaterialStored=false" });
            const approvedByAgent = classes.every((credentialClass) => agent.allowedCredentialClasses.includes(credentialClass));
            const approvedByGrant = classes.every((credentialClass) => grant.allowedCredentialClasses.includes(credentialClass));
            if (!approvedByAgent || !approvedByGrant) throw new RealmIdentityError({ code: "credential_exchange.audience_denied", message: "The requested credential audience is not approved by both the enrolled Agent and its delegated Grant.", recoveryAction: "request only the exact credential classes returned by delegation; provider, runner, deployment, and promotion audiences are separate authority", receipt: `agentAudience=${approvedByAgent}; grantAudience=${approvedByGrant}; credentialExchange=not-created; credentialMaterialStored=false` });
            const credentials = classes.map((credentialClass) => next.issueCredential({ class: credentialClass, principalId: humanSession.principalId, actorId: agentSession.actorId, clientId: agentSession.clientId, sessionId: agentSession.id, taskId: task.id, grantId: grant.id, resource: bounded.resource }));
            return coordinatorJson({
              protocol: REALM_COORDINATOR_PROTOCOL,
              status: "credentials-issued",
              agentId,
              agentSessionId,
              taskId,
              grantId,
              resource: { ...bounded.resource, sourceSpaceIds: [...bounded.sourceSpaceIds] },
              credentialClasses: classes,
              credentials: credentials.map((credential) => ({ id: credential.id, class: credential.class, audience: credential.audience, token: credential.token, expiresAt: credential.expiresAt })),
              identity: identitySummary(next),
              receipt: `kernelMembership=verified; credentialExchange=delegated-agent; classes=${classes.join(",")}; project=${bounded.projectId}; workspace=${bounded.workspaceId}; change=${bounded.changeId}; tokenMaterial=returned-explicitly; credentialMaterialStored=false; canonicalWrite=false`,
            });
          });
        });
      }

      if (url.pathname === "/identity/agent/delegation/revoke") {
        const humanSessionId = coordinatorString(body, "humanSessionId");
        const agentId = coordinatorString(body, "agentId");
        return await this.ctx.blockConcurrencyWhile(() => this.transitionIdentity((next) => {
          const humanSession = next.validateSession(humanSessionId);
          const state = next.getRecoverySnapshot();
          const ownerRelationship = Object.values(state.relationships).some((relationship) => relationship.status === "active" && relationship.role === "owner" && relationship.principalId === humanSession.principalId && relationship.resource.realmId === state.realm.id);
          const agent = state.agents[agentId];
          if (!ownerRelationship || !agent || agent.principalId !== humanSession.principalId) throw new RealmIdentityError({ code: "delegation.agent_denied", message: "The requested Agent is not owned by the authenticated Realm owner.", recoveryAction: "revoke only an Agent enrolled by this Realm owner", receipt: "agent=owner-bound; revocation=not-started" });
          if (agent.status === "revoked") return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "already-revoked", agentId, canonicalWrite: false, credentialMaterialStored: false, receipt: `agent=${agentId}; status=already-revoked; humanSession=${humanSession.id}; humanSessionUntouched=true; credentialMaterialStored=false` });
          const result = next.revokeAgent(agentId);
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "delegation-revoked", agentId, revokedSessionCount: result.revokedSessionIds.length, revokedGrantCount: result.revokedGrantIds.length, revokedCredentialCount: result.revokedCredentialIds.length, canonicalWrite: false, credentialMaterialStored: false, receipt: `${result.receipt}; humanSession=${humanSession.id}; humanSessionUntouched=true; credentialMaterialStored=false` });
        }));
      }

      if (url.pathname === "/identity/qualification/delegate") {
        const humanSessionId = coordinatorString(body, "humanSessionId");
        const agentName = coordinatorOptionalString(body, "agentName", "Anyam qualification agent");
        const runtime = coordinatorOptionalString(body, "runtime", "qualification-runtime");
        const modelProvider = coordinatorOptionalString(body, "modelProvider", "qualification-model");
        return await this.transitionIdentity((next) => {
          const humanSession = next.validateSession(humanSessionId);
          const current = next.getRecoverySnapshot();
          const resource = {
            realmId: current.realm.id,
            projectId: REALM_QUALIFICATION_PROJECT_ID,
            sourceSpaceId: REALM_QUALIFICATION_SOURCE_SPACE_ID,
            workspaceId: REALM_QUALIFICATION_WORKSPACE_ID,
            changeId: REALM_QUALIFICATION_CHANGE_ID,
          };
          const existingPolicy = current.sourceSpacePolicies[REALM_QUALIFICATION_SOURCE_SPACE_ID];
          if (existingPolicy && !existingPolicy.readerPrincipalIds.includes(humanSession.principalId)) throw new RealmIdentityError({ code: "qualification.source_space_denied", message: "The qualification Source Space is already owned by another Realm Principal.", recoveryAction: "use a fresh disposable Realm or explicitly reset the qualification state before retrying", receipt: "qualification-source-space=principal-bound" });
          if (!existingPolicy) next.setSourceSpacePolicy({ sourceSpaceId: REALM_QUALIFICATION_SOURCE_SPACE_ID, classification: "restricted", allowedCapabilities: [...REALM_QUALIFICATION_ACTIONS], readerPrincipalIds: [humanSession.principalId], allowedModelProviders: [modelProvider] });

          const afterPolicy = next.getRecoverySnapshot();
          const existingAgent = afterPolicy.agents[REALM_QUALIFICATION_AGENT_ID];
          const agent = existingAgent ?? next.registerAgent({ id: REALM_QUALIFICATION_AGENT_ID, principalId: humanSession.principalId, name: agentName, runtime, modelProvider, clientId: REALM_QUALIFICATION_AGENT_CLIENT_ID, allowedCredentialClasses: REALM_QUALIFICATION_CREDENTIAL_CLASSES });
          if (agent.principalId !== humanSession.principalId || agent.modelProvider !== modelProvider || agent.clientId !== REALM_QUALIFICATION_AGENT_CLIENT_ID) throw new RealmIdentityError({ code: "qualification.agent_mismatch", message: "The disposable qualification agent is already bound to different identity or runtime metadata.", recoveryAction: "use the original qualification agent metadata or reset the disposable Realm", receipt: `agent=${agent.id}; principal=${agent.principalId === humanSession.principalId}; model=${agent.modelProvider === modelProvider}` });

          const beforeDelegation = next.getRecoverySnapshot();
          const activeChildGrant = Object.values(beforeDelegation.grants).find((grant) => grant.status === "active" && grant.agentId === agent.id && grant.resource.workspaceId === REALM_QUALIFICATION_WORKSPACE_ID && grant.resource.changeId === REALM_QUALIFICATION_CHANGE_ID);
          let childSessionId: string;
          let childTaskId: string;
          let childGrantId: string;
          let delegationStatus: "delegated" | "already-delegated" = "delegated";
          if (activeChildGrant) {
            childSessionId = activeChildGrant.sessionId;
            childTaskId = activeChildGrant.taskId;
            childGrantId = activeChildGrant.id;
            delegationStatus = "already-delegated";
          } else {
            const parentTask = Object.values(beforeDelegation.tasks).find((task) => task.status === "active" && task.sessionId === humanSession.id && task.workspaceId === REALM_QUALIFICATION_WORKSPACE_ID && task.changeId === REALM_QUALIFICATION_CHANGE_ID && !task.agentId);
            const task = parentTask ?? next.createTask({ principalId: humanSession.principalId, actorId: humanSession.actorId, sessionId: humanSession.id, purpose: "Qualify bounded agent credentials for an isolated workspace", workspaceId: REALM_QUALIFICATION_WORKSPACE_ID, changeId: REALM_QUALIFICATION_CHANGE_ID });
            const latest = next.getRecoverySnapshot();
            const parentGrant = Object.values(latest.grants).find((grant) => grant.status === "active" && grant.taskId === task.id && grant.sessionId === humanSession.id);
            const usableParentGrant = parentGrant ?? next.createCapabilityGrant({ principalId: humanSession.principalId, actorId: humanSession.actorId, clientId: humanSession.clientId, sessionId: humanSession.id, taskId: task.id, resource, sourceSpaceIds: [REALM_QUALIFICATION_SOURCE_SPACE_ID], actions: [...REALM_QUALIFICATION_ACTIONS], effects: ["source.read", "workspace.write", "run.invoke"], allowedModelProviders: [modelProvider], allowedCredentialClasses: [...REALM_QUALIFICATION_CREDENTIAL_CLASSES] });
            const delegated = next.delegateAgent({ humanSessionId: humanSession.id, parentGrantId: usableParentGrant.id, agentId: agent.id, purpose: "Qualify bounded agent credentials for an isolated workspace", resource, sourceSpaceIds: [REALM_QUALIFICATION_SOURCE_SPACE_ID], actions: ["source.read", "workspace.write", "change.publish_revision", "run.invoke"], effects: ["source.read", "workspace.write", "run.invoke"], allowedCredentialClasses: [...REALM_QUALIFICATION_CREDENTIAL_CLASSES], workspaceId: REALM_QUALIFICATION_WORKSPACE_ID, changeId: REALM_QUALIFICATION_CHANGE_ID });
            childSessionId = delegated.session.id;
            childTaskId = delegated.task.id;
            childGrantId = delegated.grant.id;
          }
          const finalState = next.getRecoverySnapshot();
          const childSession = finalState.sessions[childSessionId];
          const childTask = finalState.tasks[childTaskId];
          const childGrant = finalState.grants[childGrantId];
          if (!childSession || !childTask || !childGrant) throw new RealmIdentityError({ code: "qualification.delegation_missing", message: "The qualification delegation did not produce a complete Session, Task, and Grant chain.", recoveryAction: "reset the disposable Realm and retry the bounded delegation operation", receipt: "principal-actor-session-task-grant chain incomplete" });
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: delegationStatus, agent, session: childSession, task: childTask, grant: childGrant, credentialClasses: [...REALM_QUALIFICATION_CREDENTIAL_CLASSES], credentialExchangePath: "/api/owner/qualification/credentials", identity: identitySummary(next), receipt: `kernelMembership=verified; delegation=${delegationStatus}; workspace=${REALM_QUALIFICATION_WORKSPACE_ID}; credentials=not-issued; exchange=explicit; canonicalWrite=false; credentialMaterialStored=false` });
        });
      }

      if (url.pathname === "/identity/qualification/credentials") {
        const humanSessionId = coordinatorString(body, "humanSessionId");
        const agentId = coordinatorString(body, "agentId");
        const agentSessionId = coordinatorString(body, "agentSessionId");
        const taskId = coordinatorString(body, "taskId");
        const grantId = coordinatorString(body, "grantId");
        const classes = qualificationCredentialClasses(body);
        return await this.transitionIdentity((next) => {
          const humanSession = next.validateSession(humanSessionId);
          const agent = next.getAgent(agentId);
          const agentSession = next.validateSession(agentSessionId);
          const state = next.getRecoverySnapshot();
          const task = state.tasks[taskId];
          const grant = state.grants[grantId];
          if (!agent || agent.principalId !== humanSession.principalId || agent.status !== "active" || agentSession.actorKind !== "agent" || agentSession.agentId !== agentId || agentSession.principalId !== humanSession.principalId || agentSession.delegatedBySessionId !== humanSession.id || !task || task.status !== "active" || task.sessionId !== agentSession.id || task.agentId !== agentId || task.workspaceId !== REALM_QUALIFICATION_WORKSPACE_ID || task.changeId !== REALM_QUALIFICATION_CHANGE_ID || !grant || grant.status !== "active" || grant.agentId !== agentId || grant.sessionId !== agentSession.id || grant.taskId !== task.id || grant.resource.workspaceId !== REALM_QUALIFICATION_WORKSPACE_ID || grant.resource.changeId !== REALM_QUALIFICATION_CHANGE_ID) {
            throw new RealmIdentityError({ code: "qualification.credential_exchange_denied", message: "Credential exchange requires the active owner Session and the exact delegated agent Session, Task, and Grant for the isolated qualification Workspace.", recoveryAction: "delegate the qualification agent first and submit its exact Session, Task, and Grant identifiers", receipt: "credentialExchange=delegated-chain-required" });
          }
          const resource = { realmId: state.realm.id, projectId: REALM_QUALIFICATION_PROJECT_ID, sourceSpaceId: REALM_QUALIFICATION_SOURCE_SPACE_ID, workspaceId: REALM_QUALIFICATION_WORKSPACE_ID, changeId: REALM_QUALIFICATION_CHANGE_ID };
          const credentials = classes.map((credentialClass) => next.issueCredential({ class: credentialClass, principalId: humanSession.principalId, actorId: agentSession.actorId, clientId: agentSession.clientId, sessionId: agentSession.id, taskId: task.id, grantId: grant.id, resource }));
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "credentials-issued", agentId, agentSessionId, taskId, grantId, workspaceId: REALM_QUALIFICATION_WORKSPACE_ID, credentials: credentials.map((credential) => ({ id: credential.id, class: credential.class, audience: CREDENTIAL_AUDIENCES[credential.class], token: credential.token, expiresAt: credential.expiresAt })), identity: identitySummary(next), receipt: `kernelMembership=verified; credentialExchange=delegated-agent; classes=${classes.join(",")}; workspace=${REALM_QUALIFICATION_WORKSPACE_ID}; canonicalWrite=false; credentialMaterialStored=false` });
        });
      }

      if (url.pathname === "/identity/agent/delegation/validate") {
        const humanSessionId = coordinatorString(body, "humanSessionId");
        const agentId = coordinatorString(body, "agentId");
        const agentSessionId = coordinatorString(body, "agentSessionId");
        const taskId = coordinatorString(body, "taskId");
        const grantId = coordinatorString(body, "grantId");
        const capability = coordinatorString(body, "capability") as Capability;
        const sourceSpaceIds = coordinatorStringArray(body, "sourceSpaceIds");
        const resourceValue = body.resource;
        if (resourceValue === null || typeof resourceValue !== "object" || Array.isArray(resourceValue)) throw new RealmIdentityError({ code: "delegation.resource_invalid", message: "Delegation validation requires the exact resource object.", recoveryAction: "reuse the resource returned by the owner-approved delegation", receipt: "delegation=resource-object-required; validation=not-accepted" });
        const resourceBody = resourceValue as Record<string, unknown>;
        const resource: ResourceRef = { realmId: identity.realm.id, ...(typeof resourceBody.projectId === "string" ? { projectId: resourceBody.projectId } : {}), ...(typeof resourceBody.sourceSpaceId === "string" ? { sourceSpaceId: resourceBody.sourceSpaceId } : {}), ...(typeof resourceBody.workspaceId === "string" ? { workspaceId: resourceBody.workspaceId } : {}), ...(typeof resourceBody.changeId === "string" ? { changeId: resourceBody.changeId } : {}) };
        const humanSession = identity.validateSession(humanSessionId);
        const agentSession = identity.validateSession(agentSessionId);
        const state = identity.getRecoverySnapshot();
        const agent = state.agents[agentId];
        const actor = state.actors[agentSession.actorId];
        const task = state.tasks[taskId];
        const grant = state.grants[grantId];
        if (!agent || agent.status !== "active" || agent.principalId !== humanSession.principalId || !actor || actor.kind !== "agent" || actor.agentId !== agentId || agentSession.principalId !== humanSession.principalId || agentSession.delegatedBySessionId !== humanSession.id || !task || task.agentId !== agentId || task.sessionId !== agentSession.id || !grant || grant.agentId !== agentId || grant.taskId !== task.id || grant.sessionId !== agentSession.id) throw new RealmIdentityError({ code: "delegation.chain_invalid", message: "The Agent Session, Task, and Capability Grant do not form the owner-approved delegation chain.", recoveryAction: "reuse the exact delegated Agent identifiers or create a fresh delegation", receipt: "delegation=principal-actor-session-task-grant-chain-invalid; validation=not-accepted" });
        const validation = identity.validateTaskGrant({ principalId: humanSession.principalId, actorId: agentSession.actorId, clientId: agentSession.clientId, sessionId: agentSession.id, taskId, grantId, resource, sourceSpaceIds, action: capability });
        if (!validation.valid) throw new RealmIdentityError({ code: validation.code, message: "The delegated Agent Task/Grant is not live for this resource.", recoveryAction: validation.recoveryAction, receipt: validation.receipt });
        return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "delegation-valid", agentId, agentSessionId, taskId, grantId, modelProvider: agent.modelProvider, authorizationEpoch: validation.authorizationEpoch, sourceSpaceCount: validation.sourceSpaceCount, resource, receipt: `${validation.receipt}; delegation=validated; agent=${agentId}; task=${taskId}; grant=${grantId}; canonicalWrite=false` });
      }

      if (url.pathname === "/identity/qualification/revoke") {
        const humanSessionId = coordinatorString(body, "humanSessionId");
        const agentId = coordinatorOptionalString(body, "agentId", REALM_QUALIFICATION_AGENT_ID);
        return await this.transitionIdentity((next) => {
          const humanSession = next.validateSession(humanSessionId);
          const agent = next.getAgent(agentId);
          if (!agent || agent.principalId !== humanSession.principalId) throw new RealmIdentityError({ code: "qualification.agent_denied", message: "The requested qualification agent is not owned by the authenticated human Principal.", recoveryAction: "revoke only the agent returned by the current Realm delegation operation", receipt: "agent-principal-bound" });
          const before = next.getRecoverySnapshot();
          const result = next.revokeAgent(agentId);
          const after = next.getRecoverySnapshot();
          const affectedWorkspaceTasks = Object.values(before.tasks).filter((task) => task.agentId === agentId && task.workspaceId === REALM_QUALIFICATION_WORKSPACE_ID).length;
          const closedWorkspaceTasks = Object.values(after.tasks).filter((task) => task.agentId === agentId && task.workspaceId === REALM_QUALIFICATION_WORKSPACE_ID && task.status === "closed").length;
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "delegation-revoked", ...result, identity: identitySummary(next), receipt: `${result.receipt}; workspaceTasks=${closedWorkspaceTasks}/${affectedWorkspaceTasks}; parentHumanSession=${humanSession.id}; credentialMaterialStored=false` });
        });
      }

      if (url.pathname === "/identity/qualification/provider-operation") {
        const authorization = this.providerOwnerAuthorization(coordinatorString(body, "humanSessionId"));
        const record = await this.providerCoordinator().run(this.providerInput(body, authorization));
        return coordinatorJson({ protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL, status: record.state, operation: record, receipt: `${record.receipt}; ownerSession=validated` });
      }

      if (url.pathname === "/identity/qualification/provider-operation/resume") {
        const authorization = this.providerOwnerAuthorization(coordinatorString(body, "humanSessionId"));
        const operationId = coordinatorString(body, "operationId");
        const record = await this.providerCoordinator().resume(operationId, authorization);
        return coordinatorJson({ protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL, status: record.state, operation: record, receipt: `${record.receipt}; ownerSession=validated; recovery=resume` });
      }

      if (url.pathname === "/identity/qualification/provider-operation/callback") {
        const authorization = this.providerOwnerAuthorization(coordinatorString(body, "humanSessionId"));
        const operationId = coordinatorString(body, "operationId");
        const providerOperationId = coordinatorString(body, "providerOperationId");
        const expectedStateDigest = coordinatorString(body, "expectedStateDigest");
        const receipt = coordinatorString(body, "receipt");
        const outputDigest = typeof body.outputDigest === "string" && body.outputDigest.trim().length > 0 ? body.outputDigest.trim() : undefined;
        const record = await this.providerCoordinator().acceptCallback({ operationId, authorization, providerOperationId, expectedStateDigest, ...(outputDigest ? { outputDigest } : {}), receipt });
        return coordinatorJson({ protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL, status: record.state, operation: record, receipt: `${record.receipt}; ownerSession=validated; callback=reconciled` });
      }

      if (url.pathname === "/identity/qualification/provider-operation/callback/internal") {
        const operationId = coordinatorString(body, "operationId");
        const providerOperationId = coordinatorString(body, "providerOperationId");
        const expectedStateDigest = coordinatorString(body, "expectedStateDigest");
        const receipt = coordinatorString(body, "receipt");
        const snapshot = identity.getRecoverySnapshot();
        const installationId = this.env.ANYAM_INSTALLATION_ID?.trim() || "unconfigured";
        if (body.realmId !== snapshot.realm.id || body.installationId !== installationId) {
          throw new CustomerProviderOperationError({
            code: "unauthorized",
            message: "The provider callback is scoped to a different Realm installation.",
            recoveryAction: "send the callback through the coordinator belonging to the original operation",
            receipt: `operation=${operationId}; callbackScope=invalid; overwritten=false`,
          });
        }
        const providerCoordinator = this.providerCoordinator();
        const current = await providerCoordinator.inspect(operationId);
        if (current.owner.authorizationEpoch !== String(snapshot.realm.authorizationEpoch)) {
          throw new CustomerProviderOperationError({
            code: "unauthorized",
            message: "The provider callback was issued under an outdated Realm authorization epoch.",
            recoveryAction: "reconcile the operation after owner authorization is restored; do not replay the stale callback",
            receipt: `operation=${operationId}; callbackEpoch=${current.owner.authorizationEpoch}; currentEpoch=${snapshot.realm.authorizationEpoch}; overwritten=false`,
          });
        }
        const authorization: CustomerProviderOwnerAuthorization = {
          realmId: current.realmId,
          principalId: current.owner.principalId,
          sessionId: current.owner.sessionId,
          capability: "provider.qualification",
          authorizationEpoch: current.owner.authorizationEpoch,
          receipt: `internalCallback=queue-or-workflow; operation=${operationId}; credentialMaterialStored=false`,
        };
        const outputDigest = typeof body.outputDigest === "string" && body.outputDigest.trim().length > 0 ? body.outputDigest.trim() : undefined;
        const record = await providerCoordinator.acceptCallback({ operationId, authorization, providerOperationId, expectedStateDigest, ...(outputDigest ? { outputDigest } : {}), receipt });
        return coordinatorJson({ protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL, status: record.state, operation: record, receipt: `${record.receipt}; callback=internal-reconciled; canonicalWrite=false` });
      }

      if (url.pathname === "/identity/qualification/provider-operation/cleanup") {
        const authorization = this.providerOwnerAuthorization(coordinatorString(body, "humanSessionId"));
        const operationId = coordinatorString(body, "operationId");
        const record = await this.providerCoordinator().cleanup(operationId, authorization);
        return coordinatorJson({ protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL, status: record.cleanup?.status ?? "blocked", operation: record, cleanup: record.cleanup, receipt: `${record.receipt}; ownerSession=validated; cleanup=${record.cleanup?.status ?? "missing"}` });
      }

      if (url.pathname === "/identity/qualification/provider-recovery/export") {
        const authorization = this.providerOwnerAuthorization(coordinatorString(body, "humanSessionId"));
        const bundle = await this.providerCoordinator().exportRecovery();
        return coordinatorJson({ protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL, status: "recovery-exported", bundle, ownerPrincipalId: authorization.principalId, receipt: `${bundle.integrity.receipt}; ownerSession=validated; authority=not-restored` });
      }

      if (url.pathname === "/identity/qualification/provider-recovery/restore") {
        const authorization = this.providerOwnerAuthorization(coordinatorString(body, "humanSessionId"));
        const bundle = providerBundle(body);
        await this.providerCoordinator().restoreRecovery(bundle);
        return coordinatorJson({ protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL, status: "recovery-restored", ownerPrincipalId: authorization.principalId, recordCount: bundle.records.length, receipt: `${bundle.integrity.receipt}; ownerSession=validated; authority=restored; credentials=not-restored` });
      }

      if (url.pathname === "/identity/session/validate") {
        const sessionId = coordinatorString(body, "sessionId");
        const session = identity.validateSession(sessionId);
        return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "session-valid", session, identity: identitySummary(identity), recoveryStatus: this.recoveryStatus, receipt: "kernelMembership=verified; session=active; authorizationEpoch=checked; recoveryStatus=observed" });
      }

      if (url.pathname === "/identity/session/revoke") {
        const sessionId = coordinatorString(body, "sessionId");
        return await this.transitionIdentity((next) => {
          const revoked = next.revokeSession(sessionId);
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "session-revoked", ...revoked, identity: identitySummary(next), receipt: "kernelMembership=verified; session=revoked; delegatedAuthority=closed" });
        });
      }

      if (url.pathname === "/identity/qualification/recovery/export") {
        const humanSessionId = coordinatorString(body, "humanSessionId");
        const humanSession = identity.validateSession(humanSessionId);
        const snapshot = identity.getRecoverySnapshot();
        return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "recovery-exported", recoveryStatus: this.recoveryStatus, ownerPrincipalId: humanSession.principalId, snapshot, receipt: "recovery=exported; credentialFree=true; authority=not-restored" });
      }

      if (url.pathname === "/identity/qualification/recovery/restore") {
        const humanSessionId = coordinatorString(body, "humanSessionId");
        const snapshot = recoverySnapshot(body);
        return await this.transitionIdentity((next) => {
          const humanSession = next.validateSession(humanSessionId);
          next.restoreRecoverySnapshot(snapshot);
          this.recoveryStatus = "recovery-pending";
          return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "recovery-pending", recoveryStatus: this.recoveryStatus, ownerPrincipalId: humanSession.principalId, identity: identitySummary(next), receipt: "recovery=restored; credentialFree=true; sessions=revoked; grants=revoked; credentials=not-restored; ownerReactivation=passkey-required" });
        });
      }

      return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, code: "not_found", recoveryAction: "use one of the bounded identity coordinator routes", receipt: `coordinator=route-not-found; path=${url.pathname}` }, 404);
    } catch (error) {
      return coordinatorError(error);
    }
  }
}

/**
 * The Workflow binding is deliberately narrow. It can complete the named
 * customer-provider qualification fixture, but it is not a general Run or
 * deployment orchestrator and never becomes state authority.
 */
export class AnyamRealmWorkflow extends WorkflowEntrypoint<Env, Record<string, unknown>> {
  override async run(event: Readonly<WorkflowEvent<Record<string, unknown>>>, step: WorkflowStep): Promise<Record<string, unknown>> {
    if (event.payload.protocol === CUSTOMER_PROVIDER_OPERATION_PROTOCOL && typeof event.payload.operationId === "string") {
      const operationId = event.payload.operationId;
      const outputDigest = typeof event.payload.outputDigest === "string" ? event.payload.outputDigest : undefined;
      const result = await step.do("bounded customer-provider qualification", async () => ({
        protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL,
        operationId,
        status: "complete",
        ...(outputDigest ? { outputDigest } : {}),
        receipt: `workflow=${event.instanceId}; operation=${operationId}; step=complete; authority=coordinator`,
      }));
      const binding = this.env.REALM_COORDINATOR as unknown as DurableObjectNamespace | undefined;
      const realmId = typeof event.payload.realmId === "string" ? event.payload.realmId : undefined;
      const installationId = typeof event.payload.installationId === "string" ? event.payload.installationId : undefined;
      const providerOperationId = typeof event.payload.providerOperationId === "string" ? event.payload.providerOperationId : undefined;
      const expectedStateDigest = typeof event.payload.expectedStateDigest === "string" ? event.payload.expectedStateDigest : undefined;
      if (!binding || typeof binding.idFromName !== "function" || !realmId || !installationId || !providerOperationId || !expectedStateDigest) throw new Error("workflow_provider_callback_authority_unavailable");
      const callbackResponse = await binding.get(binding.idFromName(realmId)).fetch(new Request("https://anyam-realm-coordinator/identity/qualification/provider-operation/callback/internal", {
        method: "POST",
        headers: { "content-type": "application/json", [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE },
        body: JSON.stringify({ protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL, realmId, installationId, operationId, providerOperationId, expectedStateDigest, ...(outputDigest ? { outputDigest } : {}), receipt: `workflow=${event.instanceId}; callback=result-accepted; authority=coordinator` }),
      }));
      if (!callbackResponse.ok) throw new Error(`workflow_provider_callback_rejected:${callbackResponse.status}`);
      return result;
    }
    return {
      status: "blocked",
      recoveryAction: "Start the bounded customer-provider qualification operation before invoking this Workflow binding.",
      receipt: "workflowAuthority=qualification-only; credentialFree=true; canonicalWrite=false",
    };
  }
}

function isAnyamOAuthPath(pathname: string): boolean {
  return pathname === "/mcp"
    || pathname === "/authorize"
    || pathname === "/oauth/token"
    || pathname === "/oauth/register"
    || pathname.startsWith("/.well-known/oauth-")
    || pathname === "/.well-known/openid-configuration";
}

function queueMessageString(message: Record<string, unknown>, key: string): string | undefined {
  const value = message[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function reconcileCustomerProviderQueue(batch: MessageBatch<Record<string, unknown>>, env: Env): Promise<void> {
  const binding = env.REALM_COORDINATOR as unknown as DurableObjectNamespace | undefined;
  for (const message of batch.messages) {
    const body = message.body;
    if (body.protocol !== CUSTOMER_PROVIDER_OPERATION_PROTOCOL) {
      // This queue is disposable and qualification-scoped. Do not allow an
      // unrelated message to become a poison message or an authority input.
      message.ack();
      continue;
    }
    const realmId = queueMessageString(body, "realmId");
    const installationId = queueMessageString(body, "installationId");
    const operationId = queueMessageString(body, "operationId");
    const providerOperationId = queueMessageString(body, "providerOperationId");
    const expectedStateDigest = queueMessageString(body, "expectedStateDigest");
    const outputDigest = queueMessageString(body, "outputDigest");
    if (!binding || typeof binding.idFromName !== "function" || !realmId || !installationId || !operationId || !providerOperationId || !expectedStateDigest || !outputDigest) {
      message.retry();
      continue;
    }
    const stub = binding.get(binding.idFromName(realmId));
    const response = await stub.fetch(new Request("https://anyam-realm-coordinator/identity/qualification/provider-operation/callback/internal", {
      method: "POST",
      headers: { "content-type": "application/json", [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE },
      body: JSON.stringify({
        protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL,
        realmId,
        installationId,
        operationId,
        providerOperationId,
        expectedStateDigest,
        outputDigest,
        receipt: `queue=${batch.queue}; message=${message.id}; attempts=${message.attempts}; result=coordinator-callback`,
      }),
    }));
    if (!response.ok) {
      message.retry();
      continue;
    }
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (result.status === "succeeded") message.ack();
    else message.retry();
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let result = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) result |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return result === 0;
}

async function publicGatewayAuthorization(request: Request, env: Env): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== "/internal/public-gateway/authorize") return undefined;
  const configured = env.ANYAM_PUBLIC_GATEWAY_SERVICE_SECRET?.trim();
  const presented = request.headers.get("x-anyam-public-gateway-service-secret")?.trim();
  if (!configured || !presented || !constantTimeEqual(configured, presented)) return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "blocked", code: "public_gateway_internal_unauthorized", recoveryAction: "invoke this route only through the bound Public Gateway service with the customer-owned service secret", receipt: "publicGateway=internal-auth-failed; authorization=not-issued; credentialMaterialStored=false" }, 403);
  try {
    const body = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be a JSON object");
    const result = await requestAnyamRealmCoordinator(env, "/public-gateway/authorize", body as Record<string, unknown>);
    return coordinatorJson(result, result.status === "authorized" ? 200 : 403);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return coordinatorJson({ protocol: REALM_COORDINATOR_PROTOCOL, status: "blocked", code: "public_gateway_authorization_failed", message, recoveryAction: "authenticate an owner or moderator Realm session and retry the same Public Gateway operation", receipt: "publicGateway=authorization-failed; credentialMaterialStored=false" }, 403);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const publicGatewayResponse = await publicGatewayAuthorization(request, env);
    if (publicGatewayResponse) return publicGatewayResponse;
    const githubActionsBridgeResponse = await handleGitHubActionsBridgeRequest(request, env);
    if (githubActionsBridgeResponse) return githubActionsBridgeResponse;
    // Owner ceremony routes do not need the OAuth provider to be constructed.
    // This keeps local HTTP development useful while the provider correctly
    // enforces HTTPS issuer metadata for MCP/OAuth requests.
    const ownerResponse = await handleAnyamRealmOwnerRequest(request, env);
    if (ownerResponse) return ownerResponse;

    const authorityResponse = await handleAuthorityRequest(request, env);
    if (authorityResponse) return authorityResponse;

    const url = new URL(request.url);
    if (!isAnyamOAuthPath(url.pathname)) return handleCustomerRealmRequest(request, env);

    const origin = url.origin;
    const oauthProvider = createAnyamRealmOAuthProvider({
      resource: `${origin}/mcp`,
      issuer: origin,
    });
    return oauthProvider.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<Record<string, unknown>>, env: Env): Promise<void> {
    await reconcileCustomerProviderQueue(batch, env);
  },
};
