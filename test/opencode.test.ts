import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { opencode } from "../src/adapters/opencode.ts";

test("resolves ~/.config/opencode under the home directory", () => {
  const home = path.join("home", "me");
  assert.equal(opencode.resolveHome({}, home), path.join(home, ".config", "opencode"));
});

test("honors XDG_CONFIG_HOME", () => {
  assert.equal(opencode.resolveHome({ XDG_CONFIG_HOME: path.resolve("xdg") }, "home"), path.join(path.resolve("xdg"), "opencode"));
});

test("relative XDG_CONFIG_HOME is resolved", () => {
  assert.equal(opencode.resolveHome({ XDG_CONFIG_HOME: "xdg" }, "home"), path.join(path.resolve("xdg"), "opencode"));
});

test("empty XDG_CONFIG_HOME falls back to ~/.config/opencode", () => {
  assert.equal(opencode.resolveHome({ XDG_CONFIG_HOME: "" }, "home"), path.join("home", ".config", "opencode"));
});

test("allowlist and blocked names are disjoint", () => {
  for (const name of opencode.blocked) {
    assert.ok(!opencode.allowlist.includes(name), name);
  }
});

test("allowlist includes every expected OpenCode path", () => {
  for (const name of ["opencode.json", "opencode.jsonc", "cli.json", "AGENTS.md", "agents", "commands", "skills", "plugins"]) {
    assert.ok(opencode.allowlist.includes(name), name);
  }
  assert.equal(opencode.allowlist.length, 8);
});

test("blocked includes every expected machine-local OpenCode path", () => {
  for (const name of ["service.json", "node_modules", "package.json", "bun.lock", "package-lock.json", "pnpm-lock.yaml"]) {
    assert.ok(opencode.blocked.includes(name), name);
  }
  assert.equal(opencode.blocked.length, 6);
});

test("links skills and has no transform or activeFilter", () => {
  assert.deepEqual(opencode.skillLinks, { dir: "skills" });
  assert.equal(opencode.transform, undefined);
  assert.equal(opencode.activeFilter, undefined);
});
