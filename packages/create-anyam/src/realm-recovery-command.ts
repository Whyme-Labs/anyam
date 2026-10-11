import { constants } from "node:fs";
import { link, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { RealmAuthorityHttpClient } from "./realm-authority-client.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

function bundle(value: unknown): RecordValue {
  if (!record(value) || value.protocol !== "anyam.authority-recovery/v1" || !text(value.bundleId) || !text(value.bundleDigest) || !text(value.signature) || !record(value.snapshot)) {
    throw new Error("realm_recovery_bundle_invalid; use the unchanged signed Authority checkpoint; no request was sent");
  }
  return value;
}

function restoreReceipt(value: unknown): RecordValue {
  if (!record(value) || value.protocol !== "anyam.authority-plane/v1" || !["recovery-quarantined", "recovery-already-active"].includes(String(value.status)) || !text(value.bundleId) || !text(value.bundleDigest) || !text(value.receipt) || value.credentialFree !== true || value.canonicalWrite !== false) {
    throw new Error("realm_recovery_receipt_invalid; use the receipt returned by the exact restore; no activation was sent");
  }
  return value;
}

async function readInput(path: string): Promise<unknown> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    if (!(await file.stat()).isFile()) throw new Error("not-regular");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await file.readFile())) as unknown;
  } catch {
    throw new Error("realm_recovery_input_invalid; provide a UTF-8 JSON regular file rather than a symlink; no request was sent");
  } finally { await file?.close(); }
}

async function saveNewFile(path: string, operation: () => Promise<{ value: RecordValue; summary: RecordValue }>): Promise<RecordValue> {
  let staging: string;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Refuse an existing destination before the request. Publish with an atomic
    // no-clobber link afterward, so a concurrent destination is never removed.
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (existing) throw new Error("output-exists");
    staging = await mkdtemp(join(dirname(path), ".anyam-recovery-"));
  } catch { throw new Error("realm_recovery_output_unavailable; choose a new checkpoint file in an owner-controlled directory; no request was sent"); }
  try {
    try { file = await open(join(staging, "checkpoint.json"), "wx", 0o600); }
    catch { throw new Error("realm_recovery_output_unavailable; choose a new checkpoint file in an owner-controlled directory; no request was sent"); }
    const result = await operation();
    const bytes = JSON.stringify(result.value, null, 2) + "\n";
    try {
      await file.writeFile(bytes, "utf8");
      await file.sync();
      await link(join(staging, "checkpoint.json"), path);
    } catch {
      throw new Error("realm_recovery_output_unconfirmed; the server operation may have completed; retain the original input and idempotency key, inspect recovery status, and retry only the identical request to a new output file");
    }
    return { ...result.summary, output: path, fileDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  } finally {
    await file?.close();
    await rm(staging, { recursive: true, force: true });
  }
}

function summary(value: RecordValue): RecordValue {
  return Object.fromEntries(["protocol", "status", "bundleId", "bundleDigest", "snapshotVersion", "recoveryStatus", "credentialFree", "canonicalWrite", "receipt"].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

/** Existing owner session only; no login, credentials, deployment or automatic activation. */
export async function runRealmRecoveryCommand(args: readonly string[], input: Readable, cwd = process.cwd()): Promise<RecordValue> {
  const operation = args[2];
  if (!["inspect", "export", "restore", "activate"].includes(operation ?? "")) throw new Error("realm_recovery_operation_invalid; use inspect, export, restore, or activate");
  const writesFile = operation === "export" || operation === "restore";
  const mutates = operation === "restore" || operation === "activate";
  const allowed = new Set(["--realm", "--session-stdin", "--json", ...(writesFile ? ["--output"] : []), ...(mutates ? ["--input", "--idempotency-key"] : [])]);
  const options = new Map<string, string>();
  for (let index = 3; index < args.length; index++) {
    const flag = args[index]!;
    if (!allowed.has(flag) || options.has(flag)) throw new Error("realm_recovery_options_invalid; use each documented option once; session input is stdin only");
    if (flag === "--session-stdin" || flag === "--json") options.set(flag, "true");
    else {
      const value = args[++index];
      if (!value?.trim() || value.startsWith("--")) throw new Error("realm_recovery_option_value_required");
      options.set(flag, value);
    }
  }
  const required = (flag: string): string => {
    const value = options.get(flag);
    if (!value) throw new Error(`realm_recovery_option_required; supply ${flag}`);
    return value;
  };
  const baseUrl = required("--realm"); required("--session-stdin");
  const output = writesFile ? resolve(cwd, required("--output")) : undefined;
  const key = mutates ? required("--idempotency-key") : undefined;
  const selected = mutates ? await readInput(resolve(cwd, required("--input"))) : undefined;
  const selectedBundle = operation === "restore" ? bundle(selected) : undefined;
  const selectedReceipt = operation === "activate" ? restoreReceipt(selected) : undefined;
  const perform = async () => {
    let ownerSession = "";
    for await (const chunk of input) ownerSession += String(chunk);
    const client = new RealmAuthorityHttpClient({ baseUrl, ownerSession: ownerSession.trim() });
    if (operation === "inspect") return { value: await client.inspectState() };
    if (operation === "activate") {
      const value = await client.activateAuthorityRecovery(selectedReceipt!.bundleId as string, selectedReceipt!.bundleDigest as string, key!);
      if (!["recovery-activated", "already-active"].includes(String(value.status)) || value.bundleId !== selectedReceipt!.bundleId || value.recoveryStatus !== "active" || !text(value.receipt)) throw new Error("realm_recovery_response_invalid; outcome=unconfirmed; inspect recovery status and retry only the identical activation");
      return { value: summary(value) };
    }
    if (operation === "restore") {
      const value = await client.restoreAuthorityRecovery(selectedBundle!, key!);
      if (value.bundleId !== selectedBundle!.bundleId || value.bundleDigest !== selectedBundle!.bundleDigest) throw new Error("realm_recovery_response_invalid; outcome=unconfirmed; inspect recovery status and retry only the identical restore");
      try { restoreReceipt(value); } catch { throw new Error("realm_recovery_response_invalid; outcome=unconfirmed; inspect recovery status and retry only the identical restore"); }
      return { value, summary: summary(value) };
    }
    const value = await client.exportAuthorityRecovery();
    if (value.protocol !== "anyam.authority-plane/v1" || value.status !== "recovery-exported" || value.credentialFree !== true || value.canonicalWrite !== false || !text(value.receipt)) throw new Error("realm_recovery_response_invalid; no complete checkpoint was saved");
    let checkpoint: RecordValue;
    try { checkpoint = bundle(value.bundle); } catch { throw new Error("realm_recovery_response_invalid; no complete checkpoint was saved"); }
    return { value: checkpoint, summary: { ...summary(value), bundleId: checkpoint.bundleId, bundleDigest: checkpoint.bundleDigest } };
  };
  if (output) return saveNewFile(output, async () => {
    const result = await perform();
    if (!result.summary) throw new Error("realm_recovery_response_invalid; no complete checkpoint was saved");
    return { value: result.value, summary: result.summary };
  });
  return (await perform()).value;
}
