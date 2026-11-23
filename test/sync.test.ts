import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { claude } from "../src/adapters/claude.ts";
import { addIncludes, defaultRepoDir, readIncludes, resolveRepoDir, saveRepoDir } from "../src/config.ts";
import { copyFiles, isBlocked, listFiles, listTopLevel, normalizeUserPath } from "../src/sync.ts";

async function tmp(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ark-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(root: string, rel: string, data: string): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

test("listFiles only returns allowlisted files, including nested ones", async (t) => {
  const root = await tmp(t);
  await write(root, "settings.json", "{}");
  await write(root, "agents/a/b.md", "x");
  await write(root, ".credentials.json", "secret");
  await write(root, "projects/p/log.jsonl", "x");
  await write(root, "history.jsonl", "x");
  const files = await listFiles(root, claude.allowlist);
  assert.deepEqual(files, [path.join("agents", "a", "b.md"), "settings.json"]);
});

test("listFiles skips OS metadata files", async (t) => {
  const root = await tmp(t);
  await write(root, "skills/a/SKILL.md", "x");
  await write(root, "skills/.DS_Store", "x");
  await write(root, "skills/a/._SKILL.md", "x");
  await write(root, "skills/a/Thumbs.db", "x");
  await write(root, "skills/a/desktop.ini", "x");
  const files = await listFiles(root, claude.allowlist);
  assert.deepEqual(files, [path.join("skills", "a", "SKILL.md")]);
});

test("backup copies allowlisted files and never credentials", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "CLAUDE.md", "hello");
  await write(local, ".credentials.json", "secret");
  const changes = await copyFiles(local, remote, claude.allowlist, { dryRun: false });
  assert.deepEqual(changes, [{ file: "CLAUDE.md", kind: "new" }]);
  assert.equal(await fs.readFile(path.join(remote, "CLAUDE.md"), "utf8"), "hello");
  assert.deepEqual(await fs.readdir(remote), ["CLAUDE.md"]);
});

test("dry run reports changes without writing", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "CLAUDE.md", "hello");
  const changes = await copyFiles(local, remote, claude.allowlist, { dryRun: true });
  assert.equal(changes.length, 1);
  assert.deepEqual(await fs.readdir(remote), []);
});

test("restore backs up a differing local file outside the synced dirs", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  const backups = await tmp(t);
  await write(local, "agents/a.md", "old");
  await write(remote, "agents/a.md", "new");
  const backupDir = path.join(backups, "stamp");
  const changes = await copyFiles(remote, local, claude.allowlist, { dryRun: false, backupDir });
  assert.deepEqual(changes, [{ file: path.join("agents", "a.md"), kind: "update" }]);
  assert.equal(await fs.readFile(path.join(local, "agents", "a.md"), "utf8"), "new");
  assert.equal(await fs.readFile(path.join(backupDir, "agents", "a.md"), "utf8"), "old");
  // A later push must not pick up any backup.
  const pushed = await copyFiles(local, await tmp(t), claude.allowlist, { dryRun: true });
  assert.deepEqual(pushed.map((c) => c.file), [path.join("agents", "a.md")]);
});

