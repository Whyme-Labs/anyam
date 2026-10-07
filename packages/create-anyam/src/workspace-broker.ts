import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalAgentError, type AgentLaunchResult, type LocalAgentManager, type LocalAgentSession } from "./agent.js";
import { WORKSPACE_BOUNDARY_POLICY, type WorkspaceBoundaryMode } from "./workspace-boundary.js";

const protocol = "anyam.workspace-broker/v1";
type Identity = Pick<LocalAgentSession, "id" | "projectId" | "changeId" | "workspaceId" | "grantId" | "taskId" | "actorId" | "authorizationEpoch">;
type Locator = { protocol: typeof protocol; endpoint: string; instanceId: string; session: Identity };
export type DisclosedWorkspaceLaunch = Omit<AgentLaunchResult, "boundary"> & { boundary: Omit<AgentLaunchResult["boundary"], "environment"> };

function failure(code: string, message: string): LocalAgentError {
  return new LocalAgentError({ code: `workspace.broker.${code}`, message, recoveryAction: "inspect the selected Workspace; revoke an interrupted session and explicitly start a fresh scoped broker", receipt: "transport=owner-local-socket; fallback=false; persisted-authority=false" });
}
function identity(session: LocalAgentSession): Identity {
  const { id, projectId, changeId, workspaceId, grantId, taskId, actorId, authorizationEpoch } = session;
  return { id, projectId, changeId, workspaceId, grantId, taskId, actorId, authorizationEpoch };
}
function matches(value: unknown, expected: Identity): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(expected).every(([key, entry]) => (value as Record<string, unknown>)[key] === entry);
}
function isIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return ["id", "projectId", "changeId", "workspaceId", "grantId", "taskId", "actorId"].every(key => typeof fields[key] === "string" && fields[key] !== "") && typeof fields.authorizationEpoch === "number" && Number.isSafeInteger(fields.authorizationEpoch);
}
export function workspaceBrokerLocatorPath(statePath: string, sessionId: string): string {
  return join(dirname(statePath), `workspace-broker-${createHash("sha256").update(sessionId).digest("hex")}.json`);
}
export async function removeWorkspaceBrokerLocator(statePath: string, sessionId: string): Promise<void> {
  const path = workspaceBrokerLocatorPath(statePath, sessionId);
  try {
    await ownerOnly(path, "file");
    const locator = JSON.parse(await readFile(path, "utf8")) as Locator;
    if (locator.protocol !== protocol || !isIdentity(locator.session) || locator.session.id !== sessionId || typeof locator.instanceId !== "string" || typeof locator.endpoint !== "string") throw failure("binding_mismatch", "The interrupted broker locator does not match the revoked Session; it was preserved.");
    const directory = dirname(locator.endpoint); await ownerOnly(directory, "directory");
    const markerPath = join(directory, "binding.json"); await ownerOnly(markerPath, "file");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Locator;
    if (locator.endpoint !== join(directory, "exec.sock") || marker.endpoint !== locator.endpoint || marker.protocol !== protocol || marker.instanceId !== locator.instanceId || !matches(marker.session, locator.session)) throw failure("binding_mismatch", "The endpoint belongs to a different broker binding; it was preserved.");
    try { await ownerOnly(locator.endpoint, "socket"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rm(locator.endpoint, { force: true }); await rm(markerPath); await rm(path);
    await rmdir(directory); // Never recursively delete a path supplied by persisted metadata.
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function ownerOnly(path: string, kind: "file" | "directory" | "socket") {
  const value = await lstat(path);
  if (!process.getuid || value.uid !== process.getuid() || (value.mode & 0o077) !== 0 || value.isSymbolicLink()
    || !(kind === "file" ? value.isFile() : kind === "directory" ? value.isDirectory() : value.isSocket())) {
    throw failure("endpoint_invalid", "The selected broker endpoint is not an owner-only local endpoint; no request was sent.");
  }
}
// Reuse the existing command output tripwire for incoming command frames;
// this is a provisional inherited budget, not a new production sizing claim.
function readRequest(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    socket.setTimeout(WORKSPACE_BOUNDARY_POLICY.commandTimeoutMs, () => {
      socket.pause();
      reject(failure("timeout", `budget=workspace-broker.request-timeout; limit=${WORKSPACE_BOUNDARY_POLICY.commandTimeoutMs}ms; asked=incomplete command frame; ${WORKSPACE_BOUNDARY_POLICY.receipt}`));
    });
    socket.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > WORKSPACE_BOUNDARY_POLICY.maxOutputBytes) { socket.pause(); reject(failure("request_budget", `budget=workspace-broker.request; limit=${WORKSPACE_BOUNDARY_POLICY.maxOutputBytes}bytes; asked=${bytes}bytes; ${WORKSPACE_BOUNDARY_POLICY.receipt}`)); return; }
      chunks.push(chunk);
    });
    socket.once("error", reject);
    socket.once("close", () => reject(failure("unavailable", "The command connection closed before a complete request was received.")));
    socket.once("end", () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("invalid_request", "The broker request must be one command object.");
        resolve(value as Record<string, unknown>);
      } catch { reject(failure("invalid_request", "The broker request is malformed; no process was started.")); }
    });
  });
}

