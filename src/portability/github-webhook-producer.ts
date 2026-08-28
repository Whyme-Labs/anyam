import type { GitRef, MirrorRepositoryObservation } from "../kernel/contracts.ts";

import { GITHUB_WEBHOOK_INGRESS_PROTOCOL, type GitHubWebhookIngressEnvelope } from "./github-webhook.ts";
import { MIRROR_HANDOFF_AUDIENCE, MIRROR_HANDOFF_CLOCK_SKEW_MS, MIRROR_HANDOFF_SIZING_RECEIPT, MIRROR_HANDOFF_TTL_MS, signMirrorIngestionHandoff, type MirrorIngestionCommand, type MirrorIngestionHandoff } from "./mirror-observation.ts";

export const GITHUB_MIRROR_PRODUCER_PROTOCOL = "anyam.github-mirror-producer/v1" as const;
export const GITHUB_MIRROR_PRODUCER_CONTEXT_PROTOCOL = "anyam.github-mirror-producer-context/v1" as const;
export const GITHUB_MIRROR_HANDOFF_TTL_MS = MIRROR_HANDOFF_TTL_MS;
export const GITHUB_MIRROR_HANDOFF_SIZING_RECEIPT = MIRROR_HANDOFF_SIZING_RECEIPT;
export const GITHUB_MIRROR_PRODUCER_ENVELOPE_MAX_BYTES = 2_097_152;
export const GITHUB_MIRROR_PRODUCER_ENVELOPE_SIZING_RECEIPT = "envelopeBytesLimit=2097152; sizing=qualification-tripwire; remeasure-before-production";

type JsonObject = Record<string, unknown>;

export type GitHubMirrorProducerContext = {
  protocol: typeof GITHUB_MIRROR_PRODUCER_CONTEXT_PROTOCOL;
  realmId: string;
  mirrorId: string;
  projectId: string;
  repositoryId: string;
  sourceSpaceId: string;
  projectViewId: string;
  remoteRepository: string;
  installationId: string;
  canonicalProjectRevisionId: string;
  canonicalRefs: readonly GitRef[];
  refMappings: readonly { localRef: string; remoteRef: string }[];
  remoteGeneration: string;
  remoteRefs: readonly GitRef[];
  pendingInboundChangeIds: readonly string[];
  disclosure: "public" | "project" | "restricted";
};

export type GitHubMirrorProducerResult = {
  protocol: typeof GITHUB_MIRROR_PRODUCER_PROTOCOL;
  status: "succeeded" | "blocked";
  deliveryId: string;
  code?: string;
  duplicate?: true;
  receipt: string;
  recoveryAction?: string;
};

export type GitHubMirrorHandoff = MirrorIngestionHandoff;

export type GitHubMirrorIngestResult = {
  status: "succeeded" | "blocked";
  duplicate?: true;
  receipt: string;
  recoveryAction?: string;
};

export type GitHubMirrorIngest = (handoff: GitHubMirrorHandoff) => Promise<GitHubMirrorIngestResult>;

export class GitHubMirrorProducerError extends Error {
  readonly code: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: string; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "GitHubMirrorProducerError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function requiredString(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || (field !== "privateKey" && /[\r\n]/u.test(value))) throw new GitHubMirrorProducerError({ code: "invalid_input", message: `${field} must be a bounded non-empty string.`, recoveryAction: `return a valid ${field} from the trusted Realm context or Queue envelope`, receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; field=${field}; transition=not-applied; credentialMaterialStored=false` });
  return value.trim();
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as JsonObject;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof value === "string" ? value : stableJson(value))));
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function der(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), derLength(value.byteLength), value);
}

function privateKeyDer(pem: string): Uint8Array {
  const normalized = pem.trim();
  const match = normalized.match(/-----BEGIN ([^-]+)-----([\s\S]+?)-----END \1-----/u);
  if (!match) throw new GitHubMirrorProducerError({ code: "private_key_invalid", message: "The GitHub App private key is not a PEM document.", recoveryAction: "configure the generated GitHub App PEM as a Worker secret and retry the synchronizer", receipt: "producer=github-app; privateKey=pem-required; credentialMaterialStored=false" });
  const encoded = match[2]!.replace(/[\s\r\n]/gu, "");
  const derBytes = decodeBase64(encoded);
  if (match[1] === "PRIVATE KEY") return derBytes;
  if (match[1] !== "RSA PRIVATE KEY") throw new GitHubMirrorProducerError({ code: "private_key_invalid", message: "The GitHub App private key uses an unsupported PEM type.", recoveryAction: "configure a PKCS#1 RSA PRIVATE KEY or PKCS#8 PRIVATE KEY generated by GitHub", receipt: `producer=github-app; privateKeyType=${match[1]}; credentialMaterialStored=false` });
  const algorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  return der(0x30, concatBytes(der(0x02, Uint8Array.of(0)), algorithm, der(0x04, derBytes)));
}

