import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { LocalAgentError, setupAgent } from "../packages/create-anyam/src/agent.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anyam-agent-setup-"));
  const directory = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(directory);
  await mkdir(outside);
  await writeFile(join(directory, "anyam.json"), "{}\n");
  return { root, directory, outside };
}

function unsafePath(error: unknown, path: string): boolean {
  assert.ok(error instanceof LocalAgentError);
  assert.equal(error.code, "agent.setup.path_unsafe");
  assert.equal(error.affectedObject, path);
  assert.match(error.message, /symbolic link|regular file|directory/u);
  assert.ok(error.recoveryAction);
  return true;
}

for (const [agent, path] of [["codex", ".codex/config.toml"], ["claude", ".mcp.json"], ["cursor", ".cursor/mcp.json"]] as const) {
  test(`agent setup rejects the linked ${agent} config before any setup write`, async () => {
    const f = await fixture();
    try {
      const external = join(f.outside, "config");
      const content = agent === "codex" ? 'model = "preserve-external"\n' : '{"external":"preserve"}\n';
      await writeFile(external, content);
      await mkdir(dirname(join(f.directory, path)), { recursive: true });
      await symlink(external, join(f.directory, path));

      await assert.rejects(setupAgent({ directory: f.directory, agent }), (error: unknown) => unsafePath(error, path));
      assert.equal(await readFile(external, "utf8"), content);
      assert.equal((await lstat(join(f.directory, path))).isSymbolicLink(), true);
      await assert.rejects(access(join(f.directory, ".anyam")), { code: "ENOENT" });
      await assert.rejects(access(join(f.directory, "AGENTS.md")), { code: "ENOENT" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const [agent, path] of [["codex", ".codex"], ["cursor", ".cursor"], ["cli", ".anyam"]] as const) {
  test(`agent setup rejects the linked ${path} directory before any setup write`, async () => {
    const f = await fixture();
    try {
      await symlink(f.outside, join(f.directory, path), "dir");
      await assert.rejects(setupAgent({ directory: f.directory, agent }), (error: unknown) => unsafePath(error, path));
      assert.deepEqual(await readdir(f.outside), []);
      await assert.rejects(access(join(f.directory, "AGENTS.md")), { code: "ENOENT" });
      if (path !== ".anyam") await assert.rejects(access(join(f.directory, ".anyam")), { code: "ENOENT" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("agent setup rejects a dangling shared instruction link before any setup write", async () => {
  const f = await fixture();
  try {
    const external = join(f.outside, "new-instructions");
    await symlink(external, join(f.directory, "AGENTS.md"));
    await assert.rejects(setupAgent({ directory: f.directory, agent: "cli" }), (error: unknown) => unsafePath(error, "AGENTS.md"));
    await assert.rejects(access(external), { code: "ENOENT" });
    await assert.rejects(access(join(f.directory, ".anyam")), { code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("agent setup rejects a non-directory config parent before any setup write", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, ".codex"), "preserve this file\n");
    await assert.rejects(setupAgent({ directory: f.directory, agent: "codex" }), (error: unknown) => unsafePath(error, ".codex"));
    assert.equal(await readFile(join(f.directory, ".codex"), "utf8"), "preserve this file\n");
    await assert.rejects(access(join(f.directory, ".anyam")), { code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("agent setup rejects a directory at a config file path before any setup write", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.directory, ".mcp.json"));
    await assert.rejects(setupAgent({ directory: f.directory, agent: "claude" }), (error: unknown) => unsafePath(error, ".mcp.json"));
    assert.deepEqual(await readdir(join(f.directory, ".mcp.json")), []);
    await assert.rejects(access(join(f.directory, ".anyam")), { code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("agent setup validates nested shared paths before changing existing metadata", async () => {
  const f = await fixture();
  try {
    const agents = join(f.directory, ".anyam/agents");
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "manifest.json"), "preserve metadata\n");
    await symlink(f.outside, join(agents, "skills"), "dir");
    await assert.rejects(setupAgent({ directory: f.directory, agent: "cli" }), (error: unknown) => unsafePath(error, ".anyam/agents/skills"));
    assert.equal(await readFile(join(agents, "manifest.json"), "utf8"), "preserve metadata\n");
    assert.deepEqual(await readdir(f.outside), []);
    await assert.rejects(access(join(agents, "AGENTS.md")), { code: "ENOENT" });
    await assert.rejects(access(join(f.directory, "AGENTS.md")), { code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("agent setup accepts an explicitly selected Project directory alias", async () => {
  const f = await fixture();
  try {
    const alias = join(f.root, "selected-project");
    await symlink(f.directory, alias, "dir");
    const result = await setupAgent({ directory: alias, agent: "cli" });
    assert.equal(result.directory, alias);
    await access(join(f.directory, ".anyam/agents/manifest.json"));
    assert.deepEqual(await readdir(f.outside), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const agent of ["claude", "cursor"] as const) {
  test(`agent setup preserves existing regular ${agent} configuration`, async () => {
    const f = await fixture();
    try {
      const path = join(f.directory, agent === "claude" ? ".mcp.json" : ".cursor/mcp.json");
      const existing = { setting: "preserve", mcpServers: { existing: { command: "existing-server" } } };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(existing));
      await setupAgent({ directory: f.directory, agent });
      const configured = JSON.parse(await readFile(path, "utf8"));
      assert.equal(configured.setting, existing.setting);
      assert.deepEqual(configured.mcpServers.existing, existing.mcpServers.existing);
      assert.deepEqual(configured.mcpServers.anyam, { command: "anyam", args: ["mcp", "serve", "--stdio", "--agent", agent] });
      await setupAgent({ directory: f.directory, agent });
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), configured);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("agent setup preserves regular Codex configuration and remains repeatable", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, ".codex/config.toml");
    const existing = 'model = "preserve-model"\n';
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, existing);
    await setupAgent({ directory: f.directory, agent: "codex" });
    const configured = await readFile(path, "utf8");
    assert.ok(configured.startsWith(existing));
    assert.match(configured, /\[mcp_servers\.anyam\]/u);
    assert.equal((await setupAgent({ directory: f.directory, agent: "codex" })).files.includes(".codex/config.toml"), false);
    assert.equal(await readFile(path, "utf8"), configured);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
