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
    env: { ...process.env, ...gitEnv, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeDir, XDG_CONFIG_HOME: path.join(home, "xdg-default"), COPILOT_HOME: path.join(home, "copilot-default"), PI_CODING_AGENT_DIR: path.join(home, "pi-default"), ...env },
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

test("Copilot backup syncs only allowlisted entries", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const copilotDir = path.join(home, "copilot-local");
  await initRepo(sync);
  await writeFile(path.join(copilotDir, "settings.json"), "{}");
  await writeFile(path.join(copilotDir, "agents", "review.md"), "agent");
  await writeFile(path.join(copilotDir, "skills", "check", "SKILL.md"), "skill");
  await writeFile(path.join(copilotDir, "installed-plugins", "plugin.json"), "{}");
  await writeFile(path.join(copilotDir, "installed-plugins.lock"), "{}");
  await writeFile(path.join(copilotDir, "config.json"), "private config");
  await writeFile(path.join(copilotDir, "session-state", "session.json"), "session");
  await writeFile(path.join(copilotDir, "logs", "ark.log"), "log");
  await writeFile(path.join(copilotDir, "settings.json.lock"), "lock");

  const res = await runCli(["backup", "--dir", sync, "--tool", "copilot"], claudeDir, home, { COPILOT_HOME: copilotDir });
  assert.equal(res.code, 0, res.stderr);
  assert.match(git(sync, "log", "-1", "--format=%s"), /^sync\(copilot\): \d{4}-/);
  assert.deepEqual(git(sync, "ls-tree", "-r", "--name-only", "HEAD").split("\n"), [
    "copilot/agents/review.md",
    "copilot/installed-plugins.lock",
    "copilot/installed-plugins/plugin.json",
    "copilot/settings.json",
    "copilot/skills/check/SKILL.md",
  ]);
});

test("OpenCode backup and restore sync only allowlisted entries", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const xdg = path.join(home, "xdg");
  const openDir = path.join(xdg, "opencode");
  const env = { XDG_CONFIG_HOME: xdg };
  await initRepo(sync);
  await writeFile(path.join(openDir, "opencode.json"), "{}");
  await writeFile(path.join(openDir, "AGENTS.md"), "rules");
  await writeFile(path.join(openDir, "agents", "review.md"), "agent");
  await writeFile(path.join(openDir, "commands", "go.md"), "command");
  await writeFile(path.join(openDir, "skills", "check", "SKILL.md"), "skill");
  await writeFile(path.join(openDir, "plugins", "p.ts"), "plugin");
  await writeFile(path.join(openDir, "service.json"), "private");
  await writeFile(path.join(openDir, "node_modules", "x", "index.js"), "dep");
  await writeFile(path.join(openDir, "package.json"), "{}");
  await writeFile(path.join(openDir, "bun.lock"), "lock");
  await writeFile(path.join(openDir, "agents_docs", "doc.md"), "doc");

  const res = await runCli(["backup", "--dir", sync, "--tool", "opencode"], claudeDir, home, env);
  assert.equal(res.code, 0, res.stderr);
  assert.match(git(sync, "log", "-1", "--format=%s"), /^sync\(opencode\): \d{4}-/);
  assert.deepEqual(git(sync, "ls-tree", "-r", "--name-only", "HEAD").split("\n"), [
    "opencode/AGENTS.md",
    "opencode/agents/review.md",
    "opencode/commands/go.md",
    "opencode/opencode.json",
    "opencode/plugins/p.ts",
    "opencode/skills/check/SKILL.md",
  ]);

  await fs.rm(path.join(openDir, "opencode.json"));
  await fs.rm(path.join(openDir, "agents"), { recursive: true });
  // A plain folder (no git) restores without needing a remote.
  const plain = path.join(home, "plain");
  await fs.cp(path.join(sync, "opencode"), path.join(plain, "opencode"), { recursive: true });
  const back = await runCli(["restore", "--dir", plain, "--tool", "opencode"], claudeDir, home, env);
  assert.equal(back.code, 0, back.stderr);
  assert.equal(await fs.readFile(path.join(openDir, "opencode.json"), "utf8"), "{}");
  assert.equal(await fs.readFile(path.join(openDir, "agents", "review.md"), "utf8"), "agent");
  assert.equal(await fs.readFile(path.join(openDir, "service.json"), "utf8"), "private");
  assert.equal(await fs.readFile(path.join(openDir, "agents_docs", "doc.md"), "utf8"), "doc");
});

test("pi backup and restore sync only allowlisted entries", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const piDir = path.join(home, "pi-custom");
  const env = { PI_CODING_AGENT_DIR: piDir };
  await initRepo(sync);
  await writeFile(path.join(piDir, "settings.json"), "{}");
  await writeFile(path.join(piDir, "AGENTS.md"), "rules");
  await writeFile(path.join(piDir, "skills", "check", "SKILL.md"), "skill");
  await writeFile(path.join(piDir, "auth.json"), "secret");
  await writeFile(path.join(piDir, "sessions", "s.jsonl"), "log");

  const res = await runCli(["backup", "--dir", sync, "--tool", "pi"], claudeDir, home, env);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(git(sync, "ls-tree", "-r", "--name-only", "HEAD").split("\n"), [
    "pi/AGENTS.md",
    "pi/settings.json",
    "pi/skills/check/SKILL.md",
  ]);

  await fs.rm(path.join(piDir, "settings.json"));
  const plain = path.join(home, "plain");
  await fs.cp(path.join(sync, "pi"), path.join(plain, "pi"), { recursive: true });
  const back = await runCli(["restore", "--dir", plain, "--tool", "pi"], claudeDir, home, env);
  assert.equal(back.code, 0, back.stderr);
  assert.equal(await fs.readFile(path.join(piDir, "settings.json"), "utf8"), "{}");
  assert.equal(await fs.readFile(path.join(piDir, "auth.json"), "utf8"), "secret");
});

