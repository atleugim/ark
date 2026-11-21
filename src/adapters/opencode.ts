import path from "node:path";
import type { ToolAdapter } from "./types.ts";

export const opencode: ToolAdapter = {
  name: "opencode",
  resolveHome: (env, homedir) =>
    env.XDG_CONFIG_HOME ? path.join(path.resolve(env.XDG_CONFIG_HOME), "opencode") : path.join(homedir, ".config", "opencode"),
  // Explicit allowlist keeps service state, installed dependencies, and lock files out of the repo.
  allowlist: ["opencode.json", "opencode.jsonc", "cli.json", "AGENTS.md", "agents", "commands", "skills", "plugins"],
  blocked: ["service.json", "node_modules", "package.json", "bun.lock", "package-lock.json", "pnpm-lock.yaml"],
  skillLinks: { dir: "skills" },
};
