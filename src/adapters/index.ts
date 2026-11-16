import { claude } from "./claude.ts";
import type { ToolAdapter } from "./types.ts";

export const adapters: Record<string, ToolAdapter> = {
  [claude.name]: claude,
};
