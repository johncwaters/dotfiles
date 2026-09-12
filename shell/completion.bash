# shellcheck shell=bash
if ! shopt -oq posix && [[ -f /usr/share/bash-completion/bash_completion ]]; then
  source /usr/share/bash-completion/bash_completion
fi

_completeProjectNames() {
  local currentWord="${COMP_WORDS[COMP_CWORD]}"
  mapfile -t COMPREPLY < <(compgen -d -- "$PROJECTS/$currentWord")
  COMPREPLY=("${COMPREPLY[@]#"$PROJECTS/"}")
}
complete -o nospace -o filenames -F _completeProjectNames c
