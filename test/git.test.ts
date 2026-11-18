import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = path.resolve("src", "cli.ts");

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}
const opts = { skip: hasGit ? false : "git is not installed" };

const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
};

async function tmp(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ark-git-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { env: { ...process.env, ...gitEnv }, encoding: "utf8" }).trim();
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
}

async function runCli(args: string[], claudeDir: string, home: string, env: NodeJS.ProcessEnv = {}) {
  return run(process.execPath, [cli, ...args], {
    env: { ...process.env, ...gitEnv, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeDir, ...env },
  }).then(
    (r) => ({ code: 0, ...r }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );
}

async function setup(t: TestContext) {
  const home = await tmp(t);
  const claudeDir = path.join(home, "claude-local");
  await fs.mkdir(claudeDir);
  await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "hello");
  return { home, claudeDir, sync: path.join(home, "sync") };
}

test("backup in a git-backed folder creates a commit", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(git(sync, "log", "-1", "--format=%s"), /^sync\(claude\): \d{4}-/);
  assert.match(res.stdout, /No remote/);
});

test("backup with no changes creates no extra commit", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await runCli(["backup", "--dir", sync], claudeDir, home);
  await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(git(sync, "rev-list", "--count", "HEAD"), "1");
});

test("backup sends the commit to origin", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const bare = path.join(home, "remote.git");
  git(home, "init", "-q", "--bare", "-b", "main", bare);
  await initRepo(sync);
  git(sync, "remote", "add", "origin", bare);
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(git(bare, "rev-list", "--count", "main"), "1");
});

test("dry-run backup creates no commit", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  const res = await runCli(["backup", "--dir", sync, "--dry-run"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /would commit/);
  assert.equal(git(sync, "rev-list", "--all", "--count"), "0");
  assert.equal(git(sync, "status", "--porcelain"), "");
});

test("backup commits only allowlisted files", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await fs.mkdir(path.join(sync, "claude"), { recursive: true });
  await fs.writeFile(path.join(sync, ".env"), "SECRET");
  await fs.writeFile(path.join(sync, "claude", ".credentials.json"), "SECRET");
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(git(sync, "show", "--name-only", "--format=", "HEAD"), "claude/CLAUDE.md");
});

test("backup skips an allowlisted file that is gitignored", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await fs.writeFile(path.join(claudeDir, "settings.json"), "{}");
  await fs.writeFile(path.join(sync, ".gitignore"), "claude/settings.json\n");
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(git(sync, "show", "--name-only", "--format=", "HEAD"), "claude/CLAUDE.md");
});

test("a stray untracked file alone does not trigger a commit", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await runCli(["backup", "--dir", sync], claudeDir, home);
  await fs.writeFile(path.join(sync, "stray.txt"), "x");
  const dry = await runCli(["backup", "--dir", sync, "--dry-run"], claudeDir, home);
  assert.doesNotMatch(dry.stdout, /would commit/);
  await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(git(sync, "rev-list", "--count", "HEAD"), "1");
});

test("backup then restore in the same folder works once origin is set", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const bare = path.join(home, "remote.git");
  git(home, "init", "-q", "--bare", "-b", "main", bare);
  await initRepo(sync);
  git(sync, "remote", "add", "origin", bare);
  await runCli(["backup", "--dir", sync], claudeDir, home);
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
});

test("a rejected backup is retried by the next backup", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const bare = path.join(home, "remote.git");
  git(home, "init", "-q", "--bare", "-b", "main", bare);
  await initRepo(sync);
  git(sync, "remote", "add", "origin", bare);
  const hook = path.join(bare, "hooks", "pre-receive");
  await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const first = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.notEqual(first.code, 0);
  await fs.rm(hook);
  const second = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(git(bare, "rev-list", "--count", "main"), "1");
});

test("dry-run backup does not touch .git/index", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await runCli(["backup", "--dir", sync], claudeDir, home);
  const index = path.join(sync, ".git", "index");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(index, old, old);
  await runCli(["backup", "--dir", sync, "--dry-run"], claudeDir, home);
  assert.equal((await fs.stat(index)).mtimeMs, old.getTime());
});

