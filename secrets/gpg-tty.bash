if tty -s; then
  GPG_TTY="$(tty)"
  export GPG_TTY
fi
