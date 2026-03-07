document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('toggle');
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onLinkedIn = tab && tab.url && tab.url.includes('linkedin.com');

  if (!onLinkedIn) {
    statusEl.classList.add('disconnected');
    statusText.textContent = 'Navigate to LinkedIn to use';
    toggle.disabled = true;

    // Still reflect stored preference
    const { artFeedEnabled } = await chrome.storage.local.get('artFeedEnabled');
    toggle.checked = artFeedEnabled !== false;
    return;
  }

  statusEl.classList.add('connected');
  statusText.textContent = 'Connected to LinkedIn';

  // Ask the content script for current state
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'getStatus',
    });
    toggle.checked = response.active;
  } catch {
    // Content script not ready — fall back to stored value
    const { artFeedEnabled } = await chrome.storage.local.get('artFeedEnabled');
    toggle.checked = artFeedEnabled !== false;
  }

  toggle.addEventListener('change', async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
    } catch {
      // If content script can't be reached, just save preference
    }
    chrome.storage.local.set({ artFeedEnabled: toggle.checked });
  });

  // ── Gemini API Key ──
  const keyInput = document.getElementById('gemini-key');
  const saveBtn = document.getElementById('save-key');
  const keyStatus = document.getElementById('key-status');

  // Load saved key
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (geminiApiKey) {
    keyInput.value = geminiApiKey;
    keyStatus.textContent = 'Key saved';
    keyStatus.className = 'api-key-status saved';
  }

  saveBtn.addEventListener('click', async () => {
    const key = keyInput.value.trim();
    if (!key) {
      keyStatus.textContent = 'Please enter a key';
      keyStatus.className = 'api-key-status error';
      return;
    }
    await chrome.storage.local.set({ geminiApiKey: key });
    keyStatus.textContent = 'Key saved';
    keyStatus.className = 'api-key-status saved';
  });
});
