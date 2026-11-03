import { containsWords, matchScore } from './match.js';
import { quickActions } from './quick-actions.js';

// The overlay opened instead of a new tab: type an address, a search or the
// name of an action, or pick one of the open tabs or pins, and only then does
// a tab open. It runs over a page (frame), as the toolbar button's popup
// (popup), or as a tab of its own that the closing button leaves (tab).
const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'tab';
// The tab the overlay was opened for is given up for whatever is picked: the
// overlay's own tab, or the page the toolbar button's second click closes.
const replacing = mode === 'tab' || params.get('replace') === '1';
const placeholderPage = chrome.runtime.getURL('src/placeholder.html');
const overlayPage = chrome.runtime.getURL('src/overlay.html');

// Zen keeps the text of an overlay closed without a choice for this long, so
// opening it again over the same tab brings the text back.
const KEEP_QUERY_MS = 45_000;
// Actions are offered from this many letters on, unless the name matches
// exactly or from its start, and at most this many of them.
const ACTION_MIN_QUERY = 3;
const ACTION_MIN_SCORE = 92;
const ACTION_STRONG_SCORE = 100_000;
const MAX_ACTIONS = 5;
const MAX_TABS = 6;

const query = document.getElementById('query');
const resultsList = document.getElementById('results');
document.body.classList.add(mode);

let target;
let tabs = [];
let pins = [];
let items = [];
let selected = 0;

function isPlaceholder(tab) {
  return (tab.pendingUrl || tab.url || '').startsWith(`${placeholderPage}?`);
}

function isOverlay(tab) {
  return (tab.pendingUrl || tab.url || '').startsWith(overlayPage);
}

// An action's icon, drawn in the muted grey of the extension's glyphs from
// the path its definition carries.
function glyphUrl(path) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8b8b93" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// An address as the row shows it beside the title: host and path, without
// the scheme or a leading www.
function siteOf(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname.replace(/^www\./, '')}${pathname === '/' ? '' : pathname}`;
  } catch {
    return url;
  }
}

// History and bookmarks, once the user has let the extension read them. A
// site whose name starts with what is typed is offered as the site itself,
// ahead of the search, as the address bar completes it; single pages from
// history and bookmarks come after the open tabs. They arrive asynchronously,
// so each query's are kept and the list is drawn again when they come.
const MAX_SITES = 2;
const MAX_PAGES = 4;
const MAX_BOOKMARKS = 3;
const recall = { text: null, sites: [], pages: [] };

function recalled(text) {
  if (recall.text !== text) {
    recall.text = text;
    recall.sites = [];
    recall.pages = [];
    recallFor(text).then((found) => {
      if (recall.text !== text) return;
      Object.assign(recall, found);
      if (found.sites.length + found.pages.length > 0) render();
    }, () => {});
  }
  return recall;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function recallFor(text) {
  const [history, bookmarks] = await Promise.all([
    chrome.history ? chrome.history.search({ text, startTime: 0, maxResults: 200 }) : [],
    chrome.bookmarks ? chrome.bookmarks.search(text).catch(() => []) : [],
  ]);
  const word = text.trim().toLowerCase();
  const web = (entry) => entry.url && /^https?:/.test(entry.url);
  // Sites: hosts that start with the typed word, or have a part that does,
  // ranked by how often they were visited.
  const visits = new Map();
  for (const entry of history.filter(web)) {
    const host = hostOf(entry.url);
    if (!host.split('.').some((part, index, parts) => parts.slice(index).join('.').startsWith(word))) continue;
    const site = visits.get(host) ?? { host, origin: new URL(entry.url).origin, count: 0 };
    site.count += (entry.visitCount ?? 1) + 2 * (entry.typedCount ?? 0);
    visits.set(host, site);
  }
  const sites = [...visits.values()]
    .sort((a, b) => (b.host.startsWith(word) - a.host.startsWith(word)) || b.count - a.count)
    .slice(0, MAX_SITES)
    .map((site) => ({ title: site.host, url: `${site.origin}/`, favIconUrl: null, kind: 'Site', pick: () => openAddress(`${site.origin}/`) }));
  const shown = new Set([...tabs.map((tab) => tab.url), ...pins.map((pin) => pin.url), ...sites.map((site) => site.url)]);
  const take = (entries, max, kind) => entries
    .filter(web)
    .filter((entry) => containsWords(text, `${entry.title ?? ''} ${entry.url}`))
    .filter((entry) => !shown.has(entry.url) && shown.add(entry.url))
    .slice(0, max)
    .map((entry) => ({ title: entry.title || siteOf(entry.url), url: entry.url, favIconUrl: null, kind, pick: () => openAddress(entry.url) }));
  const ranked = [...history].sort((a, b) => (b.typedCount ?? 0) - (a.typedCount ?? 0) || (b.visitCount ?? 0) - (a.visitCount ?? 0));
  return { sites, pages: [...take(ranked, MAX_PAGES, 'History'), ...take(bookmarks, MAX_BOOKMARKS, 'Bookmark')] };
}

// A pin's name: its own title, else that of its open tab, else its site.
function pinName(pin) {
  const live = tabs.find((tab) => tab.id === pin.tabId && !isPlaceholder(tab));
  if (pin.title || live?.title) return pin.title || live.title;
  try {
    return new URL(pin.url).hostname.replace(/^www\./, '');
  } catch {
    return pin.url;
  }
}

// An icon element that falls back to the browser's own copy of the site's
// icon where the site does not let other pages load it.
function iconImage(url, favIconUrl) {
  const icon = document.createElement('img');
  icon.alt = '';
  icon.src = iconFor(url, favIconUrl);
  icon.addEventListener('error', () => {
    const stored = iconFor(url, null);
    if (icon.src !== stored) icon.src = stored;
  }, { once: true });
  return icon;
}

function iconFor(url, favIconUrl) {
  if (favIconUrl && !favIconUrl.startsWith('chrome://')) return favIconUrl;
  return chrome.runtime.getURL(`/_favicon/?${new URLSearchParams({ pageUrl: url, size: 32 })}`);
}

// Turns typed text into an address where it reads as one: a scheme, or one
// word with a dot, a port or localhost.
function addressOf(text) {
  const value = text.trim();
  if (!value || /\s/.test(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(about|chrome|data|file|view-source):/i.test(value)) return value;
  const host = value.split(/[/?#]/)[0];
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/i.test(host)) return `http://${value}`;
  if (/^[^.:]+(\.[^.:]+)*\.[a-z]{2,}(:\d+)?$/i.test(host) || /^\[[0-9a-f:]+\](:\d+)?$/i.test(host)) return `https://${value}`;
  return null;
}

