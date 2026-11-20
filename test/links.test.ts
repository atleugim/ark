import assert from "node:assert/strict";
import test from "node:test";
import { isValidLinkName } from "../src/links.ts";

test("link names that could escape the skills folder are invalid", () => {
  for (const name of ["", ".", "..", "a/b", "a\\b"]) assert.equal(isValidLinkName(name), false, name);
  assert.equal(isValidLinkName("my-skill"), true);
});
