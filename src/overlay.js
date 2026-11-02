import { containsWords, matchScore } from './match.js';
import { quickActions } from './quick-actions.js';

// The overlay opened instead of a new tab: type an address, a search or the
// name of an action, or pick one of the open tabs or pins, and only then does
// a tab open. It runs over a page (frame), as the toolbar button's popup
// (popup), or as a tab of its own that the closing button leaves (tab).
const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'tab';
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
const pinsRow = document.getElementById('pins');
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

async function keepQuery() {
  const text = query.value;
  await chrome.storage.session.set({ overlayQuery: { text, tabId: target?.id, at: Date.now() } });
}

async function forgetQuery() {
  await chrome.storage.session.remove('overlayQuery');
}

// A page picked in a tab of its own replaces that tab; elsewhere it opens in
// a new tab, as Zen opens it.
async function openAddress(url) {
  if (mode === 'tab') await chrome.tabs.update(target.id, { url });
  else await chrome.tabs.create({ windowId: target.windowId, url });
}

async function search(text) {
  if (mode === 'tab') await chrome.search.query({ text, tabId: target.id });
  else await chrome.search.query({ text, disposition: 'NEW_TAB' });
}

// Leaves the overlay's own tab for another one, which makes it pointless.
async function leaveOwnTab() {
  if (mode === 'tab') await chrome.tabs.remove(target.id);
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
    .map((pin) => ({ title: pin.title || pin.url, icon: iconFor(pin.url, pin.favIconUrl), kind: 'Switch to Tab', pick: () => selectPin(pin) }));
}

function tabItems(text) {
  return tabs
    .filter((tab) => tab.id !== target.id && !tab.pinned && !isPlaceholder(tab) && !isOverlay(tab))
    .filter((tab) => containsWords(text, `${tab.title ?? ''} ${tab.url ?? ''}`))
    .slice(0, MAX_TABS)
    .map((tab) => ({ title: tab.title || tab.url, icon: iconFor(tab.url, tab.favIconUrl), kind: 'Switch to Tab', pick: () => selectTab(tab) }));
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
      icon: chrome.runtime.getURL('icons/icon-32.png'),
      kind: 'Action',
      pick: () => action.run(target),
    }));
}

function results(text) {
  if (!text.trim()) return [];
  const address = addressOf(text);
  const searchItem = { title: text.trim(), icon: chrome.runtime.getURL('src/search.svg'), glyph: true, kind: 'Search', pick: () => search(text.trim()) };
  const first = address
    ? [{ title: address, icon: iconFor(address, null), kind: 'Open', pick: () => openAddress(address) }]
    : [searchItem];
  // Zen lists the actions a query names ahead of everything else.
  return [
    ...actionItems(text),
    ...first,
    ...pinItems(text),
    ...tabItems(text),
    ...(address ? [searchItem] : []),
  ];
}

function render() {
  const text = query.value;
  items = text.trim() ? results(text) : pins.map((pin) => ({ pin, pick: () => selectPin(pin) }));
  selected = Math.min(selected, Math.max(items.length - 1, 0));
  pinsRow.replaceChildren();
  resultsList.replaceChildren();
  items.forEach((item, index) => {
    const element = item.pin ? pinTile(item.pin) : row(item);
    element.classList.toggle('selected', index === selected && (!item.pin || keyboardOnPins));
    element.addEventListener('mousedown', (event) => event.preventDefault());
    element.addEventListener('click', () => pick(index));
    (item.pin ? pinsRow : resultsList).append(element);
  });
  resultsList.querySelector('.selected')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function pinTile(pin) {
  const tile = document.createElement('button');
  tile.className = 'pin';
  tile.type = 'button';
  tile.title = pin.title || pin.url;
  const icon = document.createElement('img');
  icon.src = iconFor(pin.url, pin.favIconUrl);
  icon.alt = '';
  const title = document.createElement('span');
  title.textContent = pin.title || pin.url;
  tile.append(icon, title);
  return tile;
}

function row(item) {
  const element = document.createElement('div');
  element.className = 'row';
  element.setAttribute('role', 'option');
  const icon = document.createElement('img');
  icon.src = item.icon;
  icon.alt = '';
  icon.classList.toggle('glyph', Boolean(item.glyph));
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = item.title;
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = item.kind;
  element.append(icon, title, kind);
  return element;
}

// The pin tiles take the selection only once the arrow keys reach them, so
// an empty overlay shows nothing selected.
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
    keepQuery().finally(close);
  } else if (key === 'ArrowDown' || key === 'ArrowRight' && keyboardOnPins || (event.ctrlKey && key === 'n')) {
    event.preventDefault();
    move(1);
  } else if (key === 'ArrowUp' || key === 'ArrowLeft' && keyboardOnPins || (event.ctrlKey && key === 'p')) {
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
    keepQuery().finally(close);
  }
});

window.addEventListener('focus', () => query.focus());

async function start() {
  const self = mode === 'tab' ? await chrome.tabs.getCurrent() : null;
  [tabs, { pins = [] }] = await Promise.all([
    chrome.tabs.query({ windowType: 'normal' }),
    chrome.storage.session.get('pins'),
  ]);
  pins = pins.filter((pin) => pin.url);
  target = self ?? tabs.find((tab) => tab.id === Number(params.get('tab')));
  if (!target) return;
  const { overlayQuery } = await chrome.storage.session.get('overlayQuery');
  if (overlayQuery && overlayQuery.tabId === target.id && Date.now() - overlayQuery.at < KEEP_QUERY_MS) {
    query.value = overlayQuery.text;
    query.select();
  }
  render();
  query.focus();
}

start();
