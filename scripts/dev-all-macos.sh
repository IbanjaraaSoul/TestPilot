#!/usr/bin/env bash
# Opens 2 Terminal.app windows: demo target (:3456), TestPilot (:3000). LLM is cloud-only (.env).
# macOS only. From project root: npm run dev:all

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

osascript <<OSA
tell application "Terminal"
  activate
  do script "cd $(printf %q "$ROOT") && printf '\\n=== Demo target http://localhost:3456 ===\\n\\n' && npm run demo-target"
  delay 0.4
  do script "cd $(printf %q "$ROOT") && printf '\\n=== TestPilot http://localhost:3000 ===\\n\\n' && npm start"
end tell
OSA

echo "Opened 2 Terminal windows (demo-target, TestPilot)."