function close() {
  if (mode === 'frame') window.parent.postMessage('synced-pins:close', '*');
  else if (mode === 'popup') window.close();
}

// Leaving without a choice. The overlay that took a New Tab page's place goes
// with its tab, back to the tab selected before, as long as the window keeps
// another tab.
async function dismiss() {
  await keepQuery();
  if (mode === 'tab' && params.get('newtab') === '1' && target) {
    const others = (await chrome.tabs.query({ windowId: target.windowId })).filter((tab) => tab.id !== target.id);
    if (others.length > 0) {
      const back = others.find((tab) => tab.id === Number(params.get('back')));
      if (back) await chrome.tabs.update(back.id, { active: true });
      await chrome.tabs.remove(target.id);
      return;
    }
  }
  close();
}

async function keepQuery() {
  const text = query.value;
  await chrome.storage.session.set({ overlayQuery: { text, tabId: target?.id, at: Date.now() } });
}

async function forgetQuery() {
  await chrome.storage.session.remove('overlayQuery');
}

// A page picked loads in the tab being given up; elsewhere it opens in a new
// tab, as Zen opens it.
async function openAddress(url) {
  if (replacing) await chrome.tabs.update(target.id, { url });
  else await chrome.tabs.create({ windowId: target.windowId, url });
}

async function search(text) {
  if (replacing) await chrome.search.query({ text, tabId: target.id });
  else await chrome.search.query({ text, disposition: 'NEW_TAB' });
}

// Switching to another tab closes the tab being given up.
async function leaveOwnTab() {
  if (replacing) await chrome.tabs.remove(target.id);
}

async function selectTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== target.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  await leaveOwnTab();
}

