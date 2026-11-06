// Whether the overlay's command is on Ctrl+T, read from chrome.commands.getAll.
// The browser names the keys in its own language there ("Strg+T" in German,
// "⌘T" on a Mac), so the text is never compared with "Ctrl+T" itself. An
// extension's shortcut has Ctrl or Alt as its only modifier, or Command on a
// Mac, and Alt keeps its name across languages, so one modifier other than Alt
// with the T key is Ctrl+T.
export function isCtrlT(shortcut = '') {
  const text = shortcut.replace(/\s/g, '');
  if (/^⌘T$/i.test(text)) return true;
  const parts = text.split('+');
  return parts.length === 2 && parts[1].toUpperCase() === 'T' && parts[0] !== '' && parts[0].toLowerCase() !== 'alt';
}

export async function overlayShortcut() {
  return (await chrome.commands.getAll()).find((command) => command.name === 'open-overlay')?.shortcut ?? '';
}
