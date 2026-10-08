// Records the store's promo video, dist/promo.mp4, from a real headed
// Chromium with the extension loaded: two windows stacked so both tab strips
// run the full width, drawn at twice the size, one feature per scene. Each
// scene is named in a caption band from store/promo-captions.json, and every
// key press and click is shown as it happens. Run it through
// sh scripts/capture-store-assets.sh promo.
//
// With --probe it sets the windows up and saves screenshots of the context
// menus the pin and unpin scenes use to dist/probe.png and
// dist/probe-pinned.png, for finding where things are after a Chromium
// update.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, launchBrowser, waitFor } from '../test/browser.js';
import { createStage, run, sleep } from './capture-common.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const probe = process.argv.includes('--probe');

// Screen pixels are twice the DIPs Chromium places windows in.
const SCREEN = { width: 1920, height: 1080 };
const SCALE = 2;
const px = (dip) => Math.round(dip * SCALE);
const BAND = 70;
const GAP = 4;
const WINDOW_HEIGHT = (SCREEN.height / SCALE - BAND - GAP) / 2;
const TOP = { left: 0, top: BAND, width: SCREEN.width / SCALE, height: WINDOW_HEIGHT };
const BOTTOM = { left: 0, top: BAND + WINDOW_HEIGHT + GAP, width: SCREEN.width / SCALE, height: WINDOW_HEIGHT };
const DESKTOP_COLOR = '#1b1f27';

// Chromium's tab strip, in DIPs from a window's corner: the tab search button
// comes first, then the pinned tabs at a fixed pitch, all centred on this row.
const TAB_ROW_Y = 20;
const FIRST_PINNED_X = 64;
const PINNED_PITCH = 46;

const ARTICLE = 'https://en.wikipedia.org/wiki/Tab_(interface)';
const REPO = 'https://github.com/zen-browser/desktop';
const PINS = [
  ARTICLE,
  'https://developer.mozilla.org/en-US/docs/Web/API/Window',
  'https://www.openstreetmap.org/#map=13/52.5200/13.4050',
  REPO,
];
// The ordinary tab the pin scene pins and the unpin scene unpins again.
const TUTORIAL = 'https://docs.python.org/3/tutorial/index.html';
const TOP_TABS = ['https://doc.rust-lang.org/book/', TUTORIAL];
const BOTTOM_TABS = ['https://nodejs.org/docs/latest/api/', 'https://www.typescriptlang.org/docs/handbook/intro.html'];

const captions = JSON.parse(readFileSync(join(root, 'store', 'promo-captions.json'), 'utf8'));
const promoPath = join(root, 'dist', 'promo.mp4');

const stage = createStage({ screen: SCREEN, scale: SCALE, desktopColor: DESKTOP_COLOR });

const pinnedTab = (bounds, index) => ({
  x: px(bounds.left + FIRST_PINNED_X + PINNED_PITCH * index),
  y: px(bounds.top + TAB_ROW_Y),
});

// What the overlays show and when, in seconds from the start of the
// recording.
const timeline = [];
let recordingStart = 0;
const now = () => (Date.now() - recordingStart) / 1000;

function showCaption(id) {
  const open = timeline.findLast((entry) => entry.kind === 'caption' && entry.end === undefined);
  if (open) open.end = now();
  timeline.push({ kind: 'caption', id, start: now() });
}

async function click(x, y, options = {}) {
  await stage.glide(x, y, options.duration);
  await sleep(200);
  timeline.push({ kind: 'click', x, y, start: now(), end: now() + 0.6 });
  run('xdotool', ['click', String(options.button ?? 1)]);
}

async function press(keys, label) {
  timeline.push({ kind: 'key', label, start: now(), end: now() + 1.1 });
  await sleep(150);
  run('xdotool', ['key', keys]);
}

function highlight(x, y, width, height, seconds) {
  timeline.push({ kind: 'box', x, y, width, height, start: now(), end: now() + seconds });
}

