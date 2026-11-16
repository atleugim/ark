import path from "node:path";
import type { ToolAdapter } from "./types.ts";

export const claude: ToolAdapter = {
  name: "claude",
  // os.homedir() resolves to %USERPROFILE% on Windows.
  resolveHome: (env, homedir) => env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(homedir, ".claude"),
  // Explicit allowlist: credentials, settings.local.json and machine state
  // (projects, sessions, history, caches, todos, statsig, shell snapshots) stay out.
  allowlist: ["settings.json", "CLAUDE.md", "agents", "skills", "commands", "hooks"],
};
