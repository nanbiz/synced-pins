import { placeholderUrl, readPlaceholderUrl } from './placeholder-url.js';

// Chromium refuses tab edits while the user drags a tab; the drag ends within
// moments, so edits are retried after these pauses before giving up.
const TAB_STRIP_BUSY = 'Tabs cannot be edited right now';
const BUSY_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600];

// Reloading the extension, which reports the install reason "update", makes
// Chromium close the old version's pages, except that a window's last tab is
// turned into the New Tab page and stays pinned. Chromium's New Tab page has
// the host newtab under the browser's own scheme: chrome://newtab/,
// edge://newtab/ and so on.
function isNewTabPage(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return hostname === 'newtab' && !['http:', 'https:', 'file:'].includes(protocol);
  } catch {
    return false;
  }
}

const STATE_KEYS = ['pins', 'placeholders', 'focusOrder', 'orders'];

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
  // Tabs this extension removed itself, so the events these removals fire
  // are never read as the user closing them.
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
    const rebuilding = !stored.pins;
    if (!rebuilding) {
      state = structuredClone(stored);
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
    // A rebuild reads the tabs while Chromium may still be closing the old
    // version's placeholder pages; which tab a window selects is settled by
    // the events that follow, and the next pass places the pins from those.
    for (const summon of rebuilding ? [] : placeByPrecedence(state, await readLayout())) {
      const pin = state.pins.find((candidate) => candidate.id === summon.pinId);
      if (pin) await bringLiveTab(pin, summon.placeholderId);
    }
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
          delete state.orders[hint.windowId];
          break;
        case 'removed':
          if (!ownRemovals.delete(hint.tabId)) removed.set(hint.tabId, hint);
          break;
        case 'replaced':
          replaceTabId(state, hint.removedTabId, hint.addedTabId);
          break;
        case 'summon': {
          const pinId = state.placeholders[hint.tabId];
          if (!pinId) break;
          // Acting on a placeholder page is using its window, even where no
          // focus event reported it, so placement ranks that window first
          // and keeps the pin there.
          applyFocus(state, [hint]);
          summons.push({ pinId, placeholderId: hint.tabId });
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
      ? await navigatePinned(placeholder, pin.url)
      : await createPinned({ windowId, index: 0, active: false, url: pin.url });
    pin.tabId = tab.id;
    pin.windowId = windowId;
  }

  // A pin's live tab goes to the window whose selected tab is that pin, its
  // live tab or a placeholder; when several windows show it, to the one
  // focused most recently. Focus and tab selection fire events, so this runs
  // on every change without polling.
  function placeByPrecedence(state, layout) {
    const rank = (window) => {
      const at = state.focusOrder.indexOf(window.id);
      return at === -1 ? Infinity : at;
    };
    const summons = [];
    for (const pin of state.pins) {
      const live = layout.tabs.get(pin.tabId);
      if (!live) continue;
      const [first] = layout.windows
        .map((window) => ({ window, tab: window.tabs.find((tab) => tab.active) }))
        .filter(({ tab }) => tab && (tab.id === live.id || placeholderOf(tab)?.id === pin.id))
        .sort((a, b) => rank(a.window) - rank(b.window));
      if (first && first.tab.id !== live.id) summons.push({ pinId: pin.id, placeholderId: first.tab.id });
    }
    return summons;
  }

  // Swaps the live tab and the selected placeholder between their windows,
  // each taking the other's place and selected there if the tab it replaces
  // was. A window never runs out of tabs on the way: the tab leaving a window
  // that holds nothing else goes second. Both tabs change windows and are
  // selected before either is pinned in place, which keeps the moment short
  // in which the first window shows the tab beside the one that left.
  async function bringLiveTab(pin, placeholderId) {
    const [live, placeholder] = await Promise.all([
      chrome.tabs.get(pin.tabId).catch(() => null),
      chrome.tabs.get(placeholderId).catch(() => null),
    ]);
    if (!live || !placeholder || live.windowId === placeholder.windowId) return;
    if (placeholderOf(placeholder)?.id !== pin.id) return;
    const moveInto = async (tab, into) => {
      await edit(() => chrome.tabs.move(tab.id, { windowId: into.windowId, index: into.index }));
      if (into.active) await edit(() => chrome.tabs.update(tab.id, { active: true }));
    };
    const [sourceCount, targetCount] = await Promise.all([
      tabCount(live.windowId),
      tabCount(placeholder.windowId),
    ]);
    if (sourceCount > 1 || targetCount > 1) {
      const [first, second] = sourceCount > 1 ? [live, placeholder] : [placeholder, live];
      await moveInto(first, second);
      await moveInto(second, first);
      await placePinned(live.id, placeholder.windowId, placeholder.index);
      await placePinned(placeholder.id, live.windowId, live.index);
      return;
    }
    // Chromium closes a window whose last tab leaves, and creating a tab
    // makes Vivaldi focus its window, so a new placeholder is made only when
    // both windows hold nothing else.
    const replacement = await createPinned({
      windowId: live.windowId, index: live.index, active: false, url: placeholderUrl(pageUrl, pin),
    });
    await edit(() => chrome.tabs.update(replacement.id, { active: true }));
    await moveInto(live, placeholder);
    await placePinned(live.id, placeholder.windowId, placeholder.index);
    await removeTabs([placeholder.id]);
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

  // Vivaldi ignores the pinned property of chrome.tabs.create and makes an
  // ordinary tab, so such a tab is pinned afterwards and put at its index.
  async function createPinned(properties) {
    const tab = await edit(() => chrome.tabs.create({ ...properties, pinned: true }));
    return tab.pinned ? tab : placePinned(tab.id, tab.windowId, properties.index);
  }

  // Vivaldi by default keeps a pinned tab on its site and opens a page from
  // another site in a new tab instead, so the tab is unpinned while it
  // navigates and then pinned again in its place.
  async function navigatePinned(tab, url) {
    await edit(() => chrome.tabs.update(tab.id, { pinned: false }));
    await edit(() => chrome.tabs.update(tab.id, { url }));
    return placePinned(tab.id, tab.windowId, tab.index);
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
        const tab = await createPinned({
          windowId: window.id, index, active: false, url: placeholderUrl(pageUrl, slot.pin),
        });
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
    // Every window was arranged in list order; recording that rather than
    // what the tabs show now leaves a reorder made meanwhile for the next pass.
    const pinIdsInOrder = state.pins.map((pin) => pin.id);
    const orders = Object.fromEntries(layout.windows.map((window) => [window.id, pinIdsInOrder]));
    return { ...state, placeholders, orders };
  }

  // Builds the pin list from the tabs alone, after browser start, install,
  // update or re-enabling. Pinned pages are live tabs and placeholders carry
  // their pin in their URL. Pins sharing a URL, ignoring the fragment, are
  // merged into one, whose live tab is a loaded one where there is a choice:
  // a tab the browser restored or discarded without loading shows no page.
  // A pin left with only placeholders gets its page back in one of them.
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
    const liveTabs = new Map();
    const unloaded = (tab) => tab.status === 'unloaded' || tab.discarded;
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
          liveTabs.set(pin, tab);
        } else if (pin.tabId === null) {
          Object.assign(pin, { tabId: tab.id, ...liveTabDetails(tab) });
          liveTabs.set(pin, tab);
        } else if (unloaded(liveTabs.get(pin)) && !unloaded(tab)) {
          duplicates.push({ pin, tab: liveTabs.get(pin) });
          Object.assign(pin, { tabId: tab.id, ...liveTabDetails(tab) });
          liveTabs.set(pin, tab);
        } else {
          duplicates.push({ pin, tab });
        }
      }
    }
    for (const { pin, tab } of duplicates) {
      await navigatePinned(tab, placeholderUrl(pageUrl, pin));
    }
    for (const pin of pins.filter((candidate) => candidate.tabId === null)) {
      const { tab } = placeholders.find((placeholder) => placeholder.pin === pin);
      await navigatePinned(tab, pin.url);
      Object.assign(pin, { tabId: tab.id, windowId: tab.windowId });
    }
    return { pins, placeholders: {}, focusOrder: lastFocused ? [lastFocused.id] : [], orders: {} };
  }

  async function unpinLeftoverNewTabs() {
    const tabs = await chrome.tabs.query({ pinned: true, windowType: 'normal' });
    for (const tab of tabs.filter((candidate) => isNewTabPage(candidate.pendingUrl || candidate.url))) {
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
