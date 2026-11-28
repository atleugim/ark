import path from "node:path";
import type { ToolAdapter } from "./types.ts";

export const pi: ToolAdapter = {
  name: "pi",
  resolveHome: (env, homedir) =>
    env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : path.join(homedir, ".pi", "agent"),
  // Explicit allowlist keeps credentials, sessions, and installed runtime state out of the repo.
  allowlist: ["AGENTS.md", "settings.json", "agents", "extensions", "prompts", "skills"],
  blocked: ["auth.json", "models-store.json", "sessions", "install", "bin", "mcp-auth.json", "trust.json", "mcp.log", "mcp.log.1", "tmp"],
  skillLinks: { dir: "skills" },
};