async function seedRemote(home: string, bare: string): Promise<string> {
  const seed = path.join(home, "seed");
  git(home, "init", "-q", "--bare", "-b", "main", bare);
  await initRepo(seed);
  git(seed, "remote", "add", "origin", bare);
  await fs.mkdir(path.join(seed, "claude"));
  await fs.writeFile(path.join(seed, "claude", "CLAUDE.md"), "v1");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "v1");
  git(seed, "push", "-q", "origin", "main");
  return seed;
}

test("restore fast-forwards from the remote then copies", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const bare = path.join(home, "remote.git");
  const seed = await seedRemote(home, bare);
  git(home, "clone", "-q", bare, sync);
  await fs.writeFile(path.join(seed, "claude", "CLAUDE.md"), "v2");
  git(seed, "commit", "-q", "-am", "v2");
  git(seed, "push", "-q", "origin", "main");
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await fs.readFile(path.join(claudeDir, "CLAUDE.md"), "utf8"), "v2");
});

test("restore with diverged history fails without copying", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const bare = path.join(home, "remote.git");
  const seed = await seedRemote(home, bare);
  git(home, "clone", "-q", bare, sync);
  await fs.writeFile(path.join(seed, "claude", "CLAUDE.md"), "remote");
  git(seed, "commit", "-q", "-am", "remote");
  git(seed, "push", "-q", "origin", "main");
  await fs.writeFile(path.join(sync, "claude", "CLAUDE.md"), "local");
  git(sync, "commit", "-q", "-am", "local");
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.notEqual(res.code, 0);
  assert.ok(res.stderr.length > 0);
  assert.equal(await fs.readFile(path.join(claudeDir, "CLAUDE.md"), "utf8"), "hello");
});

test("a non-git sync dir makes no git calls", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await fs.mkdir(sync);
  // With an empty PATH any attempt to spawn git would fail.
  const res = await runCli(["backup", "--dir", sync], claudeDir, home, { PATH: "" });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await fs.readFile(path.join(sync, "claude", "CLAUDE.md"), "utf8"), "hello");
});

test("backup into a git repo with an upstream uses plain git push", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const bare = path.join(home, "remote.git");
  await seedRemote(home, bare);
  git(home, "clone", "-q", bare, sync);
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(git(bare, "rev-list", "--count", "main"), "2");
});

test("init clones into ~/.ark/repo and saves the path", opts, async (t) => {
  const { home, claudeDir } = await setup(t);
  const bare = path.join(home, "remote.git");
  await seedRemote(home, bare);
  const res = await runCli(["init", bare], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  const repo = path.join(home, ".ark", "repo");
  assert.equal(await fs.readFile(path.join(repo, "claude", "CLAUDE.md"), "utf8"), "v1");
  const config = JSON.parse(await fs.readFile(path.join(home, ".ark", "config.json"), "utf8"));
  assert.equal(config.repo, repo);
});

test("init on an existing git repo does nothing", opts, async (t) => {
  const { home, claudeDir } = await setup(t);
  const repo = path.join(home, ".ark", "repo");
  await initRepo(repo);
  const res = await runCli(["init", path.join(home, "nope.git")], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Already initialized/);
});

test("init prints git's error when the clone fails", opts, async (t) => {
  const { home, claudeDir } = await setup(t);
  const res = await runCli(["init", path.join(home, "missing.git")], claudeDir, home);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /missing\.git/);
});

test("backup and restore use ~/.ark/repo by default", opts, async (t) => {
  const { home, claudeDir } = await setup(t);
  const bare = path.join(home, "remote.git");
  await seedRemote(home, bare);
  await runCli(["init", bare], claudeDir, home);
  const res = await runCli(["restore"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await fs.readFile(path.join(claudeDir, "CLAUDE.md"), "utf8"), "v1");
});

test("backup and restore tell the user to run init when the repo is missing", opts, async (t) => {
  const { home, claudeDir } = await setup(t);
  for (const command of ["backup", "restore"]) {
    const res = await runCli([command], claudeDir, home);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /ark init/);
  }
});