test("Copilot restore restores allowlisted entries and leaves blocked entries untouched", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const copilotDir = path.join(home, "copilot-local");
  await writeFile(path.join(sync, "copilot", "settings.json"), "repo settings");
  await writeFile(path.join(sync, "copilot", "agents", "review.md"), "repo agent");
  await writeFile(path.join(sync, "copilot", "skills", "check", "SKILL.md"), "repo skill");
  await writeFile(path.join(sync, "copilot", "installed-plugins", "plugin.json"), "repo plugin");
  await writeFile(path.join(sync, "copilot", "installed-plugins.lock"), "repo lock");
  await writeFile(path.join(sync, "copilot", "config.json"), "repo config");
  await writeFile(path.join(sync, "copilot", "session-state", "session.json"), "repo session");
  await writeFile(path.join(sync, "copilot", "logs", "ark.log"), "repo log");
  await writeFile(path.join(sync, "copilot", "settings.json.lock"), "repo lockfile");

  await writeFile(path.join(copilotDir, "settings.json"), "local settings");
  await writeFile(path.join(copilotDir, "skills", "check", "SKILL.md"), "local skill");
  await writeFile(path.join(copilotDir, "installed-plugins.lock"), "local lock");
  await writeFile(path.join(copilotDir, "skills", "removed", "SKILL.md"), "removed from repo");
  await writeFile(path.join(copilotDir, "config.json"), "local config");
  await writeFile(path.join(copilotDir, "session-state", "session.json"), "local session");
  await writeFile(path.join(copilotDir, "logs", "ark.log"), "local log");
  await writeFile(path.join(copilotDir, "settings.json.lock"), "local lockfile");

  const res = await runCli(["restore", "--dir", sync, "--tool", "copilot"], claudeDir, home, { COPILOT_HOME: copilotDir });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await fs.readFile(path.join(copilotDir, "settings.json"), "utf8"), "repo settings");
  assert.equal(await fs.readFile(path.join(copilotDir, "agents", "review.md"), "utf8"), "repo agent");
  assert.equal(await fs.readFile(path.join(copilotDir, "skills", "check", "SKILL.md"), "utf8"), "repo skill");
  await assert.rejects(fs.stat(path.join(copilotDir, "skills", "removed", "SKILL.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(copilotDir, "installed-plugins", "plugin.json"), "utf8"), "repo plugin");
  assert.equal(await fs.readFile(path.join(copilotDir, "installed-plugins.lock"), "utf8"), "repo lock");
  assert.equal(await fs.readFile(path.join(copilotDir, "config.json"), "utf8"), "local config");
  assert.equal(await fs.readFile(path.join(copilotDir, "session-state", "session.json"), "utf8"), "local session");
  assert.equal(await fs.readFile(path.join(copilotDir, "logs", "ark.log"), "utf8"), "local log");
  assert.equal(await fs.readFile(path.join(copilotDir, "settings.json.lock"), "utf8"), "local lockfile");
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

test("backup commits global agents entries alongside the selected tool", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(home, ".agents", "skills", "x", "SKILL.md"), "shared skill");
  await writeFile(path.join(home, ".agents", ".skill-lock.json"), "{}");
  await writeFile(path.join(home, ".agents", "docs", "lang", "x.md"), "shared doc");
  await writeFile(path.join(home, ".agents", "other.txt"), "not synced");
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await fs.readFile(path.join(sync, "agents", "skills", "x", "SKILL.md"), "utf8"), "shared skill");
  assert.equal(await fs.readFile(path.join(sync, "agents", ".skill-lock.json"), "utf8"), "{}");
  assert.equal(await fs.readFile(path.join(sync, "agents", "docs", "lang", "x.md"), "utf8"), "shared doc");
  assert.equal(git(sync, "rev-list", "--count", "HEAD"), "1");
  assert.match(git(sync, "log", "-1", "--format=%s"), /^sync\(claude\): \d{4}-/);
  assert.deepEqual(git(sync, "ls-tree", "-r", "--name-only", "HEAD").split("\n"), [
    "agents/.skill-lock.json",
    "agents/docs/lang/x.md",
    "agents/skills/x/SKILL.md",
    "claude/CLAUDE.md",
  ]);
  assert.match(res.stdout, /^new: agents\/docs\/lang\/x\.md$/m);
  assert.match(res.stdout, /^new: CLAUDE\.md$/m);
  assert.match(res.stdout, /^new: agents\/skills\/x\/SKILL\.md$/m);
  assert.match(res.stdout, /^new: agents\/\.skill-lock\.json$/m);
  await assert.rejects(fs.stat(path.join(sync, "agents", "other.txt")), { code: "ENOENT" });
  const again = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout.match(/Nothing to sync\./g)?.length, 1);
  assert.equal(git(sync, "rev-list", "--count", "HEAD"), "1");
});

test("dry-run backup reports agents-only changes without writing or committing", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  const first = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(first.code, 0, first.stderr);
  await writeFile(path.join(home, ".agents", "skills", "x", "SKILL.md"), "shared skill");
  await writeFile(path.join(home, ".agents", ".skill-lock.json"), "{}");
  const res = await runCli(["backup", "--dir", sync, "--dry-run"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^would new: agents\/skills\/x\/SKILL\.md$/m);
  assert.match(res.stdout, /would commit/);
  assert.doesNotMatch(res.stdout, /Nothing to sync/);
  await assert.rejects(fs.stat(path.join(sync, "agents")), { code: "ENOENT" });
  assert.equal(git(sync, "rev-list", "--count", "HEAD"), "1");
  assert.equal(git(sync, "status", "--porcelain"), "");
});

test("backup commits a deletion from global agents skills", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  const skill = path.join(home, ".agents", "skills", "x", "SKILL.md");
  await writeFile(skill, "shared skill");
  const first = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(first.code, 0, first.stderr);
  await fs.rm(skill);
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^delete: agents\/skills\/x\/SKILL\.md$/m);
  await assert.rejects(fs.stat(path.join(sync, "agents", "skills", "x", "SKILL.md")), { code: "ENOENT" });
  assert.equal(git(sync, "show", "--name-status", "--format=", "HEAD"), "D\tagents/skills/x/SKILL.md");
  assert.equal(git(sync, "rev-list", "--count", "HEAD"), "2");
  assert.equal(git(sync, "status", "--porcelain"), "");
});

test("backup includes and excludes apply only to the selected tool, not global agents", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(home, ".ark", "config.json"), JSON.stringify({ include: { claude: ["rules"] } }));
  for (const root of [claudeDir, path.join(home, ".agents")]) {
    await writeFile(path.join(root, "skills", "x", "SKILL.md"), "skill");
    await writeFile(path.join(root, ".skill-lock.json"), "{}");
    await writeFile(path.join(root, "rules", "a.md"), "saved include");
    await writeFile(path.join(root, "notes", "a.md"), "run include");
  }
  const res = await runCli(["backup", "--dir", sync, "--tool", "claude", "--exclude", "skills", "--exclude", ".skill-lock.json", "--include", "notes"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(git(sync, "ls-tree", "-r", "--name-only", "HEAD").split("\n"), [
    "agents/.skill-lock.json",
    "agents/skills/x/SKILL.md",
    "claude/CLAUDE.md",
    "claude/notes/a.md",
    "claude/rules/a.md",
  ]);
  await assert.rejects(fs.stat(path.join(sync, "claude", "skills")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(sync, "agents", "notes")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(sync, "agents", "rules")), { code: "ENOENT" });
  const config = JSON.parse(await fs.readFile(path.join(home, ".ark", "config.json"), "utf8"));
  assert.deepEqual(config.include, { claude: ["rules", "notes"] });
});

test("global agents is not a selectable tool", async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const res = await runCli(["backup", "--dir", sync, "--tool", "agents"], claudeDir, home);
  assert.equal(res.code, 1);
  assert.equal(res.stderr.trim(), 'Unknown tool "agents". Available: claude, copilot, opencode, pi');
});

