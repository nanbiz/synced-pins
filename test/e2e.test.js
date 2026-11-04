import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSandbox, findBrowserExecutable, launchBrowser, waitFor } from './browser.js';

const extensionPath = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(extensionPath, 'test', 'fixture-extension');
const executable = findBrowserExecutable();
const skip = executable ? false : 'no browser: set CHROME_PATH or put chromium on PATH';

// Starting a browser and its extension worker takes several seconds on a busy
// machine.
const STARTUP_TIMEOUT_MS = 30_000;

// The pages pinned in the tests: every path is a page titled after itself.
// A page whose name starts with "iconic" has an icon that, as on claude.ai,
// only the site's own pages may load.
const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4o6FBEmIY1TCqYfhqAAAyBCwQhvh37QAAAABJRU5ErkJggg==', 'base64');
const server = createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1));
  if (name === 'icon.png') {
    response.writeHead(200, { 'content-type': 'image/png', 'cross-origin-resource-policy': 'same-origin' });
    response.end(ICON);
    return;
  }
  const icon = name.startsWith('iconic') ? '<link rel="icon" href="/icon.png">' : '';
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>${name}</title>${icon}<h1>${name}</h1>`);
});
let origin;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
// A browser process that outlives its kill, as Vivaldi's can, holds a
// keep-alive connection open, which would keep the server and so the test run
// from ending.
after(() => {
  server.closeAllConnections();
  server.close();
  // Whatever still holds the process open once every test has ended, which
  // scripts/test-e2e.sh then ends with --test-force-exit.
  setTimeout(() => {
    const open = process.getActiveResourcesInfo().filter((name) => name !== 'TTYWrap');
    if (open.length > 0) console.log(`# still open after the tests: ${open.join(', ')}`);
  }, 2000).unref();
});

const pageUrl = (name) => `${origin}/${name}`;

// Runs one browser, on a fresh profile unless a sandbox is handed back in for
// a restart. Developer mode is on so the unpacked extension survives
// chrome.runtime.reload(). On restart the profile reopens its last session
// when restoreSession is set and otherwise follows Chromium's default of
// opening a New Tab page.
async function start({ restoreSession = false, sandbox, extension = extensionPath, keepSetup = false } = {}) {
  const fresh = !sandbox;
  if (fresh) {
    sandbox = await createSandbox();
    await mkdir(join(sandbox.profile, 'Default'), { recursive: true });
    await writeFile(join(sandbox.profile, 'Default', 'Preferences'), JSON.stringify({
      extensions: { ui: { developer_mode: true } },
      session: { restore_on_startup: restoreSession ? 1 : 5 },
      // Brave asks before closing a window with several tabs and Edge before
      // closing one with pinned tabs, which holds up chrome.windows.remove
      // until someone answers.
      brave: { enable_window_closing_confirm: false },
      browser: { edge_show_warn_before_closing_window_with_pinned_tabs_prompt: false },
    }));
  }
  let browser;
  try {
    browser = await launchBrowser({ executable, sandbox, extensionPath: extension });
    const worker = extension === extensionPath
      ? await readyWorker(browser)
      : await browser.extensionWorker();
    if (extension === extensionPath && fresh && !keepSetup) await closeSetup(worker);
    return { sandbox, browser, worker };
  } catch (error) {
    await browser?.kill();
    if (fresh) await sandbox.remove();
    throw error;
  }
}

// The page the extension opens once after installation, closed so the
// windows hold only what a test opens.
async function closeSetup(worker) {
  await waitFor(() => worker.run(async () => (await chrome.storage.local.get('setupPending')).setupPending === false),
    { timeout: STARTUP_TIMEOUT_MS });
  await worker.run(async () => {
    const page = chrome.runtime.getURL('src/welcome.html');
    const tabs = (await chrome.tabs.query({})).filter((tab) => (tab.pendingUrl || tab.url).startsWith(page));
    if (tabs.length > 0) await chrome.tabs.remove(tabs.map((tab) => tab.id));
  });
}

// The extension's worker once it has built its pin list. After a reload the
// previous worker is gone, so a failing context is looked up afresh.
function readyWorker(browser) {
  return waitFor(async () => {
    try {
      const worker = await browser.extensionWorker();
      await waitFor(() => worker.run(async () => (await chrome.storage.session.get('pins')).pins !== undefined));
      return worker;
    } catch {
      return false;
    }
  }, { timeout: STARTUP_TIMEOUT_MS });
}

let current;
afterEach(async () => {
  await current?.browser.kill();
  await current?.sandbox.remove();
  current = undefined;
});

async function open(options) {
  current = await start(options);
  return current;
}

// Quits the browser the way the user does and starts it again on the same
// profile.
async function restart(options) {
  await current.browser.quit();
  current = await start({ ...options, sandbox: current.sandbox });
  return current;
}

// Every normal window with its tabs; placeholders are described by the pin
// title they stand for.
function layout(worker) {
  return worker.run(async (placeholderPrefix) => {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    return windows.map((window) => ({
      id: window.id,
      tabs: window.tabs.map((tab) => {
        const url = tab.pendingUrl || tab.url;
        const placeholder = url.startsWith(placeholderPrefix)
          ? new URLSearchParams(url.slice(placeholderPrefix.length)).get('title') : null;
        return { id: tab.id, pinned: tab.pinned, active: tab.active, url, title: tab.title, placeholder };
      }),
    }));
  }, `chrome-extension://${current.browser.extensionOrigin.split('//')[1]}/src/placeholder.html?`);
}

// The pinned area of a window written as e.g. ['a', '~b']: a live pin shows
// its page title, a placeholder its pin title after a tilde.
function pinnedArea(window) {
  return window.tabs.filter((tab) => tab.pinned)
    .map((tab) => (tab.placeholder !== null ? `~${tab.placeholder}` : tab.title));
}

async function pinnedAreas(worker, windowIds) {
  const windows = await layout(worker);
  return windowIds.map((id) => pinnedArea(windows.find((window) => window.id === id) ?? { tabs: [] }));
}

// The pinned areas of all normal windows, sorted so that the comparison does
// not depend on window ids, which change across a restart.
async function allPinnedAreas(worker) {
  return (await layout(worker)).map(pinnedArea).map((area) => JSON.stringify(area)).sort();
}

async function expectPinnedAreas(worker, windowIds, expected) {
  let actual;
  try {
    await waitFor(async () => {
      actual = await pinnedAreas(worker, windowIds);
      return JSON.stringify(actual) === JSON.stringify(expected);
    });
  } catch {
    assert.deepEqual(actual, expected);
  }
}

function createWindow(worker, name, options = {}) {
  return worker.run(async (url, options) => (await chrome.windows.create({ url, focused: true, ...options })).id,
    pageUrl(name), options);
}

// Vivaldi ignores the pinned property of chrome.tabs.create, so a tab to be
// pinned is pinned once open, as the user pins one.
function openTab(worker, windowId, name, { pinned = false, ...properties } = {}) {
  return worker.run(async (windowId, url, pinned, properties) => {
    const tab = await chrome.tabs.create({ windowId, url, ...properties });
    if (pinned) await chrome.tabs.update(tab.id, { pinned: true });
    return tab.id;
  }, windowId, pageUrl(name), pinned, properties);
}

async function tabIdByTitle(worker, windowId, title, { placeholder = false } = {}) {
  const window = (await layout(worker)).find((candidate) => candidate.id === windowId);
  return window.tabs.find((tab) => (placeholder ? tab.placeholder === title : tab.placeholder === null && tab.title === title))?.id;
}

async function waitForTitle(worker, tabId, title) {
  await waitFor(() => worker.run(async (id, title) => (await chrome.tabs.get(id)).title === title, tabId, title));
}

// Three normal windows with pin 'a' live in the first and 'b' pinned after
// it, placeholders everywhere else.
async function threeWindowsWithPins(worker) {
  const windows = [
    await createWindow(worker, 'A'),
    await createWindow(worker, 'B'),
    await createWindow(worker, 'C'),
  ];
  const a = await openTab(worker, windows[0], 'a', { pinned: true, active: false });
  await waitForTitle(worker, a, 'a');
  const b = await openTab(worker, windows[0], 'b', { pinned: true, active: false });
  await waitForTitle(worker, b, 'b');
  await expectPinnedAreas(worker, windows, [['a', 'b'], ['~a', '~b'], ['~a', '~b']]);
  return { windows, a, b };
}

// Placeholder pages of one pin share a URL, so the page is told apart by the
// tab it reports for itself.
async function placeholderPage(browser, tabId) {
  for (const target of await browser.targets()) {
    if (target.type !== 'page' || !target.url.includes('/src/placeholder.html')) continue;
    const page = await browser.attach(target.targetId);
    if (await page.run(async () => (await chrome.tabs.getCurrent()).id) === tabId) return page;
  }
  throw new Error(`no placeholder page in tab ${tabId}`);
}

function select(worker, tabId) {
  return worker.run((id) => chrome.tabs.update(id, { active: true }), tabId);
}

function focus(worker, windowId) {
  return worker.run((id) => chrome.windows.update(id, { focused: true }), windowId);
}

// The titles of the pins stored for the next browser start, in order.
async function storedTitles(worker) {
  return worker.run(async () => ((await chrome.storage.local.get('pins')).pins ?? []).map((pin) => pin.title));
}

async function waitForStoredTitles(worker, expected) {
  let actual;
  await waitFor(async () => {
    actual = await storedTitles(worker);
    return actual.join() === expected.join();
  }).catch(() => assert.deepEqual(actual, expected));
}

