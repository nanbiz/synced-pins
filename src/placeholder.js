import { placeholderUrl, readPlaceholderUrl } from './placeholder-url.js';

const pageUrl = chrome.runtime.getURL('src/placeholder.html');
const fromUrl = readPlaceholderUrl(pageUrl, location.href);

// The browser's own store of site icons, for the icon of a page. For an
// address it holds no icon for it answers with the icon of the site, and for
// an unknown site with the browser's default.
function storedIcon(url) {
  return chrome.runtime.getURL(`/_favicon/?${new URLSearchParams({ pageUrl: url, size: 64 })}`);
}

// The site's own icon where it may be loaded here, else the stored one: a site
// may allow only its own pages to load its icon, as claude.ai does with
// Cross-Origin-Resource-Policy: same-origin, and the store learns the icon of
// a page only some time after the page first shows it.
let iconRequest = 0;
function showIcon(pin) {
  const request = ++iconRequest;
  const use = (src) => {
    if (request !== iconRequest) return;
    document.getElementById('icon').src = src;
    document.getElementById('favicon').href = src;
  };
  if (!pin.favIconUrl) {
    use(storedIcon(pin.url));
    return;
  }
  const probe = new Image();
  probe.onload = () => use(pin.favIconUrl);
  probe.onerror = () => use(storedIcon(pin.url));
  probe.src = pin.favIconUrl;
}

function show(pin) {
  const title = pin.title || pin.url;
  document.title = title;
  document.getElementById('title').textContent = title;
  showIcon(pin);
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
