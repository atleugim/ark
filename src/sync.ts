import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface Change {
  file: string;
  kind: "new" | "update" | "delete" | "link";
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

// Top-level entry names of a directory (OS junk skipped); a missing directory has none.
export async function listTopLevel(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(root)).filter((name) => !isOsJunk(name));
  } catch (err) {
    if (isErrno(err, "ENOENT", "ENOTDIR")) return [];
    throw err;
  }
}

// Turns a user-given path into a canonical one relative to the tool root, or throws.
export function normalizeUserPath(input: string): string {
  const slashed = input.replaceAll("\\", "/");
  if (path.posix.isAbsolute(slashed) || path.win32.isAbsolute(input)) throw new Error(`Invalid path "${input}": must be relative to the tool folder`);
  const parts = slashed.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw new Error(`Invalid path "${input}": must not contain ".."`);
  if (parts.length === 0) throw new Error(`Invalid path "${input}": must name a file or folder inside the tool folder`);
  return parts.join(path.sep);
}

// Same folding as prune, so an excluded path also covers case-only variants.
const isExcluded = (file: string, exclude: readonly string[]) => {
  const key = pathKey(file);
  return exclude.some((item) => {
    const excluded = pathKey(item);
    return key === excluded || key.startsWith(excluded + path.sep);
  });
};

export async function listFiles(root: string, allowlist: readonly string[], exclude: readonly string[] = []): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of allowlist) {
    const item = path.normalize(entry);
    const stat = await statEntry(root, item);
    if (!stat) continue;
    const files: string[] = [];
    if (stat.isFile()) files.push(item);
    else if (stat.isDirectory()) await walk(root, item, files);
    // Overlapping entries list the same file more than once; adapter entries come first, so their casing wins.
    // Only cross-entry overlap is folded, so case-distinct files on a case-sensitive FS both survive
    // (tradeoff: an include differing from an adapter entry only by case is folded there too).
    const fresh = files.filter((file) => !seen.has(pathKey(file)));
    for (const file of files) seen.add(pathKey(file));
    out.push(...fresh);
  }
  return out.filter((file) => !isExcluded(file, exclude)).sort();
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

const listSource = async (
  from: string,
  entries: readonly string[],
  opts: { exclude?: readonly string[]; filter?: (file: string) => boolean },
) => (await listFiles(from, entries, opts.exclude)).filter(opts.filter ?? (() => true));

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
    // Paths (from normalizeUserPath) that are neither copied nor pruned.
    exclude?: readonly string[];
    // Restore copies everything in the repo but only prunes what backup would upload, so local files backup never syncs are left alone.
    pruneEntries?: readonly string[];
    // Source files failing this are treated as absent: not copied, and pruned from the destination.
    filter?: (file: string) => boolean;
    // Also delete the destination copy of an entry that is missing entirely from the source.
    pruneMissing?: boolean;
  },
): Promise<Change[]> {
  const changes: Change[] = [];
  for (const file of await listSource(from, allowlist, opts)) {
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
  await prune(from, to, opts.pruneEntries ?? allowlist, opts, changes);
  return changes;
}

// Case/normalization-insensitive so a case-only rename on APFS/NTFS never deletes the live file.
export const pathKey = (file: string) => file.normalize("NFC").toLowerCase();

// First spelling wins, so adapter entries keep their own casing.
export function uniqueByKey(entries: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const key = pathKey(entry);
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

// Stricter than pathKey: APFS/NTFS fold full Unicode case ("\u017Fettings" is "settings") and NTFS
// also resolves "projects." and "projects " to "projects".
export const isBlocked = (name: string, blocked: readonly string[]) => {
  const key = (file: string) => file.normalize("NFKC").toUpperCase().toLowerCase().replace(/[. ]+$/, "");
  return blocked.some((item) => key(item) === key(name));
};

// Removes destination files that no longer exist in the source, only inside entries the source still has.
async function prune(
  from: string,
  to: string,
  allowlist: readonly string[],
  opts: { dryRun: boolean; backupDir?: string; guardDest?: boolean; exclude?: readonly string[]; filter?: (file: string) => boolean; pruneMissing?: boolean },
  changes: Change[],
): Promise<void> {
  for (const entry of allowlist) {
    const item = path.normalize(entry);
    const stat = await statEntry(from, item);
    // A missing or symlinked source entry says nothing about what should exist, unless pruneMissing opts in for the missing case.
    const missing = stat === undefined && opts.pruneMissing;
    if (!missing && !stat?.isFile() && !stat?.isDirectory()) continue;
    const kept = new Set(missing ? [] : (await listSource(from, [item], opts)).map(pathKey));
    for (const file of await listFiles(to, [item], opts.exclude)) {
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
