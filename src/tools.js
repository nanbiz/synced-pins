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

// Opens the overlay over the page in the tab, centred over the page dimmed and
// blurred as Zen does, or closes it where it is open already. Runs in the
// page, so it is self-contained.
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
    + 'margin:0;padding:0;background:rgb(0 0 0 / 0.45);backdrop-filter:blur(3px);color-scheme:light dark;'
    + 'z-index:2147483647;opacity:0';
  const focusedBefore = document.activeElement;
  const close = () => {
    window.removeEventListener('message', onMessage);
    frame.remove();
    if (focusedBefore instanceof HTMLElement) focusedBefore.focus({ preventScroll: true });
  };
  // The frame shows once the overlay in it has drawn its bar, so the dimmed
  // page and the bar appear together.
  function onMessage(event) {
    if (event.source !== frame.contentWindow) return;
    if (event.data === 'synced-pins:ready') frame.style.opacity = '1';
    if (event.data === 'synced-pins:close') close();
  }
  window.addEventListener('message', onMessage);
  // An overlay that never gets ready leaves no invisible frame over the page.
  setTimeout(() => {
    if (frame.isConnected && frame.style.opacity !== '1') close();
  }, 3000);
  frame.addEventListener('load', () => frame.focus());
  document.documentElement.append(frame);
  return 'opened';
}

// The browsers' New Tab pages, which the overlay replaces wherever a tab
// opens on one: the tab strip's button, the menu, a new window.
const NEW_TAB_PAGE = /^[a-z]+:\/\/(newtab|new-tab-page|startpage|vivaldi-webui\/startpage)([/?#]|$)/;

// Turns a tab that opened on a New Tab page into the overlay as a tab of its
// own; back is the tab that was selected before it, which Escape returns to.
export async function replaceNewTab(tab, url, back) {
  if (!NEW_TAB_PAGE.test(url ?? '')) return;
  const query = new URLSearchParams({ mode: 'tab', newtab: '1' });
  if (back !== undefined) query.set('back', back);
  await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL(`${overlayPath}?${query}`) }).catch(() => {});
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
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: toggleInPage, args: [overlayPath, query], injectImmediately: true });
    return;
  } catch (error) {
    // The page cannot host it; the reason stays for the session, for finding
    // out why on a page where it should have.
    const focused = await chrome.windows.getLastFocused({ populate: true }).catch(() => null);
    await chrome.storage.session.set({
      overlayFallback: {
        reason: String(error?.message ?? error),
        url: tab.url ?? '',
        tabId: tab.id,
        windowId: tab.windowId,
        focusedWindowId: focused?.id ?? null,
        focusedTabId: focused?.tabs?.find((other) => other.active)?.id ?? null,
        at: Date.now(),
      },
    });
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

// The overlay's Close Other Tabs closes only the others; the button's second
// click gives up the selected tab too.
export async function closeTabs(tab, { othersOnly = false } = {}) {
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const closable = closableTabs(tabs);
  if (closable.tabs.length === 0 || (closable.current && othersOnly)) return;
  if (!closable.current) {
    await chrome.tabs.remove(closable.tabs.map((other) => other.id));
    return;
  }
  // The selected tab goes too, once the overlay drawn over it has been told
  // where to go instead; Escape keeps it. Where the page cannot host the
  // overlay, the overlay takes the tab's place at once.
  try {
    const query = new URLSearchParams({ mode: 'frame', replace: '1', tab: tab.id, window: tab.windowId }).toString();
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: toggleInPage, args: [overlayPath, query], injectImmediately: true });
  } catch {
    await chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, active: true, url: overlayUrl('tab', tab) });
    await chrome.tabs.remove(tab.id);
  }
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
