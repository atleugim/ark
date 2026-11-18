import fs from "node:fs/promises";
import path from "node:path";
import { isErrno, uniqueByKey } from "./sync.ts";

export function configPath(homedir: string): string {
  return path.join(homedir, ".ark", "config.json");
}

export function defaultRepoDir(homedir: string): string {
  return path.join(homedir, ".ark", "repo");
}

async function readSavedRepo(file: string): Promise<string | undefined> {
  try {
    const data: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (typeof data === "object" && data !== null && "repo" in data && typeof data.repo === "string") {
      return data.repo;
    }
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
  }
  return undefined;
}

// Precedence: --dir flag, saved config, ~/.ark/repo.
export async function resolveRepoDir(opts: { flag?: string; homedir: string }): Promise<string> {
  if (opts.flag) return path.resolve(opts.flag);
  return (await readSavedRepo(configPath(opts.homedir))) ?? defaultRepoDir(opts.homedir);
}

// Whole config object, so writers keep keys they do not own; a missing file is an empty config.
async function readConfig(homedir: string): Promise<Record<string, unknown>> {
  try {
    const data: unknown = JSON.parse(await fs.readFile(configPath(homedir), "utf8"));
    return typeof data === "object" && data !== null && !Array.isArray(data) ? { ...data } : {};
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    return {};
  }
}

async function writeConfig(homedir: string, config: Record<string, unknown>): Promise<void> {
  const file = configPath(homedir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Temp file + rename so a crash can't leave half-written JSON that breaks every command.
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n");
  await fs.rename(tmp, file);
}

function includesOf(config: Record<string, unknown>, tool: string): string[] {
  const { include } = config;
  if (typeof include !== "object" || include === null || !Object.hasOwn(include, tool)) return [];
  const list: unknown = Object.getOwnPropertyDescriptor(include, tool)?.value;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
}

// Malformed values are skipped rather than failing every backup.
export async function readIncludes(homedir: string, tool: string): Promise<string[]> {
  return includesOf(await readConfig(homedir), tool);
}

export async function addIncludes(homedir: string, tool: string, added: readonly string[]): Promise<void> {
  const config = await readConfig(homedir);
  const { include } = config;
  const others = typeof include === "object" && include !== null && !Array.isArray(include) ? include : {};
  config.include = { ...others, [tool]: uniqueByKey([...includesOf(config, tool), ...added]) };
  await writeConfig(homedir, config);
}

export async function saveRepoDir(homedir: string, repo: string): Promise<void> {
  await writeConfig(homedir, { ...(await readConfig(homedir)), repo });
}