test("backup refuses to write through a symlink in the sync dir", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  const outside = await tmp(t);
  await write(local, "agents/a.md", "x");
  await fs.symlink(outside, path.join(remote, "agents"), "junction");
  await assert.rejects(
    copyFiles(local, remote, claude.allowlist, { dryRun: false, guardDest: true }),
    /symlink/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("backup refuses a symlinked tool dir inside the sync dir", async (t) => {
  const local = await tmp(t);
  const shared = await tmp(t);
  const outside = await tmp(t);
  await write(local, "agents/a.md", "x");
  const remote = path.join(shared, "claude");
  await fs.symlink(outside, remote, "junction");
  await assert.rejects(copyFiles(local, remote, claude.allowlist, { dryRun: false, guardDest: true }), /symlink/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("restore writes through a symlinked local file and keeps the link", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  const dotfiles = await tmp(t);
  await write(dotfiles, "CLAUDE.md", "old");
  await write(remote, "CLAUDE.md", "new");
  await fs.symlink(path.join(dotfiles, "CLAUDE.md"), path.join(local, "CLAUDE.md"));
  await copyFiles(remote, local, claude.allowlist, { dryRun: false });
  assert.ok((await fs.lstat(path.join(local, "CLAUDE.md"))).isSymbolicLink());
  assert.equal(await fs.readFile(path.join(dotfiles, "CLAUDE.md"), "utf8"), "new");
});

test("listFiles skips symlinked files and directories", async (t) => {
  const root = await tmp(t);
  const outside = await tmp(t);
  await write(outside, "secret.md", "s");
  await write(root, "agents/real.md", "r");
  await fs.symlink(path.join(outside, "secret.md"), path.join(root, "agents", "link.md"));
  await fs.symlink(outside, path.join(root, "agents", "linkdir"), "junction");
  await fs.symlink(outside, path.join(root, "skills"), "junction");
  assert.deepEqual(await listFiles(root, claude.allowlist), [path.join("agents", "real.md")]);
});

test("listFiles skips nested allowlist entries under a symlinked parent", async (t) => {
  const root = await tmp(t);
  const outside = await tmp(t);
  await write(outside, "cache/x.txt", "x");
  await write(outside, "installed_plugins.json", "{}");
  await fs.symlink(outside, path.join(root, "plugins"), "junction");
  assert.deepEqual(await listFiles(root, claude.allowlist), []);
});

test("listFiles skips nested allowlist entries when the parent is a regular file", async (t) => {
  const root = await tmp(t);
  await write(root, "plugins", "not a dir");
  assert.deepEqual(await listFiles(root, claude.allowlist), []);
});

test("identical files are skipped and not backed up", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "settings.json", "same");
  await write(remote, "settings.json", "same");
  const changes = await copyFiles(remote, local, claude.allowlist, { dryRun: false, backupDir: path.join(local, "..", "unused-backup") });
  assert.deepEqual(changes, []);
  assert.deepEqual(await fs.readdir(local), ["settings.json"]);
});

const upper = (_file: string, data: Buffer): Buffer => Buffer.from(data.toString().toUpperCase());

test("transform result is compared and written, and equal results are skipped", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "settings.json", "abc");
  await write(remote, "settings.json", "ABC");
  const same = await copyFiles(local, remote, claude.allowlist, { dryRun: false, transform: upper });
  assert.deepEqual(same, []);
  await write(local, "settings.json", "xyz");
  const changes = await copyFiles(local, remote, claude.allowlist, { dryRun: false, transform: upper });
  assert.deepEqual(changes, [{ file: "settings.json", kind: "update" }]);
  assert.equal(await fs.readFile(path.join(remote, "settings.json"), "utf8"), "XYZ");
});

test("transform keeps raw destination bytes in the backup", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  const backupDir = path.join(await tmp(t), "backup");
  await write(remote, "settings.json", "abc");
  await write(local, "settings.json", "old");
  await copyFiles(remote, local, claude.allowlist, { dryRun: false, backupDir, transform: upper });
  assert.equal(await fs.readFile(path.join(backupDir, "settings.json"), "utf8"), "old");
  assert.equal(await fs.readFile(path.join(local, "settings.json"), "utf8"), "ABC");
});

test("transform dry run reports on the transformed comparison and writes nothing", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "settings.json", "abc");
  const changes = await copyFiles(local, remote, claude.allowlist, { dryRun: true, transform: upper });
  assert.deepEqual(changes, [{ file: "settings.json", kind: "new" }]);
  assert.deepEqual(await fs.readdir(remote), []);
});

test("repo dir defaults to ~/.ark/repo", async (t) => {
  const home = await tmp(t);
  assert.equal(await resolveRepoDir({ homedir: home }), path.join(home, ".ark", "repo"));
  assert.equal(defaultRepoDir(home), path.join(home, ".ark", "repo"));
});

