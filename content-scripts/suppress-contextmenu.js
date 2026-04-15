// Runs at document_start — before page JavaScript — so our listener is
// registered first in the capture phase.
//
// This script is intentionally conservative: it only suppresses a page's custom
// contextmenu handler when the right-click appears to be on an image, an image
// overlay, or an element styled with a background image. That keeps critical
// custom menus on apps like docs/editors intact for normal non-image clicks.

'use strict';

function isImageLikeElement(node) {
  if (!(node instanceof Element)) return false;
  if (node instanceof HTMLImageElement) return true;
  if (node.getAttribute('role') === 'img') return true;
  if (node.closest('img, picture, figure, [role="img"]')) return true;

  const style = window.getComputedStyle(node);
  return style.backgroundImage && style.backgroundImage !== 'none';
}

function looksLikeImageContext(event) {
  const seen = new Set();
  const candidates = [];

  if (typeof event.composedPath === 'function') {
    candidates.push.apply(candidates, event.composedPath());
  }

  let current = event.target;
  while (current) {
    candidates.push(current);
    current = current.parentNode;
  }

  if (typeof document.elementsFromPoint === 'function') {
    candidates.push.apply(candidates, document.elementsFromPoint(event.clientX, event.clientY));
  }

  for (const candidate of candidates) {
    if (!(candidate instanceof Element) || seen.has(candidate)) continue;
    seen.add(candidate);
    if (isImageLikeElement(candidate)) return true;
  }

  return false;
}

window.addEventListener('contextmenu', function (event) {
  if (looksLikeImageContext(event)) {
    event.stopImmediatePropagation();
  }
}, true /* capture phase */);
