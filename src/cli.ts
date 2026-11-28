#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { adapters, globalAdapters } from "./adapters/index.ts";
import type { ToolAdapter } from "./adapters/types.ts";
import { addIncludes, readIncludes, resolveRepoDir, saveRepoDir } from "./config.ts";
import { commitAndPush, gitClone, gitPull, hasChanges, isGitBacked } from "./git.ts";
import { LINKS_FILE, restoreSkillLinks, scanSkillLinks, writeLinksManifest } from "./links.ts";
import { copyFiles, isBlocked, isErrno, listFiles, listTopLevel, normalizeUserPath, uniqueByKey } from "./sync.ts";

const usage =
  "Usage: ark init <git-url>\n       ark <backup|restore> [--tool claude|copilot|opencode|pi] [--dry-run] [--prune] [--include <path>]... [--exclude <path>]...\n       ark -h|--help\nThe repo lives in ~/.ark/repo (--dir <path> overrides it). ~/.agents (skills/, docs/ and .skill-lock.json) is also synced on every backup/restore. Without --tool, backup processes every tool that is installed or already in the repo (claude, copilot, opencode, pi); restore uses claude. --include (backup only) adds a file or folder (relative to the selected tool's folder) to the backup and saves it in ~/.ark/config.json for later runs; repeat it for several. --exclude skips a file or folder (relative to the selected tool's folder) for this run only; repeat it for several. On backup, --include and --exclude need --tool. Files removed from a synced folder are removed on the other side too (restore saves them to ~/.ark/backups first). --prune also removes an allowlisted entry that is missing entirely at the source from the destination (backup: the repo copy; restore: the local copy, saved to ~/.ark/backups first).";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tool: { type: "string" },
      dir: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      prune: { type: "boolean", default: false },
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
  if (values.tool !== undefined && !Object.hasOwn(adapters, values.tool)) throw new Error(`Unknown tool "${values.tool}". Available: ${Object.keys(adapters).join(", ")}`);
  const checkPath = (item: string, label: string, blocked: readonly string[] | false) => {
    try {
      const normalized = normalizeUserPath(item);
      if (blocked && isBlocked(normalized.split(path.sep)[0], blocked)) throw new Error(`Invalid path "${item}": never synced`);
      return normalized;
    } catch (err) {
      throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (values.include.length > 0 && command !== "backup") throw new Error("--include only applies to backup");
  if (command === "backup" && values.tool === undefined && (values.include.length > 0 || values.exclude.length > 0)) {
    throw new Error("--include and --exclude need --tool when backing up: their paths are relative to one tool's folder");
  }
  const exclude = values.exclude.map((item) => checkPath(item, "--exclude", false));
  const runIncludes = values.include.map((item) => checkPath(item, "--include", adapters[values.tool!].blocked));

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
  const gitBacked = await isGitBacked(syncDir);

  const exists = (target: string) => fs.stat(target).then(() => true, (err: unknown) => {
    if (isErrno(err, "ENOENT")) return false;
    throw err;
  });
  const applicableTools = async () => {
    const found: string[] = [];
    for (const name of Object.keys(adapters)) {
      if ((await exists(adapters[name].resolveHome(process.env, homedir))) || (await exists(path.join(syncDir, name)))) found.push(name);
    }
    if (found.length === 0) {
      throw new Error(`No tool to back up: none of ${Object.keys(adapters).join(", ")} has a local config folder or a folder in the repo. Pass --tool <name> to back up one explicitly.`);
    }
    return found;
  };
  const tools = command === "backup" && values.tool === undefined ? await applicableTools() : [values.tool ?? "claude"];

  for (const [index, tool] of tools.entries()) {
    const adapter = adapters[tool];
    if (tools.length > 1) console.log(`== ${tool} ==`);
    const local = adapter.resolveHome(process.env, homedir);
    const remote = path.join(syncDir, adapter.name);
    const skillTarget = adapter.skillLinks && { tool: adapter.name, home: local, dir: adapter.skillLinks.dir };

    const { transform: adapterTransform } = adapter;
    const backupTransform = adapterTransform && ((file: string, data: Buffer) => adapterTransform("backup", file, data, local));
    const restoreTransform = adapterTransform && ((file: string, data: Buffer) => adapterTransform("restore", file, data, local));
    const toRepoPath = (target: ToolAdapter, file: string) => path.posix.join(target.name, file.split(path.sep).join("/"));

    let changes;
    let backupPaths: string[] = [];
    const savedBackupDirs: string[] = [];
    const savedIncludes = (await readIncludes(homedir, adapter.name)).map((item) => checkPath(item, "config include", adapter.blocked));
    if (command === "backup") {
      const backupAdapter = async (target: ToolAdapter, entries: readonly string[], options: Parameters<typeof copyFiles>[3]) => {
        const source = target.resolveHome(process.env, homedir);
        const destination = path.join(syncDir, target.name);
        const copied = await copyFiles(source, destination, entries, options);
        let paths: string[] = [];
        if (gitBacked) {
          // Deleted files are gone from disk, so listFiles misses them; add them so the commit records the removal.
          const present = (await listFiles(destination, entries, options.exclude)).map((file) => toRepoPath(target, file));
          const deleted = copied.filter((change) => change.kind === "delete").map((change) => toRepoPath(target, change.file));
          paths = [...present, ...deleted];
        }
        return { changes: copied, paths };
      };
      const backupEntries = uniqueByKey([...adapter.allowlist, ...savedIncludes, ...runIncludes]);
      const filter = await adapter.activeFilter?.(local);
      ({ changes, paths: backupPaths } = await backupAdapter(adapter, backupEntries, { dryRun, guardDest: true, transform: backupTransform, exclude, filter, pruneMissing: values.prune }));
      // ~/.agents is shared by all tools, so only the first one syncs it.
      for (const globalAdapter of index === 0 ? globalAdapters : []) {
        const result = await backupAdapter(globalAdapter, globalAdapter.allowlist, { dryRun, guardDest: true, exclude: [], pruneMissing: values.prune });
        changes.push(...result.changes.map((change) => ({ ...change, file: toRepoPath(globalAdapter, change.file) })));
        backupPaths.push(...result.paths);
      }
      if (skillTarget) {
        const agentsHome = globalAdapters.find((item) => item.name === "agents")!.resolveHome(process.env, homedir);
        const change = await writeLinksManifest(syncDir, adapter.name, await scanSkillLinks(skillTarget, agentsHome), dryRun);
        if (change) changes.push(change);
        if (gitBacked) backupPaths.push(LINKS_FILE);
      }
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
      const pruneEntries = uniqueByKey([...adapter.allowlist, ...savedIncludes]);
      // The repo manifest decides which plugin versions are live; the other versions in the repo stay there.
      const filter = await adapter.activeFilter?.(remote);
      changes = await copyFiles(remote, local, entries, { dryRun, backupDir, transform: restoreTransform, exclude, pruneEntries, filter, pruneMissing: values.prune });
      // Only updates and deletes replace existing local files.
      if (!dryRun && changes.some((change) => change.kind !== "new")) savedBackupDirs.push(backupDir);
      for (const globalAdapter of globalAdapters) {
        const globalRemote = path.join(syncDir, globalAdapter.name);
        const globalLocal = globalAdapter.resolveHome(process.env, homedir);
        const globalBackupDir = path.join(homedir, ".ark", "backups", globalAdapter.name, stamp);
        const globalEntries = await listTopLevel(globalRemote);
        const copied = await copyFiles(globalRemote, globalLocal, globalEntries, {
          dryRun, backupDir: globalBackupDir, exclude: [], pruneEntries: globalAdapter.allowlist, pruneMissing: values.prune,
        });
        if (!dryRun && copied.some((change) => change.kind !== "new")) savedBackupDirs.push(globalBackupDir);
        changes.push(...copied.map((change) => ({ ...change, file: toRepoPath(globalAdapter, change.file) })));
      }
      // After the ~/.agents restore, so the link targets exist.
      if (skillTarget) {
        const agentsHome = globalAdapters.find((item) => item.name === "agents")!.resolveHome(process.env, homedir);
        changes.push(...(await restoreSkillLinks(syncDir, skillTarget, agentsHome, dryRun)));
      }
    }

    for (const change of changes) console.log(`${dryRun ? "would " : ""}${change.kind}: ${change.file}`);
    if (changes.length === 0) console.log("Nothing to sync.");
    for (const dir of savedBackupDirs) console.log(`Previous local files saved to ${dir}`);

    if (gitBacked && command === "backup") {
      const paths = [...new Set(backupPaths)];
      if (dryRun) {
        if (changes.length > 0 || (await hasChanges(syncDir, paths))) console.log("would commit");
      } else {
        const message = await commitAndPush(syncDir, adapter.name, paths);
        if (message) console.log(message);
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
