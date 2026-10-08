#!/usr/bin/env node
import { hasCliOption, main } from "./cli.js";
import { LocalAgentError } from "./agent.js";

const args = process.argv.slice(2);
try {
  process.exitCode = await main(args);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (hasCliOption(args, "--json")) console.error(JSON.stringify({ status: "error", ...(error instanceof LocalAgentError ? error.toJSON() : { code: "cli.error", message }) }));
  else console.error(message);
  process.exitCode = 1;
}