// Quits and starts again on the same profile with nothing reopened: Chromium
// reopens the pinned tabs it lists in Preferences even without session
// restore, and a browser after a crash, or Edge, starts without them.
async function restartWithoutTabs() {
  const { sandbox } = current;
  await current.browser.quit();
  const preferences = join(sandbox.profile, 'Default', 'Preferences');
  const { pinned_tabs: _, ...rest } = JSON.parse(await readFile(preferences, 'utf8'));
  await writeFile(preferences, JSON.stringify(rest));
  current = await start({ sandbox });
  return current;
}

// The pinned areas of all windows once they show the expected ones, in any
// window order.
async function expectAllPinnedAreas(worker, expected) {
  const want = expected.map((area) => JSON.stringify(area)).sort();
  let actual;
  await waitFor(async () => {
    actual = await allPinnedAreas(worker);
    return JSON.stringify(actual) === JSON.stringify(want);
  }).catch(() => assert.deepEqual(actual, want));
}

function liveWindowOf(worker, tabId) {
  return worker.run(async (id) => (await chrome.tabs.get(id)).windowId, tabId);
}

// Presses Ctrl+Shift+T in the window, on its page of this name, the way the
// user reopens the tab closed last, and waits for the tab to open. Vivaldi
// now and then drops the key press, even in a focused window, so a press
// that opens nothing is repeated.
async function reopenClosedTab(browser, worker, windowId, name) {
  await focus(worker, windowId);
  await select(worker, await tabIdByTitle(worker, windowId, name));
  await waitFor(() => worker.run(async (id) => (await chrome.windows.get(id)).focused, windowId));
  const page = await browser.page(pageUrl(name));
  await worker.run(() => {
    globalThis.reopened = false;
    chrome.tabs.onCreated.addListener(function listener() {
      globalThis.reopened = true;
      chrome.tabs.onCreated.removeListener(listener);
    });
  });
  for (let attempt = 1; ; attempt++) {
    await page.press('T', { ctrl: true, shift: true, wait: false });
    try {
      return await waitFor(() => worker.run(() => globalThis.reopened), { timeout: 5_000 });
    } catch (error) {
      if (attempt === 3 || error instanceof NoOverlayInPage) throw error;
    }
  }
}

// Every window shows the pins in this order, and each pin is live in exactly
// one of them.
async function expectEachPinOnce(worker, titles) {
  let areas;
  await waitFor(async () => {
    areas = (await layout(worker)).map(pinnedArea);
    const live = areas.flat().filter((title) => !title.startsWith('~')).sort();
    return areas.every((area) => area.map((title) => title.replace('~', '')).join() === titles.join())
      && live.join() === [...titles].sort().join();
  }).catch(() => assert.fail(`pinned areas: ${JSON.stringify(areas)}`));
}

