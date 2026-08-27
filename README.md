# dotfiles

Personal machine setup: Claude Code, editor, shell tooling, fonts, services, and the
bootstrap that puts them on a fresh machine. Replaces `claude-setup`, which outgrew its
name.

Linux, with mac seams left open. No Windows.

## Install

```sh
git clone git@github.com:johncwaters/dotfiles.git ~/.dotfiles
cd ~/.dotfiles
script/bootstrap
```

The repo path is baked into every symlink it creates, so it lives at `~/.dotfiles` and
stays there.

## How it works

Each top-level dir is a topic that owns one concern: its config files, its `install.sh`,
its `test.sh`. `script/bootstrap` reads the machine's profile, runs that profile's topics
in listed order, and each topic links its config into place.

Almost everything is a symlink, so a `git pull` updates the machine and `script/bootstrap`
only ensures the links exist. The exception is `~/.claude/settings.json`, rendered from
`ai/settings.base.json` plus the profile's `settings.overlay.json`.

## Profiles

`profiles/<name>/profile.json` lists the topics that profile runs, in order. Ordering is
load-bearing: `packages` installs node before `ai` needs it, git before `repos` clones.
Alongside it sit the files that genuinely differ per machine: `CLAUDE.md`, `commit.md`,
`settings.overlay.json`.

The active profile comes from `.machine-profile` (untracked) or `$DOTFILES_PROFILE`.

- `personal`: this workstation
- `server`: headless, no editor or desktop topics
- `work`: Claude models only, no external model CLIs, org PR workflow

## Topics

| Topic | Installs |
| --- | --- |
| `ai` | Claude Code and Codex: agents, commands, hooks, hud, skills, compiled-commit |
| `git` | global gitconfig |
| `vscodium` | settings, keybindings, mcp.json, extensions |
| `glissa` | dashboard config and user service |
| `fonts` | CommitMono |
| `dictation` | ydotoold user service |
| `screenshot` | flameshot desktop entry and save path |
| `packages` | system packages, npm globals, python tools, and their removals |
| `repos` | clones the working set |

Vendored third-party skills are listed in [NOTICE.md](NOTICE.md).

## Machine-local files

Anything holding a path, hostname, or credential is untracked, with a tracked
`.example` sibling documenting its shape: `.machine-profile`, `repos/repos.txt`,
`glissa/config.json`, `~/.claude/settings.json`.
