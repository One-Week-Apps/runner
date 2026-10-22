#!/bin/bash
# Stops and removes the One Week Apps Runner services. Keeps the configuration and clones (~/.aitasker).
set -uo pipefail
for label in com.oneweekapps.runner.focus com.oneweekapps.runner.compute com.oneweekapps.runner.awake; do
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 && echo "  arrêté : $label"
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
echo "Runner désinstallé. Configuration et clones conservés dans ~/.aitasker."
