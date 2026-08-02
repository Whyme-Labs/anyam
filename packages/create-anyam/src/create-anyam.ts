#!/usr/bin/env node
import { main } from "./cli.js";

const args = process.argv.slice(2);
const command = args[0];
const directCommands = new Set(["init", "check", "change", "--help", "-h"]);
try {
  process.exitCode = await main(directCommands.has(command ?? "") ? args : ["init", ...args]);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (args.includes("--json")) console.error(JSON.stringify({ status: "error", code: "cli.error", message }));
  else console.error(message);
  process.exitCode = 1;
}
