# Privacy

Zen Essentials in Chrome does not collect, send or share any data. The only network requests it causes are its stand-in pages loading each pinned site's own icon, the same one the browser shows for that tab, and a search you choose in its new tab overlay, which goes to your browser's default search engine as a search from the address bar would. Where a site does not let other pages load its icon, the stand-in pages take it from the browser's own store of site icons instead.

To show your pinned tabs in every window, it reads the address, title and icon of the tabs you pin. It keeps that list in the browser's session storage, which is cleared when the browser quits, and in the address of its own stand-in pages, so the browser can restore them with your session. The address, title and icon of each pinned tab also stay in the extension's local storage, so the pin comes back when the browser starts again, until you unpin that tab or remove the extension.

While its new tab overlay is open, it reads the address, title and icon of your open tabs to suggest them as you type, and keeps none of them. Text you typed into the overlay and left without choosing anything stays in session storage for 45 seconds, so reopening the overlay over the same tab brings it back. The overlay is drawn over a page only after you press its shortcut there; it reads nothing from the page. The toolbar button counts and closes the tabs of its window and reads nothing else about them.

If you allow it to open over any page, it draws the overlay over the page you were on when you open a new tab, and reads nothing from that page.

If you allow it to read your history and bookmarks, from the row the overlay offers for it, the overlay searches them for what you type while it is open, in the browser, and keeps none of it.

To find the cause of a pin that went wrong, the extension keeps a log of its recent decisions about pinned tabs in local storage, naming tabs, windows and pins by the browser's internal numbers only, without any address or title.

It reads nothing from the pages themselves.

Questions go to the [issue tracker](https://github.com/nanbiz/synced-pins/issues).
