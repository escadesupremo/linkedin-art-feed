// Background service worker — handles all cross-origin API fetches

const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.0-flash'];
const GEMINI_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models/';

const ID_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Per-source state ──

const sources = {
  met: {
    cachedIDs: null,
    used: new Set(),
    base: 'https://collectionapi.metmuseum.org/public/collection/v1',
  },
  chicago: {
    totalPages: null,
    used: new Set(),
    base: 'https://api.artic.edu/api/v1',
    iiif: 'https://www.artic.edu/iiif/2',
  },
};

// ── Install & Startup ──

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ artFeedEnabled: true });
  warmUpCache('met');
  warmUpCache('chicago');
});

warmUpCache('met');
warmUpCache('chicago');

async function warmUpCache(source) {
  const cacheKey = source === 'met' ? 'artworkCache' : 'artworkCache_chicago';
  try {
    if (source === 'met') await fetchMetObjectIDs();
    const data = await chrome.storage.local.get(cacheKey);
    const cached = data[cacheKey];
    if (!cached || cached.length < 12) {
      const arts = await silentFetchBatch(40, source);
      if (arts.length > 0) {
        const merged = [...(cached || []), ...arts];
        await chrome.storage.local.set({ [cacheKey]: merged.slice(-80) });
      }
    }
  } catch (e) {
    console.error(`[LinkedIn Art Feed] ${source} cache warm-up failed:`, e);
  }
}

// ══════════════════════════════════════════
// ── Met Museum API ──
// ══════════════════════════════════════════

async function fetchMetHighlightIDs() {
  try {
    const res = await fetch(
      `${sources.met.base}/search?isHighlight=true&hasImages=true&q=*`
    );
    const data = await res.json();
    return data.objectIDs || [];
  } catch {
    return [];
  }
}

async function fetchMetFullIDs() {
  try {
    const res = await fetch(
      `${sources.met.base}/search?hasImages=true&isPublicDomain=true&q=*`
    );
    const data = await res.json();
    return data.objectIDs || [];
  } catch {
    return [];
  }
}

async function fetchMetObjectIDs() {
  if (sources.met.cachedIDs?.length > 0) return sources.met.cachedIDs;

  try {
    const { metObjectIDs, metIDsTimestamp } = await chrome.storage.local.get([
      'metObjectIDs',
      'metIDsTimestamp',
    ]);
    if (
      metObjectIDs?.length > 0 &&
      metIDsTimestamp &&
      Date.now() - metIDsTimestamp < ID_CACHE_TTL
    ) {
      sources.met.cachedIDs = metObjectIDs;
      return sources.met.cachedIDs;
    }
  } catch {}

  sources.met.cachedIDs = await fetchMetHighlightIDs();

  fetchMetFullIDs().then((allIDs) => {
    if (allIDs.length > 0) {
      sources.met.cachedIDs = allIDs;
      chrome.storage.local.set({
        metObjectIDs: allIDs,
        metIDsTimestamp: Date.now(),
      });
    }
  });

  return sources.met.cachedIDs;
}

function pickMetRandomIDs(count) {
  const ids = [];
  const src = sources.met;
  const max = src.cachedIDs.length;
  if (max === 0) return ids;
  if (src.used.size > max * 0.9) src.used.clear();

  let attempts = 0;
  while (ids.length < count && attempts < count * 10) {
    const idx = Math.floor(Math.random() * max);
    if (!src.used.has(idx)) {
      src.used.add(idx);
      ids.push(src.cachedIDs[idx]);
    }
    attempts++;
  }
  return ids;
}

async function fetchMetObject(id) {
  try {
    const res = await fetch(`${sources.met.base}/objects/${id}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function isHttpsUrl(str) {
  try {
    return new URL(str).protocol === 'https:';
  } catch {
    return false;
  }
}

function metToArtwork(obj) {
  const img = obj.primaryImageSmall || obj.primaryImage;
  if (!img || !isHttpsUrl(img)) return null;
  const fallbackUrl = `https://www.metmuseum.org/art/collection/search/${encodeURIComponent(obj.objectID)}`;
  const url = obj.objectURL && isHttpsUrl(obj.objectURL) ? obj.objectURL : fallbackUrl;
  return {
    id: obj.objectID,
    image: img,
    title: String(obj.title || 'Untitled'),
    artist: String(obj.artistDisplayName || 'Unknown Artist'),
    date: String(obj.objectDate || ''),
    medium: String(obj.medium || ''),
    department: String(obj.department || ''),
    source: 'met',
    url,
  };
}

async function fetchMetArtworks(count) {
  if (!sources.met.cachedIDs?.length) await fetchMetObjectIDs();

  const artworks = [];
  let rounds = 0;

  while (artworks.length < count && rounds < 3) {
    const needed = Math.ceil((count - artworks.length) * 1.5);
    const ids = pickMetRandomIDs(needed);
    const promises = ids.map((id) =>
      fetchMetObject(id).then((obj) => {
        if (!obj) return null;
        return metToArtwork(obj);
      })
    );
    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && artworks.length < count) {
        artworks.push(r.value);
      }
    }
    rounds++;
  }
  return artworks;
}

// ══════════════════════════════════════════
// ── Art Institute of Chicago API ──
// ══════════════════════════════════════════

const AIC_FIELDS =
  'id,title,artist_display,date_display,medium_display,image_id,is_public_domain';

