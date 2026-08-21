export const PROMOTION_NONCE_PROTOCOL = "anyam.promotion-executor-nonce/v1" as const;

export type PromotionNonceStorage = {
  list(options: { prefix: string }): Promise<Map<string, { expiresAt?: string }>>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<{ expiresAt?: string } | null>;
  put(key: string, value: { protocol: typeof PROMOTION_NONCE_PROTOCOL; expiresAt: string; claimedAt: string }): Promise<void>;
};

export async function claimPromotionNonce(input: { nonce: string; expiresAt: string; storage: PromotionNonceStorage; now?: () => string }): Promise<"claimed" | "duplicate"> {
  const now = input.now ?? (() => new Date().toISOString());
  const nonce = input.nonce.trim();
  const expiresAt = input.expiresAt.trim();
  if (!nonce || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(now())) throw new Error("nonce=non-empty; expiresAt=future-required");
  for (const [key, value] of await input.storage.list({ prefix: "nonce:" })) {
    if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.parse(now())) await input.storage.delete(key);
  }
  const key = `nonce:${nonce}`;
  if (await input.storage.get(key)) return "duplicate";
  await input.storage.put(key, { protocol: PROMOTION_NONCE_PROTOCOL, expiresAt, claimedAt: now() });
  return "claimed";
}