// The pinned area of a window holding this many pins.
function pinnedArea(bounds, count) {
  const first = pinnedTab(bounds, 0);
  return { x: first.x - px(PINNED_PITCH / 2), y: first.y - px(17), width: px(PINNED_PITCH * count), height: px(34) };
}

async function main() {
  const sandbox = await createSandbox();
  let wm;
  let browser;
  try {
    wm = await stage.startWindowManager(sandbox.root);
    mkdirSync(join(sandbox.profile, 'Default'), { recursive: true });
    writeFileSync(join(sandbox.profile, 'Default', 'Preferences'), JSON.stringify({
      intl: { accept_languages: 'en-US,en' },
      browser: { has_seen_welcome_page: true },
    }));
    browser = await launchBrowser({ executable: stage.browserWrapper(sandbox.root), sandbox, extensionPath: root });
    const worker = await browser.extensionWorker();
    await waitFor(() => worker.run(async () => (await chrome.storage.session.get('pins')).pins !== undefined),
      { timeout: 30_000 });
    const scene = await setUp(browser, worker);
    if (probe) {
      const tutorial = await tabPosition(worker, scene.top, TUTORIAL);
      await stage.click(tutorial.x, tutorial.y, { button: 3 });
      await sleep(800);
      await stage.screenshot(join(root, 'dist', 'probe.png'));
      run('xdotool', ['key', 'Escape']);
      await worker.run(async (url) => chrome.tabs.update((await chrome.tabs.query({ url })).at(0).id, { pinned: true }), TUTORIAL);
      await waitFor(() => pinnedCount(worker, scene.bottom, PINS.length + 1), { timeout: 10_000 });
      await sleep(800);
      const pinned = pinnedTab(TOP, PINS.length);
      await stage.click(pinned.x, pinned.y, { button: 3 });
      await sleep(800);
      await stage.screenshot(join(root, 'dist', 'probe-pinned.png'));
      return;
    }
    const raw = join(sandbox.root, 'promo.mkv');
    const stopRecording = stage.startRecording(raw);
    await sleep(300);
    recordingStart = Date.now();
    try {
      await record(worker, scene);
    } finally {
      await stopRecording();
    }
    await render(raw, sandbox.root);
  } finally {
    await browser?.kill();
    wm?.kill();
    await sandbox.remove();
  }
}

// The article lives in the top window, read half-way down; the bottom window
// shows an ordinary tab and the same pins.
async function setUp(browser, worker) {
  const top = await worker.run(async (bounds) => {
    const [window] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    await chrome.windows.update(window.id, bounds);
    return window.id;
  }, TOP);
  await worker.run(async (windowId, pins, tabs) => {
    for (const url of pins) await chrome.tabs.create({ windowId, url, pinned: true, active: false });
    const [blank] = await chrome.tabs.query({ windowId, pinned: false });
    await chrome.tabs.update(blank.id, { url: tabs[0] });
    for (const url of tabs.slice(1)) await chrome.tabs.create({ windowId, url, active: false });
  }, top, PINS, TOP_TABS);
  const bottom = await worker.run(async (bounds, tabs) => (await chrome.windows.create({ url: tabs, ...bounds, focused: true })).id,
    BOTTOM, BOTTOM_TABS);
  await waitFor(() => pinnedCount(worker, bottom, PINS.length), { timeout: 30_000 });
  await waitForPages(worker);
  const article = await tabId(worker, ARTICLE);
  const repo = await tabId(worker, REPO);
  // The repository pin has wandered off to the issues before the video
  // starts, so closing it shows it going back to the repository.
  await worker.run((id, url) => chrome.tabs.update(id, { url }), repo, `${REPO}/issues`);
  await waitFor(() => worker.run(async (id) => {
    const tab = await chrome.tabs.get(id);
    return tab.status === 'complete' && /issue/i.test(tab.title);
  }, repo), { timeout: 30_000 });
  await worker.run((id) => chrome.tabs.update(id, { active: true }), article);
  const articlePage = await browser.page((url) => url === ARTICLE);
  await articlePage.run(() => document.querySelector('#History').scrollIntoView({ block: 'start' }));
  await focusWindow(worker, top);
  await stage.glide(px(TOP.width * 0.75), px(TOP.top + TOP.height * 0.6), 1);
  await sleep(1500);
  return { top, bottom, article };
}