describe('synced pins', { skip, concurrency: 1 }, () => {
  test('pinning a tab in one window adds its placeholder to the others', async () => {
    const { worker } = await open();
    await threeWindowsWithPins(worker);
  });

  test('selecting a placeholder with Ctrl+1 brings the same live page and leaves a placeholder behind', async () => {
    const { worker, browser } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    const page = await browser.page(pageUrl('a'));
    await page.run(() => { window.typed = 'kept'; });
    await focus(worker, B);
    await (await browser.page(pageUrl('B'))).press('1', { ctrl: true });
    await expectPinnedAreas(worker, [A, B, C], [['~a', 'b'], ['a', '~b'], ['~a', '~b']]);
    assert.equal(await liveWindowOf(worker, a), B);
    assert.equal(await (await browser.page(pageUrl('a'))).run(() => window.typed), 'kept');
    const selected = (await layout(worker)).find((window) => window.id === B).tabs.find((tab) => tab.active);
    assert.equal(selected.id, a);
  });

  test('switching windows alone moves nothing', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    for (const windowId of [B, C, A, C]) {
      await focus(worker, windowId);
      await waitFor(() => worker.run(async (id) => (await chrome.storage.session.get('focusOrder')).focusOrder[0] === id, windowId));
    }
    await expectPinnedAreas(worker, [A, B, C], [['a', 'b'], ['~a', '~b'], ['~a', '~b']]);
    assert.equal(await liveWindowOf(worker, a), A);
  });

  test('a pin shown in two windows stays in the one focused more recently', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    await select(worker, a);
    await focus(worker, B);
    await focus(worker, A);
    await focus(worker, C);
    await select(worker, await tabIdByTitle(worker, B, 'a', { placeholder: true }));
    await expectPinnedAreas(worker, [A, B, C], [['a', 'b'], ['~a', '~b'], ['~a', '~b']]);
    assert.equal(await liveWindowOf(worker, a), A);
  });

  test('focusing a window that shows a placeholder brings its pin there', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    await select(worker, a);
    await focus(worker, B);
    await select(worker, await tabIdByTitle(worker, B, 'a', { placeholder: true }));
    await expectPinnedAreas(worker, [A, B, C], [['~a', 'b'], ['a', '~b'], ['~a', '~b']]);
    await focus(worker, A);
    await expectPinnedAreas(worker, [A, B, C], [['a', 'b'], ['~a', '~b'], ['~a', '~b']]);
    assert.equal(await liveWindowOf(worker, a), A);
  });

  test('a pin left behind returns to the background window still showing it', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    await select(worker, a);
    await focus(worker, B);
    await select(worker, await tabIdByTitle(worker, B, 'a', { placeholder: true }));
    await expectPinnedAreas(worker, [A, B, C], [['~a', 'b'], ['a', '~b'], ['~a', '~b']]);
    await select(worker, await tabIdByTitle(worker, B, 'B'));
    await expectPinnedAreas(worker, [A, B, C], [['a', 'b'], ['~a', '~b'], ['~a', '~b']]);
    assert.equal(await liveWindowOf(worker, a), A);
  });

  test('the old window selects the placeholder only when the live tab was selected there', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], a, b } = await threeWindowsWithPins(worker);
    await select(worker, a);
    await focus(worker, B);
    await select(worker, await tabIdByTitle(worker, B, 'a', { placeholder: true }));
    await expectPinnedAreas(worker, [A, B, C], [['~a', 'b'], ['a', '~b'], ['~a', '~b']]);
    const activeIn = async (windowId) => (await layout(worker)).find((window) => window.id === windowId).tabs.find((tab) => tab.active);
    await waitFor(async () => (await activeIn(A)).placeholder === 'a');
    const pageA = await tabIdByTitle(worker, A, 'A');
    await select(worker, pageA);
    await focus(worker, C);
    await select(worker, await tabIdByTitle(worker, C, 'b', { placeholder: true }));
    await expectPinnedAreas(worker, [A, B, C], [['~a', '~b'], ['a', '~b'], ['~a', 'b']]);
    await waitFor(async () => (await activeIn(C)).title === 'b');
    assert.equal((await activeIn(A)).id, pageA);
    assert.equal(await liveWindowOf(worker, b), C);
  });

  test('the button on a placeholder in a window focused less recently brings its pin there', async () => {
    const { worker, browser } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    await select(worker, a);
    await focus(worker, A);
    await waitFor(() => worker.run(async (id) => (await chrome.storage.session.get('focusOrder')).focusOrder[0] === id, A));
    const shown = await tabIdByTitle(worker, C, 'a', { placeholder: true });
    await select(worker, shown);
    // Vivaldi delivers no input events to a window without focus, and giving
    // C focus would bring the pin by itself, so the button is pressed from
    // inside the page.
    await (await placeholderPage(browser, shown)).run(() => document.getElementById('summon').click());
    await expectPinnedAreas(worker, [A, B, C], [['~a', 'b'], ['~a', '~b'], ['a', '~b']]);
    const tab = await worker.run((id) => chrome.tabs.get(id), a);
    assert.equal(tab.windowId, C);
    assert.equal(tab.active, true);
  });

  test('unpinning the live tab ends the pin', async () => {
    const { worker } = await open();
    const { windows, a } = await threeWindowsWithPins(worker);
    await worker.run((id) => chrome.tabs.update(id, { pinned: false }), a);
    await expectPinnedAreas(worker, windows, [['b'], ['~b'], ['~b']]);
    assert.equal(await liveWindowOf(worker, a), windows[0]);
  });

  test('unpinning a placeholder brings the live tab there unpinned and ends the pin', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    await worker.run((id) => chrome.tabs.update(id, { pinned: false }), await tabIdByTitle(worker, B, 'a', { placeholder: true }));
    await expectPinnedAreas(worker, [A, B, C], [['b'], ['~b'], ['~b']]);
    const tab = await worker.run((id) => chrome.tabs.get(id), a);
    assert.equal(tab.windowId, B);
    assert.equal(tab.pinned, false);
    assert.equal(tab.index, 1);
  });

  test('putting the live tab into a tab group lets the page go with it and keeps the pin', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    await worker.run((id, url) => chrome.tabs.update(id, { url }), a, pageUrl('a2'));
    await expectPinnedAreas(worker, [A, B, C], [['a2', 'b'], ['~a2', '~b'], ['~a2', '~b']]);
    await focus(worker, A);
    await worker.run((id) => chrome.tabs.group({ tabIds: [id] }), a);
    await expectPinnedAreas(worker, [A, B, C], [['~a', 'b'], ['~a', '~b'], ['~a', '~b']]);
    const grouped = await worker.run((id) => chrome.tabs.get(id), a);
    assert.equal(grouped.windowId, A);
    assert.equal(grouped.pinned, false);
    assert.notEqual(grouped.groupId, -1);
    assert.equal(grouped.url, pageUrl('a2'));
    await worker.run((id) => chrome.tabs.update(id, { pinned: true }), a);
    await expectPinnedAreas(worker, [A, B, C], [['a2', 'b'], ['~a2', '~b'], ['~a2', '~b']]);
  });

  test('closing the live tab unloads the pin, which loads the page it was pinned at when selected', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    await worker.run((id, url) => chrome.tabs.update(id, { url }), a, pageUrl('a2'));
    await expectPinnedAreas(worker, [A, B, C], [['a2', 'b'], ['~a2', '~b'], ['~a2', '~b']]);
    await focus(worker, A);
    await worker.run((id) => chrome.tabs.remove(id), a);
    await expectPinnedAreas(worker, [A, B, C], [['~a', 'b'], ['~a', '~b'], ['~a', '~b']]);
    const unloaded = await tabIdByTitle(worker, A, 'a', { placeholder: true });
    await select(worker, unloaded);
    // The placeholder carries the pin's title too, so the page is told by its
    // address.
    await waitFor(() => worker.run(async (id, url) => (await chrome.tabs.get(id)).url === url, unloaded, pageUrl('a')));
    await expectPinnedAreas(worker, [A, B, C], [['a', 'b'], ['~a', '~b'], ['~a', '~b']]);
  });

  test('a pin unloaded from its live tab keeps its place among the pins', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], b } = await threeWindowsWithPins(worker);
    await worker.run((id) => chrome.tabs.remove(id), b);
    await expectPinnedAreas(worker, [A, B, C], [['a', '~b'], ['~a', '~b'], ['~a', '~b']]);
    await focus(worker, B);
    await expectPinnedAreas(worker, [A, B, C], [['a', '~b'], ['~a', '~b'], ['~a', '~b']]);
  });

  test('closing a placeholder unloads the pin everywhere, and selecting it loads it there', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], b } = await threeWindowsWithPins(worker);
    await focus(worker, C);
    await worker.run((id) => chrome.tabs.remove(id), await tabIdByTitle(worker, C, 'b', { placeholder: true }));
    await expectPinnedAreas(worker, [A, B, C], [['a', '~b'], ['~a', '~b'], ['~a', '~b']]);
    assert.equal(await liveWindowOf(worker, b), A);
    const placeholder = await tabIdByTitle(worker, C, 'b', { placeholder: true });
    await select(worker, placeholder);
    await waitFor(() => worker.run(async (id, url) => (await chrome.tabs.get(id)).url === url, placeholder, pageUrl('b')));
    await expectPinnedAreas(worker, [A, B, C], [['a', '~b'], ['~a', '~b'], ['~a', 'b']]);
  });

  test('a pin selected in a window in the background stays unloaded', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], b } = await threeWindowsWithPins(worker);
    await select(worker, b);
    await focus(worker, C);
    await worker.run((id) => chrome.tabs.remove(id), await tabIdByTitle(worker, C, 'b', { placeholder: true }));
    await expectPinnedAreas(worker, [A, B, C], [['a', '~b'], ['~a', '~b'], ['~a', '~b']]);
    await focus(worker, B);
    await focus(worker, C);
    await expectPinnedAreas(worker, [A, B, C], [['a', '~b'], ['~a', '~b'], ['~a', '~b']]);
    await focus(worker, A);
    await waitForTitle(worker, b, 'b');
    await expectPinnedAreas(worker, [A, B, C], [['a', 'b'], ['~a', '~b'], ['~a', '~b']]);
  });

  test('reordering pins in one window reorders them everywhere', async () => {
    const { worker } = await open();
    const { windows: [A, B, C] } = await threeWindowsWithPins(worker);
    await worker.run((id) => chrome.tabs.move(id, { index: 0 }), await tabIdByTitle(worker, B, 'b', { placeholder: true }));
    await expectPinnedAreas(worker, [A, B, C], [['b', 'a'], ['~b', '~a'], ['~b', '~a']]);
  });

  test('a new window gets placeholders for all pins', async () => {
    const { worker } = await open();
    const { windows } = await threeWindowsWithPins(worker);
    const D = await createWindow(worker, 'D');
    await expectPinnedAreas(worker, [...windows, D], [['a', 'b'], ['~a', '~b'], ['~a', '~b'], ['~a', '~b']]);
  });

  test('closing the window holding a live tab brings it back in the last focused window', async () => {
    const { worker } = await open();
    const { windows: [A, B, C] } = await threeWindowsWithPins(worker);
    await select(worker, await tabIdByTitle(worker, B, 'b', { placeholder: true }));
    await expectPinnedAreas(worker, [A, B, C], [['a', '~b'], ['~a', 'b'], ['~a', '~b']]);
    for (const windowId of [C, B, A]) {
      await focus(worker, windowId);
      await waitFor(() => worker.run(async (id) => (await chrome.storage.session.get('focusOrder')).focusOrder[0] === id, windowId));
    }
    await worker.run((id) => chrome.windows.remove(id), A);
    await expectPinnedAreas(worker, [B, C], [['a', 'b'], ['~a', '~b']]);
    // The tab shows the placeholder's title until its page commits.
    await waitFor(async () => (await layout(worker)).find((window) => window.id === B).tabs
      .some((tab) => tab.pinned && tab.url === pageUrl('a') && tab.title === 'a'));
  });

  test('a title change of the live tab reaches its placeholders', async () => {
    const { worker, browser } = await open();
    const { windows: [A, B] } = await threeWindowsWithPins(worker);
    await (await browser.page(pageUrl('a'))).run(() => { document.title = 'renamed'; });
    const placeholder = await tabIdByTitle(worker, B, 'a', { placeholder: true });
    await waitForTitle(worker, placeholder, 'renamed');
    await expectPinnedAreas(worker, [A, B], [['renamed', 'b'], ['~renamed', '~b']]);
  });

  test('popup windows are left alone', async () => {
    const { worker } = await open();
    const { windows } = await threeWindowsWithPins(worker);
    const popup = await createWindow(worker, 'popup', { type: 'popup' });
    const popupTab = (await worker.run((id) => chrome.tabs.query({ windowId: id }), popup))[0];
    await worker.run((id) => chrome.tabs.update(id, { pinned: true }).catch(() => {}), popupTab.id);
    const D = await createWindow(worker, 'D');
    await expectPinnedAreas(worker, [...windows, D], [['a', 'b'], ['~a', '~b'], ['~a', '~b'], ['~a', '~b']]);
    const popupTabs = await worker.run((id) => chrome.tabs.query({ windowId: id }), popup);
    assert.deepEqual(popupTabs.map((tab) => tab.id), [popupTab.id]);
  });

  test('install gathers pins from several windows and merges duplicate pages', async () => {
    const { worker } = await open({ restoreSession: true, extension: fixturePath });
    await worker.run(async (x, y, z) => {
      const pin = async (windowId, url) => chrome.tabs.update((await chrome.tabs.create({ windowId, url })).id, { pinned: true });
      const first = await chrome.windows.create({ url: 'about:blank#first' });
      const second = await chrome.windows.create({ url: 'about:blank#second' });
      await pin(first.id, x);
      await pin(first.id, y);
      await pin(second.id, `${x}#fragment`);
      await pin(second.id, z);
    }, pageUrl('x'), pageUrl('y'), pageUrl('z'));
    await waitFor(async () => (await current.browser.targets()).filter((target) => target.title === 'x').length === 2);
    const { worker: synced } = await restart({ extension: extensionPath });
    let areas;
    await waitFor(async () => {
      areas = (await layout(synced)).map(pinnedArea);
      const live = areas.flat().filter((title) => !title.startsWith('~'));
      const orders = new Set(areas.map((area) => area.map((title) => title.replace('~', '')).join()));
      return live.length === 3 && new Set(live).size === 3 && orders.size === 1
        && [...orders][0].split(',').sort().join() === 'x,y,z';
    }).catch(async () => {
      // The pin list tells a pin dropped from the list from one the windows
      // only fail to show.
      const pins = await synced.run(async () => ({
        session: (await chrome.storage.session.get('pins')).pins?.map(({ title, url, tabId, closed }) => ({ title, url, tabId, closed: !!closed })),
        stored: (await chrome.storage.local.get('pins')).pins?.map(({ title, url }) => ({ title, url })),
      }));
      assert.fail(`pinned areas after install: ${JSON.stringify(areas)}\npins: ${JSON.stringify(pins)}`);
    });
  });

  test('a restart on the same profile restores every pin once', async () => {
    const { worker } = await open({ restoreSession: true });
    await threeWindowsWithPins(worker);
    await select(worker, (await layout(worker)).flatMap((window) => window.tabs).find((tab) => tab.placeholder === 'b').id);
    // The window now showing b's placeholder takes b, even in the background.
    await waitFor(async () => (await allPinnedAreas(worker)).includes('["~a","b"]'));
    const before = await allPinnedAreas(worker);
    const { worker: restarted } = await restart();
    let after;
    await waitFor(async () => {
      after = await allPinnedAreas(restarted);
      return JSON.stringify(after) === JSON.stringify(before);
    }).catch(() => assert.deepEqual(after, before));
  });

  test('a restart without session restore keeps each pin once', async () => {
    const { worker } = await open();
    await threeWindowsWithPins(worker);
    await waitForStoredTitles(worker, ['a', 'b']);
    // Chromium reopens the pinned tabs it listed in Preferences on quitting,
    // even without session restore; Edge lists none. Either way each pin is
    // there once.
    const { worker: restarted } = await restart();
    await waitFor(async () => {
      const areas = (await layout(restarted)).map(pinnedArea);
      return areas.some((area) => area.join() === 'a,b')
        && areas.every((area) => ['a,b', '~a,~b'].includes(area.join()));
    });
  });

  test('pins come back after a restart that reopens none of their tabs', async () => {
    const { worker } = await open();
    await threeWindowsWithPins(worker);
    await waitForStoredTitles(worker, ['a', 'b']);
    const { worker: restarted } = await restartWithoutTabs();
    await expectAllPinnedAreas(restarted, [['a', 'b']]);
    const urls = (await layout(restarted)).flatMap((window) => window.tabs).filter((tab) => tab.pinned).map((tab) => tab.url);
    assert.deepEqual(urls, [pageUrl('a'), pageUrl('b')]);
  });

  test('a pin unpinned before quitting stays gone', async () => {
    const { worker } = await open();
    const { windows, a } = await threeWindowsWithPins(worker);
    await worker.run((id) => chrome.tabs.update(id, { pinned: false }), a);
    await expectPinnedAreas(worker, windows, [['b'], ['~b'], ['~b']]);
    await waitForStoredTitles(worker, ['b']);
    const { worker: restarted } = await restartWithoutTabs();
    await expectAllPinnedAreas(restarted, [['b']]);
  });

  test('pins come back in the order they had', async () => {
    const { worker } = await open();
    const { windows: [A, B, C] } = await threeWindowsWithPins(worker);
    const c = await openTab(worker, A, 'c', { pinned: true, active: false });
    await waitForTitle(worker, c, 'c');
    await expectPinnedAreas(worker, [A, B, C], [['a', 'b', 'c'], ['~a', '~b', '~c'], ['~a', '~b', '~c']]);
    await worker.run((id) => chrome.tabs.move(id, { index: 0 }), await tabIdByTitle(worker, B, 'c', { placeholder: true }));
    await expectPinnedAreas(worker, [A, B, C], [['c', 'a', 'b'], ['~c', '~a', '~b'], ['~c', '~a', '~b']]);
    await waitForStoredTitles(worker, ['c', 'a', 'b']);
    const { worker: restarted } = await restartWithoutTabs();
    await expectAllPinnedAreas(restarted, [['c', 'a', 'b']]);
  });

  test('a session restored after the pins came back merges into one tab per pin', async () => {
    const { worker } = await open();
    await threeWindowsWithPins(worker);
    await waitForStoredTitles(worker, ['a', 'b']);
    const { worker: restarted } = await restartWithoutTabs();
    await expectAllPinnedAreas(restarted, [['a', 'b']]);
    const [first] = await layout(restarted);
    const recreated = first.tabs.find((tab) => tab.pinned && tab.title === 'a').id;
    // A late restore, as after a crash, opens the old window with its pinned
    // tab, whose address may carry a fragment.
    const restored = await restarted.run(async (url) => {
      const window = await chrome.windows.create({ url, focused: true });
      return (await chrome.tabs.update(window.tabs[0].id, { pinned: true })).id;
    }, `${pageUrl('a')}#restored`);
    await expectPinnedAreas(restarted, [first.id], [['~a', 'b']]);
    await expectAllPinnedAreas(restarted, [['~a', 'b'], ['a', '~b']]);
    assert.equal(await restarted.run((id) => chrome.tabs.get(id).then(() => true, () => false), recreated), false);
    assert.equal((await restarted.run((id) => chrome.tabs.get(id), restored)).pinned, true);
    await waitForStoredTitles(restarted, ['a', 'b']);
  });

  test('reopening the live tab of a pin it unloaded brings its page back', async () => {
    const { worker, browser } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    await worker.run((id, url) => chrome.tabs.update(id, { url }), a, pageUrl('a2'));
    await expectPinnedAreas(worker, [A, B, C], [['a2', 'b'], ['~a2', '~b'], ['~a2', '~b']]);
    await worker.run((id) => chrome.tabs.remove(id), a);
    await expectPinnedAreas(worker, [A, B, C], [['~a', 'b'], ['~a', '~b'], ['~a', '~b']]);
    await reopenClosedTab(browser, worker, A, 'A');
    await expectPinnedAreas(worker, [A, B, C], [['a2', 'b'], ['~a2', '~b'], ['~a2', '~b']]);
  });

  test('reopening a placeholder that unloaded its pin loads the pin there', async () => {
    const { worker, browser } = await open();
    const { windows: [A, B, C] } = await threeWindowsWithPins(worker);
    await worker.run((id) => chrome.tabs.remove(id), await tabIdByTitle(worker, C, 'b', { placeholder: true }));
    await expectPinnedAreas(worker, [A, B, C], [['a', '~b'], ['~a', '~b'], ['~a', '~b']]);
    await reopenClosedTab(browser, worker, C, 'C');
    await expectPinnedAreas(worker, [A, B, C], [['a', '~b'], ['~a', '~b'], ['~a', 'b']]);
  });

  // Vivaldi's Ctrl+Shift+T reopens closed tabs only, and a tab from the
  // closed window is not among them.
  const vivaldi = /vivaldi/i.test(executable ?? '');
  test('reopening the window a pin was live in keeps each pin once', {
    skip: vivaldi && 'Vivaldi reopens no windows with Ctrl+Shift+T',
  }, async () => {
    const { worker, browser } = await open();
    const { windows: [A, B, C] } = await threeWindowsWithPins(worker);
    for (const windowId of [C, B]) {
      await focus(worker, windowId);
      await waitFor(() => worker.run(async (id) => (await chrome.storage.session.get('focusOrder')).focusOrder[0] === id, windowId));
    }
    await worker.run((id) => chrome.windows.remove(id), A);
    await expectPinnedAreas(worker, [B, C], [['a', 'b'], ['~a', '~b']]);
    await reopenClosedTab(browser, worker, B, 'B');
    await waitFor(async () => (await layout(worker)).length === 4);
    await expectEachPinOnce(worker, ['a', 'b']);
  });

  // Vivaldi reopens no tab at all after this swap, from either window.
  test('reopening the placeholder a swap between one-tab windows closed keeps the pin once', {
    skip: vivaldi && 'Vivaldi reopens nothing with Ctrl+Shift+T here',
  }, async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'x');
    const x = (await worker.run((id) => chrome.tabs.query({ windowId: id }), A))[0].id;
    await worker.run((id) => chrome.tabs.update(id, { pinned: true }), x);
    await waitForTitle(worker, x, 'x');
    const B = await createWindow(worker, 'B');
    await expectPinnedAreas(worker, [A, B], [['x'], ['~x']]);
    await worker.run(async (id) => chrome.tabs.remove((await chrome.tabs.query({ windowId: id, pinned: false }))[0].id), B);
    await focus(worker, B);
    await expectPinnedAreas(worker, [A, B], [['~x'], ['x']]);
    await reopenClosedTab(browser, worker, B, 'x');
    await waitFor(async () => (await layout(worker)).find((window) => window.id === B).tabs.length === 1);
    await expectPinnedAreas(worker, [A, B], [['~x'], ['x']]);
    assert.equal(await liveWindowOf(worker, x), B);
  });

  test('reopening the copy a late session restore closed keeps the pin once', async () => {
    const { worker } = await open();
    await threeWindowsWithPins(worker);
    await waitForStoredTitles(worker, ['a', 'b']);
    const { worker: restarted, browser: started } = await restartWithoutTabs();
    await expectAllPinnedAreas(restarted, [['a', 'b']]);
    const [first] = await layout(restarted);
    // A restored window arrives with its tabs already pinned. Creating one
    // and then pinning its tab would let a pass give the window a placeholder
    // for a in between, which the merge closes after the copy, and reopening
    // would bring back that placeholder instead. The extension's reads of the
    // windows wait until the tab is pinned.
    await restarted.run(async (url) => {
      const getAll = chrome.windows.getAll;
      let release;
      const pinnedYet = new Promise((resolve) => { release = resolve; });
      chrome.windows.getAll = async (...args) => {
        await pinnedYet;
        return getAll.apply(chrome.windows, args);
      };
      try {
        const window = await chrome.windows.create({ url, focused: true });
        await chrome.tabs.update(window.tabs[0].id, { pinned: true });
      } finally {
        chrome.windows.getAll = getAll;
        release();
      }
    }, `${pageUrl('a')}#restored`);
    await expectAllPinnedAreas(restarted, [['~a', 'b'], ['a', '~b']]);
    // The tab closed last is the copy of a the merge closed in the first
    // window, which now shows a placeholder for a.
    await waitForTitle(restarted, await openTab(restarted, first.id, 'F', { active: true }), 'F');
    await reopenClosedTab(started, restarted, first.id, 'F');
    await expectEachPinOnce(restarted, ['a', 'b']);
    // The reopened copy was selected, so the live tab comes to its window.
    await expectPinnedAreas(restarted, [first.id], [['a', 'b']]);
    const live = (await layout(restarted)).find((window) => window.id === first.id).tabs.find((tab) => tab.title === 'a');
    assert.equal(live.active, true);
    assert.equal(live.url, `${pageUrl('a')}#restored`);
  });

  test('pinning a second tab at the address of a pin selects that pin instead', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    await focus(worker, B);
    const copy = await openTab(worker, B, 'a#again', { active: true });
    await waitForTitle(worker, copy, 'a');
    await worker.run((id) => chrome.tabs.update(id, { pinned: true }), copy);
    await expectPinnedAreas(worker, [A, B, C], [['~a', 'b'], ['a', '~b'], ['~a', '~b']]);
    assert.equal(await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), copy), false);
    const tab = await worker.run((id) => chrome.tabs.get(id), a);
    assert.equal(tab.windowId, B);
    assert.equal(tab.active, true);
  });

  test('the trace records pinning, copies and moves by id, without any address', async () => {
    const { worker } = await open();
    const { windows: [, B], a } = await threeWindowsWithPins(worker);
    await focus(worker, B);
    const copy = await openTab(worker, B, 'a', { active: true });
    await waitForTitle(worker, copy, 'a');
    await worker.run((id) => chrome.tabs.update(id, { pinned: true }), copy);
    let trace;
    await waitFor(async () => {
      trace = await worker.run(async () => (await chrome.storage.local.get('trace')).trace ?? []);
      return trace.flatMap((entry) => entry.decisions).some((decision) => decision.brought);
    }).catch(() => assert.fail(`trace: ${JSON.stringify(trace)}`));
    const decisions = trace.flatMap((entry) => entry.decisions);
    const pins = await worker.run(async () => (await chrome.storage.session.get('pins')).pins);
    const pinA = pins.find((pin) => pin.tabId === a).id;
    assert.ok(decisions.some((decision) => decision.adopted === pinA && decision.tabId === a));
    assert.ok(decisions.some((decision) => decision.copy === copy && decision.of === pinA));
    assert.ok(decisions.some((decision) => decision.brought === pinA && decision.live === a && decision.to === B));
    assert.ok(trace.some((entry) => entry.hints.some((hint) => hint.type === 'activated')));
    assert.doesNotMatch(JSON.stringify(trace), /127\.0\.0\.1|https?:/);
  });

  test('a placeholder shows the icon of its pin even where the site lets only its own pages load it', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const B = await createWindow(worker, 'B');
    const live = await openTab(worker, A, 'iconic', { pinned: true, active: false });
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).favIconUrl?.endsWith('/icon.png'), live));
    await expectPinnedAreas(worker, [A, B], [['iconic'], ['~iconic']]);
    const placeholder = await tabIdByTitle(worker, B, 'iconic', { placeholder: true });
    const page = await placeholderPage(browser, placeholder);
    // The browser's default icon, which an unknown site gets, differs from
    // the pin's own. The page first tries whether the site's icon loads, and
    // shows an icon only once it knows which.
    let shown;
    const read = () => page.run(async (unknown) => {
      const bytes = async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())].join();
      const src = document.getElementById('icon').src;
      const width = await new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth);
        image.onerror = () => resolve(0);
        image.src = src;
      });
      const fallback = chrome.runtime.getURL(`/_favicon/?${new URLSearchParams({ pageUrl: unknown, size: 64 })}`);
      if (!src) return { loads: false, own: false };
      return { loads: width > 0, own: (await bytes(src)) !== (await bytes(fallback)) };
    }, 'https://unknown.invalid/');
    await waitFor(async () => {
      shown = await read();
      return shown.loads && shown.own;
    }).catch(() => assert.deepEqual(shown, { loads: true, own: true }));
  });

  test('a pin the browser unloaded stays unloaded until it is selected', async () => {
    const { worker } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    await focus(worker, B);
    // Discarding may give the tab a new id.
    const unloaded = await worker.run(async (id) => (await chrome.tabs.discard(id)).id, a);
    const discarded = () => worker.run(async (id) => (await chrome.tabs.get(id)).discarded, unloaded);
    assert.equal(await discarded(), true);
    await focus(worker, C);
    await focus(worker, A);
    await focus(worker, B);
    await expectPinnedAreas(worker, [A, B, C], [['a', 'b'], ['~a', '~b'], ['~a', '~b']]);
    assert.equal(await discarded(), true);
    assert.equal(await liveWindowOf(worker, unloaded), A);
    const [placeholder] = await worker.run(async (id) => (await chrome.tabs.query({ windowId: id, pinned: true }))
      .filter((tab) => tab.url.includes('/src/placeholder.html')).map((tab) => tab.id), B);
    await select(worker, placeholder);
    await expectPinnedAreas(worker, [A, B, C], [['~a', 'b'], ['a', '~b'], ['~a', '~b']]);
    await waitForTitle(worker, unloaded, 'a');
    assert.equal(await discarded(), false);
  });

  test('a rebuild keeps the loaded copy of a pin live rather than one the browser unloaded', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const B = await createWindow(worker, 'B');
    const loaded = await openTab(worker, A, 'x', { pinned: true, active: false });
    await waitForTitle(worker, loaded, 'x');
    // Pinning a second tab at x would merge it into x, so the second pin
    // starts elsewhere and its page goes to x after.
    const copy = await openTab(worker, B, 'y', { pinned: true, active: false });
    await waitForTitle(worker, copy, 'y');
    await waitFor(async () => (await pinnedAreas(worker, [A])).flat().includes('~y'));
    await worker.run((id, url) => chrome.tabs.update(id, { url }), copy, pageUrl('x#copy'));
    await waitForTitle(worker, copy, 'x');
    await waitFor(async () => (await pinnedAreas(worker, [A, B])).every((area) => [...area].sort().join() === 'x,~x'));
    // Discarding may give the tab a new id.
    await worker.run((id) => chrome.tabs.discard(id), copy);
    // On failure the window's tabs as the browser reports them tell which
    // half of the condition did not hold.
    await waitFor(async () => (await layout(worker)).find((window) => window.id === B).tabs.some((tab) => tab.url.endsWith('#copy')
      && tab.pinned) && worker.run(async (id) => (await chrome.tabs.query({ windowId: id, discarded: true })).length === 1, B))
      .catch(async (error) => {
        const tabs = await worker.run(async (id) => (await chrome.tabs.query({ windowId: id }))
          .map(({ id: tabId, pinned, discarded, status, url }) => ({ tabId, pinned, discarded, status, url })), B);
        throw new Error(`${error.message}\nwindow B: ${JSON.stringify(tabs)}`);
      });
    // B, focused last, is read first, so its copy of x is found first.
    await worker.run(() => { setTimeout(() => chrome.runtime.reload(), 0); });
    await waitFor(() => worker.run(() => false).catch(() => true));
    const reloaded = await readyWorker(browser);
    await expectPinnedAreas(reloaded, [A, B], [['x'], ['~x']]);
    assert.equal(await liveWindowOf(reloaded, loaded), A);
  });

  test('reloading the extension rebuilds the placeholders Chromium closed', async () => {
    const { worker, browser } = await open();
    const { windows: [A, B, C], a } = await threeWindowsWithPins(worker);
    // C is left holding nothing but placeholders, which stays so only while
    // the pin it selects is shown in a window focused more recently.
    await select(worker, a);
    await focus(worker, A);
    await waitFor(() => worker.run(async (id) => (await chrome.storage.session.get('focusOrder')).focusOrder[0] === id, A));
    await select(worker, await tabIdByTitle(worker, C, 'a', { placeholder: true }));
    await worker.run((id) => chrome.tabs.remove(id), await tabIdByTitle(worker, C, 'C'));
    await expectPinnedAreas(worker, [A, B, C], [['a', 'b'], ['~a', '~b'], ['~a', '~b']]);
    await worker.run(() => { setTimeout(() => chrome.runtime.reload(), 0); });
    await waitFor(() => worker.run(() => false).catch(() => true));
    const reloaded = await readyWorker(browser);
    await expectPinnedAreas(reloaded, [A, B, C], [['a', 'b'], ['~a', '~b'], ['~a', '~b']]);
    // The New Tab page the browser opens there becomes the overlay.
    let unpinned;
    await waitFor(async () => {
      unpinned = (await layout(reloaded)).find((window) => window.id === C).tabs.filter((tab) => !tab.pinned);
      return unpinned.length === 1 && unpinned[0].url.includes('/src/overlay.html?mode=tab&newtab=1');
    }).catch(() => assert.fail(JSON.stringify(unpinned)));
  });
});

