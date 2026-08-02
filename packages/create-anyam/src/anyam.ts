#!/usr/bin/env node
import { main } from "./cli.js";

const args = process.argv.slice(2);
try {
  process.exitCode = await main(args);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (args.includes("--json")) console.error(JSON.stringify({ status: "error", code: "cli.error", message }));
  else console.error(message);
  process.exitCode = 1;
}