async function record(worker, { top, bottom, article }) {
  showCaption('intro');
  await sleep(400);
  highlight(...Object.values(pinnedArea(TOP, PINS.length)), 2);
  highlight(...Object.values(pinnedArea(BOTTOM, PINS.length)), 2);
  await sleep(2200);

  showCaption('move');
  const placeholder = pinnedTab(BOTTOM, PINS.indexOf(ARTICLE));
  await click(placeholder.x, placeholder.y, { duration: 500 });
  await waitFor(() => liveIn(worker, article, bottom), { timeout: 10_000 });
  await stage.glide(px(BOTTOM.width * 0.75), px(BOTTOM.top + BOTTOM.height * 0.6), 300);
  await sleep(2000);

  // Selecting the tab before pinning it keeps the top window from selecting
  // the article's placeholder, which would bring the article back up.
  showCaption('pin');
  const tutorial = await tabPosition(worker, top, TUTORIAL);
  await click(tutorial.x, tutorial.y, { duration: 500 });
  await sleep(400);
  await click(tutorial.x, tutorial.y, { button: 3, duration: 1 });
  await choosePinItem(tutorial);
  await waitFor(() => pinnedCount(worker, bottom, PINS.length + 1), { timeout: 10_000 });
  await waitForPlaceholderIcons(worker, bottom);
  highlight(...Object.values(pinnedArea(TOP, PINS.length + 1)), 1.8);
  highlight(...Object.values(pinnedArea(BOTTOM, PINS.length + 1)), 1.8);
  await sleep(2000);

  showCaption('close');
  const repoTab = pinnedTab(TOP, PINS.indexOf(REPO));
  await click(repoTab.x, repoTab.y, { duration: 500 });
  await sleep(1100);
  // Chromium closes a pinned tab on the second Ctrl+W in a row.
  await press('ctrl+w', 'Ctrl + W');
  await sleep(450);
  await press('ctrl+w', 'Ctrl + W');
  await waitFor(() => worker.run(async (windowId, index) => {
    const tabs = await chrome.tabs.query({ windowId, pinned: true });
    return tabs[index]?.url.startsWith(chrome.runtime.getURL('src/placeholder.html'));
  }, top, PINS.indexOf(REPO)), { timeout: 10_000 });
  highlight(repoTab.x - px(PINNED_PITCH / 2), repoTab.y - px(17), px(PINNED_PITCH), px(34), 1.4);
  await sleep(1400);
  await click(repoTab.x, repoTab.y, { duration: 300 });
  await waitFor(() => worker.run(async (windowId, url) => {
    const [tab] = await chrome.tabs.query({ windowId, active: true });
    return tab.url === url && tab.status === 'complete';
  }, top, REPO), { timeout: 30_000 });
  await sleep(1500);

  showCaption('unpin');
  const pinnedTutorial = pinnedTab(TOP, PINS.length);
  await click(pinnedTutorial.x, pinnedTutorial.y, { button: 3, duration: 500 });
  await choosePinItem(pinnedTutorial);
  await waitFor(() => pinnedCount(worker, bottom, PINS.length), { timeout: 10_000 });
  await sleep(1800);

  showCaption('outro');
  await sleep(3000);
  timeline.findLast((entry) => entry.kind === 'caption').end = now();
}

// The tab context menu opens with its corner at the pointer, and Pin, or
// Unpin on a pinned tab, is its seventh item, this far down and in, in
// screen pixels; the probe screenshots show the menu.
const PIN_ITEM = { x: 150, y: 458 };

async function choosePinItem(from) {
  await sleep(400);
  await click(from.x + PIN_ITEM.x, from.y + PIN_ITEM.y, { duration: 500 });
}

