import { createPinSync } from './pins.js';
import { closeTabs, showClosableCount, toggleOverlay } from './tools.js';

const sync = createPinSync(chrome);

const normalWindows = { windowTypes: ['normal'] };
const layoutChanged = () => sync.note({ type: 'layout' });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  sync.note({ type: 'installed', reason });
});
chrome.runtime.onStartup.addListener(layoutChanged);
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message === 'summon' && sender.tab) sync.note({ type: 'summon', tabId: sender.tab.id, windowId: sender.tab.windowId });
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