test("repo dir: flag wins over the saved value", async (t) => {
  const home = await tmp(t);
  await saveRepoDir(home, path.join(home, "saved"));
  assert.equal(await resolveRepoDir({ homedir: home }), path.join(home, "saved"));
  const dir = path.join(home, "flag");
  assert.equal(await resolveRepoDir({ flag: dir, homedir: home }), dir);
});

test("includes: missing config has none and bad values are ignored", async (t) => {
  const home = await tmp(t);
  assert.deepEqual(await readIncludes(home, "claude"), []);
  await write(home, ".ark/config.json", JSON.stringify({ include: { claude: ["rules", 3, null], other: "x" } }));
  assert.deepEqual(await readIncludes(home, "claude"), ["rules"]);
  assert.deepEqual(await readIncludes(home, "other"), []);
  await write(home, ".ark/config.json", JSON.stringify({ include: "nope" }));
  assert.deepEqual(await readIncludes(home, "claude"), []);
});

test("includes: invalid JSON is rethrown", async (t) => {
  const home = await tmp(t);
  await write(home, ".ark/config.json", "{");
  await assert.rejects(readIncludes(home, "claude"));
});

test("includes: addIncludes dedupes case-insensitively and keeps other keys", async (t) => {
  const home = await tmp(t);
  await saveRepoDir(home, "/r");
  await addIncludes(home, "claude", ["rules", "docs/a"]);
  await addIncludes(home, "claude", ["Rules", "docs/a", "x"]);
  const config = JSON.parse(await fs.readFile(path.join(home, ".ark", "config.json"), "utf8"));
  assert.deepEqual(config, { repo: "/r", include: { claude: ["rules", "docs/a", "x"] } });
});

test("saveRepoDir keeps saved includes", async (t) => {
  const home = await tmp(t);
  await addIncludes(home, "claude", ["rules"]);
  await saveRepoDir(home, "/new");
  const config = JSON.parse(await fs.readFile(path.join(home, ".ark", "config.json"), "utf8"));
  assert.deepEqual(config, { repo: "/new", include: { claude: ["rules"] } });
});

test("backup prunes files gone from the source and removes emptied dirs", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(remote, "plugins/cache/p/1.0/x", "old");
  await write(local, "plugins/cache/p/2.0/x", "new");
  const changes = await copyFiles(local, remote, claude.allowlist, { dryRun: false, guardDest: true });
  assert.deepEqual(changes, [
    { file: path.join("plugins", "cache", "p", "2.0", "x"), kind: "new" },
    { file: path.join("plugins", "cache", "p", "1.0", "x"), kind: "delete" },
  ]);
  assert.deepEqual(await fs.readdir(path.join(remote, "plugins", "cache", "p")), ["2.0"]);
  assert.deepEqual(await copyFiles(local, remote, claude.allowlist, { dryRun: false, guardDest: true }), []);
});

const manifestFor = (root: string, version: string) =>
  JSON.stringify({ plugins: { "p@m": [{ installPath: path.join(root, "plugins", "cache", "m", "p", version) }] } });

test("backup copies only the active plugin version and prunes the stale one", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "plugins/installed_plugins.json", manifestFor(local, "0.6.16"));
  await write(local, "plugins/cache/m/p/0.6.14/x", "old");
  await write(local, "plugins/cache/m/p/0.6.16/x", "new");
  await write(remote, "plugins/cache/m/p/0.6.14/x", "old");
  const filter = await claude.activeFilter?.(local);
  const changes = await copyFiles(local, remote, claude.allowlist, { dryRun: false, guardDest: true, filter });
  assert.ok(changes.some((c) => c.kind === "delete" && c.file === path.join("plugins", "cache", "m", "p", "0.6.14", "x")));
  assert.deepEqual(await fs.readdir(path.join(remote, "plugins", "cache", "m", "p")), ["0.6.16"]);
  assert.deepEqual(await copyFiles(local, remote, claude.allowlist, { dryRun: false, guardDest: true, filter }), []);
});