// The centre of an ordinary tab in the top window's strip, in screen pixels:
// the tabs after the pinned ones share the rest of the strip.
async function tabPosition(worker, windowId, url) {
  const { index, pinnedCount: pinned, count } = await worker.run(async (windowId, url) => {
    const tabs = await chrome.tabs.query({ windowId });
    return {
      index: tabs.findIndex((tab) => tab.url === url),
      pinnedCount: tabs.filter((tab) => tab.pinned).length,
      count: tabs.length,
    };
  }, windowId, url);
  const bounds = TOP;
  const start = FIRST_PINNED_X - PINNED_PITCH / 2 + PINNED_PITCH * pinned + 8;
  const end = bounds.width - 150;
  const width = Math.min(240, (end - start) / (count - pinned));
  return { x: px(start + width * (index - pinned + 0.5)), y: px(bounds.top + TAB_ROW_Y) };
}

// Draws the overlays over the recording and encodes it the way YouTube takes
// it: H.264 in 4:2:0.
async function render(raw, workDir) {
  const inputs = [];
  const filters = [];
  let last = '0:v';
  let n = 0;
  const add = (image, x, y, start, end) => {
    n += 1;
    inputs.push('-loop', '1', '-framerate', '30', '-i', image);
    const fade = Math.min(0.2, (end - start) / 3);
    filters.push(`[${n}:v]format=rgba,fade=in:st=${start}:d=${fade}:alpha=1,fade=out:st=${end - fade}:d=${fade}:alpha=1[o${n}]`);
    filters.push(`[${last}][o${n}]overlay=x=${x}:y=${y}:shortest=1:enable='between(t,${start},${end})'[v${n}]`);
    last = `v${n}`;
  };
  const images = await drawOverlays(workDir);
  for (const entry of timeline) {
    if (entry.kind === 'caption') {
      const image = images.captions[entry.id];
      add(image.path, 0, 0, entry.start, entry.id === 'outro' ? entry.end + 1 : entry.end);
    } else if (entry.kind === 'click') {
      add(images.ring, entry.x - 45, entry.y - 45, entry.start, entry.end);
    } else if (entry.kind === 'key') {
      add(images.keys[entry.label], `(main_w-overlay_w)/2`, SCREEN.height - 190, entry.start, entry.end);
    } else if (entry.kind === 'box') {
      add(images.box(entry.width, entry.height), entry.x - 6, entry.y - 6, entry.start, entry.end);
    }
  }
  mkdirSync(dirname(promoPath), { recursive: true });
  run('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', raw, ...inputs,
    '-filter_complex', `${filters.join(';')};[${last}]fps=30,format=yuv420p[out]`, '-map', '[out]',
    // The recording runs on a moment after the closing card; the video ends
    // with the card.
    '-t', String(timeline.findLast((entry) => entry.kind === 'caption').end),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-movflags', '+faststart', promoPath,
  ]);
  console.log(`wrote ${promoPath}`);
}