test("global agents restore copies and prunes independently of selected tool filters", async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const agents = path.join(home, ".agents");
  await writeFile(path.join(home, ".ark", "config.json"), JSON.stringify({ include: { claude: ["rules"] } }));
  await writeFile(path.join(sync, "claude", "CLAUDE.md"), "changed");
  await writeFile(path.join(sync, "claude", "skills", "x", "SKILL.md"), "claude skill");
  await writeFile(path.join(sync, "agents", "skills", "x", "SKILL.md"), "shared skill");
  await writeFile(path.join(sync, "agents", ".skill-lock.json"), "new lock");
  await writeFile(path.join(sync, "agents", "docs", "lang", "x.md"), "shared doc");
  await writeFile(path.join(sync, "agents", "rules", "repo.md"), "repo only");
  await writeFile(path.join(agents, "skills", "gone", "SKILL.md"), "old skill");
  await writeFile(path.join(agents, ".skill-lock.json"), "old lock");
  await writeFile(path.join(agents, "other.txt"), "keep");
  await writeFile(path.join(agents, "rules", "local.md"), "keep");

  const res = await runCli(["restore", "--dir", sync, "--exclude", "skills", "--exclude", ".skill-lock.json"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await fs.readFile(path.join(agents, "skills", "x", "SKILL.md"), "utf8"), "shared skill");
  assert.equal(await fs.readFile(path.join(agents, ".skill-lock.json"), "utf8"), "new lock");
  assert.equal(await fs.readFile(path.join(agents, "docs", "lang", "x.md"), "utf8"), "shared doc");
  assert.equal(await fs.readFile(path.join(agents, "rules", "repo.md"), "utf8"), "repo only");
  assert.equal(await fs.readFile(path.join(agents, "rules", "local.md"), "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(agents, "other.txt"), "utf8"), "keep");
  await assert.rejects(fs.stat(path.join(agents, "skills", "gone", "SKILL.md")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(claudeDir, "skills")), { code: "ENOENT" });
  const [stamp] = await fs.readdir(path.join(home, ".ark", "backups", "agents"));
  const backup = path.join(home, ".ark", "backups", "agents", stamp);
  assert.equal(await fs.readFile(path.join(backup, "skills", "gone", "SKILL.md"), "utf8"), "old skill");
  assert.equal(await fs.readFile(path.join(backup, ".skill-lock.json"), "utf8"), "old lock");
  assert.match(res.stdout, /^new: agents\/skills\/x\/SKILL\.md$/m);
  assert.match(res.stdout, /^delete: agents\/skills\/gone\/SKILL\.md$/m);
  assert.ok(res.stdout.includes(`Previous local files saved to ${backup}`));
  assert.equal(res.stdout.match(/Previous local files saved to /g)?.length, 2);
  assert.doesNotMatch(res.stdout, /Nothing to sync/);
  const again = await runCli(["restore", "--dir", sync, "--exclude", "skills"], claudeDir, home);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout.match(/Nothing to sync\./g)?.length, 1);
  assert.doesNotMatch(again.stdout, /saved to/);
});

test("global agents restore skips a missing agents repo without pruning", async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "claude", "CLAUDE.md"), "hello");
  await writeFile(path.join(home, ".agents", "skills", "keep", "SKILL.md"), "local");
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.trim(), "Nothing to sync.");
  assert.equal(await fs.readFile(path.join(home, ".agents", "skills", "keep", "SKILL.md"), "utf8"), "local");
  await assert.rejects(fs.stat(path.join(home, ".ark", "backups")), { code: "ENOENT" });
});

test("global agents restore validates the selected tool before writing", async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "agents", "skills", "x", "SKILL.md"), "shared skill");
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /Folder .*claude.* does not exist/);
  await assert.rejects(fs.stat(path.join(home, ".agents")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(home, ".ark", "backups")), { code: "ENOENT" });
});

test("global agents restore dry-run skips pull and reports changes without writing", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const bare = path.join(home, "remote.git");
  const seed = await seedRemote(home, bare);
  await writeFile(path.join(seed, "agents", "skills", "x", "SKILL.md"), "v1");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "agents");
  git(seed, "push", "-q", "origin", "main");
  git(home, "clone", "-q", bare, sync);
  await writeFile(path.join(seed, "agents", "skills", "x", "SKILL.md"), "v2");
  git(seed, "commit", "-q", "-am", "agents v2");
  git(seed, "push", "-q", "origin", "main");
  await writeFile(path.join(home, ".agents", "skills", "gone", "SKILL.md"), "old");
  const res = await runCli(["restore", "--dir", sync, "--dry-run"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^would new: agents\/skills\/x\/SKILL\.md$/m);
  assert.match(res.stdout, /^would delete: agents\/skills\/gone\/SKILL\.md$/m);
  assert.equal(await fs.readFile(path.join(sync, "agents", "skills", "x", "SKILL.md"), "utf8"), "v1");
  assert.equal(await fs.readFile(path.join(home, ".agents", "skills", "gone", "SKILL.md"), "utf8"), "old");
  await assert.rejects(fs.stat(path.join(home, ".agents", "skills", "x")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(home, ".ark", "backups")), { code: "ENOENT" });
  const restored = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(await fs.readFile(path.join(home, ".agents", "skills", "x", "SKILL.md"), "utf8"), "v2");
});

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

test("backup uploads only the version installPath points to and commits the stale deletion", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(sync, "claude", "plugins", "cache", "m", "p", "0.6.14", "x"), "old");
  git(sync, "add", "-A");
  git(sync, "commit", "-q", "-m", "seed");
  const active = path.join(claudeDir, "plugins", "cache", "m", "p", "0.6.16");
  await writeFile(path.join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "p@m": [{ installPath: active }] } }));
  await writeFile(path.join(claudeDir, "plugins", "cache", "m", "p", "0.6.14", "x"), "old");
  await writeFile(path.join(active, "x"), "new");
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /delete: plugins\/cache\/m\/p\/0\.6\.14\/x/);
  assert.deepEqual(await fs.readdir(path.join(sync, "claude", "plugins", "cache", "m", "p")), ["0.6.16"]);
  assert.match(git(sync, "show", "--name-status", "--format=", "HEAD"), /^D\tclaude\/plugins\/cache\/m\/p\/0\.6\.14\/x$/m);
  assert.match((await runCli(["backup", "--dir", sync], claudeDir, home)).stdout, /Nothing to sync\./);
});

test("restore brings only the active version and dry-run changes nothing", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  const stored = JSON.stringify({ plugins: { "p@m": [{ installPath: "CLAUDE_HOME/plugins/cache/m/p/0.6.16" }] } });
  await writeFile(path.join(sync, "claude", "plugins", "installed_plugins.json"), stored);
  await writeFile(path.join(sync, "claude", "plugins", "cache", "m", "p", "0.6.14", "x"), "old");
  await writeFile(path.join(sync, "claude", "plugins", "cache", "m", "p", "0.6.16", "x"), "new");
  const dry = await runCli(["restore", "--dir", sync, "--dry-run"], claudeDir, home);
  assert.equal(dry.code, 0, dry.stderr);
  assert.doesNotMatch(dry.stdout, /0\.6\.14/);
  await assert.rejects(fs.stat(path.join(claudeDir, "plugins")));
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(await fs.readdir(path.join(claudeDir, "plugins", "cache", "m", "p")), ["0.6.16"]);
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
  assert.match(res.stdout, new RegExp(`Previous local files saved to .*${stamps[0]}`));
  assert.equal(await fs.readFile(path.join(home, ".ark", "backups", "claude", stamps[0], "plugins", "cache", "p", "1.0", "x"), "utf8"), "old");
  const again = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.match(again.stdout, /Nothing to sync\./);
  assert.doesNotMatch(again.stdout, /saved to/);
});

test("restore pulls repo entries outside the allowlist and skips blocked ones", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "claude", "rules", "a.md"), "rule");
  await writeFile(path.join(sync, "claude", ".credentials.json"), "secret");
  await writeFile(path.join(sync, "claude", "projects", "x"), "state");
  await writeFile(path.join(claudeDir, "keep.txt"), "local only");
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await fs.readFile(path.join(claudeDir, "rules", "a.md"), "utf8"), "rule");
  await assert.rejects(fs.stat(path.join(claudeDir, ".credentials.json")));
  await assert.rejects(fs.stat(path.join(claudeDir, "projects")));
  assert.equal(await fs.readFile(path.join(claudeDir, "keep.txt"), "utf8"), "local only");
});

