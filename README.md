# ⛽ TankSlim — Grenstanken Calculator

A Dutch fuel price comparison tool that calculates whether it's worth driving to Germany or Belgium to fill up. Enter your car, select your home station, and TankSlim automatically finds the nearest border crossing, fetches live fuel prices, and computes your exact break-even point.

---

## Features

- **Auto border detection** — selects the nearest DE/BE crossing (20 DE + 10 BE reference points covering the full NL border) when you pick a home station
- **Live fuel prices** — NL via ANWB, DE via Tankerkönig, BE via Grid.com
- **Real road routing** — actual driving distance and travel time via OSRM (OpenStreetMap), not air distance × 1.3
- **Map browsing** — pan the map to explore prices anywhere; all stations loaded in a session stay visible with a per-country colour scale
- **Session colour scale** — prices are coloured relative to all stations seen in the session, per country, so Ghent and Antwerp are on the same scale
- **Break-even calculator** — shows minimum litres to tank, net profit at 40/50/60/75 L scenarios, and full cost breakdown
- **RDW licence plate lookup** — auto-detects fuel type from Dutch plate
- **Persistent preferences** — licence plate, fuel type, consumption, and home station are saved to `localStorage` and restored on next visit
- **Saved favourites** — star any station; favourites persist across sessions
- **Cloudflare KV cache** — all price fetches are cached at the edge for 2 hours, shared across users; a session coverage check skips the API entirely if enough nearby stations are already loaded

---

## Architecture

```
┌─────────────────────┐        ┌────────────────────────────────┐
│   tankgrens.html    │──────▶ │  Cloudflare Worker (proxy)     │
│   (frontend)        │        │  tankslim-proxy.fradoum99      │
└─────────────────────┘        │  .workers.dev                  │
                                │                                │
                                │  ┌──────────────────────────┐ │
                                │  │  KV: TANKSLIM_PRICE_CACHE│ │
                                │  │  TTL: 2 hours            │ │
                                │  └──────────────────────────┘ │
                                │                                │
                                │  Upstream APIs:                │
                                │  · ANWB (NL)                  │
                                │  · Tankerkönig (DE)            │
                                │  · Grid.com (BE)               │
                                └────────────────────────────────┘

External (called directly from browser):
  · OSRM — road routing
  · Nominatim — geocoding & country detection
  · RDW OpenData — licence plate lookup
```

---

## Setup

### 1. Clone and configure secrets

```bash
wrangler secret put ANWB_API_KEY
wrangler secret put TK_API_KEY
wrangler secret put GRID_SUBSCRIPTION_KEY
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in the values (this file is gitignored).

### 2. Create the KV namespace

```bash
wrangler kv namespace create "TANKSLIM_PRICE_CACHE"
```

Paste the returned `id` into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TANKSLIM_PRICE_CACHE"
id      = "your-id-here"
```

Alternatively, create the namespace in the Cloudflare dashboard under **Workers & Pages → KV**, then bind it to the worker under **Settings → Bindings**.

### 3. Deploy

```bash
wrangler deploy
```

### 4. Open the app

Open `tankgrens.html` directly in a browser, or serve it as a static file. No build step required.

---

## Files

| File | Description |
|------|-------------|
| `tankgrens.html` | Single-file frontend — all HTML, CSS, and JavaScript |
| `cloudflare-worker.js` | Proxy worker: handles CORS, KV caching, and upstream API calls |
| `wrangler.toml` | Cloudflare Worker configuration and KV binding |
| `.dev.vars.example` | Template for local development secrets |

---

## API Keys

| Secret | Where to get it |
|--------|----------------|
| `ANWB_API_KEY` | ANWB developer portal |
| `TK_API_KEY` | [creativecommons.tankerkoenig.de](https://creativecommons.tankerkoenig.de) — free |
| `GRID_SUBSCRIPTION_KEY` | [developer.grid.com](https://developer.grid.com) |

---

## Caching

Price data is cached in Cloudflare KV keyed by `{country}:{lat_grid}:{lng_grid}:{fuel}` with a 0.2° grid (~15–22 km) and a 2-hour TTL. This means:

- The first user to search an area pays the API cost; subsequent users within 2 hours get an instant response
- Switching fuel type (benzine ↔ diesel) fetches fresh data
- The frontend additionally skips browse fetches when the session already has 8+ stations within 6 km of the map centre

---

## Local Development

```bash
wrangler dev
```

Update `PROXY_URL` in `tankgrens.html` to `http://localhost:8787` for local testing.
