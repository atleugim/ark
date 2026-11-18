import path from "node:path";
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

export const claude: ToolAdapter = {
  name: "claude",
  // os.homedir() resolves to %USERPROFILE% on Windows.
  resolveHome: (env, homedir) => env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(homedir, ".claude"),
  // Explicit allowlist: credentials, settings.local.json and machine state
  // (projects, sessions, history, caches, todos, statsig, shell snapshots) stay out.
  // Plugins: manifests plus installed copies; marketplace clones and catalog caches are re-fetchable.
  allowlist: ["settings.json", "CLAUDE.md", "agents", "skills", "commands", "hooks", "plugins/installed_plugins.json", "plugins/known_marketplaces.json", "plugins/cache"],
  transform: (direction, file, data, home) => {
    if (!manifests.has(file.split(path.sep).join("/"))) return data;
    const text = data.toString("utf8");
    if (!isJson(text)) return data;
    const root = JSON.stringify(home).slice(1, -1);
    const out = direction === "backup" ? swapRoot(text, root, PLACEHOLDER) : swapRoot(text, PLACEHOLDER, root);
    return Buffer.from(out);
  },
};
