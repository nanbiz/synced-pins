#!/bin/sh
# Regenerates store/screenshot-*.png and docs/demo.webp: sh scripts/capture-store-assets.sh
# With "promo" it records the store's promo video instead, dist/promo.mp4:
# sh scripts/capture-store-assets.sh promo
# Chromium runs headed on a private Xvfb display with openbox, never on the user's screen.
set -eu
cd "$(dirname "$0")/.."
if [ -z "${SYNCED_PINS_CAPTURE_TOOLS:-}" ]; then
  export SYNCED_PINS_CAPTURE_TOOLS=1
  exec nix shell nixpkgs#chromium nixpkgs#xvfb-run nixpkgs#openbox nixpkgs#xdotool \
    nixpkgs#xsetroot nixpkgs#imagemagick nixpkgs#ffmpeg-full nixpkgs#nodejs -c sh "$0" "$@"
fi
unset WAYLAND_DISPLAY DISPLAY
export SYNCED_PINS_XVFB=1
if [ "${1:-}" = promo ]; then
  shift
  exec xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24 -nolisten tcp' \
    node scripts/capture-promo.mjs "$@"
fi
exec xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  node scripts/capture-store-assets.mjs "$@"