// A pin is selected in this window: its live tab where it lives here, or its
// placeholder, which brings the live page over.
async function selectPin(pin) {
  const here = tabs.filter((tab) => tab.windowId === target.windowId);
  const live = here.find((tab) => tab.id === pin.tabId);
  const placeholder = here.find((tab) => isPlaceholder(tab)
    && new URLSearchParams((tab.pendingUrl || tab.url).split('?')[1]).get('pin') === pin.id);
  const tab = live ?? placeholder ?? tabs.find((other) => other.id === pin.tabId);
  if (tab) await selectTab(tab);
}

function pinItems(text) {
  return pins
    .filter((pin) => containsWords(text, `${pin.title ?? ''} ${pin.url}`))
    .map((pin) => ({ title: pinName(pin), url: pin.url, favIconUrl: pin.favIconUrl, kind: 'Switch to Tab', pick: () => selectPin(pin) }));
}

function tabItems(text) {
  return tabs
    .filter((tab) => tab.id !== target.id && !tab.pinned && !isPlaceholder(tab) && !isOverlay(tab))
    .filter((tab) => containsWords(text, `${tab.title ?? ''} ${tab.url ?? ''}`))
    .slice(0, MAX_TABS)
    .map((tab) => ({ title: tab.title || tab.url, url: tab.url, favIconUrl: tab.favIconUrl, kind: 'Switch to Tab', pick: () => selectTab(tab) }));
}

function actionItems(text) {
  return quickActions
    .filter((action) => action.available(target))
    .map((action) => ({ action, score: matchScore(text, action.label) }))
    .filter(({ score }) => score !== null
      && (score >= ACTION_STRONG_SCORE || (text.trim().length >= ACTION_MIN_QUERY && score > ACTION_MIN_SCORE)))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ACTIONS)
    .map(({ action, score }) => ({
      title: action.label,
      icon: glyphUrl(action.glyph),
      glyph: true,
      kind: 'Action',
      pick: () => action.run(target),
    }));
}

function results(text) {
  if (!text.trim()) return [];
  const address = addressOf(text);
  const searchItem = { title: text.trim(), icon: chrome.runtime.getURL('src/search.svg'), glyph: true, kind: 'Search', pick: () => search(text.trim()) };
  const first = address
    ? [{ title: address, url: address, favIconUrl: null, kind: 'Open', pick: () => openAddress(address) }]
    : [searchItem];
  const { sites, pages } = recalled(text);
  // Zen lists the actions a query names ahead of everything else.
  return [
    ...actionItems(text),
    ...(address ? [] : sites),
    ...first,
    ...pinItems(text),
    ...tabItems(text),
    ...pages,
    ...(address ? [searchItem] : []),
  ];
}

// With nothing typed the overlay lists the pins; nothing is selected until
// the arrow keys move into the list.
function pinRows() {
  return pins.map((pin) => ({ title: pinName(pin), url: pin.url, favIconUrl: pin.favIconUrl, kind: 'Pinned', pick: () => selectPin(pin) }));
}

