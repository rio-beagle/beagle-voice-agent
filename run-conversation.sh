#!/bin/bash
# Explicit operator action: temporarily replace old listener, restore it on exit.
set -eu
cd /workspace/beagle-voice-agent
exec 9>out/listener-switch.lock
flock -n 9 || { echo 'another conversational listener holds the lock'; exit 1; }
mapfile -t prior < <(pgrep -f '^(/usr/local/lib/nodejs/node|node) agent.js listen' || true)
restore() { for pid in "${prior[@]}"; do kill -CONT "$pid" 2>/dev/null || true; done; }
trap restore EXIT
for pid in "${prior[@]}"; do kill -STOP "$pid"; done
node converse.js "$@"
