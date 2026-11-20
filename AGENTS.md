# dotfiles

Personal machine setup. Linux for the personal and server profiles, macOS for work; no Windows.

## Invariants

- No secrets in tracked files. Config needing a credential reads it from the environment
  or an untracked sibling, with a tracked `.example` documenting the shape.
- Symlink, do not copy. A copy means the machine silently drifts from the repo until
  someone reruns the installer; a link cannot drift. Render only what a profile varies.
  Files that tools append to in place (`~/.gitconfig`, `~/.bashrc`, `~/.bash_profile`) are
  small stubs including the repo copy, since a link there makes `git config --global` and
  installer hooks write into the tracked file. Git's repo copy is instead linked
  at `~/.config/git/config` by its physical checkout path, since sandboxes that allow the
  standard git config paths deny an include outside them and the `~/.dotfiles` hop. `~/.claude/CLAUDE.md` is a rendered plain file
  instead: Claude Code drops every `@import` in a memory file that is itself a symlink, and
  its `@AGENTS.md` must resolve in `~/.claude`, beside the AGENTS.md link. The desktop wallpaper HEIC is copied too: macOS ignores a symlinked HEIC's
  time-of-day schedule.
- Agent rules live in AGENTS.md files, never in a `CLAUDE.md`, which `ai/install.sh` renders
  as imports alone (`ai/test.sh` pins this), so Codex and agy get every rule too. Profile-only rules go in
  `profiles/<name>/AGENTS.md` and reach only that profile or its declared AI descendants
  (`ai/test.sh` pins isolation); Codex and agy read one global
  file with no imports, so `ai/install.sh` renders shared plus profile rules into each.
- Installers are idempotent. A machine is converged by running everything, not by
  remembering what already ran.
- Removals converge too. Retiring a tool means adding it to a removal list, so machines
  that already have it drop it, rather than only deleting it from the install list.
- A topic owns its concern completely: config, `install.sh`, `test.sh`. Deleting the dir
  deletes the feature.
- Machine-specific values are rendered or untracked, never committed.
- Platform branches go through `script/lib/platform.sh`, so tests can pin both systems without replacing `uname`.
- A profile may pin its platform because a converge on the wrong OS would half-apply before the first Darwin-only step failed.
- Bash 4 is the floor; bootstrap re-execs through Homebrew bash on macOS so topic code keeps one shell dialect.
- Link targets are written as `~/.dotfiles/...`, never as the clone path, except git's
  XDG link above, which a rerun relinks after a move. The alias is
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
  topics in listed order; a run with only `noteWarned` exits 0, since callers read non-zero
  as broken, and any `noteFailed` exits 1; `test/bootstrap.sh` pins both
- `script/lib/`: shared helpers (logging, linking, rendering, profile parsing)
- `script/lib/merge-json.mjs`: shared base-plus-overlay JSON merge with `{{HOME}}`
  substitution, used by `ai` and `glimmervoid`
- `script/lib/packages.sh`: opt-in package tooling each software topic sources itself
- `script/collect`: pulls live machine state back into the repo
- `profiles/<name>/profile.json`: the topic list for that machine, in run order, and its optional platform pin
- `profiles/<name>/packages.txt`: the package groups the `packages` topic installs there
- `profiles/<name>/`: profile additions and AI inheritance (`ai.json` `extends`);
  `ai/test.sh` and `test/repo-wiring.sh` pin isolation so shared installers need no profile names.
- `<topic>/install.sh`: idempotent, safe to rerun, no assumptions about run order beyond
  what the profile guarantees; ends at `finishTopic`, which exits non-zero when the topic
  warned so bootstrap still sees the failure if the shared counts file is lost
- `<topic>/collect.sh`: optional, run by `script/collect`
- `<topic>/*.bash`: sourced by the shell loader for the profile's topics, `path.bash`
  first, `completion.bash` last; `shell/test.sh` pins the order
- `bin/dot`: clones on a fresh machine, pulls mainline and reruns bootstrap; `dot status`
  reports drift against `origin/main` and owed work
- `test/`: cross-cutting suites listed in `test/run-all.sh`;
  per-topic tests live next to their installer
- `test/harness.sh`: shared assertions, sandbox home, command stubs
- `GLOSSARY.md`: one meaning per workflow term (design spec, unit of work, ticket); docs cite it as
  `~/.dotfiles/GLOSSARY.md`, and `test/repo-wiring.sh` pins that every cited term is defined
