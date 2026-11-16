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
  for (const name of [".credentials.json", "settings.local.json", "projects", "sessions", "history.jsonl", "todos", "statsig", "shell-snapshots"]) {
    assert.ok(!claude.allowlist.includes(name), name);
  }
  assert.ok(claude.allowlist.includes("settings.json"));
});
