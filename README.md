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

`ark init` clones the repository into `~/.ark/repo` (`%USERPROFILE%\.ark\repo` in cmd, `$env:USERPROFILE\.ark\repo` in PowerShell on Windows) and saves that path in `~/.ark/config.json`. Includes saved by `backup --include` (see below) live in the same file and are kept when you run `ark init` again. If the folder is already a git repository, it says so and does nothing. If the clone fails, git's error is printed.

### Commands

```sh
ark init <git-url>     # one-time: clone the private repo into ~/.ark/repo
ark backup             # local config -> ~/.ark/repo/claude, commit, push
ark backup --dry-run   # list changes without writing anything
ark restore            # git pull --ff-only, then ~/.ark/repo/claude -> local config (also deletes, see Deletions)
ark restore --dry-run  # list changes without writing anything
ark backup --include output-styles --include notes  # also back up these paths, and remember them
ark backup --exclude skills/scratch                 # skip this path for this run only
ark restore --exclude plugins/marketplaces          # skip this path for this run only
```

- `backup` copies the local config into `<repo>/<tool>`. It fails with a hint to run `ark init` if the repo folder does not exist.
- `restore` copies `<repo>/<tool>` into the local config and deletes local files inside synced folders that are absent from the repo (see Deletions). It fails if the repo or `<repo>/<tool>` does not exist (run `ark init`, and `ark backup` on the machine that has the config).
- `--tool <name>`: tool adapter to use (default `claude`).
- `--dir <path>`: use this folder instead of `~/.ark/repo` (mainly for tests).
- `--include <path>`: `backup` only; add a file or folder to the backup and save it in `~/.ark/config.json` for later runs. Repeat it for several paths. `restore --include` is rejected. The path does not need to exist locally. Nothing is saved with `--dry-run`.
- `--exclude <path>`: `backup` and `restore`; skip a file or folder for this run only (never saved). Repeat it for several paths.
- `--dry-run`: print what would change (`would new: <file>` / `would update: <file>` / `would delete: <file>`) without writing files.

The local Claude config directory is `~/.claude`, or `CLAUDE_CONFIG_DIR` if set.

Paths for `--include` and `--exclude` are relative to that directory. Absolute paths, paths containing `..` and empty paths are rejected. An `--include` of a never-synced name (see "What is synced") is an error; only the top-level segment is checked, and `--exclude` is not checked against that list.

Saved includes are stored per tool in `~/.ark/config.json`:

```json
{ "repo": "/home/you/.ark/repo", "include": { "claude": ["output-styles", "notes"] } }
```

There is no flag to remove a saved include; edit `~/.ark/config.json` by hand. If a saved include is invalid or blocked (for example `projects`), every `backup` fails with a `config include` error until you fix the file.

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
- `backup` copies, then commits any changes as `sync(<tool>): <ISO 8601 UTC timestamp>`, and pushes with `git push --set-upstream origin HEAD` (plain `git push` once an upstream is set). Only the allowlist and your includes under `<repo>/<tool>` are committed (including removals of files that `backup` deleted); other files in the folder are left alone. With no changes it does not commit, but it still pushes so an earlier failed push is retried. `backup` does not pull first: run `restore` before `backup` when another machine may have pushed.
- `--dry-run` runs no git writes. `backup` prints `would commit` if there would be changes; `restore` skips the git pull.
- Your existing git identity is used. The repo is trusted: git runs its hooks and config. Conflicts are never resolved automatically: if a pull or push fails, resolve it by hand with git in the repo, then run the command again.
- A plain folder at the repo path (no `.git`) still works for `backup` and `restore` without git.

## What is synced

`backup` syncs this allowlist plus any includes (saved ones and those passed with `--include` in this run), minus any `--exclude`. Paths are relative to the Claude config directory:

- `settings.json`
- `CLAUDE.md`
- `agents/`
- `skills/`
- `commands/`
- `hooks/`
- `plugins/installed_plugins.json`, `plugins/known_marketplaces.json` and `plugins/cache/` (installed plugins; `backup` does not sync marketplace clones or catalog caches, but see the `restore` note below). The plugin manifests store absolute paths, so on `backup` the local Claude config dir is replaced with the placeholder `CLAUDE_HOME` in the repo copy, and on `restore` `CLAUDE_HOME` is expanded to the local config dir. A literal `CLAUDE_HOME` already present in a manifest is also expanded on restore. Manifests that are not valid JSON are copied unchanged

