// Open the settings page as a tab when the toolbar icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Create the context menu item when the extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'share-to-tumblr',
    title: 'Share image to Tumblr',
    contexts: ['all']
  });
});

// Listen for context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'share-to-tumblr') return;

  // Attempt to extract richer metadata from the page (alt text, captions, etc.)
  // Also used to find an image URL when right-clicking on an overlay div
  let metadata = {};
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractImageMetadata,
      args: [info.srcUrl || null]
    });
    if (results && results[0] && results[0].result) {
      metadata = results[0].result;
    }
  } catch (e) {
    // Page may have restricted scripting (e.g. chrome:// pages) — continue without metadata
    console.warn('Share to Tumblr: could not extract page metadata:', e.message);
  }

  // Prefer the image URL resolved by the injected script — for sites like STRKNG that
  // serve images through a proxy/CDN rewrite, foundImageUrl holds the real file URL.
  // Fall back to what Chrome detected (info.srcUrl) for all other sites.
  const imageUrl = metadata.foundImageUrl || info.srcUrl || '';

  // For sites with hotlink protection (e.g. STRKNG), fetch the image from within
  // the page tab using executeScript — that request carries the user's cookies and
  // the correct origin header, bypassing server-side hotlink checks.
  let imageBase64 = '';
  if (imageUrl) {
    try {
      const imgHost = new URL(imageUrl).hostname.replace(/^www\./, '');
      if (imgHost === 'strkng.com' || imgHost === 'strkng.net') {
        const b64Results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (url) => {
            try {
              const r = await fetch(url, { credentials: 'include' });
              if (!r.ok) return null;
              const buf = await r.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let bin = '';
              for (let i = 0; i < bytes.length; i += 8192) {
                bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
              }
              return btoa(bin);
            } catch (e) { return null; }
          },
          args: [imageUrl]
        });
        if (b64Results && b64Results[0] && b64Results[0].result) {
          imageBase64 = b64Results[0].result;
        }
      }
    } catch (e) {
      console.warn('Share to Tumblr: could not fetch STRKNG image from page:', e.message);
    }
  }

  // Store the share data in session storage so the dialog can read it
  await chrome.storage.session.set({
    pendingShare: {
      imageUrl,
      imageBase64,
      pageUrl: info.pageUrl || tab.url || '',
      pageTitle: metadata.pageTitle || tab.title || '',
      altText: metadata.altText || '',
      imageTitle: metadata.imageTitle || '',
      surroundingText: metadata.surroundingText || '',
      pageDescription: metadata.pageDescription || '',
      photoTitle: metadata.photoTitle || '',
      photoOwner: metadata.photoOwner || '',
      pageTags: metadata.pageTags || [],
      timestamp: Date.now()
    }
  });

  // Open the share dialog as a popup window
  chrome.windows.create({
    url: chrome.runtime.getURL('dialog/dialog.html'),
    type: 'popup',
    width: 520,
    height: 700,
    focused: true
  });
});

