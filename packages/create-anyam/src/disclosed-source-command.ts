import { parseActionArtifactOutputContract, actionArtifactOutputInputSchema, type ActionArtifactOutputContract } from "./action-artifact-output.js";
/** Public selector contracts. Selectors express intent; they never grant authority. */
export const DISCLOSED_SOURCE_FIELDS = {
  "workspace.create": ["projectId", "projectViewRevisionId", "sourceSpaceIds", "mounts", "classification"],
  "change.create": ["projectId", "workspaceId", "baseProjectViewRevisionId", "intentId"],
  "revision.publish": ["projectId", "workspaceId", "changeId", "baseProjectViewRevisionId", "sourceSpaceSnapshots", "declaredEffects", "kind", "expectedSymbolicRef"],
  "run.request": ["projectId", "workspaceId", "changeRevisionId", "projectViewRevisionId", "actionId", "actionContractDigest", "artifactOutputContract", "verifierId", "verifierContractDigest", "inputDigests", "effectDigests", "dependencyDigest", "toolchainDigest", "environmentDigest"],
} as const;
export type DisclosedSourceOperation = keyof typeof DISCLOSED_SOURCE_FIELDS;
export type DisclosedSourcePayloads = {
  "workspace.create": { projectId: string; projectViewRevisionId: string; sourceSpaceIds?: string[]; mounts?: string[]; classification?: string };
  "change.create": { projectId: string; workspaceId: string; baseProjectViewRevisionId: string; intentId: string };
  "revision.publish": { projectId: string; workspaceId: string; changeId: string; baseProjectViewRevisionId: string; sourceSpaceSnapshots: Record<string, string>; declaredEffects?: string[]; kind?: string; expectedSymbolicRef?: string };
  "run.request": { projectId: string; workspaceId: string; changeRevisionId: string; projectViewRevisionId: string; actionId: string; actionContractDigest: string; artifactOutputContract?: ActionArtifactOutputContract; inputDigests: string[]; verifierId?: string; verifierContractDigest?: string; effectDigests?: string[]; dependencyDigest?: string; toolchainDigest?: string; environmentDigest?: string };
};
const required: Record<DisclosedSourceOperation, readonly string[]> = {
  "workspace.create": ["projectId", "projectViewRevisionId"],
  "change.create": ["projectId", "workspaceId", "baseProjectViewRevisionId", "intentId"],
  "revision.publish": ["projectId", "workspaceId", "changeId", "baseProjectViewRevisionId", "sourceSpaceSnapshots"],
  "run.request": ["projectId", "workspaceId", "changeRevisionId", "projectViewRevisionId", "actionId", "actionContractDigest", "inputDigests"],
};
const arrays = new Set(["sourceSpaceIds", "mounts", "declaredEffects", "inputDigests", "effectDigests"]);
export const DISCLOSED_SOURCE_TOOLS = {
  "workspace.create_from_view": { command: "workspace.create", scope: "workspace.write" },
  "change.create_from_view": { command: "change.create", scope: "change.write" },
  "change.publish_revision_from_view": { command: "revision.publish", scope: "change.write" },
  "run.request_from_view": { command: "run.request", scope: "run.invoke" },
} as const;
export function disclosedSourceInputSchema(command: DisclosedSourceOperation) {
  const properties = Object.fromEntries(DISCLOSED_SOURCE_FIELDS[command].map(field => [field, arrays.has(field)
    ? { type: "array", items: { type: "string", minLength: 1 }, ...(field === "sourceSpaceIds" ? { minItems: 1, uniqueItems: true } : {}) }
    : field === "artifactOutputContract" ? actionArtifactOutputInputSchema
    : field === "sourceSpaceSnapshots" ? { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1 } }
    : { type: "string", minLength: 1 }]));
  return { type: "object", additionalProperties: false, required: ["idempotencyKey", ...required[command]], properties: { idempotencyKey: { type: "string", minLength: 1 }, ...properties } };
}
export function parseDisclosedSourcePayload<C extends DisclosedSourceOperation>(command: C, payload: unknown): DisclosedSourcePayloads[C] {
  const invalid = (): never => { throw new Error("disclosed_source_input_invalid; use only the documented selector fields"); };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalid();
  const value = payload as Record<string, unknown>;
  const fields: readonly string[] = DISCLOSED_SOURCE_FIELDS[command];
  if (Object.keys(value).some(field => !fields.includes(field)) || required[command].some(field => value[field] === undefined)) invalid();
  const text = (entry: unknown) => typeof entry === "string" && entry.trim().length > 0;
  for (const [field, entry] of Object.entries(value)) {
    if (arrays.has(field)) {
      if (!Array.isArray(entry) || entry.some(item => !text(item)) || (field === "sourceSpaceIds" && (!entry.length || new Set(entry).size !== entry.length))) invalid();
    } else if (field === "artifactOutputContract") {
      parseActionArtifactOutputContract(entry);
    } else if (field === "sourceSpaceSnapshots") {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !Object.keys(entry).length || Object.entries(entry).some(([key, item]) => !text(key) || !text(item))) invalid();
    } else if (!text(entry)) invalid();
  }
  return JSON.parse(JSON.stringify(value)) as DisclosedSourcePayloads[C];
}
