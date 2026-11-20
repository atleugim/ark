import path from "node:path";
import type { ToolAdapter } from "./types.ts";

export const copilot: ToolAdapter = {
  name: "copilot",
  resolveHome: (env, homedir) => env.COPILOT_HOME ? path.resolve(env.COPILOT_HOME) : path.join(homedir, ".copilot"),
  // Explicit allowlist keeps config, session state, logs, and lock files out of the repo.
  allowlist: ["settings.json", "agents", "skills", "installed-plugins", "installed-plugins.lock"],
  blocked: [
    "config.json",
    "plugin-data",
    "session-state",
    "session-store.db",
    "session-store.db-shm",
    "session-store.db-wal",
    "logs",
    "ide",
    "command-history-state.json",
    "open-sessions-state.json",
    "sidebar-sessions-state",
    "servers",
    "config.json.trusted-folders.lock",
    "settings.json.lock",
  ],
};
