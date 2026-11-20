import fs from "node:fs/promises";
import path from "node:path";
import { pathKey } from "../sync.ts";
import type { ToolAdapter } from "./types.ts";

const PLACEHOLDER = "CLAUDE_HOME";
const manifests = new Set(["plugins/installed_plugins.json", "plugins/known_marketplaces.json"]);

const isJson = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

// Works on the JSON-escaped root so Windows backslashes match and restored files stay valid JSON.
// Only matches at a path boundary, so "<root>-other" is untouched. A literal CLAUDE_HOME already
// in a manifest is expanded on restore (accepted edge case).
const swapRoot = (text: string, from: string, to: string) =>
  text.replace(new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/\\\\"])`, "g"), () => to);

const collectInstallPaths = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) collectInstallPaths(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "installPath" && typeof item === "string") out.push(item);
      else collectInstallPaths(item, out);
    }
  }
  return out;
};

const splitPath = (file: string) => file.split(/[\\/]+/).filter(Boolean);

// Claude keeps every version it ever installed under plugins/cache; only the ones installPath points to are live.
// Format-agnostic on purpose: v1 and v2 manifests differ in shape but both use "installPath".
const readActiveVersions = async (root: string) => {
  let installPaths: string[];
  try {
    installPaths = collectInstallPaths(JSON.parse(await fs.readFile(path.join(root, "plugins", "installed_plugins.json"), "utf8")));
  } catch {
    return new Map<string, Set<string>>();
  }
  const rootParts = splitPath(root).map(pathKey);
  const active = new Map<string, Set<string>>();
  for (const installPath of installPaths) {
    const parts = splitPath(installPath);
    const isPlaceholder = parts[0] === PLACEHOLDER;
    const isLocal = rootParts.every((part, i) => pathKey(parts[i] ?? "") === part);
    if (!isPlaceholder && !isLocal) continue;
    const [plugins, cache, marketplace, plugin, version, ...rest] = parts.slice(isPlaceholder ? 1 : rootParts.length);
    if (rest.length || !version || pathKey(`${plugins}/${cache}`) !== "plugins/cache") continue;
    const key = pathKey(`${marketplace}/${plugin}`);
    active.set(key, (active.get(key) ?? new Set()).add(pathKey(version)));
  }
  return active;
};

export const claude: ToolAdapter = {
  name: "claude",
  skillLinks: { dir: "skills" },
  // os.homedir() resolves to %USERPROFILE% on Windows.
  resolveHome: (env, homedir) => env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(homedir, ".claude"),
  // Explicit allowlist: credentials, settings.local.json and machine state
  // (projects, sessions, history, caches, todos, statsig, shell snapshots) stay out.
  // Plugins: manifests plus installed copies; marketplace clones and catalog caches are re-fetchable.
  blocked: [".credentials.json", "settings.local.json", "projects", "sessions", "history.jsonl", "todos", "statsig", "shell-snapshots", "ide", "file-history", "debug", "session-env", "telemetry"],
  allowlist: ["settings.json", "CLAUDE.md", "agents", "skills", "commands", "hooks", "plugins/installed_plugins.json", "plugins/known_marketplaces.json", "plugins/cache"],
  transform: (direction, file, data, home) => {
    if (!manifests.has(file.split(path.sep).join("/"))) return data;
    const text = data.toString("utf8");
    if (!isJson(text)) return data;
    const root = JSON.stringify(home).slice(1, -1);
    const out = direction === "backup" ? swapRoot(text, root, PLACEHOLDER) : swapRoot(text, PLACEHOLDER, root);
    return Buffer.from(out);
  },
  activeFilter: async (root) => {
    const active = await readActiveVersions(root);
    if (!active.size) return undefined;
    return (file) => {
      const [plugins, cache, marketplace, plugin, version, entry] = splitPath(file);
      // Without an entry the path is a file sitting directly under the plugin dir, not inside a version.
      if (!entry || pathKey(`${plugins}/${cache}`) !== "plugins/cache") return true;
      const versions = active.get(pathKey(`${marketplace}/${plugin}`));
      return !versions || versions.has(pathKey(version));
    };
  },
};
