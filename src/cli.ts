#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { adapters } from "./adapters/index.ts";
import { resolveRepoDir, saveRepoDir } from "./config.ts";
import { commitAndPush, gitClone, gitPull, hasChanges, isGitBacked } from "./git.ts";
import { copyFiles, isErrno, listFiles } from "./sync.ts";

const usage =
  "Usage: ark init <git-url>\n       ark <backup|restore> [--tool claude] [--dry-run]\n       ark -h|--help\nThe repo lives in ~/.ark/repo (--dir <path> overrides it). Files are never deleted; removals do not propagate.";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tool: { type: "string", default: "claude" },
      dir: { type: "string" },
      "dry-run": { type: "boolean", default: false },
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
  if (command === "backup") {
    changes = await copyFiles(local, remote, adapter.allowlist, { dryRun, guardDest: true, transform: backupTransform });
  } else {
    if (gitBacked && !dryRun) await gitPull(syncDir);
    await fs.stat(remote).catch((err: unknown) => {
      throw isErrno(err, "ENOENT") ? new Error(`Folder "${remote}" does not exist. Run "ark init <git-url>" first, and "ark backup" on the machine that has the config.`) : err;
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(homedir, ".ark", "backups", adapter.name, stamp);
    changes = await copyFiles(remote, local, adapter.allowlist, { dryRun, backupDir, transform: restoreTransform });
  }

  for (const change of changes) console.log(`${dryRun ? "would " : ""}${change.kind}: ${change.file}`);
  if (changes.length === 0) console.log("Nothing to sync.");

  if (gitBacked && command === "backup") {
    const paths = (await listFiles(remote, adapter.allowlist)).map((file) => path.posix.join(adapter.name, file.split(path.sep).join("/")));
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
