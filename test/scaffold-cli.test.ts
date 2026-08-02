import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
  runLocalCheck,
  scaffoldProject,
  startChange,
  type ProjectTemplateKind,
} from "../packages/create-anyam/src/scaffold.ts";
import { runK0Harness } from "../src/harness/k0.ts";

const packageManifestPath = fileURLToPath(new URL("../packages/create-anyam/package.json", import.meta.url));
const fixtureRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function tempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "anyam-scaffold-"));
}

test("create-anyam exposes both package-manager entry points", async () => {
  const packageManifestMetadata = JSON.parse(await readFile(packageManifestPath, "utf8")) as {
    name: string;
    version: string;
    bin: Record<string, string>;
    scripts: Record<string, string>;
  };

  assert.equal(packageManifestMetadata.name, "create-anyam");
  assert.ok(packageManifestMetadata.bin["create-anyam"]);
  assert.ok(packageManifestMetadata.bin.anyam);
  assert.equal(packageManifestMetadata.scripts.prepare, "npm run build");
  assert.equal(packageManifestMetadata.scripts.prepack, "npm run build");
});

for (const kind of ["worker", "library"] as const satisfies readonly ProjectTemplateKind[]) {
  test(`scaffold ${kind} project and run local check without Realm authority`, async () => {
    const root = await tempDirectory();
    const target = join(root, `sample-${kind}`);
    const result = await scaffoldProject({ directory: target, name: `sample-${kind}`, kind });

    assert.equal(result.status, "created");
    assert.equal(result.git, "initialized");
    assert.ok(result.createdFiles.includes("anyam.json"));
    assert.ok(result.createdFiles.includes("src/index.ts"));
    assert.equal(result.createdFiles.some((file) => /credential|token|realm/i.test(file)), false);
    await access(join(target, ".git"));

    const manifest = JSON.parse(await readFile(join(target, "anyam.json"), "utf8")) as Record<string, unknown>;
    assert.equal(manifest.schema, "anyam.project/v1");
    assert.equal(manifest.name, `sample-${kind}`);
    assert.equal(manifest.id, `project:local:sample-${kind}`);
    assert.ok(Array.isArray(manifest.modules));
    assert.ok(Array.isArray(manifest.verifiers));
    assert.ok(Array.isArray(manifest.targets));
    assert.equal(manifest.auth, undefined);

    const packageManifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
    const packageMetadata = JSON.parse(await readFile(packageManifestPath, "utf8")) as { version: string };
    assert.equal(packageManifest.devDependencies?.["create-anyam"], `^${packageMetadata.version}`);

    const check = await runLocalCheck(target);
    assert.equal(check.status, "passed");
    assert.equal(check.blockers.length, 0);
    assert.ok(check.receipts.some((receipt) => receipt.name === "manifest"));
    assert.ok(check.receipts.some((receipt) => receipt.name === "source"));

    const change = await startChange(target, "Add a first local feature");
    assert.equal(change.status, "created");
    const changeDocument = JSON.parse(await readFile(join(target, ".anyam", "change.json"), "utf8")) as Record<string, unknown>;
    assert.equal(changeDocument.protocol, "anyam.change/v1");
    assert.equal(changeDocument.id, change.changeId);
    assert.equal(changeDocument.projectId, `project:local:sample-${kind}`);
    assert.equal(changeDocument.baseProjectRevisionId, "project-revision:local:working-tree");
    assert.equal(changeDocument.status, "active");
    assert.equal(changeDocument.latestRevisionId, null);
    assert.deepEqual(changeDocument.local, {
      workspaceId: "workspace:local:working-tree",
      sourceSpaceId: "source:local",
      baseSnapshot: "snapshot:local:working-tree",
    });
    assert.equal(changeDocument.title, "Add a first local feature");
  });
}

test("Worker and TypeScript library fixtures remain ready at the K0 Stage Gate", async () => {
  const report = await runK0Harness({ fixtureRoot });

  assert.equal(report.gate.status, "ready");
  assert.equal(report.fixtures.ok, true);
  assert.equal(report.fixtures.failedJourneys.length, 0);
  assert.ok(report.fixtures.checkedJourneys > 0);
});

test("local check names a missing budget, limit, request, and receipt", async () => {
  const root = await tempDirectory();
  const check = await runLocalCheck(root);

  assert.equal(check.status, "blocked");
  assert.ok(check.blockers.length > 0);
  assert.match(check.blockers[0]!.message, /budget=.*limit=.*asked=.*receipt=/);
});

test("local check blocks an incomplete v1 Project Manifest", async () => {
  const root = await tempDirectory();
  const target = join(root, "incomplete");
  await scaffoldProject({ directory: target, name: "incomplete", kind: "worker" });
  await writeFile(join(target, "anyam.json"), `${JSON.stringify({ schema: "anyam.project/v1", name: "incomplete" })}\n`, "utf8");

  const check = await runLocalCheck(target);

  assert.equal(check.status, "blocked");
  assert.equal(check.blockers[0]?.code, "manifest.invalid");
  assert.match(check.blockers[0]?.message ?? "", /modules/);
  assert.match(check.blockers[0]?.message ?? "", /budget=.*limit=.*asked=.*receipt=/);
});

test("scaffolding leaves existing files intact and reports them", async () => {
  const root = await tempDirectory();
  const target = join(root, "existing");
  await scaffoldProject({ directory: target, name: "existing", kind: "worker" });
  const before = await readdir(target);
  const result = await scaffoldProject({ directory: target, name: "existing", kind: "worker" });

  assert.equal(result.status, "unchanged");
  assert.deepEqual(await readdir(target), before);
});

test("init dry-run prints a manifest plan without writing files", async () => {
  const root = await tempDirectory();
  const target = join(root, "planned");
  const result = await scaffoldProject({ directory: target, name: "planned", kind: "library", dryRun: true });

  assert.equal(result.status, "planned");
  assert.equal(result.git, "not-created");
  assert.ok(result.createdFiles.includes("anyam.json"));
  await assert.rejects(readFile(join(target, "anyam.json")));
});
