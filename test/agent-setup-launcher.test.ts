import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LocalAgentError, setupAgent } from "../packages/create-anyam/src/agent.ts";
import { main } from "../packages/create-anyam/src/cli.ts";

const execFile = promisify(execFileCallback);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anyam-setup-launcher-"));
  const directory = join(root, "project");
  const cliPath = join(root, process.platform === "win32" ? "selected CLI build.mjs" : 'selected CLI "build".mjs');
  await mkdir(directory);
  await writeFile(join(directory, "anyam.json"), "{}\n");
  await writeFile(cliPath, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  return { root, directory, cliPath };
}

for (const agent of ["codex", "claude", "cursor", "cli"] as const) {
  test(`agent setup selects a built CLI for ${agent} without a global executable`, async () => {
    const f = await fixture();
    try {
      const relativeConfig = agent === "codex" ? ".codex/config.toml" : agent === "claude" ? ".mcp.json" : ".cursor/mcp.json";
      const configPath = join(f.directory, relativeConfig);
      if (agent !== "cli") {
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, agent === "codex" ? 'model = "preserve-model"\n' : JSON.stringify({ setting: "preserve", mcpServers: { existing: { command: "existing-server" } } }));
      }
      const result = await setupAgent({ directory: f.directory, agent, cliPath: f.cliPath });
      const expected = { command: process.execPath, args: [f.cliPath, "mcp", "serve", "--stdio", "--agent", agent], transport: "stdio" };
      assert.deepEqual(result.broker, expected);
      const manifest: unknown = JSON.parse(await readFile(join(f.directory, ".anyam/agents/manifest.json"), "utf8"));
      assert.deepEqual(manifest, { protocol: result.protocol, agent, broker: expected, credentialStorage: "memory-only", canonicalWrite: false });

      // Run the selected script through the generated argv, rather than a shell
      // or an assumed globally installed anyam executable.
      const launched = await execFile(result.broker.command, [...result.broker.args], { cwd: f.directory, env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {} });
      const received: unknown = JSON.parse(launched.stdout);
      assert.deepEqual(received, ["mcp", "serve", "--stdio", "--agent", agent]);
      if (agent === "codex") {
        const configured = await readFile(configPath, "utf8");
        assert.ok(configured.startsWith('model = "preserve-model"\n'));
        assert.ok(configured.includes(`command = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(expected.args)}\n`));
        await setupAgent({ directory: f.directory, agent, cliPath: f.cliPath });
        assert.equal(await readFile(configPath, "utf8"), configured);
      } else if (agent !== "cli") {
        const configured: unknown = JSON.parse(await readFile(configPath, "utf8"));
        assert.deepEqual(configured, { setting: "preserve", mcpServers: { existing: { command: "existing-server" }, anyam: { command: expected.command, args: expected.args } } });
        await setupAgent({ directory: f.directory, agent, cliPath: f.cliPath });
        const repeated: unknown = JSON.parse(await readFile(configPath, "utf8"));
        assert.deepEqual(repeated, configured);
      }
      await assert.rejects(access(join(f.directory, ".anyam/agents/state.json")), { code: "ENOENT" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const kind of ["missing", "directory"] as const) {
  test(`agent setup refuses a ${kind} selected CLI before writing configuration`, async () => {
    const f = await fixture();
    try {
      const cliPath = kind === "missing" ? join(f.root, "missing.js") : f.root;
      await assert.rejects(setupAgent({ directory: f.directory, agent: "claude", cliPath }), (error: unknown) => error instanceof LocalAgentError && error.code === "agent.setup.cli_unavailable");
      await assert.rejects(access(join(f.directory, ".anyam")), { code: "ENOENT" });
      await assert.rejects(access(join(f.directory, ".mcp.json")), { code: "ENOENT" });
      await assert.rejects(access(join(f.directory, "AGENTS.md")), { code: "ENOENT" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("an explicit CLI selection refuses an incompatible existing Codex server before setup writes", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, ".codex/config.toml");
    await mkdir(dirname(path));
    const original = '[mcp_servers.anyam]\ncommand = "existing-cli"\nargs = []\n';
    await writeFile(path, original);
    await assert.rejects(setupAgent({ directory: f.directory, agent: "codex", cliPath: f.cliPath }), (error: unknown) => error instanceof LocalAgentError && error.code === "agent.setup.broker_conflict");
    assert.equal(await readFile(path, "utf8"), original);
    await assert.rejects(access(join(f.directory, ".anyam")), { code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("CLI agent setup resolves one selected CLI relative to the invocation directory", async () => {
  const f = await fixture();
  try {
    assert.equal(await main(["agent", "setup", "claude", f.directory, "--cli-path", basename(f.cliPath), "--json"], f.root), 0);
    const configured: unknown = JSON.parse(await readFile(join(f.directory, ".mcp.json"), "utf8"));
    assert.deepEqual(configured, { mcpServers: { anyam: { command: process.execPath, args: [f.cliPath, "mcp", "serve", "--stdio", "--agent", "claude"] } } });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("CLI agent setup rejects duplicate or missing CLI path options before writing files", async () => {
  const f = await fixture();
  try {
    for (const suffix of [["--cli-path"], ["--cli-path", f.cliPath, "--cli-path", f.cliPath]]) {
      await assert.rejects(main(["agent", "setup", "cli", f.directory, ...suffix], f.root), /--cli-path requires one/u);
      await assert.rejects(access(join(f.directory, ".anyam")), { code: "ENOENT" });
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const definition of [
  '[mcp_servers."anyam"]\ncommand = "existing-cli"\nargs = []\n',
  '[mcp_servers . anyam]\ncommand = "existing-cli"\nargs = []\n',
  'mcp_servers.anyam.command = "existing-cli"\nmcp_servers.anyam.args = []\n',
  'mcp_servers = { anyam = { command = "existing-cli", args = [] } }\n',
]) {
  test(`selected CLI detects an existing Codex launcher defined as ${definition.split("\n")[0]}`, async () => {
    const f = await fixture();
    try {
      const configPath = join(f.directory, ".codex/config.toml");
      await mkdir(dirname(configPath));
      await writeFile(configPath, definition);
      await assert.rejects(setupAgent({ directory: f.directory, agent: "codex", cliPath: f.cliPath }), (error: unknown) => error instanceof LocalAgentError && error.code === "agent.setup.broker_conflict");
      assert.equal(await readFile(configPath, "utf8"), definition);
      await assert.rejects(access(join(f.directory, ".anyam")), { code: "ENOENT" });
      await assert.rejects(access(join(f.directory, "AGENTS.md")), { code: "ENOENT" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("selected CLI preserves equivalent Codex settings, comments and CRLF bytes", async () => {
  const f = await fixture();
  try {
    const configPath = join(f.directory, ".codex/config.toml");
    const args = [f.cliPath, "mcp", "serve", "--stdio", "--agent", "codex"];
    const original = [
      "unrelated_counter = 9223372036854775807",
      "# Existing model and server controls belong to the user.",
      '[mcp_servers."anyam"]',
      `args = ${JSON.stringify(args)} # keep this comment`,
      "enabled = false",
      `command = ${JSON.stringify(process.execPath)}`,
      "startup_timeout_sec = 20",
      "[mcp_servers.anyam.env]",
      'EXAMPLE = "preserve"',
      "[mcp_servers.other]",
      'command = "other-cli"',
      "",
    ].join("\r\n");
    await mkdir(dirname(configPath));
    await writeFile(configPath, original);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const result = await setupAgent({ directory: f.directory, agent: "codex", cliPath: f.cliPath });
      assert.deepEqual(result.broker.args, args);
      assert.equal(await readFile(configPath, "utf8"), original);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("default setup preserves a quoted existing Codex server without a duplicate table", async () => {
  const f = await fixture();
  try {
    const configPath = join(f.directory, ".codex/config.toml");
    const original = '[mcp_servers."anyam"]\ncommand = "existing-cli"\nargs = []\n';
    await mkdir(dirname(configPath));
    await writeFile(configPath, original);
    await setupAgent({ directory: f.directory, agent: "codex" });
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const definition of [
  'secret_marker = "SYNTHETIC_PRIVATE_VALUE"\n[mcp_servers.anyam\n',
  'mcp_servers = "SYNTHETIC_PRIVATE_VALUE"\n',
  "mcp_servers = []\n",
  "mcp_servers = 2026-10-12\n",
  'mcp_servers = { other = { command = "other-cli" } }\n',
]) {
  test(`Codex configuration preflight refuses an invalid or unextendable table: ${definition.split("\n")[0]}`, async () => {
    const f = await fixture();
    try {
      const configPath = join(f.directory, ".codex/config.toml");
      await mkdir(dirname(configPath));
      await writeFile(configPath, definition);
      await assert.rejects(setupAgent({ directory: f.directory, agent: "codex", cliPath: f.cliPath }), (error: unknown) => {
        assert.ok(error instanceof LocalAgentError);
        assert.equal(error.code, "agent.setup.config_invalid");
        assert.ok(!JSON.stringify(error).includes("SYNTHETIC_PRIVATE_VALUE"));
        assert.ok(!error.message.includes("SYNTHETIC_PRIVATE_VALUE"));
        return true;
      });
      assert.equal(await readFile(configPath, "utf8"), definition);
      await assert.rejects(access(join(f.directory, ".anyam")), { code: "ENOENT" });
      await assert.rejects(access(join(f.directory, "AGENTS.md")), { code: "ENOENT" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}