test("restore skips non-active versions from a placeholder manifest and dry-run changes nothing", async (t) => {
  const remote = await tmp(t);
  const local = await tmp(t);
  await write(remote, "plugins/installed_plugins.json", manifestFor("CLAUDE_HOME", "0.6.16"));
  await write(remote, "plugins/cache/m/p/0.6.14/x", "old");
  await write(remote, "plugins/cache/m/p/0.6.16/x", "new");
  const filter = await claude.activeFilter?.(remote);
  const dry = await copyFiles(remote, local, ["plugins"], { dryRun: true, filter });
  assert.ok(!dry.some((c) => c.file.includes("0.6.14")));
  await assert.rejects(fs.stat(path.join(local, "plugins")));
  await copyFiles(remote, local, ["plugins"], { dryRun: false, filter });
  assert.deepEqual(await fs.readdir(path.join(local, "plugins", "cache", "m", "p")), ["0.6.16"]);
});

test("restore saves a pruned local file to the backup dir first", async (t) => {
  const remote = await tmp(t);
  const local = await tmp(t);
  const backups = await tmp(t);
  await write(remote, "skills/a/SKILL.md", "kept");
  await write(local, "skills/a/SKILL.md", "kept");
  await write(local, "skills/gone/SKILL.md", "bye");
  await copyFiles(remote, local, claude.allowlist, { dryRun: false, backupDir: backups });
  const file = path.join("skills", "gone", "SKILL.md");
  assert.equal(await fs.readFile(path.join(backups, file), "utf8"), "bye");
  await assert.rejects(fs.stat(path.join(local, file)));
});

test("dry run reports deletions and leaves every file", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "skills/a/SKILL.md", "x");
  await write(remote, "skills/a/SKILL.md", "x");
  await write(remote, "skills/old/SKILL.md", "y");
  const changes = await copyFiles(local, remote, claude.allowlist, { dryRun: true });
  assert.deepEqual(changes, [{ file: path.join("skills", "old", "SKILL.md"), kind: "delete" }]);
  assert.equal(await fs.readFile(path.join(remote, "skills", "old", "SKILL.md"), "utf8"), "y");
});

test("pruning never touches files outside the allowlist", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "CLAUDE.md", "x");
  await write(remote, "CLAUDE.md", "x");
  await write(remote, "README.md", "keep");
  await write(remote, ".credentials.json", "keep");
  assert.deepEqual(await copyFiles(local, remote, claude.allowlist, { dryRun: false }), []);
  assert.deepEqual((await fs.readdir(remote)).sort(), [".credentials.json", "CLAUDE.md", "README.md"]);
});

test("an allowlist entry missing from the source is not pruned", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "CLAUDE.md", "x");
  await write(remote, "skills/a/SKILL.md", "keep");
  assert.deepEqual(await copyFiles(local, remote, claude.allowlist, { dryRun: false }), [
    { file: "CLAUDE.md", kind: "new" },
  ]);
  assert.equal(await fs.readFile(path.join(remote, "skills", "a", "SKILL.md"), "utf8"), "keep");
});

test("an allowlist entry symlinked in the source is not pruned", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  const elsewhere = await tmp(t);
  await write(elsewhere, "a/SKILL.md", "x");
  await fs.symlink(elsewhere, path.join(local, "skills"), "junction");
  await write(remote, "skills/a/SKILL.md", "keep");
  assert.deepEqual(await copyFiles(local, remote, claude.allowlist, { dryRun: false }), []);
  assert.equal(await fs.readFile(path.join(remote, "skills", "a", "SKILL.md"), "utf8"), "keep");
});

test("an empty source directory still prunes its destination files", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await fs.mkdir(path.join(local, "skills"));
  await write(remote, "skills/a/SKILL.md", "x");
  const changes = await copyFiles(local, remote, claude.allowlist, { dryRun: false });
  assert.deepEqual(changes, [{ file: path.join("skills", "a", "SKILL.md"), kind: "delete" }]);
  assert.deepEqual(await fs.readdir(path.join(remote, "skills")), []);
});