// The overlay frame over the page in the window, once it has started.
async function overlayFrame(browser) {
  const target = await waitFor(async () => (await browser.targets()).find(
    (info) => info.type === 'iframe' && info.url.includes('/src/overlay.html'),
  )).catch(async (error) => {
    const targets = (await browser.targets()).filter((info) => info.type === 'page' || info.type === 'iframe')
      .map((info) => `${info.type} ${info.url.slice(0, 90)}`);
    const fallback = await current.worker.run(async () => (await chrome.storage.session.get('overlayFallback')).overlayFallback ?? null);
    throw new Error(`${error.message}\nfallback: ${JSON.stringify(fallback)}\ntargets: ${JSON.stringify(targets)}`);
  });
  const frame = await browser.attach(target.targetId);
  await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, frame.sessionId);
  await waitFor(() => frame.run(() => document.activeElement?.id === 'query'));
  return frame;
}

// Presses the extension's shortcut, Ctrl+Shift+Space, on the page.
async function pressShortcut(context) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    current.browser.connection.send('Input.dispatchKeyEvent', {
      type, key: ' ', code: 'Space', modifiers: 2 | 8, windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    }, context.sessionId).catch(() => {});
  }
}

function pressCtrlT(context) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    current.browser.connection.send('Input.dispatchKeyEvent', {
      type, key: 't', code: 'KeyT', modifiers: 2, windowsVirtualKeyCode: 84, nativeVirtualKeyCode: 84,
    }, context.sessionId).catch(() => {});
  }
}

