'use strict';

const TUMBLR_API = 'https://api.tumblr.com/v2';

let shareData   = null;
let oauthTokens = null;   // { token, tokenSecret }
let credentials = null;   // { consumerKey, consumerSecret }

// ─────────────────────────────────────────────
// OAuth 1.0a HMAC-SHA1 helpers
// ─────────────────────────────────────────────

async function hmacSha1B64(key, data) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function pct(v) {
  return encodeURIComponent(String(v))
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function oauthHeader({ method, url, bodyParams = {}, consumerKey, consumerSecret, token = '', tokenSecret = '' }) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const sigParams = {
    ...bodyParams,
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        timestamp,
    oauth_version:          '1.0',
    ...(token ? { oauth_token: token } : {})
  };

  const sortedStr = Object.keys(sigParams).sort()
    .map(k => `${pct(k)}=${pct(sigParams[k])}`).join('&');
  const sigBase = [method.toUpperCase(), pct(url.split('?')[0]), pct(sortedStr)].join('&');
  const signature = await hmacSha1B64(`${pct(consumerSecret)}&${pct(tokenSecret)}`, sigBase);

  const hdrParams = {
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        timestamp,
    oauth_version:          '1.0',
    ...(token ? { oauth_token: token } : {}),
    oauth_signature:        signature
  };
  return 'OAuth ' + Object.keys(hdrParams).sort()
    .map(k => `${pct(k)}="${pct(hdrParams[k])}"`).join(', ');
}

// ─────────────────────────────────────────────
// State helpers
// ─────────────────────────────────────────────

function showState(id) {
  ['state-loading', 'state-not-authed', 'state-error', 'state-success', 'share-form'].forEach(s => {
    document.getElementById(s).classList.add('hidden');
  });
  document.getElementById(id).classList.remove('hidden');
}

function showFormError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideFormError() {
  document.getElementById('form-error').classList.add('hidden');
}

// ─────────────────────────────────────────────
// Initialise
// ─────────────────────────────────────────────

async function init() {
  showState('state-loading');

  // Retrieve the image data stored by the background service worker
  const { pendingShare } = await chrome.storage.session.get('pendingShare');
  if (!pendingShare || !pendingShare.imageUrl) {
    document.getElementById('error-message').textContent =
      'No image data found. Please try right-clicking the image again.';
    showState('state-error');
    return;
  }
  shareData = pendingShare;

  // Check for saved OAuth tokens and credentials
  const { tumblrOAuth1Tokens, tumblrCredentials } = await chrome.storage.local.get([
    'tumblrOAuth1Tokens',
    'tumblrCredentials'
  ]);

  if (!tumblrOAuth1Tokens || !tumblrOAuth1Tokens.token || !tumblrCredentials) {
    showState('state-not-authed');
    return;
  }

  oauthTokens = tumblrOAuth1Tokens;
  credentials = tumblrCredentials;

  try {
    await loadBlogs();
  } catch (err) {
    document.getElementById('error-message').textContent =
      'Could not load your Tumblr blogs: ' + err.message;
    showState('state-error');
    return;
  }

  await populateForm();
  showState('share-form');
}

// ─────────────────────────────────────────────
// Load blogs into the select
// ─────────────────────────────────────────────

async function loadBlogs() {
  const data = await tumblrGet('/user/info');
  if (data.meta.status === 401) throw new Error('Not authorised — please reconnect in Settings.');
  if (data.meta.status !== 200) throw new Error(data.meta.msg || 'API error');

  const blogs = data.response.user.blogs || [];
  const select = document.getElementById('blog-select');
  select.innerHTML = '';

  blogs.forEach(blog => {
    const opt = document.createElement('option');
    opt.value = blog.name;
    opt.textContent = blog.title ? `${blog.title} (${blog.name})` : blog.name;
    if (blog.primary) opt.selected = true;
    select.appendChild(opt);
  });

  if (blogs.length === 0) throw new Error('No blogs found on this account.');

  // Restore the last-used blog if it still exists in the list
  const { tumblrLastBlog } = await chrome.storage.local.get('tumblrLastBlog');
  if (tumblrLastBlog && select.querySelector(`option[value="${CSS.escape(tumblrLastBlog)}"]`)) {
    select.value = tumblrLastBlog;
  }
}

