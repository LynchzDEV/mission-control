#!/usr/bin/env bash
# Usage: scripts/wsl/setup.sh [--with-plugins] [--repo <git-url>] [--no-cli]
set -euo pipefail

MIN_BUN=1.2.23
USERNS_KEY=kernel.apparmor_restrict_unprivileged_userns
USERNS_PROC=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
USERNS_CONF=/etc/sysctl.d/60-mission-control-userns.conf
DEFAULT_CLONE_DIR="$HOME/mission-control"

with_plugins=false
install_cli=true
repo_url=""

say() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2p' "$0" | sed 's/^# //'
}

parse_args() {
  while (($#)); do
    case "$1" in
      --with-plugins) with_plugins=true ;;
      --no-cli) install_cli=false ;;
      --repo)
        [[ $# -ge 2 && -n "$2" ]] || die "--repo needs a git URL"
        repo_url="$2"
        shift
        ;;
      -h|--help) usage; exit 0 ;;
      *) usage; die "unknown option: $1" ;;
    esac
    shift
  done
}

as_root() {
  if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

check_platform() {
  [[ "$(uname -s)" == "Linux" ]] || die "run this inside WSL Ubuntu (Linux), not on $(uname -s)"
  [[ $EUID -ne 0 ]] || warn "running as root; run as your normal WSL user so the cockpit lives in your home folder"
  if grep -qi microsoft /proc/version 2>/dev/null; then
    say "WSL detected"
  fi
}

install_apt_packages() {
  local packages=(git curl unzip lsof ripgrep ca-certificates python3 make g++)
  if $with_plugins; then packages+=(bubblewrap socat); fi
  say "Installing system packages: ${packages[*]} (sudo may ask for your password)"
  as_root apt-get update -y
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"
}

allow_plugin_sandbox() {
  if [[ ! -e $USERNS_PROC ]]; then
    say "$USERNS_KEY not present on this kernel; nothing to change for isolated plugins"
    return
  fi
  if [[ "$(cat "$USERNS_PROC")" == "0" ]]; then
    say "$USERNS_KEY is already 0"
  else
    as_root sysctl -w "$USERNS_KEY=0" >/dev/null 2>&1 || true
  fi
  if [[ "$(cat "$USERNS_PROC")" == "0" ]]; then
    say "$USERNS_KEY is 0, so the plugin sandbox (bubblewrap) can create user namespaces"
  else
    warn "could not set $USERNS_KEY=0 now (read-only /proc/sys, e.g. inside Docker); isolated plugins may fail until it is set"
  fi
  printf '%s = 0\n' "$USERNS_KEY" | as_root tee "$USERNS_CONF" >/dev/null
  say "Persisted in $USERNS_CONF (remove that file to undo; it lowers a hardening default on Ubuntu 24.04)"
}

bun_version_ok() {
  command -v bun >/dev/null 2>&1 || return 1
  local current
  current="$(bun --version)"
  [[ "$(printf '%s\n%s\n' "$MIN_BUN" "$current" | sort -V | head -n1)" == "$MIN_BUN" ]]
}

ensure_bun() {
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if bun_version_ok; then
    say "Bun $(bun --version) is new enough"
    return
  fi
  if command -v bun >/dev/null 2>&1; then
    say "Bun $(bun --version) is older than $MIN_BUN; upgrading"
    bun upgrade
  else
    say "Installing Bun"
    curl -fsSL https://bun.sh/install | bash
  fi
  bun_version_ok || die "Bun $MIN_BUN or newer is required (found: $(bun --version 2>/dev/null || echo none))"
}

ensure_claude_cli() {
  export PATH="$HOME/.local/bin:$PATH"
  if command -v claude >/dev/null 2>&1; then
    say "Claude CLI already installed"
    return
  fi
  say "Installing Claude CLI"
  curl -fsSL https://claude.ai/install.sh | bash
}

ensure_codex_cli() {
  if command -v codex >/dev/null 2>&1; then
    say "Codex CLI already installed"
    return
  fi
  say "Installing Codex CLI"
  bun add -g @openai/codex
}

ensure_login_path() {
  local profile="$HOME/.profile"
  # shellcheck disable=SC2016  # written literally so $HOME expands at login, not now
  local line='export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"'
  if grep -qxF "$line" "$profile" 2>/dev/null; then return; fi
  say "Adding Bun and Claude to the login PATH in $profile (used by the Windows autostart task)"
  printf '\n%s\n' "$line" >>"$profile"
}

resolve_repo_dir() {
  if [[ -n $repo_url ]]; then
    if [[ -d "$DEFAULT_CLONE_DIR/.git" ]]; then
      say "$DEFAULT_CLONE_DIR already exists; leaving it as is" >&2
    else
      [[ ! -e $DEFAULT_CLONE_DIR ]] || die "$DEFAULT_CLONE_DIR exists but is not a git checkout"
      say "Cloning $repo_url into $DEFAULT_CLONE_DIR" >&2
      git clone "$repo_url" "$DEFAULT_CLONE_DIR" >&2
    fi
    printf '%s\n' "$DEFAULT_CLONE_DIR"
    return
  fi
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  (cd "$script_dir/../.." && pwd)
}

check_repo_location() {
  local repo_dir="$1"
  [[ -f "$repo_dir/package.json" ]] || die "$repo_dir does not look like a Mission Control checkout"
  case "$repo_dir" in
    /mnt/*) die "$repo_dir is on the Windows drive; clone it inside your WSL home (e.g. ~/mission-control) instead" ;;
    "$HOME"/*) ;;
    *) warn "$repo_dir is outside $HOME; Mission Control only works with folders under your home directory" ;;
  esac
}

install_dependencies() {
  local repo_dir="$1" node_shim
  node_shim="$(mktemp -d)"
  ln -s "$(command -v bun)" "$node_shim/node"
  say "Installing dependencies in $repo_dir"
  # Ubuntu's apt node 18 cannot run node-gyp@latest (node-pty build), so Bun stands in as node.
  (cd "$repo_dir" && PATH="$node_shim:$PATH" bun install)
  rm -r -- "$node_shim"
}

print_next_steps() {
  local repo_dir="$1"
  cat <<EOF

Setup finished. Next steps:
  1. Open a new terminal (or run: source ~/.bashrc) so bun and claude are on your PATH.
  2. Sign in to Claude:   claude      (follow the login prompt, then exit)
  3. Sign in to Codex:    codex login (needed before the first review job)
  4. GLM runs the build jobs by default: paste your z.ai token in Studio -> Manage AIs -> GLM,
     or reassign the roles there to AIs you have.
  5. Start the cockpit:   cd $repo_dir && bun start
  6. Open http://localhost:7777 in your Windows browser.
EOF
  if ! $with_plugins; then
    printf '\nIsolated plugins (e.g. the ClickUp board) need: %s --with-plugins\n' "$0"
  fi
}

main() {
  parse_args "$@"
  check_platform
  install_apt_packages
  if $with_plugins; then allow_plugin_sandbox; fi
  ensure_bun
  ensure_login_path
  if $install_cli; then
    ensure_claude_cli
    ensure_codex_cli
  else
    say "Skipping Claude/Codex CLI installs (--no-cli)"
  fi
  local repo_dir
  repo_dir="$(resolve_repo_dir)"
  check_repo_location "$repo_dir"
  install_dependencies "$repo_dir"
  print_next_steps "$repo_dir"
}

main "$@"
