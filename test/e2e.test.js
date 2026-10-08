import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
const server = createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1));
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>${name}</title><h1>${name}</h1>`);
});
let origin;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const pageUrl = (name) => `${origin}/${name}`;

// Runs one browser, on a fresh profile unless a sandbox is handed back in for
// a restart. Developer mode is on so the unpacked extension survives
// chrome.runtime.reload(). On restart the profile reopens its last session
// when restoreSession is set and otherwise follows Chromium's default of
// opening a New Tab page.
async function start({ restoreSession = false, sandbox, extension = extensionPath } = {}) {
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
    return { sandbox, browser, worker };
  } catch (error) {
    await browser?.kill();
    if (fresh) await sandbox.remove();
    throw error;
  }
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
      if (attempt === 3) throw error;
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
    await waitForTitle(worker, unloaded, 'a');
    await expectPinnedAreas(worker, [A, B, C], [['a', 'b'], ['~a', '~b'], ['~a', '~b']]);
    assert.equal((await worker.run((id) => chrome.tabs.get(id), unloaded)).url, pageUrl('a'));
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
    await waitForTitle(worker, placeholder, 'b');
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
    }).catch(() => assert.fail(`pinned areas after install: ${JSON.stringify(areas)}`));
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
    await waitFor(async () => (await layout(worker)).find((window) => window.id === B).tabs.some((tab) => tab.url.endsWith('#copy')
      && tab.pinned) && worker.run(async (id) => (await chrome.tabs.query({ windowId: id, discarded: true })).length === 1, B));
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
    // The New Tab page is chrome://newtab/, or the same under the browser's
    // own scheme, such as edge://newtab/.
    const unpinned = (await layout(reloaded)).find((window) => window.id === C).tabs.filter((tab) => !tab.pinned);
    assert.deepEqual(unpinned.map((tab) => new URL(tab.url).hostname), ['newtab']);
  });
});