async function fetchChicagoPage(page, limit) {
  try {
    const res = await fetch(
      `${sources.chicago.base}/artworks/search?query[term][is_public_domain]=true&limit=${limit}&page=${page}&fields=${AIC_FIELDS}`
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function chicagoToArtwork(item) {
  if (!item.image_id) return null;
  return {
    id: item.id,
    image: `${sources.chicago.iiif}/${encodeURIComponent(item.image_id)}/full/400,/0/default.jpg`,
    title: String(item.title || 'Untitled'),
    artist: String(item.artist_display || 'Unknown Artist'),
    date: String(item.date_display || ''),
    medium: String(item.medium_display || ''),
    department: '',
    source: 'chicago',
    url: `https://www.artic.edu/artworks/${encodeURIComponent(item.id)}`,
  };
}

async function fetchChicagoArtworks(count) {
  // Get total pages on first call
  if (!sources.chicago.totalPages) {
    const probe = await fetchChicagoPage(1, 1);
    if (probe?.pagination?.total_pages) {
      sources.chicago.totalPages = Math.min(probe.pagination.total_pages, 1000);
    } else {
      sources.chicago.totalPages = 500;
    }
  }

  const artworks = [];
  let rounds = 0;
  const src = sources.chicago;
  if (src.used.size > src.totalPages * 0.9) src.used.clear();

  while (artworks.length < count && rounds < 3) {
    // Pick random pages
    const pagesToFetch = Math.ceil((count - artworks.length) / 10) + 1;
    const pages = [];
    for (let i = 0; i < pagesToFetch; i++) {
      let page;
      let attempts = 0;
      do {
        page = Math.floor(Math.random() * src.totalPages) + 1;
        attempts++;
      } while (src.used.has(page) && attempts < 50);
      src.used.add(page);
      pages.push(page);
    }

    const promises = pages.map((p) => fetchChicagoPage(p, 12));
    const results = await Promise.allSettled(promises);

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value?.data) continue;
      for (const item of r.value.data) {
        const art = chicagoToArtwork(item);
        if (art && artworks.length < count) {
          artworks.push(art);
        }
      }
    }
    rounds++;
  }
  return artworks;
}

// ══════════════════════════════════════════
// ── Unified batch fetching ──
// ══════════════════════════════════════════

function safeSend(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    /* port disconnected */
  }
}

async function getSource() {
  const { artSource } = await chrome.storage.local.get('artSource');
  return artSource || 'met';
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function fetchBatch(count, port, source) {
  const cacheKey = source === 'met' ? 'artworkCache' : 'artworkCache_chicago';
  const data = await chrome.storage.local.get(cacheKey);
  const cached = data[cacheKey] || [];
  let served = 0;

  // Serve full batch from cache if we have enough
  const cacheServe = Math.min(count, cached.length);
  if (cacheServe > 0) {
    const pick = shuffle([...cached]).slice(0, cacheServe);
    for (const art of pick) {
      safeSend(port, { type: 'artwork', art });
      served++;
    }
  }

  // If cache couldn't fill the batch, fetch the rest live
  const remaining = count - served;
  if (remaining > 0) {
    safeSend(port, {
      type: 'progress',
      loaded: 0,
      total: count,
      message: 'Discovering artworks\u2026',
    });

    const fetcher =
      source === 'chicago' ? fetchChicagoArtworks : fetchMetArtworks;
    const arts = await fetcher(remaining);

    for (const art of arts) {
      safeSend(port, { type: 'artwork', art });
      served++;
    }
  }

  safeSend(port, { type: 'done' });

  // Replenish cache in the background — fetch fresh ones to rotate stock
  const fetcher =
    source === 'chicago' ? fetchChicagoArtworks : fetchMetArtworks;
  fetcher(8).then((fresh) => {
    if (fresh.length > 0) {
      const updatedCache = shuffle([...cached, ...fresh]).slice(-80);
      chrome.storage.local.set({ [cacheKey]: updatedCache });
    }
  }).catch(() => {});
}

async function silentFetchBatch(count, source) {
  const fetcher =
    source === 'chicago' ? fetchChicagoArtworks : fetchMetArtworks;
  return fetcher(count);
}

// ── Gemini API ──

async function callGemini(art) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) {
    return 'Please add your free Gemini API key in the extension popup to enable artwork explanations.';
  }

  const prompt = `You are an art historian. In 3-4 concise paragraphs, explain the history behind this artwork:

Title: ${art.title}
Artist: ${art.artist}
Date: ${art.date}
Medium: ${art.medium}
Department: ${art.department}

Cover: the historical context of when it was created, the artist's intent and significance, the artistic techniques or style, and why this work matters today. Be engaging and accessible.`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
  });

  for (const model of GEMINI_MODELS) {
    const url = `${GEMINI_BASE}${model}:generateContent?key=${geminiApiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (res.status === 429) {
      continue;
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${err}`);
    }

    const data = await res.json();
    return (
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      'No explanation available.'
    );
  }

  throw new Error(
    'Rate limit reached on all models. Please wait a minute and try again.'
  );
}

// ── Message handling ──

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'met-api') return;

  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.action === 'fetchBatch') {
      try {
        const source = msg.source || (await getSource());
        await fetchBatch(msg.count || 12, port, source);
      } catch (err) {
        if (!disconnected) {
          try {
            port.postMessage({ type: 'error', error: err.message });
          } catch {}
        }
      }
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'explain') {
    callGemini(msg.art)
      .then((text) => sendResponse({ text }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.action === 'toggle') {
    return false;
  }
  if (msg.action === 'getStatus') {
    return false;
  }
});