function overlayOpen(browser) {
  return browser.targets().then((targets) => targets.some((info) => info.url.includes('/src/overlay.html')));
}

// Opens the overlay with the extension's shortcut, pressed on the page. A
// press right after the page loaded is now and then dropped, so a press that
// opens nothing is repeated.
// Vivaldi from its own repository grants the shortcut no access to the page
// on the CI runner, so the overlay opens as a tab of its own there; a test of
// the overlay over a page then has nothing to test.
class NoOverlayInPage extends Error {}

// A shortcut press on the CI runners is now and then dropped several times in
// a row.
const SHORTCUT_TRIES = 5;

function overlayTest(name, fn) {
  test(name, async (context) => {
    try {
      await fn(context);
    } catch (error) {
      if (!(error instanceof NoOverlayInPage)) throw error;
      context.skip(error.message);
    }
  });
}

async function pressOverlayShortcut(browser, name) {
  // The shortcut acts on the selected tab of the window focused last.
  // A page still loading replaces the document the overlay is drawn into.
  await waitFor(() => current.worker.run(async (url) => (await chrome.tabs.query({ url })).some((tab) => tab.active && tab.status === 'complete'), pageUrl(name)));
  const windowId = await current.worker.run(async (url) => (await chrome.tabs.query({ url })).find((tab) => tab.active)?.windowId, pageUrl(name));
  if (windowId !== undefined) {
    await focus(current.worker, windowId);
    await waitFor(() => current.worker.run(async (id) => (await chrome.windows.getLastFocused()).id === id, windowId));
  }
  const page = await browser.page(pageUrl(name));
  // The shortcut grants the extension the selected tab of the browser's
  // active window; without a window manager that need not be the window the
  // key goes to, so the page's window is made the active one.
  await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
  await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, page.sessionId);
  for (let attempt = 1; ; attempt++) {
    await pressShortcut(page);
    // Which overlay the press opened: over the page, or, where the shortcut
    // was given no access to it, as the popup or a tab.
    let kind;
    try {
      kind = await waitFor(async () => {
        const targets = await browser.targets();
        if (targets.some((info) => info.type === 'iframe' && info.url.includes('/src/overlay.html'))) return 'page';
        if (targets.some((info) => info.url.includes('/src/overlay.html?mode=tab'))) return 'tab';
        if (targets.some((info) => info.url.includes('/src/overlay.html?mode=popup'))) return 'popup';
        return null;
      }, { timeout: 8_000 });
    } catch (error) {
      if (attempt === SHORTCUT_TRIES) throw error;
      await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
      continue;
    }
    if (kind === 'page') return overlayFrame(browser);
    if (kind === 'tab' && /vivaldi/i.test(executable ?? '')) {
      throw new NoOverlayInPage('Vivaldi gave the shortcut no access to the page, so the overlay opened as a tab');
    }
    // Now and then on the CI runners the shortcut grants no access to the
    // page; the fallback goes again and that try counts as lost.
    for (const info of (await browser.targets()).filter((target) => /\/src\/overlay\.html\?mode=(tab|popup)/.test(target.url))) {
      await current.browser.connection.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
    }
    await waitFor(async () => !(await overlayOpen(browser)));
    if (attempt === SHORTCUT_TRIES) throw new Error(`the shortcut was given no access to the page in ${SHORTCUT_TRIES} tries; the overlay opened as the ${kind}`);
    await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
  }
}

