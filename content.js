// LinkedIn Art Feed — content script
// Architecture: scaffold-level injection. Our #met-art-feed is injected
// inside LinkedIn's main content area (main[aria-label]). CSS hides
// LinkedIn's feed children and sidebars via data-artfeed attribute.
// The scaffold structure and nav bar remain completely untouched.

(function () {
  'use strict';

  // ── State ──

  let artFeedEl = null;    // persistent DOM node (built once, never destroyed)
  let isArtMode = true;    // user's toggle preference
  let artSource = 'met';   // 'met' or 'chicago'
  let isLoading = false;
  let firstLoad = true;
  let scrollObserver = null;
  let initialized = false;
  let prefetchBuffer = [];
  let isPrefetching = false;
  const shownIDs = new Set();
  let hasGeminiKey = false;


  // ── Utilities ──

  function isFeedPage() {
    const path = location.pathname;
    return path === '/' || path === '/feed' || path.startsWith('/feed/');
  }

  function esc(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  }

  // ── Inject art feed into LinkedIn's main content area ──

  function injectArtFeed() {
    // Already in the DOM — nothing to do
    if (document.getElementById('met-art-feed')) return;

    // Find LinkedIn's main content area
    const mainEl = document.querySelector('main[aria-label]')
                || document.querySelector('.scaffold-layout__content')
                || document.querySelector('.scaffold-layout__main');

    if (mainEl) {
      mainEl.prepend(artFeedEl);
    } else {
      // Fallback: body-level injection
      document.body.appendChild(artFeedEl);
    }
  }

  // ── The single visibility function ──

  function applyState() {
    const show = isFeedPage() && isArtMode;
    document.documentElement.dataset.artfeed = show ? 'on' : 'off';

    // Ensure art feed is in the DOM (handles SPA re-injection)
    if (show) injectArtFeed();

    // Show/hide toolbar on feed pages only
    const toolbar = document.getElementById('met-art-toolbar');
    if (toolbar) toolbar.style.display = isFeedPage() ? '' : 'none';

    // Remove the early-hide style now that we control visibility
    const earlyHide = document.getElementById('met-art-early-hide');
    if (earlyHide) earlyHide.remove();

    updateToggleText();
  }

  // ── Gemini API (via background) ──

  function explainArtwork(art) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'explain', art }, (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (response.error) return reject(new Error(response.error));
        resolve(response.text);
      });
    });
  }

  // ── Explain Modal ──

  function ensureModal() {
    if (document.getElementById('met-art-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'met-art-modal';
    modal.className = 'met-art-modal';
    modal.innerHTML = `
      <div class="met-art-modal__backdrop"></div>
      <div class="met-art-modal__dialog">
        <button class="met-art-modal__close">&times;</button>
        <div class="met-art-modal__header">
          <h3 class="met-art-modal__title"></h3>
          <p class="met-art-modal__artist"></p>
        </div>
        <div class="met-art-modal__body">
          <div class="met-art-modal__spinner-wrap">
            <div class="met-art-feed__spinner"></div>
            <div class="met-art-feed__loader-text">Asking Gemini&hellip;</div>
          </div>
        </div>
      </div>`;

    document.body.appendChild(modal);
    modal.querySelector('.met-art-modal__backdrop').addEventListener('click', closeModal);
    modal.querySelector('.met-art-modal__close').addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
  }

  function stopTTS() {
    speechSynthesis.cancel();
    const btn = document.getElementById('met-art-tts-btn');
    if (btn) {
      btn.textContent = '\u25B6 Listen';
      btn.classList.remove('met-art-modal__tts-btn--active');
    }
  }

  let ttsVoice = null;

  function populateVoiceSelect() {
    const select = document.getElementById('met-art-tts-voice');
    if (!select) return;
    const voices = speechSynthesis.getVoices();
    if (voices.length === 0) return;

    select.innerHTML = '';
    voices.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${v.name} (${v.lang})`;
      if (v.default) opt.selected = true;
      select.appendChild(opt);
    });

    // Restore saved preference
    chrome.storage.local.get('ttsVoiceName', ({ ttsVoiceName }) => {
      if (!ttsVoiceName) return;
      const idx = voices.findIndex((v) => v.name === ttsVoiceName);
      if (idx >= 0) {
        select.value = idx;
        ttsVoice = voices[idx];
      }
    });
  }

  // Voices load async in some browsers
  speechSynthesis.onvoiceschanged = populateVoiceSelect;

  function startTTS(text) {
    stopTTS();
    const btn = document.getElementById('met-art-tts-btn');
    if (!btn) return;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    if (ttsVoice) utterance.voice = ttsVoice;
    utterance.onend = () => stopTTS();
    utterance.onerror = () => stopTTS();

    btn.textContent = '\u25A0 Stop';
    btn.classList.add('met-art-modal__tts-btn--active');
    speechSynthesis.speak(utterance);
  }

  function toggleTTS() {
    if (speechSynthesis.speaking) {
      stopTTS();
      return;
    }
    const body = document.querySelector('.met-art-modal__body');
    if (!body) return;
    const paragraphs = body.querySelectorAll('.met-art-modal__paragraph');
    const text = Array.from(paragraphs).map((p) => p.textContent).join('\n\n').trim();
    if (text) startTTS(text);
  }

  function closeModal() {
    stopTTS();
    const modal = document.getElementById('met-art-modal');
    if (modal) modal.classList.remove('met-art-modal--open');
  }

  async function openExplainModal(art) {
    ensureModal();
    const modal = document.getElementById('met-art-modal');
    modal.querySelector('.met-art-modal__title').textContent = art.title;
    modal.querySelector('.met-art-modal__artist').textContent =
      [art.artist, art.date].filter(Boolean).join(' \u00b7 ');

    const body = modal.querySelector('.met-art-modal__body');
    body.innerHTML = `
      <div class="met-art-modal__spinner-wrap">
        <div class="met-art-feed__spinner"></div>
        <div class="met-art-feed__loader-text">Asking Gemini&hellip;</div>
      </div>`;
    modal.classList.add('met-art-modal--open');

    try {
      const text = await explainArtwork(art);
      body.innerHTML =
        `<div class="met-art-modal__tts"><button id="met-art-tts-btn" class="met-art-modal__tts-btn">\u25B6 Listen</button></div>` +
        text
          .split(/\n\n+/)
          .map((p) => `<p class="met-art-modal__paragraph">${esc(p)}</p>`)
          .join('');
      document.getElementById('met-art-tts-btn').addEventListener('click', toggleTTS);
    } catch (err) {
      body.innerHTML = `<p class="met-art-modal__error">Failed to load explanation: ${esc(err.message)}</p>`;
    }
  }

  // ── Art Card ──

  function setupExplainBtn(btn, art) {
    if (!hasGeminiKey) {
      btn.disabled = true;
      btn.title = 'Add a Gemini API key in settings to enable';
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hasGeminiKey) return;
      openExplainModal(art);
    });
  }

  function updateExplainButtons() {
    document.querySelectorAll('.met-art-card__explain').forEach((btn) => {
      btn.disabled = !hasGeminiKey;
      btn.title = hasGeminiKey ? 'Explain this artwork' : 'Add a Gemini API key in settings to enable';
    });
  }

  function createArtCard(art) {
    const card = document.createElement('div');
    card.className = 'met-art-card';
    card.innerHTML = `
      <a class="met-art-card__link" href="${esc(art.url)}" target="_blank" rel="noopener noreferrer">
        <div class="met-art-card__image-wrap">
          <img class="met-art-card__image"
               src="${esc(art.image)}"
               alt="${esc(art.title)}"
               loading="lazy" />
        </div>
        <div class="met-art-card__info">
          <h3 class="met-art-card__title">${esc(art.title)}</h3>
          <p class="met-art-card__artist">${esc(art.artist)}</p>
          <p class="met-art-card__meta">
            ${art.date ? `<span>${esc(art.date)}</span>` : ''}
            ${art.medium ? `<span>${esc(art.medium)}</span>` : ''}
          </p>
        </div>
      </a>
      <button class="met-art-card__explain" title="Explain this artwork">Explain</button>`;

    setupExplainBtn(card.querySelector('.met-art-card__explain'), art);

    // Fade in image once loaded
    const img = card.querySelector('.met-art-card__image');
    if (img.complete) {
      img.classList.add('met-art-card__image--loaded');
    } else {
      img.addEventListener('load', () => img.classList.add('met-art-card__image--loaded'));
      img.addEventListener('error', () => img.classList.add('met-art-card__image--loaded'));
    }

    return card;
  }

  // ── Skeleton Placeholder Card ──

  function createSkeletonCard() {
    const card = document.createElement('div');
    card.className = 'met-art-card met-art-card--skeleton';
    card.innerHTML = `
      <div class="met-art-card__image-wrap"></div>
      <div class="met-art-card__info">
        <div class="met-art-card__title-placeholder"></div>
        <div class="met-art-card__artist-placeholder"></div>
      </div>`;
    return card;
  }

  function fillCard(skeleton, art) {
    skeleton.className = 'met-art-card';
    skeleton.innerHTML = `
      <a class="met-art-card__link" href="${esc(art.url)}" target="_blank" rel="noopener noreferrer">
        <div class="met-art-card__image-wrap">
          <img class="met-art-card__image"
               src="${esc(art.image)}"
               alt="${esc(art.title)}"
               loading="lazy" />
        </div>
        <div class="met-art-card__info">
          <h3 class="met-art-card__title">${esc(art.title)}</h3>
          <p class="met-art-card__artist">${esc(art.artist)}</p>
          <p class="met-art-card__meta">
            ${art.date ? `<span>${esc(art.date)}</span>` : ''}
            ${art.medium ? `<span>${esc(art.medium)}</span>` : ''}
          </p>
        </div>
      </a>
      <button class="met-art-card__explain" title="Explain this artwork">Explain</button>`;

    setupExplainBtn(skeleton.querySelector('.met-art-card__explain'), art);

    const img = skeleton.querySelector('.met-art-card__image');
    if (img.complete) {
      img.classList.add('met-art-card__image--loaded');
    } else {
      img.addEventListener('load', () => img.classList.add('met-art-card__image--loaded'));
      img.addEventListener('error', () => img.classList.add('met-art-card__image--loaded'));
    }
  }

  // ── First-load messages ──

  const galleryMessages = [
    'Opening the vaults\u2026',
    'Dusting off the frames\u2026',
    'Checking the lighting\u2026',
    'Hanging the masterpieces\u2026',
    'Adjusting the gallery walls\u2026',
    'Polishing the plaques\u2026',
    'Inviting the artists\u2026',
    'Almost ready for viewing\u2026',
  ];
  let galleryMsgTimer = null;

  function startGalleryMessages() {
    const text = document.getElementById('met-progress-text');
    if (!text) return;
    let index = 0;
    text.textContent = galleryMessages[0];
    galleryMsgTimer = setInterval(() => {
      index++;
      if (index >= galleryMessages.length) index = 0;
      text.textContent = galleryMessages[index];
    }, 3000);
  }

  function stopGalleryMessages() {
    if (galleryMsgTimer) {
      clearInterval(galleryMsgTimer);
      galleryMsgTimer = null;
    }
  }

  // ── Prefetch next batch in background ──

  async function prefetchNext() {
    if (isPrefetching || prefetchBuffer.length >= 8) return;
    isPrefetching = true;
    try {
      await MetAPI.fetchBatch(8, {
        source: artSource,
        onArtwork: (art) => {
          if (shownIDs.has(art.id)) return;
          prefetchBuffer.push(art);
          // Preload image into browser cache
          const img = new Image();
          img.src = art.image;
        },
      });
    } catch (e) {
      console.error('[LinkedIn Art Feed] Prefetch failed:', e);
    }
    isPrefetching = false;
  }

  // ── Empty State ──

  function showEmptyState(grid) {
    if (document.getElementById('met-art-empty')) return;
    const el = document.createElement('div');
    el.id = 'met-art-empty';
    el.className = 'met-art-feed__empty';
    el.innerHTML = `
      <div class="met-art-feed__empty-icon">\uD83C\uDFA8</div>
      <h3 class="met-art-feed__empty-title">Waiting for Art</h3>
      <p class="met-art-feed__empty-text">The museum APIs are temporarily unavailable. Hang tight.</p>
      <button class="met-art-feed__empty-retry">Try Again</button>`;
    el.querySelector('.met-art-feed__empty-retry').addEventListener('click', () => {
      hideEmptyState();
      firstLoad = true;
      isLoading = false;
      loadMore();
    });
    grid.appendChild(el);
  }

  function hideEmptyState() {
    const el = document.getElementById('met-art-empty');
    if (el) el.remove();
  }

  // ── Load More Artworks ──

  async function loadMore() {
    if (isLoading) return;
    isLoading = true;

    const isFirst = firstLoad;
    firstLoad = false;

    const loader = document.getElementById('met-art-loader');
    const progressWrap = document.getElementById('met-art-progress');
    const grid = document.getElementById('met-art-grid');
    const count = 8;

    if (isFirst && progressWrap) {
      progressWrap.style.display = '';
      startGalleryMessages();
    }
    if (!isFirst && loader) loader.style.display = '';

    // Pre-render skeleton placeholders (subsequent loads only)
    const skeletons = [];
    if (!isFirst && grid) {
      for (let i = 0; i < count; i++) {
        const sk = createSkeletonCard();
        skeletons.push(sk);
        grid.appendChild(sk);
      }
    }

    let fillIndex = 0;

    function handleArtwork(art) {
      if (shownIDs.has(art.id)) return;
      shownIDs.add(art.id);

      if (isFirst && progressWrap && progressWrap.style.display !== 'none') {
        progressWrap.style.display = 'none';
      }

      if (isFirst && grid) {
        grid.appendChild(createArtCard(art));
      } else if (fillIndex < skeletons.length) {
        fillCard(skeletons[fillIndex], art);
        fillIndex++;
      }
    }

    // Drain prefetch buffer first (instant — images already preloaded)
    while (prefetchBuffer.length > 0 && fillIndex < count) {
      handleArtwork(prefetchBuffer.shift());
    }

    // Fetch remaining from API if needed
    const needed = count - fillIndex;
    if (needed > 0) {
      let retries = 2;
      while (retries >= 0) {
        try {
          await MetAPI.fetchBatch(needed + 4, {
            source: artSource,
            onArtwork: handleArtwork,
          });
          break;
        } catch (err) {
          retries--;
          if (retries < 0) {
            console.error('[LinkedIn Art Feed] Failed to load art:', err);
          }
        }
      }
    }

    // Remove unfilled skeletons
    for (let i = fillIndex; i < skeletons.length; i++) {
      skeletons[i].remove();
    }

    // Show empty state if nothing loaded on first attempt
    const totalCards = grid ? grid.querySelectorAll('.met-art-card:not(.met-art-card--skeleton)').length : 0;
    if (totalCards === 0 && grid) {
      showEmptyState(grid);
    } else {
      hideEmptyState();
    }

    if (progressWrap) {
      progressWrap.style.display = 'none';
      stopGalleryMessages();
    }
    if (loader) loader.style.display = 'none';
    isLoading = false;

    // Start prefetching next batch in background
    if (totalCards > 0) prefetchNext();
  }

  // ── Infinite Scroll ──

  function setupInfiniteScroll() {
    const sentinel = document.getElementById('met-art-sentinel');
    if (!sentinel || scrollObserver) return;

    scrollObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: '400px' }
    );
    scrollObserver.observe(sentinel);
  }

  // ── Source switching ──

  function switchSource(newSource) {
    if (newSource === artSource) return;
    artSource = newSource;
    chrome.storage.local.set({ artSource });
    prefetchBuffer = [];
    shownIDs.clear();

    // Update UI
    const grid = document.getElementById('met-art-grid');
    if (grid) grid.innerHTML = '';
    firstLoad = true;
    isLoading = false;

    // Update pill toggle
    const pillEl = document.getElementById('met-art-source-pill');
    if (pillEl?._updateUI) pillEl._updateUI(artSource);

    loadMore();
  }

  // ── Build art feed element (once) ──

  function buildArtFeed() {
    const el = document.createElement('div');
    el.id = 'met-art-feed';
    el.innerHTML = `
      <div class="met-art-feed__header" id="met-art-header"></div>
      <div class="met-art-feed__progress" id="met-art-progress">
        <div class="met-art-feed__progress-icon">\uD83C\uDFDB\uFE0F</div>
        <div class="met-art-feed__progress-label">First time in the gallery</div>
        <div class="met-art-feed__progress-sublabel">Curating your first collection&hellip;</div>
        <div class="met-art-feed__progress-text" id="met-progress-text"></div>
      </div>
      <div class="met-art-feed__grid" id="met-art-grid"></div>
      <div class="met-art-feed__loader" id="met-art-loader" style="display:none">
        <div class="met-art-feed__spinner"></div>
        <div class="met-art-feed__loader-text">Loading more art&hellip;</div>
      </div>
      <div id="met-art-sentinel" style="height:1px"></div>`;
    return el;
  }

  // ── Toggle Button ──

  function updateToggleText() {
    const btn = document.getElementById('met-art-toggle-btn');
    if (btn) {
      btn.textContent = isArtMode ? 'Show LinkedIn Feed' : 'Show Art Feed';
    }
  }

  function injectToolbar() {
    if (document.getElementById('met-art-toolbar')) return;

    const toolbar = document.createElement('div');
    toolbar.id = 'met-art-toolbar';
    toolbar.className = 'met-art-toolbar';

    // Toggle button
    const btn = document.createElement('button');
    btn.id = 'met-art-toggle-btn';
    btn.className = 'met-art-toolbar__btn';
    btn.addEventListener('click', () => {
      isArtMode = !isArtMode;
      chrome.storage.local.set({ artFeedEnabled: isArtMode });
      applyState();
    });

    // Pill slider toggle
    const pill = document.createElement('div');
    pill.id = 'met-art-source-pill';
    pill.className = 'met-art-toolbar__pill';
    pill.innerHTML = `
      <div class="met-art-toolbar__pill-thumb" id="met-art-pill-thumb"></div>
      <span class="met-art-toolbar__pill-option met-art-toolbar__pill-option--active" data-source="met">Metropolitan Museum of Art</span>
      <span class="met-art-toolbar__pill-option" data-source="chicago">Art Institute of Chicago</span>`;

    function updatePillUI(source) {
      const thumb = pill.querySelector('#met-art-pill-thumb');
      const opts = pill.querySelectorAll('.met-art-toolbar__pill-option');
      opts.forEach((o) => {
        o.classList.toggle('met-art-toolbar__pill-option--active', o.dataset.source === source);
      });
      // Position thumb to cover the active option
      const active = pill.querySelector(`.met-art-toolbar__pill-option[data-source="${source}"]`);
      if (active && thumb) {
        thumb.style.left = active.offsetLeft + 'px';
        thumb.style.width = active.offsetWidth + 'px';
      }
    }

    // Click to toggle
    pill.addEventListener('click', (e) => {
      if (pillDragged) return;
      switchSource(artSource === 'met' ? 'chicago' : 'met');
      updatePillUI(artSource);
    });

    // Drag to toggle
    let pillDragStartX = 0;
    let pillDragged = false;
    pill.addEventListener('mousedown', (e) => {
      pillDragStartX = e.clientX;
      pillDragged = false;
      e.stopPropagation(); // don't trigger toolbar drag
    });
    document.addEventListener('mousemove', (e) => {
      if (pillDragStartX === 0) return;
      if (Math.abs(e.clientX - pillDragStartX) > 10) pillDragged = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (pillDragStartX === 0) return;
      const dx = e.clientX - pillDragStartX;
      pillDragStartX = 0;
      if (!pillDragged) return;
      if (dx > 20 && artSource === 'met') {
        switchSource('chicago');
        updatePillUI(artSource);
      } else if (dx < -20 && artSource === 'chicago') {
        switchSource('met');
        updatePillUI(artSource);
      }
    });

    // Expose updatePillUI for switchSource/init
    pill._updateUI = updatePillUI;

    // Gear button
    const gear = document.createElement('button');
    gear.className = 'met-art-toolbar__gear';
    gear.title = 'Settings';
    gear.innerHTML = '\u2699';
    gear.addEventListener('click', () => {
      const panel = document.getElementById('met-art-settings');
      if (panel) panel.classList.toggle('met-art-toolbar__settings--open');
    });

    // Settings panel (hidden by default)
    const settings = document.createElement('div');
    settings.id = 'met-art-settings';
    settings.className = 'met-art-toolbar__settings';
    settings.innerHTML = `
      <div class="met-art-toolbar__settings-label">Gemini API Key</div>
      <div class="met-art-toolbar__key-row">
        <input type="password" id="met-art-key-input"
               class="met-art-toolbar__key-input"
               placeholder="Paste your key" />
        <button id="met-art-key-save" class="met-art-toolbar__key-save">Save</button>
      </div>
      <span id="met-art-key-status" class="met-art-toolbar__key-status"></span>
      <a class="met-art-toolbar__key-hint" href="https://www.youtube.com/watch?v=prrb0hsfI60" target="_blank" rel="noopener noreferrer">
        <svg class="met-art-toolbar__yt-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M21.8 8.001a2.75 2.75 0 0 0-1.94-1.93C18.12 5.5 12 5.5 12 5.5s-6.12 0-7.86.57A2.75 2.75 0 0 0 2.2 8.001 28.7 28.7 0 0 0 1.75 12a28.7 28.7 0 0 0 .45 3.999 2.75 2.75 0 0 0 1.94 1.93c1.74.57 7.86.57 7.86.57s6.12 0 7.86-.57a2.75 2.75 0 0 0 1.94-1.93A28.7 28.7 0 0 0 22.25 12a28.7 28.7 0 0 0-.45-3.999ZM9.75 15.02V8.98L15.5 12l-5.75 3.02Z"/></svg>
        Click here to learn how you can get a Gemini API Key for free
      </a>`;

    // Privacy policy link
    const privacy = document.createElement('a');
    privacy.className = 'met-art-toolbar__privacy';
    privacy.href = 'https://escadesupremo.github.io/linkedin-art-feed/privacy-policy.html';
    privacy.target = '_blank';
    privacy.rel = 'noopener noreferrer';
    privacy.title = 'Privacy Policy';
    privacy.textContent = '\uD83D\uDD12';

    toolbar.appendChild(settings);
    toolbar.appendChild(btn);
    toolbar.appendChild(privacy);
    toolbar.appendChild(gear);

    // Place pill in the feed header
    const header = document.getElementById('met-art-header');
    if (header) header.appendChild(pill);
    document.body.appendChild(toolbar);

    // Close settings when clicking outside
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('met-art-settings');
      if (panel && !toolbar.contains(e.target)) {
        panel.classList.remove('met-art-toolbar__settings--open');
      }
    });

    // Load saved key
    chrome.storage.local.get('geminiApiKey', ({ geminiApiKey }) => {
      const input = document.getElementById('met-art-key-input');
      const status = document.getElementById('met-art-key-status');
      if (geminiApiKey && input) {
        input.value = geminiApiKey;
        status.textContent = '\u2713 Key saved';
        status.classList.add('met-art-toolbar__key-status--saved');
        hasGeminiKey = true;
        updateExplainButtons();
      }
    });

    document.getElementById('met-art-key-save').addEventListener('click', () => {
      const input = document.getElementById('met-art-key-input');
      const status = document.getElementById('met-art-key-status');
      const key = input.value.trim();
      if (!key) {
        status.textContent = 'Enter key';
        status.className = 'met-art-toolbar__key-status met-art-toolbar__key-status--error';
        return;
      }
      chrome.storage.local.set({ geminiApiKey: key });
      status.textContent = '\u2713 Saved';
      status.className = 'met-art-toolbar__key-status met-art-toolbar__key-status--saved';
      hasGeminiKey = true;
      updateExplainButtons();
    });

    // ── Drag logic ──
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };

    toolbar.addEventListener('mousedown', (e) => {
      // Don't drag when clicking buttons or inputs
      if (e.target.closest('button, input')) return;
      isDragging = true;
      dragOffset.x = e.clientX - toolbar.getBoundingClientRect().left;
      dragOffset.y = e.clientY - toolbar.getBoundingClientRect().top;
      toolbar.classList.add('met-art-toolbar--dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const x = Math.max(0, Math.min(e.clientX - dragOffset.x, window.innerWidth - toolbar.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - dragOffset.y, window.innerHeight - toolbar.offsetHeight));
      toolbar.style.left = x + 'px';
      toolbar.style.top = y + 'px';
      toolbar.style.bottom = 'auto';
      toolbar.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      toolbar.classList.remove('met-art-toolbar--dragging');
    });
  }

  // ── SPA navigation ──

  function startNavigationListener() {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        applyState();
      }
    }, 200);
  }

  // ── Message listener (popup communication) ──

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg.action === 'toggle') {
      isArtMode = !isArtMode;
      chrome.storage.local.set({ artFeedEnabled: isArtMode });
      applyState();
      sendResponse({ active: isArtMode });
    } else if (msg.action === 'getStatus') {
      sendResponse({ active: isArtMode && isFeedPage() });
    }
    return true;
  });

  // ── Init ──

  async function init() {
    if (initialized) return;
    initialized = true;

    // Load user preferences
    const { artFeedEnabled, artSource: savedSource } =
      await chrome.storage.local.get(['artFeedEnabled', 'artSource']);
    isArtMode = artFeedEnabled !== false;
    artSource = savedSource || 'met';

    // Build art feed DOM (once, kept forever) and inject into scaffold
    artFeedEl = buildArtFeed();
    injectArtFeed();

    // Inject toolbar + apply initial visibility
    injectToolbar();

    applyState();

    // Update pill after applyState so the feed is visible and offsetLeft/offsetWidth work
    requestAnimationFrame(() => {
      const pillEl = document.getElementById('met-art-source-pill');
      if (pillEl?._updateUI) pillEl._updateUI(artSource);
    });

    // Start SPA navigation detection
    startNavigationListener();

    // Load art (cached = instant, fresh = streaming)
    await loadMore();
    setupInfiniteScroll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
