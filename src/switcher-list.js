// Draws the list the page's script shows while Alt is held, from the tabs the
// worker gives for the tab this frame is in, and tells the page its height.

function iconFor(url, favIconUrl) {
  if (favIconUrl && !favIconUrl.startsWith('chrome://')) return favIconUrl;
  return chrome.runtime.getURL(`/_favicon/?${new URLSearchParams({ pageUrl: url, size: 32 })}`);
}

function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const tabs = await chrome.runtime.sendMessage({ type: 'switcherTabs' }) ?? [];
const list = document.getElementById('list');
for (const tab of tabs) {
  const row = document.createElement('div');
  row.className = 'row';
  row.classList.toggle('current', tab.active);
  const number = Object.assign(document.createElement('span'), { className: 'number', textContent: tab.number ?? '' });
  const icon = Object.assign(document.createElement('img'), { src: iconFor(tab.url, tab.favIconUrl), alt: '' });
  const title = Object.assign(document.createElement('span'), { className: 'title', textContent: tab.title || tab.url });
  const site = Object.assign(document.createElement('span'), { className: 'site', textContent: siteOf(tab.url) });
  row.append(number, icon, title, site);
  list.append(row);
}
window.parent.postMessage({ syncedPinsSwitcherHeight: Math.ceil(list.scrollHeight) + 80 }, '*');
