# Privacy

Synced Pins does not collect, send or share any data. The only network requests it causes are its stand-in pages loading each pinned site's own icon, the same one the browser shows for that tab; where a site does not let other pages load its icon, they take it from the browser's own store of site icons instead.

To show your pinned tabs in every window, it reads the address, title and icon of the tabs you pin. It keeps that list in the browser's session storage, which is cleared when the browser quits, and in the address of its own stand-in pages, so the browser can restore them with your session. The address, title and icon of each pinned tab also stay in the extension's local storage, so the pin comes back when the browser starts again, until you unpin that tab or remove the extension. It reads nothing from the pages themselves. It looks at the addresses of your other tabs only to recognise its own stand-in pages, and keeps none of them.

Questions go to the [issue tracker](https://github.com/nanbiz/synced-pins/issues).
