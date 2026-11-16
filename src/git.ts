import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isErrno } from "./sync.ts";

// A `.git` entry at the sync dir root (directory, or file for worktrees) marks it as git-backed.
// Checking the filesystem avoids spawning git for plain folders and ignores unrelated parent repos.
export async function isGitBacked(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch (err) {
    if (isErrno(err, "ENOENT")) return false;
    throw err;
  }
}

// Literal pathspecs keep synced file names from being read as pathspec magic; no optional
// locks keeps read-only calls (status) from refreshing .git/index.
function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["--literal-pathspecs", "--no-optional-locks", "-C", dir, ...args], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

// Run without a shell and without -C: the target folder does not exist yet. "--" keeps a URL from being read as an option.
export function gitClone(url: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", ["clone", "--", url, dir], (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve();
    });
  });
}

export async function gitPull(dir: string): Promise<void> {
  await git(dir, ["pull", "--ff-only"]);
}

// `paths` are the allowlisted files only, so stray or secret files in the sync folder are never committed.
// Status leaves out gitignored files, which `git add` would otherwise reject.
async function changedPaths(dir: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const entries = (await git(dir, ["status", "--porcelain", "-z", "--", ...paths])).split("\0").filter(Boolean);
  const changed: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    changed.push(entries[i].slice(3));
    if (/[RC]/.test(entries[i].slice(0, 2))) i++; // rename/copy entries are followed by the original path
  }
  return changed;
}

export async function hasChanges(dir: string, paths: string[]): Promise<boolean> {
  return (await changedPaths(dir, paths)).length > 0;
}

export async function commitAndPush(dir: string, tool: string, paths: string[]): Promise<string> {
  const changed = await changedPaths(dir, paths);
  const committed = changed.length > 0;
  if (committed) {
    await git(dir, ["add", "-A", "--", ...changed]);
    await git(dir, ["commit", "-m", `sync(${tool}): ${new Date().toISOString()}`, "--", ...changed]);
  }
  const remotes = (await git(dir, ["remote"])).split("\n");
  if (!remotes.includes("origin")) {
    return committed ? "No remote named origin is configured; committed locally, nothing was pushed." : "";
  }
  // Always push: an earlier push may have failed after its commit succeeded.
  const hasHead = await git(dir, ["rev-parse", "--verify", "-q", "HEAD"]).then(() => true, () => false);
  if (!hasHead) return "";
  const hasUpstream = await git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).then(() => true, () => false);
  await git(dir, hasUpstream ? ["push"] : ["push", "--set-upstream", "origin", "HEAD"]);
  return committed ? "Committed and pushed to origin." : "Pushed to origin.";
}
