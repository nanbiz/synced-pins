#!/bin/sh
# Runs the end-to-end suite with a headed Chromium on a private Xvfb display.
# Headless Chromium reports every window as focused and fires no focus
# events, so the focus-dependent behaviour can only be tested headed.
set -eu
cd "$(dirname "$0")/.."
if ! command -v xvfb-run >/dev/null; then
  echo "xvfb-run is required (on NixOS: nix shell nixpkgs#xvfb-run -c sh scripts/test-e2e.sh)" >&2
  exit 1
fi
unset WAYLAND_DISPLAY
export SYNCED_PINS_XVFB=1
exec xvfb-run --auto-servernum --server-args='-screen 0 1600x1000x24 -nolisten tcp' \
  node --test --test-concurrency=1 "$@" test/*.test.js
