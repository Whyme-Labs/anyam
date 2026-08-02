#!/usr/bin/env node
import { main } from "./cli.js";

try {
  process.exitCode = await main(["git-credential-anyam", ...process.argv.slice(2)]);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
