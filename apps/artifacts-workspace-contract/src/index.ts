import { ArtifactsWorkspaceAdapter, type ArtifactsWorkspaceOptions } from "../../../src/cloudflare/artifacts-workspace.ts";
import { ArtifactsWorkspaceQualification, type ArtifactsQualificationOptions } from "../../../src/cloudflare/artifacts-workspace-qualification.ts";

export type Env = {
  ARTIFACTS: Artifacts;
  ARTIFACTS_ACCOUNT_ID: string;
  ARTIFACTS_NAMESPACE: string;
};

/** Compile-time conformance to the official Workers binding, with the Realm
 * authorization callback supplied by a trusted caller. No HTTP token route. */
export function createArtifactsWorkspaceControl(env: Env, authorize: ArtifactsWorkspaceOptions["authorize"], store?: ArtifactsWorkspaceOptions["store"]): ArtifactsWorkspaceAdapter {
  return new ArtifactsWorkspaceAdapter({ artifacts: env.ARTIFACTS, accountId: env.ARTIFACTS_ACCOUNT_ID, namespace: env.ARTIFACTS_NAMESPACE, authorize, ...(store ? { store } : {}) });
}

/** Trusted one-shot entry point. The caller supplies current authorization,
 * durable stores and any separately qualified expected-UUID deletion port. */
export function createArtifactsWorkspaceQualification(env: Env, dependencies: Omit<ArtifactsQualificationOptions, "artifacts" | "accountId" | "namespace">): ArtifactsWorkspaceQualification {
  return new ArtifactsWorkspaceQualification({ ...dependencies, artifacts: env.ARTIFACTS, accountId: env.ARTIFACTS_ACCOUNT_ID, namespace: env.ARTIFACTS_NAMESPACE });
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({ status: "blocked", code: "artifacts.trusted_caller_required", liveQualified: false }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
