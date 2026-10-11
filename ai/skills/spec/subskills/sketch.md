# Sketch

Give the questions something concrete to attack.

1. Name the repo. `<repo>` is `basename "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"`, the main checkout's name from any worktree; outside git, the working directory's name.
2. Resume the design spec in `~/.claude/specs/<repo>/` whose Request and Goal match this feature, once the carbon unit confirms the match; a `challenged` one with a different Request is a different feature. A new feature gets `<slug>`: two to five kebab-case words, new to that directory.
3. Read the repo: instruction files, prior art by behavior and synonym, the code the feature touches. Record what the repo settles as `read` decisions with file and line.
4. Write Request, Goal, Non-goals, and one branch per guess with its leaning.
5. Tell the carbon unit the goal as understood and the branch count, then continue to `grill.md`.
