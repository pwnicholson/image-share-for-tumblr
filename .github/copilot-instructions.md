# GitHub Copilot Instructions — Image Share for Tumblr

## Project overview

A Chrome extension (Manifest V3) that adds a right-click context menu item on any image to share it directly to a Tumblr blog. The user can choose which blog, add a caption, tags, and a source link, and select a post state (publish now / queue / draft).

---

## Tech stack

- **Vanilla JavaScript only** — no build step, no npm, no frameworks, no TypeScript
- **Chrome Extension Manifest V3** — service worker architecture
- **OAuth 1.0a with HMAC-SHA1** implemented from scratch using `crypto.subtle`
- No test framework currently in place

---

## Key files and roles

| File | Role |
|---|---|
| `manifest.json` | Extension manifest — permissions, host permissions, content script declarations |
| `background.js` | Service worker — context menu, metadata extraction injected into pages, STRKNG image fetching |
| `dialog/dialog.html` + `dialog.js` + `dialog.css` | Share popup — the form the user fills in after right-clicking an image |
| `options/options.html` + `options.js` + `options.css` | Settings page — OAuth flow, save default post state and tags |
| `oauth-callback.html` | Intercepts the OAuth callback redirect from Tumblr |
| `content-scripts/suppress-contextmenu.js` | Re-enables the native context menu on image-like right-clicks on sites that suppress it |

---

## Auth & storage

- The user registers their own Tumblr OAuth app and pastes their consumer key/secret into the Settings page
- OAuth 1.0a tokens are stored in `chrome.storage.local`
- Per-share ephemeral data (image URL, extracted metadata) is stored in `chrome.storage.session`
- User defaults (post state, tags) are stored in `chrome.storage.local`

---

## Site-specific quirks

- **STRKNG** (`strkng.com` / `strkng.net`): Images are hotlink-protected. The background service worker fetches the image from within the active page tab via `executeScript` so the request carries the user's cookies and the correct origin header, then base64-encodes it before passing it to the dialog.
- **500px / YouPic / similar sites**: Some sites suppress the native browser context menu. `content-scripts/suppress-contextmenu.js` now runs broadly but only stops the page's `contextmenu` handler for image-like right-clicks, reducing the risk of breaking custom menus on apps that rely on them.

---

## Code conventions

- All JS files begin with `'use strict';`
- No external libraries — use Web APIs and Chrome extension APIs only
- OAuth helpers (`hmacSha1B64`, `pct`, `oauthHeader`) are intentionally duplicated in both `dialog.js` and `options.js` — MV3 service workers don't support shared modules without import maps, so this is by design
- The share dialog is opened as a `chrome.windows.create` popup (520 × 700 px)
- Prefer `chrome.storage.local` for persistence; `chrome.storage.session` for per-share ephemeral data
- Prefer clear, well-commented code over clever/compact patterns

---

## User context

- The extension owner is a non-developer; all code is written entirely through AI assistance
- Always flag security concerns immediately, especially anything touching OAuth token handling or content security policy
- When suggesting changes, prefer the simplest correct solution over abstractions or generalisations
