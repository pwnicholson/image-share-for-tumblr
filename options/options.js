'use strict';

// OAuth 1.0a constants
const TUMBLR_REQUEST_TOKEN = 'https://www.tumblr.com/oauth/request_token';
const TUMBLR_AUTHORIZE     = 'https://www.tumblr.com/oauth/authorize';
const TUMBLR_ACCESS_TOKEN  = 'https://www.tumblr.com/oauth/access_token';
const TUMBLR_API           = 'https://api.tumblr.com/v2';

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

async function oauthHeader({ method, url, oauthExtra = {}, bodyParams = {}, consumerKey, consumerSecret, token = '', tokenSecret = '' }) {
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
    ...(token ? { oauth_token: token } : {}),
    ...oauthExtra
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
    ...oauthExtra,
    oauth_signature:        signature
  };
  return 'OAuth ' + Object.keys(hdrParams).sort()
    .map(k => `${pct(k)}="${pct(hdrParams[k])}"`).join(', ');
}

// ─────────────────────────────────────────────
// Page setup
// ─────────────────────────────────────────────

// Track whether anything has changed so Save becomes active
let dirty = false;
function markDirty() {
  dirty = true;
  document.getElementById('btn-save').disabled = false;
}

['default-state', 'default-tags'].forEach(id => {
  document.getElementById(id).addEventListener('input', markDirty);
  document.getElementById(id).addEventListener('change', markDirty);
});

// ─────────────────────────────────────────────
// Initialise — load saved settings
// ─────────────────────────────────────────────

async function init() {
  const { tumblrOAuth1Tokens, tumblrCredentials, tumblrSettings } = await chrome.storage.local.get([
    'tumblrOAuth1Tokens',
    'tumblrCredentials',
    'tumblrSettings'
  ]);

  if (tumblrCredentials) {
    document.getElementById('client-id').value     = tumblrCredentials.consumerKey    || '';
    document.getElementById('client-secret').value = tumblrCredentials.consumerSecret || '';
  }

  if (tumblrSettings) {
    if (tumblrSettings.defaultState) {
      document.getElementById('default-state').value = tumblrSettings.defaultState;
    }
    if (tumblrSettings.defaultTags !== undefined) {
      document.getElementById('default-tags').value = tumblrSettings.defaultTags;
    }
  }

  if (tumblrOAuth1Tokens && tumblrOAuth1Tokens.token && tumblrCredentials) {
    await showConnectedState(
      tumblrCredentials.consumerKey,
      tumblrCredentials.consumerSecret,
      tumblrOAuth1Tokens.token,
      tumblrOAuth1Tokens.tokenSecret
    );
  } else {
    showDisconnectedState();
  }
}

// ─────────────────────────────────────────────
// Auth state UI
// ─────────────────────────────────────────────

function showDisconnectedState() {
  document.getElementById('auth-status-connected').classList.add('hidden');
  document.getElementById('auth-status-disconnected').classList.remove('hidden');
}

async function showConnectedState(consumerKey, consumerSecret, token, tokenSecret) {
  document.getElementById('auth-status-disconnected').classList.add('hidden');
  document.getElementById('auth-status-connected').classList.remove('hidden');

  try {
    const url    = `${TUMBLR_API}/user/info`;
    const authHdr = await oauthHeader({ method: 'GET', url, consumerKey, consumerSecret, token, tokenSecret });
    const resp   = await fetch(url, { headers: { Authorization: authHdr } });
    const data   = await resp.json();

    if (data.meta.status !== 200) throw new Error('API error');

    const user  = data.response.user;
    const blogs = user.blogs || [];

    document.getElementById('connected-username').textContent = user.name;

    const list = document.getElementById('blog-list');
    list.innerHTML = '';
    blogs.forEach(blog => {
      const li = document.createElement('li');
      li.textContent = blog.title ? `${blog.title} (${blog.name})` : blog.name;
      if (blog.primary) {
        const badge = document.createElement('span');
        badge.className = 'blog-primary';
        badge.textContent = 'Primary';
        li.appendChild(badge);
      }
      list.appendChild(li);
    });
  } catch (_) {
    // Non-fatal — just don't show blog list
    document.getElementById('connected-username').textContent = '(connected)';
  }
}

// ─────────────────────────────────────────────
// OAuth 1.0a connect flow
// ─────────────────────────────────────────────

