# dotfiles

Personal machine setup: Claude Code, editor, shell tooling, fonts, and services.

Linux, with mac seams left open. No Windows.

## Install

One command on any machine, fresh or converged:

```sh
curl -fsSL https://raw.githubusercontent.com/johncwaters/dotfiles/main/bin/dot | bash -s -- --profile server
```

Entry points: [converge and status](bin/dot), [bootstrap](script/bootstrap),
[collect](script/collect), [test suite](test/run-all.sh).
The [repository invariants and map](AGENTS.md) cover checkout safety and link ownership;
[script/lib/render.sh](script/lib/render.sh) owns rendered destinations.

## Profiles

Profile inputs live beside `profiles/<name>/profile.json`: `packages.txt`, `CLAUDE.md`,
`commit-policy.json`, `settings.overlay.json`, `glimmervoid.json`, `glimmervoid.overlay.json`,
`vscodium.json`.

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
| `glimmervoid` | dashboard config, plus the user service on profiles that serve Glimmervoid |
| `converge` | a nightly user timer running `dot`, the one converge outside Glimmervoid's cgroup that can pay a restart a hosted run left owed |
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
`glimmervoid/config.example.json` for `glimmervoid/config.json`, `git/gitconfig.local.example`
for `~/.gitconfig.local`, and `shell/localrc.example` for `~/.localrc`.
`~/.claude/settings.json` is rendered from `ai/settings.base.json` plus the active
profile's `settings.overlay.json`. `.machine-profile` is written by `script/bootstrap`.

`vscodium/mcp.json` reads its PostHog token from the environment, so
`POSTHOG_PERSONAL_API_KEY` has to be exported where VSCodium can see it.

`johnwaters.glimmervoid-visions` is built on this machine and published to no marketplace, so
`vscodium/extensions.txt` cannot name it. Install it by hand with
`codium --install-extension <path>.vsix`; exact sync keeps it, because an extension whose
manifest says `private` is never pruned.
