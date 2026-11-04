// The setup page. Opened once after installation it shows the overlay's
// shortcut and offers to put it on Ctrl+T, which no extension may ask for.
// As the guide (?guide) it sits beside a window with the browser's own
// shortcuts page, where most browsers take Ctrl+T for the overlay, and walks
// the user through it; for a browser whose page refuses it, the line that
// sets it is run in the console of the extensions page instead.
const params = new URLSearchParams(location.search);
const guiding = params.has('guide');
const shortcutsWindow = Number(params.get('shortcuts'));
const command = `chrome.developerPrivate.updateExtensionCommand({ extensionId: '${chrome.runtime.id}', commandName: 'open-overlay', keybinding: 'Ctrl+T' })`;

async function overlayShortcut() {
  return (await chrome.commands.getAll()).find((entry) => entry.name === 'open-overlay')?.shortcut ?? '';
}

const isCtrlT = (shortcut) => shortcut.replace(/\s/g, '').toLowerCase() === 'ctrl+t';

function keys(element, text) {
  const parts = text ? text.split('+') : [];
  element.replaceChildren(...parts.flatMap((part, index) => {
    const key = document.createElement('kbd');
    key.textContent = part;
    return index === 0 ? [key] : [document.createTextNode(' + '), key];
  }));
}

// The shortcut can change in another window at any time, so both views show
// it afresh whenever they are looked at, and the guide also every moment
// while it waits.
async function showWelcome() {
  const current = await overlayShortcut();
  keys(document.getElementById('shortcut'), current || 'none');
  document.getElementById('ctrl-t').hidden = isCtrlT(current);
  document.getElementById('done').hidden = !isCtrlT(current);
}

let finished = false;
async function showGuide() {
  if (finished || !isCtrlT(await overlayShortcut())) return;
  finished = true;
  for (const id of ['page-steps', 'console-steps', 'waiting', 'copy-again', 'refuses']) document.getElementById(id).hidden = true;
  document.getElementById('worked').hidden = false;
  document.getElementById('guide-done').hidden = false;
  if (shortcutsWindow) await chrome.windows.remove(shortcutsWindow).catch(() => {});
}

if (guiding) {
  document.getElementById('welcome').hidden = true;
  document.getElementById('guide').hidden = false;
  document.body.classList.add('guiding');
  // Copying needs the page focused, which a click gives; the steps change
  // either way, and the line can be copied again.
  const copy = () => navigator.clipboard.writeText(command).catch(() => {});
  document.getElementById('refuses').addEventListener('click', async () => {
    await copy();
    document.getElementById('page-steps').hidden = true;
    document.getElementById('console-steps').hidden = false;
    document.getElementById('refuses').hidden = true;
    document.getElementById('copy-again').hidden = false;
    const [tab] = await chrome.tabs.query({ windowId: shortcutsWindow }).catch(() => []);
    if (tab) await chrome.tabs.update(tab.id, { url: 'chrome://extensions' });
  });
  document.getElementById('copy-again').addEventListener('click', copy);
  setInterval(showGuide, 400);
  showGuide();
} else {
  document.getElementById('ctrl-t').addEventListener('click', async () => {
    const { id } = await chrome.windows.getCurrent();
    await chrome.runtime.sendMessage({ type: 'openSetup', windowId: id });
  });
  document.addEventListener('visibilitychange', showWelcome);
  window.addEventListener('focus', showWelcome);
  showWelcome();
}