async function importSigningKey(pem: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey("pkcs8", privateKeyDer(pem).buffer as ArrayBuffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (error) {
    if (error instanceof GitHubMirrorProducerError) throw error;
    throw new GitHubMirrorProducerError({ code: "private_key_invalid", message: "The GitHub App private key could not be imported by the Worker Web Crypto runtime.", recoveryAction: "generate a fresh RSA GitHub App private key and configure it as a Worker secret", receipt: `producer=github-app; privateKey=import-failed; error=${error instanceof Error ? error.name : "unknown"}; credentialMaterialStored=false` });
  }
}

async function appJwt(input: { appId: string; privateKey: string; lifetimeSeconds: number; clockSkewSeconds: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = now - input.clockSkewSeconds;
  const unsigned = `${base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${base64Url(new TextEncoder().encode(JSON.stringify({ iat: issuedAt, exp: issuedAt + input.lifetimeSeconds, iss: input.appId })))}`;
  const key = await importSigningKey(input.privateKey);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function boundedResponseText(response: Response, limit: number): Promise<string> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("response_limit_invalid");
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw new GitHubMirrorProducerError({ code: "provider_response_too_large", message: "GitHub returned a response beyond the producer response tripwire.", recoveryAction: "increase the measured provider response tripwire only after remeasurement, then retry the same delivery", receipt: `producer=github-app; responseBytesLimit=${limit}; declaredBytes=${declared}; providerMutation=false; credentialMaterialStored=false` });
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        await reader.cancel("github-provider-response-too-large");
        throw new GitHubMirrorProducerError({ code: "provider_response_too_large", message: "GitHub returned a response beyond the producer response tripwire.", recoveryAction: "increase the measured provider response tripwire only after remeasurement, then retry the same delivery", receipt: `producer=github-app; responseBytes=${bytes}; responseBytesLimit=${limit}; providerMutation=false; credentialMaterialStored=false` });
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel("github-provider-response-read-failed").catch(() => undefined);
    throw error;
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

type GitHubApiClientOptions = {
  appId: string;
  installationId: string;
  repository: string;
  privateKey: string;
  jwtLifetimeSeconds: number;
  jwtLifetimeReceipt: string;
  clockSkewSeconds: number;
  clockSkewReceipt: string;
  responseBytesLimit: number;
  responseBytesReceipt: string;
  requestTimeoutMs: number;
  requestTimeoutReceipt: string;
  fetchImpl?: typeof fetch;
};

class GitHubWebhookApiClient {
  private readonly options: GitHubApiClientOptions & { fetchImpl: typeof fetch };
  private token: { value: string; expiresAt: number } | undefined;

  constructor(input: GitHubApiClientOptions) {
    if (!Number.isSafeInteger(input.jwtLifetimeSeconds) || input.jwtLifetimeSeconds <= 0 || !Number.isSafeInteger(input.clockSkewSeconds) || input.clockSkewSeconds < 0 || !Number.isSafeInteger(input.responseBytesLimit) || input.responseBytesLimit <= 0 || !Number.isSafeInteger(input.requestTimeoutMs) || input.requestTimeoutMs <= 0) throw new GitHubMirrorProducerError({ code: "configuration_invalid", message: "The GitHub producer requires positive measured JWT, response, and request tripwires.", recoveryAction: "configure the provider tripwires and their receipts before binding the producer", receipt: "producer=github-app; configuration=tripwire-invalid; credentialMaterialStored=false" });
    if (input.jwtLifetimeReceipt.trim().length === 0 || input.clockSkewReceipt.trim().length === 0 || input.responseBytesReceipt.trim().length === 0 || input.requestTimeoutReceipt.trim().length === 0) throw new GitHubMirrorProducerError({ code: "configuration_invalid", message: "The GitHub producer requires receipts for every provider tripwire.", recoveryAction: "configure provider tripwire receipts before binding the producer", receipt: "producer=github-app; configuration=receipt-required; credentialMaterialStored=false" });
    this.options = { ...input, appId: requiredString(input.appId, "appId"), installationId: requiredString(input.installationId, "installationId"), repository: requiredString(input.repository, "repository"), privateKey: requiredString(input.privateKey, "privateKey", 16_384), fetchImpl: input.fetchImpl ?? fetch };
  }

  private async request(input: { method: "GET" | "POST"; path: string; token: string; body?: JsonObject }): Promise<JsonObject> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("github-provider-timeout"), this.options.requestTimeoutMs);
    try {
      const response = await this.options.fetchImpl(`https://api.github.com${input.path}`, {
        method: input.method,
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: `Bearer ${input.token}`, "cache-control": "no-cache", ...(input.body ? { "content-type": "application/json" } : {}) },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        signal: controller.signal,
      });
      const raw = await boundedResponseText(response, this.options.responseBytesLimit);
      let value: unknown;
      try { value = raw.length > 0 ? JSON.parse(raw) as unknown : {}; } catch { value = {}; }
      if (!response.ok || value === null || typeof value !== "object" || Array.isArray(value)) throw new GitHubMirrorProducerError({ code: `provider_http_${response.status}`, message: `GitHub provider request ${input.method} ${input.path} failed.`, recoveryAction: response.status === 404 ? "reconcile the selected GitHub repository, ref, or pull request before retrying the same delivery" : "retry the same provider delivery after inspecting the bounded provider receipt", receipt: `producer=github-app; operation=${input.method} ${input.path}; httpStatus=${response.status}; responseBytesReceipt=${this.options.responseBytesReceipt}; providerMutation=false; credentialMaterialStored=false` });
      return value as JsonObject;
    } catch (error) {
      if (error instanceof GitHubMirrorProducerError) throw error;
      throw new GitHubMirrorProducerError({ code: "provider_transport_failed", message: "GitHub provider request failed before a trusted response was received.", recoveryAction: "retry the same delivery after the provider request timeout and transport are healthy", receipt: `producer=github-app; operation=${input.method} ${input.path}; requestTimeoutMs=${this.options.requestTimeoutMs}; requestTimeoutReceipt=${this.options.requestTimeoutReceipt}; error=${error instanceof Error ? error.name : "unknown"}; providerMutation=false; credentialMaterialStored=false` });
    } finally {
      clearTimeout(timer);
    }
  }

  private async installationToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - now > 30_000) return this.token.value;
    const jwt = await appJwt({ appId: this.options.appId, privateKey: this.options.privateKey, lifetimeSeconds: this.options.jwtLifetimeSeconds, clockSkewSeconds: this.options.clockSkewSeconds });
    const repositoryName = this.options.repository.split("/").at(-1);
    if (!repositoryName) throw new GitHubMirrorProducerError({ code: "repository_invalid", message: "The selected GitHub repository must be owner/name.", recoveryAction: "configure the exact selected GitHub repository full name", receipt: "producer=github-app; repository=invalid; credentialMaterialStored=false" });
    const response = await this.request({ method: "POST", path: `/app/installations/${encodeURIComponent(this.options.installationId)}/access_tokens`, token: jwt, body: { repositories: [repositoryName], permissions: { contents: "read", metadata: "read", pull_requests: "read" } } });
    const value = typeof response.token === "string" ? response.token : undefined;
    const expiresAt = typeof response.expires_at === "string" ? Date.parse(response.expires_at) : NaN;
    if (!value || !Number.isFinite(expiresAt) || expiresAt <= now) throw new GitHubMirrorProducerError({ code: "installation_token_invalid", message: "GitHub did not return a valid short-lived installation token.", recoveryAction: "inspect the installed App permissions and issue a fresh installation token", receipt: `producer=github-app; installation=${this.options.installationId}; token=not-persisted; expiry=invalid; credentialMaterialStored=false` });
    this.token = { value, expiresAt };
    return value;
  }

  async ref(remoteRef: string): Promise<{ oid: string }> {
    const token = await this.installationToken();
    const path = remoteRef.replace(/^refs\//u, "").split("/").map((part) => encodeURIComponent(part)).join("/");
    const value = await this.request({ method: "GET", path: `/repos/${this.options.repository}/git/ref/${path}`, token });
    const object = value.object as JsonObject | undefined;
    const oid = typeof object?.sha === "string" ? object.sha : undefined;
    if (!oid || !/^[0-9a-f]{40}$/iu.test(oid)) throw new GitHubMirrorProducerError({ code: "ref_observation_invalid", message: "GitHub returned an invalid ref object.", recoveryAction: "reinspect the exact mapped ref and retry the same delivery", receipt: `producer=github-app; ref=${remoteRef}; observation=invalid; providerMutation=false; credentialMaterialStored=false` });
    return { oid };
  }

  async commit(oid: string): Promise<{ oid: string; treeOid: string; author: { name: string; email?: string } }> {
    const token = await this.installationToken();
    const value = await this.request({ method: "GET", path: `/repos/${this.options.repository}/commits/${encodeURIComponent(oid)}`, token });
    const commit = value.commit as JsonObject | undefined;
    const author = commit?.author as JsonObject | undefined;
    const tree = commit?.tree as JsonObject | undefined;
    const treeOid = typeof tree?.sha === "string" ? tree.sha : undefined;
    if (!treeOid || !/^[0-9a-f]{40}$/iu.test(treeOid)) throw new GitHubMirrorProducerError({ code: "commit_observation_invalid", message: "GitHub returned a commit without a valid tree identity.", recoveryAction: "reinspect the exact provider commit and retry the same delivery", receipt: `producer=github-app; commit=${oid}; tree=invalid; providerMutation=false; credentialMaterialStored=false` });
    const name = typeof author?.name === "string" && author.name.trim().length > 0 ? author.name.trim() : "GitHub contributor";
    const email = typeof author?.email === "string" && author.email.trim().length > 0 ? author.email.trim() : undefined;
    return { oid, treeOid, author: { name, ...(email ? { email } : {}) } };
  }

  async compare(baseOid: string, headOid: string): Promise<"identical" | "ahead" | "behind" | "diverged"> {
    const token = await this.installationToken();
    const value = await this.request({ method: "GET", path: `/repos/${this.options.repository}/compare/${encodeURIComponent(baseOid)}...${encodeURIComponent(headOid)}`, token });
    if (value.status !== "identical" && value.status !== "ahead" && value.status !== "behind" && value.status !== "diverged") throw new GitHubMirrorProducerError({ code: "compare_observation_invalid", message: "GitHub returned an unrecognized ancestry comparison.", recoveryAction: "reinspect the exact provider base and head commits before retrying the delivery", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; compare=invalid; providerMutation=false; credentialMaterialStored=false` });
    return value.status;
  }

  async pullRequest(number: number): Promise<{ number: number; state: "open" | "closed"; merged: boolean; headRef: string; headCommit: string; baseRef: string; baseCommit: string; title?: string }> {
    const token = await this.installationToken();
    const value = await this.request({ method: "GET", path: `/repos/${this.options.repository}/pulls/${encodeURIComponent(String(number))}`, token });
    const head = value.head as JsonObject | undefined;
    const base = value.base as JsonObject | undefined;
    const headRef = typeof head?.ref === "string" ? head.ref : undefined;
    const headCommit = typeof (head?.sha) === "string" ? head.sha : undefined;
    const baseRef = typeof base?.ref === "string" ? base.ref : undefined;
    const baseCommit = typeof (base?.sha) === "string" ? base.sha : undefined;
    const state = value.state === "open" ? "open" : value.state === "closed" ? "closed" : undefined;
    if (!headRef || !headCommit || !baseRef || !baseCommit || !state || !/^[0-9a-f]{40}$/iu.test(headCommit) || !/^[0-9a-f]{40}$/iu.test(baseCommit)) throw new GitHubMirrorProducerError({ code: "pull_request_observation_invalid", message: "GitHub returned an incomplete pull-request lineage.", recoveryAction: "reinspect the selected pull request and retry the same delivery", receipt: `producer=github-app; pullRequest=${number}; lineage=invalid; providerMutation=false; credentialMaterialStored=false` });
    return { number, state, merged: value.merged === true, headRef, headCommit, baseRef, baseCommit, ...(typeof value.title === "string" ? { title: value.title } : {}) };
  }
}

function parseRefs(value: unknown, field: string): GitRef[] {
  if (!Array.isArray(value)) throw new GitHubMirrorProducerError({ code: "context_invalid", message: `${field} must be an array of Git refs.`, recoveryAction: "return the complete provider Mirror context from the Realm", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; field=${field}; transition=not-applied; credentialMaterialStored=false` });
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new GitHubMirrorProducerError({ code: "context_invalid", message: `${field}[${index}] must be a Git ref object.`, recoveryAction: "return named ref and OID objects in the trusted Realm context", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; field=${field}[${index}]; transition=not-applied; credentialMaterialStored=false` });
    const record = entry as JsonObject;
    const name = requiredString(record.name, `${field}[${index}].name`);
    const oid = requiredString(record.oid, `${field}[${index}].oid`);
    if (!/^refs\/[A-Za-z0-9._/-]+$/u.test(name) || !/^[0-9a-f]{40}$/iu.test(oid)) throw new GitHubMirrorProducerError({ code: "context_invalid", message: `${field}[${index}] contains an invalid ref or OID.`, recoveryAction: "return GitHub-compatible refs and SHA-1 OIDs from the trusted Realm context", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; field=${field}[${index}]; transition=not-applied; credentialMaterialStored=false` });
    return { name, oid };
  });
}

