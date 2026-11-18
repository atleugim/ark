# ark

Back up and restore AI agent configuration, extensible to other AI tools. Ark keeps what is needed to rebuild your AI agent setup: a backup you can restore on any machine.

## Usage

Requires Node 24+ and pnpm. Install it locally from a clone:

```sh
git clone https://github.com/atleugim/ark.git
cd ark
pnpm install
pnpm build
pnpm add -g .
```

This provides the `ark` command. If pnpm reports that the global bin directory is not in `PATH`, run `pnpm setup` once and restart your shell.

To run without installing, use `node dist/cli.js <command>` after `pnpm build`. The examples below use the installed `ark` command.

## Quick start

Create a private git repository (GitHub, GitLab, any host) and keep its URL at hand.

First machine:

```sh
ark init <url>
ark backup
```

Other machine:

```sh
ark init <url>
ark restore
```

`ark init` clones the repository into `~/.ark/repo` (`%USERPROFILE%\.ark\repo` in cmd, `$env:USERPROFILE\.ark\repo` in PowerShell on Windows) and saves that path in `~/.ark/config.json`. If the folder is already a git repository, it says so and does nothing. If the clone fails, git's error is printed.

### Commands

```sh
ark init <git-url>     # one-time: clone the private repo into ~/.ark/repo
ark backup             # local config -> ~/.ark/repo/claude, commit, push
ark backup --dry-run   # list changes without writing anything
ark restore            # git pull --ff-only, then ~/.ark/repo/claude -> local config
ark restore --dry-run  # list changes without writing anything
```

- `backup` copies the local config into `<repo>/<tool>`. It fails with a hint to run `ark init` if the repo folder does not exist.
- `restore` copies `<repo>/<tool>` into the local config. It fails if the repo or `<repo>/<tool>` does not exist (run `ark init`, and `ark backup` on the machine that has the config).
- `--tool <name>`: tool adapter to use (default `claude`).
- `--dir <path>`: use this folder instead of `~/.ark/repo` (mainly for tests).
- `--dry-run`: print what would change (`would new: <file>` / `would update: <file>`) without writing files.

The local Claude config directory is `~/.claude`, or `CLAUDE_CONFIG_DIR` if set.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Versioning with git

The repo folder is a git repository, so `backup` and `restore` use git.

- `restore` runs `git pull --ff-only` in the repo first, then copies. If the pull fails (diverged history, no remote, network), it stops with git's error and copies nothing.
- `backup` copies, then commits any changes as `sync(<tool>): <ISO 8601 UTC timestamp>`, and pushes with `git push --set-upstream origin HEAD` (plain `git push` once an upstream is set). Only allowlisted files under `<repo>/<tool>` are committed; other files in the folder are left alone. With no changes it does not commit, but it still pushes so an earlier failed push is retried. `backup` does not pull first: run `restore` before `backup` when another machine may have pushed.
- `--dry-run` runs no git writes. `backup` prints `would commit` if there would be changes; `restore` skips the git pull.
- Your existing git identity is used. The repo is trusted: git runs its hooks and config. Conflicts are never resolved automatically: if a pull or push fails, resolve it by hand with git in the repo, then run the command again.
- A plain folder at the repo path (no `.git`) still works for `backup` and `restore` without git.

## What is synced

Only this allowlist, relative to the Claude config directory:

- `settings.json`
- `CLAUDE.md`
- `agents/`
- `skills/`
- `commands/`
- `hooks/`
- `plugins/installed_plugins.json`, `plugins/known_marketplaces.json` and `plugins/cache/` (installed plugins; marketplace clones and catalog caches are not synced). The plugin manifests store absolute paths, so on `backup` the local Claude config dir is replaced with the placeholder `CLAUDE_HOME` in the repo copy, and on `restore` `CLAUDE_HOME` is expanded to the local config dir. A literal `CLAUDE_HOME` already present in a manifest is also expanded on restore. Manifests that are not valid JSON are copied unchanged

Only regular files are read. OS metadata files (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`, `.localized`, `ehthumbs.db`) are skipped inside synced folders. Symlinks are skipped, including allowlisted entries that are themselves symlinks (for example, a `settings.json` symlinked from a dotfiles repo is not backed up).

Never synced: credentials, `settings.local.json`, and machine-local state (projects, sessions, history, caches, todos, statsig, shell snapshots). Anything not in the allowlist is ignored.

Files are never deleted. Removing a file on one machine does not remove it on the other.

There is no conflict detection: the last backup wins. `backup` overwrites files in the repo without a backup; only `restore` backs up local files. Run with `--dry-run` first to review changes.

## Backups

Before `restore` overwrites an existing local file, the previous content is saved to `~/.ark/backups/<tool>/<timestamp>/<file>`.

## Safety notes

- `backup` refuses to write through symlinks in the repo folder (including the `<dir>/<tool>` folder itself). It stops with an error mid-run, so earlier files may already have been written.
- `restore` follows a symlinked local file and writes to its target, so symlinked dotfiles stay linked.
- Writes go to a temporary file followed by a rename.

## Adding a tool

Implement the `ToolAdapter` interface from `src/adapters/types.ts`:

- `name`: tool name, used for `--tool` and as the subfolder in the repo folder.
- `resolveHome(env, homedir)`: the tool's config root on the current machine.
- `allowlist`: files or directories, relative to that root, that are safe to sync.
- `transform?(direction, file, data, home)`: optional content rewrite applied while copying (`direction` is `"backup"` or `"restore"`, `file` is relative to the root, `home` is the local root). Used by the Claude adapter to portabilize the plugin manifests.

Then register the adapter in `src/adapters/index.ts`. See `src/adapters/claude.ts` for an example.

## License

MIT. See [LICENSE](LICENSE).