test("restore skips blocked names that differ only by case or trailing dots", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "claude", "rules", "a.md"), "rule");
  await writeFile(path.join(sync, "claude", "Projects", "x"), "state");
  await writeFile(path.join(sync, "claude", "sessions.", "x"), "state");
  await writeFile(path.join(sync, "claude", ".Credentials.json"), "secret");
  await writeFile(path.join(claudeDir, "projects", "session.jsonl"), "mine");
  await writeFile(path.join(claudeDir, ".credentials.json"), "mine");
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /Projects|Credentials|sessions/i);
  assert.equal(await fs.readFile(path.join(claudeDir, "projects", "session.jsonl"), "utf8"), "mine");
  assert.equal(await fs.readFile(path.join(claudeDir, ".credentials.json"), "utf8"), "mine");
});

test("restore copies a repo-only entry but never prunes inside it", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "claude", "rules", "a.md"), "rule");
  await writeFile(path.join(claudeDir, "rules", "gone.md"), "local");
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await fs.readFile(path.join(claudeDir, "rules", "a.md"), "utf8"), "rule");
  assert.equal(await fs.readFile(path.join(claudeDir, "rules", "gone.md"), "utf8"), "local");
  assert.doesNotMatch(res.stdout, /delete:/);
});

test("restore leaves local files outside the paths backup syncs, even in a shared top-level folder", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "claude", "plugins", "installed_plugins.json"), "{}");
  await writeFile(path.join(claudeDir, "plugins", "marketplaces", "m", "a"), "clone");
  await writeFile(path.join(claudeDir, "plugins", "other.txt"), "local");
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await fs.readFile(path.join(claudeDir, "plugins", "marketplaces", "m", "a"), "utf8"), "clone");
  assert.equal(await fs.readFile(path.join(claudeDir, "plugins", "other.txt"), "utf8"), "local");
  assert.doesNotMatch(res.stdout, /delete:/);
});

test("restore prunes inside a saved include", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(home, ".ark", "config.json"), JSON.stringify({ include: { claude: ["notes"] } }));
  await writeFile(path.join(sync, "claude", "notes", "a.md"), "note");
  await writeFile(path.join(claudeDir, "notes", "gone.md"), "old");
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /delete: notes\/gone\.md/);
  await assert.rejects(fs.stat(path.join(claudeDir, "notes", "gone.md")));
  assert.equal(await fs.readFile(path.join(claudeDir, "notes", "a.md"), "utf8"), "note");
});

test("restore fails on an invalid or blocked saved include and deletes nothing", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "claude", "skills", "a.md"), "skill");
  const stale = path.join(claudeDir, "skills", "gone.md");
  const outside = path.join(claudeDir, "..", "x", "f");
  await writeFile(stale, "old");
  await writeFile(outside, "keep");
  for (const include of ["projects", "../x"]) {
    await writeFile(path.join(home, ".ark", "config.json"), JSON.stringify({ include: { claude: [include] } }));
    const res = await runCli(["restore", "--dir", sync], claudeDir, home);
    assert.notEqual(res.code, 0, include);
    assert.match(res.stderr, /config include/, include);
    assert.equal(await fs.readFile(stale, "utf8"), "old");
    assert.equal(await fs.readFile(outside, "utf8"), "keep");
    await assert.rejects(fs.stat(path.join(claudeDir, "skills", "a.md")));
  }
});

test("backup --exclude skips and keeps the excluded repo copy, without touching config", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(claudeDir, "skills", "foo", "SKILL.md"), "new");
  await writeFile(path.join(claudeDir, "skills", "bar", "SKILL.md"), "bar");
  await writeFile(path.join(claudeDir, "settings.json"), "{}");
  await writeFile(path.join(sync, "claude", "skills", "foo", "SKILL.md"), "old");
  const res = await runCli(["backup", "--dir", sync, "--tool", "claude", "--exclude", "skills/foo", "--exclude", "settings.json"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /foo|settings/);
  assert.equal(await fs.readFile(path.join(sync, "claude", "skills", "foo", "SKILL.md"), "utf8"), "old");
  assert.equal(await fs.readFile(path.join(sync, "claude", "skills", "bar", "SKILL.md"), "utf8"), "bar");
  await assert.rejects(fs.stat(path.join(sync, "claude", "settings.json")));
  const committed = git(sync, "ls-tree", "-r", "--name-only", "HEAD");
  assert.doesNotMatch(committed, /foo|settings/);
  await assert.rejects(fs.stat(path.join(home, ".ark", "config.json")), { code: "ENOENT" });
});

test("backup --exclude does not commit an excluded file already in the repo", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(sync, "claude", "skills", "foo", "SKILL.md"), "old");
  const res = await runCli(["backup", "--dir", sync, "--tool", "claude", "--exclude", "skills/foo"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.doesNotMatch(git(sync, "ls-tree", "-r", "--name-only", "HEAD"), /foo/);
});

test("restore --exclude neither overwrites nor prunes the excluded local path", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "claude", "CLAUDE.md"), "hello");
  await writeFile(path.join(sync, "claude", "skills", "foo", "SKILL.md"), "repo");
  await writeFile(path.join(sync, "claude", "rules", "a.md"), "rule");
  await writeFile(path.join(claudeDir, "skills", "foo", "SKILL.md"), "mine");
  await writeFile(path.join(claudeDir, "skills", "foo", "extra.md"), "mine");
  const res = await runCli(["restore", "--dir", sync, "--exclude", "skills/foo"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /foo/);
  assert.equal(await fs.readFile(path.join(claudeDir, "skills", "foo", "SKILL.md"), "utf8"), "mine");
  assert.equal(await fs.readFile(path.join(claudeDir, "skills", "foo", "extra.md"), "utf8"), "mine");
  assert.equal(await fs.readFile(path.join(claudeDir, "rules", "a.md"), "utf8"), "rule");
});

test("an invalid --exclude fails before any sync runs", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  for (const command of ["backup", "restore"]) {
    for (const bad of ["/abs", "../x", "", "."]) {
      const res = await runCli([command, "--dir", sync, "--exclude", bad], claudeDir, home);
      assert.equal(res.code, 1, `${command} ${JSON.stringify(bad)}`);
      assert.match(res.stderr, /--exclude/);
    }
  }
  await assert.rejects(fs.stat(path.join(sync, "claude")));
});

async function plainSetup(t: TestContext) {
  const ctx = await setup(t);
  await fs.mkdir(ctx.sync);
  await fs.mkdir(path.join(ctx.claudeDir, "rules"));
  await fs.writeFile(path.join(ctx.claudeDir, "rules", "a.md"), "rule");
  const config = path.join(ctx.home, ".ark", "config.json");
  const saved = async () => JSON.parse(await fs.readFile(config, "utf8")).include?.claude;
  return { ...ctx, config, saved };
}