export function parseGitHubMirrorProducerContext(value: unknown): GitHubMirrorProducerContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new GitHubMirrorProducerError({ code: "context_invalid", message: "The Realm producer context must be a JSON object.", recoveryAction: "request a fresh context from the customer Realm", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; context=object-required; transition=not-applied; credentialMaterialStored=false` });
  const record = value as JsonObject;
  const protocol = requiredString(record.protocol, "protocol");
  const disclosure = record.disclosure === "public" || record.disclosure === "project" || record.disclosure === "restricted" ? record.disclosure : undefined;
  const refMappings = Array.isArray(record.refMappings) ? record.refMappings.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new GitHubMirrorProducerError({ code: "context_invalid", message: `refMappings[${index}] must be an object.`, recoveryAction: "return complete ref mappings from the trusted Realm context", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; field=refMappings[${index}]; transition=not-applied; credentialMaterialStored=false` });
    const mapping = entry as JsonObject;
    return { localRef: requiredString(mapping.localRef, `refMappings[${index}].localRef`), remoteRef: requiredString(mapping.remoteRef, `refMappings[${index}].remoteRef`) };
  }) : undefined;
  const pendingInboundChangeIds = Array.isArray(record.pendingInboundChangeIds) && record.pendingInboundChangeIds.every((entry) => typeof entry === "string") ? record.pendingInboundChangeIds.map((entry) => entry.trim()).filter(Boolean) : undefined;
  if (protocol !== GITHUB_MIRROR_PRODUCER_CONTEXT_PROTOCOL || !disclosure || !refMappings || refMappings.length === 0 || !pendingInboundChangeIds || record.canonicalRefs === undefined || record.remoteRefs === undefined) throw new GitHubMirrorProducerError({ code: "context_invalid", message: "The Realm producer context is incomplete.", recoveryAction: "re-read the exact Mirror context and retry the same provider delivery", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; context=complete-required; transition=not-applied; credentialMaterialStored=false` });
  return {
    protocol,
    realmId: requiredString(record.realmId, "realmId"),
    mirrorId: requiredString(record.mirrorId, "mirrorId"),
    projectId: requiredString(record.projectId, "projectId"),
    repositoryId: requiredString(record.repositoryId, "repositoryId"),
    sourceSpaceId: requiredString(record.sourceSpaceId, "sourceSpaceId"),
    projectViewId: requiredString(record.projectViewId, "projectViewId"),
    remoteRepository: requiredString(record.remoteRepository, "remoteRepository"),
    installationId: requiredString(record.installationId, "installationId"),
    canonicalProjectRevisionId: requiredString(record.canonicalProjectRevisionId, "canonicalProjectRevisionId"),
    canonicalRefs: parseRefs(record.canonicalRefs, "canonicalRefs"),
    refMappings,
    remoteGeneration: requiredString(record.remoteGeneration, "remoteGeneration"),
    remoteRefs: parseRefs(record.remoteRefs, "remoteRefs"),
    pendingInboundChangeIds,
    disclosure,
  };
}

function parseEnvelope(value: unknown): GitHubWebhookIngressEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new GitHubMirrorProducerError({ code: "envelope_invalid", message: "The queued GitHub webhook envelope must be a JSON object.", recoveryAction: "requeue the original credential-free webhook envelope after inspecting Queue serialization", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; envelope=object-required; providerMutation=false; credentialMaterialStored=false` });
  const record = value as JsonObject;
  const event = record.event === "push" || record.event === "pull_request" ? record.event : undefined;
  const envelope = {
    protocol: requiredString(record.protocol, "protocol"),
    realmId: requiredString(record.realmId, "realmId"),
    event: event ?? "invalid",
    ...(typeof record.action === "string" ? { action: record.action } : {}),
    deliveryId: requiredString(record.deliveryId, "deliveryId"),
    repository: requiredString(record.repository, "repository"),
    installationId: requiredString(record.installationId, "installationId"),
    body: requiredString(record.body, "body", GITHUB_MIRROR_PRODUCER_ENVELOPE_MAX_BYTES),
    signature: requiredString(record.signature, "signature"),
    bodyDigest: requiredString(record.bodyDigest, "bodyDigest"),
    receivedAt: requiredString(record.receivedAt, "receivedAt"),
    receipt: requiredString(record.receipt, "receipt"),
  } as GitHubWebhookIngressEnvelope;
  if (envelope.protocol !== GITHUB_WEBHOOK_INGRESS_PROTOCOL || event === undefined || !/^sha256:[0-9a-f]{64}$/u.test(envelope.bodyDigest) || !/^sha256=[0-9a-f]{64}$/iu.test(envelope.signature)) throw new GitHubMirrorProducerError({ code: "envelope_invalid", message: "The queued GitHub webhook envelope failed its protocol or digest checks.", recoveryAction: "retain the delivery identity, inspect the Queue serialization, and retry only the original signed envelope", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; envelope=protocol-or-digest-invalid; delivery=${envelope.deliveryId}; providerMutation=false; credentialMaterialStored=false` });
  return envelope;
}

function payloadObject(body: string): JsonObject {
  try {
    const value: unknown = JSON.parse(body);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  } catch {
    // Fall through to the typed error below.
  }
  throw new GitHubMirrorProducerError({ code: "payload_invalid", message: "The queued GitHub webhook body is not a JSON object.", recoveryAction: "ask GitHub to redeliver the original webhook after inspecting the delivery payload", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; payload=object-required; providerMutation=false; credentialMaterialStored=false` });
}

