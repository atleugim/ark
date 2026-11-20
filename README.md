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
ark backup             # local config -> ~/.ark/repo/claude and ~/.ark/repo/agents, commit, push
ark backup --tool copilot  # ~/.copilot -> ~/.ark/repo/copilot, commit, push
ark backup --dry-run   # list changes without writing anything
ark restore            # git pull --ff-only, then repo config -> local config (also prunes, see Deletions)
ark restore --dry-run  # list changes without writing anything
ark backup --include output-styles --include notes  # also back up these paths, and remember them
ark backup --exclude skills/scratch                 # skip this path for this run only
ark restore --exclude skills/scratch                # skip this path for this run only
```

- `backup` and `restore` also sync `~/.agents/skills/` and `~/.agents/.skill-lock.json` with `<repo>/agents`; these changes are reported with an `agents/` prefix.
- `backup` copies the local config into `<repo>/<tool>`. It fails with a hint to run `ark init` if the repo folder does not exist.
- `restore` copies `<repo>/<tool>` into the local config and deletes local files, inside the paths `backup` syncs, that are absent from the repo (see Deletions). It fails if the repo or `<repo>/<tool>` does not exist (run `ark init`, and `ark backup` on the machine that has the config).
- `--tool <name>`: select the tool-specific adapter: `claude` (default) or `copilot`; the global `agents` sync always runs and is not selectable.
- `--dir <path>`: use this folder instead of `~/.ark/repo` (mainly for tests).
- `--include <path>`: `backup` only; add a file or folder from the selected tool's config to the backup and save it in `~/.ark/config.json` for later runs. Repeat it for several paths. `restore --include` is rejected. The path does not need to exist locally. Nothing is saved with `--dry-run`. It does not apply to `~/.agents`.
- `--exclude <path>`: `backup` and `restore`; skip a file or folder in the selected tool's config for this run only (never saved). Repeat it for several paths. It does not apply to `~/.agents`.
- `--dry-run`: print what would change (`would new: <file>` / `would update: <file>` / `would delete: <file>` / `would link: skills/<name>`) without writing files.

The local Claude config directory is `~/.claude`, or `CLAUDE_CONFIG_DIR` if set. For `--tool copilot` it is `~/.copilot`, or `COPILOT_HOME` if set.

Paths for `--include` and `--exclude` are relative to that directory. Absolute paths, paths containing `..` and empty paths are rejected. An `--include` of a never-synced name (see "What is synced") is an error; only the top-level segment is checked, and `--exclude` is not checked against that list.

Saved includes are stored per tool in `~/.ark/config.json`:

```json
{ "repo": "/home/you/.ark/repo", "include": { "claude": ["output-styles", "notes"] } }
```

There is no flag to remove a saved include; edit `~/.ark/config.json` by hand. If a saved include is invalid or blocked (for example `projects`), every `backup` and `restore` fails with a `config include` error until you fix the file.

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
- `backup` copies, then commits any changes as `sync(<tool>): <ISO 8601 UTC timestamp>`, and pushes with `git push --set-upstream origin HEAD` (plain `git push` once an upstream is set). One commit includes the selected tool's allowlist and includes under `<repo>/<tool>` (including removals of files that `backup` deleted) plus changes under `<repo>/agents/skills/` and `<repo>/agents/.skill-lock.json`, and, for tools that declare `skillLinks` (today Claude), `<repo>/links.json` (see "Skill links"). The subject remains `sync(<tool>): ...`; other files in `<repo>/<tool>` are left alone. With no changes it does not commit, but it still pushes so an earlier failed push is retried. `backup` does not pull first: run `restore` before `backup` when another machine may have pushed.
- `--dry-run` runs no git writes. `backup` prints `would commit` if there would be changes; `restore` skips the git pull.
- Your existing git identity is used. The repo is trusted: git runs its hooks and config. Conflicts are never resolved automatically: if a pull or push fails, resolve it by hand with git in the repo, then run the command again.
- A plain folder at the repo path (no `.git`) still works for `backup` and `restore` without git.

## What is synced

### Global agent configuration

Every `backup` and `restore` also syncs `~/.agents/skills/` and `~/.agents/.skill-lock.json` with `<repo>/agents/`. A missing `~/.agents` source or `<repo>/agents` repo directory is skipped; symlinked source entries are skipped. Backup syncs only these two entries. Restore copies entries present in `<repo>/agents/`, but prunes local files only inside `skills/` and `.skill-lock.json`; other local files are not pruned (though matching repo entries can be copied over them). `--exclude` is not applied to this sync.

### Skill links

For tools that declare `skillLinks` (today Claude), skills installed from `~/.agents/skills` are often symlinks such as `~/.claude/skills/<name> -> ../../.agents/skills/<name>`. They are not uploaded as files. Instead, `backup` records them in `<repo>/links.json`, keyed by tool name (at the repo root, included in the backup commit and reported as `new: links.json` / `update: links.json`):

```json
{
  "claude": [{ "link": "my-skill", "target": "my-skill" }]
}
```

Only names are stored, sorted, and the tool's own key is regenerated from scratch on every `backup`; other tools' keys are preserved. Only symlinks that point straight at a skill folder in `~/.agents/skills` are recorded; other symlinks stay ignored. With no such links and no existing `links.json`, nothing is written; with no links and an existing file, its own key becomes an empty list (the last backup wins, so a machine without links drops the entries of other machines for that tool). Once a skill is a symlink locally, the next `backup` deletes its old copy under `<tool>/<dir>/<name>/` from the repo. `--exclude` does not apply to links: `backup --exclude skills` still records them in `links.json`, while any older `<tool>/<dir>/<name>/` copies stay in the repo, so a later `restore` may report extra changes.

After restoring `~/.agents`, `restore` recreates the missing links as relative directory symlinks inside `~/.claude/skills` (or `CLAUDE_CONFIG_DIR/skills`). `restore --dry-run` prints `would link: skills/<name>`. A link that already points to the right skill (relative or absolute) is left alone silently. Anything else that already exists at the link path, or a target skill that is missing from `~/.agents/skills`, is skipped with a warning on stderr. `restore` reads only its own tool's key; a missing key means no links. Only tools that declare `skillLinks` use `links.json`; `--tool copilot` ignores it. A `links.json` that is not valid JSON or not an object stops `backup` and `restore` with an `Invalid .../links.json` error; `restore` also stops when its own `<tool>` entry is not a list (`backup` just regenerates that entry). `backup` leaves the file untouched and commits nothing, though files copied earlier in the run may already be in the repo. On a real run, `restore` stops after the local files are already restored, so the change list and the backup-folder message are not printed; earlier versions of overwritten files are still under `~/.ark/backups/<tool>/` (and `~/.ark/backups/agents/` for `~/.agents`). With `--dry-run` nothing has been restored when it stops. Fix or delete the file first.

### Claude (default)

`backup` syncs this allowlist plus any includes (saved ones and those passed with `--include` in this run), minus any `--exclude`. Paths are relative to the Claude config directory:

- `settings.json`
- `CLAUDE.md`
- `agents/`
- `skills/`
- `commands/`
- `hooks/`
- `plugins/installed_plugins.json`, `plugins/known_marketplaces.json` and `plugins/cache/` (installed plugins; per plugin only the version that `installPath` in `installed_plugins.json` points to is synced, and the other cached versions are pruned from the repo; every version is synced when there is no usable manifest or the plugin is not listed in it; if the manifest lists a plugin but its active version directory is missing locally, `backup` prunes every version of that plugin from the repo (recoverable from git history); marketplace clones and catalog caches are neither synced nor pruned). The plugin manifests store absolute paths, so on `backup` the local Claude config dir is replaced with the placeholder `CLAUDE_HOME` in the repo copy, and on `restore` `CLAUDE_HOME` is expanded to the local config dir. A literal `CLAUDE_HOME` already present in a manifest is also expanded on restore. Manifests that are not valid JSON are copied unchanged

`restore` takes every top-level entry present in `<repo>/<tool>` (not just the allowlist), except the never-synced names below. This includes entries that another machine added with `--include`. On a new machine, run `ark backup --include <path>` once so those includes are also saved locally and backed up from there. `restore` copies every file the repo has under those entries (for plugins, only the active version, by the same manifest rule), but it only prunes inside the paths `backup` would sync (the allowlist and the includes saved in `~/.ark/config.json`), so a local file that `backup` never uploads is never deleted. Behavior change: older versions of `restore` only copied, and only the allowlist; it now also prunes (see "Deletions" below). Run `ark restore --dry-run` first.

Only regular files are read. OS metadata files (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`, `.localized`, `ehthumbs.db`) are skipped inside synced folders. Symlinks are skipped, including allowlisted entries that are themselves symlinks (for example, a `settings.json` symlinked from a dotfiles repo is not backed up). The one exception is a skill symlink into `~/.agents/skills` in a tool that declares `skillLinks` (today Claude), which is recorded in `links.json` (see "Skill links").

