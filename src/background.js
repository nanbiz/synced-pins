import { createPinSync } from './pins.js';

const sync = createPinSync(chrome);
const normalWindows = { windowTypes: ['normal'] };
const layoutChanged = () => sync.note({ type: 'layout' });

chrome.runtime.onInstalled.addListener(({ reason }) => sync.note({ type: 'installed', reason }));
chrome.runtime.onStartup.addListener(layoutChanged);
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message === 'summon' && sender.tab) sync.note({ type: 'summon', tabId: sender.tab.id, windowId: sender.tab.windowId });
});

chrome.windows.onCreated.addListener(layoutChanged, normalWindows);
chrome.windows.onRemoved.addListener((windowId) => sync.note({ type: 'windowRemoved', windowId }), normalWindows);
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) sync.note({ type: 'focused', windowId });
}, normalWindows);

chrome.tabs.onActivated.addListener(layoutChanged);
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
