/** Encode random bytes without depending on Node Buffer's overloaded methods. */
export function base64Url(bytes: Uint8Array): string {
  if (typeof globalThis.btoa !== "function") {
    throw new Error("base64url encoding requires a btoa implementation");
  }

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
