import { agents } from "./agents.ts";
import { claude } from "./claude.ts";
import { copilot } from "./copilot.ts";
import type { ToolAdapter } from "./types.ts";

export const adapters: Record<string, ToolAdapter> = {
  [claude.name]: claude,
  [copilot.name]: copilot,
};

export const globalAdapters: readonly ToolAdapter[] = [agents];
