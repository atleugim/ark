import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { agents } from "../src/adapters/agents.ts";

test("agents resolves to ~/.agents", () => {
  assert.equal(agents.resolveHome({}, "home"), path.join("home", ".agents"));
});

test("agents allowlist is skills, docs and the skill lock", () => {
  assert.deepEqual([...agents.allowlist].sort(), [".skill-lock.json", "docs", "skills"]);
});