document.getElementById('btn-connect').addEventListener('click', async () => {
  const consumerKey    = document.getElementById('client-id').value.trim();
  const consumerSecret = document.getElementById('client-secret').value.trim();
  const errorEl        = document.getElementById('auth-error');

  errorEl.classList.add('hidden');

  if (!consumerKey || !consumerSecret) {
    errorEl.textContent = 'Please enter your Consumer Key and Consumer Secret.';
    errorEl.classList.remove('hidden');
    return;
  }

  if (!/^[A-Za-z0-9]{20,}$/.test(consumerKey)) {
    errorEl.textContent = 'Consumer Key looks invalid. Copy it directly from the Tumblr app registration page.';
    errorEl.classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('btn-connect');
  btn.disabled = true;
  btn.textContent = 'Connecting…';

  try {
    const callbackUrl = 'http://localhost:38945/tumblr/callback';

    // ── Step 1: Get a request token ───────────────────────────────────────────
    const reqHdr = await oauthHeader({
      method: 'POST',
      url: TUMBLR_REQUEST_TOKEN,
      oauthExtra: { oauth_callback: callbackUrl },
      consumerKey, consumerSecret
    });

    const reqResp = await fetch(TUMBLR_REQUEST_TOKEN, {
      method: 'POST',
      headers: { Authorization: reqHdr, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `oauth_callback=${encodeURIComponent(callbackUrl)}`
    });

    if (!reqResp.ok) {
      const txt = await reqResp.text().catch(() => String(reqResp.status));
      throw new Error(`Request token failed (${reqResp.status}): ${String(txt).slice(0, 120)}`);
    }

    const reqParsed = new URLSearchParams(await reqResp.text());
    const reqToken  = reqParsed.get('oauth_token');
    const reqSecret = reqParsed.get('oauth_token_secret');

    if (!reqToken) {
      throw new Error('No request token returned. Check your Consumer Key and Secret.');
    }

    // ── Step 2: Let the user authorise on Tumblr ──────────────────────────────
    const authorizeUrl  = `${TUMBLR_AUTHORIZE}?oauth_token=${encodeURIComponent(reqToken)}`;
    const redirectedUrl = await new Promise((resolve, reject) => {
      let authWindowId = null;

      function navListener(details) {
        if (!details.url.startsWith(callbackUrl)) return;
        chrome.webNavigation.onBeforeNavigate.removeListener(navListener);
        chrome.windows.onRemoved.removeListener(removedListener);
        chrome.windows.remove(authWindowId).catch(() => {});
        resolve(details.url);
      }

      function removedListener(windowId) {
        if (windowId !== authWindowId) return;
        chrome.webNavigation.onBeforeNavigate.removeListener(navListener);
        chrome.windows.onRemoved.removeListener(removedListener);
        reject(new Error('Authentication was cancelled.'));
      }

      chrome.windows.create(
        { url: authorizeUrl, type: 'popup', width: 600, height: 700, focused: true },
        (win) => {
          if (chrome.runtime.lastError || !win) {
            reject(new Error('Could not open the authentication window.'));
            return;
          }
          authWindowId = win.id;
          chrome.webNavigation.onBeforeNavigate.addListener(navListener);
          chrome.windows.onRemoved.addListener(removedListener);
        }
      );
    });

    const verifier = new URL(redirectedUrl).searchParams.get('oauth_verifier');
    if (!verifier) throw new Error('No OAuth verifier returned. Please try again.');

    // ── Step 3: Exchange for permanent access token ───────────────────────────
    const accHdr = await oauthHeader({
      method: 'POST',
      url: TUMBLR_ACCESS_TOKEN,
      oauthExtra: { oauth_verifier: verifier },
      consumerKey, consumerSecret,
      token: reqToken, tokenSecret: reqSecret
    });

    const accResp = await fetch(TUMBLR_ACCESS_TOKEN, {
      method: 'POST',
      headers: { Authorization: accHdr, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `oauth_verifier=${encodeURIComponent(verifier)}`
    });

    if (!accResp.ok) {
      const txt = await accResp.text().catch(() => String(accResp.status));
      throw new Error(`Access token failed (${accResp.status}): ${String(txt).slice(0, 120)}`);
    }

    const accParsed   = new URLSearchParams(await accResp.text());
    const token       = accParsed.get('oauth_token');
    const tokenSecret = accParsed.get('oauth_token_secret');

    if (!token) throw new Error('No access token returned by Tumblr.');

    await chrome.storage.local.set({
      tumblrOAuth1Tokens: { token, tokenSecret },
      tumblrCredentials:  { consumerKey, consumerSecret }
    });

    await showConnectedState(consumerKey, consumerSecret, token, tokenSecret);

  } catch (err) {
    errorEl.textContent = err.message || 'Authentication failed. Please try again.';
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect to Tumblr';
  }
});

// ─────────────────────────────────────────────
// Disconnect
// ─────────────────────────────────────────────

document.getElementById('btn-disconnect').addEventListener('click', async () => {
  if (!confirm('Disconnect your Tumblr account? Your saved credentials will be removed.')) return;

  await chrome.storage.local.remove(['tumblrOAuth1Tokens', 'tumblrCredentials']);
  document.getElementById('client-id').value     = '';
  document.getElementById('client-secret').value = '';
  showDisconnectedState();
});

// ─────────────────────────────────────────────
// Save settings
// ─────────────────────────────────────────────

document.getElementById('btn-save').addEventListener('click', async () => {
  const settings = {
    defaultState: document.getElementById('default-state').value,
    defaultTags:  document.getElementById('default-tags').value.trim()
  };

  const statusEl = document.getElementById('save-status');

  try {
    await chrome.storage.local.set({ tumblrSettings: settings });
    statusEl.textContent = 'Settings saved.';
    statusEl.className   = 'save-status success';
    statusEl.classList.remove('hidden');
    dirty = false;
    document.getElementById('btn-save').disabled = true;
    setTimeout(() => statusEl.classList.add('hidden'), 2500);
  } catch (_) {
    statusEl.textContent = 'Could not save settings. Please try again.';
    statusEl.className   = 'save-status error';
    statusEl.classList.remove('hidden');
  }
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

init();
