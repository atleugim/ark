export interface ToolAdapter {
  name: string;
  // Config root for this tool on the current machine.
  resolveHome(env: NodeJS.ProcessEnv, homedir: string): string;
  // Files or directories (relative to the home dir) that are safe to sync.
  allowlist: readonly string[];
  // Top-level names that are never restored, even when present in the repo.
  blocked: readonly string[];
  // Optional content rewrite applied while copying; `file` is relative to the home dir, `home` is the local root.
  transform?(direction: "backup" | "restore", file: string, data: Buffer, home: string): Buffer;
  // Optional filter over files (relative to the home dir): true for files active according to the manifest under `home`; undefined means no filtering.
  activeFilter?(home: string): Promise<((file: string) => boolean) | undefined>;
}
