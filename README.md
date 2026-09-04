# dotfiles

Personal machine setup: Claude Code, editor, shell tooling, fonts, services, and the
bootstrap that puts them on a fresh machine. Replaces `claude-setup`, which outgrew its
name.

Linux, with mac seams left open. No Windows.

## Install

Clone it wherever you work on repos, then bootstrap:

```sh
git clone git@github.com:johncwaters/dotfiles.git ~/Projects/dotfiles
cd ~/Projects/dotfiles
script/bootstrap
```

After that, `dot` is on PATH in any new interactive shell: it pulls the repo and reruns bootstrap, so
keeping a machine current is one command.

`bootstrap` points `~/.dotfiles` at the clone and every link it creates resolves through
that alias, never through the clone path. So the checkout lives wherever you want it and
moving it later means repointing one symlink instead of rewriting every link on the
machine.

## How it works

Each top-level dir is a topic that owns one concern: its config files, its `install.sh`,
its `test.sh`. `script/bootstrap` reads the machine's profile, runs that profile's topics
in listed order, and each topic links its config into place.

Almost everything is a symlink, so a `git pull` updates the machine and `script/bootstrap`
only ensures the links exist. Destinations that carry a machine-specific value are rendered
or copied instead, and those go through `script/lib/render.sh`, which keeps a sidecar of what
it last wrote so a hand edit is backed up and its own output is not. `~/.gitconfig`,
`~/.bashrc`, `~/.bash_profile` are small stubs that include the repo copy, because git
and installers append to those files in place and a link would send the appends into the
repo.

## Profiles

`profiles/<name>/profile.json` lists the topics that profile runs, in order. Ordering is
load-bearing: `packages` installs node before `ai` needs it, git before `repos` clones.
Alongside it sit the files that genuinely differ per machine: `packages.txt`, `CLAUDE.md`,
`commit-policy.json`, `settings.overlay.json`, `glissa.json`, `glissa.overlay.json`,
`vscodium.json`.

The active profile comes from `--profile`, then `$DOTFILES_PROFILE`, then the untracked
`.machine-profile`. An existing `.machine-profile` is never rewritten, so a differing
`--profile` or `$DOTFILES_PROFILE` applies to that one run and the machine keeps its
profile.

- `personal`: this workstation
- `server`: headless, no editor or desktop topics
- `work`: Claude models only, no external model CLIs, org PR workflow

## Topics

| Topic | Installs |
| --- | --- |
| `shell` | `~/.bashrc` and `~/.bash_profile` stubs; `~/.localrc` first, then the profile's topics' `*.bash`; a `c` completion over `$PROJECTS` |
| `git` | global gitconfig, with identity and credentials in `~/.gitconfig.local` |
| `ai` | Claude Code and Codex: agents, commands, hooks, hud, skills, compiled-commit |
| `vscodium` | settings, keybindings, mcp.json, extensions |
| `glissa` | dashboard config, plus the user service on profiles that serve Glissa |
| `fonts` | CommitMono |
| `dictation` | ydotoold user service |
| `screenshot` | flameshot desktop entry and save path |
| `terminal` | Ghostty, its config, and COSMIC's default terminal |
| `packages` | system packages, npm globals, python tools, and their removals |
| `repos` | clones the working set |
| `tailscale` | the tailnet client |
| `peripherals` | Logitech tooling and the headset udev rule |

Vendored third-party skills are listed in [NOTICE.md](NOTICE.md).

## Machine-local files

Anything holding a path, hostname, or credential is untracked, with a tracked
example documenting its shape: `repos/repos.example.txt` for `repos/repos.txt`,
`glissa/config.example.json` for `glissa/config.json`, `git/gitconfig.local.example`
for `~/.gitconfig.local`, and `shell/localrc.example` for `~/.localrc`.
`~/.claude/settings.json` is rendered from `ai/settings.base.json` plus the active
profile's `settings.overlay.json`. `.machine-profile` is written by `script/bootstrap`.

`~/.localrc` is where a machine's own exports go. The shell topic sources it before
anything else. The git topic seeds `~/.gitconfig.local` from the previous `~/.gitconfig`.

`vscodium/mcp.json` reads its PostHog token from the environment, so
`POSTHOG_PERSONAL_API_KEY` has to be exported where VSCodium can see it.

`johnwaters.glissa-visions` is built on this machine and published to no marketplace, so
`vscodium/extensions.txt` cannot name it. Install it by hand with
`codium --install-extension <path>.vsix`; exact sync keeps it, because an extension whose
manifest says `private` is never pruned.
