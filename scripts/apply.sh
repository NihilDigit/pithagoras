#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$HOME/.pi/agent" "$HOME/.agent-browser"

backup_copy() {
  local src="$1"
  local dst="$2"
  if [[ -f "$dst" ]]; then
    cp "$dst" "$dst.$STAMP.bak"
  fi
  cp "$src" "$dst"
}

backup_copy "$ROOT/configs/pi/AGENTS.md" "$HOME/.pi/agent/AGENTS.md"
backup_copy "$ROOT/configs/pi/web-search.json" "$HOME/.pi/web-search.json"
backup_copy "$ROOT/configs/agent-browser/config.json" "$HOME/.agent-browser/config.json"

# Install/update the Pi packages this setup expects. `pi install` is idempotent for already-installed packages.
pi install npm:pi-resource-center || true
pi install npm:pi-web-access || true

# Install agent-browser and its Agent Skill. The skill is a stable stub that loads version-matched usage docs from the CLI.
bun install -g agent-browser || true
bunx skills add vercel-labs/agent-browser -g --skill agent-browser --agent '*' -y || true

ROOT="$ROOT" python - <<'PY'
import json
import os
from pathlib import Path
src = Path(os.environ['ROOT']) / 'configs' / 'pi' / 'settings.json'
dst = Path.home() / '.pi' / 'agent' / 'settings.json'
base = {}
if dst.exists():
    base = json.loads(dst.read_text())
setup = json.loads(src.read_text())
for package in setup.get('packages', []):
    base.setdefault('packages', [])
    if package not in base['packages']:
        base['packages'].append(package)
dst.write_text(json.dumps(base, indent=2, ensure_ascii=False) + '\n')
PY

echo "Applied pithagoras setup. Restart or /reload Pi to pick up resource changes."
