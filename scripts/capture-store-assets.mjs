// Captures the Chrome Web Store screenshots and the README demo from a real
// headed Chromium with the extension loaded. Run it through
// scripts/capture-store-assets.sh, which provides the tools and the Xvfb display.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, launchBrowser, waitFor } from '../test/browser.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const display = process.env.DISPLAY;
if (!process.env.SYNCED_PINS_XVFB || !display) {
  throw new Error('run this through scripts/capture-store-assets.sh, which gives the browser its own Xvfb display');
}

// The screen is exactly the store's screenshot size, holding two windows side
// by side with an even gap around and between them. Positions are in DIPs,
// which equal pixels at the forced scale factor of 1.
const SCREEN = { width: 1280, height: 800 };
const GAP = 8;
const WINDOW_WIDTH = (SCREEN.width - 3 * GAP) / 2;
const WINDOW_HEIGHT = SCREEN.height - 2 * GAP;
const LEFT = { left: GAP, top: GAP, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
const RIGHT = { left: 2 * GAP + WINDOW_WIDTH, top: GAP, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
const DESKTOP_COLOR = '#c7ccd4';

// Chromium's tab strip in a restored window: the tab search button comes
// first, then the pinned tabs at a fixed pitch, all centred on this row.
const TAB_ROW_Y = 20;
const FIRST_PINNED_X = 64;
const PINNED_PITCH = 46;
// A spot on the empty part of the tab strip, which focuses the window
// without selecting a tab.
const EMPTY_STRIP_X = 505;

const ARTICLE = 'https://en.wikipedia.org/wiki/Tab_(interface)';
const PINS = [
  ARTICLE,
  'https://developer.mozilla.org/en-US/docs/Web/API/Window',
  'https://www.openstreetmap.org/#map=13/52.5200/13.4050',
  'https://github.com/zen-browser/desktop',
];
const LEFT_TABS = ['https://doc.rust-lang.org/book/', 'https://docs.python.org/3/tutorial/index.html'];
const RIGHT_TABS = ['https://nodejs.org/docs/latest/api/', 'https://www.typescriptlang.org/docs/handbook/intro.html'];

const screenshotPath = (n) => join(root, 'store', `screenshot-${n}.png`);
const demoPath = join(root, 'docs', 'demo.webp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' });
const onScreen = (command, args, options = {}) => spawn(command, args, {
  env: { ...process.env, DISPLAY: display }, ...options,
});

// A window manager gives the windows real focus changes, which the extension
// follows, and places them where they are asked to go.
async function startWindowManager(workDir) {
  const ready = join(workDir, 'wm-ready');
  const wm = onScreen('openbox', ['--startup', `sh -c 'xsetroot -solid "${DESKTOP_COLOR}" && touch ${ready}'`], {
    stdio: 'ignore',
  });
  await waitFor(() => existsSync(ready), { timeout: 15_000 });
  return wm;
}

// test/browser.js starts Chromium with the flags the test suite needs; this
// wrapper adds the ones that keep bubbles, prompts and sound out of the shots.
function browserWrapper(workDir) {
  const chromium = run('sh', ['-c', 'command -v chromium']).trim();
  const wrapper = join(workDir, 'chromium');
  writeFileSync(wrapper, [
    '#!/bin/sh',
    `exec ${chromium} --mute-audio --lang=en-US --force-device-scale-factor=1 --hide-crash-restore-bubble \\`,
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
let pointer = { x: SCREEN.width / 2, y: SCREEN.height / 2 };
async function glide(x, y, duration = 700) {
  const steps = Math.round(duration / 16);
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

async function click(x, y) {
  await glide(x, y);
  await sleep(250);
  run('xdotool', ['click', '1']);
}

// The gap between the windows, where the pointer rests over the desktop and
// raises no hover card or link highlight.
const parkPointer = () => glide(LEFT.left + LEFT.width + GAP / 2, SCREEN.height / 2);

const pinnedTab = (bounds, index) => ({
  x: bounds.left + FIRST_PINNED_X + PINNED_PITCH * index,
  y: bounds.top + TAB_ROW_Y,
});

function startRecording(path) {
  const ffmpeg = onScreen('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', '25',
    '-video_size', `${SCREEN.width}x${SCREEN.height}`, '-i', display,
    '-c:v', 'libx264rgb', '-preset', 'ultrafast', '-crf', '0', path,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const exited = new Promise((resolve) => ffmpeg.once('exit', resolve));
  return async () => {
    ffmpeg.stdin.write('q');
    ffmpeg.stdin.end();
    await exited;
  };
}

// Lossless frames: the lossy encoder leaves smudges where a changed region
// of one frame is blended over the previous one.
function encodeDemo(raw, path) {
  mkdirSync(dirname(path), { recursive: true });
  run('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', raw, '-vf', 'fps=15',
    '-c:v', 'libwebp_anim', '-lossless', '1', '-quality', '100', '-compression_level', '6', '-loop', '0', path,
  ]);
  console.log(`wrote ${path}`);
}

async function main() {
  const sandbox = await createSandbox();
  let wm;
  let browser;
  try {
    wm = await startWindowManager(sandbox.root);
    run('xdotool', ['mousemove', String(pointer.x), String(pointer.y)]);
    mkdirSync(join(sandbox.profile, 'Default'), { recursive: true });
    writeFileSync(join(sandbox.profile, 'Default', 'Preferences'), JSON.stringify({
      intl: { accept_languages: 'en-US,en' },
      browser: { has_seen_welcome_page: true },
    }));
    browser = await launchBrowser({ executable: browserWrapper(sandbox.root), sandbox, extensionPath: root });
    const worker = await browser.extensionWorker();
    await waitFor(() => worker.run(async () => (await chrome.storage.session.get('pins')).pins !== undefined),
      { timeout: 30_000 });
    await capture(browser, worker, sandbox.root);
  } finally {
    await browser?.kill();
    wm?.kill();
    await sandbox.remove();
  }
}

async function capture(browser, worker, workDir) {
  const left = await worker.run(async (bounds) => {
    const [window] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    await chrome.windows.update(window.id, bounds);
    return window.id;
  }, LEFT);
  await worker.run(async (windowId, pins, tabs) => {
    for (const url of pins) await chrome.tabs.create({ windowId, url, pinned: true, active: false });
    const [blank] = await chrome.tabs.query({ windowId, pinned: false });
    await chrome.tabs.update(blank.id, { url: tabs[0] });
    for (const url of tabs.slice(1)) await chrome.tabs.create({ windowId, url, active: false });
  }, left, PINS, LEFT_TABS);
  const right = await worker.run(async (bounds, tabs) => {
    const window = await chrome.windows.create({ url: tabs, ...bounds, focused: true });
    return window.id;
  }, RIGHT, RIGHT_TABS);
  await waitForPlaceholders(worker, right);
  await waitForPages(worker);

  // Opening scene: the article lives in the left window, read half-way down;
  // the right window shows an ordinary tab and the same pins.
  const article = await worker.run(async (url) => (await chrome.tabs.query({ url })).at(0).id, ARTICLE);
  await worker.run(async (id) => chrome.tabs.update(id, { active: true }), article);
  await worker.run(async (windowId, url) => {
    const [first] = await chrome.tabs.query({ windowId, url });
    await chrome.tabs.update(first.id, { active: true });
  }, right, RIGHT_TABS[0]);
  const articlePage = await browser.page((url) => url === ARTICLE);
  // The figure's row leaves room on its left for the article's floating
  // contents button, which covers text anywhere else.
  await articlePage.run(() => {
    document.querySelector('#History').closest('.mw-heading').nextElementSibling.nextElementSibling
      .scrollIntoView({ block: 'start' });
  });
  await focusWindow(worker, left);
  await parkPointer();
  await sleep(1500);
  await screenshot(screenshotPath(1));

  const raw = join(workDir, 'demo.mkv');
  const stopRecording = startRecording(raw);
  try {
    await demo(worker, { left, right, article });
  } finally {
    await stopRecording();
  }
  encodeDemo(raw, demoPath);
}

async function demo(worker, { left, right, article }) {
  await sleep(2500);

  // Selecting the article's placeholder in the right window brings the page
  // there, still scrolled to where it was read.
  const target = pinnedTab(RIGHT, PINS.indexOf(ARTICLE));
  await click(target.x, target.y);
  await waitFor(async () => await liveIn(worker, article, right) && showsPlaceholder(worker, left), { timeout: 10_000 });
  await sleep(300);
  await parkPointer();
  await sleep(1200);
  await screenshot(screenshotPath(2));
  await sleep(1800);

  // Switching windows without selecting a tab moves nothing.
  await click(LEFT.left + EMPTY_STRIP_X, LEFT.top + TAB_ROW_Y);
  await waitFor(() => focused(worker, left));
  await sleep(300);
  await parkPointer();
  await sleep(1800);
  await click(RIGHT.left + EMPTY_STRIP_X, RIGHT.top + TAB_ROW_Y);
  await waitFor(() => focused(worker, right));
  await sleep(300);
  await parkPointer();
  await sleep(2500);
  if (!await liveIn(worker, article, right) || !await showsPlaceholder(worker, left)) {
    throw new Error('switching windows moved the article');
  }
}

// Every placeholder has picked up its pin's title and icon.
function waitForPlaceholders(worker, windowId) {
  return waitFor(() => worker.run(async (windowId, count) => {
    const tabs = await chrome.tabs.query({ windowId, pinned: true });
    return tabs.length === count && tabs.every((tab) => tab.status === 'complete' && tab.favIconUrl?.startsWith('https:'));
  }, windowId, PINS.length), { timeout: 60_000 });
}

// Every page has loaded, carries its own title and shows its favicon.
function waitForPages(worker) {
  return waitFor(() => worker.run(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.every((tab) => tab.status === 'complete' && tab.favIconUrl?.startsWith('https:')
      && !(tab.url.startsWith('https:') && tab.url.includes(tab.title)));
  }), { timeout: 60_000, interval: 250 });
}

function focusWindow(worker, windowId) {
  return worker.run(async (id) => {
    await chrome.windows.update(id, { focused: true });
  }, windowId).then(() => waitFor(() => focused(worker, windowId)));
}

function focused(worker, windowId) {
  return worker.run(async (id) => (await chrome.windows.get(id)).focused, windowId);
}

// The tab is the live tab of its pin, selected in the given window.
function liveIn(worker, tabId, windowId) {
  return worker.run(async (id, windowId) => {
    const tab = await chrome.tabs.get(id);
    return tab.windowId === windowId && tab.active && tab.pinned;
  }, tabId, windowId);
}

function showsPlaceholder(worker, windowId) {
  return worker.run(async (windowId) => {
    const [tab] = await chrome.tabs.query({ windowId, active: true });
    return tab.pinned && tab.url.startsWith(chrome.runtime.getURL('src/placeholder.html'));
  }, windowId);
}

await main();
