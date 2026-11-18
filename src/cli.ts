#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { adapters } from "./adapters/index.ts";
import { addIncludes, readIncludes, resolveRepoDir, saveRepoDir } from "./config.ts";
import { commitAndPush, gitClone, gitPull, hasChanges, isGitBacked } from "./git.ts";
import { copyFiles, isBlocked, isErrno, listFiles, listTopLevel, normalizeUserPath, uniqueByKey } from "./sync.ts";

const usage =
  "Usage: ark init <git-url>\n       ark <backup|restore> [--tool claude] [--dry-run] [--include <path>]... [--exclude <path>]...\n       ark -h|--help\nThe repo lives in ~/.ark/repo (--dir <path> overrides it). --include (backup only) adds a file or folder (relative to the tool folder) to the backup and saves it in ~/.ark/config.json for later runs; repeat it for several. --exclude skips a file or folder (relative to the tool folder) for this run only; repeat it for several. Files removed from a synced folder are removed on the other side too (restore saves them to ~/.ark/backups first).";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tool: { type: "string", default: "claude" },
      dir: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      include: { type: "string", multiple: true, default: [] },
      exclude: { type: "string", multiple: true, default: [] },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const [command, url] = positionals;
  if (command === "init" ? positionals.length !== 2 : positionals.length !== 1 || (command !== "backup" && command !== "restore")) {
    throw new Error(usage);
  }
  if (!Object.hasOwn(adapters, values.tool)) throw new Error(`Unknown tool "${values.tool}". Available: ${Object.keys(adapters).join(", ")}`);
  const adapter = adapters[values.tool];
  const checkPath = (item: string, label: string, blockedCheck = true) => {
    try {
      const normalized = normalizeUserPath(item);
      if (blockedCheck && isBlocked(normalized.split(path.sep)[0], adapter.blocked)) throw new Error(`Invalid path "${item}": never synced`);
      return normalized;
    } catch (err) {
      throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (values.include.length > 0 && command !== "backup") throw new Error("--include only applies to backup");
  const exclude = values.exclude.map((item) => checkPath(item, "--exclude", false));
  const runIncludes = values.include.map((item) => checkPath(item, "--include"));

  const homedir = os.homedir();
  const dryRun = values["dry-run"];
  const syncDir = await resolveRepoDir({ flag: values.dir, homedir });

  if (command === "init") {
    if (await isGitBacked(syncDir)) {
      console.log(`Already initialized: ${syncDir} is a git repository. Nothing to do.`);
      return;
    }
    await fs.mkdir(path.dirname(syncDir), { recursive: true });
    await gitClone(url, syncDir);
    await saveRepoDir(homedir, syncDir);
    console.log(`Cloned into ${syncDir}.`);
    return;
  }
  await fs.stat(syncDir).catch((err: unknown) => {
    throw isErrno(err, "ENOENT") ? new Error(`Repo "${syncDir}" does not exist. Run "ark init <git-url>" first.`) : err;
  });
  const local = adapter.resolveHome(process.env, homedir);
  const remote = path.join(syncDir, adapter.name);

  const gitBacked = await isGitBacked(syncDir);

  const { transform: adapterTransform } = adapter;
  const backupTransform = adapterTransform && ((file: string, data: Buffer) => adapterTransform("backup", file, data, local));
  const restoreTransform = adapterTransform && ((file: string, data: Buffer) => adapterTransform("restore", file, data, local));

  let changes;
  let backupEntries: string[] = [];
  if (command === "backup") {
    const savedIncludes = (await readIncludes(homedir, adapter.name)).map((item) => checkPath(item, "config include"));
    backupEntries = uniqueByKey([...adapter.allowlist, ...savedIncludes, ...runIncludes]);
    changes = await copyFiles(local, remote, backupEntries, { dryRun, guardDest: true, transform: backupTransform, exclude });
    if (runIncludes.length > 0 && !dryRun) {
      await addIncludes(homedir, adapter.name, runIncludes.map((item) => item.split(path.sep).join("/")));
    }
  } else {
    if (gitBacked && !dryRun) await gitPull(syncDir);
    await fs.stat(remote).catch((err: unknown) => {
      throw isErrno(err, "ENOENT") ? new Error(`Folder "${remote}" does not exist. Run "ark init <git-url>" first, and "ark backup" on the machine that has the config.`) : err;
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(homedir, ".ark", "backups", adapter.name, stamp);
    const entries = (await listTopLevel(remote)).filter((name) => !isBlocked(name, adapter.blocked));
    changes = await copyFiles(remote, local, entries, { dryRun, backupDir, transform: restoreTransform, exclude });
  }

  for (const change of changes) console.log(`${dryRun ? "would " : ""}${change.kind}: ${change.file}`);
  if (changes.length === 0) console.log("Nothing to sync.");

  if (gitBacked && command === "backup") {
    // Deleted files are gone from disk, so listFiles misses them; add them so the commit records the removal.
    const toRepoPath = (file: string) => path.posix.join(adapter.name, file.split(path.sep).join("/"));
    const present = (await listFiles(remote, backupEntries, exclude)).map(toRepoPath);
    const deleted = changes.filter((change) => change.kind === "delete").map((change) => toRepoPath(change.file));
    const paths = [...new Set([...present, ...deleted])];
    if (dryRun) {
      if (changes.length > 0 || (await hasChanges(syncDir, paths))) console.log("would commit");
    } else {
      const message = await commitAndPush(syncDir, adapter.name, paths);
      if (message) console.log(message);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
