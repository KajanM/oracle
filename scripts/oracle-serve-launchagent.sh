#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/oracle-serve-launchagent.sh <install|uninstall|restart|status> [options]

Options:
  --host <address>     Bind address for oracle serve (default 0.0.0.0)
  --port <number>      Port for oracle serve (default 7333)
  --token <token>      Required for install/restart; stored in the user LaunchAgent
  --repo <path>        Oracle checkout path (default current directory)
  --label <label>      LaunchAgent label (default dev.oracle.serve)

This installs a per-user macOS LaunchAgent. It runs in the logged-in GUI
launchd domain, which gives Oracle access to the user's Chrome cookies/Keychain.
EOF
}

command="${1:-}"
if [[ -z "$command" ]]; then
  usage
  exit 2
fi
shift || true

host="0.0.0.0"
port="7333"
token="${ORACLE_SERVE_TOKEN:-}"
repo="$(pwd)"
label="dev.oracle.serve"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      host="${2:?missing --host value}"
      shift 2
      ;;
    --port)
      port="${2:?missing --port value}"
      shift 2
      ;;
    --token)
      token="${2:?missing --token value}"
      shift 2
      ;;
    --repo)
      repo="${2:?missing --repo value}"
      shift 2
      ;;
    --label)
      label="${2:?missing --label value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

repo="$(cd "$repo" && pwd)"
plist="$HOME/Library/LaunchAgents/$label.plist"
oracle_home="${ORACLE_HOME:-$HOME/.oracle}"
uid="$(id -u)"
service="gui/$uid/$label"
node_bin_dir="$(dirname "$(command -v node)")"
path_value="$node_bin_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

write_plist() {
  if [[ -z "$token" ]]; then
    echo "Missing --token (or ORACLE_SERVE_TOKEN) for $command." >&2
    exit 2
  fi
  mkdir -p "$(dirname "$plist")" "$oracle_home"
  local shell_command
  shell_command="cd $(printf '%q' "$repo") && export PATH=$(printf '%q' "$path_value") && export ORACLE_SERVE_LOG_RUNS=1 ORACLE_SERVE_VERBOSE=1 && exec node dist/bin/oracle-cli.js serve --host $(printf '%q' "$host") --port $(printf '%q' "$port") --token $(printf '%q' "$token")"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$label")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>$(xml_escape "$shell_command")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$repo")</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$oracle_home/serve.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$oracle_home/serve.err.log")</string>
</dict>
</plist>
EOF
  chmod 600 "$plist"
}

bootout() {
  launchctl bootout "gui/$uid" "$plist" >/dev/null 2>&1 || true
}

bootstrap() {
  launchctl bootstrap "gui/$uid" "$plist"
  launchctl kickstart -k "$service"
}

case "$command" in
  install)
    write_plist
    bootout
    bootstrap
    ;;
  uninstall)
    bootout
    rm -f "$plist"
    ;;
  restart)
    write_plist
    bootout
    bootstrap
    ;;
  status)
    launchctl print "$service"
    ;;
  *)
    echo "Unknown command: $command" >&2
    usage >&2
    exit 2
    ;;
esac