// Renders each overlay as a transparent PNG with Chromium's own text
// rendering.
async function drawOverlays(workDir) {
  const dir = join(workDir, 'overlays');
  mkdirSync(dir, { recursive: true });
  const chromium = run('sh', ['-c', 'command -v chromium']).trim();
  let count = 0;
  const draw = (width, height, body, style = '') => {
    const name = `overlay-${count++}`;
    const html = join(dir, `${name}.html`);
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>
      html, body { margin: 0; background: transparent; font-family: 'Inter', 'Noto Sans', 'DejaVu Sans', sans-serif; }
      ${style}</style>${body}`);
    const png = join(dir, `${name}.png`);
    run(chromium, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      `--window-size=${width},${height}`, '--default-background-color=00000000', `--screenshot=${png}`, `file://${html}`]);
    return png;
  };
  const escape = (text) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const icon = `file://${join(root, 'icons', 'icon-128.png')}`;
  const captionImages = {};
  for (const [id, { title, subtitle }] of Object.entries(captions)) {
    if (id === 'outro') {
      captionImages[id] = { path: draw(SCREEN.width, SCREEN.height, `<div class="card">
        <img src="${icon}"><h1>${escape(title)}</h1><p>${escape(subtitle)}</p></div>`, `
        .card { width: 100vw; height: 100vh; background: ${DESKTOP_COLOR}; color: #fff; display: flex;
          flex-direction: column; align-items: center; justify-content: center; }
        img { width: 160px; height: 160px; } h1 { font-size: 96px; margin: 32px 0 12px; }
        p { font-size: 40px; color: #b8c0cc; margin: 0; }`) };
      continue;
    }
    captionImages[id] = { path: draw(SCREEN.width, px(BAND), `<div class="band">
      <img src="${icon}"><div><h1>${escape(title)}</h1><p>${escape(subtitle)}</p></div></div>`, `
      .band { height: ${px(BAND)}px; background: ${DESKTOP_COLOR}; color: #fff; display: flex; align-items: center;
        gap: 28px; padding: 0 44px; box-sizing: border-box; }
      img { width: 84px; height: 84px; } h1 { font-size: 46px; margin: 0; line-height: 1.15; }
      p { font-size: 30px; margin: 4px 0 0; color: #b8c0cc; }`) };
  }
  const keys = {};
  for (const label of new Set(timeline.filter((entry) => entry.kind === 'key').map((entry) => entry.label))) {
    keys[label] = draw(420, 120, `<div class="key">${escape(label)}</div>`, `
      body { display: flex; align-items: center; justify-content: center; height: 120px; }
      .key { font-size: 54px; font-weight: 600; color: #fff; background: rgba(20, 24, 32, 0.88);
        border: 3px solid #6aa0ff; border-radius: 22px; padding: 10px 34px; }`);
  }
  const ring = draw(90, 90, '<div class="ring"></div>', `
    .ring { width: 70px; height: 70px; margin: 10px; border-radius: 50%; border: 6px solid #ff9f1c;
      box-sizing: border-box; background: rgba(255, 159, 28, 0.25); }`);
  const boxes = new Map();
  const box = (width, height) => {
    const key = `${width}x${height}`;
    if (!boxes.has(key)) {
      boxes.set(key, draw(width + 12, height + 12, '<div class="box"></div>', `
        .box { width: ${width + 12}px; height: ${height + 12}px; border: 5px solid #ff9f1c; border-radius: 16px;
          box-sizing: border-box; }`));
    }
    return boxes.get(key);
  };
  // Boxes are drawn on demand from the timeline, so they are made here.
  for (const entry of timeline.filter((candidate) => candidate.kind === 'box')) box(entry.width, entry.height);
  return { captions: captionImages, keys, ring, box };
}

// Every placeholder in the window shows its pin's icon.
function waitForPlaceholderIcons(worker, windowId) {
  return waitFor(() => worker.run(async (windowId) => (await chrome.tabs.query({ windowId, pinned: true }))
    .every((tab) => tab.status === 'complete' && tab.favIconUrl), windowId), { timeout: 10_000, interval: 100 });
}

function tabId(worker, url) {
  return worker.run(async (url) => (await chrome.tabs.query({ url })).at(0).id, url);
}

function pinnedCount(worker, windowId, count) {
  return worker.run(async (windowId, count) => (await chrome.tabs.query({ windowId, pinned: true })).length === count,
    windowId, count);
}

// Every page has loaded, carries its own title and shows its favicon, a
// placeholder the one from the browser's favicon store.
function waitForPages(worker) {
  return waitFor(() => worker.run(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.every((tab) => tab.status === 'complete' && /^(https|chrome-extension):/.test(tab.favIconUrl ?? '')
      && !(tab.url.startsWith('https:') && tab.url.includes(tab.title)));
  }), { timeout: 60_000, interval: 250 });
}

function focusWindow(worker, windowId) {
  return worker.run((id) => chrome.windows.update(id, { focused: true }), windowId)
    .then(() => waitFor(() => worker.run(async (id) => (await chrome.windows.get(id)).focused, windowId)));
}

// The tab is the live tab of its pin, selected in the given window.
function liveIn(worker, tabId, windowId) {
  return worker.run(async (id, windowId) => {
    const tab = await chrome.tabs.get(id);
    return tab.windowId === windowId && tab.active && tab.pinned;
  }, tabId, windowId);
}

await main();