test("backup --include copies the path, saves it, and later backups keep syncing it", async (t) => {
  const { home, claudeDir, sync, saved } = await plainSetup(t);
  const res = await runCli(["backup", "--dir", sync, "--tool", "claude", "--include", "rules"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await fs.readFile(path.join(sync, "claude", "rules", "a.md"), "utf8"), "rule");
  assert.deepEqual(await saved(), ["rules"]);
  await fs.writeFile(path.join(claudeDir, "rules", "a.md"), "rule2");
  const again = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(await fs.readFile(path.join(sync, "claude", "rules", "a.md"), "utf8"), "rule2");
});

test("backup --include does not duplicate saved entries or change lines", async (t) => {
  const { home, claudeDir, sync, saved } = await plainSetup(t);
  await fs.mkdir(path.join(claudeDir, "skills"));
  await fs.writeFile(path.join(claudeDir, "skills", "s.md"), "s");
  await runCli(["backup", "--dir", sync, "--tool", "claude", "--include", "rules"], claudeDir, home);
  const res = await runCli(["backup", "--dir", sync, "--tool", "claude", "--include", "rules", "--include", "Rules", "--include", "skills/s.md", "--include", "Skills"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal((await saved()).filter((item: string) => item.toLowerCase() === "rules").length, 1);
  assert.equal(res.stdout.trim(), "Nothing to sync.");
});

test("backup --include rejects bad paths and writes nothing", async (t) => {
  const { home, claudeDir, sync, config } = await plainSetup(t);
  for (const bad of [".credentials.json", "projects/x", "/abs", "../x", "", "settings.local.json"]) {
    const res = await runCli(["backup", "--dir", sync, "--tool", "claude", "--include", bad], claudeDir, home);
    assert.equal(res.code, 1, `${bad}: ${res.stderr}`);
    assert.match(res.stderr, /--include/);
  }
  assert.deepEqual(await fs.readdir(sync), []);
  await assert.rejects(fs.stat(config));
});

test("backup --dry-run --include reports changes without saving", async (t) => {
  const { home, claudeDir, sync, config } = await plainSetup(t);
  const res = await runCli(["backup", "--dir", sync, "--tool", "claude", "--dry-run", "--include", "rules"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /would new: rules/);
  await assert.rejects(fs.stat(config));
});

test("backup fails on a saved include that is blocked", async (t) => {
  const { home, claudeDir, sync, config } = await plainSetup(t);
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, JSON.stringify({ include: { claude: [".credentials.json"] } }));
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /include/);
  assert.deepEqual(await fs.readdir(sync), []);
});

test("Copilot backup fails when config.json is explicitly included", async (t) => {
  const { home, claudeDir, sync, config } = await plainSetup(t);
  const copilotDir = path.join(home, "copilot-local");
  const res = await runCli(["backup", "--dir", sync, "--tool", "copilot", "--include", "config.json"], claudeDir, home, {
    COPILOT_HOME: copilotDir,
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--include/);
  assert.deepEqual(await fs.readdir(sync), []);
  await assert.rejects(fs.stat(config));
});

test("restore rejects --include", async (t) => {
  const { home, claudeDir, sync } = await plainSetup(t);
  const res = await runCli(["restore", "--dir", sync, "--include", "rules"], claudeDir, home);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--include/);
});

test("backup --include also commits the included files", opts, async (t) => {
  const { home, claudeDir, sync } = await plainSetup(t);
  await initRepo(sync);
  const res = await runCli(["backup", "--dir", sync, "--tool", "claude", "--include", "rules"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(git(sync, "show", "--name-only", "--format=", "HEAD"), /claude\/rules\/a\.md/);
});

test("init keeps saved includes", opts, async (t) => {
  const { home, claudeDir, config } = await plainSetup(t);
  const bare = path.join(home, "remote.git");
  await seedRemote(home, bare);
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, JSON.stringify({ include: { claude: ["rules"] } }));
  const res = await runCli(["init", bare], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  const saved = JSON.parse(await fs.readFile(config, "utf8"));
  assert.deepEqual(saved.include, { claude: ["rules"] });
  assert.equal(saved.repo, path.join(home, ".ark", "repo"));
});

test("a mis-cased --include overlapping an adapter entry keeps the on-disk casing in the repo", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await fs.mkdir(path.join(claudeDir, "skills"));
  await fs.writeFile(path.join(claudeDir, "skills", "s.md"), "s");
  const caseInsensitive = await fs.stat(path.join(claudeDir, "Skills", "S.md")).then(() => true, () => false);
  if (!caseInsensitive) return t.skip("case-sensitive filesystem");
  const res = await runCli(["backup", "--dir", sync, "--tool", "claude", "--include", "Skills/S.md"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /new: skills[\\/]s\.md/);
  const tracked = git(sync, "ls-files");
  assert.match(tracked, /claude\/skills\/s\.md/);
  assert.doesNotMatch(tracked, /Skills/);
});

async function linkSkill(claudeDir: string, name: string, target: string): Promise<void> {
  const link = path.join(claudeDir, "skills", name);
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(path.relative(path.dirname(link), target), link);
}

test("backup records skill symlinks into the agents folder in links.json", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(home, ".agents", "skills", "b", "SKILL.md"), "b");
  await writeFile(path.join(home, ".agents", "skills", "a", "SKILL.md"), "a");
  await linkSkill(claudeDir, "zeta", path.join(home, ".agents", "skills", "b"));
  await linkSkill(claudeDir, "alpha", path.join(home, ".agents", "skills", "a"));
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^new: links\.json$/m);
  assert.equal(
    await fs.readFile(path.join(sync, "links.json"), "utf8"),
    JSON.stringify({ claude: [{ link: "alpha", target: "a" }, { link: "zeta", target: "b" }] }, null, 2) + "\n",
  );
  assert.match(git(sync, "show", "--name-only", "--format=", "HEAD"), /^links\.json$/m);
  await assert.rejects(fs.stat(path.join(sync, "claude", "skills", "alpha")), { code: "ENOENT" });

  const again = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.match(again.stdout, /Nothing to sync\./);
  assert.equal(git(sync, "rev-list", "--count", "HEAD"), "1");
});

test("backup ignores foreign, dangling and nested skill symlinks", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(home, "elsewhere", "x", "f"), "x");
  await writeFile(path.join(home, ".agents", "skills", "g", "deep", "f"), "x");
  await linkSkill(claudeDir, "foreign", path.join(home, "elsewhere", "x"));
  await linkSkill(claudeDir, "dangling", path.join(home, ".agents", "skills", "missing"));
  await linkSkill(claudeDir, "nested", path.join(home, ".agents", "skills", "g", "deep"));
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  await assert.rejects(fs.stat(path.join(sync, "links.json")), { code: "ENOENT" });
});

test("dry-run backup reports links.json without writing it", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(home, ".agents", "skills", "a", "SKILL.md"), "a");
  await linkSkill(claudeDir, "a", path.join(home, ".agents", "skills", "a"));
  const res = await runCli(["backup", "--dir", sync, "--dry-run"], claudeDir, home);
  assert.match(res.stdout, /^would new: links\.json$/m);
  assert.match(res.stdout, /^would commit$/m);
  await assert.rejects(fs.stat(path.join(sync, "links.json")), { code: "ENOENT" });
});

test("backup rewrites an existing links.json when the last link is gone", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(home, ".agents", "skills", "a", "SKILL.md"), "a");
  await linkSkill(claudeDir, "a", path.join(home, ".agents", "skills", "a"));
  await runCli(["backup", "--dir", sync], claudeDir, home);
  await fs.rm(path.join(claudeDir, "skills", "a"));
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.match(res.stdout, /^update: links\.json$/m);
  assert.equal(await fs.readFile(path.join(sync, "links.json"), "utf8"), '{\n  "claude": []\n}\n');
  assert.equal(git(sync, "rev-list", "--count", "HEAD"), "2");
});

test("Copilot backup never touches links.json", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(home, ".agents", "skills", "a", "SKILL.md"), "a");
  await linkSkill(claudeDir, "a", path.join(home, ".agents", "skills", "a"));
  const res = await runCli(["backup", "--dir", sync, "--tool", "copilot"], claudeDir, home, { COPILOT_HOME: path.join(home, "copilot-local") });
  assert.equal(res.code, 0, res.stderr);
  await assert.rejects(fs.stat(path.join(sync, "links.json")), { code: "ENOENT" });
});