// ─────────────────────────────────────────────
// Pre-fill the form from metadata
// ─────────────────────────────────────────────

async function populateForm() {
  // Image preview
  const img = document.getElementById('preview-img');
  img.src = shareData.imageUrl;
  img.onerror = () => {
    img.classList.add('hidden');
    document.getElementById('preview-fallback').classList.remove('hidden');
  };

  // Caption — assemble from site-specific fields in display order, skipping blanks.
  // Format: Title / by Owner / Description (each on its own line, blank lines omitted)
  // Falls back to generic alt text / figcaption for non-Flickr/Instagram pages.
  const captionEl = document.getElementById('caption-input');
  let caption = '';
  if (shareData.photoTitle || shareData.photoOwner || shareData.pageDescription) {
    const parts = [];
    if (shareData.photoTitle) {
      // Flickr-style: Title → by Author → Description
      parts.push(shareData.photoTitle);
      if (shareData.photoOwner)      parts.push('by ' + shareData.photoOwner);
      if (shareData.pageDescription) parts.push(shareData.pageDescription);
    } else {
      // Instagram-style (no separate title): Description → by Author
      if (shareData.pageDescription) parts.push(shareData.pageDescription);
      if (shareData.photoOwner)      parts.push('by ' + shareData.photoOwner);
    }
    caption = parts.join('\n');
  } else {
    caption = shareData.altText || shareData.surroundingText || '';
  }
  if (caption) captionEl.innerHTML = plainTextToHtml(caption);

  // Source URL pre-filled to the page where the image was found
  document.getElementById('source-url').value = shareData.pageUrl || '';

  // Apply saved default settings
  const { tumblrSettings } = await chrome.storage.local.get('tumblrSettings');
  if (tumblrSettings) {
    if (tumblrSettings.defaultState) {
      const radio = document.querySelector(`input[name="post-state"][value="${CSS.escape(tumblrSettings.defaultState)}"]`);
      if (radio) radio.checked = true;
    }

    // Merge page-extracted tags (Flickr tags, Instagram hashtags) with the user's saved defaults.
    // Page tags come first; default tags are appended without duplicates.
    const pageTags = shareData.pageTags || [];
    const defaultTagsList = tumblrSettings.defaultTags
      ? tumblrSettings.defaultTags.split(',').map(t => t.trim()).filter(Boolean)
      : [];
    const merged = [...pageTags];
    for (const t of defaultTagsList) {
      if (!merged.some(x => x.toLowerCase() === t.toLowerCase())) merged.push(t);
    }
    if (merged.length) document.getElementById('tags-input').value = merged.join(', ');
  } else if (shareData.pageTags && shareData.pageTags.length) {
    // No default settings saved — still populate page tags
    document.getElementById('tags-input').value = shareData.pageTags.join(', ');
  }
}

// ─────────────────────────────────────────────
// Submit the post
// ─────────────────────────────────────────────

