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

function overlayUrl(mode, tab) {
  return chrome.runtime.getURL(`${overlayPath}?${new URLSearchParams({ mode, tab: tab.id, window: tab.windowId })}`);
}

function isOverlayTab(tab) {
  return (tab.pendingUrl || tab.url || '').startsWith(chrome.runtime.getURL(overlayPath));
}

// Opens the overlay over the page in the tab, centred over the page dimmed and
// blurred as Zen does, or closes it where it is open already. Runs in the
// page, so it is self-contained.
function toggleInPage(path, query, openOnly = false) {
  const id = 'synced-pins-overlay';
  const open = document.getElementById(id);
  if (open) {
    if (openOnly) return 'open';
    navigator.keyboard?.unlock();
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
  // Keys typed before the overlay has the keyboard are kept from the page and
  // handed to the overlay once it is ready, so a fast word after the shortcut
  // arrives whole.
  let held = '';
  const heldKeys = new Set();
  const hold = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.key.length === 1) held += event.key;
    else if (event.key === 'Backspace') held = held.slice(0, -1);
    else return;
    heldKeys.add(event.code);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const holdUp = (event) => {
    if (!heldKeys.delete(event.code)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const release = () => {
    window.removeEventListener('keydown', hold, true);
    window.removeEventListener('keyup', holdUp, true);
  };
  window.addEventListener('keydown', hold, true);
  window.addEventListener('keyup', holdUp, true);
  // Over a page in full screen the browser takes Escape to leave it before
  // the page sees the key, so the overlay holds Escape while it is open: the
  // first press closes the overlay, and holding Escape still leaves full
  // screen. The overlay shows once the key is held, so an Escape pressed the
  // moment it appears reaches it.
  const escapeHeld = document.fullscreenElement && navigator.keyboard
    ? navigator.keyboard.lock(['Escape']).then(() => {
      if (!frame.isConnected) navigator.keyboard.unlock();
    }, () => {})
    : Promise.resolve();
  const close = () => {
    navigator.keyboard?.unlock();
    release();
    window.removeEventListener('message', onMessage);
    frame.remove();
    if (focusedBefore instanceof HTMLElement) focusedBefore.focus({ preventScroll: true });
  };
  // The frame shows once the overlay in it has drawn its bar, so the dimmed
  // page and the bar appear together.
  function onMessage(event) {
    if (event.source !== frame.contentWindow) return;
    if (event.data === 'synced-pins:ready') {
      escapeHeld.then(() => {
        if (!frame.isConnected) return;
        frame.style.opacity = '1';
        release();
        if (held) frame.contentWindow.postMessage({ syncedPinsTyped: held }, '*');
      });
    }
    if (event.data === 'synced-pins:hide') {
      frame.style.opacity = '0';
      requestAnimationFrame(() => requestAnimationFrame(() => frame.contentWindow?.postMessage('synced-pins:hidden', '*')));
    }
    if (event.data === 'synced-pins:close') close();
  }
  window.addEventListener('message', onMessage);
  // An overlay that never gets ready leaves no invisible frame over the page.
  setTimeout(() => {
    if (frame.isConnected && frame.style.opacity !== '1') close();
  }, 3000);
  frame.addEventListener('load', () => frame.focus());
  document.documentElement.append(frame);
  return { opened: Date.now(), readyState: document.readyState };
}

// When the overlay's shortcut last arrived, and how soon after it a New Tab
// page counts as opened by the same key press.
let overlayCommandAt = 0;
const SAME_KEY_MS = 500;

// The browsers' New Tab pages, which the overlay replaces wherever a tab
// opens on one: the tab strip's button, the menu, a new window.
const NEW_TAB_PAGE = /^[a-z]+:\/\/(newtab|new-tab-page|startpage|vivaldi-webui\/startpage)([/?#]|$)/;

// Turns a tab that opened on a New Tab page into the overlay as a tab of its
// own; back is the tab that was selected before it, which Escape returns to.
// A pinned one is left alone: Chromium puts those where it closed this
// extension's placeholders, and the pin list unpins them itself.
const replacing = new Set();
// Drawing on any page, which the user can allow from the overlay.
const PAGES = { origins: ['<all_urls>'] };

export async function replaceNewTab(tab, url, back, { found = false } = {}) {
  // The browser reports a new tab more than once (created, then its address),
  // and each report would open an overlay of its own.
  if (tab.pinned || replacing.has(tab.id) || !NEW_TAB_PAGE.test(url ?? '')) return;
  replacing.add(tab.id);
  setTimeout(() => replacing.delete(tab.id), 5_000);
  // A browser that keeps Ctrl+T for itself, such as Vivaldi, opens its new
  // tab on the same key that opened the overlay; that tab is not wanted.
  if (Date.now() - overlayCommandAt < SAME_KEY_MS) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    return;
  }
  // Where the user lets the extension draw on pages, the New Tab page goes
  // and the overlay opens over the page they were on; elsewhere, and over
  // pages no extension may draw on, it opens as a tab.
  if (!found && back !== undefined && await chrome.permissions.contains(PAGES).catch(() => false)) {
    try {
      const page = await chrome.tabs.get(back);
      if (page.windowId === tab.windowId) {
        const frameQuery = new URLSearchParams({ mode: 'frame', tab: page.id, window: page.windowId }).toString();
        await chrome.scripting.executeScript({ target: { tabId: page.id }, func: toggleInPage, args: [overlayPath, frameQuery, true], injectImmediately: true });
        await chrome.tabs.update(page.id, { active: true });
        await removeNewTab(tab);
        return;
      }
    } catch {
      // A page the overlay cannot be drawn over.
    }
  }
  const query = new URLSearchParams({ mode: 'tab', newtab: '1' });
  if (back !== undefined) query.set('back', back);
  // The browser keeps the keyboard in its address bar on a New Tab page, also
  // once the tab loads another page, so the overlay opens as a tab of its own
  // in the same place, which takes the keyboard, and the New Tab page goes.
  // Edge reports a tab from the tab strip's button as not yet selected, so
  // only the New Tab pages found open at start keep their own state.
  const active = found ? tab.active : true;
  let overlay;
  try {
    overlay = await chrome.tabs.create({ windowId: tab.windowId, index: tab.index, active, url: chrome.runtime.getURL(`${overlayPath}?${query}`) });
  } catch {
    return;
  }
  await removeNewTab(tab);
  // Closing the New Tab page lets Edge select the page before it instead.
  if (active) await chrome.tabs.update(overlay.id, { active: true }).catch(() => {});
}

// Edge refuses to close its New Tab page ("Cannot remove NTP tab"), but lets
// a tab go once it shows another page, so the tab is made blank first there;
// a tab still being added to the strip is tried again for a moment.
async function removeNewTab(tab) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await chrome.tabs.remove(tab.id);
      return;
    } catch (error) {
      const now = await chrome.tabs.get(tab.id).catch(() => null);
      if (!now) return;
      if (/NTP/.test(error?.message ?? '')) await chrome.tabs.update(tab.id, { url: 'about:blank' }).catch(() => {});
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// The overlay opens in the page where the browser lets an extension draw
// into it, and otherwise, as on the browser's own pages, local files without
// the browser's file access or this extension's placeholders, as a tab of its
// own beside the page, the way a New Tab page opens.
// The last overlays opened over a page, with how long each step took, kept
// in local storage so a slow opening on a user's machine can be read back:
// the key's arrival, the page running the code that adds the overlay (it
// waits for the page's own work), and the overlay's bar ready in its frame.
const TIMINGS = 20;
const opening = new Map();

async function noteTiming(timing) {
  const { overlayTimings = [] } = await chrome.storage.local.get('overlayTimings');
  await chrome.storage.local.set({ overlayTimings: [...overlayTimings, timing].slice(-TIMINGS) });
}

export function overlayReady(tabId, frameStarted, ready) {
  const timing = opening.get(tabId);
  if (!timing) return;
  opening.delete(tabId);
  noteTiming({ ...timing, frameStarted: Math.round(frameStarted - timing.key), ready: ready - timing.key });
}

export async function toggleOverlay(tab) {
  overlayCommandAt = Date.now();
  // A New Tab page being turned into the overlay gets it that way; no
  // extension may draw on it, so a second overlay would open beside that one.
  if (!tab || isOverlayTab(tab) || replacing.has(tab.id)) return;
  try {
    const query = new URLSearchParams({ mode: 'frame', tab: tab.id, window: tab.windowId }).toString();
    const key = overlayCommandAt;
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: toggleInPage, args: [overlayPath, query], injectImmediately: true });
    if (result?.opened) {
      let site = '';
      try {
        site = new URL(tab.url).hostname;
      } catch {
        // No address to name.
      }
      opening.set(tab.id, { at: new Date(key).toISOString(), site, loading: tab.status === 'loading', readyState: result.readyState, pageRan: result.opened - key, injected: Date.now() - key, key });
      setTimeout(() => opening.delete(tab.id), 10_000);
    }
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
  const query = new URLSearchParams({ mode: 'tab', closes: '1', back: tab.id });
  await chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, active: true, url: chrome.runtime.getURL(`${overlayPath}?${query}`) });
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
