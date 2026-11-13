import Foundation

enum WebCompatibility {
    // Keep React's DOM ownership and the skin selectors intact. Promoting the
    // existing settings overlay to the top layer avoids clipping by sidebar
    // ancestors and composited artwork without moving or cloning the dialog.
    static let script = #"""
    (() => {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
      if (location.port !== '3080' || window.__aihubSettingsCompat) return;
      window.__aihubSettingsCompat = true;
      const selector = '[data-slot="sidebar.settings"] [role="dialog"][aria-modal="true"], [data-dsh-surface="settings"][role="dialog"]';
      const style = document.createElement('style');
      style.dataset.aihubWebkitCompat = '';
      style.textContent = `
        [data-aihub-settings-overlay] {
          position: fixed !important; inset: 0 !important;
          width: 100vw !important; height: 100vh !important;
          max-width: none !important; max-height: none !important;
          margin: 0 !important; border: 0 !important;
          box-sizing: border-box !important;
          background: transparent !important; color: inherit;
          overflow: visible !important;
        }
        [data-aihub-settings-overlay]::backdrop { background: transparent; }
      `;
      document.head.appendChild(style);
      const sync = () => {
        for (const dialog of document.querySelectorAll(selector)) {
          const overlay = dialog.parentElement;
          if (!overlay || typeof overlay.showPopover !== 'function') continue;
          if (!overlay.hasAttribute('data-aihub-settings-overlay')) {
            overlay.setAttribute('data-aihub-settings-overlay', '');
            overlay.setAttribute('popover', 'manual');
          }
          if (!overlay.matches(':popover-open')) overlay.showPopover();
        }
      };
      // Only additions/removals matter; avoid observing every streamed token,
      // style mutation or animation tick across the application.
      new MutationObserver(records => {
        if (records.some(r => [...r.addedNodes].some(n => n.nodeType === 1 &&
            (n.matches(selector) || n.querySelector(selector))))) sync();
      }).observe(document.body, { childList: true, subtree: true });
      sync();
    })();
    """#
}