test("a case-only difference in a path never prunes the live file", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "skills/Foo/SKILL.md", "x");
  await write(remote, "skills/foo/SKILL.md", "x");
  const opts = { dryRun: false };
  const changes = await copyFiles(local, remote, claude.allowlist, opts);
  assert.equal(changes.some((c) => c.kind === "delete"), false);
  assert.equal(await fs.readFile(path.join(remote, "skills", "foo", "SKILL.md"), "utf8"), "x");
  assert.deepEqual(await copyFiles(local, remote, claude.allowlist, opts), []);
});

test("guardDest refuses to prune through a symlinked destination root", async (t) => {
  const local = await tmp(t);
  const realRemote = await tmp(t);
  const parent = await tmp(t);
  const remote = path.join(parent, "link");
  await fs.mkdir(path.join(local, "skills"));
  await write(realRemote, "skills/a/SKILL.md", "keep");
  await fs.symlink(realRemote, remote, "junction");
  await assert.rejects(copyFiles(local, remote, claude.allowlist, { dryRun: false, guardDest: true }));
  assert.equal(await fs.readFile(path.join(realRemote, "skills", "a", "SKILL.md"), "utf8"), "keep");
});

test("listTopLevel returns entry names, skipping OS junk, and is empty for a missing dir", async (t) => {
  const root = await tmp(t);
  await write(root, "rules/a.md", "x");
  await write(root, "settings.json", "{}");
  await write(root, ".DS_Store", "x");
  await write(root, "._settings.json", "x");
  assert.deepEqual((await listTopLevel(root)).sort(), ["rules", "settings.json"]);
  assert.deepEqual(await listTopLevel(path.join(root, "missing")), []);
});

test("isBlocked matches names ignoring case, normalization and trailing dots or spaces", () => {
  const blocked = [".credentials.json", "projects", "sessions", "settings.local.json", "file-history"];
  const names = ["projects", "Projects", "PROJECTS.", "projects. ", ".Credentials.json"];
  // Full Unicode case folding: APFS/NTFS treat these as the same file.
  names.push("\u017Fessions", "\u017Fettings.local.json", "\uFB01le-history");
  for (const name of names) {
    assert.ok(isBlocked(name, blocked), name);
  }
  for (const name of ["project", "projects.bak", "rules"]) {
    assert.ok(!isBlocked(name, blocked), name);
  }
});

test("normalizeUserPath canonicalizes separators and rejects unsafe paths", () => {
  assert.equal(normalizeUserPath("skills/foo"), path.join("skills", "foo"));
  assert.equal(normalizeUserPath("skills\\foo\\"), path.join("skills", "foo"));
  assert.equal(normalizeUserPath("./settings.json"), "settings.json");
  for (const bad of ["", ".", "./", "/abs", "\\abs", "C:\\x", "../x", "a/../b", "a\\..\\b"]) {
    assert.throws(() => normalizeUserPath(bad), /path/i, JSON.stringify(bad));
  }
});

test("listFiles dedupes overlapping entries", async (t) => {
  const root = await tmp(t);
  await write(root, "skills/a/SKILL.md", "x");
  const files = await listFiles(root, ["skills", "skills/a", "skills/a/SKILL.md"]);
  assert.deepEqual(files, [path.join("skills", "a", "SKILL.md")]);
});

test("listFiles keeps case-distinct files found by one walk", async (t) => {
  const root = await tmp(t);
  await write(root, "d/A.md", "x");
  await write(root, "d/a.md", "y");
  // Probe the filesystem directly: on a case-insensitive one the second write overwrote the first.
  if ((await fs.readFile(path.join(root, "d", "A.md"), "utf8")) !== "x") return t.skip("case-insensitive filesystem");
  const files = await listFiles(root, ["d"]);
  assert.deepEqual(files, [path.join("d", "A.md"), path.join("d", "a.md")]);
});

test("listFiles folds case across overlapping entries", async (t) => {
  const root = await tmp(t);
  await write(root, "d/a.md", "x");
  const caseInsensitive = await fs.stat(path.join(root, "D", "a.md")).then(() => true, () => false);
  if (!caseInsensitive) return t.skip("case-sensitive filesystem");
  assert.deepEqual(await listFiles(root, ["d", "D/a.md"]), [path.join("d", "a.md")]);
});

