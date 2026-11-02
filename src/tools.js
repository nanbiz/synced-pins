// The overlay that opens instead of a new tab, and the toolbar button that
// closes the window's other tabs, both run from the extension's service
// worker.

const overlayPath = 'src/overlay.html';
// chrome.tabGroups.TAB_GROUP_ID_NONE, without the tabGroups permission that
// API needs.
const NO_TAB_GROUP = -1;

function inGroup(tab) {
  return tab.groupId !== undefined && tab.groupId !== NO_TAB_GROUP;
}

function overlayPage(mode, tab) {
  return `${overlayPath}?${new URLSearchParams({ mode, tab: tab.id, window: tab.windowId })}`;
}

function overlayUrl(mode, tab) {
  return chrome.runtime.getURL(overlayPage(mode, tab));
}

function isOverlayTab(tab) {
  return (tab.pendingUrl || tab.url || '').startsWith(chrome.runtime.getURL(overlayPath));
}

// Opens the overlay over the page in the tab, centred in it, or closes it
// where it is open already. Runs in the page, so it is self-contained.
function toggleInPage(path, query) {
  const id = 'synced-pins-overlay';
  const open = document.getElementById(id);
  if (open) {
    open.remove();
    return 'closed';
  }
  const frame = document.createElement('iframe');
  frame.id = id;
  frame.src = `${chrome.runtime.getURL(path)}?${query}`;
  frame.allow = 'clipboard-write';
  frame.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;border:0;'
    + 'margin:0;padding:0;background:transparent;color-scheme:normal;z-index:2147483647';
  const focusedBefore = document.activeElement;
  const close = () => {
    window.removeEventListener('message', onMessage);
    frame.remove();
    if (focusedBefore instanceof HTMLElement) focusedBefore.focus({ preventScroll: true });
  };
  function onMessage(event) {
    if (event.source === frame.contentWindow && event.data === 'synced-pins:close') close();
  }
  window.addEventListener('message', onMessage);
  frame.addEventListener('load', () => frame.focus());
  document.documentElement.append(frame);
  return 'opened';
}

// The overlay opens in the page where the browser lets an extension draw
// into it, and otherwise, as on the browser's own pages, the New Tab page or
// this extension's placeholders, as the toolbar button's popup. A browser
// without extension popups on request, such as Vivaldi, gets it as a tab of
// its own, the way a New Tab page opens.
export async function toggleOverlay(tab) {
  if (!tab || isOverlayTab(tab)) return;
  try {
    const query = new URLSearchParams({ mode: 'frame', tab: tab.id, window: tab.windowId }).toString();
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: toggleInPage, args: [overlayPath, query] });
    return;
  } catch (error) {
    // The page cannot host it; the reason stays for the session, for finding
    // out why on a page where it should have.
    await chrome.storage.session.set({ overlayFallback: { reason: String(error?.message ?? error), url: tab.url ?? '', at: Date.now() } });
  }
  try {
    await openOverlayPopup(tab);
  } catch {
    await chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, active: true, url: overlayUrl('tab', tab) });
  }
}

async function openOverlayPopup(tab) {
  await chrome.action.setPopup({ popup: overlayPage('popup', tab) });
  try {
    await chrome.action.openPopup({ windowId: tab.windowId });
  } finally {
    // The button's own click closes tabs; the popup only opens on request.
    await chrome.action.setPopup({ popup: '' });
  }
}

// The tabs a click on the button closes in the window: every tab that is
// neither pinned nor in a tab group, apart from the selected one, or, once
// those are gone, the selected one.
function closableTabs(tabs) {
  const current = tabs.find((tab) => tab.active);
  const loose = tabs.filter((tab) => !tab.pinned && !inGroup(tab));
  const others = loose.filter((tab) => tab !== current);
  if (others.length > 0) return { tabs: others, current: false };
  return { tabs: loose.filter((tab) => tab === current), current: true };
}

export async function closeTabs(tab) {
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const closable = closableTabs(tabs);
  if (closable.tabs.length === 0) return;
  if (!closable.current) {
    await chrome.tabs.remove(closable.tabs.map((other) => other.id));
    return;
  }
  // The selected tab goes too. A pin open in this window takes its place,
  // so no pin moves here from another window, with the overlay over it to
  // pick where to go; without one, the overlay itself takes the tab's place.
  const { pins = [] } = await chrome.storage.session.get('pins');
  const ids = new Set(tabs.map((other) => other.id));
  const pin = pins.find((candidate) => !candidate.closed && candidate.windowId === tab.windowId && ids.has(candidate.tabId));
  if (pin) {
    const live = tabs.find((other) => other.id === pin.tabId);
    await chrome.tabs.update(live.id, { active: true });
    await chrome.tabs.remove(tab.id);
    await openOverlayPopup(live);
    return;
  }
  await chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, active: true, url: overlayUrl('tab', tab) });
  await chrome.tabs.remove(tab.id);
}

// The button shows how many tabs a click closes in the window it sits in.
// Counts for a window run one after another, so an earlier count finishing
// late never overwrites a later one.
const counting = new Map();

export function showClosableCount(windowId) {
  const next = (counting.get(windowId) ?? Promise.resolve()).then(() => countIn(windowId));
  counting.set(windowId, next);
  next.finally(() => {
    if (counting.get(windowId) === next) counting.delete(windowId);
  });
  return next;
}

async function countIn(windowId) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId });
  } catch {
    return;
  }
  const active = tabs.find((tab) => tab.active);
  if (!active) return;
  const count = closableTabs(tabs).tabs.length;
  await chrome.action.setBadgeText({ tabId: active.id, text: count > 0 ? String(count) : '' }).catch(() => {});
}
