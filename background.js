// Create the context menu item when the extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'share-to-tumblr',
    title: 'Share image to Tumblr',
    contexts: ['image']
  });
});

// Listen for context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'share-to-tumblr') return;

  // Attempt to extract richer metadata from the page (alt text, captions, etc.)
  let metadata = {};
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractImageMetadata,
      args: [info.srcUrl]
    });
    if (results && results[0] && results[0].result) {
      metadata = results[0].result;
    }
  } catch (e) {
    // Page may have restricted scripting (e.g. chrome:// pages) — continue without metadata
    console.warn('Share to Tumblr: could not extract page metadata:', e.message);
  }

  // Store the share data in session storage so the dialog can read it
  await chrome.storage.session.set({
    pendingShare: {
      imageUrl: info.srcUrl,
      pageUrl: info.pageUrl || tab.url || '',
      pageTitle: metadata.pageTitle || tab.title || '',
      altText: metadata.altText || '',
      imageTitle: metadata.imageTitle || '',
      surroundingText: metadata.surroundingText || '',
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
    if (!targetImg) {
      for (const img of images) {
        try {
          if (new URL(img.src).href === new URL(srcUrl).href) {
            targetImg = img;
            break;
          }
        } catch (_) { /* skip malformed srcs */ }
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

    return {
      pageTitle: document.title,
      altText: altText.substring(0, 500),
      imageTitle: imageTitle.substring(0, 200),
      surroundingText: surroundingText.substring(0, 500)
    };
  } catch (_) {
    return { pageTitle: document.title };
  }
}
