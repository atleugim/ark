import fs from "node:fs/promises";
import path from "node:path";
import { isErrno, type Change } from "./sync.ts";

export interface SkillLink {
  link: string;
  target: string;
}

export const LINKS_FILE = "links.json";

// `dir` is relative to the tool home; `tool` is the adapter name and doubles as the manifest key.
export interface SkillLinkTarget {
  tool: string;
  home: string;
  dir: string;
}

// Names end up as path segments on restore, so anything that could escape the skills folder is rejected.
export function isValidLinkName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && path.basename(name) === name;
}

const realpathIfExists = (item: string) =>
  fs.realpath(item).catch((err: unknown) => {
    if (isErrno(err, "ENOENT", "ENOTDIR", "ELOOP")) return undefined;
    throw err;
  });

// Only symlinks that point straight at a skill folder in the agents home are portable; anything else stays ignored.
export async function scanSkillLinks(target: SkillLinkTarget, agentsHome: string): Promise<SkillLink[]> {
  const toolSkills = path.join(target.home, target.dir);
  // Both sides go through realpath so a symlinked home (macOS /var -> /private/var) still compares equal.
  const agentsSkills = await realpathIfExists(path.join(agentsHome, "skills"));
  if (!agentsSkills) return [];
  let names: string[];
  try {
    names = await fs.readdir(toolSkills);
  } catch (err) {
    if (isErrno(err, "ENOENT", "ENOTDIR")) return [];
    throw err;
  }
  const links: SkillLink[] = [];
  for (const name of names) {
    if (!isValidLinkName(name)) continue;
    const entry = path.join(toolSkills, name);
    if (!(await fs.lstat(entry)).isSymbolicLink()) continue;
    const resolved = await realpathIfExists(entry);
    if (!resolved || path.dirname(resolved) !== agentsSkills) continue;
    if (!(await fs.stat(resolved)).isDirectory()) continue;
    const targetName = path.basename(resolved);
    if (isValidLinkName(targetName)) links.push({ link: name, target: targetName });
  }
  return links.sort((a, b) => (a.link < b.link ? -1 : a.link > b.link ? 1 : 0));
}

// The manifest is shared by every tool, so the top level must be a plain object whose other keys are left alone.
function parseManifest(file: string, raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${file}: expected an object keyed by tool name`);
  }
  return parsed as Record<string, unknown>;
}

// Rewrites only this tool's key; returns undefined when nothing needs to change.
export async function writeLinksManifest(syncDir: string, tool: string, links: SkillLink[], dryRun: boolean): Promise<Change | undefined> {
  const file = path.join(syncDir, LINKS_FILE);
  let current: string | undefined;
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Refusing to write "${file}": it is a symlink`);
    current = await fs.readFile(file, "utf8");
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
  }
  if (current === undefined && links.length === 0) return undefined;
  // A malformed file is never overwritten: that would silently drop the other tools' links.
  const existing = current === undefined ? {} : parseManifest(file, current);
  const next = JSON.stringify({ ...existing, [tool]: links }, null, 2) + "\n";
  if (next === current) return undefined;
  if (!dryRun) {
    // Temp file + rename so a crash can't leave a half-written manifest.
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      await fs.writeFile(tmp, next);
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
  return { file: LINKS_FILE, kind: current === undefined ? "new" : "update" };
}

const isDir = (item: string) => fs.stat(item).then((stat) => stat.isDirectory(), (err: unknown) => {
  if (isErrno(err, "ENOENT", "ENOTDIR", "ELOOP")) return false;
  throw err;
});

async function readLinksManifest(syncDir: string, tool: string): Promise<SkillLink[]> {
  const file = path.join(syncDir, LINKS_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return [];
    throw err;
  }
  const manifest = parseManifest(file, raw);
  // Another tool may be the only one with an entry, which just means this tool has nothing to restore.
  if (!Object.hasOwn(manifest, tool)) return [];
  const entries = manifest[tool];
  if (!Array.isArray(entries)) throw new Error(`Invalid ${file}: expected {"${tool}": [{"link": ..., "target": ...}]}`);
  const links: SkillLink[] = [];
  for (const entry of entries as unknown[]) {
    const { link, target } = (entry ?? {}) as Partial<Record<keyof SkillLink, unknown>>;
    if (typeof link === "string" && typeof target === "string" && isValidLinkName(link) && isValidLinkName(target)) {
      links.push({ link, target });
    } else {
      console.warn(`Skipping invalid entry in ${file}: ${JSON.stringify(entry)}`);
    }
  }
  return links;
}

// Recreates missing skill symlinks from the manifest. Never replaces or removes anything that already exists.
export async function restoreSkillLinks(syncDir: string, target: SkillLinkTarget, agentsHome: string, dryRun: boolean): Promise<Change[]> {
  const links = await readLinksManifest(syncDir, target.tool);
  if (links.length === 0) return [];
  const toolSkills = path.join(target.home, target.dir);
  const agentsSkills = path.join(agentsHome, "skills");
  // Writing through a symlinked skills folder could land outside it, so such a folder is left alone.
  const skillsStat = await fs.lstat(toolSkills).catch((err: unknown) => {
    if (isErrno(err, "ENOENT")) return undefined;
    throw err;
  });
  if (skillsStat && !skillsStat.isDirectory()) {
    console.warn(`Skipping skill links: ${toolSkills} is not a regular directory`);
    return [];
  }
  const changes: Change[] = [];
  for (const { link, target: skill } of links) {
    const linkPath = path.join(toolSkills, link);
    const targetPath = path.join(agentsSkills, skill);
    // A dry run has not restored ~/.agents yet, so the repo copy counts as present too.
    if (!(await isDir(targetPath)) && !(dryRun && (await isDir(path.join(syncDir, "agents", "skills", skill))))) {
      console.warn(`Skipping skill link "${link}": ${targetPath} does not exist`);
      continue;
    }
    const exists = await fs.lstat(linkPath).then(() => true, (err: unknown) => {
      if (isErrno(err, "ENOENT")) return false;
      throw err;
    });
    if (exists) {
      // Absolute and relative links to the same skill are both fine, so compare where they end up.
      const [current, wanted] = await Promise.all([realpathIfExists(linkPath), realpathIfExists(targetPath)]);
      if (current === undefined || current !== wanted) console.warn(`Skipping skill link "${link}": ${linkPath} already exists`);
      continue;
    }
    if (!dryRun) {
      try {
        await fs.mkdir(toolSkills, { recursive: true });
        // The OS resolves a relative link from the link's real folder, so build it from realpaths on both sides.
        const realSkills = (await realpathIfExists(toolSkills)) ?? toolSkills;
        const realTarget = path.join((await realpathIfExists(agentsSkills)) ?? agentsSkills, skill);
        await fs.symlink(path.relative(realSkills, realTarget), linkPath, "dir");
      } catch (err) {
        if (!isErrno(err, "EPERM", "EACCES")) throw err;
        console.warn(`Skipping skill link "${link}": not allowed to create symlinks (${(err as Error).message})`);
        continue;
      }
    }
    changes.push({ file: path.join(target.dir, link), kind: "link" });
  }
  return changes;
}
