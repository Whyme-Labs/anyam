import { readFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;

const protocol = "anyam.provider-feed-observation/v1" as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function configuredAccountId(): string | undefined {
  const configUrl = new URL("../apps/realm-worker/wrangler.p3-24-live.jsonc", import.meta.url);
  const config = readFileSync(configUrl, "utf8");
  return config.match(/"account_id"\s*:\s*"([^"]+)"/)?.[1];
}

function csv(name: string): string[] {
  return required(name).split(",").map((value) => value.trim()).filter(Boolean);
}

function json(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function safeError(value: unknown): JsonObject {
  const body = json(value);
  const errors = Array.isArray(body.errors)
    ? body.errors.map((entry) => {
      const item = json(entry);
      return { message: typeof item.message === "string" ? item.message : "provider query failed", code: item.extensions && typeof item.extensions === "object" ? json(item.extensions).code : undefined };
    })
    : [];
  return { errors };
}

async function graphQL(input: { token: string; query: string; variables: JsonObject }): Promise<{ httpStatus: number; body: JsonObject }> {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: input.query, variables: input.variables }),
  });
  return { httpStatus: response.status, body: json(await response.json()) };
}

function feedResult(name: string, result: { httpStatus: number; body: JsonObject }): JsonObject {
  const errors = safeError(result.body).errors;
  return {
    name,
    httpStatus: result.httpStatus,
    status: result.httpStatus >= 200 && result.httpStatus < 300 && result.body.data !== null && result.body.data !== undefined && Array.isArray(errors) && errors.length === 0 ? "observed" : "unavailable",
    ...(errors && Array.isArray(errors) && errors.length > 0 ? { errors } : {}),
    data: result.body.data ?? null,
  };
}

const workersQuery = `query Workers($accountTag: string!, $datetimeStart: Time!, $datetimeEnd: Time!, $scriptName: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 10000, filter: { scriptName: $scriptName, datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }) {
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 }
      dimensions { datetime scriptName status }
    }
  } }
}`;

const r2Query = `query R2($accountTag: String!, $datetimeStart: Time!, $datetimeEnd: Time!, $bucketName: String!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd, bucketName: $bucketName }) {
      sum { requests }
      dimensions { actionType actionStatus }
    }
  } }
}`;

const d1Query = `query D1($accountTag: string!, $dateStart: Date!, $dateEnd: Date!, $databaseId: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $dateStart, date_leq: $dateEnd, databaseId: $databaseId }) {
      sum { readQueries writeQueries }
      quantiles { queryBatchTimeMsP90 }
      dimensions { date databaseId }
    }
  } }
}`;

const workflowQuery = `query Workflows($accountTag: string!, $datetimeStart: Time!, $datetimeEnd: Time!, $workflowName: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workflowsAdaptiveGroups(limit: 10000, filter: { datetimeHour_geq: $datetimeStart, datetimeHour_leq: $datetimeEnd, workflowName: $workflowName }) {
      count
      sum { wallTime }
      dimensions { datetimeHour workflowName }
    }
  } }
}`;

const queueQuery = `query Queue($accountTag: string!, $datetimeStart: Time!, $datetimeEnd: Time!, $queueId: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    backlog: queueBacklogAdaptiveGroups(limit: 10000, filter: { queueId: $queueId, datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }) {
      avg { messages bytes }
      dimensions { datetimeHour queueId }
    }
    operations: queueMessageOperationsAdaptiveGroups(limit: 10000, filter: { queueId: $queueId, datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }) {
      count
      sum { bytes billableOperations }
      avg { lagTime retryCount }
      dimensions { datetimeMinute actionType consumerType outcome queueId }
    }
  } }
}`;

const queueDiscoveryQuery = `query QueueDiscovery($accountTag: string!, $datetimeStart: Time!, $datetimeEnd: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    queueMessageOperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }) {
      count
      dimensions { datetimeMinute queueId actionType consumerType outcome }
    }
  } }
}`;

async function run(): Promise<void> {
  const token = required("ANYAM_ACCOUNT_ANALYTICS_TOKEN");
  const accountTag = required("ANYAM_CLOUDFLARE_ACCOUNT_ID");
  const expectedAccountTag = configuredAccountId();
  if (expectedAccountTag && accountTag !== expectedAccountTag) {
    throw new Error(`ANYAM_CLOUDFLARE_ACCOUNT_ID does not match the named cohort config (expected ${expectedAccountTag}, received ${accountTag})`);
  }
  const datetimeStart = required("ANYAM_PROVIDER_FEED_START");
  const datetimeEnd = required("ANYAM_PROVIDER_FEED_END");
  const dateStart = datetimeStart.slice(0, 10);
  const dateEnd = datetimeEnd.slice(0, 10);
  const workerNames = csv("ANYAM_PROVIDER_WORKER_NAMES");
  const bucketName = required("ANYAM_PROVIDER_R2_BUCKET");
  const databaseId = required("ANYAM_PROVIDER_D1_DATABASE_ID");
  const workflowName = required("ANYAM_PROVIDER_WORKFLOW_NAME");
  const queueId = process.env.ANYAM_PROVIDER_QUEUE_ID?.trim();
  const operationIds = process.env.ANYAM_PROVIDER_OPERATION_IDS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const variables = { accountTag, datetimeStart, datetimeEnd, dateStart, dateEnd };
  const feeds: JsonObject[] = [];

  for (const scriptName of workerNames) feeds.push(feedResult(`workers:${scriptName}`, await graphQL({ token, query: workersQuery, variables: { ...variables, scriptName } })));
  feeds.push(feedResult(`r2:${bucketName}`, await graphQL({ token, query: r2Query, variables: { ...variables, bucketName } })));
  feeds.push(feedResult(`d1:${databaseId}`, await graphQL({ token, query: d1Query, variables: { ...variables, databaseId } })));
  feeds.push(feedResult(`workflow:${workflowName}`, await graphQL({ token, query: workflowQuery, variables: { ...variables, workflowName } })));
  if (queueId) feeds.push(feedResult(`queue:${queueId}`, await graphQL({ token, query: queueQuery, variables: { ...variables, queueId } })));
  else {
    const discovery = feedResult("queue:discovery", await graphQL({ token, query: queueDiscoveryQuery, variables }));
    feeds.push({ ...discovery, status: "discovery-only", recoveryAction: "read a queueId from this account-wide result, set ANYAM_PROVIDER_QUEUE_ID, and rerun to bind the named disposable queue" });
  }

  const unavailable = feeds.filter((feed) => feed.status !== "observed");
  console.log(JSON.stringify({
    protocol,
    status: unavailable.length === 0 ? "succeeded" : "blocked",
    account: accountTag,
    window: { start: datetimeStart, end: datetimeEnd, dateStart, dateEnd },
    operationIds,
    feeds,
    credentialValues: "not-printed",
    providerFactsAreNotAnyamLimits: true,
    recoveryAction: unavailable.length === 0 ? "No recovery action is currently required." : "resolve each unavailable feed and rerun the same bounded window before treating the receipt as complete",
  }, null, 2));
  if (unavailable.length > 0) process.exitCode = 2;
}

try {
  await run();
} catch (error) {
  console.error(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? error.message : "provider-feed qualification failed", credentialValues: "not-printed", recoveryAction: "set the named inputs and retry the same bounded observation window" }, null, 2));
  process.exitCode = 2;
}