function sourceIdentity(installationId: string): string {
  return `installation:${installationId}`;
}

function refNameForRemote(remoteRef: string): string {
  return remoteRef.startsWith("refs/") ? remoteRef : `refs/${remoteRef}`;
}

function canonicalRefFor(context: GitHubMirrorProducerContext, remoteRef: string): GitRef | undefined {
  const mapping = context.refMappings.find((candidate) => candidate.remoteRef === remoteRef);
  return mapping ? context.canonicalRefs.find((ref) => ref.name === mapping.localRef) : undefined;
}

function remoteRefSet(context: GitHubMirrorProducerContext, values: readonly GitRef[]): GitRef[] {
  const mapped = new Set(context.refMappings.map((mapping) => mapping.remoteRef));
  return values.filter((ref) => mapped.has(ref.name)).map((ref) => ({ ...ref }));
}

export async function signGitHubMirrorHandoff(input: { command: JsonObject; keyId: string; secret: string; nonce: string; realmId: string; installationId: string; issuer: string; provider: string; remoteRepository: string; mirrorId: string; deliveryId: string; proposalKey: string; issuedAt: string; expiresAt: string; audience?: typeof MIRROR_HANDOFF_AUDIENCE; now?: number; maxLifetimeMs?: number; clockSkewMs?: number }): Promise<GitHubMirrorHandoff> {
  return await signMirrorIngestionHandoff({ command: input.command as unknown as MirrorIngestionCommand, keyId: input.keyId, secret: input.secret, nonce: input.nonce, realmId: input.realmId, installationId: input.installationId, issuer: input.issuer, provider: input.provider, remoteRepository: input.remoteRepository, mirrorId: input.mirrorId, deliveryId: input.deliveryId, proposalKey: input.proposalKey, issuedAt: input.issuedAt, expiresAt: input.expiresAt, ...(input.audience === undefined ? {} : { audience: input.audience }), ...(input.now === undefined ? {} : { now: input.now }), ...(input.maxLifetimeMs === undefined ? {} : { maxLifetimeMs: input.maxLifetimeMs }), clockSkewMs: input.clockSkewMs ?? MIRROR_HANDOFF_CLOCK_SKEW_MS }) as GitHubMirrorHandoff;
}