Never synced, not even with `--include`, and skipped by `restore` even if present in the repo: `.credentials.json`, `settings.local.json`, `projects`, `sessions`, `history.jsonl`, `todos`, `statsig`, `shell-snapshots`, `ide`, `file-history`, `debug`, `session-env`, `telemetry`. Names are matched case-insensitively, with NFKC normalization, and trailing dots and spaces are ignored (`projects.` and `projects ` count as `projects`). On `backup`, anything that is not in the allowlist or an include is ignored.

Deletions propagate inside the paths `backup` syncs (the allowlist and the saved includes are pruned alike): a file that is gone from the source is removed from the destination (`delete: <file>`), and subfolders left empty are removed (the synced folder itself is kept). `backup` deletes files from the repo copy; `restore` deletes local files only inside those same paths when they are absent from the repo copy. So with the default allowlist `restore` prunes `plugins/cache` but never `plugins/marketplaces`, and a repo-only entry that this machine never included (for example `rules/` added by another machine) is copied but never pruned here; run `ark backup --include rules` on this machine to have it pruned too. Each deleted local file is first copied to `~/.ark/backups/<tool>/<timestamp>/`. The same applies to includes: after `ark backup --include notes`, `restore` deletes local files under `notes/` that are not in the repo (saving them first). An include that covers a whole allowlisted folder (for example `ark backup --include plugins`) makes `restore` prune all of `plugins/`, marketplaces included, just as `backup` uploads all of it. Use `--exclude notes/other.md` to protect specific files. A path that is missing entirely in the repo is not pruned, so local files under it are never touched. On `backup`, an entry missing entirely locally is not pruned from the repo; remove it with git. A path given with `--exclude` is neither copied nor pruned, even inside a larger entry or an allowlisted folder. Paths that differ only by case are treated as the same file (also when entries overlap), so a case-only rename never deletes the live file.

