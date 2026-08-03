/// <reference types="@cloudflare/workers-types" />

import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";

import {
  handleCustomerRealmRequest,
  type CustomerRealmWorkerEnv,
} from "../../../src/cloudflare/realm-worker.ts";

export type Env = CustomerRealmWorkerEnv;

/**
 * The coordinator is exported so Wrangler can provision the SQLite-backed
 * Durable Object namespace.  P2-0 intentionally exposes no authority-bearing
 * route; Project and Realm transitions arrive in later bounded tickets.
 */
export class AnyamRealmCoordinator extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    return new Response(JSON.stringify({
      protocol: "anyam.customer-realm-coordinator/v1",
      status: "blocked",
      recoveryAction: "Use the credential-free Worker health surface until the coordinator contract is qualified.",
      receipt: "authorityRoutes=not-enabled; credentialFree=true",
    }), {
      status: 404,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
}

/**
 * The Workflow binding is present to make the orchestration boundary explicit;
 * this ticket does not start or mutate a Workflow instance.
 */
export class AnyamRealmWorkflow extends WorkflowEntrypoint<Env, { readonly operation: "foundation-probe" }> {
  override async run(): Promise<{ readonly status: "blocked"; readonly recoveryAction: string; readonly receipt: string }> {
    return {
      status: "blocked",
      recoveryAction: "Implement a bounded Run/Workflow operation before invoking this binding.",
      receipt: "workflowAuthority=not-enabled; credentialFree=true",
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleCustomerRealmRequest(request, env);
  },
};
