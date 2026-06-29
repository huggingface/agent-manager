# Loaded for every interactive shell in a session (bash --rcfile).
# Pull in system defaults first, then set our prompt so it wins.
[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc

AM_USER="${AM_USER:-${SPACE_AUTHOR_NAME:-user}}"
AM_SESSION="${AM_SESSION:-session}"

# Prompt: "user/session $" — colors come from the (theme-tuned) ANSI palette,
# bold cyan user + bold green session, readable on both light and dark backgrounds.
PS1='\[\e[1;36m\]'"${AM_USER}"'\[\e[0;2m\]/\[\e[0m\]\[\e[1;32m\]'"${AM_SESSION}"'\[\e[0;2m\] \$\[\e[0m\] '
