# Chrome Web Store listing

Fields as the developer dashboard asks for them. The package is the release zip
(`node scripts/package.js` builds the same file).

## Store listing

- Name and summary come from manifest.json.
- Category: Tools
- Language: English
- Store icon: icons/icon-128.png
- Screenshots: store/screenshot-1.png, store/screenshot-2.png, store/screenshot-3.png
- Promo video: dist/promo.mp4 from `sh scripts/capture-store-assets.sh promo`, captions from store/promo-captions.json, uploaded to YouTube and linked here
- Small promo tile: store/promo-small-440x280.png
- Homepage: https://github.com/nanbiz/synced-pins
- Support: https://github.com/nanbiz/synced-pins/issues

Description:

The tab handling of the Zen browser in Chrome: the same pinned tabs in every window, like Zen's Essentials, a new tab overlay that opens no tab until you pick where to go, and a toolbar button that clears away the other tabs.

Pinned tabs in every window. Each pinned tab is open in one window. Your other windows show it in the same place, with its icon, and selecting it there brings the page over as it is: nothing reloads, a video keeps playing, a half-typed message stays. Pin, unpin or reorder a pinned tab in any window and every window follows. Closing a pinned tab closes its page, but the pin stays: select it again and it opens at the address it was pinned at. Unpin it to remove it.

New tab overlay. Press Ctrl+Shift+Space, or Ctrl+T once you set it up from the overlay, and a search bar opens over the page. Type an address or a search and press Enter to open it in a new tab, type part of a tab's title to switch to it, find sites from your history once you allow it, or type an action such as pin tab, duplicate or reload to run it. Escape closes it without leaving a tab behind.

Clearing tabs. The toolbar button closes every tab of its window that is neither pinned nor in a tab group, apart from the one you are on, and shows how many. Click it again and the overlay opens over the tab you are on, which gives way to whatever you pick there.

Nothing is collected or sent anywhere. Source: https://github.com/nanbiz/synced-pins

## Privacy practices

- Single purpose: Manage tabs the way the Zen browser does: the same pinned tabs in every browser window, a new tab overlay to open or find a tab, and a button that closes the window's other tabs.
- tabs: Reads the address, title and icon of the user's tabs: of pinned tabs to show them in the user's other windows and reopen one whose window was closed, and of open tabs to suggest them in the new tab overlay while it is open.
- storage: Keeps the list of pinned tabs in session storage while the browser runs and in local storage across restarts.
- favicon: Shows a pinned site's icon on the extension's stand-in pages from the browser's own favicon store where the site does not let other pages load its icon.
- activeTab: Lets the new tab overlay be drawn over the page the user is on, only after the user presses the overlay's keyboard shortcut there.
- scripting: Inserts the new tab overlay into the page the user is on when the user presses its keyboard shortcut; nothing is read from the page.
- search: Sends a search the user picks in the new tab overlay to the browser's default search engine.
- history (optional, asked for from the overlay): Lets the new tab overlay suggest sites and pages the user visited for what they type, once the user allows it; nothing is kept or sent.
- bookmarks (optional, asked for from the overlay): Lets the new tab overlay suggest the user's bookmarks for what they type, once the user allows it; nothing is kept or sent.
- Host permission <all_urls> (optional, asked for from the overlay): Lets a tab opened on the New Tab page close at once and the new tab overlay open over the page the user was on instead, once the user allows it; the overlay is only drawn over the page, which is not read.
- Remote code: No.
- Data usage: no data collected; certify the three statements (not sold, not used for unrelated purposes, not used for creditworthiness).
- Privacy policy: https://github.com/nanbiz/synced-pins/blob/main/PRIVACY.md
