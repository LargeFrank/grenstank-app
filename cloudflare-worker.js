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

    // ---- België: Grid.com proxy ----
    if (url.searchParams.get('source') === 'be') {
      const lat      = parseFloat(url.searchParams.get('lat'));
      const lng      = parseFloat(url.searchParams.get('lng'));
      const radiusKm = parseFloat(url.searchParams.get('rad') || '8');
      const fuelType = url.searchParams.get('fuelType') || 'Gasoline';

      // Build bounding box from center + radius
      const latOff = radiusKm / 111.32;
      const lngOff = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
      const topLeftLat     = lat + latOff;
      const topLeftLon     = lng - lngOff;
      const bottomRightLat = lat - latOff;
      const bottomRightLon = lng + lngOff;

      try {
        const beUrl = `https://api.grid.com/Locations/FuelStationLocations?screenWidth=1024&screenHeight=768&topLeftLat=${topLeftLat}&topLeftLon=${topLeftLon}&bottomRightLat=${bottomRightLat}&bottomRightLon=${bottomRightLon}&brands=&fuelType=${fuelType}&subscription-key=${env.GRID_SUBSCRIPTION_KEY}`;
        const r = await fetch(beUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json',
            'Origin': 'https://www.grid.com',
            'Referer': 'https://www.grid.com/',
          }
        });
        const data = await r.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsJson(), 'Cache-Control': 'public, max-age=300' }
        });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: corsJson()
        });
      }
    }
    if (url.searchParams.get('source') === 'tk') {
      const lat    = url.searchParams.get('lat')    || '';
      const lng    = url.searchParams.get('lng')    || '';
      const rad    = url.searchParams.get('rad')    || '8';
      const type   = url.searchParams.get('type')   || 'e10';
      const apikey = env.TK_API_KEY || '';

      try {
        const tkUrl = `https://creativecommons.tankerkoenig.de/json/list.php?lat=${lat}&lng=${lng}&rad=${rad}&sort=price&type=${type}&apikey=${apikey}`;
        const r = await fetch(tkUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        });
        const data = await r.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsJson(), 'Cache-Control': 'public, max-age=180' }
        });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: corsJson()
        });
      }
    }

    // ---- ANWB proxy (existing) ----
    const lat    = parseFloat(url.searchParams.get('lat'));
    const lng    = parseFloat(url.searchParams.get('lng'));
    const radius = parseFloat(url.searchParams.get('radius') || '5000');
    const fuel   = url.searchParams.get('fuel') || 'EURO95';

    if (isNaN(lat) || isNaN(lng)) {
      return new Response(JSON.stringify({ error: 'lat en lng zijn verplicht' }), {
        status: 400, headers: corsJson()
      });
    }

    // Try v1 API first (simple geobox, no route needed)
    try {
      const v1result = await tryV1(lat, lng, radius, fuel, env);
      if (v1result) {
        return new Response(JSON.stringify(v1result), {
          headers: { ...corsJson(), 'Cache-Control': 'public, max-age=300', 'X-Source': 'v1' }
        });
      }
    } catch(e) {}

    // Fallback: v3 API with grid scatter route
    try {
      const v3result = await tryV3(lat, lng, radius, fuel);
      if (v3result) {
        return new Response(JSON.stringify(v3result), {
          headers: { ...corsJson(), 'Cache-Control': 'public, max-age=300', 'X-Source': 'v3-scatter' }
        });
      }
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: corsJson()
      });
    }
  }
};

// ---- V1 API: fires multiple requests from offset points to overcome 10-result limit ----
async function tryV1(lat, lng, radius, fuel, env) {
  const radiusKm = Math.round(radius / 1000);

  // Sample points: center + 8 points around the edge at 60% of radius
  // This ensures overlapping coverage and catches all stations
  const offsetFraction = 0.6;
  const offsetM = radius * offsetFraction;
  const latOff = offsetM / 111320;
  const lngOff = offsetM / (111320 * Math.cos(lat * Math.PI / 180));

  const samplePoints = [
    [lat, lng],                          // center
    [lat + latOff, lng],                 // N
    [lat - latOff, lng],                 // S
    [lat, lng + lngOff],                 // E
    [lat, lng - lngOff],                 // W
    [lat + latOff * 0.7, lng + lngOff * 0.7], // NE
    [lat + latOff * 0.7, lng - lngOff * 0.7], // NW
    [lat - latOff * 0.7, lng + lngOff * 0.7], // SE
    [lat - latOff * 0.7, lng - lngOff * 0.7], // SW
  ];

  const headers = {
    'apiKey': env.ANWB_API_KEY,
    'Accept': 'application/json',
    'User-Agent': 'ANWB/7.0 (Android)',
  };

  // Fire all requests in parallel
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

  // Merge all results, deduplicate by station id
  const seen = new Set();
  const allItems = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        const id = item.id || `${item.lat ?? item.latitude}-${item.lng ?? item.longitude}`;
        if (!seen.has(id)) {
          seen.add(id);
          allItems.push(item);
        }
      }
    }
  }

  if (!allItems.length) return null;
  return normalizeAndSort(allItems, lat, lng, radius, fuel, 'v1');
}

// ---- V3 API: grid scatter route ----
async function tryV3(lat, lng, radius, fuel) {
  const coordinates = buildGrid(lat, lng, radius);

  const resp = await fetch(
    `https://api.anwb.nl/routing/points-of-interest/v3/all?type-filter=FUEL_STATION&show-all-pois-along-route-filter=true&fuel-types-filter=${fuel}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
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

// ---- Normalize either v1 or v3 response to flat array ----
function normalizeAndSort(items, lat, lng, radius, fuel, source) {
  return items
    .map(s => {
      const sLat = s.coordinates?.latitude ?? s.lat ?? s.latitude;
      const sLng = s.coordinates?.longitude ?? s.lng ?? s.longitude;
      const prices = source === 'v3'
        ? (s.prices || []).filter(p => p.value > 0)
        : (s.fuelPrices || s.prices || []).filter(p => (p.price || p.value || 0) > 0);
      const d = haversine(lat, lng, sLat, sLng);
      return {
        id:      s.id,
        name:    s.title || s.name || s.stationName || 'Station',
        address: source === 'v3'
          ? [s.address?.streetAddress, s.address?.city].filter(Boolean).join(', ')
          : [s.address, s.city].filter(Boolean).join(', '),
        lat: sLat, lng: sLng,
        distM: d,
        prices,
        openingHours: s.openingHours || []
      };
    })
    .filter(s => s.lat && s.lng && isFinite(s.distM) && s.distM <= radius)
    .sort((a, b) => a.distM - b.distM)
    .slice(0, 50);
}

// ---- Grid snake pattern ----
function buildGrid(lat, lng, radiusM) {
  const latPerM = 1 / 111320;
  const lngPerM = 1 / (111320 * Math.cos(lat * Math.PI / 180));
  const spacing = 250;
  const steps = Math.ceil(radiusM / spacing);
  const coords = [];

  for (let row = -steps; row <= steps; row++) {
    const dLat = row * spacing * latPerM;
    const cols = [];
    for (let col = -steps; col <= steps; col++) {
      const dLng = col * spacing * lngPerM;
      if (Math.sqrt((row * spacing) ** 2 + (col * spacing) ** 2) <= radiusM) {
        cols.push([lng + dLng, lat + dLat]);
      }
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