function render() {
  const text = query.value;
  items = text.trim() ? results(text) : pinRows();
  selected = Math.min(selected, Math.max(items.length - 1, 0));
  resultsList.replaceChildren();
  items.forEach((item, index) => {
    const element = row(item);
    element.classList.toggle('selected', index === selected && (text.trim() !== '' || keyboardOnPins));
    element.addEventListener('mousedown', (event) => event.preventDefault());
    element.addEventListener('click', () => pick(index));
    resultsList.append(element);
  });
  resultsList.querySelector('.selected')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function row(item) {
  const element = document.createElement('div');
  element.className = 'row';
  element.setAttribute('role', 'option');
  const icon = item.icon ? document.createElement('img') : iconImage(item.url, item.favIconUrl);
  if (item.icon) {
    icon.src = item.icon;
    icon.alt = '';
  }
  icon.classList.toggle('glyph', Boolean(item.glyph));
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = item.title;
  const site = document.createElement('span');
  site.className = 'site';
  site.textContent = item.url && item.kind !== 'Open' && item.kind !== 'Site' ? siteOf(item.url) : '';
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = item.kind;
  element.append(icon, title, site, kind);
  return element;
}

// The pin list takes the selection only once the arrow keys reach it.
let keyboardOnPins = false;

async function pick(index) {
  const item = items[index];
  if (!item) return;
  await forgetQuery();
  try {
    await item.pick();
  } finally {
    close();
  }
}

function move(step) {
  if (items.length === 0) return;
  if (!query.value.trim() && !keyboardOnPins) {
    keyboardOnPins = true;
    selected = step > 0 ? 0 : items.length - 1;
  } else {
    selected = (selected + step + items.length) % items.length;
  }
  render();
}

query.addEventListener('input', () => {
  selected = 0;
  keyboardOnPins = false;
  render();
});

document.addEventListener('keydown', (event) => {
  const key = event.key;
  if (key === 'Escape') {
    event.preventDefault();
    dismiss();
  } else if (key === 'ArrowDown' || (event.ctrlKey && key === 'n')) {
    event.preventDefault();
    move(1);
  } else if (key === 'ArrowUp' || (event.ctrlKey && key === 'p')) {
    event.preventDefault();
    move(-1);
  } else if (key === 'Enter') {
    event.preventDefault();
    if (query.value.trim() || keyboardOnPins) pick(selected);
  }
});

// A click beside the box over a page closes the overlay, as clicking outside
// Zen's address bar does.
document.addEventListener('mousedown', (event) => {
  if (mode === 'frame' && !document.getElementById('box').contains(event.target)) {
    dismiss();
  }
});

window.addEventListener('focus', () => query.focus());

const setup = document.getElementById('setup');

// The row stays until the overlay is on Ctrl+T or the row is dismissed.
// Vivaldi, which marks its tabs with vivExtData, keeps Ctrl+T for its own new
// tab, which becomes the overlay anyway, so it is offered nothing there.
async function offerSetup() {
  const [commands, { setupDismissed }, [anyTab]] = await Promise.all([
    chrome.commands.getAll(),
    chrome.storage.local.get('setupDismissed'),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
  ]);
  const command = commands.find((candidate) => candidate.name === 'open-overlay');
  setup.hidden = setupDismissed || command?.shortcut === 'Ctrl+T' || (anyTab !== undefined && 'vivExtData' in anyTab);
}

for (const button of setup.querySelectorAll('button')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
}
document.getElementById('setup-open').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html'), windowId: target?.windowId });
  close();
});
document.getElementById('setup-dismiss').addEventListener('click', async () => {
  setup.hidden = true;
  query.focus();
  await chrome.storage.local.set({ setupDismissed: true });
});

const historyOffer = document.getElementById('history');
const RECALL = { permissions: ['history', 'bookmarks'] };

// The row stays until history and bookmarks may be read or it is dismissed.
async function offerHistory() {
  const [allowed, { historyDismissed }] = await Promise.all([
    chrome.permissions.contains(RECALL),
    chrome.storage.local.get('historyDismissed'),
  ]);
  historyOffer.hidden = allowed || historyDismissed === true;
}

for (const button of historyOffer.querySelectorAll('button')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
}
document.getElementById('history-allow').addEventListener('click', async () => {
  const allowed = await chrome.permissions.request(RECALL).catch(() => false);
  if (!allowed) return;
  historyOffer.hidden = true;
  recall.text = null;
  render();
  query.focus();
});
document.getElementById('history-dismiss').addEventListener('click', async () => {
  historyOffer.hidden = true;
  query.focus();
  await chrome.storage.local.set({ historyDismissed: true });
});

async function start() {
  offerSetup();
  offerHistory();
  const self = mode === 'tab' ? await chrome.tabs.getCurrent() : null;
  [tabs, { pins = [] }] = await Promise.all([
    chrome.tabs.query({ windowType: 'normal' }),
    chrome.storage.session.get('pins'),
  ]);
  pins = pins.filter((pin) => pin.url);
  target = self ?? tabs.find((tab) => tab.id === Number(params.get('tab')));
  if (!target) {
    close();
    return;
  }
  const { overlayQuery } = await chrome.storage.session.get('overlayQuery');
  if (overlayQuery && overlayQuery.tabId === target.id && Date.now() - overlayQuery.at < KEEP_QUERY_MS) {
    query.value = overlayQuery.text;
    query.select();
  }
  render();
  query.focus();
  if (mode === 'frame') requestAnimationFrame(() => window.parent.postMessage('synced-pins:ready', '*'));
}

start();
