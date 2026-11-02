// The page opened on install and on the update that brought the overlay: it
// shows the overlay's shortcut and helps put it on Ctrl+T, which no
// extension may ask for and the browser's shortcuts page cannot record, but a
// line run on chrome://extensions can set.
const shortcut = document.getElementById('shortcut');
const change = document.getElementById('change');
const useCtrlT = document.getElementById('ctrl-t');
const done = document.getElementById('done');
const steps = document.getElementById('steps');

const command = `chrome.developerPrivate.updateExtensionCommand({ extensionId: '${chrome.runtime.id}', commandName: 'open-overlay', keybinding: 'Ctrl+T' })`;

function keys(text) {
  const parts = text ? text.split('+') : [];
  shortcut.replaceChildren(...parts.flatMap((part, index) => {
    const key = document.createElement('kbd');
    key.textContent = part;
    return index === 0 ? [key] : [document.createTextNode(' + '), key];
  }));
}

// The shortcut can change in another tab at any time, so the page shows it
// afresh whenever it is looked at.
async function show() {
  const overlay = (await chrome.commands.getAll()).find((entry) => entry.name === 'open-overlay');
  const current = overlay?.shortcut ?? '';
  keys(current || 'none');
  const onCtrlT = current.replace(/\s/g, '').toLowerCase() === 'ctrl+t';
  useCtrlT.hidden = onCtrlT;
  done.hidden = !onCtrlT;
  if (onCtrlT) steps.hidden = true;
}

change.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
let extensionsOpened = false;
useCtrlT.addEventListener('click', async () => {
  await navigator.clipboard.writeText(command);
  steps.hidden = false;
  useCtrlT.textContent = 'Copy again';
  useCtrlT.classList.replace('primary', 'quiet');
  if (!extensionsOpened) {
    extensionsOpened = true;
    await chrome.tabs.create({ url: 'chrome://extensions' });
  }
});
document.addEventListener('visibilitychange', show);
window.addEventListener('focus', show);
show();
