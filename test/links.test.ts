import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adapters, globalAdapters } from "../src/adapters/index.ts";
import { isValidLinkName, LINKS_FILE, restoreSkillLinks, scanSkillLinks, writeLinksManifest } from "../src/links.ts";

test("link names that could escape the skills folder are invalid", () => {
  for (const name of ["", ".", "..", "a/b", "a\\b"]) assert.equal(isValidLinkName(name), false, name);
  assert.equal(isValidLinkName("my-skill"), true);
});

test("skillLinks dirs of every adapter stay inside the tool home", () => {
  for (const adapter of [...Object.values(adapters), ...globalAdapters]) {
    if (!adapter.skillLinks) continue;
    const { dir } = adapter.skillLinks;
    assert.notEqual(dir, "", adapter.name);
    assert.equal(path.isAbsolute(dir) || path.win32.isAbsolute(dir), false, adapter.name);
    assert.equal(dir.split(/[\\/]/).includes(".."), false, adapter.name);
  }
});

test("skill links round-trip through a tool-specific folder and manifest key", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ark-links-"));
  try {
    const [home, agents, sync] = ["home", "agents", "sync"].map((name) => path.join(root, name));
    const target = { tool: "fake", home, dir: "other-skills" };
    await fs.mkdir(path.join(agents, "skills", "real"), { recursive: true });
    await fs.mkdir(path.join(home, "other-skills"), { recursive: true });
    await fs.mkdir(sync);
    await fs.symlink(path.join(agents, "skills", "real"), path.join(home, "other-skills", "alias"), "dir");

    const links = await scanSkillLinks(target, agents);
    assert.deepEqual(links, [{ link: "alias", target: "real" }]);
    await writeLinksManifest(sync, target.tool, links, false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(sync, LINKS_FILE), "utf8")), { fake: links });

    await fs.rm(path.join(home, "other-skills", "alias"));
    const changes = await restoreSkillLinks(sync, target, agents, false);
    assert.deepEqual(changes, [{ file: path.join("other-skills", "alias"), kind: "link" }]);
    assert.equal(await fs.realpath(path.join(home, "other-skills", "alias")), await fs.realpath(path.join(agents, "skills", "real")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function withManifest(raw: string | undefined, run: (sync: string, file: string) => Promise<void>): Promise<void> {
  const sync = await fs.mkdtemp(path.join(os.tmpdir(), "ark-links-"));
  try {
    const file = path.join(sync, LINKS_FILE);
    if (raw !== undefined) await fs.writeFile(file, raw);
    await run(sync, file);
  } finally {
    await fs.rm(sync, { recursive: true, force: true });
  }
}

test("writing one tool's links keeps the other tools' keys", async () => {
  const claude = [{ link: "a", target: "b" }];
  await withManifest(JSON.stringify({ claude }, null, 2) + "\n", async (sync, file) => {
    await writeLinksManifest(sync, "fake", [{ link: "c", target: "d" }], false);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { claude, fake: [{ link: "c", target: "d" }] });
    await writeLinksManifest(sync, "fake", [], false);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { claude, fake: [] });
  });
  await withManifest('{"claude": "whatever"}', async (sync, file) => {
    assert.equal(await writeLinksManifest(sync, "fake", [], false).then((change) => change?.kind), "update");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { claude: "whatever", fake: [] });
  });
});

test("writing a manifest that is malformed throws and leaves it untouched", async () => {
  for (const raw of ["{not json", "[]", "null", "3"]) {
    await withManifest(raw, async (sync, file) => {
      await assert.rejects(writeLinksManifest(sync, "fake", [{ link: "a", target: "b" }], false), /links\.json/, raw);
      assert.equal(await fs.readFile(file, "utf8"), raw);
    });
  }
});

test("restore ignores a manifest that has no key for the tool", async () => {
  for (const raw of ['{"claude": "x"}', '{"claude": [{"link": "a", "target": "b"}]}', "{}"]) {
    await withManifest(raw, async (sync) => {
      const home = path.join(sync, "home");
      assert.deepEqual(await restoreSkillLinks(sync, { tool: "fake", home, dir: "s" }, path.join(sync, "agents"), false), [], raw);
    });
  }
});
