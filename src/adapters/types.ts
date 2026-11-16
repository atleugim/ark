export interface ToolAdapter {
  name: string;
  // Config root for this tool on the current machine.
  resolveHome(env: NodeJS.ProcessEnv, homedir: string): string;
  // Files or directories (relative to the home dir) that are safe to sync.
  allowlist: readonly string[];
}
