# dotfiles

Personal machine setup repo. Successor to `claude-setup` for everything that is not
Claude Code itself.

## Invariants

- No secrets in tracked files. Config that needs a credential reads it from the
  environment or from an untracked `*.local` sibling, with a tracked `.example` next to
  it documenting the shape.
- Scripts are idempotent. Re-running a bootstrap step on a converged machine is a no-op,
  because a machine is set up by running everything, not by remembering what already ran.
- Machine-specific values are rendered, never committed. Absolute paths, hostnames, and
  clone urls come from a profile or a token substitution at apply time.
- Removals converge too. Retiring a tool means adding it to the removal list, not just
  deleting it from the install list, so machines that already have it drop it.

## Map

- `README.md`: scope boundary against `claude-setup`, layout
- `CLAUDE.md`: pointer to this file only

## Related repos

- `claude-setup`: Claude Code config (agents, skills, hooks, profiles, compiled-commit)
