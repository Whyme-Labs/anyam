/**
 * The portable identity kernel currently uses the synchronous Node crypto
 * surface for opaque credential digests and IDs. Wrangler's `nodejs_compat`
 * runtime supplies this module in the Worker; keep the edge package's type
 * surface narrow instead of importing all Node globals, which conflict with
 * Cloudflare's Worker declarations.
 */
declare module "node:crypto" {
  interface Hash {
    update(value: string): Hash;
    digest(encoding: "hex"): string;
  }

  interface RandomBytes {
    toString(encoding: "base64url"): string;
  }

  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): RandomBytes;
  export function randomUUID(): string;
}
