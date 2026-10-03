/** Portable Action declaration. A declared type never grants release or Target authority. */
export type ActionArtifactOutputContract = {
  protocol: "anyam.action-artifact-outputs/v1";
  outputs: readonly { path: string; type: string }[];
};

export class ActionArtifactOutputError extends Error {
  constructor(readonly reason: string) {
    super(`Action Artifact output contract is invalid: ${reason}.`);
    this.name = "ActionArtifactOutputError";
  }
}
function invalid(reason: string): never { throw new ActionArtifactOutputError(reason); }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

export function canonicalArtifactOutputPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    && !/[\\:\u0000-\u001f\u007f]/u.test(value)
    && value.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git");
}

/** Validate and detach at every untrusted boundary; output paths are Action-relative. */
export function parseActionArtifactOutputContract(value: unknown, declaredPaths?: readonly string[]): ActionArtifactOutputContract {
  if (!record(value) || !exactKeys(value, ["protocol", "outputs"]) || value.protocol !== "anyam.action-artifact-outputs/v1" || !Array.isArray(value.outputs) || !value.outputs.length) invalid("expected versioned non-empty outputs");
  const seen = new Set<string>();
  const outputs = (value.outputs as unknown[]).map(entry => {
    if (!record(entry) || !exactKeys(entry, ["path", "type"]) || !canonicalArtifactOutputPath(entry.path) || typeof entry.type !== "string" || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(entry.type)) invalid("expected canonical path and Artifact type");
    const path = entry.path as string;
    if (seen.has(path)) invalid("duplicate output path");
    if (declaredPaths && !declaredPaths.includes(path)) invalid("typed path is outside Action outputs");
    seen.add(path);
    return { path, type: entry.type as string };
  });
  return { protocol: "anyam.action-artifact-outputs/v1", outputs };
}

export const actionArtifactOutputInputSchema = {
  type: "object", additionalProperties: false, required: ["protocol", "outputs"],
  properties: {
    protocol: { const: "anyam.action-artifact-outputs/v1" },
    outputs: {
      type: "array", minItems: 1,
      items: {
        type: "object", additionalProperties: false, required: ["path", "type"],
        properties: { path: { type: "string", minLength: 1 }, type: { type: "string", pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$" } },
      },
    },
  },
} as const;

/** Bind each declared Artifact to its signed normalized Action digest. Storage
 * locations remain separate, and the Realm subsequently hashes the actual bytes. */
export function validateActionArtifactOutputs(input: {
  contract: ActionArtifactOutputContract | undefined;
  declaredPaths: readonly string[];
  status: string;
  outputDigests: readonly string[];
  outputs: readonly { kind: string; outputPath?: string; digest: string }[];
}): void {
  if (!input.contract) {
    if (input.outputs.some(output => output.outputPath !== undefined)) invalid("logical output path requires a declared contract");
    return;
  }
  const contract = parseActionArtifactOutputContract(input.contract, input.declaredPaths);
  const digests = new Map<string, string>();
  for (const entry of input.outputDigests) {
    const separator = entry.lastIndexOf("=");
    const path = entry.slice(0, separator); const digest = entry.slice(separator + 1);
    if (separator < 1 || !input.declaredPaths.includes(path) || digests.has(path) || !/^sha256:[0-9a-f]{64}$/u.test(digest)) invalid("normalized output digest is undeclared, duplicated or malformed");
    digests.set(path, digest);
  }
  const seen = new Set<string>();
  for (const output of input.outputs) {
    if (output.kind !== "artifact") {
      if (output.outputPath !== undefined) invalid("logical output path is only valid on Artifacts");
      continue;
    }
    const declaration = contract.outputs.find(entry => entry.path === output.outputPath);
    if (!declaration || seen.has(declaration.path)) invalid("Artifact path is missing, undeclared or duplicated");
    if (digests.get(declaration.path) !== output.digest) invalid("Artifact digest differs from normalized Action output");
    seen.add(declaration.path);
  }
  if (input.status === "succeeded" && seen.size !== contract.outputs.length) invalid("successful Result is missing declared Artifacts");
}