// Clicks the toolbar button in the tab's window, the way its click reaches
// the extension: as a closeTabs message, sent from an extension page in a
// window of its own that goes again afterwards.
async function clickButton(browser, worker, tabId) {
  const welcome = await worker.run(async () => {
    const window = await chrome.windows.create({ url: chrome.runtime.getURL('src/welcome.html'), focused: false });
    return { windowId: window.id, tabId: window.tabs[0].id };
  });
  // Vivaldi leaves a page that is attached to while it loads unanswered.
  await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).status === 'complete', welcome.tabId));
  const page = await browser.page((url) => url.includes('/src/welcome.html'));
  await page.run((id) => chrome.runtime.sendMessage({ type: 'closeTabs', tabId: id }), tabId);
  await worker.run((id) => chrome.windows.remove(id), welcome.windowId);
}

async function typeInto(frame, text) {
  await current.browser.connection.send('Input.insertText', { text }, frame.sessionId);
}

function overlayResults(frame) {
  return frame.run(() => [...document.querySelectorAll('#results .row')].map((row) => ({
    title: row.querySelector('.title').textContent,
    kind: row.querySelector('.kind').textContent,
    selected: row.classList.contains('selected'),
  })));
}

function tabsIn(worker, windowId) {
  return worker.run(async (id) => (await chrome.tabs.query({ windowId: id })).map((tab) => ({
    id: tab.id, title: tab.title, url: tab.pendingUrl || tab.url, pinned: tab.pinned, active: tab.active, groupId: tab.groupId,
  })), windowId);
}

