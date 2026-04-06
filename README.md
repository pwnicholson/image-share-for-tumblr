# Image Share for Tumblr

Right-click any image on any webpage and share it directly to your Tumblr blog.
Choose which blog to post to, add a caption, tags, and a source link — and decide
whether to post immediately, send to your queue, or save as a draft.

---

## Features

- **Right-click any image** on any page → "Share image to Tumblr"
- **Pick any of your blogs** from the dropdown in the share dialog
- **Auto-filled caption** from the image's alt text or nearby figure caption
- **Auto-filled source link** back to the page where you found the image
- **Post now / Queue / Draft** — selectable every time you share
- **Default settings** — set your preferred post state and default tags once in Settings
- Secure OAuth 2.0 + PKCE login — your password is never touched

---

## Setup

### Step 1 — Get a Tumblr API key

You need a free Tumblr OAuth app to allow the extension to post on your behalf.

1. Go to **[https://www.tumblr.com/oauth/apps](https://www.tumblr.com/oauth/apps)** and sign in.
2. Click **"Register application"**.
3. Fill in the form:
   - **Application name**: anything you like, e.g. `My Share Extension`
   - **Application website**: anything, e.g. `https://example.com`
   - **Default callback URL**: leave blank for now — you'll fill it in next
4. Submit the form. You'll be shown your **Consumer Key** and **Consumer Secret** — copy both somewhere safe.

### Step 2 — Set the Callback URL

1. Load the extension in Chrome (see Step 3 below) — you need its extension ID first.
2. Open the extension's **Settings** page (click the toolbar icon, or right-click → "Options").
3. You will see a **Callback URL** shown in the grey box — it looks like:
   `https://YOUR_EXTENSION_ID.chromiumapp.org/`
4. Go back to your Tumblr app at `https://www.tumblr.com/oauth/apps`, click **Edit**, and paste that URL into the **"Default callback URL"** field. Save.

### Step 3 — Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the `tumblr-share-extension` folder (the one containing `manifest.json`)
5. The extension will appear in your toolbar. Note its **Extension ID** (shown under the name on the extensions page) — you need it for the Callback URL above.

### Step 4 — Connect your account

1. Click the extension icon in the toolbar (or right-click any image → "Share image to Tumblr" → it will prompt you if you're not connected yet).
2. Paste your **Consumer Key** and **Consumer Secret** from Step 1.
3. Click **"Connect to Tumblr"** — a Tumblr login/consent window will appear.
4. Approve access. You'll be redirected back and the extension will show your connected username and blog list.

Done! Right-click any image and you're ready to share.

---

## Publishing to the Chrome Web Store (optional)

If you want to install this from the store rather than loading it unpacked:

1. Zip the entire `tumblr-share-extension` folder.
2. Create a developer account at [https://chrome.google.com/webstore/devconsole/](https://chrome.google.com/webstore/devconsole/) (one-time $5 fee).
3. Upload the zip, fill in the store listing, and add a **Privacy Policy** (required because the extension stores OAuth tokens). A simple one-paragraph policy hosted anywhere is fine.
4. Submit for review — typically approved within a few days.

> **Note:** The extension ID changes when you publish to the Web Store. Before submitting,
> update the Callback URL in your Tumblr app to the new production extension ID.

---

## File structure

```
tumblr-share-extension/
├── manifest.json          — Extension manifest (Manifest V3)
├── background.js          — Service worker: context menu, metadata extraction
├── dialog/
│   ├── dialog.html        — Share popup window
│   ├── dialog.css
│   └── dialog.js          — Posting logic, token refresh
└── options/
    ├── options.html        — Settings page
    ├── options.css
    └── options.js          — OAuth PKCE flow, save defaults
```

---

## Permissions used

| Permission | Why |
|---|---|
| `contextMenus` | Adds the right-click "Share image to Tumblr" menu item |
| `storage` | Saves your OAuth tokens and default settings locally |
| `identity` | Opens the Tumblr OAuth login window |
| `scripting` + `activeTab` | Reads image alt text / captions from the page you right-clicked |
| `https://api.tumblr.com/*` | Calls the Tumblr API to post and fetch your blog list |
| `https://www.tumblr.com/*` | OAuth authorisation endpoint |

No data is sent anywhere except directly to Tumblr's official API.
