# Chrome Web Store listing

Fields as the developer dashboard asks for them. The package is the release zip
(`node scripts/package.js` builds the same file).

## Store listing

- Name and summary come from manifest.json.
- Category: Tools
- Language: English
- Store icon: icons/icon-128.png
- Screenshots: store/screenshot-1.png, store/screenshot-2.png
- Small promo tile: store/promo-small-440x280.png
- Homepage: https://github.com/nanbiz/synced-pins
- Support: https://github.com/nanbiz/synced-pins/issues

Description:

Every window gets the same pinned tabs, like Essentials in the Zen browser.

Each pinned tab is open in one window. Your other windows show it in the same place, with its icon, and selecting it there brings the page over as it is: nothing reloads, a video keeps playing, a half-typed message stays. Switching to a window that shows a pinned tab brings the page back there too. A window showing one of its own tabs takes nothing, so a pinned tab can keep running in one window while you work in another.

Pin, unpin, close or reorder a pinned tab in any window and every window follows. Close the window a pinned tab is open in and it opens again in the window you used last. Popups, installed web apps and incognito windows are left alone.

Nothing is collected or sent anywhere. Source: https://github.com/nanbiz/synced-pins

## Privacy practices

- Single purpose: Show the same pinned tabs in every browser window, moving a pinned tab's page to the window where the user selects it.
- tabs: Reads the address, title and icon of the user's pinned tabs so the extension can show them in the user's other windows and reopen one whose window was closed.
- storage: Keeps the list of pinned tabs in session storage while the browser runs.
- Remote code: No.
- Data usage: no data collected; certify the three statements (not sold, not used for unrelated purposes, not used for creditworthiness).
- Privacy policy: https://github.com/nanbiz/synced-pins/blob/main/PRIVACY.md
