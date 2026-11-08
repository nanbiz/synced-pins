import { createPinSync } from './pins.js';
import { isCtrlT, overlayShortcut } from './shortcut.js';
import { closeTabs, overlayReady, replaceNewTab, showClosableCount, toggleOverlay } from './tools.js';

const sync = createPinSync(chrome);

const normalWindows = { windowTypes: ['normal'] };
const layoutChanged = () => sync.note({ type: 'layout' });

// Once after installation the page that puts the overlay on Ctrl+T opens,
// unless it is there already. The browser can report the installation before
// it has a window to open the page in, so the page waits for the first one.
const setupPage = chrome.runtime.getURL('src/welcome.html');

async function promptSetupNow() {
  const { setupPending } = await chrome.storage.local.get('setupPending');
  if (!setupPending) return;
  const onCtrlT = isCtrlT(await overlayShortcut());
  const [window] = await chrome.windows.getAll(normalWindows);
  if (!onCtrlT && !window) return;
  await chrome.storage.local.set({ setupPending: false });
  if (!onCtrlT) await chrome.tabs.create({ windowId: window.id, url: setupPage });
}

// One check at a time, so a window opening during the installation does not
// open the page twice.
let prompting = Promise.resolve();
function promptSetup() {
  prompting = prompting.then(promptSetupNow).catch(() => {});
  return prompting;
}

// The browser reloads the extension when its file access is turned on, which
// closes the setup page the user went there from, so the page comes back in
// place of the tab holding the switch.
async function returnToSetup() {
  const { setupReturn } = await chrome.storage.local.get('setupReturn');
  if (!setupReturn || !await chrome.extension.isAllowedFileSchemeAccess()) return;
  await chrome.storage.local.remove('setupReturn');
  const switchPage = new RegExp(`^[a-z]+://extensions/\\?id=${chrome.runtime.id}$`);
  const tab = (await chrome.tabs.query({})).find((other) => switchPage.test(other.url));
  await chrome.tabs.create({ windowId: tab?.windowId, url: setupPage });
  if (tab) await chrome.tabs.remove(tab.id);
}
returnToSetup();

// The guide to putting the overlay on Ctrl+T opens beside the browser's own
// shortcuts page, both in the space of the window it was asked from: the page
// on the left, the guide on the right, so its steps stay in view.
async function openSetup(windowId) {
  const from = await chrome.windows.get(windowId).catch(() => null);
  const { left = 0, top = 0, width = 1280, height = 800 } = from ?? {};
  const pageWidth = Math.round(width * 0.6);
  const shortcuts = await chrome.windows.create({ url: 'chrome://extensions/shortcuts', left, top, width: pageWidth, height, focused: true });
  await chrome.windows.create({
    url: chrome.runtime.getURL(`src/welcome.html?guide&shortcuts=${shortcuts.id}`),
    type: 'popup',
    left: left + pageWidth,
    top,
    width: width - pageWidth,
    height,
  });
  await chrome.windows.update(shortcuts.id, { focused: true });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  sync.note({ type: 'installed', reason });
  if (reason !== 'install') return;
  const { setupPending } = await chrome.storage.local.get('setupPending');
  if (setupPending === undefined) await chrome.storage.local.set({ setupPending: true });
  await promptSetup();
});
chrome.windows.onCreated.addListener(() => promptSetup(), normalWindows);
chrome.runtime.onStartup.addListener(layoutChanged);
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message === 'summon' && sender.tab) sync.note({ type: 'summon', tabId: sender.tab.id, windowId: sender.tab.windowId });
  if (message?.type === 'openSetup') openSetup(message.windowId);
  if (message?.type === 'overlayReady') overlayReady(message.tabId, message.frameStarted, message.ready);
  if (message?.type === 'closeTabs') {
    chrome.tabs.get(message.tabId).then((tab) => closeTabs(tab, { othersOnly: message.othersOnly === true })).catch(() => {});
  }
});

chrome.windows.onCreated.addListener(layoutChanged, normalWindows);
chrome.windows.onRemoved.addListener((windowId) => sync.note({ type: 'windowRemoved', windowId }), normalWindows);
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) sync.note({ type: 'focused', windowId });
}, normalWindows);

chrome.tabs.onActivated.addListener(({ tabId }) => sync.note({ type: 'activated', tabId }));
chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  sync.note({ type: 'removed', tabId, windowId, windowClosing: isWindowClosing });
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  sync.note({ type: 'replaced', addedTabId, removedTabId });
});
chrome.tabs.onCreated.addListener(layoutChanged);
chrome.tabs.onMoved.addListener(layoutChanged);
chrome.tabs.onAttached.addListener(layoutChanged);
chrome.tabs.onUpdated.addListener(layoutChanged);

// The overlay opens on the extension's shortcut, which the user can put on
// Ctrl+T, and the toolbar button closes the window's other tabs, showing how
// many it would close.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-overlay') toggleOverlay(tab);
});
chrome.action.onClicked.addListener((tab) => closeTabs(tab));

// A New Tab page becomes the overlay. The selected tab of each window and the
// one before it are kept, so the overlay's Escape can go back to where the
// user was.
const selection = new Map();
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const [now] = selection.get(windowId) ?? [];
  if (now !== tabId) selection.set(windowId, [tabId, now]);
});
const selectedBefore = (tab) => {
  const [now, before] = selection.get(tab.windowId) ?? [];
  return now === tab.id ? before : now;
};
chrome.tabs.onCreated.addListener((tab) => replaceNewTab(tab, tab.pendingUrl || tab.url, selectedBefore(tab)));
chrome.tabs.onUpdated.addListener((tabId, { url, pinned }, tab) => {
  if (url || pinned === false) replaceNewTab(tab, tab.pendingUrl || tab.url, selectedBefore(tab));
});
// New Tab pages opened while the worker was not running, as when the browser
// starts or the extension reloads, are turned once it runs.
chrome.tabs.query({}).then((tabs) => {
  for (const tab of tabs) replaceNewTab(tab, tab.pendingUrl || tab.url, undefined, { found: true });
});
const countIn = (windowId) => showClosableCount(windowId);
chrome.tabs.onActivated.addListener(({ windowId }) => countIn(windowId));
chrome.tabs.onCreated.addListener(({ windowId }) => countIn(windowId));
chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  if (!isWindowClosing) countIn(windowId);
});
// Chromium clears a tab's badge when the tab navigates, so the count is
// shown again whenever a page starts or finishes loading.
chrome.tabs.onUpdated.addListener((tabId, change, { windowId }) => {
  if ('pinned' in change || 'groupId' in change || 'status' in change) countIn(windowId);
});
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => countIn(newWindowId));
chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => countIn(oldWindowId));