Known limitations of pruning:

- If the commit fails after `backup` deleted a repo file, the next `backup` does not see that file as a change, so the removal is not committed automatically. Remove it with git in the repo.
- On a case-sensitive filesystem, a stale duplicate that differs from a live file only by case is not pruned.
- A folder that holds only OS metadata files (skipped, see above) is not removed.

There is no conflict detection: the last backup wins. `backup` overwrites and deletes files in the repo without a backup (in a git-backed repo, git history is the recovery); only `restore` backs up local files. Run with `--dry-run` first to review changes.

### Copilot (`--tool copilot`)

The same include, exclude, restore and deletion rules apply, with the repo folder `<repo>/copilot`. Paths are relative to the Copilot config directory (`~/.copilot` or `COPILOT_HOME`). The allowlist is:

- `settings.json`
- `agents/`
- `skills/`
- `installed-plugins/`
- `installed-plugins.lock`

`installed-plugins` is synced verbatim: unlike the Claude plugin manifests, no paths are rewritten.

Never synced, not even with `--include`, and skipped by `restore` even if present in the repo: `config.json`, `plugin-data`, `session-state`, `session-store.db`, `session-store.db-shm`, `session-store.db-wal`, `logs`, `ide`, `command-history-state.json`, `open-sessions-state.json`, `sidebar-sessions-state`, `servers`, `config.json.trusted-folders.lock`, `settings.json.lock`.

