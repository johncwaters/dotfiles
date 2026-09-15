# dotfiles

Personal machine setup. Linux, with mac seams left open; no Windows.

## Invariants

- No secrets in tracked files. Config needing a credential reads it from the environment
  or an untracked sibling, with a tracked `.example` documenting the shape.
- Symlink, do not copy. A copy means the machine silently drifts from the repo until
  someone reruns the installer; a link cannot drift. Render only what a profile varies.
  Files that tools append to in place (`~/.gitconfig`, `~/.bashrc`, `~/.bash_profile`) are
  small stubs including the repo copy, since a link there makes `git config --global` and
  installer hooks write into the tracked file. `~/.claude/CLAUDE.md` is copied verbatim
  instead: Claude Code drops every `@import` in a memory file that is itself a symlink, and
  a stub cannot serve because the nested `@AGENTS.md` must resolve in `~/.claude`, beside
  the AGENTS.md link, not beside the profile file; the copy converges by rerunning the
  installer.
- Installers are idempotent. A machine is converged by running everything, not by
  remembering what already ran.
- Removals converge too. Retiring a tool means adding it to a removal list, so machines
  that already have it drop it, rather than only deleting it from the install list.
- A topic owns its concern completely: config, `install.sh`, `test.sh`. Deleting the dir
  deletes the feature.
- Machine-specific values are rendered or untracked, never committed.
- Platform branches go through `script/lib/platform.sh`, so tests can pin both systems without replacing `uname`.
- Bash 4 is the floor; bootstrap re-execs through Homebrew bash on macOS so topic code keeps one shell dialect.
- Link targets are written as `~/.dotfiles/...`, never as the clone path. The alias is
  what makes the checkout relocatable and lets a machine keep the repo wherever its owner
  works; `bootstrap` creates it and repoints it if the clone moved.
- What a converge still owes is state, not config: it is recorded under
  `$XDG_STATE_HOME/dotfiles` through `script/lib/state.sh`, so a run can retry owed work
  and no marker lands beside a root-owned target the next run cannot rewrite.
- The checkout is the live config, so `~/.dotfiles` stays on mainline and clean; feature work
  happens in a worktree. `bin/dot` refuses to converge otherwise, and every converge records
  its commit under the state directory so `dot status` can name the drift.
- `~/.claude` holds runtime state (`projects/`, `sessions/`, `plugins/`, credentials)
  that must never enter this repo, so `ai/install.sh` links per entry rather than
  linking whole directories.

## Map

- `script/bootstrap`: points `~/.dotfiles` at this clone, reads the profile, runs its
  topics in listed order
- `script/lib/`: shared helpers (logging, linking, rendering, profile parsing)
- `script/lib/merge-json.mjs`: shared base-plus-overlay JSON merge with `{{HOME}}`
  substitution, used by `ai` and `glimmervoid`
- `script/lib/packages.sh`: opt-in package tooling each software topic sources itself
- `script/collect`: pulls live machine state back into the repo
- `profiles/<name>/profile.json`: the topic list for that machine, in run order
- `profiles/<name>/packages.txt`: the package groups the `packages` topic installs there
- `<topic>/install.sh`: idempotent, safe to rerun, no assumptions about run order beyond
  what the profile guarantees; ends at `finishTopic`, which exits non-zero when the topic
  warned so bootstrap still sees the failure if the shared counts file is lost
- `<topic>/collect.sh`: optional, run by `script/collect`
- `<topic>/*.bash`: sourced by the shell loader for the profile's topics, `path.bash`
  first, `completion.bash` last; `shell/test.sh` pins the order
- `bin/dot`: clones on a fresh machine, pulls mainline and reruns bootstrap; `dot status`
  reports drift against `origin/main` and owed work
- `test/`: shared bubblewrap sandbox and cross-cutting suites listed in `test/run-all.sh`;
  per-topic tests live next to their installer
- `test/harness.sh`: shared assertions, sandbox home, command stubs
