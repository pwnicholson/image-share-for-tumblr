'use strict';

// Tumblr OAuth2 PKCE constants
const TUMBLR_AUTH_URL    = 'https://www.tumblr.com/oauth2/authorize';
const TUMBLR_TOKEN_URL   = 'https://api.tumblr.com/v2/oauth2/token';
const TUMBLR_API         = 'https://api.tumblr.com/v2';
const OAUTH_SCOPES       = 'basic write offline_access';

// The redirect URI Chrome identity API provides for this extension
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;

// ─────────────────────────────────────────────
// Page setup
// ─────────────────────────────────────────────

document.getElementById('redirect-uri-display').textContent = REDIRECT_URI;

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
  const { tumblrTokens, tumblrCredentials, tumblrSettings } = await chrome.storage.local.get([
    'tumblrTokens',
    'tumblrCredentials',
    'tumblrSettings'
  ]);

  // Pre-fill credentials inputs if we have them saved (but not yet connected)
  if (tumblrCredentials) {
    document.getElementById('client-id').value     = tumblrCredentials.clientId     || '';
    document.getElementById('client-secret').value = tumblrCredentials.clientSecret || '';
  }

  // Apply saved default settings
  if (tumblrSettings) {
    if (tumblrSettings.defaultState) {
      document.getElementById('default-state').value = tumblrSettings.defaultState;
    }
    if (tumblrSettings.defaultTags !== undefined) {
      document.getElementById('default-tags').value = tumblrSettings.defaultTags;
    }
  }

  if (tumblrTokens && tumblrTokens.accessToken) {
    await showConnectedState(tumblrTokens.accessToken);
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

async function showConnectedState(accessToken) {
  document.getElementById('auth-status-disconnected').classList.add('hidden');
  document.getElementById('auth-status-connected').classList.remove('hidden');

  try {
    const resp = await fetch(`${TUMBLR_API}/user/info`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await resp.json();

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
// PKCE helpers
// ─────────────────────────────────────────────

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

async function sha256Base64Url(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ─────────────────────────────────────────────
// OAuth connect flow (PKCE)
// ─────────────────────────────────────────────

document.getElementById('btn-connect').addEventListener('click', async () => {
  const clientId     = document.getElementById('client-id').value.trim();
  const clientSecret = document.getElementById('client-secret').value.trim();
  const errorEl      = document.getElementById('auth-error');

  errorEl.classList.add('hidden');

  if (!clientId || !clientSecret) {
    errorEl.textContent = 'Please enter both your Consumer Key and Consumer Secret.';
    errorEl.classList.remove('hidden');
    return;
  }

  // Basic format sanity check — Tumblr keys are alphanumeric, 50 chars typically
  if (!/^[A-Za-z0-9]{20,}$/.test(clientId)) {
    errorEl.textContent = 'Consumer Key looks invalid. Copy it directly from the Tumblr app registration page.';
    errorEl.classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('btn-connect');
  btn.disabled = true;
  btn.textContent = 'Connecting…';

  try {
    const codeVerifier  = generateRandomString(64);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const state         = generateRandomString(16);

    const params = new URLSearchParams({
      response_type:         'code',
      client_id:             clientId,
      redirect_uri:          REDIRECT_URI,
      scope:                 OAUTH_SCOPES,
      code_challenge:        codeChallenge,
      code_challenge_method: 'S256',
      state
    });

    const authUrl = `${TUMBLR_AUTH_URL}?${params}`;

    // chrome.identity.launchWebAuthFlow opens the Tumblr consent screen
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    });

    if (!responseUrl) throw new Error('Authentication was cancelled.');

    const responseParams = new URL(responseUrl).searchParams;

    // CSRF check
    if (responseParams.get('state') !== state) {
      throw new Error('State mismatch — possible CSRF. Please try again.');
    }

    const code = responseParams.get('code');
    if (!code) throw new Error('No authorisation code returned by Tumblr.');

    // Exchange the code for tokens
    const tokenResp = await fetch(TUMBLR_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  REDIRECT_URI,
        code,
        code_verifier: codeVerifier
      })
    });

    const tokenData = await tokenResp.json();

    if (!tokenData.access_token) {
      const detail = tokenData.error_description || tokenData.error || 'Unknown error';
      throw new Error('Token exchange failed: ' + detail);
    }

    const tokens = {
      accessToken:  tokenData.access_token,
      refreshToken: tokenData.refresh_token || '',
      expiresAt:    Date.now() + (tokenData.expires_in || 3600) * 1000
    };

    await chrome.storage.local.set({
      tumblrTokens:      tokens,
      tumblrCredentials: { clientId, clientSecret }
    });

    await showConnectedState(tokens.accessToken);

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

  await chrome.storage.local.remove(['tumblrTokens', 'tumblrCredentials']);
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