/** An owner CLI handoff, deliberately separate from the semantic MCP tool list. */
export async function startWorkspaceCommandBroker(input: { manager: LocalAgentManager; sessionId: string; agent: string }): Promise<{ close(): Promise<void> } | undefined> {
  if (process.platform === "win32") return undefined; // Named-pipe ownership is not qualified by this contract.
  const selected = await input.manager.bindSession(input.sessionId, input.agent);
  const binding = identity(selected.session); const instanceId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), "am-w-")); await chmod(directory, 0o700);
  const endpoint = join(directory, "exec.sock"); const path = workspaceBrokerLocatorPath(input.manager.statePathname, input.sessionId);
  const locator = { protocol, endpoint, instanceId, session: binding } satisfies Locator;
  const sockets = new Set<Socket>(); const pending = new Set<Promise<void>>(); let closing = false;
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); let executing = false; let finished = false; let cancellation: Promise<void> | undefined; let cancellationError: unknown;
    socket.on("error", () => { /* The request/response promise owns the diagnostic. */ });
    socket.once("close", () => {
      sockets.delete(socket);
      if (executing && !finished) cancellation = input.manager.revoke(input.sessionId).then(() => undefined, error => { cancellationError = error; });
    });
    const task = (async () => {
      try {
        const request = await readRequest(socket);
        // The workload already has its own deadline and custody cleanup. Do
        // not let connection setup consume that execution deadline as well.
        socket.setTimeout(0);
        if (closing || request.protocol !== protocol || request.instanceId !== instanceId || !matches(request.session, binding)) throw failure("binding_mismatch", "The requested identity does not belong to this live broker; no process was started.");
        if (Object.keys(request.session as object).some(key => !Object.hasOwn(binding, key)) || Object.keys(request).some(key => !["protocol", "instanceId", "session", "command", "args", "mode"].includes(key)) || typeof request.command !== "string" || !request.command.trim()
          || !Array.isArray(request.args) || !request.args.every(value => typeof value === "string") || (request.mode !== undefined && request.mode !== "enforceable" && request.mode !== "supervised")) throw failure("invalid_request", "The command request contains invalid or caller-authority fields; no process was started.");
        const current = await input.manager.bindSession(input.sessionId, input.agent);
        if (!matches(current.session, binding) || current.grant.id !== binding.grantId || current.grant.subjectId !== binding.actorId || current.grant.authorizationEpoch !== binding.authorizationEpoch
          || current.grant.resource.projectId !== binding.projectId || current.grant.resource.changeId !== binding.changeId || current.grant.resource.workspaceId !== binding.workspaceId
          || current.session.workspaceBoundaryId !== selected.session.workspaceBoundaryId || current.session.workspaceMode !== selected.session.workspaceMode || current.session.workspaceDirectory !== selected.session.workspaceDirectory || current.session.workspaceEnforcement !== selected.session.workspaceEnforcement
          || !(["source.read", "workspace.write", "run.start"] as const).every(action => current.grant.actions.includes(action) && !current.grant.deniedActions.includes(action))) throw failure("binding_mismatch", "The live session no longer authorizes this execution; no process was started.");
        if (request.mode !== undefined && request.mode !== current.session.workspaceMode) throw failure("mode_mismatch", "The selected Workspace has a different boundary mode; no replacement boundary was created.");
        executing = true;
        const launched = await input.manager.launchAgent({ sessionId: binding.id, command: request.command, args: request.args as string[] });
        await input.manager.bindSession(binding.id, input.agent);
        const { environment: runtimeEnvironment, ...boundary } = launched.boundary;
        finished = true; socket.end(JSON.stringify({ protocol, instanceId, result: { ...launched, boundary } }));
      } catch (error) {
        finished = true;
        socket.setTimeout(WORKSPACE_BOUNDARY_POLICY.commandTimeoutMs, () => {
          process.stderr.write(`budget=workspace-broker.denial-flush; limit=${WORKSPACE_BOUNDARY_POLICY.commandTimeoutMs}ms; asked=unfinished denial response; ${WORKSPACE_BOUNDARY_POLICY.receipt}\n`);
          socket.destroy();
        });
        if (!socket.destroyed) socket.end(JSON.stringify({ protocol, instanceId, error: error instanceof LocalAgentError ? error.toJSON() : failure("execution_failed", "The broker could not complete the selected execution; inspect its state before retrying.").toJSON() }), () => socket.destroy());
      } finally {
        if (cancellation) await cancellation;
        if (cancellationError) throw cancellationError;
      }
    })();
    pending.add(task);
    void task.then(() => pending.delete(task), () => { pending.delete(task); process.stderr.write("Workspace broker cancellation failed; inspect and revoke the selected session before retrying.\n"); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => { server.removeListener("error", reject); resolve(); });
    });
    await chmod(endpoint, 0o600);
    await writeFile(join(directory, "binding.json"), JSON.stringify(locator), { flag: "wx", mode: 0o600 });
    await writeFile(path, JSON.stringify(locator), { flag: "wx", mode: 0o600 });
  } catch (error) {
    server.close(); await rm(directory, { recursive: true, force: true });
    throw failure("unavailable", "The live broker endpoint could not be published; no execution fallback was created.");
  }
  return { async close() {
    closing = true;
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const socket of sockets) socket.destroy();
    await Promise.all([...pending]); await closed;
    try { await removeWorkspaceBrokerLocator(input.manager.statePathname, selected.session.id); }
    finally { await rm(directory, { recursive: true, force: true }); }
  } };
}

