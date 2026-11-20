import fs from "node:fs/promises";
import path from "node:path";
import { isErrno, type Change } from "./sync.ts";

export interface SkillLink {
  link: string;
  target: string;
}

export const LINKS_FILE = "links.json";

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
export async function scanSkillLinks(claudeHome: string, agentsHome: string): Promise<SkillLink[]> {
  const claudeSkills = path.join(claudeHome, "skills");
  // Both sides go through realpath so a symlinked home (macOS /var -> /private/var) still compares equal.
  const agentsSkills = await realpathIfExists(path.join(agentsHome, "skills"));
  if (!agentsSkills) return [];
  let names: string[];
  try {
    names = await fs.readdir(claudeSkills);
  } catch (err) {
    if (isErrno(err, "ENOENT", "ENOTDIR")) return [];
    throw err;
  }
  const links: SkillLink[] = [];
  for (const name of names) {
    if (!isValidLinkName(name)) continue;
    const entry = path.join(claudeSkills, name);
    if (!(await fs.lstat(entry)).isSymbolicLink()) continue;
    const resolved = await realpathIfExists(entry);
    if (!resolved || path.dirname(resolved) !== agentsSkills) continue;
    if (!(await fs.stat(resolved)).isDirectory()) continue;
    const target = path.basename(resolved);
    if (isValidLinkName(target)) links.push({ link: name, target });
  }
  return links.sort((a, b) => (a.link < b.link ? -1 : a.link > b.link ? 1 : 0));
}

// Regenerates the manifest from scratch; returns undefined when nothing needs to change.
export async function writeLinksManifest(syncDir: string, links: SkillLink[], dryRun: boolean): Promise<Change | undefined> {
  const file = path.join(syncDir, LINKS_FILE);
  let current: string | undefined;
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Refusing to write "${file}": it is a symlink`);
    current = await fs.readFile(file, "utf8");
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
  }
  if (current === undefined && links.length === 0) return undefined;
  const next = JSON.stringify({ claude: links }, null, 2) + "\n";
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

async function readLinksManifest(syncDir: string): Promise<SkillLink[]> {
  const file = path.join(syncDir, LINKS_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return [];
    throw err;
  }
  let claude: unknown;
  try {
    claude = (JSON.parse(raw) as { claude?: unknown } | null)?.claude;
  } catch (err) {
    throw new Error(`Invalid ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(claude)) throw new Error(`Invalid ${file}: expected {"claude": [{"link": ..., "target": ...}]}`);
  const links: SkillLink[] = [];
  for (const entry of claude as unknown[]) {
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
export async function restoreSkillLinks(syncDir: string, claudeHome: string, agentsHome: string, dryRun: boolean): Promise<Change[]> {
  const links = await readLinksManifest(syncDir);
  if (links.length === 0) return [];
  const claudeSkills = path.join(claudeHome, "skills");
  const agentsSkills = path.join(agentsHome, "skills");
  // Writing through a symlinked skills folder could land outside it, so such a folder is left alone.
  const skillsStat = await fs.lstat(claudeSkills).catch((err: unknown) => {
    if (isErrno(err, "ENOENT")) return undefined;
    throw err;
  });
  if (skillsStat && !skillsStat.isDirectory()) {
    console.warn(`Skipping skill links: ${claudeSkills} is not a regular directory`);
    return [];
  }
  const changes: Change[] = [];
  for (const { link, target } of links) {
    const linkPath = path.join(claudeSkills, link);
    const targetPath = path.join(agentsSkills, target);
    // A dry run has not restored ~/.agents yet, so the repo copy counts as present too.
    if (!(await isDir(targetPath)) && !(dryRun && (await isDir(path.join(syncDir, "agents", "skills", target))))) {
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
        await fs.mkdir(claudeSkills, { recursive: true });
        // The OS resolves a relative link from the link's real folder, so build it from realpaths on both sides.
        const realSkills = (await realpathIfExists(claudeSkills)) ?? claudeSkills;
        const realTarget = path.join((await realpathIfExists(agentsSkills)) ?? agentsSkills, target);
        await fs.symlink(path.relative(realSkills, realTarget), linkPath, "dir");
      } catch (err) {
        if (!isErrno(err, "EPERM", "EACCES")) throw err;
        console.warn(`Skipping skill link "${link}": not allowed to create symlinks (${(err as Error).message})`);
        continue;
      }
    }
    changes.push({ file: path.join("skills", link), kind: "link" });
  }
  return changes;
}
