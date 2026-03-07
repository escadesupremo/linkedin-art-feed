# LinkedIn Art Feed

A Chrome extension that replaces your LinkedIn feed with public domain masterworks from the Metropolitan Museum of Art and the Art Institute of Chicago.

![Chrome Extension](https://img.shields.io/badge/Manifest-V3-blue) ![Version](https://img.shields.io/badge/version-1.0.0-green)

## Features

- **Dual museum sources** — Browse artwork from the Met (470,000+ works) or the Art Institute of Chicago, switchable via pill toggle
- **AI-powered explanations** — Click "Explain" on any artwork for an art history breakdown powered by Google Gemini (free API key)
- **Text-to-speech** — Listen to AI explanations read aloud using the browser's built-in speech synthesis
- **Infinite scroll** — Loads 8 artworks at a time with skeleton placeholders as you scroll
- **Prefetch buffer** — Next batch is preloaded in the background for near-instant loading
- **One-click toggle** — Switch between art feed and your normal LinkedIn feed instantly
- **Zero data collection** — No analytics, no telemetry, no tracking. Everything stays on your device

## Installation

### From source

1. Clone this repository:
   ```
   git clone https://github.com/escadesupremo/linkedin-art-feed.git
   ```
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the cloned folder
5. Navigate to [linkedin.com](https://www.linkedin.com) — your feed is now art

### Gemini API key (optional)

The "Explain" feature uses Google Gemini to generate art history context. To enable it:

1. Get a free API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Click the extension icon and paste your key
3. Click **Save** — the "Explain" button on each artwork will activate

## How it works

| File | Role |
|------|------|
| `early-hide.js` | Runs at `document_start` to hide the LinkedIn feed before it renders (no flash) |
| `content.js` | Injects the art feed UI, handles scroll loading, TTS, settings, and Gemini integration |
| `content.css` | CSS Grid layout, skeleton shimmer animations, modal and toolbar styles |
| `met-api.js` | Content-side API client that communicates with the background worker via ports |
| `background.js` | Service worker that fetches from both museum APIs, manages cache, and proxies Gemini requests |
| `popup.html/js/css` | Extension popup for toggling the feed and managing the API key |

### Architecture

- **Scaffold injection** — The art feed is injected inside LinkedIn's `<main>` element. LinkedIn's feed children and sidebars are hidden via a `data-artfeed` attribute, leaving the nav bar and page shell untouched.
- **Streaming fetch** — Artwork data streams from the background worker to the content script via `chrome.runtime.connect` ports, so cards appear one by one.
- **Deduplication** — A `Set` of shown artwork IDs prevents duplicates across scroll batches.
- **Cache + prefetch** — The background worker maintains a shuffled cache of 80 artworks. The content script prefetches the next batch while you browse the current one.

## Privacy

No personal data is collected or transmitted. Artwork is fetched from public museum APIs. Your Gemini API key (if provided) is stored locally in Chrome's storage and sent only to Google's API when you click "Explain."

Full privacy policy: [escadesupremo.github.io/linkedin-art-feed/privacy-policy.html](https://escadesupremo.github.io/linkedin-art-feed/privacy-policy.html)

## APIs used

- [Metropolitan Museum of Art Collection API](https://metmuseum.github.io/) — Public domain artwork data
- [Art Institute of Chicago API](https://api.artic.edu/docs/) — Public domain artwork data via IIIF
- [Google Gemini API](https://ai.google.dev/) — AI art explanations (optional, requires free API key)

## License

MIT
