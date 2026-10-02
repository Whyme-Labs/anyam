import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { parseDisclosedSourcePayload, type DisclosedSourceOperation } from "./disclosed-source-command.js";
import { RealmAuthorityHttpClient } from "./realm-authority-client.js";

const mutations: Record<string, DisclosedSourceOperation> = {
  "workspace.create": "workspace.create",
  "change.create": "change.create",
  "revision.publish": "revision.publish",
  "run.request": "run.request",
};

/** Explicit hosted workflow. Existing human authentication arrives on stdin. */
export async function runRealmSourceCommand(args: readonly string[], input: Readable): Promise<unknown> {
  const [, target, operation] = args;
  const mutation = mutations[`${target}.${operation}`];
  if (!mutation && !(operation === "inspect" && ["project", "workspace", "change", "run"].includes(target ?? ""))) {
    throw new Error("realm_source_operation_invalid; use project/workspace/change/run inspect or workspace create/change create/revision publish/run request");
  }
  const allowed = new Set(["--realm", "--session-stdin", "--json", ...(mutation ? ["--input", "--idempotency-key"] : ["--id"])]);
  const options = new Map<string, string>();
  for (let index = 3; index < args.length; index++) {
    const flag = args[index]!;
    if (!allowed.has(flag) || options.has(flag)) throw new Error("realm_source_options_invalid; use each documented option once; session input is stdin only");
    if (flag === "--session-stdin" || flag === "--json") options.set(flag, "true");
    else {
      const value = args[++index];
      if (!value?.trim() || value.startsWith("--")) throw new Error("realm_source_option_value_required");
      options.set(flag, value);
    }
  }
  const required = (flag: string) => {
    const value = options.get(flag);
    if (!value) throw new Error(`realm_source_option_required; supply ${flag}`);
    return value;
  };
  const baseUrl = required("--realm");
  required("--session-stdin");
  let payload: unknown;
  if (mutation) {
    const path = required("--input");
    try { payload = JSON.parse(await readFile(path, "utf8")); }
    catch { throw new Error("realm_source_input_invalid; provide a JSON file using documented selector fields"); }
    payload = parseDisclosedSourcePayload(mutation, payload);
  }
  const selector = required(mutation ? "--idempotency-key" : "--id");
  let ownerSession = "";
  for await (const chunk of input) ownerSession += String(chunk);
  const client = new RealmAuthorityHttpClient({ baseUrl, ownerSession: ownerSession.trim() });
  if (mutation) return client.viewCommand(mutation, parseDisclosedSourcePayload(mutation, payload), selector);
  if (target === "project") return client.inspectProject(selector);
  if (target === "workspace") return client.inspectWorkspace(selector);
  if (target === "change") return client.inspectChange(selector);
  return client.inspectRun(selector);
}