export async function executeThroughWorkspaceBroker(input: { manager: LocalAgentManager; sessionId: string; command: string; args: readonly string[]; mode?: WorkspaceBoundaryMode }): Promise<DisclosedWorkspaceLaunch> {
  if (process.platform === "win32") throw failure("unavailable", "Owner-local socket handoff is not qualified on Windows; no process was started.");
  const selected = await input.manager.inspectSession(input.sessionId); const session = selected?.session;
  if (!session || session.status !== "active" || selected?.grant?.status !== "active") throw failure("unavailable", "The selected session is not active; no process was started.");
  const path = workspaceBrokerLocatorPath(input.manager.statePathname, input.sessionId);
  let locator: Locator;
  try {
    await ownerOnly(path, "file"); locator = JSON.parse(await readFile(path, "utf8")) as Locator;
    if (locator.protocol !== protocol || typeof locator.endpoint !== "string" || typeof locator.instanceId !== "string" || !matches(locator.session, identity(session))) throw failure("binding_mismatch", "The broker locator does not match the selected session.");
    await ownerOnly(dirname(locator.endpoint), "directory"); await ownerOnly(locator.endpoint, "socket");
  } catch (error) {
    if (error instanceof LocalAgentError) throw error;
    throw failure("unavailable", "The selected session has no live Workspace boundary; no process was started.");
  }
  const request = JSON.stringify({ protocol, instanceId: locator.instanceId, session: identity(session), command: input.command, args: input.args, ...(input.mode ? { mode: input.mode } : {}) });
  if (Buffer.byteLength(request) > WORKSPACE_BOUNDARY_POLICY.maxOutputBytes) throw failure("request_budget", `budget=workspace-broker.request; limit=${WORKSPACE_BOUNDARY_POLICY.maxOutputBytes}bytes; asked=${Buffer.byteLength(request)}bytes; ${WORKSPACE_BOUNDARY_POLICY.receipt}`);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; const socket = createConnection({ path: locator.endpoint, allowHalfOpen: true }, () => socket.end(request));
    socket.on("data", chunk => chunks.push(chunk));
    socket.once("error", error => reject(error instanceof LocalAgentError ? error : failure("unavailable", "The selected broker is unavailable; persisted metadata cannot recreate its Workspace authority.")));
    socket.once("close", () => reject(failure("unavailable", "The selected broker connection ended without a completed receipt; inspect the Workspace before retrying.")));
    socket.once("end", () => {
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { protocol?: unknown; instanceId?: unknown; error?: Record<string, unknown>; result?: DisclosedWorkspaceLaunch };
        if (response.protocol !== protocol || response.instanceId !== locator.instanceId) throw failure("binding_mismatch", "The broker response does not match the selected live endpoint.");
        if (response.error) throw new LocalAgentError({ code: String(response.error.code), message: String(response.error.message), ...(typeof response.error.recoveryAction === "string" ? { recoveryAction: response.error.recoveryAction } : {}), ...(typeof response.error.receipt === "string" ? { receipt: response.error.receipt } : {}) });
        if (!response.result || !matches(response.result.session, identity(session)) || Object.hasOwn(response.result.boundary, "environment")) throw failure("binding_mismatch", "The broker did not return the selected disclosed execution identity.");
        resolve(response.result);
      } catch (error) { reject(error instanceof LocalAgentError ? error : failure("invalid_response", "The broker returned an invalid execution response.")); }
      finally { socket.destroy(); }
    });
  });
}
