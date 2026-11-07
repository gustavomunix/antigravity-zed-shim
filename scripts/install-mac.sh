#!/bin/sh
set -eu

label=dev.antigravity-zed-shim
port=${PORT:-8123}
root=$(cd "$(dirname "$0")/.." && pwd)
plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$HOME/Library/Logs/antigravity-zed-shim"
domain="gui/$(id -u)"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "Removed $label"
  exit 0
fi

node_bin=$(command -v node || true)
if [ -z "$node_bin" ]; then
  echo "node not found in PATH" >&2
  exit 1
fi

cd "$root"
npm install
npm run build

mkdir -p "$log_dir" "$(dirname "$plist")"

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$root/dist/cli.js</string>
    <string>serve</string>
    <string>--port</string>
    <string>$port</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$root</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Nice</key>
  <integer>10</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$log_dir/out.log</string>
  <key>StandardErrorPath</key>
  <string>$log_dir/err.log</string>
</dict>
</plist>
EOF

launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
launchctl kickstart -k "$domain/$label"

echo "Installed $label on http://127.0.0.1:$port"
echo "Logs: $log_dir"
