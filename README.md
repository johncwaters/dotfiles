# dotfiles

Personal machine setup: Claude Code, editor, shell tooling, fonts, and services.

The `personal` and `server` profiles are Linux-only; `work` is macOS-only. Bootstrap
refuses a mismatch because a partial cross-platform converge leaves the machine inconsistent.
No Windows.

## Install

This repository is private, so unauthenticated GitHub raw URLs return 404. Clone it through
`gh`, which follows its configured Git protocol, including SSH at work, then run `dot`
from the clone, which finds it in place and skips its own clone. Both blocks below are for
a fresh machine, since the clone step aborts on a path that already exists; a machine that
has already converged reruns plain `dot`.

```sh
sudo apt-get update
sudo apt-get install -y gh git
gh auth login
gh repo clone johncwaters/dotfiles ~/Projects/dotfiles
~/Projects/dotfiles/bin/dot --profile server
```

### Fresh mac

Run as the account that will own the machine; the profile is `work`. Apple ships bash 3.2,
so `bootstrap` re-execs through Homebrew bash before any topic runs. `--profile work`
is the only profile that converges there.

```sh
xcode-select --install
sudo -v
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
brew install gh
gh auth login
gh repo clone johncwaters/dotfiles ~/Projects/dotfiles
~/Projects/dotfiles/bin/dot --profile work
```

Homebrew comes first by hand because `gh` has to exist before the private repository
can be cloned, and `bootstrap` then finds it already installed. A Mac that already has
Homebrew and an authenticated `gh` (`gh auth status`) starts at `gh repo clone`. Choose
SSH when `gh auth login` asks for the Git protocol on the work Mac.

`sudo -v` asks the account password once and the Homebrew installer runs on that
credential; if it has lapsed by the time the shell topic appends `/etc/shells`, that
step asks again; `chsh` asks the account password itself. So a carbon unit sits at the
keyboard for the first run.

The first line opens Apple's installer dialog and returns at once; wait for it to finish
before the rest, since Homebrew needs the Command Line Tools. An unattended run warns
instead of asking and a later hand `dot` finishes it. Then open a new terminal, which
is now Homebrew bash, and run `dot status`. Converging again is plain `dot`.

Entry points: [converge and status](bin/dot), [bootstrap](script/bootstrap),
[collect](script/collect), [test suite](test/run-all.sh).
The [repository invariants and map](AGENTS.md) cover checkout safety and link ownership;
[script/lib/render.sh](script/lib/render.sh) owns rendered destinations.

## Profiles

Profile inputs live beside `profiles/<name>/profile.json`: `packages.txt`, `npm-globals.txt`, `AGENTS.md`, `CLAUDE.md`,
`skills/`, `review-checklist.md`, `mcp-servers.json`, `commit-policy.json`, `settings.overlay.json`,
`glimmervoid.json`, `glimmervoid.overlay.json`, `vscodium.json`.

- `personal`: this workstation
- `server`: headless, no editor or desktop topics
- `work`: Claude and Codex only, no other model CLIs, PostHog plugin for its MCP

## Topics

| Topic | Installs |
| --- | --- |
| `shell` | `~/.bashrc` and `~/.bash_profile` stubs; `~/.localrc` first, then the profile's topics' `*.bash`; a `c` completion over `$PROJECTS` |
| `git` | global gitconfig, with identity and credentials in `~/.gitconfig.local` |
| `ai` | Claude Code and Codex: agents, commands, hooks, hud, shared skills, workflows; profile skills in `profiles/<name>/skills/` |
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
| `coder` | the Coder CLI |
| `devbox` | glimmervoid on the Coder devbox, pushed from the laptop to keep the private dotfiles repo off the box |
| `peripherals` | Logitech tooling and the headset udev rule; LinearMouse on macOS |

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
