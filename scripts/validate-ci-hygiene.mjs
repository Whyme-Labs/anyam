import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const workflowsDirectory = ".github/workflows";
const shaPattern = /^[0-9a-f]{40}$/;
const workflowNames = (await readdir(workflowsDirectory)).filter((name) =>
  name.endsWith(".yml") || name.endsWith(".yaml"),
);

if (workflowNames.length === 0) {
  throw new Error(`No workflow files found under ${workflowsDirectory}`);
}

const pins = [];
const failures = [];

for (const workflowName of workflowNames) {
  const path = join(workflowsDirectory, workflowName);
  const source = await readFile(path, "utf8");

  if (!/^permissions:\s*$/m.test(source)) {
    failures.push(`${path}: missing a top-level permissions block`);
  }

  for (const [index, line] of source.split("\n").entries()) {
    const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/);
    if (!match) continue;

    const reference = match[1];
    const at = reference.lastIndexOf("@");
    const action = at < 0 ? reference : reference.slice(0, at);
    const revision = at < 0 ? "" : reference.slice(at + 1);

    pins.push({ workflow: workflowName, line: index + 1, action, revision });
    if (!shaPattern.test(revision)) {
      failures.push(`${path}:${index + 1}: ${reference} is not pinned to a 40-character commit SHA`);
    }
  }
}

const receipt = {
  protocol: "anyam.repository-gate-hygiene/v1",
  status: failures.length === 0 ? "succeeded" : "blocked",
  workflows: workflowNames.sort(),
  actionPins: pins,
  checks: ["top-level-permissions", "immutable-action-refs"],
  credentialMaterialStored: false,
  providerFactsAreNotAnyamLimits: true,
};

console.log(JSON.stringify(receipt, null, 2));

if (failures.length > 0) {
  for (const failure of failures) console.error(`CI hygiene failure: ${failure}`);
  process.exitCode = 1;
}
