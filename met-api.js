// Art API client — proxies requests through the background service worker
const MetAPI = (() => {
  function fetchBatch(count = 12, { onArtwork, source } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;

      function finish(fn, val) {
        if (settled) return;
        settled = true;
        fn(val);
      }

      let port;
      try {
        port = chrome.runtime.connect({ name: 'met-api' });
      } catch (err) {
        return reject(new Error('Could not connect to background: ' + err.message));
      }

      port.onMessage.addListener((msg) => {
        if (msg.type === 'artwork' && onArtwork) {
          onArtwork(msg.art);
        } else if (msg.type === 'done') {
          finish(resolve);
          port.disconnect();
        } else if (msg.type === 'error') {
          finish(reject, new Error(msg.error));
          port.disconnect();
        }
      });

      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError;
        finish(reject, new Error(err ? err.message : 'Background disconnected'));
      });

      port.postMessage({ action: 'fetchBatch', count, source });
    });
  }

  function reset() {
    // no-op on content side; state lives in background
  }

  return { fetchBatch, reset };
})();
