#!/bin/sh
set -eu

# Provision the npm-distributed agent CLIs for a non-Docker Agent Manager.
# With no arguments, install every CLI the Docker image installs through npm.
# Pass CLI ids (for example, "opencode codex") to install only those tools.

prefix="${NPM_CONFIG_PREFIX:-$HOME/.local}"
export NPM_CONFIG_PREFIX="$prefix"
export PATH="$prefix/bin:$PATH"

selected="${*:-claude codex gemini opencode openclaw}"

# Required versus optional, matching the Dockerfile exactly: it installs Claude
# and Codex unconditionally and lets Gemini, opencode and OpenClaw fail with a
# note (`|| echo "... install failed"`). Those three routinely refuse to install
# on a Node version the others accept, so making them fatal here meant the
# recommended no-argument run could not finish on a supported runtime — and the
# manager already reports a missing CLI as unavailable rather than breaking.
skipped=''

for cli in $selected; do
  case "$cli" in
    claude)   package='@anthropic-ai/claude-code@latest'; binary='claude';   optional=0 ;;
    codex)    package='@openai/codex@latest';             binary='codex';    optional=0 ;;
    gemini)   package='@google/gemini-cli@latest';        binary='gemini';   optional=1 ;;
    opencode) package='opencode-ai@latest';               binary='opencode'; optional=1 ;;
    openclaw) package='openclaw@latest';                  binary='openclaw'; optional=1 ;;
    *)
      echo "unknown CLI '$cli' (expected: claude codex gemini opencode openclaw)" >&2
      exit 2
      ;;
  esac

  echo "Installing $cli ($package) into $prefix ..."
  if npm install -g --no-audit --no-fund "$package" && command -v "$binary" >/dev/null 2>&1; then
    echo "Installed $binary: $($binary --version 2>/dev/null | head -n 1)"
    continue
  fi
  if [ "$optional" -eq 0 ]; then
    echo "$cli did not install, and Agent Manager needs it" >&2
    exit 1
  fi
  echo "$cli did not install — Agent Manager will show it as unavailable" >&2
  skipped="$skipped $cli"
done

echo "Agent CLIs are installed in $prefix/bin."
if [ -n "$skipped" ]; then
  echo "Not installed:$skipped. Re-run with that name to see the failure in full."
fi
