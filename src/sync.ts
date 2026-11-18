import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface Change {
  file: string;
  kind: "new" | "update" | "delete";
}

export function isErrno(err: unknown, ...codes: string[]): boolean {
  return err instanceof Error && "code" in err && typeof err.code === "string" && codes.includes(err.code);
}

// OS metadata that tools write on their own; never worth syncing. "._*" are macOS AppleDouble files.
const OS_JUNK = new Set([".DS_Store", ".localized", "Thumbs.db", "ehthumbs.db", "desktop.ini"]);
const isOsJunk = (name: string) => OS_JUNK.has(name) || name.startsWith("._");

// Regular files only: symlinks and special files are skipped.
async function walk(root: string, rel: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch (err) {
    if (isErrno(err, "ENOENT", "ENOTDIR")) return;
    throw err;
  }
  for (const entry of entries) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) await walk(root, child, out);
    else if (entry.isFile() && !isOsJunk(entry.name)) out.push(child);
  }
}

// Stat of the entry itself; a symlink at any segment yields that link's stat, so callers skip it.
async function statEntry(root: string, item: string): Promise<Stats | undefined> {
  // Every segment is checked, so a symlinked parent of a nested entry is skipped too.
  const parts = item.split(path.sep);
  let stat: Stats | undefined;
  try {
    for (let i = 1; i <= parts.length; i++) {
      stat = await fs.lstat(path.join(root, ...parts.slice(0, i)));
      if (stat.isSymbolicLink()) break;
    }
  } catch (err) {
    if (isErrno(err, "ENOENT", "ENOTDIR")) return undefined;
    throw err;
  }
  return stat;
}

export async function listFiles(root: string, allowlist: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of allowlist) {
    const item = path.normalize(entry);
    const stat = await statEntry(root, item);
    if (!stat) continue;
    if (stat.isFile()) out.push(item);
    else if (stat.isDirectory()) await walk(root, item, out);
  }
  return out.sort();
}

// The sync dir is a shared folder, so it must not redirect writes elsewhere.
async function assertNoSymlink(root: string, rel: string): Promise<void> {
  // The root itself is checked too; the dirs above it were chosen by the user.
  let current = root;
  for (const part of ["", ...rel.split(path.sep)]) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(`Refusing to write through symlink: ${current}`);
      }
    } catch (err) {
      if (isErrno(err, "ENOENT")) return;
      throw err;
    }
  }
}

async function readIfExists(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (err) {
    if (isErrno(err, "ENOENT")) return undefined;
    throw err;
  }
}

export async function copyFiles(
  from: string,
  to: string,
  allowlist: readonly string[],
  opts: {
    dryRun: boolean;
    // Replaced files are saved here, outside the synced dirs.
    backupDir?: string;
    // Reject symlinks along the destination path (set when the destination is the sync dir).
    guardDest?: boolean;
    // Rewrites file content before comparing and writing; backups keep the raw destination bytes.
    transform?: (file: string, data: Buffer) => Buffer;
  },
): Promise<Change[]> {
  const changes: Change[] = [];
  for (const file of await listFiles(from, allowlist)) {
    let dest = path.join(to, file);
    if (opts.guardDest) await assertNoSymlink(to, file);
    const [rawData, destData] = await Promise.all([fs.readFile(path.join(from, file)), readIfExists(dest)]);
    const srcData = opts.transform ? opts.transform(file, rawData) : rawData;
    if (destData?.equals(srcData)) continue;
    changes.push({ file, kind: destData ? "update" : "new" });
    if (opts.dryRun) continue;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (destData && opts.backupDir) {
      const backup = path.join(opts.backupDir, file);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.writeFile(backup, destData);
    }
    // Write through a symlinked local file (e.g. dotfiles) instead of replacing the link.
    if (destData) dest = await fs.realpath(dest);
    // Rename is atomic, so a crash never leaves a truncated file.
    const tmp = `${dest}.tmp-${process.pid}`;
    try {
      await fs.writeFile(tmp, srcData);
      await fs.rename(tmp, dest);
    } catch (err) {
      // A leftover temp file inside a synced dir would be picked up by the next run.
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
  await prune(from, to, allowlist, opts, changes);
  return changes;
}

// Case/normalization-insensitive so a case-only rename on APFS/NTFS never deletes the live file.
const pathKey = (file: string) => file.normalize("NFC").toLowerCase();

// Removes destination files that no longer exist in the source, only inside entries the source still has.
async function prune(
  from: string,
  to: string,
  allowlist: readonly string[],
  opts: { dryRun: boolean; backupDir?: string; guardDest?: boolean },
  changes: Change[],
): Promise<void> {
  for (const entry of allowlist) {
    const item = path.normalize(entry);
    const stat = await statEntry(from, item);
    // A missing or symlinked source entry says nothing about what should exist.
    if (!stat?.isFile() && !stat?.isDirectory()) continue;
    const kept = new Set((await listFiles(from, [item])).map(pathKey));
    for (const file of await listFiles(to, [item])) {
      if (kept.has(pathKey(file))) continue;
      if (opts.guardDest) await assertNoSymlink(to, file);
      changes.push({ file, kind: "delete" });
      if (opts.dryRun) continue;
      const dest = path.join(to, file);
      if (opts.backupDir) {
        const backup = path.join(opts.backupDir, file);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.writeFile(backup, await fs.readFile(dest));
      }
      await fs.rm(dest);
      await removeEmptyDirs(to, file, item);
    }
  }
}

// Walks up from the deleted file, stopping before the allowlist entry itself.
async function removeEmptyDirs(root: string, file: string, item: string): Promise<void> {
  if (file === item) return;
  for (let dir = path.dirname(file); dir !== item && dir !== "."; dir = path.dirname(dir)) {
    try {
      await fs.rmdir(path.join(root, dir));
    } catch (err) {
      if (isErrno(err, "ENOTEMPTY", "EEXIST")) return;
      throw err;
    }
  }
}
