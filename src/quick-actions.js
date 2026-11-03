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
  { label: 'Pin Tab', glyph: 'M12 17v5M9 10.8V4h6v6.8l2.5 3.2h-11z', available: (tab) => !tab.pinned, run: (tab) => chrome.tabs.update(tab.id, { pinned: true }) },
  { label: 'Unpin Tab', glyph: 'M12 17v5M9 10.8V4h6v6.8l2.5 3.2h-11zM3 3l18 18', available: (tab) => tab.pinned, run: (tab) => chrome.tabs.update(tab.id, { pinned: false }) },
  { label: 'Close Tab', glyph: 'M6 6l12 12M18 6 6 18', available: () => true, run: (tab) => chrome.tabs.remove(tab.id) },
  {
    label: 'Close Other Tabs', glyph: 'M4 20h16M7 16l3-9 4 1.5-3 8.5M13 6l1-3',
    available: () => true,
    run: (tab) => chrome.runtime.sendMessage({ type: 'closeTabs', tabId: tab.id, othersOnly: true }),
  },
  { label: 'Duplicate Current Tab', glyph: 'M8 8h12v12H8zM16 8V4H4v12h4', available: isWebPage, run: (tab) => chrome.tabs.duplicate(tab.id) },
  { label: 'Reload Tab', glyph: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5', available: isWebPage, run: (tab) => chrome.tabs.reload(tab.id) },
  { label: 'Reload Tab Without Cache', glyph: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5M12 9v4l2 2', available: isWebPage, run: (tab) => chrome.tabs.reload(tab.id, { bypassCache: true }) },
  { label: 'Next Tab', glyph: 'M5 12h14M13 6l6 6-6 6', available: () => true, run: (tab) => selectNeighbour(tab, 1) },
  { label: 'Previous Tab', glyph: 'M19 12H5M11 6l-6 6 6 6', available: () => true, run: (tab) => selectNeighbour(tab, -1) },
  { label: 'Copy Current URL', glyph: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1', available: isWebPage, run: (tab) => navigator.clipboard.writeText(tab.url) },
  { label: 'Open New Window', glyph: 'M3 5h18v14H3zM3 9h18', available: () => true, run: () => chrome.windows.create({}) },
  { label: 'Open Private Window', glyph: 'M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4 4l16 16', available: () => true, run: () => chrome.windows.create({ incognito: true }) },
  {
    label: 'Print', glyph: 'M7 9V3h10v6M7 17H4v-8h16v8h-3M7 14h10v7H7z',
    available: isWebPage,
    run: (tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => print() }),
  },
  { label: 'Settings', glyph: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1', available: () => true, run: () => chrome.tabs.create({ url: 'chrome://settings' }) },
  { label: 'Manage Extensions', glyph: 'M10 4h4v3a2 2 0 1 0 0 4v0h3v4h-3a2 2 0 1 0 0 4v1h-4v-3a2 2 0 1 0-4 0v3H3v-4h3a2 2 0 1 0 0-4H3V7h7z', available: () => true, run: () => chrome.tabs.create({ url: 'chrome://extensions' }) },
];
