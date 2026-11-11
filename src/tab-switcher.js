// The worker's side of the tab list shown while Alt is held: the page script
// that watches the keys runs on every page once the user allows the
// extension on pages, and the numbers follow the browser's own for Ctrl with
// a digit, 1 to 8 the tab at that place in the strip and 9 the last.

const PAGES = { origins: ['<all_urls>'] };
const SCRIPT = { id: 'tab-switcher', js: ['src/switcher.js'], matches: ['<all_urls>'], allFrames: true, runAt: 'document_start' };

function numberOf(index, count) {
  if (index === count - 1) return 9;
  return index < 8 ? index + 1 : null;
}

async function windowTabs(windowId) {
  return (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
}

// Registers the page script while pages are allowed and puts it into the
// pages already open, which a registration reaches only once they load again.
export async function keepSwitcher() {
  const allowed = await chrome.permissions.contains(PAGES).catch(() => false);
  const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT.id] })).length > 0;
  if (!allowed) {
    if (registered) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT.id] }).catch(() => {});
    return;
  }
  if (registered) return;
  await chrome.scripting.registerContentScripts([SCRIPT]);
  for (const tab of await chrome.tabs.query({})) {
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: SCRIPT.js }).catch(() => {});
  }
}

export async function switcherTabs(windowId) {
  const tabs = await windowTabs(windowId);
  return tabs.map((tab, index) => ({
    number: numberOf(index, tabs.length),
    title: tab.title,
    url: tab.pendingUrl || tab.url,
    favIconUrl: tab.favIconUrl,
    active: tab.active,
  }));
}

export async function switchTab(windowId, number) {
  const tabs = await windowTabs(windowId);
  const tab = number === 9 ? tabs.at(-1) : tabs[number - 1];
  if (tab) await chrome.tabs.update(tab.id, { active: true });
}
