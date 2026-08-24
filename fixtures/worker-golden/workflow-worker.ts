import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export class GoldenWorkflow extends WorkflowEntrypoint<Env, Record<string, unknown>> {
  override async run(event: Readonly<WorkflowEvent<Record<string, unknown>>>, step: WorkflowStep): Promise<Record<string, unknown>> {
    return step.do("golden qualification step", async () => ({
      status: "healthy",
      workflow: event.instanceId,
    }));
  }
}

interface Env {
  GOLDEN_PREVIEW_WORKFLOW: Workflow;
  GOLDEN_STAGING_WORKFLOW: Workflow;
  GOLDEN_PRODUCTION_WORKFLOW: Workflow;
}

export default {
  fetch() {
    return new Response(JSON.stringify({ status: "healthy", service: "anyam-golden-workflow-host" }), {
      headers: { "content-type": "application/json" },
    });
  },
};
