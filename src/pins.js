import { placeholderUrl, readPlaceholderUrl } from './placeholder-url.js';

// Chromium refuses tab edits while the user drags a tab; the drag ends within
// moments, so edits are retried after these pauses before giving up.
const TAB_STRIP_BUSY = 'Tabs cannot be edited right now';
const BUSY_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600];

// Reloading the extension, which reports the install reason "update", makes
// Chromium close the old version's pages, except that a window's last tab is
// turned into the New Tab page and stays pinned.
const NEW_TAB_URL = 'chrome://newtab/';

const STATE_KEYS = ['pins', 'placeholders', 'activeTabs', 'focusOrder', 'orders'];

// Keeps the pinned area of every normal window showing the same ordered pins.
// Each pin has one live tab in one window; every other normal window shows a
// pinned placeholder page for it.
//
// Events only leave hints. One pass at a time reads the actual tabs, infers
// what the user changed since the previous pass, applies it to the pin list
// and then makes every window match that list. The pin list lives in
// chrome.storage.session so a restarted service worker picks it up again.
export function createPinSync(chrome) {
  const pageUrl = chrome.runtime.getURL('src/placeholder.html');
  const hints = [];
  // Tabs this extension activated or removed itself, so the events these
  // operations fire are never read as the user's doing.
  const ownActivations = new Set();
  const ownRemovals = new Set();
  // Windows whose tabs are being closed with the window; they are left alone.
  const closingWindows = new Set();
  let draining = null;

  function note(hint) {
    if (hint.type === 'removed' && hint.windowClosing) closingWindows.add(hint.windowId);
    hints.push(hint);
    draining ??= drain();
  }

  async function drain() {
    while (hints.length > 0) {
      const batch = hints.splice(0);
      try {
        await pass(batch);
      } catch (error) {
        console.error('Synced Pins could not update the pinned tabs', error);
      }
    }
    draining = null;
  }

  async function pass(batch) {
    const stored = await chrome.storage.session.get(STATE_KEYS);
    let state;
    if (stored.pins) {
      state = structuredClone(stored);
      if (batch.every((hint) => hint.type === 'focused')) {
        applyFocus(state, batch);
        await save(stored, state);
        return;
      }
    } else {
      // Hints gathered before the pin list exists describe tabs the rebuild
      // reads directly, so they are dropped.
      const installed = batch.find((hint) => hint.type === 'installed');
      state = await rebuild(installed?.reason);
      batch = [];
    }
    const { removed, summons } = await applyHints(state, batch);
    let layout = await readLayout();
    const actions = inferUserChanges(state, layout, removed);
    await carryOut(state, layout, actions, summons);
    // The user may have pinned or reordered meanwhile; arranging from a
    // layout those changes are missing from would revert them.
    layout = await readLayout();
    locatePins(state, layout);
    adoptNewPins(state, layout);
    adoptReorder(state, layout);
    for (const window of layout.windows) await arrangeWindow(state.pins, window);
    await save(stored, await finish(state));
  }

  function applyFocus(state, batch) {
    for (const { windowId } of batch) {
      state.focusOrder = [windowId, ...state.focusOrder.filter((id) => id !== windowId)];
    }
  }

  async function save(stored, state) {
    const changed = Object.fromEntries(STATE_KEYS
      .filter((key) => JSON.stringify(stored[key]) !== JSON.stringify(state[key]))
      .map((key) => [key, state[key]]));
    if (Object.keys(changed).length > 0) await chrome.storage.session.set(changed);
  }

  // Normal windows that are not closing, with their tabs in strip order.
  async function readLayout() {
    const windows = (await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }))
      .filter((window) => !window.incognito && !closingWindows.has(window.id) && window.tabs.length > 0);
    const tabs = new Map(windows.flatMap((window) => window.tabs.map((tab) => [tab.id, tab])));
    return { windows, tabs };
  }

  function placeholderOf(tab) {
    return readPlaceholderUrl(pageUrl, tab.pendingUrl || tab.url);
  }

  async function applyHints(state, batch) {
    const removed = new Map();
    const summons = [];
    for (const hint of batch) {
      switch (hint.type) {
        case 'focused':
          applyFocus(state, [hint]);
          break;
        case 'windowRemoved':
          closingWindows.delete(hint.windowId);
          state.focusOrder = state.focusOrder.filter((id) => id !== hint.windowId);
          delete state.activeTabs[hint.windowId];
          delete state.orders[hint.windowId];
          break;
        case 'removed':
          if (!ownRemovals.delete(hint.tabId)) removed.set(hint.tabId, hint);
          break;
        case 'replaced':
          replaceTabId(state, hint.removedTabId, hint.addedTabId);
          break;
        case 'activated': {
          const summon = await selectedPlaceholder(state, hint);
          if (summon) summons.push(summon);
          break;
        }
        case 'summon': {
          const pinId = state.placeholders[hint.tabId];
          if (pinId) summons.push({ pinId, placeholderId: hint.tabId });
          break;
        }
      }
    }
    return { removed, summons };
  }

  function replaceTabId(state, oldId, newId) {
    for (const pin of state.pins) if (pin.tabId === oldId) pin.tabId = newId;
    if (state.placeholders[oldId]) {
      state.placeholders[newId] = state.placeholders[oldId];
      delete state.placeholders[oldId];
    }
  }

  // A placeholder counts as selected by the user only when the tab selected
  // before it is still in the window. Otherwise Chromium picked it because
  // the selected tab was closed or dragged away.
  async function selectedPlaceholder(state, { tabId, windowId }) {
    const previousId = state.activeTabs[windowId];
    state.activeTabs[windowId] = tabId;
    if (ownActivations.delete(tabId)) return null;
    const pinId = state.placeholders[tabId];
    if (!pinId || previousId === undefined) return null;
    const previous = await chrome.tabs.get(previousId).catch(() => null);
    if (previous?.windowId !== windowId) return null;
    return { pinId, placeholderId: tabId };
  }

  // Compares the tabs with the pin list of the previous pass. Differences the
  // extension did not cause are the user's: pinning, unpinning, closing,
  // reordering, dragging a pin to another window, or the live page changing.
  function inferUserChanges(state, layout, removed) {
    const ended = new Map();
    const died = new Set();
    const unpinnedPlaceholders = [];
    for (const pin of state.pins) {
      const tab = layout.tabs.get(pin.tabId);
      if (!tab) {
        const removal = removed.get(pin.tabId);
        if (removal?.windowClosing) died.add(pin.id);
        else if (removal) ended.set(pin.id, { closeLiveTab: false });
        continue;
      }
      if (!tab.pinned) {
        ended.set(pin.id, { closeLiveTab: false });
        continue;
      }
      Object.assign(pin, liveTabDetails(tab));
    }
    for (const [tabId, pinId] of Object.entries(state.placeholders)) {
      const tab = layout.tabs.get(Number(tabId));
      if (!tab) {
        const removal = removed.get(Number(tabId));
        if (removal && !removal.windowClosing) ended.set(pinId, { closeLiveTab: true });
      } else if (!tab.pinned && placeholderOf(tab)?.id === pinId && !ended.has(pinId)) {
        unpinnedPlaceholders.push({ pinId, tab });
      }
    }
    adoptNewPins(state, layout);
    adoptReorder(state, layout);
    return { ended, died, unpinnedPlaceholders };
  }

  function liveTabDetails(tab) {
    return {
      windowId: tab.windowId,
      url: tab.pendingUrl || tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl,
    };
  }

  function pinIdOf(state, tab) {
    return state.pins.find((pin) => pin.tabId === tab.id)?.id ?? placeholderOf(tab)?.id;
  }

  // A pinned tab that is neither a live pin nor a placeholder was pinned by
  // the user and joins the pin list right after the pin preceding it.
  function adoptNewPins(state, layout) {
    const known = new Set(state.pins.map((pin) => pin.id));
    for (const window of layout.windows) {
      let previousId = null;
      for (const tab of window.tabs.filter((candidate) => candidate.pinned)) {
        const pinId = pinIdOf(state, tab);
        if (known.has(pinId)) {
          previousId = pinId;
          continue;
        }
        if (placeholderOf(tab)) continue;
        const pin = { id: newPinId(), tabId: tab.id, ...liveTabDetails(tab) };
        const at = previousId === null ? 0 : state.pins.findIndex((candidate) => candidate.id === previousId) + 1;
        state.pins.splice(at, 0, pin);
        known.add(pin.id);
        previousId = pin.id;
      }
    }
  }

  // The known pins in a window's pinned area, in strip order.
  function pinOrder(state, window) {
    const known = new Set(state.pins.map((pin) => pin.id));
    return [...new Set(window.tabs
      .filter((tab) => tab.pinned)
      .map((tab) => pinIdOf(state, tab))
      .filter((pinId) => known.has(pinId)))];
  }

  // A window whose pins changed order since the last pass was reordered by
  // the user; its order is carried into the list, keeping the slots of pins
  // the window does not show.
  function adoptReorder(state, layout) {
    const slotOf = new Map(state.pins.map((pin, slot) => [pin.id, slot]));
    for (const window of layout.windows) {
      const order = pinOrder(state, window);
      const recorded = (state.orders[window.id] ?? []).filter((pinId) => order.includes(pinId));
      if (order.filter((pinId) => recorded.includes(pinId)).join() === recorded.join()) continue;
      const slots = order.map((pinId) => slotOf.get(pinId));
      const sorted = [...slots].sort((a, b) => a - b);
      if (slots.every((slot, index) => slot === sorted[index])) continue;
      const pins = [...state.pins];
      sorted.forEach((slot, index) => {
        pins[slot] = state.pins[slotOf.get(order[index])];
      });
      state.pins = pins;
      return;
    }
  }

  async function carryOut(state, layout, { ended, died, unpinnedPlaceholders }, summons) {
    for (const { pinId, tab } of unpinnedPlaceholders) {
      const pin = state.pins.find((candidate) => candidate.id === pinId);
      if (layout.tabs.has(pin.tabId)) await takeLiveTabUnpinned(pin, tab);
      ended.set(pinId, { closeLiveTab: false });
    }
    for (const [pinId, { closeLiveTab }] of ended) {
      const pin = state.pins.find((candidate) => candidate.id === pinId);
      if (closeLiveTab && pin && layout.tabs.has(pin.tabId)) await removeTabs([pin.tabId]);
    }
    state.pins = state.pins.filter((pin) => !ended.has(pin.id));
    for (const pin of state.pins.filter((candidate) => died.has(candidate.id))) {
      await resurrect(state, layout, pin);
    }
    state.pins = state.pins.filter((pin) => pin.tabId !== null);
    for (const { pinId, placeholderId } of summons) {
      const pin = state.pins.find((candidate) => candidate.id === pinId);
      if (pin) await bringLiveTab(pin, placeholderId);
    }
  }

  // The live tab of a pin whose window closed died with it. Its placeholder in
  // the most recently focused remaining window becomes the live tab again.
  async function resurrect(state, layout, pin) {
    const windowIds = layout.windows.map((window) => window.id);
    const windowId = state.focusOrder.find((id) => windowIds.includes(id)) ?? windowIds[0];
    pin.tabId = null;
    if (windowId === undefined) return;
    const window = layout.windows.find((candidate) => candidate.id === windowId);
    const placeholder = window.tabs.find((tab) => tab.pinned && placeholderOf(tab)?.id === pin.id);
    const tab = placeholder
      ? await edit(() => chrome.tabs.update(placeholder.id, { url: pin.url }))
      : await edit(() => chrome.tabs.create({ windowId, index: 0, pinned: true, active: false, url: pin.url }));
    pin.tabId = tab.id;
    pin.windowId = windowId;
  }

  // Swaps the live tab and the selected placeholder between their windows,
  // each taking the other's place. A window never runs out of tabs on the
  // way: the tab leaving a window that holds nothing else goes second.
  async function bringLiveTab(pin, placeholderId) {
    const [live, placeholder] = await Promise.all([
      chrome.tabs.get(pin.tabId).catch(() => null),
      chrome.tabs.get(placeholderId).catch(() => null),
    ]);
    if (!live || !placeholder || live.windowId === placeholder.windowId) return;
    if (placeholderOf(placeholder)?.id !== pin.id) return;
    const moveLive = async () => {
      await placePinned(live.id, placeholder.windowId, placeholder.index);
      if (placeholder.active) await edit(() => chrome.tabs.update(live.id, { active: true }));
    };
    const movePlaceholder = async () => {
      const moved = await placePinned(placeholder.id, live.windowId, live.index);
      if (live.active) await activate(moved);
    };
    const [sourceCount, targetCount] = await Promise.all([
      tabCount(live.windowId),
      tabCount(placeholder.windowId),
    ]);
    if (sourceCount > 1) {
      await moveLive();
      await movePlaceholder();
    } else if (targetCount > 1) {
      await movePlaceholder();
      await moveLive();
    } else {
      const replacement = await edit(() => chrome.tabs.create({
        windowId: live.windowId, index: live.index, pinned: true, active: false, url: placeholderUrl(pageUrl, pin),
      }));
      await activate(replacement);
      await moveLive();
      await removeTabs([placeholder.id]);
    }
  }

  // Unpinning a placeholder ends its pin, with the live tab taking the
  // placeholder's place as an ordinary tab.
  async function takeLiveTabUnpinned(pin, placeholder) {
    const live = await chrome.tabs.get(pin.tabId);
    await keepWindowOpen(live.windowId, 1);
    const moved = await edit(() => chrome.tabs.move(live.id, { windowId: placeholder.windowId, index: placeholder.index }));
    if (moved.pinned) {
      await edit(() => chrome.tabs.update(live.id, { pinned: false }));
      await edit(() => chrome.tabs.move(live.id, { index: placeholder.index }));
    }
    if (placeholder.active) await edit(() => chrome.tabs.update(live.id, { active: true }));
    await removeTabs([placeholder.id]);
  }

  // Moving a tab to another window unpins it, so it is pinned again and then
  // put at its index, which only exists inside the pinned area once pinned.
  async function placePinned(tabId, windowId, index) {
    let tab = await edit(() => chrome.tabs.move(tabId, { windowId, index }));
    if (!tab.pinned) tab = await edit(() => chrome.tabs.update(tabId, { pinned: true }));
    if (tab.index !== index) tab = await edit(() => chrome.tabs.move(tabId, { index }));
    return tab;
  }

  async function activate(tab) {
    if (tab.active) return;
    ownActivations.add(tab.id);
    await edit(() => chrome.tabs.update(tab.id, { active: true }));
  }

  async function tabCount(windowId) {
    return (await chrome.tabs.query({ windowId })).length;
  }

  // Chromium closes a window whose last tab goes, so a window about to lose
  // all its tabs first gets a New Tab page.
  async function keepWindowOpen(windowId, leaving) {
    if (await tabCount(windowId) <= leaving) {
      await edit(() => chrome.tabs.create({ windowId, active: false }));
    }
  }

  async function removeTabs(tabIds) {
    const leaving = new Map();
    for (const tab of await Promise.all(tabIds.map((id) => chrome.tabs.get(id)))) {
      leaving.set(tab.windowId, (leaving.get(tab.windowId) ?? 0) + 1);
    }
    for (const [windowId, count] of leaving) await keepWindowOpen(windowId, count);
    for (const id of tabIds) ownRemovals.add(id);
    await edit(() => chrome.tabs.remove(tabIds));
  }

  // Makes the window's pinned area hold, in list order, each pin's live tab
  // where it lives and exactly one placeholder everywhere else, touching only
  // what differs.
  async function arrangeWindow(pins, window) {
    const pinned = window.tabs.filter((tab) => tab.pinned);
    const used = new Set();
    const wanted = pins.map((pin) => {
      const tab = pin.windowId === window.id
        ? pinned.find((candidate) => candidate.id === pin.tabId)
        : pinned.find((candidate) => !used.has(candidate.id) && placeholderOf(candidate)?.id === pin.id);
      if (!tab) return { pin };
      used.add(tab.id);
      return { tabId: tab.id };
    });
    await refreshFrozenPlaceholders(pins, pinned);
    let order = pinned.map((tab) => tab.id);
    for (const [index, slot] of wanted.entries()) {
      if (slot.pin) {
        if (slot.pin.windowId === window.id) continue;
        const tab = await edit(() => chrome.tabs.create({
          windowId: window.id, index, pinned: true, active: false, url: placeholderUrl(pageUrl, slot.pin),
        }));
        order.splice(index, 0, tab.id);
      } else if (order[index] !== slot.tabId) {
        await edit(() => chrome.tabs.move(slot.tabId, { index }));
        order = order.filter((id) => id !== slot.tabId);
        order.splice(index, 0, slot.tabId);
      }
    }
    const extras = pinned.filter((tab) => !used.has(tab.id) && placeholderOf(tab));
    if (extras.length > 0) await removeTabs(extras.map((tab) => tab.id));
  }

  // A placeholder page keeps its title, icon and URL current itself, but a
  // page the browser froze in the background runs no script, so it is loaded
  // again with the current details instead.
  async function refreshFrozenPlaceholders(pins, tabs) {
    for (const tab of tabs.filter((candidate) => candidate.frozen)) {
      const pin = pins.find((candidate) => candidate.id === placeholderOf(tab)?.id);
      const url = pin && placeholderUrl(pageUrl, pin);
      if (url && url !== (tab.pendingUrl || tab.url)) await edit(() => chrome.tabs.update(tab.id, { url }));
    }
  }

  function locatePins(state, layout) {
    for (const pin of state.pins) {
      const tab = layout.tabs.get(pin.tabId);
      if (tab) pin.windowId = tab.windowId;
    }
  }

  // Records where the pins ended up, which tabs are placeholders and the order
  // each window shows. An unpinned placeholder stays recorded so the next
  // pass sees the unpinning, and one missing from the tabs stays recorded
  // until its removal event tells whether the user closed it, unless the
  // extension removed it.
  async function finish(state) {
    const layout = await readLayout();
    locatePins(state, layout);
    const pinIds = new Set(state.pins.map((pin) => pin.id));
    const placeholders = {};
    for (const [tabId, pinId] of Object.entries(state.placeholders)) {
      if (!layout.tabs.has(Number(tabId)) && !ownRemovals.has(Number(tabId)) && pinIds.has(pinId)) {
        placeholders[tabId] = pinId;
      }
    }
    for (const tab of layout.tabs.values()) {
      const pinId = placeholderOf(tab)?.id;
      if (pinId && pinIds.has(pinId)) placeholders[tab.id] = pinId;
    }
    const activeTabs = { ...state.activeTabs };
    for (const window of layout.windows) {
      activeTabs[window.id] ??= window.tabs.find((tab) => tab.active)?.id;
    }
    // Every window was arranged in list order; recording that rather than
    // what the tabs show now leaves a reorder made meanwhile for the next pass.
    const pinIdsInOrder = state.pins.map((pin) => pin.id);
    const orders = Object.fromEntries(layout.windows.map((window) => [window.id, pinIdsInOrder]));
    return { ...state, placeholders, activeTabs, orders };
  }

  // Builds the pin list from the tabs alone, after browser start, install,
  // update or re-enabling. Pinned pages are live tabs and placeholders carry
  // their pin in their URL. Pins sharing a URL, ignoring the fragment, are
  // merged into one; a pin left with only placeholders gets its page back in
  // one of them.
  async function rebuild(installReason) {
    if (installReason === 'update') await unpinLeftoverNewTabs();
    const layout = await readLayout();
    const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    const windows = [...layout.windows].sort((a, b) => (b.id === lastFocused?.id) - (a.id === lastFocused?.id));
    const pins = [];
    const byUrl = new Map();
    // Pins found through their live tab take the id their placeholders carry,
    // so those placeholders stay in place.
    const withNewId = new Set();
    const duplicates = [];
    const placeholders = [];
    for (const window of windows) {
      for (const tab of window.tabs.filter((candidate) => candidate.pinned)) {
        const described = placeholderOf(tab);
        const key = urlWithoutFragment(described?.url ?? (tab.pendingUrl || tab.url));
        let pin = byUrl.get(key);
        if (described) {
          if (!pin) {
            pin = { ...described, tabId: null, windowId: null };
            byUrl.set(key, pin);
            pins.push(pin);
          } else if (withNewId.delete(pin)) {
            pin.id = described.id;
          }
          placeholders.push({ pin, tab });
        } else if (!pin) {
          pin = { id: newPinId(), tabId: tab.id, ...liveTabDetails(tab) };
          withNewId.add(pin);
          byUrl.set(key, pin);
          pins.push(pin);
        } else if (pin.tabId === null) {
          Object.assign(pin, { tabId: tab.id, ...liveTabDetails(tab) });
        } else {
          duplicates.push({ pin, tab });
        }
      }
    }
    for (const { pin, tab } of duplicates) {
      await edit(() => chrome.tabs.update(tab.id, { url: placeholderUrl(pageUrl, pin) }));
    }
    for (const pin of pins.filter((candidate) => candidate.tabId === null)) {
      const { tab } = placeholders.find((placeholder) => placeholder.pin === pin);
      await edit(() => chrome.tabs.update(tab.id, { url: pin.url }));
      Object.assign(pin, { tabId: tab.id, windowId: tab.windowId });
    }
    const activeTabs = Object.fromEntries(layout.windows.map((window) => [
      window.id, window.tabs.find((tab) => tab.active)?.id,
    ]));
    return { pins, placeholders: {}, activeTabs, focusOrder: lastFocused ? [lastFocused.id] : [], orders: {} };
  }

  async function unpinLeftoverNewTabs() {
    const tabs = await chrome.tabs.query({ pinned: true, windowType: 'normal' });
    for (const tab of tabs.filter((candidate) => (candidate.pendingUrl || candidate.url) === NEW_TAB_URL)) {
      await edit(() => chrome.tabs.update(tab.id, { pinned: false }));
    }
  }

  return { note };
}

function newPinId() {
  return crypto.randomUUID().slice(0, 8);
}

function urlWithoutFragment(url) {
  return url.split('#')[0];
}

async function edit(operation) {
  for (const delay of BUSY_RETRY_DELAYS_MS) {
    try {
      return await operation();
    } catch (error) {
      if (!String(error?.message).includes(TAB_STRIP_BUSY)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return operation();
}
