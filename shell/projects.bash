# shellcheck shell=bash
c() {
  cd -- "$PROJECTS/${1:-}" || return
}
