import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { copilot } from "../src/adapters/copilot.ts";

test("resolves ~/.copilot under the home directory", () => {
  const home = path.join("home", "me");
  assert.equal(copilot.resolveHome({}, home), path.join(home, ".copilot"));
});

test("honors COPILOT_HOME", () => {
  assert.equal(copilot.resolveHome({ COPILOT_HOME: "custom" }, "home"), path.resolve("custom"));
});

test("empty COPILOT_HOME falls back to ~/.copilot", () => {
  assert.equal(copilot.resolveHome({ COPILOT_HOME: "" }, "home"), path.join("home", ".copilot"));
});

test("allowlist and blocked names are disjoint", () => {
  for (const name of copilot.blocked) {
    assert.ok(!copilot.allowlist.includes(name), name);
  }
});

test("allowlist includes every expected Copilot path", () => {
  for (const name of ["settings.json", "agents", "skills", "installed-plugins", "installed-plugins.lock"]) {
    assert.ok(copilot.allowlist.includes(name), name);
  }
  assert.equal(copilot.allowlist.length, 5);
});

test("blocked includes every expected machine-local Copilot path", () => {
  for (const name of [
    "config.json",
    "plugin-data",
    "session-state",
    "session-store.db",
    "session-store.db-shm",
    "session-store.db-wal",
    "logs",
    "ide",
    "command-history-state.json",
    "open-sessions-state.json",
    "sidebar-sessions-state",
    "servers",
    "config.json.trusted-folders.lock",
    "settings.json.lock",
  ]) {
    assert.ok(copilot.blocked.includes(name), name);
  }
  assert.equal(copilot.blocked.length, 14);
});
