# dotfiles

Personal machine setup: configs, bootstrap scripts, and the tracker for what a fresh
machine needs. Successor to `claude-setup`, which outgrew its name.

`claude-setup` stays the home for Claude Code itself (agents, skills, hooks, profiles,
compiled-commit). Everything that is not Claude Code moves here.

## Scope

Belongs here:

- shell, terminal, editor, and window-manager config
- git config and global ignores
- OS-level bootstrap (packages, fonts, dictation, screenshot tooling)
- global CLI tooling lists and their install/uninstall convergence
- machine inventory and the checklist for standing a new one up

Does not belong here:

- anything Claude Code reads out of `~/.claude` (lives in `claude-setup`)
- project-specific config (lives in the project repo)
- secrets of any kind; this repo is private but is not a secret store

## Layout

Directories appear as content moves in; nothing is pre-created empty.

## Conventions

See [AGENTS.md](AGENTS.md).