// ---------------------------------------------------------------------------
// This function is serialised and injected into the page — it must be
// entirely self-contained with no references to anything outside itself.
// ---------------------------------------------------------------------------
function extractImageMetadata(srcUrl) {
  try {
    // Find the image element that matches the right-clicked URL
    let targetImg = null;
    const images = Array.from(document.querySelectorAll('img'));

    for (const img of images) {
      if (img.src === srcUrl || img.currentSrc === srcUrl) {
        targetImg = img;
        break;
      }
    }

    // Fallback: normalise both URLs and compare
    if (!targetImg && srcUrl) {
      for (const img of images) {
        try {
          if (new URL(img.src).href === new URL(srcUrl).href) {
            targetImg = img;
            break;
          }
        } catch (_) { /* skip malformed srcs */ }
      }
    }

    // Hover-chain fallback: used when the user right-clicked an overlay element
    // (e.g. a transparent <div> on top of an image, common on Flickr and similar sites)
    if (!targetImg) {
      const hovered = Array.from(document.querySelectorAll(':hover'));
      for (let i = hovered.length - 1; i >= 0; i--) {
        const el = hovered[i];
        if (el.tagName === 'IMG' && el.src) {
          targetImg = el;
          break;
        }
        // Check direct children for an <img>
        const childImg = el.querySelector('img[src]');
        if (childImg) {
          targetImg = childImg;
          break;
        }
      }
    }

    let altText = '';
    let imageTitle = '';
    let surroundingText = '';

    if (targetImg) {
      altText = targetImg.alt || '';
      imageTitle = targetImg.title || '';

      // 1. <figure> / <figcaption> — the most semantic source
      const figure = targetImg.closest('figure');
      if (figure) {
        const figcaption = figure.querySelector('figcaption');
        if (figcaption) {
          surroundingText = figcaption.textContent.trim();
        }
      }

      // 2. aria-describedby
      if (!surroundingText) {
        const describedById = targetImg.getAttribute('aria-describedby');
        if (describedById) {
          const el = document.getElementById(describedById);
          if (el) surroundingText = el.textContent.trim();
        }
      }

      // 3. Nearest heading inside a parent anchor
      if (!surroundingText) {
        const parentLink = targetImg.closest('a');
        if (parentLink) {
          const heading = parentLink.querySelector('h1,h2,h3,h4,h5');
          if (heading) surroundingText = heading.textContent.trim();
        }
      }
    }

    // ── Site-specific extraction ──────────────────────────────────────────────
    // Pulls richer data (description, tags) from known photo-sharing sites.
    let pageTags = [];
    let pageDescription = '';
    let photoTitle = '';
    let photoOwner = '';
    let overrideImageUrl = '';
    const host = location.hostname.replace(/^www\./, '');

    // Parse all JSON-LD blocks on the page — these are server-rendered and reliable
    const getJsonLdItems = () => {
      const items = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try {
          const parsed = JSON.parse(s.textContent);
          const flat = Array.isArray(parsed) ? parsed : [parsed];
          flat.forEach(item => {
            items.push(item);
            if (item['@graph']) items.push(...item['@graph']);
          });
        } catch (_) {}
      });
      return items;
    };

    // Read a meta tag by attribute + value
    const getMeta = (attr, value) => {
      const el = document.querySelector(`meta[${attr}="${value}"]`);
      return el ? (el.getAttribute('content') || '') : '';
    };

    if (host === 'flickr.com' && /\/photos\/[^/]+\/\d+/.test(location.pathname)) {
      // Title — <h1 class="... photo-title ...">
      const titleEl = document.querySelector('h1[class*="photo-title"]');
      if (titleEl) photoTitle = titleEl.textContent.trim();

      // Description — <h2 class="... photo-desc ...">
      // Use innerHTML to preserve links and paragraph formatting
      const descEl = document.querySelector('h2[class*="photo-desc"]');
      if (descEl) {
        pageDescription = descEl.innerHTML
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .trim();
      }

      // Owner — the photo owner anchor has both rel="author" and class="owner-name"
      // Using the combined selector avoids picking up comment author links, which
      // also use rel="author" but appear later in the DOM and lack the owner-name class.
      const authorEl = document.querySelector('a[rel="author"].owner-name')
        || document.querySelector('a[rel="author"]');
      if (authorEl) photoOwner = authorEl.textContent.trim();

      // Tags — Flickr tag URLs are /photos/tags/TAGNAME
      const seen = new Set();
      document.querySelectorAll('a[href*="/photos/tags/"]').forEach(a => {
        const m = a.href.match(/\/photos\/tags\/([^\/\?#]+)/);
        if (m) {
          const slug = decodeURIComponent(m[1]).trim();
          if (slug && !seen.has(slug.toLowerCase())) {
            seen.add(slug.toLowerCase());
            pageTags.push(a.textContent.trim() || slug);
          }
        }
      });
    }

    if (host === 'instagram.com' && /\/(p|reel)\//.test(location.pathname)) {
      // Instagram's "More posts from" section at the bottom of every post page also
      // contains span[lang] elements, so we must scope to the FIRST li in the FIRST ul
      // (which is always the current post caption, not a related post).
      const articleEl = document.querySelector('main article, article');
      if (articleEl) {
        // Most specific: first li's span[lang] — this is the post caption "comment"
        const firstLi = articleEl.querySelector('ul > li:first-child');
        if (firstLi) {
          const langSpan = firstLi.querySelector('span[lang]');
          if (langSpan && langSpan.textContent.trim()) {
            // Instagram appends "Image description: ..." accessibility text inside
            // the same span on some posts — strip it
            let raw = langSpan.textContent.trim();
            raw = raw.replace(/\s*Image description:[\s\S]*$/i, '').trim();
            if (raw) pageDescription = raw;
          }
        }
        // h1 fallback (used in some reel and dialog views)
        if (!pageDescription) {
          const h1 = articleEl.querySelector('h1');
          if (h1 && h1.textContent.trim()) pageDescription = h1.textContent.trim();
        }
      }

      // Author — og:title is server-rendered as "Display Name on Instagram: ..."
      // This is safe to use — it only reflects the current page, not related posts.
      const ogTitle = getMeta('property', 'og:title') || '';
      const nameMatch = ogTitle.match(/^(.+?)\s+on\s+Instagram\b/i);
      if (nameMatch) photoOwner = nameMatch[1].trim();

      // Author DOM fallback: the first link in the article's <header>
      if (!photoOwner && articleEl) {
        const headerLink = articleEl.querySelector('header a');
        if (headerLink && headerLink.textContent.trim()) {
          photoOwner = headerLink.textContent.trim();
        }
      }

      // Extract #hashtags from the caption as tags
      if (pageDescription) {
        const tagMatches = pageDescription.match(/#([\w]+)/g) || [];
        pageTags = [...new Set(tagMatches.map(h => h.slice(1)))];
      }
    }

    if (host === 'strkng.com') {
      // All photo metadata is in JSON-LD <script> blocks — one per photo on feed pages,
      // one on single-photo pages. Match the right-clicked image to the correct block.
      const photographs = getJsonLdItems().filter(i => i['@type'] === 'Photograph');

      // Extract the photo ID from the img src (?iid=ID) or CDN path (/ID.jpg)
      const srcToCheck = (targetImg && (targetImg.currentSrc || targetImg.src)) || '';
      const iidMatch  = srcToCheck.match(/[?&]iid=([^&]+)/i);
      const pathMatch = srcToCheck.match(/\/([A-Za-z0-9]{20,})\.(?:jpg|jpeg|png|webp)/i);
      // Also try the page URL itself (single-photo pages embed the ID in the path)
      const urlMatch  = location.pathname.match(/\/([A-Za-z0-9]{20,})\/?(?:\?|$)/);
      const searchId  = iidMatch ? iidMatch[1] : (pathMatch ? pathMatch[1] : (urlMatch ? urlMatch[1] : null));

      let item = null;
      if (searchId) {
        item = photographs.find(p =>
          (p.thumbnailUrl || '').includes(searchId) ||
          (p.Image       || '').includes(searchId) ||
          (p.url         || '').includes(searchId)
        );
      }
      if (!item && photographs.length === 1) item = photographs[0];

      if (item) {
        // Real image URL — the cencored.php proxy URL won't load on Tumblr
        if (item.Image) overrideImageUrl = item.Image;

        // Title: decode HTML entities and strip wrapping typographic quotes
        const rawName = (item.name || '')
          .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .trim();
        const stripped = rawName.replace(/^["\u201c\u2018']+|["\u201d\u2019']+$/g, '').trim();
        if (stripped) photoTitle = stripped;

        // Author: strip the "Photographer " prefix STRKNG prepends to display names
        if (item.author && item.author.name) {
          photoOwner = item.author.name.replace(/^Photographer\s+/i, '').trim();
        }

        // Tags: genre from JSON-LD is the primary category tag
        if (item.genre) pageTags = [item.genre];
      }

      // Additional tags from DOM — STRKNG renders tag links in the photo sidebar
      if (document.querySelectorAll) {
        const seen = new Set(pageTags.map(t => t.toLowerCase()));
        document.querySelectorAll('a[href*="/en/"][class*="tag"], a[href*="/en/tag"], [class*="tags"] a').forEach(a => {
          const t = a.textContent.trim();
          if (t && t.length < 50 && !seen.has(t.toLowerCase())) {
            seen.add(t.toLowerCase());
            pageTags.push(t);
          }
        });
      }
    }

    if (host === 'deviantart.com' && /\/art\//.test(location.pathname)) {
      // Author: og:title is "TITLE by DISPLAY NAME on DeviantArt"
      const ogTitleDA = getMeta('property', 'og:title') || '';
      const byMatchDA = ogTitleDA.match(/\bby\s+(.+?)\s+on\s+DeviantArt\s*$/i);
      if (byMatchDA) {
        photoOwner = byMatchDA[1].trim();
      } else {
        // Fallback: username is the first segment of the path  /username/art/...
        const pathSegMatch = location.pathname.match(/^\/([^/]+)\/art\//i);
        if (pathSegMatch) photoOwner = pathSegMatch[1];
      }

      // Description: og:description is usually the artist's written description.
      // Strip anything from "©" onward (copyright boilerplate many artists append)
      // and also strip EXIF lines that start with "Image size".
      const ogDescDA = getMeta('property', 'og:description') || getMeta('name', 'description') || '';
      if (ogDescDA) {
        const stripped = ogDescDA
          .replace(/\s*©[\s\S]*/i, '')
          .replace(/\s*Image size[\s\S]*/i, '')
          .trim();
        if (stripped) pageDescription = stripped;
      }

      // Tags: DeviantArt renders tag links as /tag/TAGNAME
      if (document.querySelectorAll) {
        const seen = new Set();
        document.querySelectorAll('a[href*="deviantart.com/tag/"], a[href^="/tag/"]').forEach(a => {
          const t = a.textContent.trim();
          if (t && t.length < 50 && !seen.has(t.toLowerCase())) {
            seen.add(t.toLowerCase());
            pageTags.push(t);
          }
        });
      }
    }

    if (host === '500px.com') {
      // Title: h1 is most reliable; fall back to the "TITLE by AUTHOR on 500px" og:title
      const h1El = document.querySelector('h1');
      if (h1El && h1El.textContent.trim()) {
        photoTitle = h1El.textContent.trim();
      } else {
        const ogT = getMeta('property', 'og:title') || '';
        const mT = ogT.match(/^(.+?)\s+by\s+.+?\s+on\s+500px/i);
        if (mT) photoTitle = mT[1].trim();
      }

      // Author: og:title always ends in "by NAME on 500px"
      const ogTitle500 = getMeta('property', 'og:title') || '';
      const byMatch = ogTitle500.match(/\bby\s+(.+?)\s+on\s+500px\s*$/i);
      if (byMatch) {
        photoOwner = byMatch[1].trim();
      } else {
        const authorEl = document.querySelector('a[href*="/p/"]');
        if (authorEl) photoOwner = authorEl.textContent.trim();
      }

      // Description: og:description is clean on 500px (no "X likes…" pollution)
      const ogDesc500 = getMeta('property', 'og:description') || getMeta('name', 'description') || '';
      if (ogDesc500) pageDescription = ogDesc500.trim();

      // Tags: links to /search/TAGNAME-photos
      if (document.querySelectorAll) {
        const seen = new Set();
        document.querySelectorAll('a[href*="/search/"]').forEach(a => {
          const m = (a.getAttribute('href') || '').match(/\/search\/(.+?)-photos(?:[?#]|$)/i);
          if (m) {
            const t = decodeURIComponent(m[1]).trim();
            if (t && !seen.has(t.toLowerCase())) {
              seen.add(t.toLowerCase());
              pageTags.push(a.textContent.trim() || t);
            }
          }
        });
      }
    }

    return {
      pageTitle: document.title,
      altText: altText.substring(0, 500),
      imageTitle: imageTitle.substring(0, 200),
      surroundingText: surroundingText.substring(0, 500),
      pageDescription: pageDescription.substring(0, 2000),
      photoTitle: photoTitle.substring(0, 400),
      photoOwner: photoOwner.substring(0, 200),
      pageTags: pageTags.slice(0, 50),
      foundImageUrl: overrideImageUrl || (targetImg ? (targetImg.currentSrc || targetImg.src || null) : null)
    };
  } catch (_) {
    return { pageTitle: document.title };
  }
}
