#!/usr/bin/env node
import { formatRelease, greet } from "./index.js";

const [command, value = "world"] = process.argv.slice(2);

if (command === "greet") {
  process.stdout.write(`${greet(value)}\n`);
} else if (command === "version") {
  process.stdout.write(`${formatRelease("0.1.0")}\n`);
} else {
  process.stdout.write("Usage: anyam-example greet <name> | version\n");
  process.exitCode = 1;
}