`restore` takes every top-level entry present in `<repo>/<tool>` (not just the allowlist), except the never-synced names below. This includes entries that another machine added with `--include`. On a new machine, run `ark backup --include <path>` once so those includes are also saved locally and backed up from there. On `restore`, a synced entry is the whole top-level folder or file present in the repo (for example all of `plugins/`, not just the three paths above). Behavior change: older versions of `restore` only copied, and only the allowlist; it now also prunes (see "Deletions" below). Run `ark restore --dry-run` first.

Only regular files are read. OS metadata files (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`, `.localized`, `ehthumbs.db`) are skipped inside synced folders. Symlinks are skipped, including allowlisted entries that are themselves symlinks (for example, a `settings.json` symlinked from a dotfiles repo is not backed up).

Never synced, not even with `--include`, and skipped by `restore` even if present in the repo: `.credentials.json`, `settings.local.json`, `projects`, `sessions`, `history.jsonl`, `todos`, `statsig`, `shell-snapshots`, `ide`, `file-history`, `debug`, `session-env`, `telemetry`. Names are matched case-insensitively, with NFKC normalization, and trailing dots and spaces are ignored (`projects.` and `projects ` count as `projects`). On `backup`, anything that is not in the allowlist or an include is ignored.

Deletions propagate inside the synced entries (the allowlist and includes are pruned alike): a file that is gone from the source is removed from the destination (`delete: <file>`), and subfolders left empty are removed (the synced folder itself is kept). `backup` deletes files from the repo copy; `restore` deletes any local file inside a top-level folder that is present in the repo but absent from the repo copy, so a local file you never backed up is removed by `restore`. This applies to the whole top-level folder: if the repo has `plugins/installed_plugins.json`, local marketplace clones and any other file under `plugins/` that is not in the repo are deleted, even though `backup` never syncs them. Each deleted local file is first copied to `~/.ark/backups/<tool>/<timestamp>/`. The same applies to nested includes: after `ark backup --include notes/a.md`, the repo has `notes/a.md`, so `restore` treats all of `notes/` as synced and deletes other local files under `notes/` (saving them first). Use `--exclude notes/other.md` to protect specific files. A top-level entry that is missing entirely in the repo is not pruned, so local files under it are never touched. On `backup`, an entry missing entirely locally is not pruned from the repo; remove it with git. A path given with `--exclude` is neither copied nor pruned, even inside a larger entry or an allowlisted folder. Paths that differ only by case are treated as the same file (also when entries overlap), so a case-only rename never deletes the live file.

Known limitations of pruning:

- If the commit fails after `backup` deleted a repo file, the next `backup` does not see that file as a change, so the removal is not committed automatically. Remove it with git in the repo.
- On a case-sensitive filesystem, a stale duplicate that differs from a live file only by case is not pruned.
- A folder that holds only OS metadata files (skipped, see above) is not removed.

There is no conflict detection: the last backup wins. `backup` overwrites and deletes files in the repo without a backup (in a git-backed repo, git history is the recovery); only `restore` backs up local files. Run with `--dry-run` first to review changes.

## Backups

Before `restore` overwrites or deletes an existing local file, the previous content is saved to `~/.ark/backups/<tool>/<timestamp>/<file>`.

`~/.ark/backups` is never cleaned up automatically. Each `restore` that prunes files adds a folder there, which can be large when it holds pruned local marketplace clones; delete old folders by hand.

## Safety notes

- `backup` refuses to write through symlinks in the repo folder (including the `<dir>/<tool>` folder itself). It stops with an error mid-run, so earlier files may already have been written.
- `restore` follows a symlinked local file and writes to its target, so symlinked dotfiles stay linked.
- Writes go to a temporary file followed by a rename.

## Adding a tool

Implement the `ToolAdapter` interface from `src/adapters/types.ts`:

- `name`: tool name, used for `--tool` and as the subfolder in the repo folder.
- `resolveHome(env, homedir)`: the tool's config root on the current machine.
- `allowlist`: files or directories, relative to that root, that are safe to sync.
- `blocked`: names (top-level, relative to that root) that are never synced, rejected as includes and skipped by `restore`. Required. Keeping it disjoint from the allowlist is up to the adapter author (not checked).
- `transform?(direction, file, data, home)`: optional content rewrite applied while copying (`direction` is `"backup"` or `"restore"`, `file` is relative to the root, `home` is the local root). Used by the Claude adapter to portabilize the plugin manifests.

Then register the adapter in `src/adapters/index.ts`. See `src/adapters/claude.ts` for an example.

## License

MIT. See [LICENSE](LICENSE).