test("plugin manifests are portable in the repo and expanded on restore", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const bare = path.join(home, "remote.git");
  git(home, "init", "-q", "--bare", "-b", "main", bare);
  await initRepo(sync);
  git(sync, "remote", "add", "origin", bare);
  const manifest = path.join(claudeDir, "plugins", "installed_plugins.json");
  const settings = path.join(claudeDir, "settings.json");
  const text = JSON.stringify({ installPath: path.join(claudeDir, "plugins", "cache", "p") });
  await fs.mkdir(path.dirname(manifest), { recursive: true });
  await fs.writeFile(manifest, text);
  await fs.writeFile(settings, JSON.stringify({ p: claudeDir }));

  await runCli(["backup", "--dir", sync], claudeDir, home);
  const stored = await fs.readFile(path.join(sync, "claude", "plugins", "installed_plugins.json"), "utf8");
  assert.ok(!stored.includes(claudeDir));
  assert.match(stored, /CLAUDE_HOME/);
  assert.equal(await fs.readFile(path.join(sync, "claude", "settings.json"), "utf8"), JSON.stringify({ p: claudeDir }));
  assert.match((await runCli(["backup", "--dir", sync], claudeDir, home)).stdout, /Nothing to sync/);

  const restore = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.match(restore.stdout, /Nothing to sync/);
  assert.equal(await fs.readFile(manifest, "utf8"), text);

  await fs.rm(manifest);
  await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(await fs.readFile(manifest, "utf8"), text);
});

async function writeFile(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

test("backup commits the deletion of a file removed locally", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(sync, "claude", "plugins", "cache", "p", "1.0", "x"), "old");
  git(sync, "add", "-A");
  git(sync, "commit", "-q", "-m", "seed");
  await writeFile(path.join(claudeDir, "plugins", "cache", "p", "2.0", "x"), "new");
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /delete: plugins\/cache\/p\/1\.0\/x/);
  await assert.rejects(fs.stat(path.join(sync, "claude", "plugins", "cache", "p", "1.0")));
  assert.equal(git(sync, "status", "--porcelain"), "");
  assert.match(git(sync, "show", "--name-status", "--format=", "HEAD"), /^D\tclaude\/plugins\/cache\/p\/1\.0\/x$/m);
  const again = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.match(again.stdout, /Nothing to sync\./);
  assert.equal(git(sync, "rev-list", "--count", "HEAD"), "2");
});

test("dry-run backup reports deletions and changes nothing", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(sync, "claude", "plugins", "cache", "p", "1.0", "x"), "old");
  git(sync, "add", "-A");
  git(sync, "commit", "-q", "-m", "seed");
  await writeFile(path.join(claudeDir, "plugins", "cache", "p", "2.0", "x"), "new");
  const res = await runCli(["backup", "--dir", sync, "--dry-run"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /would delete: plugins\/cache\/p\/1\.0\/x/);
  assert.match(res.stdout, /would commit/);
  assert.equal((await fs.readFile(path.join(sync, "claude", "plugins", "cache", "p", "1.0", "x"), "utf8")), "old");
  assert.equal(git(sync, "rev-list", "--count", "HEAD"), "1");
});

test("restore deletes a stale local file after backing it up", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "claude", "CLAUDE.md"), "hello");
  await writeFile(path.join(sync, "claude", "plugins", "cache", "p", "2.0", "x"), "new");
  await writeFile(path.join(claudeDir, "plugins", "cache", "p", "1.0", "x"), "old");
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /delete: plugins\/cache\/p\/1\.0\/x/);
  await assert.rejects(fs.stat(path.join(claudeDir, "plugins", "cache", "p", "1.0", "x")));
  const stamps = await fs.readdir(path.join(home, ".ark", "backups", "claude"));
  assert.equal(await fs.readFile(path.join(home, ".ark", "backups", "claude", stamps[0], "plugins", "cache", "p", "1.0", "x"), "utf8"), "old");
  const again = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.match(again.stdout, /Nothing to sync\./);
});