async function submitPost(e) {
  e.preventDefault();
  hideFormError();

  const blogName = document.getElementById('blog-select').value;
  const caption  = getEditorHtml();
  const tagsRaw  = document.getElementById('tags-input').value.trim();
  const sourceUrl = document.getElementById('source-url').value.trim();
  const state    = document.querySelector('input[name="post-state"]:checked').value;

  // Validate source URL if provided
  if (sourceUrl && !isValidHttpUrl(sourceUrl)) {
    showFormError('Source URL must start with http:// or https://');
    return;
  }

  const submitBtn = document.getElementById('btn-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Posting…';

  // Build the full caption — append a source link if we have one
  let fullCaption = caption;
  if (sourceUrl) {
    const linkText = escapeHtml(getSourceDisplayHost(sourceUrl));
    const linkHref = escapeHtml(sourceUrl);
    const sourceSnippet = `<p><small>Source: <a href="${linkHref}">${linkText}</a></small></p>`;
    fullCaption = fullCaption ? fullCaption + '\n' + sourceSnippet : sourceSnippet;
  }

  const bodyFields = { type: 'photo', state };
  // Sites with hotlink protection (e.g. STRKNG) send a pre-fetched base64 image.
  // Use data[0] for those; use source= (Tumblr fetches the URL) for everything else.
  const unsignedFields = {};
  if (shareData.imageBase64) {
    unsignedFields['data[0]'] = shareData.imageBase64;
  } else {
    bodyFields.source = shareData.imageUrl;
  }
  if (fullCaption) bodyFields.caption = fullCaption;
  if (sourceUrl)   bodyFields.link    = sourceUrl;
  if (tagsRaw)     bodyFields.tags    = tagsRaw;

  try {
    const result = await tumblrPost(
      `/blog/${encodeURIComponent(blogName)}/post`,
      bodyFields,
      unsignedFields
    );

    if (result.meta.status === 201 || result.meta.status === 200) {
      await chrome.storage.local.set({ tumblrLastBlog: blogName });
      showSuccess(state);
      return;
    }

    if (result.meta.status === 401) {
      showFormError('Authentication failed. Please reconnect in Settings.');
    } else {
      const detail = (result.errors && result.errors[0] && result.errors[0].detail)
        || result.meta.msg
        || 'Unknown error from Tumblr.';
      showFormError('Tumblr returned an error: ' + detail);
    }
  } catch (err) {
    showFormError('Could not reach Tumblr. Check your internet connection and try again.');
  }

  submitBtn.disabled = false;
  submitBtn.textContent = 'Share';
}

function showSuccess(state) {
  const messages = { published: 'Posted!', queue: 'Added to queue!', draft: 'Saved as draft!' };
  document.getElementById('success-message').textContent = messages[state] || 'Done!';
  showState('state-success');
  setTimeout(() => window.close(), 2000);
}

// ─────────────────────────────────────────────
// Tumblr API helpers
// ─────────────────────────────────────────────

async function tumblrGet(path) {
  const url     = TUMBLR_API + path;
  const authHdr = await oauthHeader({
    method: 'GET', url,
    consumerKey:    credentials.consumerKey,
    consumerSecret: credentials.consumerSecret,
    token:          oauthTokens.token,
    tokenSecret:    oauthTokens.tokenSecret
  });
  const resp = await fetch(url, { headers: { Authorization: authHdr } });
  return resp.json();
}

async function tumblrPost(path, bodyFields, unsignedFields = {}) {
  const url     = TUMBLR_API + path;
  // OAuth signature covers only the text body fields, never binary payloads
  const authHdr = await oauthHeader({
    method: 'POST', url,
    bodyParams:     bodyFields,
    consumerKey:    credentials.consumerKey,
    consumerSecret: credentials.consumerSecret,
    token:          oauthTokens.token,
    tokenSecret:    oauthTokens.tokenSecret
  });

  let body;
  const headers = { Authorization: authHdr };

  if (unsignedFields['data[0]']) {
    // Binary image upload — multipart/form-data is required for binary data.
    // Do NOT set Content-Type manually; the browser adds it with the correct boundary.
    const form = new FormData();
    for (const [k, v] of Object.entries(bodyFields)) form.append(k, v);
    // Decode base64 → Blob via a data: URL (avoids manual atob loops)
    const dataUrl = 'data:image/jpeg;base64,' + unsignedFields['data[0]'];
    const blobResp = await fetch(dataUrl);
    const blob = await blobResp.blob();
    form.append('data[0]', blob, 'image.jpg');
    body = form;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams({ ...bodyFields, ...unsignedFields }).toString();
  }

  const resp = await fetch(url, { method: 'POST', headers, body });
  return resp.json();
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) { return false; }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Convert plain text to safe HTML for display in the caption editor
function plainTextToHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function getSourceDisplayHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    return url;
  }
}

// Read and clean the HTML content from the caption editor
function getEditorHtml() {
  const html = document.getElementById('caption-input').innerHTML.trim();
  // Treat a contenteditable placeholder made only of breaks/whitespace as empty.
  if (!html || /^(?:\s|&nbsp;|<br\s*\/?>)+$/i.test(html)) return '';
  return html;
}

