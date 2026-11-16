import fs from "node:fs/promises";
import path from "node:path";
import { isErrno } from "./sync.ts";

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

export async function saveRepoDir(homedir: string, repo: string): Promise<void> {
  const file = configPath(homedir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ repo }, null, 2) + "\n");
}