test("backup refuses to write links.json through a symlink", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(home, ".agents", "skills", "a", "SKILL.md"), "a");
  await linkSkill(claudeDir, "a", path.join(home, ".agents", "skills", "a"));
  const outside = path.join(home, "outside.json");
  await fs.symlink(outside, path.join(sync, "links.json"));
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /Refusing to write .*links\.json.*symlink/);
  await assert.rejects(fs.stat(outside), { code: "ENOENT" });
});

test("backup keeps other tools' keys in an existing links.json", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  const other = [{ link: "x", target: "y" }];
  await writeFile(path.join(sync, "links.json"), JSON.stringify({ other }, null, 2) + "\n");
  git(sync, "add", "-A");
  git(sync, "commit", "-m", "seed");
  await writeFile(path.join(home, ".agents", "skills", "a", "SKILL.md"), "a");
  await linkSkill(claudeDir, "a", path.join(home, ".agents", "skills", "a"));
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(git(sync, "show", "HEAD:links.json")), { other, claude: [{ link: "a", target: "a" }] });
});

test("backup refuses a malformed links.json and leaves it unchanged", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(home, ".agents", "skills", "a", "SKILL.md"), "a");
  await linkSkill(claudeDir, "a", path.join(home, ".agents", "skills", "a"));
  await writeFile(path.join(sync, "links.json"), "{not json");
  const res = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /links\.json/);
  assert.equal(await fs.readFile(path.join(sync, "links.json"), "utf8"), "{not json");
});

async function restoreSetup(t: TestContext, manifest: string | undefined, skills = ["a"]) {
  const ctx = await setup(t);
  await fs.rm(ctx.claudeDir, { recursive: true });
  await writeFile(path.join(ctx.sync, "claude", "CLAUDE.md"), "hello");
  for (const name of skills) await writeFile(path.join(ctx.sync, "agents", "skills", name, "SKILL.md"), name);
  if (manifest !== undefined) await writeFile(path.join(ctx.sync, "links.json"), manifest);
  return { ...ctx, skills: path.join(ctx.claudeDir, "skills"), agents: path.join(ctx.home, ".agents", "skills") };
}

const manifestOf = (...links: unknown[]) => JSON.stringify({ claude: links });

test("backup then restore into a fresh home recreates the skill symlink", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(home, ".agents", "skills", "a", "SKILL.md"), "a");
  await linkSkill(claudeDir, "alias", path.join(home, ".agents", "skills", "a"));
  assert.equal((await runCli(["backup", "--dir", sync], claudeDir, home)).code, 0);

  const home2 = await tmp(t);
  const claude2 = path.join(home2, "claude-local");
  // Copy without .git so restore does not try to pull from a remote.
  const plain = path.join(home2, "plain");
  await fs.cp(sync, plain, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
  const res = await runCli(["restore", "--dir", plain], claude2, home2);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^link: skills[\\/]alias$/m);
  const link = path.join(claude2, "skills", "alias");
  assert.equal(await fs.readlink(link), path.relative(path.dirname(link), path.join(home2, ".agents", "skills", "a")));
  assert.equal(await fs.readFile(path.join(link, "SKILL.md"), "utf8"), "a");
  await assert.rejects(fs.stat(path.join(claude2, "links.json")), { code: "ENOENT" });

  const again = await runCli(["restore", "--dir", plain], claude2, home2);
  assert.doesNotMatch(again.stdout, /link:/);
  assert.equal(again.stderr, "");
});

test("restore leaves a real directory at the link path untouched and warns", opts, async (t) => {
  const { home, claudeDir, sync, skills } = await restoreSetup(t, manifestOf({ link: "alias", target: "a" }));
  await writeFile(path.join(skills, "alias", "mine.md"), "mine");
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /alias/);
  assert.doesNotMatch(res.stdout, /link:/);
  assert.equal(await fs.readFile(path.join(skills, "alias", "mine.md"), "utf8"), "mine");
});

test("restore leaves a symlink pointing elsewhere untouched", opts, async (t) => {
  const { home, claudeDir, sync, skills } = await restoreSetup(t, manifestOf({ link: "alias", target: "a" }), ["a", "b"]);
  await linkSkill(claudeDir, "alias", path.join(home, ".agents", "skills", "b"));
  const before = await fs.readlink(path.join(skills, "alias"));
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /alias/);
  assert.equal(await fs.readlink(path.join(skills, "alias")), before);
});

test("restore dry-run prints would link and creates nothing", opts, async (t) => {
  const { home, claudeDir, sync, skills } = await restoreSetup(t, manifestOf({ link: "alias", target: "a" }));
  const res = await runCli(["restore", "--dir", sync, "--dry-run"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^would link: skills[\\/]alias$/m);
  await assert.rejects(fs.lstat(path.join(skills, "alias")), { code: "ENOENT" });
});

test("restore skips invalid link names and writes nothing outside skills", opts, async (t) => {
  const bad = ["..", "a/b", ".", "", "a\\b"].map((link) => ({ link, target: "a" }));
  const { home, claudeDir, sync, skills } = await restoreSetup(t, manifestOf(...bad, { link: 5, target: "a" }, { link: "x", target: "../a" }));
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /link:/);
  assert.ok(res.stderr.length > 0);
  assert.deepEqual(await fs.readdir(skills).catch(() => []), []);
  assert.deepEqual((await fs.readdir(claudeDir)).sort(), ["CLAUDE.md"]);
});

test("restore skips a link whose target is missing", opts, async (t) => {
  const { home, claudeDir, sync, skills } = await restoreSetup(t, manifestOf({ link: "alias", target: "gone" }));
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /gone/);
  await assert.rejects(fs.lstat(path.join(skills, "alias")), { code: "ENOENT" });
});

test("restore skips all links when the skills folder is a symlink", opts, async (t) => {
  const { home, claudeDir, sync, skills } = await restoreSetup(t, manifestOf({ link: "alias", target: "a" }));
  const elsewhere = path.join(home, "elsewhere");
  await fs.mkdir(elsewhere);
  await fs.mkdir(claudeDir);
  await fs.symlink(elsewhere, skills);
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /skills/);
  assert.deepEqual(await fs.readdir(elsewhere), []);
});

test("restore fails clearly on a malformed links.json", opts, async (t) => {
  for (const manifest of ["{not json", '{"claude": "x"}', "[]"]) {
    const { home, claudeDir, sync } = await restoreSetup(t, manifest);
    const res = await runCli(["restore", "--dir", sync], claudeDir, home);
    assert.notEqual(res.code, 0, manifest);
    assert.match(res.stderr, /links\.json/);
  }
});

test("Copilot restore ignores links.json", opts, async (t) => {
  const { home, claudeDir, sync, skills } = await restoreSetup(t, "{not json");
  await writeFile(path.join(sync, "copilot", "x.md"), "x");
  const res = await runCli(["restore", "--dir", sync, "--tool", "copilot"], claudeDir, home, { COPILOT_HOME: path.join(home, "copilot-local") });
  assert.equal(res.code, 0, res.stderr);
  await assert.rejects(fs.lstat(skills), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(home, "copilot-local", "links.json")), { code: "ENOENT" });
});

