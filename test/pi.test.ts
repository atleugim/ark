import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pi } from "../src/adapters/pi.ts";

test("resolves ~/.pi/agent under the home directory", () => {
  const home = path.join("home", "me");
  assert.equal(pi.resolveHome({}, home), path.join(home, ".pi", "agent"));
});

test("honors PI_CODING_AGENT_DIR", () => {
  assert.equal(pi.resolveHome({ PI_CODING_AGENT_DIR: path.resolve("pi") }, "home"), path.resolve("pi"));
});

test("relative PI_CODING_AGENT_DIR is resolved", () => {
  assert.equal(pi.resolveHome({ PI_CODING_AGENT_DIR: "pi" }, "home"), path.resolve("pi"));
});

test("empty PI_CODING_AGENT_DIR falls back to ~/.pi/agent", () => {
  assert.equal(pi.resolveHome({ PI_CODING_AGENT_DIR: "" }, "home"), path.join("home", ".pi", "agent"));
});

test("allowlist and blocked names are disjoint", () => {
  for (const name of pi.blocked) {
    assert.ok(!pi.allowlist.includes(name), name);
  }
});

test("allowlist includes every expected pi path", () => {
  for (const name of ["AGENTS.md", "settings.json", "agents", "agents_docs", "extensions", "prompts", "skills"]) {
    assert.ok(pi.allowlist.includes(name), name);
  }
  assert.equal(pi.allowlist.length, 7);
});

test("blocked includes every expected machine-local pi path", () => {
  for (const name of ["auth.json", "models-store.json", "sessions", "install", "bin", "mcp-auth.json", "trust.json", "mcp.log", "mcp.log.1", "tmp"]) {
    assert.ok(pi.blocked.includes(name), name);
  }
  assert.equal(pi.blocked.length, 10);
});

test("links skills and has no transform or activeFilter", () => {
  assert.deepEqual(pi.skillLinks, { dir: "skills" });
  assert.equal(pi.transform, undefined);
  assert.equal(pi.activeFilter, undefined);
});
