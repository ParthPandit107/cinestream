# CINESTREAM — Movies & TV Shows Discovery Platform

**CineStream** is a minimalist, black-and-white Movies & TV Shows discovery and streaming application built as a sister site to **AniStream**. It features the exact same visual identity, pure black aesthetic, high-contrast typography, and components for brand consistency.

---

## 🌟 Key Features

- **Strict Black-and-White Visual Theme**: Pure black (`#000000`), off-black cards (`#0a0a0a`), thin borders (`#262626`), white typography, duotone grayscale posters.
- **Strict Separation of Movies & TV Shows**: Movies and TV shows are kept strictly separate across API endpoints, data models, and UI catalog rows.
- **Sister Site Cross-Promo (`<SisterSitePromo />`)**: Reusable card component linking directly to sister site **AniStream** (`https://anistream.wstream.workers.dev`).
- **TMDB API Backend Proxy**: Server-side proxy handling TMDB requests (`49699d061436b6db5a0bc503f5aab402`) with 1-hour in-memory TTL response caching to respect rate limits.
- **Streaming Architecture**: Embedded video player supporting `Embed.streamxtv.tech` (`https://embed.streamxtv.tech/movie/{id}` and `https://embed.streamxtv.tech/tv/{id}/{season}/{episode}`), audio toggle (Original Sub / English Dub), server switcher, and official YouTube trailer embeds.
- **Mobile Optimization (HARD REQUIREMENT)**: Mobile navigation drawer (`☰` menu), fluid grid system (2 cols mobile, 3-6 desktop), min 44x44px touch targets, mobile search overlay.
- **Scoped Comments & Discussions**: Real-time comments per movie or per TV episode (`tv_{id}_s{season}_e{episode}`) with threaded replies, likes/dislikes counters, and spoiler warning masks.
- **Automated 14-Min Keep-Alive System**: Built-in self-ping system preventing Render free tier cold-starts.

---

## 🚀 Quick Start (Local Development)

1. Clone or open `C:\Users\HP\Desktop\cinestream`.
2. Run the proxy server:
   ```bash
   node server.js
   ```
3. Open `http://localhost:3000` in your browser!

---

## 📦 Deployment Instructions

### 1. Host Backend on Render (Free Tier)
1. Push project files (`server.js`, `package.json`, `render.yaml`) to your GitHub repository `CineStream`.
2. On Render Dashboard: Click **New** ➔ **Blueprint** ➔ Select your `CineStream` repository.
3. Render will deploy the backend proxy live at `https://cinestream-backend.onrender.com`.

### 2. Host Frontend on Cloudflare Pages / Workers
1. On Cloudflare Dashboard: **Workers & Pages** ➔ **Create application** ➔ Connect your `CineStream` GitHub repo.
2. Build output directory: `./`
3. Click **Deploy**!
