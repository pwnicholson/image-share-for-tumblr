'use strict';

const TUMBLR_API = 'https://api.tumblr.com/v2';

let shareData = null;
let accessToken = null;

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

  // Check for a saved access token
  const { tumblrTokens, tumblrCredentials } = await chrome.storage.local.get([
    'tumblrTokens',
    'tumblrCredentials'
  ]);

  if (!tumblrTokens || !tumblrTokens.accessToken) {
    showState('state-not-authed');
    return;
  }

  accessToken = tumblrTokens.accessToken;

  // Fetch the user's blogs
  try {
    await loadBlogs();
  } catch (err) {
    if (err.message === 'UNAUTHORIZED' && tumblrCredentials && tumblrTokens.refreshToken) {
      try {
        await doTokenRefresh(tumblrCredentials, tumblrTokens.refreshToken);
        await loadBlogs();
      } catch (_) {
        showState('state-not-authed');
        return;
      }
    } else {
      document.getElementById('error-message').textContent =
        'Could not load your Tumblr blogs: ' + err.message;
      showState('state-error');
      return;
    }
  }

  populateForm();
  showState('share-form');
}

// ─────────────────────────────────────────────
// Load blogs into the select
// ─────────────────────────────────────────────

async function loadBlogs() {
  const data = await tumblrGet('/user/info');
  if (data.meta.status === 401) throw new Error('UNAUTHORIZED');
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
}

// ─────────────────────────────────────────────
// Pre-fill the form from metadata
// ─────────────────────────────────────────────

function populateForm() {
  // Image preview
  const img = document.getElementById('preview-img');
  img.src = shareData.imageUrl;
  img.onerror = () => {
    img.classList.add('hidden');
    document.getElementById('preview-fallback').classList.remove('hidden');
  };

  // Caption — use alt text, then surrounding text (figure caption, aria, etc.)
  const captionEl = document.getElementById('caption-input');
  const caption = shareData.altText || shareData.surroundingText || '';
  if (caption) captionEl.value = caption;

  // Source URL pre-filled to the page where the image was found
  document.getElementById('source-url').value = shareData.pageUrl || '';

  // Apply saved default settings
  const { tumblrSettings } = await chrome.storage.local.get('tumblrSettings');
  if (tumblrSettings) {
    if (tumblrSettings.defaultState) {
      const radio = document.querySelector(`input[name="post-state"][value="${CSS.escape(tumblrSettings.defaultState)}"]`);
      if (radio) radio.checked = true;
    }
    if (tumblrSettings.defaultTags) {
      document.getElementById('tags-input').value = tumblrSettings.defaultTags;
    }
  }
}

// ─────────────────────────────────────────────
// Submit the post
// ─────────────────────────────────────────────

async function submitPost(e) {
  e.preventDefault();
  hideFormError();

  const blogName = document.getElementById('blog-select').value;
  const caption  = document.getElementById('caption-input').value.trim();
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
    const linkText = escapeHtml(shareData.pageTitle || sourceUrl);
    const linkHref = escapeHtml(sourceUrl);
    const sourceSnippet = `<p><small>Source: <a href="${linkHref}">${linkText}</a></small></p>`;
    fullCaption = fullCaption ? fullCaption + '\n' + sourceSnippet : sourceSnippet;
  }

  const body = new URLSearchParams({ type: 'photo', state });
  body.set('source', shareData.imageUrl);
  if (fullCaption) body.set('caption', fullCaption);
  if (sourceUrl)   body.set('link', sourceUrl);   // click-through URL on the image
  if (tagsRaw)     body.set('tags', tagsRaw);

  try {
    const result = await tumblrPost(
      `/blog/${encodeURIComponent(blogName)}/post`,
      body
    );

    if (result.meta.status === 201 || result.meta.status === 200) {
      showSuccess(state);
      return;
    }

    if (result.meta.status === 401) {
      // Token may have expired mid-session — try a refresh once
      const { tumblrCredentials, tumblrTokens } = await chrome.storage.local.get([
        'tumblrCredentials', 'tumblrTokens'
      ]);
      if (tumblrCredentials && tumblrTokens && tumblrTokens.refreshToken) {
        await doTokenRefresh(tumblrCredentials, tumblrTokens.refreshToken);
        const retry = await tumblrPost(`/blog/${encodeURIComponent(blogName)}/post`, body);
        if (retry.meta.status === 201 || retry.meta.status === 200) {
          showSuccess(state);
          return;
        }
      }
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
  const resp = await fetch(TUMBLR_API + path, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return resp.json();
}

async function tumblrPost(path, body) {
  const resp = await fetch(TUMBLR_API + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  return resp.json();
}

async function doTokenRefresh(credentials, refreshToken) {
  const resp = await fetch('https://api.tumblr.com/v2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Token refresh failed');

  const tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000
  };
  await chrome.storage.local.set({ tumblrTokens: tokens });
  accessToken = tokens.accessToken;
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

// Start
init();
