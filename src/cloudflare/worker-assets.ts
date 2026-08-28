import type { Artifact } from "../kernel/contracts.ts";
import type { WorkerTarget } from "../delivery/promotion.ts";
import type { WorkerReleaseManifest } from "./worker-release-manifest.ts";
import {
  CLOUDFLARE_WORKER_DEPLOYMENT_AUDIENCE,
  type CloudflareWorkerApiResponse,
  type CloudflareWorkerApiTransport,
  type CloudflareWorkerCredentialBroker,
} from "./worker-target.ts";
import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, scanCredentialMaterial } from "../security/credential-material.ts";

type AssetManifestEntry = { hash: string; size: number };
type AssetUploadSession = { buckets?: readonly (readonly string[])[]; jwt?: string };
type AssetUploadCompletion = { jwt?: string };

export type CloudflareWorkerStaticAssetUploaderConfig = {
  accountId: string;
  scriptName: string;
  transport: CloudflareWorkerApiTransport;
  credentialBroker: CloudflareWorkerCredentialBroker;
  /** Converts a sealed Artifact path into the provider asset URL path. */
  assetPathForArtifact?: (artifact: Artifact) => string;
};

export type CloudflareWorkerStaticAssetUploaderInput = {
  manifest: WorkerReleaseManifest;
  artifacts: readonly Artifact[];
  readArtifact: (artifact: Artifact) => Promise<Uint8Array>;
  operation: "preview" | "apply";
  target: WorkerTarget;
};

export type CloudflareWorkerStaticAssetUploader = (input: CloudflareWorkerStaticAssetUploaderInput) => Promise<{ jwt: string; receipt: string }>;

function safeProviderErrors<T>(response: CloudflareWorkerApiResponse<T>): string {
  return [...response.errors, ...response.messages]
    .map((error) => {
      const finding = scanCredentialMaterial(error.message, "providerError");
      const message = finding ? `credential-material-redacted; scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}` : error.message;
      return `${error.code ?? "unknown"}:${message}`;
    })
    .join(" | ") || `http-${response.status}`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function providerAssetHash(bytes: Uint8Array, path: string): Promise<string> {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
  const encoded = base64(bytes);
  const payload = new TextEncoder().encode(`${encoded}${extension}`);
  const hash = await crypto.subtle.digest("SHA-256", payload);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function defaultAssetPath(artifact: Artifact): string {
  const outputPath = artifact.outputPath?.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!outputPath) throw new Error(`Asset Artifact ${artifact.id} has no output path`);
  const path = outputPath.replace(/^dist\/assets\//u, "").replace(/^assets\//u, "");
  if (!path || path.startsWith("/") || path.split("/").some((segment) => segment === ".." || segment.toLocaleLowerCase() === ".git")) throw new Error(`Asset Artifact ${artifact.id} has an unsafe provider path`);
  return `/${path}`;
}

function assetContentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLocaleLowerCase();
  const types: Readonly<Record<string, string>> = {
    css: "text/css; charset=utf-8",
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    json: "application/json",
    map: "application/json",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    wasm: "application/wasm",
  };
  return types[extension] ?? "application/null";
}

function responseResult<T>(response: CloudflareWorkerApiResponse<T>, operation: string): T {
  if (response.ok && response.result !== undefined) return response.result;
  throw new Error(`Cloudflare Worker static asset ${operation} failed (HTTP ${response.status}): ${safeProviderErrors(response)}`);
}

/**
 * Customer-owned static asset uploader for the Worker Version adapter.
 * Account credentials are used only to create the manifest session; the
 * returned short-lived JWT is used only for the immediate content batches.
 */
export function createCloudflareWorkerStaticAssetUploader(config: CloudflareWorkerStaticAssetUploaderConfig): CloudflareWorkerStaticAssetUploader {
  const pathForArtifact = config.assetPathForArtifact ?? defaultAssetPath;
  return async (input) => {
    if (!input.manifest.staticAssets) throw new Error("Static asset uploader requires manifest.staticAssets");
    const entries = new Map<string, { artifact: Artifact; bytes: Uint8Array; hash: string }>();
    for (const artifact of input.artifacts) {
      const path = pathForArtifact(artifact);
      if (entries.has(path)) throw new Error(`Static asset path ${path} is duplicated in the sealed Release`);
      const bytes = await input.readArtifact(artifact);
      const hash = await providerAssetHash(bytes, path);
      entries.set(path, { artifact, bytes, hash });
    }
    const manifest: Record<string, AssetManifestEntry> = {};
    for (const [path, value] of entries) manifest[path] = { hash: value.hash, size: value.bytes.byteLength };
    const credential = await config.credentialBroker.issue({ accountId: config.accountId, scriptName: config.scriptName, targetId: input.target.id, operation: "version-upload", audience: CLOUDFLARE_WORKER_DEPLOYMENT_AUDIENCE });
    if (!credential.token || credential.audience !== CLOUDFLARE_WORKER_DEPLOYMENT_AUDIENCE || credential.providerAuthorization !== "observed") throw new Error("Static asset uploader received an incomplete provider credential observation");
    const session = responseResult(await config.transport.request<AssetUploadSession>({
      method: "POST",
      path: `/accounts/${encodeURIComponent(config.accountId)}/workers/scripts/${encodeURIComponent(config.scriptName)}/assets-upload-session`,
      token: credential.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest }),
    }), "asset-session");
    if (!session.jwt) throw new Error("Cloudflare static asset session did not return an upload JWT");
    let completionJwt = session.jwt;
    const byHash = new Map([...entries.values()].map((value) => [value.hash, value]));
    for (const bucket of session.buckets ?? []) {
      const form = new FormData();
      for (const hash of bucket) {
        const value = byHash.get(hash);
        if (!value) throw new Error(`Cloudflare static asset session requested unknown hash ${hash}`);
        form.append(hash, new File([base64(value.bytes)], hash, { type: assetContentType(pathForArtifact(value.artifact)) }), hash);
      }
      const upload = responseResult(await config.transport.request<AssetUploadCompletion>({ method: "POST", path: `/accounts/${encodeURIComponent(config.accountId)}/workers/assets/upload?base64=true`, token: session.jwt, body: form }), "asset-content");
      if (!upload.jwt) throw new Error("Cloudflare static asset content upload did not return a completion JWT");
      completionJwt = upload.jwt;
    }
    return {
      jwt: completionJwt,
      receipt: `provider=cloudflare-workers; operation=static-assets; target=${input.target.id}; assets=${entries.size}; buckets=${session.buckets?.length ?? 0}; completionJwt=issued; credentialMaterialStored=false`,
    };
  };
}
