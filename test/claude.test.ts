import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claude } from "../src/adapters/claude.ts";

test("resolves ~/.claude under the home directory", () => {
  const home = path.join("home", "me");
  assert.equal(claude.resolveHome({}, home), path.join(home, ".claude"));
});

test("honors CLAUDE_CONFIG_DIR", () => {
  assert.equal(claude.resolveHome({ CLAUDE_CONFIG_DIR: "custom" }, "home"), path.resolve("custom"));
});

test("allowlist excludes credentials and machine-local state", () => {
  for (const name of claude.blocked) {
    assert.ok(!claude.allowlist.includes(name), name);
  }
  for (const name of [".credentials.json", "settings.local.json", "projects", "sessions", "history.jsonl", "todos", "statsig", "shell-snapshots"]) {
    assert.ok(claude.blocked.includes(name), name);
  }
  assert.ok(claude.allowlist.includes("settings.json"));
});

test("allowlist includes plugin manifests and cache but not the marketplace clones", () => {
  for (const name of ["plugins/installed_plugins.json", "plugins/known_marketplaces.json", "plugins/cache"]) {
    assert.ok(claude.allowlist.includes(name), name);
  }
  assert.ok(!claude.allowlist.includes("plugins"));
  assert.ok(!claude.allowlist.includes("plugins/marketplaces"));
});

const manifest = "plugins/installed_plugins.json";
const transform = (direction: "backup" | "restore", file: string, text: string, home: string) => {
  assert.ok(claude.transform);
  return claude.transform(direction, file, Buffer.from(text), home).toString();
};

test("backup replaces the local root with CLAUDE_HOME in both manifests", () => {
  const home = "/Users/x/.claude";
  for (const file of [manifest, "plugins/known_marketplaces.json"]) {
    const text = JSON.stringify({ installPath: `${home}/plugins/cache/p`, other: home });
    const out = transform("backup", file, text, home);
    assert.ok(!out.includes(home));
    assert.equal(out, JSON.stringify({ installPath: "CLAUDE_HOME/plugins/cache/p", other: "CLAUDE_HOME" }));
  }
});

test("restore expands CLAUDE_HOME and a same-machine round trip is byte-identical", () => {
  const home = "/Users/x/.claude";
  const text = JSON.stringify({ installPath: `${home}/plugins/cache/p` }, null, 2);
  const stored = transform("backup", manifest, text, home);
  assert.equal(transform("restore", manifest, stored, home), text);
});

test("other files are copied unchanged", () => {
  const home = "/Users/x/.claude";
  const text = JSON.stringify({ p: home });
  assert.equal(transform("backup", "settings.json", text, home), text);
  assert.equal(transform("backup", "plugins/cache/a/b.json", text, home), text);
});

test("invalid JSON manifests are copied unchanged", () => {
  const home = "/Users/x/.claude";
  const text = `{ "p": "${home}/x", `;
  assert.equal(transform("backup", manifest, text, home), text);
  assert.equal(transform("restore", manifest, "{ CLAUDE_HOME", home), "{ CLAUDE_HOME");
});

test("only replaces the root at a path boundary", () => {
  const home = "/Users/x/.claude";
  const text = JSON.stringify({ p: `${home}-other/x` });
  assert.equal(transform("backup", manifest, text, home), text);
});

test("Windows roots are matched and restored in JSON-escaped form", () => {
  const home = "C:\\Users\\x\\.claude";
  const text = JSON.stringify({ p: `${home}\\plugins\\cache` });
  const stored = transform("backup", manifest, text, home);
  assert.equal(stored, JSON.stringify({ p: "CLAUDE_HOME\\plugins\\cache" }));
  assert.equal(transform("restore", manifest, stored, home), text);
  assert.deepEqual(JSON.parse(transform("restore", manifest, stored, home)), { p: `${home}\\plugins\\cache` });
});

const activeFilter = async (files: Record<string, string>) => {
  assert.ok(claude.activeFilter);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ark-active-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), text.replaceAll("<ROOT>", JSON.stringify(dir).slice(1, -1)));
    }
    return await claude.activeFilter(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};
const v2 = (...installs: string[]) =>
  JSON.stringify({ version: 2, plugins: { "p@m": installs.map((installPath) => ({ scope: "user", installPath })) } });

test("activeFilter keeps only the version installPath points to", async () => {
  const keep = await activeFilter({ [manifest]: v2("<ROOT>/plugins/cache/m/p/0.6.16") });
  assert.ok(keep);
  assert.equal(keep("plugins/cache/m/p/0.6.16/a.md"), true);
  assert.equal(keep("plugins/cache/m/p/0.6.14/a.md"), false);
  assert.equal(keep("plugins/cache/m/p/0.6.14/skills/b/SKILL.md"), false);
});

test("activeFilter treats the CLAUDE_HOME placeholder like the local root, with either slash", async () => {
  for (const installPath of ["CLAUDE_HOME/plugins/cache/m/p/0.6.16", "CLAUDE_HOME\\plugins\\cache\\m\\p\\0.6.16"]) {
    const keep = await activeFilter({ [manifest]: v2(installPath) });
    assert.ok(keep);
    assert.equal(keep(path.join("plugins", "cache", "m", "p", "0.6.16", "a.md")), true);
    assert.equal(keep(path.join("plugins", "cache", "m", "p", "0.6.14", "a.md")), false);
  }
});

test("activeFilter keeps every version installed in some scope", async () => {
  const keep = await activeFilter({
    [manifest]: v2("CLAUDE_HOME/plugins/cache/m/p/1.0.0", "CLAUDE_HOME/plugins/cache/m/p/2.0.0"),
  });
  assert.ok(keep);
  assert.equal(keep("plugins/cache/m/p/1.0.0/a"), true);
  assert.equal(keep("plugins/cache/m/p/2.0.0/a"), true);
  assert.equal(keep("plugins/cache/m/p/0.9.0/a"), false);
});

test("activeFilter ignores installPaths that are not plugins/cache/<m>/<p>/<v>", async () => {
  const keep = await activeFilter({
    [manifest]: v2("CLAUDE_HOME/plugins/cache/m/p", "/elsewhere/plugins/cache/m/p/1.0.0", "CLAUDE_HOME/plugins/cache/m/p/1.0.0/deep"),
  });
  assert.equal(keep, undefined);
});

test("activeFilter leaves unlisted plugins, plugin-level files and other paths alone", async () => {
  const keep = await activeFilter({ [manifest]: v2("CLAUDE_HOME/plugins/cache/m/p/1.0.0") });
  assert.ok(keep);
  assert.equal(keep("plugins/cache/m/other/0.1.0/a"), true);
  assert.equal(keep("plugins/cache/m/p/notes.txt"), true);
  assert.equal(keep("plugins/installed_plugins.json"), true);
  assert.equal(keep("settings.json"), true);
});

test("activeFilter compares case-insensitively like pathKey", async () => {
  const keep = await activeFilter({ [manifest]: v2("CLAUDE_HOME/plugins/cache/M/P/1.0.0") });
  assert.ok(keep);
  assert.equal(keep("plugins/cache/m/p/1.0.0/a"), true);
  assert.equal(keep("plugins/cache/m/p/0.9.0/a"), false);
});

test("activeFilter is permissive when the manifest is missing, invalid or lists nothing", async () => {
  assert.equal(await activeFilter({}), undefined);
  assert.equal(await activeFilter({ [manifest]: "{ nope" }), undefined);
  assert.equal(await activeFilter({ [manifest]: "{}" }), undefined);
});
