// Holding Alt over a page shows the window's tabs numbered in strip order, as
// Alt with a digit selects them: 1 to 8 the tab at that place, 9 the last.
// A digit selects its tab and letting go of Alt closes the list. Runs in every
// frame of a page, since the keys go to the frame that has the focus; the list
// is drawn in the top one.
(() => {
  if (globalThis.syncedPinsSwitcher) return;
  globalThis.syncedPinsSwitcher = true;
  // Option with a digit types a character on a Mac.
  if (navigator.platform.startsWith('Mac')) return;

  // How long Alt is held before the list shows, so Alt pressed on its way to
  // another shortcut shows nothing.
  const HOLD_MS = 250;
  const top = window === window.top;
  let timer;
  let frame;
  let shown = false;

  function show() {
    if (!top) {
      window.top.postMessage({ syncedPinsSwitcher: 'show' }, '*');
      return;
    }
    if (frame) return;
    frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('src/switcher.html');
    frame.tabIndex = -1;
    frame.style.cssText = 'all:initial;position:fixed;top:40px;left:50%;transform:translateX(-50%);'
      + 'width:min(688px,100vw);height:0;border:0;margin:0;padding:0;color-scheme:light dark;'
      + 'z-index:2147483647;opacity:0;pointer-events:none';
    (document.fullscreenElement?.children ? document.fullscreenElement : document.documentElement).append(frame);
  }

  function hide() {
    clearTimeout(timer);
    timer = undefined;
    shown = false;
    if (!top) {
      window.top.postMessage({ syncedPinsSwitcher: 'hide' }, '*');
      return;
    }
    frame?.remove();
    frame = undefined;
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Alt') {
      if (event.repeat || event.ctrlKey || event.metaKey || event.shiftKey) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        shown = true;
        show();
      }, HOLD_MS);
      return;
    }
    if (!event.altKey) return;
    const digit = /^Digit([1-9])$/.exec(event.code);
    if (digit && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      hide();
      chrome.runtime.sendMessage({ type: 'switchTab', number: Number(digit[1]) }).catch(() => {});
      return;
    }
    // Alt on its way to another shortcut.
    hide();
  }, true);

  window.addEventListener('keyup', (event) => {
    if (event.key !== 'Alt') return;
    if (shown) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    hide();
  }, true);

  window.addEventListener('blur', hide);

  if (top) {
    window.addEventListener('message', (event) => {
      if (event.data?.syncedPinsSwitcher === 'show') show();
      else if (event.data?.syncedPinsSwitcher === 'hide') hide();
      else if (event.source === frame?.contentWindow && typeof event.data?.syncedPinsSwitcherHeight === 'number') {
        frame.style.height = `${Math.min(event.data.syncedPinsSwitcherHeight, window.innerHeight - 60)}px`;
        frame.style.opacity = '1';
      }
    });
  }
})();
