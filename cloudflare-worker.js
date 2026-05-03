const CACHE_TTL = 7200; // 2 hours in seconds

// ── Cache helpers ────────────────────────────────────────────────────────────
// Key: "{country}:{lat_grid}:{lng_grid}:{fuel}"
// Grid rounds to 0.2° (~15–22 km) — one cell covers one typical search radius.
function kvKey(country, lat, lng, fuel) {
  return `${country}:${(lat * 5).toFixed(0)}:${(lng * 5).toFixed(0)}:${fuel}`;
}

async function cacheGet(kv, key) {
  if (!kv) return null;
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

async function cachePut(kv, key, data) {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(data), { expirationTtl: CACHE_TTL });
  } catch(e) {} // best-effort; never block the response
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const url = new URL(req.url);
    const source = url.searchParams.get('source');

    // ── België ───────────────────────────────────────────────────────────────
    if (source === 'be') {
      const lat      = parseFloat(url.searchParams.get('lat'));
      const lng      = parseFloat(url.searchParams.get('lng'));
      const radiusKm = parseFloat(url.searchParams.get('rad') || '8');
      const fuelType = url.searchParams.get('fuelType') || 'Gasoline';

      const key = kvKey('be', lat, lng, fuelType);
      const hit = await cacheGet(env.TANKSLIM_PRICE_CACHE, key);
      if (hit) return cachedResponse(hit);

      const latOff = radiusKm / 111.32;
      const lngOff = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));

      try {
        const beUrl = `https://api.grid.com/Locations/FuelStationLocations` +
          `?screenWidth=1024&screenHeight=768` +
          `&topLeftLat=${lat + latOff}&topLeftLon=${lng - lngOff}` +
          `&bottomRightLat=${lat - latOff}&bottomRightLon=${lng + lngOff}` +
          `&brands=&fuelType=${fuelType}&subscription-key=${env.GRID_SUBSCRIPTION_KEY}`;

        const r = await fetch(beUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json',
            'Origin': 'https://www.grid.com',
            'Referer': 'https://www.grid.com/',
          }
        });
        const data = await r.json();
        await cachePut(env.TANKSLIM_PRICE_CACHE, key, data);
        return freshResponse(data);
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsJson() });
      }
    }

    // ── Duitsland (Tankerkönig) ───────────────────────────────────────────────
    if (source === 'tk') {
      const lat  = parseFloat(url.searchParams.get('lat'));
      const lng  = parseFloat(url.searchParams.get('lng'));
      const rad  = url.searchParams.get('rad')  || '8';
      const type = url.searchParams.get('type') || 'e10';

      const key = kvKey('de', lat, lng, type);
      const hit = await cacheGet(env.TANKSLIM_PRICE_CACHE, key);
      if (hit) return cachedResponse(hit);

      try {
        const tkUrl = `https://creativecommons.tankerkoenig.de/json/list.php` +
          `?lat=${lat}&lng=${lng}&rad=${rad}&sort=price&type=${type}&apikey=${env.TK_API_KEY || ''}`;

        const r = await fetch(tkUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        });
        const data = await r.json();
        await cachePut(env.TANKSLIM_PRICE_CACHE, key, data);
        return freshResponse(data);
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsJson() });
      }
    }

    // ── Nederland (ANWB) ─────────────────────────────────────────────────────
    const lat    = parseFloat(url.searchParams.get('lat'));
    const lng    = parseFloat(url.searchParams.get('lng'));
    const radius = parseFloat(url.searchParams.get('radius') || '5000');
    const fuel   = url.searchParams.get('fuel') || 'EURO95';

    if (isNaN(lat) || isNaN(lng)) {
      return new Response(JSON.stringify({ error: 'lat en lng zijn verplicht' }), {
        status: 400, headers: corsJson()
      });
    }

    const key = kvKey('nl', lat, lng, fuel);
    const hit = await cacheGet(env.TANKSLIM_PRICE_CACHE, key);
    if (hit) return cachedResponse(hit);

    try {
      const v1result = await tryV1(lat, lng, radius, fuel, env);
      if (v1result) {
        await cachePut(env.TANKSLIM_PRICE_CACHE, key, v1result);
        return freshResponse(v1result, 'v1');
      }
    } catch(e) {}

    try {
      const v3result = await tryV3(lat, lng, radius, fuel);
      if (v3result) {
        await cachePut(env.TANKSLIM_PRICE_CACHE, key, v3result);
        return freshResponse(v3result, 'v3-scatter');
      }
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsJson() });
    }
  }
};

// ── Response helpers ─────────────────────────────────────────────────────────
function cachedResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsJson(), 'X-Cache': 'HIT' }
  });
}

