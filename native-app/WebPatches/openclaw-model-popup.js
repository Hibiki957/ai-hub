/* OpenClaw composer menus in older embedded WebKit.
 * Its fixed-position containing block includes the composer query container,
 * while Floating UI computes viewport coordinates. Correct only that fallback;
 * keep the original details, menu, search and selection event handlers intact.
 */
(() => {
  if (typeof HTMLElement.prototype.showPopover === 'function') return;
  const pending = new WeakSet();
  window.addEventListener('wa-reposition', event => {
    const host = event.composedPath().find(node => node.localName === 'wa-popup');
    const picker = host?.closest('.chat-controls__model-picker, .chat-controls__effort-picker');
    if (!picker || !host.active || pending.has(host)) return;
    pending.add(host);
    requestAnimationFrame(() => {
      pending.delete(host);
      if (!host.isConnected || !host.active || !picker.open) return;
      const popup = host.shadowRoot?.querySelector('[part="popup"]');
      const anchor = host.anchor instanceof Element ? host.anchor : picker.querySelector('summary');
      if (!popup || !anchor) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      const a = anchor.getBoundingClientRect();
      const above = a.top - top - 14, below = top + height - a.bottom - 14;
      const placeAbove = above >= Math.min(240, Math.max(above, below));
      host.style.setProperty('--auto-size-available-height', `${Math.max(0, placeAbove ? above : below)}px`);
      const r = popup.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const x = Math.max(left + 12, Math.min(a.right - r.width, left + width - r.width - 12));
      const y = Math.max(top + 8, Math.min(placeAbove ? a.top - r.height - 6 : a.bottom + 6, top + height - r.height - 8));
      // Convert viewport delta back to the existing containing block coordinates.
      const sx = r.width / popup.offsetWidth || 1, sy = r.height / popup.offsetHeight || 1;
      popup.style.left = `${(parseFloat(popup.style.left) || 0) + (x - r.left) / sx}px`;
      popup.style.top = `${(parseFloat(popup.style.top) || 0) + (y - r.top) / sy}px`;
    });
  }, true);
})();
