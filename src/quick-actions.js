// The actions the overlay offers by name, as Zen's address bar does, acting
// on the tab the overlay was opened over. Each is offered only where it can
// do something.
function isWebPage(tab) {
  return /^(https?|file):/.test(tab.url ?? '');
}

async function selectNeighbour(tab, step) {
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const at = tabs.findIndex((other) => other.id === tab.id);
  const next = tabs[(at + step + tabs.length) % tabs.length];
  await chrome.tabs.update(next.id, { active: true });
}

export const quickActions = [
  { label: 'Pin Tab', available: (tab) => !tab.pinned, run: (tab) => chrome.tabs.update(tab.id, { pinned: true }) },
  { label: 'Unpin Tab', available: (tab) => tab.pinned, run: (tab) => chrome.tabs.update(tab.id, { pinned: false }) },
  { label: 'Close Tab', available: () => true, run: (tab) => chrome.tabs.remove(tab.id) },
  {
    label: 'Close Other Tabs',
    available: () => true,
    run: (tab) => chrome.runtime.sendMessage({ type: 'closeTabs', tabId: tab.id }),
  },
  { label: 'Duplicate Current Tab', available: isWebPage, run: (tab) => chrome.tabs.duplicate(tab.id) },
  { label: 'Reload Tab', available: isWebPage, run: (tab) => chrome.tabs.reload(tab.id) },
  { label: 'Reload Tab Without Cache', available: isWebPage, run: (tab) => chrome.tabs.reload(tab.id, { bypassCache: true }) },
  { label: 'Next Tab', available: () => true, run: (tab) => selectNeighbour(tab, 1) },
  { label: 'Previous Tab', available: () => true, run: (tab) => selectNeighbour(tab, -1) },
  { label: 'Copy Current URL', available: isWebPage, run: (tab) => navigator.clipboard.writeText(tab.url) },
  { label: 'Open New Window', available: () => true, run: () => chrome.windows.create({}) },
  { label: 'Open Private Window', available: () => true, run: () => chrome.windows.create({ incognito: true }) },
  {
    label: 'Print',
    available: isWebPage,
    run: (tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => print() }),
  },
  { label: 'Settings', available: () => true, run: () => chrome.tabs.create({ url: 'chrome://settings' }) },
  { label: 'Manage Extensions', available: () => true, run: () => chrome.tabs.create({ url: 'chrome://extensions' }) },
];