test("restore builds a working link when the Claude home is a symlink", opts, async (t) => {
  const { home, sync } = await restoreSetup(t, manifestOf({ link: "alias", target: "a" }));
  const real = path.join(home, "dotfiles", "deep", "claude");
  await fs.mkdir(real, { recursive: true });
  const claudeLink = path.join(home, "claude-link");
  await fs.symlink(real, claudeLink);
  const res = await runCli(["restore", "--dir", sync], claudeLink, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^link: skills[\\/]alias$/m);
  assert.equal(await fs.readFile(path.join(real, "skills", "alias", "SKILL.md"), "utf8"), "a");
});

test("restore stays silent for a correct absolute link", opts, async (t) => {
  const { home, claudeDir, sync, skills, agents } = await restoreSetup(t, manifestOf({ link: "alias", target: "a" }));
  await fs.mkdir(agents, { recursive: true });
  await fs.mkdir(skills, { recursive: true });
  await fs.symlink(path.join(agents, "a"), path.join(skills, "alias"), "dir");
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, "");
  assert.doesNotMatch(res.stdout, /link:/);
});

test("restore that only creates links does not print Nothing to sync", opts, async (t) => {
  const { home, claudeDir, sync } = await restoreSetup(t, manifestOf({ link: "alias", target: "a" }));
  assert.equal((await runCli(["restore", "--dir", sync], claudeDir, home)).code, 0);
  await fs.rm(path.join(claudeDir, "skills", "alias"));
  const res = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^link: skills[\\/]alias$/m);
  assert.doesNotMatch(res.stdout, /new:|Nothing to sync/);
});

test("restore warns and continues when the skills folder is read-only", opts, async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs permission checks");
  const { home, claudeDir, sync, skills } = await restoreSetup(t, manifestOf({ link: "alias", target: "a" }));
  await fs.mkdir(skills, { recursive: true });
  await fs.chmod(skills, 0o555);
  try {
    const res = await runCli(["restore", "--dir", sync], claudeDir, home);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stderr, /not allowed to create symlinks/);
  } finally {
    await fs.chmod(skills, 0o755);
  }
});

test("backup --prune commits the removal of entries missing locally, including global agents", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(claudeDir, "CLAUDE.md"), "hello");
  await writeFile(path.join(home, ".agents", "skills", "x", "SKILL.md"), "shared");
  await writeFile(path.join(home, ".agents", ".skill-lock.json"), "{}");
  assert.equal((await runCli(["backup", "--dir", sync], claudeDir, home)).code, 0);
  await fs.rm(claudeDir, { recursive: true });
  await fs.rm(path.join(home, ".agents"), { recursive: true });
  const plain = await runCli(["backup", "--dir", sync], claudeDir, home);
  assert.match(plain.stdout, /Nothing to sync\./);
  assert.equal(await fs.readFile(path.join(sync, "claude", "CLAUDE.md"), "utf8"), "hello");
  const res = await runCli(["backup", "--dir", sync, "--prune"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  await assert.rejects(fs.stat(path.join(sync, "claude", "CLAUDE.md")));
  await assert.rejects(fs.stat(path.join(sync, "agents", "skills", "x", "SKILL.md")));
  await assert.rejects(fs.stat(path.join(sync, "agents", ".skill-lock.json")));
  const deleted = git(sync, "show", "--name-status", "--format=", "HEAD");
  assert.match(deleted, /^D\tclaude\/CLAUDE\.md$/m);
  assert.match(deleted, /^D\tagents\/skills\/x\/SKILL\.md$/m);
  assert.match(deleted, /^D\tagents\/\.skill-lock\.json$/m);
  assert.equal(git(sync, "status", "--porcelain"), "");
});

test("dry-run backup --prune reports the deletion and changes nothing", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  await writeFile(path.join(claudeDir, "CLAUDE.md"), "hello");
  assert.equal((await runCli(["backup", "--dir", sync], claudeDir, home)).code, 0);
  await fs.rm(path.join(claudeDir, "CLAUDE.md"));
  const res = await runCli(["backup", "--dir", sync, "--prune", "--dry-run"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /would delete: CLAUDE\.md/);
  assert.equal(await fs.readFile(path.join(sync, "claude", "CLAUDE.md"), "utf8"), "hello");
  assert.equal(git(sync, "rev-list", "--count", "HEAD"), "1");
});

test("restore --prune deletes allowlisted entries missing in the repo after backing them up", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "claude", "CLAUDE.md"), "hello");
  await writeFile(path.join(claudeDir, "commands", "x.md"), "mine");
  await writeFile(path.join(claudeDir, "keep.txt"), "never synced");
  await writeFile(path.join(claudeDir, ".credentials.json"), "secret");
  const plain = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(await fs.readFile(path.join(claudeDir, "commands", "x.md"), "utf8"), "mine");
  const res = await runCli(["restore", "--dir", sync, "--prune"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /delete: commands\/x\.md/);
  await assert.rejects(fs.stat(path.join(claudeDir, "commands", "x.md")));
  const stamps = await fs.readdir(path.join(home, ".ark", "backups", "claude"));
  assert.match(res.stdout, new RegExp(`Previous local files saved to .*${stamps[0]}`));
  assert.equal(await fs.readFile(path.join(home, ".ark", "backups", "claude", stamps[0], "commands", "x.md"), "utf8"), "mine");
  assert.equal(await fs.readFile(path.join(claudeDir, "keep.txt"), "utf8"), "never synced");
  assert.equal(await fs.readFile(path.join(claudeDir, ".credentials.json"), "utf8"), "secret");
});

test("restore --prune honors --exclude and --dry-run", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "claude", "CLAUDE.md"), "hello");
  await writeFile(path.join(claudeDir, "commands", "x.md"), "mine");
  await writeFile(path.join(claudeDir, "hooks", "h.sh"), "mine");
  const dry = await runCli(["restore", "--dir", sync, "--prune", "--dry-run", "--exclude", "hooks"], claudeDir, home);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /would delete: commands\/x\.md/);
  assert.doesNotMatch(dry.stdout, /hooks/);
  assert.equal(await fs.readFile(path.join(claudeDir, "commands", "x.md"), "utf8"), "mine");
  await assert.rejects(fs.stat(path.join(home, ".ark", "backups")), { code: "ENOENT" });
  const res = await runCli(["restore", "--dir", sync, "--prune", "--exclude", "hooks"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  await assert.rejects(fs.stat(path.join(claudeDir, "commands", "x.md")));
  assert.equal(await fs.readFile(path.join(claudeDir, "hooks", "h.sh"), "utf8"), "mine");
});

test("restore --prune still fails when the repo folder is missing", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "agents", "skills", "x", "SKILL.md"), "shared");
  await writeFile(path.join(claudeDir, "commands", "x.md"), "mine");
  const res = await runCli(["restore", "--dir", sync, "--prune"], claudeDir, home);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /Folder .*claude.* does not exist/);
  assert.equal(await fs.readFile(path.join(claudeDir, "commands", "x.md"), "utf8"), "mine");
});

