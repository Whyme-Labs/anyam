import { createHash, createHmac } from "node:crypto";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

/** Independent synthetic signer: intentionally permits malformed metadata so
 * verification tests exercise schema checks even with a matching HMAC. */
export function signArtifactRecoveryFixture(value: Record<string, unknown>, secret: string): Record<string, unknown> {
  const unsigned = { ...value };
  delete unsigned.signature; delete unsigned.bundleDigest;
  const message = canonical(unsigned);
  return { ...unsigned, bundleDigest: `sha256:${createHash("sha256").update(message).digest("hex")}`, signature: createHmac("sha256", secret).update(message).digest("base64url") };
}
