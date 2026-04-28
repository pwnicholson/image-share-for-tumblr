# Wishlist — Image Share for Tumblr

Issues, planned features, and improvements to address in future sessions.

---

## Planned features

---

### Misc. Features to Add
- Allow settings to link certain profiles on common sites (Flickr, 500px, etc) to known Tumblr accounts. User configurable.
- Warn if the reference link is just to a site's main page and not a photo page (ie flickr.com, flickr explore, or 500px.com)

---

### Content moderation / safety level

Allow the user to set the content rating of a post before sharing. Like the existing post state (publish/queue/draft), the selected value should be remembered and pre-selected on the next share.

**Where it appears:** Share dialog, alongside the post state radio buttons.

**Options:**
- Safe for work *(default)*
- Mature (NSFW) — with individual sub-toggles for: drug & alcohol use, violence, sexual themes

**Behaviour:**
- Last-selected value (including which sub-toggles are on) is saved to `chrome.storage.local` and restored each time the dialog opens.
- A default can optionally also be set in the Settings page alongside the existing post state default.

**Status: ON HOLD — API not confirmed.**
The Tumblr v2 API documentation (reviewed April 2026) does not document any content rating or content label parameters for post creation — neither in the legacy `/post` endpoint nor in the NPF `/posts` endpoint. Content label categories (`sexual_themes`, `violence`, `drug_use`) only appear in the Communities API, which is unrelated to individual posts. Implementing this feature would require guessing at undocumented parameters that may silently fail. Do not implement until Tumblr documents these parameters or a reliable source confirms the correct field names.

---

### STRKNG image fetching not working reliably

**Symptom:** When right-clicking an image on `strkng.com` or `strkng.net`, the share dialog receives the photo title and page link correctly, but the image itself is not being fetched — the post either fails or shares without an image.

**Background:** STRKNG uses hotlink protection, so the extension is supposed to fetch the image from within the active tab via `chrome.scripting.executeScript` (so the request is sent with the user's cookies and the correct `Origin` header). The fetched image is base64-encoded and passed to the dialog via `chrome.storage.session`. This is implemented in `background.js`.

**Possible causes to investigate:**
- The image URL being resolved from the page may be incorrect or point to a CDN-rewritten URL that still rejects the fetch
- STRKNG may have changed its page structure or image serving since the code was written, so the `foundImageUrl` logic in `extractImageMetadata` may no longer find the right element
- The in-page `fetch()` call may be failing silently (returns `null`) without surfacing a useful error
- The base64 result may be getting dropped somewhere between `background.js` and the dialog

**To debug:** Add temporary `console.log` output in `background.js` to confirm (a) what image URL is being resolved, (b) whether the in-page fetch returns a valid result, and (c) whether `imageBase64` is non-empty when stored in `chrome.storage.session`.