## Backups

Before `restore` overwrites or deletes an existing local file, the previous content is saved to `~/.ark/backups/<tool>/<timestamp>/<file>`, and `restore` prints that folder (`Previous local files saved to <path>`) when it saved anything.

For the global agent configuration, previous files are saved under `~/.ark/backups/agents/<timestamp>/`.

`~/.ark/backups` is never cleaned up automatically. Each `restore` that replaces or deletes local files adds a folder there; delete old folders by hand.

## Safety notes

- `backup` refuses to write through symlinks in the repo folder (including the `<dir>/<tool>` folder itself). It stops with an error mid-run, so earlier files may already have been written.
- `restore` follows a symlinked local file and writes to its target, so symlinked dotfiles stay linked.
- `restore` creates skill links only inside the tool's skills folder (for Claude `~/.claude/skills`, or `CLAUDE_CONFIG_DIR/skills`), and only for names that are not empty, `.` or `..` and contain no `/` or `\`. It never replaces or deletes an existing file or symlink: conflicts are skipped with a warning. If that folder is itself a symlink or not a folder, all links are skipped with a warning. Creating a link may need extra permission on some systems (for example Windows); when it is denied, that link is skipped with a warning.
- `backup` refuses to write `links.json` if it is a symlink in the repo folder, or if it is not valid JSON or not an object: it stops with an error, leaves the file untouched and commits nothing, though files copied earlier may already be in the repo (see "Skill links").
- `restore` stops with an error on a malformed `links.json` (or a `<tool>` entry that is not a list) on a real run only after the local files are already restored; the change list and backup-folder message are not printed, and overwritten files are under `~/.ark/backups/<tool>/` and `~/.ark/backups/agents/`. With `--dry-run` nothing has been restored when it stops.
- Writes go to a temporary file followed by a rename.

## Adding a tool

Implement the `ToolAdapter` interface from `src/adapters/types.ts`:

- `name`: tool name, used for `--tool` and as the subfolder in the repo folder.
- `resolveHome(env, homedir)`: the tool's config root on the current machine.
- `allowlist`: files or directories, relative to that root, that are safe to sync.
- `blocked`: names (top-level, relative to that root) that are never synced, rejected as includes and skipped by `restore`. Required. Keeping it disjoint from the allowlist is up to the adapter author (not checked).
- `transform?(direction, file, data, home)`: optional content rewrite applied while copying (`direction` is `"backup"` or `"restore"`, `file` is relative to the root, `home` is the local root). Used by the Claude adapter to portabilize the plugin manifests.
- `activeFilter?(home)`: optional, async; resolves to a predicate over files (relative to the root) that returns `true` for the files to sync, or to `undefined` for no filtering. Used by the Claude adapter to sync only the active plugin version.
- `skillLinks?`: optional `{ dir }`, the skills folder relative to the root. Opts the tool into skill symlink portability: `backup` records symlinks in `dir` that point into `~/.agents/skills` under the tool's own key in `links.json`, and `restore` recreates them (see "Skill links"). Link targets always come from `~/.agents/skills`. For `backup` to delete the old repo copy of a skill that became a symlink, `dir` must also be in the adapter's allowlist (true for Claude). Omit it to opt out, as the Copilot adapter does; Claude declares `{ dir: "skills" }`.

Then register the adapter in `src/adapters/index.ts`. See `src/adapters/claude.ts` for an example.

Adapters that should always run alongside the selected tool, and must not be selectable with `--tool`, belong in `globalAdapters` in `src/adapters/index.ts`.

## License

MIT. See [LICENSE](LICENSE).