test("global agents restore --prune deletes local entries missing in the agents repo", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "claude", "CLAUDE.md"), "hello");
  await writeFile(path.join(home, ".agents", "skills", "a", "SKILL.md"), "local");
  await writeFile(path.join(home, ".agents", ".skill-lock.json"), "{}");
  await writeFile(path.join(home, ".agents", "other.txt"), "never synced");
  const res = await runCli(["restore", "--dir", sync, "--prune"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /delete: agents\/skills\/a\/SKILL\.md/);
  await assert.rejects(fs.stat(path.join(home, ".agents", "skills", "a", "SKILL.md")));
  await assert.rejects(fs.stat(path.join(home, ".agents", ".skill-lock.json")));
  assert.equal(await fs.readFile(path.join(home, ".agents", "other.txt"), "utf8"), "never synced");
  const stamps = await fs.readdir(path.join(home, ".ark", "backups", "agents"));
  assert.equal(await fs.readFile(path.join(home, ".ark", "backups", "agents", stamps[0], "skills", "a", "SKILL.md"), "utf8"), "local");
  assert.equal(await fs.readFile(path.join(home, ".ark", "backups", "agents", stamps[0], ".skill-lock.json"), "utf8"), "{}");
  assert.match(res.stdout, /Previous local files saved to .*agents/);
});

test("restore --prune deletes the local plugin cache when the repo has none", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await writeFile(path.join(sync, "claude", "CLAUDE.md"), "hello");
  await writeFile(path.join(sync, "claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "p@m": [{ installPath: path.join(claudeDir, "plugins", "cache", "m", "p", "1.0.0") }] } }));
  const active = path.join(claudeDir, "plugins", "cache", "m", "p", "1.0.0", "a.txt");
  const stale = path.join(claudeDir, "plugins", "cache", "m", "p", "0.9.0", "b.txt");
  await writeFile(active, "a");
  await writeFile(stale, "b");
  const plain = await runCli(["restore", "--dir", sync], claudeDir, home);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(await fs.readFile(active, "utf8"), "a");
  assert.equal(await fs.readFile(stale, "utf8"), "b");
  const res = await runCli(["restore", "--dir", sync, "--prune"], claudeDir, home);
  assert.equal(res.code, 0, res.stderr);
  await assert.rejects(fs.stat(active));
  await assert.rejects(fs.stat(stale));
  const [stamp] = await fs.readdir(path.join(home, ".ark", "backups", "claude"));
  const saved = path.join(home, ".ark", "backups", "claude", stamp, "plugins", "cache", "m", "p");
  assert.equal(await fs.readFile(path.join(saved, "1.0.0", "a.txt"), "utf8"), "a");
  assert.equal(await fs.readFile(path.join(saved, "0.9.0", "b.txt"), "utf8"), "b");
});

test("backup without --tool prunes a tool whose home is gone but whose repo folder remains", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  const copilotDir = path.join(home, "copilot-local");
  await fs.mkdir(copilotDir);
  await fs.writeFile(path.join(copilotDir, "settings.json"), "hi");
  const env = { COPILOT_HOME: copilotDir };
  assert.equal((await runCli(["backup", "--dir", sync, "--tool", "copilot"], claudeDir, home, env)).code, 0);
  await fs.rm(copilotDir, { recursive: true });
  await fs.rm(claudeDir, { recursive: true });
  await fs.mkdir(path.join(sync, "claude"), { recursive: true });
  const dry = await runCli(["backup", "--prune", "--dry-run", "--dir", sync], claudeDir, home, env);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /would delete: settings\.json/);
  await fs.stat(path.join(sync, "copilot", "settings.json"));
  const res = await runCli(["backup", "--prune", "--dir", sync], claudeDir, home, env);
  assert.equal(res.code, 0);
  assert.match(git(sync, "log", "-1", "--format=%s"), /^sync\(copilot\): /);
  await assert.rejects(fs.stat(path.join(sync, "copilot", "settings.json")), { code: "ENOENT" });
});

test("backup without --tool makes one commit per tool and syncs agents once", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  const copilotDir = path.join(home, "copilot-local");
  const opencodeDir = path.join(home, "xdg", "opencode");
  await fs.mkdir(copilotDir);
  await fs.writeFile(path.join(copilotDir, "settings.json"), "hi");
  await fs.mkdir(opencodeDir, { recursive: true });
  await fs.writeFile(path.join(opencodeDir, "AGENTS.md"), "oc");
  await fs.mkdir(path.join(home, ".agents", "skills", "s"), { recursive: true });
  await fs.writeFile(path.join(home, ".agents", "skills", "s", "SKILL.md"), "skill");
  const env = { COPILOT_HOME: copilotDir, XDG_CONFIG_HOME: path.join(home, "xdg") };
  const res = await runCli(["backup", "--dir", sync], claudeDir, home, env);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /== claude ==/);
  assert.match(res.stdout, /== opencode ==/);
  const subjects = git(sync, "log", "--format=%s").split("\n").map((line) => line.replace(/: .*/, "")).reverse();
  assert.deepEqual(subjects, ["sync(claude)", "sync(copilot)", "sync(opencode)"]);
  const withAgents = git(sync, "log", "--format=%H", "--", "agents").split("\n").filter(Boolean);
  assert.equal(withAgents.length, 1);
});

test("backup without --tool checks each tool's saved includes against its own blocked list", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  const opencodeDir = path.join(home, "xdg", "opencode");
  await fs.mkdir(path.join(opencodeDir, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(opencodeDir, "node_modules", "x.txt"), "dep");
  await fs.mkdir(path.join(home, ".ark"), { recursive: true });
  await fs.writeFile(path.join(home, ".ark", "config.json"), JSON.stringify({ include: { opencode: ["node_modules"] } }));
  const env = { XDG_CONFIG_HOME: path.join(home, "xdg") };
  const res = await runCli(["backup", "--dir", sync], claudeDir, home, env);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /never synced/);
  await assert.rejects(fs.stat(path.join(sync, "opencode", "node_modules")), { code: "ENOENT" });

  // "sessions" is blocked for claude but not for copilot.
  const copilotDir = path.join(home, "copilot-local");
  await fs.mkdir(path.join(copilotDir, "sessions"), { recursive: true });
  await fs.writeFile(path.join(copilotDir, "sessions", "a.txt"), "ok");
  await fs.writeFile(path.join(home, ".ark", "config.json"), JSON.stringify({ include: { copilot: ["sessions"] } }));
  const ok = await runCli(["backup", "--dir", sync], claudeDir, home, { ...env, COPILOT_HOME: copilotDir });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(await fs.readFile(path.join(sync, "copilot", "sessions", "a.txt"), "utf8"), "ok");
});

test("backup without --tool rejects --include and --exclude; with --tool they work", opts, async (t) => {
  const { home, claudeDir, sync } = await setup(t);
  await initRepo(sync);
  for (const flag of ["--include", "--exclude"]) {
    const res = await runCli(["backup", "--dir", sync, flag, "x"], claudeDir, home);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /need --tool/);
  }
  assert.equal(git(sync, "status", "--porcelain").trim(), "");
  assert.equal((await runCli(["backup", "--dir", sync, "--tool", "claude", "--include", "x"], claudeDir, home)).code, 0);
  const plain = path.join(home, "plain");
  await fs.mkdir(path.join(plain, "claude"), { recursive: true });
  await fs.writeFile(path.join(plain, "claude", "CLAUDE.md"), "r");
  const restored = await runCli(["restore", "--dir", plain, "--exclude", "x"], claudeDir, home);
  assert.equal(restored.code, 0, restored.stderr);
});

test("backup without --tool fails when no tool applies; --tool claude still works", async (t) => {
  const home = await tmp(t);
  const sync = path.join(home, "sync");
  await fs.mkdir(sync);
  const missing = path.join(home, "none");
  const res = await runCli(["backup", "--dir", sync], missing, home);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /No tool to back up/);
  const ok = await runCli(["backup", "--dir", sync, "--tool", "claude"], missing, home);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), "Nothing to sync.");
});
