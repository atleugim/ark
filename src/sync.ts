import fs from "node:fs/promises";
import path from "node:path";

export interface Change {
  file: string;
  kind: "new" | "update";
}

export function isErrno(err: unknown, ...codes: string[]): boolean {
  return err instanceof Error && "code" in err && typeof err.code === "string" && codes.includes(err.code);
}

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
    else if (entry.isFile()) out.push(child);
  }
}

export async function listFiles(root: string, allowlist: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of allowlist) {
    const item = path.normalize(entry);
    // Every segment is checked, so a symlinked parent of a nested entry is skipped too.
    const parts = item.split(path.sep);
    let stat;
    try {
      for (let i = 1; i <= parts.length; i++) {
        stat = await fs.lstat(path.join(root, ...parts.slice(0, i)));
        if (stat.isSymbolicLink()) break;
      }
    } catch (err) {
      if (isErrno(err, "ENOENT", "ENOTDIR")) continue;
      throw err;
    }
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
  },
): Promise<Change[]> {
  const changes: Change[] = [];
  for (const file of await listFiles(from, allowlist)) {
    let dest = path.join(to, file);
    if (opts.guardDest) await assertNoSymlink(to, file);
    const [srcData, destData] = await Promise.all([fs.readFile(path.join(from, file)), readIfExists(dest)]);
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
  return changes;
}