export class GitHubWebhookMirrorProducer {
  private readonly api: GitHubWebhookApiClient;
  private readonly options: {
    realmId: string;
    appInstallationId: string;
    repository: string;
    handoffKeyId: string;
    handoffSecret: string;
    ingest: GitHubMirrorIngest;
    nowMilliseconds: () => number;
    handoffMaxLifetimeMs: number;
    handoffClockSkewMs: number;
  };

  constructor(input: { api: GitHubApiClientOptions; realmId: string; appInstallationId: string; repository: string; handoffKeyId: string; handoffSecret: string; ingest: GitHubMirrorIngest; nowMilliseconds?: () => number; handoffMaxLifetimeMs?: number; handoffClockSkewMs?: number }) {
    this.api = new GitHubWebhookApiClient(input.api);
    const handoffMaxLifetimeMs = input.handoffMaxLifetimeMs ?? MIRROR_HANDOFF_TTL_MS;
    const handoffClockSkewMs = input.handoffClockSkewMs ?? MIRROR_HANDOFF_CLOCK_SKEW_MS;
    if (!Number.isSafeInteger(handoffMaxLifetimeMs) || handoffMaxLifetimeMs <= 0 || !Number.isSafeInteger(handoffClockSkewMs) || handoffClockSkewMs < 0) throw new GitHubMirrorProducerError({ code: "configuration_invalid", message: "The GitHub producer requires valid Mirror handoff lifetime and clock-skew tripwires.", recoveryAction: "configure measured Mirror handoff lifetime and clock-skew values before accepting webhook deliveries", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; handoffTripwires=invalid; credentialMaterialStored=false` });
    this.options = { realmId: requiredString(input.realmId, "realmId"), appInstallationId: requiredString(input.appInstallationId, "appInstallationId"), repository: requiredString(input.repository, "repository"), handoffKeyId: requiredString(input.handoffKeyId, "handoffKeyId"), handoffSecret: requiredString(input.handoffSecret, "handoffSecret"), ingest: input.ingest, nowMilliseconds: input.nowMilliseconds ?? (() => Date.now()), handoffMaxLifetimeMs, handoffClockSkewMs };
  }

  async process(input: { envelope: unknown; context: unknown }): Promise<GitHubMirrorProducerResult> {
    let envelope: GitHubWebhookIngressEnvelope | undefined;
    try {
      envelope = parseEnvelope(input.envelope);
      const context = parseGitHubMirrorProducerContext(input.context);
      if (envelope.realmId !== this.options.realmId || envelope.installationId !== this.options.appInstallationId || envelope.repository !== this.options.repository || context.realmId !== this.options.realmId || context.installationId !== this.options.appInstallationId || context.remoteRepository !== this.options.repository) throw new GitHubMirrorProducerError({ code: "binding_mismatch", message: "The queued webhook, producer, and Realm Mirror do not share one provider binding.", recoveryAction: "reconcile the GitHub App installation, repository, producer configuration, and Realm Mirror before retrying", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; binding=mismatch; delivery=${envelope.deliveryId}; providerMutation=false; credentialMaterialStored=false` });
      if (await digest(envelope.body) !== envelope.bodyDigest) throw new GitHubMirrorProducerError({ code: "envelope_digest_mismatch", message: "The queued webhook body digest does not match its signed envelope metadata.", recoveryAction: "retain the original delivery and repair Queue serialization before retrying", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; bodyDigest=mismatch; providerMutation=false; credentialMaterialStored=false` });
      const payload = payloadObject(envelope.body);
      if (payload.repository === null || typeof payload.repository !== "object" || Array.isArray(payload.repository) || (payload.repository as JsonObject).full_name !== envelope.repository || payload.installation === null || typeof payload.installation !== "object" || Array.isArray(payload.installation) || String((payload.installation as JsonObject).id ?? "") !== envelope.installationId) throw new GitHubMirrorProducerError({ code: "payload_binding_mismatch", message: "The webhook body identity does not match its Queue envelope.", recoveryAction: "request a fresh GitHub redelivery and preserve the exact signed body", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; payloadBinding=mismatch; providerMutation=false; credentialMaterialStored=false` });
      const mappedRemoteRefs = context.refMappings.map((mapping) => mapping.remoteRef);
      const observedRefs: GitRef[] = [];
      for (const remoteRef of mappedRemoteRefs) {
        try {
          const observed = await this.api.ref(remoteRef);
          observedRefs.push({ name: refNameForRemote(remoteRef), oid: observed.oid });
        } catch (error) {
          if (error instanceof GitHubMirrorProducerError && error.code === "provider_http_404") continue;
          throw error;
        }
      }
      const remoteRefs = remoteRefSet(context, observedRefs);
      const eventType = envelope.action ? `${envelope.event}.${envelope.action}` : envelope.event;
      let proposalKey: string;
      let symbolicRef: string;
      let commitOid: string;
      let baseCommitOid: string;
      let ancestryComparison: "identical" | "ahead" | "behind" | "diverged";
      let externalProposal: JsonObject;
      let commitObservation: { oid: string; treeOid: string; author: { name: string; email?: string } } | undefined;
      if (envelope.event === "pull_request") {
        const number = typeof payload.number === "number" && Number.isSafeInteger(payload.number) ? payload.number : Number(payload.number);
        if (!Number.isSafeInteger(number) || number <= 0) throw new GitHubMirrorProducerError({ code: "pull_request_invalid", message: "The webhook pull-request number is invalid.", recoveryAction: "ask GitHub to redeliver the pull-request event with its numeric identity", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; pullRequest=invalid; providerMutation=false; credentialMaterialStored=false` });
        const pullRequest = await this.api.pullRequest(number);
        proposalKey = String(number);
        symbolicRef = `refs/heads/${pullRequest.headRef}`;
        commitOid = pullRequest.headCommit;
        baseCommitOid = pullRequest.baseCommit;
        commitObservation = await this.api.commit(commitOid);
        ancestryComparison = await this.api.compare(baseCommitOid, commitOid);
        if (ancestryComparison !== "ahead" && ancestryComparison !== "identical") throw new GitHubMirrorProducerError({ code: "commit_ancestry_invalid", message: "The pull-request head is not a descendant of its provider base.", recoveryAction: "rebase or explicitly reconcile the pull request before accepting its webhook delivery", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; base=${baseCommitOid}; head=${commitOid}; comparison=${ancestryComparison}; providerMutation=false; credentialMaterialStored=false` });
        externalProposal = { provider: "github", installationId: envelope.installationId, sourceIdentity: sourceIdentity(envelope.installationId), remoteRepository: envelope.repository, proposalKind: "pull-request", proposalKey, latestHeadCommit: commitOid, baseProjectRevisionId: context.canonicalProjectRevisionId, projectViewId: context.projectViewId, disclosure: context.disclosure, sourceSpaceSnapshots: { [context.sourceSpaceId]: commitOid }, status: pullRequest.state === "open" ? "open" : pullRequest.merged ? "merged" : "closed", remoteRef: symbolicRef, baseRef: `refs/heads/${pullRequest.baseRef}`, baseCommit: baseCommitOid, remoteAuthor: { ...commitObservation.author }, receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; proposal=pull-request; providerObservation=verified; credentialMaterialStored=false` };
      } else {
        const refValue = typeof payload.ref === "string" ? payload.ref.trim() : "";
        if (!refValue || !context.refMappings.some((mapping) => mapping.remoteRef === refValue)) throw new GitHubMirrorProducerError({ code: "ref_unmapped", message: "The GitHub push delivery does not name a configured Mirror ref.", recoveryAction: "configure the exact mapped remote ref or ignore the provider delivery", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; ref=${refValue || "missing"}; providerMutation=false; credentialMaterialStored=false` });
        if (payload.deleted === true || payload.forced === true) throw new GitHubMirrorProducerError({ code: payload.deleted === true ? "ref_deleted" : "force_push_detected", message: payload.deleted === true ? "The GitHub push deleted a mapped ref." : "The GitHub push was marked as a forced rewrite.", recoveryAction: "create an explicit Mirror reconciliation choice before accepting the provider rewrite", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; ref=${refValue}; reconciliation=required; providerMutation=false; credentialMaterialStored=false` });
        const remoteRef = remoteRefs.find((ref) => ref.name === refValue);
        if (!remoteRef) throw new GitHubMirrorProducerError({ code: "ref_observation_missing", message: "The mapped GitHub push ref was not present during provider reinspection.", recoveryAction: "retry the same delivery after GitHub ref state is readable", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; ref=${refValue}; providerObservation=missing; providerMutation=false; credentialMaterialStored=false` });
        commitObservation = await this.api.commit(remoteRef.oid);
        proposalKey = `ref:${refValue}`;
        symbolicRef = refValue;
        commitOid = remoteRef.oid;
        const canonicalRef = canonicalRefFor(context, refValue);
        if (!canonicalRef) throw new GitHubMirrorProducerError({ code: "canonical_ref_missing", message: "The Realm Mirror context has no canonical ref for the mapped provider ref.", recoveryAction: "reconcile the Mirror's canonical ref mapping before retrying", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; ref=${refValue}; canonical=missing; providerMutation=false; credentialMaterialStored=false` });
        baseCommitOid = canonicalRef.oid;
        ancestryComparison = await this.api.compare(baseCommitOid, commitOid);
        if (ancestryComparison !== "ahead" && ancestryComparison !== "identical") throw new GitHubMirrorProducerError({ code: "commit_ancestry_invalid", message: "The mapped GitHub ref is not a descendant of the canonical Mirror base.", recoveryAction: "rebase or explicitly reconcile the provider ref before accepting its webhook delivery", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; base=${baseCommitOid}; head=${commitOid}; comparison=${ancestryComparison}; providerMutation=false; credentialMaterialStored=false` });
        externalProposal = { provider: "github", installationId: envelope.installationId, sourceIdentity: sourceIdentity(envelope.installationId), remoteRepository: envelope.repository, proposalKind: "ref", proposalKey, remoteRef: refValue, baseRef: refValue, baseCommit: baseCommitOid, latestHeadCommit: commitOid, baseProjectRevisionId: context.canonicalProjectRevisionId, projectViewId: context.projectViewId, disclosure: context.disclosure, sourceSpaceSnapshots: { [context.sourceSpaceId]: commitOid }, status: "open", remoteAuthor: { ...commitObservation.author }, receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; proposal=ref; providerObservation=verified; credentialMaterialStored=false` };
      }
      if (!commitObservation) throw new GitHubMirrorProducerError({ code: "commit_observation_missing", message: "The provider producer did not retain the exact commit observation used for the handoff.", recoveryAction: "reinspect the provider commit and retry the same delivery", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; commitObservation=missing; providerMutation=false; credentialMaterialStored=false` });
      const observedAt = new Date(this.options.nowMilliseconds()).toISOString();
      const observationClaims: Omit<MirrorRepositoryObservation, "manifestDigest"> = { protocol: "anyam.mirror-repository-observation/v1", repositoryId: context.repositoryId, sourceSpaceId: context.sourceSpaceId, mirrorId: context.mirrorId, proposalKey, deliveryId: envelope.deliveryId, provider: "github", remoteRepository: context.remoteRepository, projectViewId: context.projectViewId, objectFormat: "sha1", symbolicRef, commitOid, treeOid: commitObservation.treeOid, baseCommitOid, ancestryVerified: true, observedAt, receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; providerObservation=verified; comparison=${ancestryComparison}; credentialMaterialStored=false` };
      const observation: MirrorRepositoryObservation = { ...observationClaims, manifestDigest: await digest(stableJson(observationClaims)) };
      const command: JsonObject = { protocol: "anyam.authority-command/v1", command: "mirror.sync", idempotencyKey: `mirror:github-app:${context.mirrorId}:${envelope.deliveryId}`, payload: { mirrorId: context.mirrorId, canonicalProjectRevisionId: context.canonicalProjectRevisionId, canonicalRefs: context.canonicalRefs, expectedRemoteGeneration: context.remoteGeneration, remoteGeneration: await digest({ repository: context.remoteRepository, refs: remoteRefs }), remoteRefs, operationId: `mirror-operation:github-app:${envelope.deliveryId}`, checkpointId: `mirror-checkpoint:github-app:${envelope.deliveryId}`, operationKind: "inbound", operationState: "succeeded", mirrorState: "lagging", inboundChangeIds: [], completedInboundChangeIds: [], pendingInboundChangeIds: context.pendingInboundChangeIds, delivery: { provider: "github", installationId: envelope.installationId, sourceIdentity: sourceIdentity(envelope.installationId), remoteRepository: context.remoteRepository, deliveryId: envelope.deliveryId, eventType, proposalKey }, externalProposal, mirrorRepositoryObservations: { [context.sourceSpaceId]: observation }, receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; providerReinspection=verified; observationDigest=${observation.manifestDigest}; credentialMaterialStored=false` } };
      const now = this.options.nowMilliseconds();
      if (!Number.isSafeInteger(now)) throw new GitHubMirrorProducerError({ code: "clock_invalid", message: "The producer clock did not return a safe integer.", recoveryAction: "repair the producer runtime clock and retry the same delivery", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; clock=invalid; providerMutation=false; credentialMaterialStored=false` });
      const issuedAt = new Date(now).toISOString();
      const expiresAt = new Date(now + this.options.handoffMaxLifetimeMs).toISOString();
      const handoff = await signGitHubMirrorHandoff({ command, keyId: this.options.handoffKeyId, secret: this.options.handoffSecret, nonce: `nonce:github-app:${await digest([context.mirrorId, envelope.deliveryId, envelope.bodyDigest])}`, realmId: context.realmId, installationId: context.installationId, issuer: `github-app:${context.installationId}`, provider: "github", remoteRepository: context.remoteRepository, mirrorId: context.mirrorId, deliveryId: envelope.deliveryId, proposalKey, issuedAt, expiresAt, now, maxLifetimeMs: this.options.handoffMaxLifetimeMs, clockSkewMs: this.options.handoffClockSkewMs });
      const ingested = await this.options.ingest(handoff);
      if (ingested.status === "succeeded") return { protocol: GITHUB_MIRROR_PRODUCER_PROTOCOL, status: "succeeded", deliveryId: envelope.deliveryId, ...(ingested.duplicate ? { duplicate: true } : {}), receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; handoff=signed; ingestion=succeeded; ${GITHUB_MIRROR_HANDOFF_SIZING_RECEIPT}; providerCredential=jit-memory-only; credentialMaterialStored=false` };
      throw new GitHubMirrorProducerError({ code: "ingestion_blocked", message: "The Realm rejected the signed Mirror handoff.", recoveryAction: ingested.recoveryAction ?? "inspect the Mirror checkpoint and retry the same signed delivery only after reconciling Authority state", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${envelope.deliveryId}; handoff=signed; ingestion=blocked; ${ingested.receipt}; credentialMaterialStored=false` });
    } catch (error) {
      const deliveryId = envelope?.deliveryId ?? "unknown";
      const typed = error instanceof GitHubMirrorProducerError ? error : new GitHubMirrorProducerError({ code: "producer_exception", message: "GitHub Mirror producer failed before accepting the delivery.", recoveryAction: "inspect the bounded producer receipt and retry the same Queue delivery", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; delivery=${deliveryId}; exception=${error instanceof Error ? error.name : "unknown"}; providerMutation=false; credentialMaterialStored=false` });
      return { protocol: GITHUB_MIRROR_PRODUCER_PROTOCOL, status: "blocked", deliveryId, code: typed.code, receipt: typed.receipt, recoveryAction: typed.recoveryAction };
    }
  }
}

export function githubMirrorProducerContextDigest(context: GitHubMirrorProducerContext): Promise<string> {
  return digest(context);
}
