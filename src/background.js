import { createPinSync } from './pins.js';
import { closeTabs, showClosableCount, toggleOverlay } from './tools.js';

const sync = createPinSync(chrome);

// The welcome page opens on install and on the update from a version before
// the overlay, the one change a user has to be told about.
const WELCOME_SINCE = '1.1.0';

function olderThan(version, than) {
  const parts = (text) => (text ?? '0').split('.').map(Number);
  const [a, b] = [parts(version), parts(than)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0);
  }
  return false;
}

async function showWelcome() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') }).catch(() => {});
  await chrome.storage.session.set({ welcomeShown: true });
}
const normalWindows = { windowTypes: ['normal'] };
const layoutChanged = () => sync.note({ type: 'layout' });

chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  sync.note({ type: 'installed', reason });
  if (reason === 'install' || (reason === 'update' && olderThan(previousVersion, WELCOME_SINCE))) showWelcome();
});
chrome.runtime.onStartup.addListener(layoutChanged);
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message === 'summon' && sender.tab) sync.note({ type: 'summon', tabId: sender.tab.id, windowId: sender.tab.windowId });
  if (message?.type === 'closeTabs') chrome.tabs.get(message.tabId).then(closeTabs).catch(() => {});
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
chrome.action.onClicked.addListener(closeTabs);
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