test("listFiles omits excluded files and directories, ignoring case", async (t) => {
  const root = await tmp(t);
  await write(root, "skills/foo/SKILL.md", "x");
  await write(root, "skills/foobar/SKILL.md", "x");
  await write(root, "settings.json", "{}");
  const files = await listFiles(root, claude.allowlist, ["Skills/FOO", "settings.json"]);
  assert.deepEqual(files, [path.join("skills", "foobar", "SKILL.md")]);
});

test("an excluded path is neither copied nor pruned", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "skills/foo/SKILL.md", "new");
  await write(local, "skills/bar/SKILL.md", "bar");
  await write(remote, "skills/foo/SKILL.md", "old");
  await write(remote, "skills/foo/gone.md", "old");
  const changes = await copyFiles(local, remote, claude.allowlist, { dryRun: false, guardDest: true, exclude: [path.join("skills", "foo")] });
  assert.deepEqual(changes, [{ file: path.join("skills", "bar", "SKILL.md"), kind: "new" }]);
  assert.equal(await fs.readFile(path.join(remote, "skills", "foo", "SKILL.md"), "utf8"), "old");
  assert.equal(await fs.readFile(path.join(remote, "skills", "foo", "gone.md"), "utf8"), "old");
});

test("an excluded file inside an entry is left alone while siblings are pruned", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "skills/a/keep.md", "x");
  await write(remote, "skills/a/keep.md", "x");
  await write(remote, "skills/a/mine.md", "x");
  await write(remote, "skills/a/gone.md", "x");
  const changes = await copyFiles(local, remote, claude.allowlist, { dryRun: false, exclude: [path.join("skills", "a", "mine.md")] });
  assert.deepEqual(changes, [{ file: path.join("skills", "a", "gone.md"), kind: "delete" }]);
  assert.deepEqual((await fs.readdir(path.join(remote, "skills", "a"))).sort(), ["keep.md", "mine.md"]);
});

test("pruneMissing deletes the destination copy of an entry missing from the source", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(local, "CLAUDE.md", "x");
  await write(remote, "skills/a/SKILL.md", "gone");
  assert.deepEqual(await copyFiles(local, remote, claude.allowlist, { dryRun: false, pruneMissing: true }), [
    { file: "CLAUDE.md", kind: "new" },
    { file: path.join("skills", "a", "SKILL.md"), kind: "delete" },
  ]);
  await assert.rejects(fs.stat(path.join(remote, "skills", "a")));
});

test("pruneMissing dry run reports the deletion and changes nothing", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  await write(remote, "skills/a/SKILL.md", "keep");
  assert.deepEqual(await copyFiles(local, remote, claude.allowlist, { dryRun: true, pruneMissing: true }), [
    { file: path.join("skills", "a", "SKILL.md"), kind: "delete" },
  ]);
  assert.equal(await fs.readFile(path.join(remote, "skills", "a", "SKILL.md"), "utf8"), "keep");
});

test("pruneMissing keeps excluded paths and symlinked source entries", async (t) => {
  const local = await tmp(t);
  const remote = await tmp(t);
  const elsewhere = await tmp(t);
  await fs.symlink(elsewhere, path.join(local, "agents"), "junction");
  await write(remote, "skills/a/SKILL.md", "gone");
  await write(remote, "skills/b/SKILL.md", "excluded");
  await write(remote, "agents/x.md", "linked");
  const changes = await copyFiles(local, remote, [...claude.allowlist, "agents"], {
    dryRun: false,
    pruneMissing: true,
    exclude: [path.join("skills", "b")],
  });
  assert.deepEqual(changes, [{ file: path.join("skills", "a", "SKILL.md"), kind: "delete" }]);
  assert.equal(await fs.readFile(path.join(remote, "skills", "b", "SKILL.md"), "utf8"), "excluded");
  assert.equal(await fs.readFile(path.join(remote, "agents", "x.md"), "utf8"), "linked");
});
