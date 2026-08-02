import { proposedManifest, runLocalCheck, scaffoldProject, startChange, type ProjectTemplateKind } from "./scaffold.js";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function kindFrom(args: readonly string[]): ProjectTemplateKind {
  const value = valueAfter(args, "--type");
  if (!args.includes("--type") || value === "worker") return "worker";
  if (value === "library") return "library";
  throw new Error(`--type must be worker or library; asked=${value ?? "missing"}; fix the option and rerun anyam init.`);
}

function positionalArgs(args: readonly string[], command: string): readonly string[] {
  const values: string[] = [];
  const valueFlags = new Set(["--type", "--name"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (valueFlags.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("--") && argument !== command) values.push(argument);
  }
  return values;
}

function printHelp(): void {
  console.log(`Anyam local CLI\n\nCommands:\n  init [directory]                 create a local TypeScript Project\n  check [directory]                inspect manifest and source locally\n  change start <title>             start a local Change\n\nOptions:\n  --type worker|library             choose the template (default: worker)\n  --name <name>                     choose the Project name\n  --json                            print machine-readable output\n  --dry-run                         print the proposed manifest without writing\n\nNo command creates a Realm, authenticates, provisions cloud resources, or stores credentials.`);
}

export async function main(args: readonly string[], cwd = process.cwd()): Promise<number> {
  const [command, subcommand] = args;
  const json = args.includes("--json");
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "init") {
    const directory = positionalArgs(args, "init")[0] ?? cwd;
    const name = valueAfter(args, "--name");
    if (args.includes("--name") && !name) throw new Error("--name requires a Project name; fix the option and rerun anyam init.");
    const scaffoldInput = {
      directory,
      kind: kindFrom(args),
      ...(name ? { name } : {}),
    };
    if (args.includes("--dry-run")) {
      const result = proposedManifest(scaffoldInput);
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    const result = await scaffoldProject({
      ...scaffoldInput,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.status === "created" ? "Created" : "Already initialized"} local Project at ${result.directory}\nNext: cd ${result.directory} && npx create-anyam check && npx create-anyam change start "Describe the next Change"`);
    return 0;
  }

  if (command === "check") {
    const directory = positionalArgs(args, "check")[0] ?? cwd;
    const result = await runLocalCheck(directory);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const receipt of result.receipts) console.log(`PASS ${receipt.name}: ${receipt.receipt}`);
      for (const item of result.blockers) console.error(`BLOCKED ${item.code}: ${item.message}`);
      console.log(result.status === "passed" ? "Local check passed." : "Local check blocked; fix the named receipt and rerun anyam check.");
    }
    return result.status === "passed" ? 0 : 1;
  }

  if (command === "change" && subcommand === "start") {
    const title = args.slice(2).filter((arg) => !arg.startsWith("--")).join(" ");
    const result = await startChange(cwd, title);
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.status === "created" ? "Started" : "Using existing"} Change ${result.changeId}: ${result.title}\nLocal only: no Realm or remote credentials were used.`);
    return 0;
  }

  printHelp();
  return 1;
}