describe('overlay and closing button', { skip, concurrency: 1 }, () => {
  overlayTest('the shortcut opens the overlay over the page without a tab, and Escape closes it', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const before = (await tabsIn(worker, A)).length;
    const frame = await pressOverlayShortcut(browser, 'A');
    assert.equal((await tabsIn(worker, A)).length, before);
    // How long the opening took is kept, step by step.
    let timing;
    await waitFor(async () => {
      [timing] = (await worker.run(() => chrome.storage.local.get('overlayTimings'))).overlayTimings ?? [];
      return timing?.ready !== undefined;
    });
    assert.ok(['pageRan', 'injected', 'frameStarted', 'ready'].every((step) => Number.isFinite(timing[step])), JSON.stringify(timing));
    await frame.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
  });

  overlayTest('an address typed in the overlay opens in a new tab', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const frame = await pressOverlayShortcut(browser, 'A');
    await typeInto(frame, pageUrl('typed').replace('http://', ''));
    await waitFor(async () => (await overlayResults(frame))[0]?.kind === 'Open');
    await frame.press('Enter', { wait: false });
    await waitFor(async () => (await tabsIn(worker, A)).some((tab) => tab.title === 'typed' && tab.active));
    await waitFor(async () => !(await overlayOpen(browser)));
  });

  overlayTest('the overlay offers open tabs and pins, and picking one selects it', async () => {
    const { worker, browser } = await open();
    const { windows: [A, B] } = await threeWindowsWithPins(worker);
    const other = await openTab(worker, A, 'other');
    await waitForTitle(worker, other, 'other');
    await focus(worker, B);
    const frame = await pressOverlayShortcut(browser, 'B');
    await typeInto(frame, 'othe');
    await waitFor(async () => (await overlayResults(frame)).some((row) => row.title === 'other' && row.kind === 'Switch to Tab'));
    const rows = await overlayResults(frame);
    for (let index = 0; index < rows.findIndex((row) => row.title === 'other'); index++) await frame.press('ArrowDown');
    await frame.press('Enter', { wait: false });
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).active, other));
    await waitFor(async () => !(await overlayOpen(browser)));
    // A pin is picked in the window the overlay was opened in, which brings
    // its live page there.
    await focus(worker, B);
    const again = await pressOverlayShortcut(browser, 'B');
    await typeInto(again, 'a');
    await waitFor(async () => (await overlayResults(again)).some((row) => row.title === 'a' && row.kind === 'Switch to Tab'));
    const pinRows = await overlayResults(again);
    for (let index = 0; index < pinRows.findIndex((row) => row.title === 'a' && row.kind === 'Switch to Tab'); index++) await again.press('ArrowDown');
    await again.press('Enter', { wait: false });
    await expectPinnedAreas(worker, [A, B], [['~a', 'b'], ['a', '~b']]);
  });

  overlayTest('an action named in the overlay acts on the tab it was opened over', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const [tab] = (await tabsIn(worker, A));
    const frame = await pressOverlayShortcut(browser, 'A');
    await typeInto(frame, 'pin tab');
    await waitFor(async () => (await overlayResults(frame))[0]?.title === 'Pin Tab');
    await frame.press('Enter', { wait: false });
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).pinned, tab.id));
  });

  overlayTest('closing other tabs leaves pins and tab groups, and the button\'s second click gives up the selected tab for a pick in the overlay', async () => {
    const { worker, browser } = await open();
    const { windows: [A], a } = await threeWindowsWithPins(worker);
    await focus(worker, A);
    const grouped = await openTab(worker, A, 'grouped');
    await worker.run((id) => chrome.tabs.group({ tabIds: [id] }), grouped);
    const loose = await openTab(worker, A, 'loose');
    const current = await openTab(worker, A, 'current', { active: true });
    await waitForTitle(worker, current, 'current');
    const badge = () => worker.run((id) => chrome.action.getBadgeText({ tabId: id }), current);
    // A: the window's first tab, loose: one more; the group and pins stay.
    let shown;
    await waitFor(async () => (shown = await badge()) === '2').catch(async () => assert.fail(`badge ${shown}, tabs ${JSON.stringify(await tabsIn(worker, A))}`));
    const frame = await pressOverlayShortcut(browser, 'current');
    await typeInto(frame, 'close other');
    await waitFor(async () => (await overlayResults(frame))[0]?.title === 'Close Other Tabs');
    await frame.press('Enter', { wait: false });
    await waitFor(async () => {
      const titles = (await tabsIn(worker, A)).filter((tab) => !tab.pinned).map((tab) => tab.title);
      return titles.join() === 'grouped,current';
    });
    assert.equal(await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), loose), false);
    await waitFor(async () => (await badge()) === '1');
    // Named in the overlay once only the selected tab is left, it closes
    // nothing more.
    const again = await pressOverlayShortcut(browser, 'current');
    await typeInto(again, 'close other');
    await waitFor(async () => (await overlayResults(again))[0]?.title === 'Close Other Tabs');
    await again.press('Enter', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    assert.equal(await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), current), true);
    // The button's second click opens the overlay over the selected tab,
    // which goes once a pin is picked there.
    await clickButton(browser, worker, current);
    const second = await overlayFrame(browser);
    assert.match((await browser.targets()).find((info) => info.type === 'iframe' && info.url.includes('/src/overlay.html')).url, /replace=1/);
    await second.press('ArrowDown');
    await second.press('Enter', { wait: false });
    await waitFor(async () => (await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), current)) === false);
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).active, a));
    assert.equal(await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), grouped), true);
  });

  overlayTest('an address picked in the overlay of the button\'s second click loads in the tab it was opened over', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const [tab] = await tabsIn(worker, A);
    // Escape keeps the tab.
    const first = await pressOverlayShortcut(browser, 'A');
    await first.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    await clickButton(browser, worker, tab.id);
    const kept = await overlayFrame(browser);
    await kept.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    assert.equal(await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), tab.id), true);
    await clickButton(browser, worker, tab.id);
    const frame = await overlayFrame(browser);
    await typeInto(frame, pageUrl('there').replace('http://', ''));
    await waitFor(async () => (await overlayResults(frame))[0]?.kind === 'Open');
    await frame.press('Enter', { wait: false });
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).title === 'there', tab.id));
    assert.equal((await tabsIn(worker, A)).length, 1);
  });

  test('over a page the browser keeps to itself the overlay opens as the button\'s popup, or as a tab without popups', async () => {
    const { worker, browser } = await open();
    const B = await createWindow(worker, 'B');
    const [{ id }] = await tabsIn(worker, B);
    await worker.run((tabId) => chrome.tabs.update(tabId, { url: 'chrome://version' }), id);
    // Edge shows chrome://version as edge://version.
    const version = await browser.page((url) => /^[a-z]+:\/\/version/.test(url));
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, version.sessionId);
    // Vivaldi opens no extension popup on request.
    const mode = /vivaldi/i.test(executable ?? '') ? 'tab' : 'popup';
    const shown = async () => (await browser.targets()).some((info) => info.url.includes(`/src/overlay.html?mode=${mode}`));
    for (let attempt = 1; !(await shown()); attempt++) {
      await pressShortcut(version);
      await waitFor(shown, { timeout: 8_000 }).catch((error) => {
        if (attempt === 3) throw error;
      });
    }
  });

  test('the button\'s second click on a page the overlay cannot be drawn over leaves the overlay in its place', async () => {
    const { worker, browser } = await open();
    const { windows: [, B] } = await threeWindowsWithPins(worker);
    await focus(worker, B);
    const own = await tabIdByTitle(worker, B, 'B');
    // Without the page granted by a shortcut or click, the overlay cannot be
    // drawn over it and takes the tab's place.
    await clickButton(browser, worker, own);
    await waitFor(async () => {
      const tabs = await tabsIn(worker, B);
      return !tabs.some((tab) => tab.id === own)
        && tabs.some((tab) => tab.active && !tab.pinned && tab.url.includes('/src/overlay.html?mode=tab'));
    });
    // An address picked there opens in that same tab.
    // Vivaldi leaves a page that is attached to while it loads unanswered.
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.query({ windowId: id, active: true }))[0]?.status === 'complete', B));
    const page = await browser.page((url) => url.includes('/src/overlay.html?mode=tab'));
    await waitFor(() => page.run(() => document.activeElement?.id === 'query'));
    await typeInto(page, pageUrl('there').replace('http://', ''));
    await waitFor(async () => (await overlayResults(page))[0]?.kind === 'Open');
    await page.press('Enter', { wait: false });
    await waitFor(async () => {
      const tabs = (await tabsIn(worker, B)).filter((tab) => !tab.pinned);
      return tabs.length === 1 && tabs[0].title === 'there';
    });
  });

  overlayTest('the overlay opens a private window', async () => {
    const { worker, browser } = await open();
    await createWindow(worker, 'A');
    const frame = await pressOverlayShortcut(browser, 'A');
    await typeInto(frame, 'private window');
    await waitFor(async () => (await overlayResults(frame))[0]?.title === 'Open Private Window');
    await frame.press('Enter', { wait: false });
    // The extension is kept out of private windows and cannot see them, so
    // the new window is looked for as a page in a browser context of its own.
    const main = (await browser.targets()).find((info) => info.type === 'page' && info.url === pageUrl('A')).browserContextId;
    let privatePage;
    await waitFor(async () => {
      privatePage = (await browser.targets()).find((info) => info.type === 'page' && info.browserContextId !== main);
      return privatePage;
    });
    // Vivaldi keeps the test run alive after its kill while a private window
    // is left open.
    await current.browser.connection.send('Target.closeTarget', { targetId: privatePage.targetId });
  });

  test('a tab opened on the New Tab page becomes the overlay, and Escape goes back to the tab before', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const [before] = await tabsIn(worker, A);
    await worker.run(async (windowId) => chrome.tabs.create({ windowId, url: 'chrome://newtab/' }), A);
    let created;
    await waitFor(async () => {
      created = await worker.run(async (windowId) => (await chrome.tabs.query({ windowId }))
        .find((tab) => (tab.pendingUrl || tab.url).includes('/src/overlay.html?mode=tab&newtab=1') && tab.status === 'complete')?.id, A);
      return created;
    });
    const afterNewTab = await tabsIn(worker, A);
    assert.equal(afterNewTab.length, 2, JSON.stringify(afterNewTab.map((tab) => tab.url)));
    const page = await browser.page((url) => url.includes('/src/overlay.html?mode=tab&newtab=1'));
    await waitFor(() => page.run(() => document.activeElement?.id === 'query'));
    await page.press('Escape', { wait: false });
    await waitFor(async () => (await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), created)) === false);
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).active, before.id));
  });

  overlayTest('with history allowed, a typed site comes first and visited pages after the tabs', async () => {
    // A copy that asks for history and bookmarks up front, which an unpacked
    // extension is granted without the dialog the overlay's Include opens.
    const copy = await mkdtemp(join(tmpdir(), 'synced-pins-history-'));
    try {
      await cp(extensionPath, copy, { recursive: true, filter: (path) => !/\/(node_modules|dist|\.git)(\/|$)/.test(path) });
      const manifest = JSON.parse(await readFile(join(copy, 'manifest.json'), 'utf8'));
      manifest.permissions.push('history', 'bookmarks');
      delete manifest.optional_permissions;
      await writeFile(join(copy, 'manifest.json'), JSON.stringify(manifest));
      const { worker, browser } = await open({ extension: copy });
      await createWindow(worker, 'A');
      const visited = await worker.run(async (url) => (await chrome.tabs.create({ url, active: false })).id, pageUrl('remembered'));
      await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).status === 'complete', visited));
      await worker.run((id) => chrome.tabs.remove(id), visited);
      const frame = await pressOverlayShortcut(browser, 'A');
      assert.equal(await frame.run(() => document.getElementById('history').hidden), true);
      await typeInto(frame, 'remembered');
      await waitFor(async () => (await overlayResults(frame)).some((row) => row.title === 'remembered' && row.kind === 'History'));
      await frame.run(() => { const input = document.getElementById('query'); input.value = ''; input.dispatchEvent(new Event('input')); });
      await typeInto(frame, '127');
      await waitFor(async () => {
        const [first] = await overlayResults(frame);
        return first?.title === '127.0.0.1' && first.kind === 'Site';
      });
      // The rest of the site's address is filled in, selected, after the typed
      // text, so the next key replaces it.
      await waitFor(() => frame.run(() => {
        const input = document.getElementById('query');
        return input.value === '127.0.0.1' && input.selectionStart === 3 && !document.getElementById('hint').hidden;
      }));
      await frame.press('Backspace');
      assert.deepEqual(await frame.run(() => [document.getElementById('query').value, document.getElementById('hint').hidden]), ['127', true]);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  overlayTest('with nothing typed the overlay lists the pins, and offers history until allowed or dismissed', async () => {
    const { worker, browser } = await open();
    const { windows: [A] } = await threeWindowsWithPins(worker);
    await focus(worker, A);
    const frame = await pressOverlayShortcut(browser, 'A');
    await waitFor(async () => (await overlayResults(frame)).length > 0);
    const rows = await overlayResults(frame);
    assert.ok(rows.every((row) => row.kind === 'Pinned' && !row.selected), JSON.stringify(rows));
    assert.equal(await frame.run(() => document.getElementById('history').hidden), false);
    await frame.run(() => document.getElementById('history-dismiss').click());
    await frame.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    const again = await pressOverlayShortcut(browser, 'A');
    await waitFor(async () => (await overlayResults(again)).length > 0);
    assert.equal(await again.run(() => document.getElementById('history').hidden), true);
  });

  overlayTest('a New Tab page opened by the same key press as the overlay closes again', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    await pressOverlayShortcut(browser, 'A');
    // What a browser that keeps Ctrl+T for itself, like Vivaldi, does on it.
    const created = await worker.run(async (windowId) => (await chrome.tabs.create({ windowId, url: 'chrome://newtab/', active: false })).id, A);
    await waitFor(async () => (await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), created)) === false);
    assert.equal((await tabsIn(worker, A)).length, 1);
  });

  test('the browser\'s own new tab becomes the overlay with the keyboard in its bar', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    await focus(worker, A);
    const page = await browser.page(pageUrl('A'));
    await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
    const overlayTab = () => worker.run(async (windowId) => (await chrome.tabs.query({ windowId }))
      .find((tab) => (tab.pendingUrl || tab.url).includes('/src/overlay.html?mode=tab&newtab=1') && tab.status === 'complete')?.id, A);
    // Ctrl+T, still the browser's own here.
    for (let attempt = 1; !(await overlayTab()); attempt++) {
      pressCtrlT(page);
      await waitFor(overlayTab, { timeout: 5_000 }).catch((error) => {
        if (attempt === SHORTCUT_TRIES) throw error;
      });
    }
    const overlay = await browser.page((url) => url.includes('/src/overlay.html?mode=tab&newtab=1'));
    await waitFor(() => overlay.run(() => document.hasFocus() && document.activeElement?.id === 'query'))
      .catch(async (error) => assert.fail(`${error.message}\n${JSON.stringify(await tabsIn(worker, A))}`));
    assert.equal((await tabsIn(worker, A)).length, 2);
  });

  overlayTest('with pages allowed, a New Tab page goes and the overlay opens over the page before it', async () => {
    // A copy that asks for every page up front, which an unpacked extension
    // is granted without the dialog the overlay's Allow opens.
    const copy = await mkdtemp(join(tmpdir(), 'synced-pins-pages-'));
    try {
      await cp(extensionPath, copy, { recursive: true, filter: (path) => !/\/(node_modules|dist|\.git)(\/|$)/.test(path) });
      const manifest = JSON.parse(await readFile(join(copy, 'manifest.json'), 'utf8'));
      manifest.host_permissions = ['<all_urls>'];
      delete manifest.optional_host_permissions;
      await writeFile(join(copy, 'manifest.json'), JSON.stringify(manifest));
      const { worker, browser } = await open({ extension: copy });
      const A = await createWindow(worker, 'A');
      const [before] = await tabsIn(worker, A);
      await focus(worker, A);
      await worker.run(async (windowId) => chrome.tabs.create({ windowId, url: 'chrome://newtab/' }), A);
      await waitFor(async () => (await browser.targets()).some((info) => info.url.includes('/src/overlay.html')));
      if (/vivaldi/i.test(executable ?? '') && !(await browser.targets()).some((info) => info.type === 'iframe' && info.url.includes('/src/overlay.html'))) {
        throw new NoOverlayInPage('Vivaldi gives the extension no access to the page on the CI runner, so the overlay opened as a tab');
      }
      const frame = await overlayFrame(browser);
      await waitFor(() => frame.run(() => document.activeElement?.id === 'query'));
      const tabs = await tabsIn(worker, A);
      assert.deepEqual(tabs.map((tab) => [tab.id, tab.active]), [[before.id, true]]);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  test('whether the browser\'s shortcuts page records Ctrl+T for the overlay', async () => {
    const { worker, browser } = await open();
    const tabId = await worker.run(async () => (await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })).id);
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).status === 'complete', tabId));
    const page = await browser.page((url) => /^[a-z]+:\/\/extensions\/shortcuts/.test(url));
    await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, page.sessionId);
    const id = await worker.run(() => chrome.runtime.id);
    // The page is built of nested shadow roots; the overlay's row is found by
    // the command's description and its edit button clicked.
    const clicked = await page.run((extensionId) => {
      const all = (root) => [root, ...[...root.querySelectorAll('*')].flatMap((element) => (element.shadowRoot ? all(element.shadowRoot) : []))];
      const roots = all(document);
      const inputs = roots.flatMap((root) => [...root.querySelectorAll('cr-shortcut-input, extensions-shortcut-input')]);
      const input = inputs.find((candidate) => (candidate.item?.id ?? candidate.extension ?? '') === extensionId && (candidate.commandName ?? candidate.command?.name) === 'open-overlay')
        ?? inputs.find((candidate) => candidate.closest?.('.command-entry')?.textContent?.includes('Open a new tab'));
      // Edge's page is plain inputs named after the command.
      const plain = document.querySelector('input[aria-label^="Shortcut Open a new tab"]');
      if (!input && plain) {
        plain.click();
        plain.focus();
        return 'clicked';
      }
      if (!input) return `no input among ${inputs.length}`;
      const edit = input.shadowRoot?.querySelector('#edit, cr-icon-button');
      if (!edit) return 'no edit button';
      edit.click();
      return 'clicked';
    }, id);
    let recorded = 'not tried';
    if (clicked === 'clicked') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        for (const type of ['rawKeyDown', 'keyUp']) {
          await current.browser.connection.send('Input.dispatchKeyEvent', { type, key: 't', code: 'KeyT', modifiers: 2, windowsVirtualKeyCode: 84, nativeVirtualKeyCode: 84 }, page.sessionId);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        recorded = await worker.run(async () => (await chrome.commands.getAll()).find((command) => command.name === 'open-overlay')?.shortcut);
      } catch (error) {
        recorded = `the page took no keys: ${error.message}`;
      }
    }
    console.log(`SHORTCUTS PAGE ${executable}: ${clicked}, overlay shortcut now ${JSON.stringify(recorded)}`);
  });

  test('installing opens the page that puts the overlay on Ctrl+T, once', async () => {
    const { browser, worker, sandbox } = await open({ keepSetup: true });
    // Vivaldi leaves a page that is attached to while it loads unanswered.
    await waitFor(() => worker.run(async () => (await chrome.tabs.query({})).some((tab) => tab.url.includes('/src/welcome.html') && tab.status === 'complete')));
    const page = await browser.page((url) => url.includes('/src/welcome.html'));
    await waitFor(async () => (await page.run(() => document.getElementById('shortcut').textContent)) === 'Ctrl + Shift + Space');
    const { worker: again } = await restart({ sandbox });
    await waitFor(() => again.run(async () => (await chrome.windows.getAll()).length > 0));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const pages = await again.run(async () => (await chrome.tabs.query({})).filter((tab) => (tab.pendingUrl || tab.url).includes('/src/welcome.html')).length);
    assert.ok(pages <= 1, `${pages} setup pages after a restart`);
  });

  overlayTest('once put on Ctrl+T, Ctrl+T opens the overlay and no tab', async (context) => {
    // Vivaldi on the CI runner gives the shortcut no access to the page, so
    // the overlay opens as a tab there, which is a tab more.
    if (/vivaldi/i.test(executable ?? '')) return context.skip('Vivaldi gives the shortcut no access to the page on the CI runner');
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const extensions = await worker.run(async () => (await chrome.tabs.create({ url: 'chrome://extensions' })).id);
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).status === 'complete', extensions));
    const page = await browser.page((url) => /^[a-z]+:\/\/extensions/.test(url));
    const id = await worker.run(() => chrome.runtime.id);
    await page.run((extensionId) => new Promise((resolve) => chrome.developerPrivate.updateExtensionCommand(
      { extensionId, commandName: 'open-overlay', keybinding: 'Ctrl+T' }, resolve)), id);
    await worker.run((tabId) => chrome.tabs.remove(tabId), extensions);
    await waitFor(async () => (await worker.run(async () => (await chrome.commands.getAll()).find((c) => c.name === 'open-overlay').shortcut)) === 'Ctrl+T');
    const before = (await tabsIn(worker, A)).length;
    await focus(worker, A);
    const target = await browser.page(pageUrl('A'));
    await current.browser.connection.send('Page.bringToFront', {}, target.sessionId);
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, target.sessionId);
    for (let attempt = 1; !(await overlayOpen(browser)); attempt++) {
      pressCtrlT(target);
      await waitFor(() => overlayOpen(browser), { timeout: 8_000 }).catch((error) => {
        if (attempt === 3) throw error;
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const after = await tabsIn(worker, A);
    assert.equal(after.length, before, JSON.stringify(after.map((tab) => tab.url)));
  });

  overlayTest('the overlay offers to go on Ctrl+T until dismissed, and its Set up opens the shortcuts page with the guide beside it', async () => {
    const { worker, browser } = await open();
    await createWindow(worker, 'A');
    const frame = await pressOverlayShortcut(browser, 'A');
    await waitFor(() => frame.run(() => !document.getElementById('setup').hidden));
    await frame.run(() => document.getElementById('setup-dismiss').click());
    await frame.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    const again = await pressOverlayShortcut(browser, 'A');
    await waitFor(() => again.run(() => document.getElementById('query') === document.activeElement));
    assert.equal(await again.run(() => document.getElementById('setup').hidden), true);
    await again.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    await worker.run(() => chrome.storage.local.remove('setupDismissed'));
    const third = await pressOverlayShortcut(browser, 'A');
    await waitFor(() => third.run(() => !document.getElementById('setup').hidden));
    await third.run(() => document.getElementById('setup-open').click());
    // The browser's shortcuts page opens in a window of its own, with the
    // guide beside it.
    let windows;
    await waitFor(async () => {
      windows = await worker.run(async () => (await chrome.windows.getAll({ populate: true })).map((window) => ({ id: window.id, type: window.type, urls: window.tabs.map((tab) => tab.pendingUrl || tab.url) })));
      return windows.some((window) => window.urls.some((url) => /^[a-z]+:\/\/extensions\/shortcuts/.test(url)))
        && windows.some((window) => window.urls.some((url) => url.includes('/src/welcome.html?guide')));
    });
    const shortcutsWindow = windows.find((window) => window.urls.some((url) => /extensions\/shortcuts/.test(url))).id;
    await waitFor(() => worker.run(async () => (await chrome.tabs.query({})).some((tab) => tab.url.includes('/src/welcome.html?guide') && tab.status === 'complete')));
    const guide = await browser.page((url) => url.includes('/src/welcome.html?guide'));
    assert.deepEqual(await guide.run(() => ['page-steps', 'console-steps', 'worked'].map((id) => document.getElementById(id).hidden)), [false, true, true]);
    // The browser that refuses Ctrl+T there gets the console steps, and its
    // window the extensions page.
    await guide.run(() => document.getElementById('refuses').click());
    await waitFor(() => guide.run(() => !document.getElementById('console-steps').hidden));
    await waitFor(() => worker.run(async (windowId) => (await chrome.tabs.query({ windowId })).some((tab) => /^[a-z]+:\/\/extensions\/?$/.test(tab.pendingUrl || tab.url)), shortcutsWindow));
    // Once Ctrl+T is set, the guide says so and the other window goes.
    await waitFor(() => worker.run(async (windowId) => (await chrome.tabs.query({ windowId }))[0]?.status === 'complete', shortcutsWindow));
    const extensions = await browser.page((url) => /^[a-z]+:\/\/extensions\/?$/.test(url));
    const id = await worker.run(() => chrome.runtime.id);
    await extensions.run((extensionId) => new Promise((resolve) => chrome.developerPrivate.updateExtensionCommand(
      { extensionId, commandName: 'open-overlay', keybinding: 'Ctrl+T' }, resolve)), id);
    await waitFor(() => guide.run(() => !document.getElementById('worked').hidden));
    await waitFor(async () => !(await worker.run(async (windowId) => chrome.windows.get(windowId).then(() => true, () => false), shortcutsWindow)));
    await worker.run(async () => {
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('src/welcome.html') + '*' });
      await chrome.tabs.remove(tabs.map((tab) => tab.id));
    });
  });
});
