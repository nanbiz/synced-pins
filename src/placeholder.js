import { placeholderUrl, readPlaceholderUrl } from './placeholder-url.js';

const pageUrl = chrome.runtime.getURL('src/placeholder.html');
const fromUrl = readPlaceholderUrl(pageUrl, location.href);

function show(pin) {
  const title = pin.title || pin.url;
  document.title = title;
  document.getElementById('title').textContent = title;
  const icon = document.getElementById('icon');
  const favicon = document.getElementById('favicon');
  icon.hidden = !pin.favIconUrl;
  if (pin.favIconUrl) {
    icon.src = pin.favIconUrl;
    favicon.href = pin.favIconUrl;
  } else {
    favicon.removeAttribute('href');
  }
  const url = placeholderUrl(pageUrl, pin);
  if (url !== location.href) history.replaceState(null, '', url);
}

function showStored(pins) {
  const pin = pins?.find((candidate) => candidate.id === fromUrl?.id);
  if (pin) show(pin);
}

// A change event can arrive before the initial read resolves; the read then
// holds older pins and is ignored.
let changed = false;
if (fromUrl) show(fromUrl);
chrome.storage.session.onChanged.addListener((changes) => {
  if (!changes.pins) return;
  changed = true;
  showStored(changes.pins.newValue);
});
chrome.storage.session.get('pins').then(({ pins }) => {
  if (!changed) showStored(pins);
});
document.getElementById('summon').addEventListener('click', () => chrome.runtime.sendMessage('summon'));