function freshResponse(data, source) {
  return new Response(JSON.stringify(data), {
    headers: {
      ...corsJson(),
      'X-Cache': 'MISS',
      ...(source ? { 'X-Source': source } : {})
    }
  });
}

// ── ANWB V1 ──────────────────────────────────────────────────────────────────
async function tryV1(lat, lng, radius, fuel, env) {
  const offsetFraction = 0.6;
  const offsetM = radius * offsetFraction;
  const latOff = offsetM / 111320;
  const lngOff = offsetM / (111320 * Math.cos(lat * Math.PI / 180));

  const samplePoints = [
    [lat, lng],
    [lat + latOff, lng], [lat - latOff, lng],
    [lat, lng + lngOff], [lat, lng - lngOff],
    [lat + latOff * 0.7, lng + lngOff * 0.7],
    [lat + latOff * 0.7, lng - lngOff * 0.7],
    [lat - latOff * 0.7, lng + lngOff * 0.7],
    [lat - latOff * 0.7, lng - lngOff * 0.7],
  ];

  const headers = {
    'apiKey': env.ANWB_API_KEY,
    'Accept': 'application/json',
    'User-Agent': 'ANWB/7.0 (Android)',
  };

  const radiusKm = Math.round(radius / 1000);
  const results = await Promise.allSettled(
    samplePoints.map(([pLat, pLng]) => {
      const params = new URLSearchParams({ lat: pLat, lng: pLng, radius: radiusKm, fuelType: fuel });
      return fetch(`https://api.anwb.nl/v1/fuel/stations?${params}`, { headers })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (!data) return [];
          return data.items || data.stations || (Array.isArray(data) ? data : []);
        });
    })
  );

  const seen = new Set();
  const allItems = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        const id = item.id || `${item.lat ?? item.latitude}-${item.lng ?? item.longitude}`;
        if (!seen.has(id)) { seen.add(id); allItems.push(item); }
      }
    }
  }

  if (!allItems.length) return null;
  return normalizeAndSort(allItems, lat, lng, radius, fuel, 'v1');
}

// ── ANWB V3 ──────────────────────────────────────────────────────────────────
async function tryV3(lat, lng, radius, fuel) {
  const coordinates = buildGrid(lat, lng, radius);
  const resp = await fetch(
    `https://api.anwb.nl/routing/points-of-interest/v3/all?type-filter=FUEL_STATION&show-all-pois-along-route-filter=true&fuel-types-filter=${fuel}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.anwb.nl/verkeer/tankstations',
        'Origin': 'https://www.anwb.nl',
      },
      body: JSON.stringify({ coordinates })
    }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.value?.length) return null;
  return normalizeAndSort(data.value, lat, lng, radius, fuel, 'v3');
}

// ── Normalise ─────────────────────────────────────────────────────────────────
function normalizeAndSort(items, lat, lng, radius, fuel, source) {
  return items
    .map(s => {
      const sLat = s.coordinates?.latitude ?? s.lat ?? s.latitude;
      const sLng = s.coordinates?.longitude ?? s.lng ?? s.longitude;
      const prices = source === 'v3'
        ? (s.prices || []).filter(p => p.value > 0)
        : (s.fuelPrices || s.prices || []).filter(p => (p.price || p.value || 0) > 0);
      return {
        id:      s.id,
        name:    s.title || s.name || s.stationName || 'Station',
        address: source === 'v3'
          ? [s.address?.streetAddress, s.address?.city].filter(Boolean).join(', ')
          : [s.address, s.city].filter(Boolean).join(', '),
        lat: sLat, lng: sLng,
        distM: haversine(lat, lng, sLat, sLng),
        prices,
        openingHours: s.openingHours || []
      };
    })
    .filter(s => s.lat && s.lng && isFinite(s.distM) && s.distM <= radius)
    .sort((a, b) => a.distM - b.distM)
    .slice(0, 50);
}

// ── Grid snake ────────────────────────────────────────────────────────────────
function buildGrid(lat, lng, radiusM) {
  const latPerM = 1 / 111320;
  const lngPerM = 1 / (111320 * Math.cos(lat * Math.PI / 180));
  const spacing = 250;
  const steps = Math.ceil(radiusM / spacing);
  const coords = [];
  for (let row = -steps; row <= steps; row++) {
    const cols = [];
    for (let col = -steps; col <= steps; col++) {
      if (Math.sqrt((row * spacing) ** 2 + (col * spacing) ** 2) <= radiusM)
        cols.push([lng + col * spacing * lngPerM, lat + row * spacing * latPerM]);
    }
    if (row % 2 !== 0) cols.reverse();
    coords.push(...cols);
  }
  return coords;
}

function haversine(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function corsJson() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}
