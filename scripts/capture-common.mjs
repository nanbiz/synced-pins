// The stage the capture scripts share: a private Xvfb display with a window
// manager, a Chromium wrapper, a pointer that moves like a hand, screenshots
// and a lossless screen recording. The scripts run through
// scripts/capture-store-assets.sh, which provides the tools and the display.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { waitFor } from '../test/browser.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' });

export function createStage({ screen, scale = 1, desktopColor }) {
  const display = process.env.DISPLAY;
  if (!process.env.SYNCED_PINS_XVFB || !display) {
    throw new Error('run this through scripts/capture-store-assets.sh, which gives the browser its own Xvfb display');
  }
  const onScreen = (command, args, options = {}) => spawn(command, args, {
    env: { ...process.env, DISPLAY: display }, ...options,
  });

  // A window manager gives the windows real focus changes, which the
  // extension follows, and places them where they are asked to go.
  async function startWindowManager(workDir) {
    const ready = join(workDir, 'wm-ready');
    const wm = onScreen('openbox', ['--startup', `sh -c 'xsetroot -solid "${desktopColor}" && touch ${ready}'`], {
      stdio: 'ignore',
    });
    await waitFor(() => existsSync(ready), { timeout: 15_000 });
    return wm;
  }

  // test/browser.js starts Chromium with the flags the test suite needs; this
  // wrapper adds the ones that keep bubbles, prompts and sound out of the
  // shots, and the scale the stage is drawn at.
  function browserWrapper(workDir) {
    const chromium = run('sh', ['-c', 'command -v chromium']).trim();
    const wrapper = join(workDir, 'chromium');
    writeFileSync(wrapper, [
      '#!/bin/sh',
      `exec ${chromium} --mute-audio --lang=en-US --force-device-scale-factor=${scale} --hide-crash-restore-bubble \\`,
      '  --disable-search-engine-choice-screen --disable-features=Translate,MediaRouter,GlobalMediaControls "$@"',
      '',
    ].join('\n'));
    chmodSync(wrapper, 0o755);
    return wrapper;
  }

  async function screenshot(path) {
    mkdirSync(dirname(path), { recursive: true });
    const raw = `${path}.raw.png`;
    run('import', ['-display', display, '-window', 'root', raw]);
    run('magick', [raw, '-alpha', 'off', '-define', 'png:color-type=2', path]);
    rmSync(raw);
    console.log(`wrote ${path}`);
  }

  // Moves the pointer the way a hand does: accelerating, then settling.
  // Positions are in screen pixels.
  let pointer = { x: screen.width / 2, y: screen.height / 2 };
  async function glide(x, y, duration = 700) {
    const steps = Math.max(1, Math.round(duration / 16));
    const from = pointer;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      run('xdotool', ['mousemove', String(Math.round(from.x + (x - from.x) * eased)),
        String(Math.round(from.y + (y - from.y) * eased))]);
      await sleep(16);
    }
    pointer = { x, y };
  }

  async function click(x, y, { button = 1, duration } = {}) {
    await glide(x, y, duration);
    await sleep(250);
    run('xdotool', ['click', String(button)]);
  }

  function startRecording(path) {
    const ffmpeg = onScreen('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', '30',
      '-video_size', `${screen.width}x${screen.height}`, '-i', display,
      '-c:v', 'libx264rgb', '-preset', 'ultrafast', '-crf', '0', path,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    const exited = new Promise((resolve) => ffmpeg.once('exit', resolve));
    return async () => {
      ffmpeg.stdin.write('q');
      ffmpeg.stdin.end();
      await exited;
    };
  }

  return {
    display, startWindowManager, browserWrapper, screenshot, glide, click, startRecording,
    get pointer() { return pointer; },
  };
}
