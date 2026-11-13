# Profile schema

```json
{
  "type": "flutter_play | npm_cli | astro_convex_netlify | electron_nsis | other",
  "targets": [{ "name": "", "paths": [], "trigger": "", "runbook": "" }],
  "versioning": {
    "scheme": "semver",
    "version_file": "package.json",
    "tag_format": "vX.Y.Z",
    "build_number": { "field": "", "monotonic": true, "never_reuse": true }
  },
  "changelog": {
    "path": "CHANGELOG.md",
    "format": "keep_a_changelog",
    "store_notes": { "path": "", "char_cap": 500 }
  },
  "git": {
    "release_from": "main",
    "release_commit_pattern": "chore(release): vX.Y.Z",
    "require": ["clean_tree", "ff_promotion", "ci_green_on_sha"]
  },
  "gates": { "pre_tag": [], "post_release": [], "evidence": [] },
  "publish": {
    "trigger": "tag_push | workflow_dispatch | local_script | push_to_main",
    "detail": {}
  },
  "rollback": {
    "steps": [],
    "never": ["unpublish", "retag", "reuse_version_or_build_number"]
  }
}
```

- `targets` is optional and for multi-surface repos only. The skill diffs each target's paths since the last release and orchestrates or explicitly flags EVERY touched target; shipping only one surface requires explicitly flagging the others.
- `versioning.scheme`: pre-1.0, minor means features and patch means fixes; 1.0 is reserved for the first public release. `version_file` is the single source of truth (`pubspec.yaml` for Flutter). `tag_format` is an annotated tag on the exact release commit. `build_number` is store types only.
- `changelog.format` `keep_a_changelog` means drafted from conventional commits since the last tag, then polished by hand. `store_notes` is the per-build note path and its character cap (Play caps at 500).
- `git.integration` is omitted for trunk-based repos. `release_commit_pattern` is the repo's exact historical pattern, read from `git log`.
- `gates.pre_tag` and `gates.post_release` hold the repo's real commands (test, typecheck, e2e, pack --dry-run). `gates.evidence` names what proves success: `git_tag`, `ci_run_url`, `registry_version`, `play_track_presence`, `netlify_deploy_id`, `update_feed_yml`, `live_site_check`.
- `publish.detail` is archetype-specific: workflow file, script name, track, site, or feed.
- `rollback.steps` are exact commands or console actions, forward-fix first.
