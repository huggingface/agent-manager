#!/bin/sh
set -eu

# Provision the npm-distributed agent CLIs for a non-Docker Agent Manager.
# With no arguments, install every CLI the Docker image installs through npm.
# Pass CLI ids (for example, "opencode codex") to install only those tools.

prefix="${NPM_CONFIG_PREFIX:-$HOME/.local}"
export NPM_CONFIG_PREFIX="$prefix"
export PATH="$prefix/bin:$PATH"

selected="${*:-claude codex gemini opencode openclaw}"

for cli in $selected; do
  case "$cli" in
    claude)   package='@anthropic-ai/claude-code@latest'; binary='claude' ;;
    codex)    package='@openai/codex@latest';             binary='codex' ;;
    gemini)   package='@google/gemini-cli@latest';        binary='gemini' ;;
    opencode) package='opencode-ai@latest';               binary='opencode' ;;
    openclaw) package='openclaw@latest';                  binary='openclaw' ;;
    *)
      echo "unknown CLI '$cli' (expected: claude codex gemini opencode openclaw)" >&2
      exit 2
      ;;
  esac

  echo "Installing $cli ($package) into $prefix ..."
  npm install -g --no-audit --no-fund "$package"
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "$cli installation completed but '$binary' is not on PATH" >&2
    exit 1
  fi
  echo "Installed $binary: $($binary --version 2>/dev/null | head -n 1)"
done

echo "Agent CLIs are installed in $prefix/bin."
