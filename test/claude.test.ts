import assert from "node:assert/strict";
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
