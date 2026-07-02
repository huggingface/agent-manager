# Loaded for every interactive shell in a session (bash --rcfile).
# Pull in system defaults first, then set our prompt so it wins.
[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc

AM_USER="${AM_USER:-${SPACE_AUTHOR_NAME:-user}}"

# The prompt's location segment: the CURRENT directory, shown relative to the
# workspaces root (AM_ROOT, exported by the manager) so it starts as the
# session's folder and follows you as you cd around. Falls back to ~-style
# for anything outside the workspace tree.
_am_pwd() {
  local root="${AM_ROOT:-/data/workspaces}"
  case "$PWD" in
    "$root")     printf 'workspaces' ;;
    "$root"/*)   printf '%s' "${PWD#"$root"/}" ;;
    "$HOME")     printf '~' ;;
    "$HOME"/*)   printf '~/%s' "${PWD#"$HOME"/}" ;;
    *)           printf '%s' "$PWD" ;;
  esac
}

# Prompt: "user/current-dir $" — colors come from the (theme-tuned) ANSI
# palette, bold cyan user + bold green location, readable on both light and
# dark backgrounds. $(_am_pwd) is single-quoted so it re-evaluates per prompt.
PS1='\[\e[1;36m\]'"${AM_USER}"'\[\e[0;2m\]/\[\e[0m\]\[\e[1;32m\]$(_am_pwd)\[\e[0;2m\] \$\[\e[0m\] '
