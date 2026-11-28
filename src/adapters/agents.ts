import path from "node:path";
import type { ToolAdapter } from "./types.ts";

export const agents: ToolAdapter = {
  name: "agents",
  resolveHome: (_env, homedir) => path.join(homedir, ".agents"),
  allowlist: ["skills", "docs", ".skill-lock.json"],
  blocked: [],
};
