# dotfiles

Personal machine setup. Linux, with mac seams left open; no Windows.

## Invariants

- No secrets in tracked files. Config needing a credential reads it from the environment
  or an untracked sibling, with a tracked `.example` documenting the shape.
- Symlink, do not copy. A copy means the machine silently drifts from the repo until
  someone reruns the installer; a link cannot drift. Render only what a profile varies.
- Installers are idempotent. A machine is converged by running everything, not by
  remembering what already ran.
- Removals converge too. Retiring a tool means adding it to a removal list, so machines
  that already have it drop it, rather than only deleting it from the install list.
- A topic owns its concern completely: config, `install.sh`, `test.sh`. Deleting the dir
  deletes the feature.
- Machine-specific values are rendered or untracked, never committed.
- Link targets are written as `~/.dotfiles/...`, never as the clone path. The alias is
  what makes the checkout relocatable and lets a machine keep the repo wherever its owner
  works; `bootstrap` creates it and repoints it if the clone moved.
- `~/.claude` holds runtime state (`projects/`, `sessions/`, `plugins/`, credentials)
  that must never enter this repo, so `ai/install.sh` links per entry rather than
  linking whole directories.

## Map

- `script/bootstrap`: points `~/.dotfiles` at this clone, reads the profile, runs its
  topics in listed order
- `script/lib/`: shared shell helpers (logging, linking, rendering, profile parsing)
- `script/collect`: pulls live machine state back into the repo
- `bin/`: on PATH
- `profiles/<name>/profile.json`: the topic list for that machine, in run order
- `<topic>/install.sh`: idempotent, safe to rerun, no assumptions about run order beyond
  what the profile guarantees
- `test/`: shared Docker matrix; per-topic tests live next to their installer