function isRangeAtEndOfEditor(editor, range) {
  const tailRange = range.cloneRange();
  tailRange.selectNodeContents(editor);
  tailRange.setStart(range.endContainer, range.endOffset);

  const fragment = tailRange.cloneContents();
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_ALL);
  let node = walker.nextNode();

  while (node) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.replace(/\u200B/g, '').trim()) {
      return false;
    }

    if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'BR') {
      return false;
    }

    node = walker.nextNode();
  }

  return true;
}

function insertEditorLineBreak(editor) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;

  const range = selection.getRangeAt(0);
  const isAtEnd = isRangeAtEndOfEditor(editor, range);

  range.deleteContents();

  const firstBreak = document.createElement('br');
  range.insertNode(firstBreak);

  if (isAtEnd) {
    const secondBreak = document.createElement('br');
    firstBreak.parentNode.insertBefore(secondBreak, firstBreak.nextSibling);
  }

  range.setStartAfter(firstBreak);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

// ─────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────

document.getElementById('btn-open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

document.getElementById('btn-retry').addEventListener('click', init);

document.getElementById('btn-cancel').addEventListener('click', () => window.close());

document.getElementById('share-form').addEventListener('submit', submitPost);

// ─────────────────────────────────────────────
// WYSIWYG caption editor
// ─────────────────────────────────────────────

let savedLinkRange = null;

function initEditor() {
  const editor    = document.getElementById('caption-input');
  const linkBar   = document.getElementById('link-bar');
  const linkInput = document.getElementById('link-url-input');

  // On Enter, insert a <br> instead of letting the browser create block elements
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      insertEditorLineBreak(editor);
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'b') {
      e.preventDefault();
      document.execCommand('bold');
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'i') {
      e.preventDefault();
      document.execCommand('italic');
    }
  });

  // On paste, strip incoming HTML and insert as plain text with <br> for newlines
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) {
      document.execCommand('insertHTML', false, escapeHtml(text).replace(/\n/g, '<br>'));
    }
  });

  // If the editor content is just a lone <br> (Chrome quirk), treat it as empty
  editor.addEventListener('input', () => {
    if (editor.innerHTML === '<br>') editor.innerHTML = '';
  });

  // Keep Bold/Italic toolbar buttons in sync with the cursor position
  document.addEventListener('selectionchange', () => {
    if (!editor.contains(window.getSelection().anchorNode)) return;
    document.getElementById('fmt-bold').classList.toggle('active', document.queryCommandState('bold'));
    document.getElementById('fmt-italic').classList.toggle('active', document.queryCommandState('italic'));
  });

  document.getElementById('fmt-bold').addEventListener('click', () => {
    editor.focus();
    document.execCommand('bold');
  });

  document.getElementById('fmt-italic').addEventListener('click', () => {
    editor.focus();
    document.execCommand('italic');
  });

  // Save the current selection, then show the link URL bar
  document.getElementById('fmt-link').addEventListener('click', () => {
    const sel = window.getSelection();
    savedLinkRange = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).cloneRange() : null;
    linkBar.classList.remove('hidden');
    linkInput.value = '';
    linkInput.focus();
  });

  document.getElementById('fmt-unlink').addEventListener('click', () => {
    editor.focus();
    document.execCommand('unlink');
  });

  function applyLink() {
    const url = linkInput.value.trim();
    if (url && isValidHttpUrl(url) && savedLinkRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedLinkRange);
      document.execCommand('createLink', false, url);
    }
    savedLinkRange = null;
    linkBar.classList.add('hidden');
    editor.focus();
  }

  document.getElementById('link-url-apply').addEventListener('click', applyLink);

  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); applyLink(); }
    if (e.key === 'Escape') {
      savedLinkRange = null;
      linkBar.classList.add('hidden');
      editor.focus();
    }
  });

  document.getElementById('link-url-cancel').addEventListener('click', () => {
    savedLinkRange = null;
    linkBar.classList.add('hidden');
    editor.focus();
  });
}

// Start
initEditor();
init();
