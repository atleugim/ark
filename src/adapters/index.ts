import { agents } from "./agents.ts";
import { claude } from "./claude.ts";
import { copilot } from "./copilot.ts";
import { opencode } from "./opencode.ts";
import { pi } from "./pi.ts";
import type { ToolAdapter } from "./types.ts";

export const adapters: Record<string, ToolAdapter> = {
  [claude.name]: claude,
  [copilot.name]: copilot,
  [opencode.name]: opencode,
  [pi.name]: pi,
};

export const globalAdapters: readonly ToolAdapter[] = [agents];
