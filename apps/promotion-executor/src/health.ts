import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, isCredentialFree } from "../../../src/security/credential-material.ts";

export const PROMOTION_EXECUTOR_HEALTH_PROTOCOL = "anyam.promotion-executor-health/v1" as const;

export type PromotionExecutorHealthDecision = {
  status: "healthy" | "blocked";
  httpStatus: 200 | 404 | 503;
  body: Record<string, unknown>;
};

function credentialFreeReceipt(value: string): boolean {
  return isCredentialFree(value);
}

export function promotionExecutorHealth(input: { authorized: boolean; configuration: "ready" | "invalid"; qualificationReceipt?: string }): PromotionExecutorHealthDecision {
  if (!input.authorized) return { status: "blocked", httpStatus: 404, body: { protocol: PROMOTION_EXECUTOR_HEALTH_PROTOCOL, status: "blocked", code: "health_internal_only", recoveryAction: "invoke health through the bound operator/service path with the configured health credential", receipt: "executor=health; authorization=not-observed; providerProbe=not-performed; credentialMaterialStored=false" } };
  if (input.configuration === "invalid") return { status: "blocked", httpStatus: 503, body: { protocol: PROMOTION_EXECUTOR_HEALTH_PROTOCOL, status: "blocked", code: "executor_configuration_invalid", recoveryAction: "configure the customer-owned executor bindings and secrets before binding the Realm service", receipt: "executor=config-invalid; providerAuthorization=not-probed; providerInvocation=false; credentialMaterialStored=false" } };
  const receipt = input.qualificationReceipt?.trim();
  if (!receipt || !credentialFreeReceipt(receipt)) return { status: "blocked", httpStatus: 503, body: { protocol: PROMOTION_EXECUTOR_HEALTH_PROTOCOL, status: "blocked", code: "provider_qualification_receipt_missing", recoveryAction: "run the explicit installation/qualification provider authorization probe and bind its credential-free receipt before accepting executor health", receipt: `executor=health; providerProbe=not-performed; qualificationReceipt=missing-or-unsafe; credentialScanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; credentialMaterialStored=false; metadata=redacted` } };
  return { status: "healthy", httpStatus: 200, body: { protocol: PROMOTION_EXECUTOR_HEALTH_PROTOCOL, status: "healthy", handoff: "signed-and-replay-protected", providerCredentials: "brokered-only", providerAuthorization: "qualification-receipt-present", receipt: `executor=health; providerProbe=not-performed; qualificationReceipt=${receipt}; credentialScanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; credentialMaterialStored=false; metadata=redacted`, canonicalWrite: false, credentialMaterialStored: false } };
}
