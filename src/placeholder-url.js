// A placeholder tab carries its pin in its own URL, so a restored session
// still knows which page each placeholder stands for.

// Data URL favicons can run to many kilobytes; past this length the icon is
// left out of the URL and the placeholder falls back to the stored pin.
const MAX_ICON_URL_LENGTH = 2048;

export function placeholderUrl(pageUrl, pin) {
  const params = new URLSearchParams({ pin: pin.id, url: pin.url, title: pin.title ?? '' });
  if (pin.favIconUrl && pin.favIconUrl.length <= MAX_ICON_URL_LENGTH) {
    params.set('icon', pin.favIconUrl);
  }
  return `${pageUrl}?${params}`;
}

// Returns the pin described by a placeholder URL, or null for any other URL.
export function readPlaceholderUrl(pageUrl, url) {
  if (!url?.startsWith(`${pageUrl}?`)) return null;
  const params = new URLSearchParams(url.slice(pageUrl.length + 1));
  const pin = { id: params.get('pin'), url: params.get('url'), title: params.get('title') ?? '' };
  if (!pin.id || !pin.url) return null;
  const favIconUrl = params.get('icon');
  return favIconUrl ? { ...pin, favIconUrl } : pin;
}
