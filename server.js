const express = require('express');
const axios = require('axios');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ── HTTP client with FAA-friendly headers ──
const client = axios.create({
  timeout: 25000,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json, */*',
    'Referer': 'https://tfr.faa.gov/tfr3/',
  },
});

app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────────────────
// FAA TFR data sources (discovered from the Nuxt.js app bundle)
// ──────────────────────────────────────────────────────────
const GEOSERVER_URL =
  'https://tfr.faa.gov/geoserver/TFR/ows' +
  '?service=WFS&version=1.1.0&request=GetFeature' +
  '&typeName=TFR:V_TFR_LOC&maxFeatures=500' +
  '&outputFormat=application/json&srsname=EPSG:4326';

const TFR_LIST_URL   = 'https://tfr.faa.gov/tfrapi/getTfrList';
const NO_SHAPE_URL   = 'https://tfr.faa.gov/tfrapi/noShapeTfrList';

// ──────────────────────────────────────────────────────────
// Utility: extract base NOTAM ID from a NOTAM_KEY
// "6/3475-1-FDC-F"  →  "6/3475"
// ──────────────────────────────────────────────────────────
function baseNotamId(key) {
  if (!key) return '';
  return key.replace(/-.*$/, '').trim();
}

// ──────────────────────────────────────────────────────────
// Utility: Haversine distance in nautical miles
// ──────────────────────────────────────────────────────────
function distanceNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ──────────────────────────────────────────────────────────
// Utility: polygon centroid (simple average of ring vertices)
// ──────────────────────────────────────────────────────────
function polygonCentroid(coords) {
  // coords is [[lon,lat], ...]
  if (!coords || coords.length === 0) return null;
  let sumLat = 0, sumLon = 0, n = 0;
  for (const [lon, lat] of coords) {
    sumLat += lat; sumLon += lon; n++;
  }
  return { lat: sumLat / n, lon: sumLon / n };
}

// ──────────────────────────────────────────────────────────
// Utility: minimum distance from a point to any polygon vertex
// (cheaper than full polygon-to-point distance, good enough for filtering)
// ──────────────────────────────────────────────────────────
function minDistToPolygon(userLat, userLon, coords) {
  if (!coords || coords.length === 0) return Infinity;
  let minDist = Infinity;
  for (const [lon, lat] of coords) {
    const d = distanceNm(userLat, userLon, lat, lon);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

// ──────────────────────────────────────────────────────────
// Format a modification datetime string "202603271948" → ISO string
// ──────────────────────────────────────────────────────────
function parseModDateTime(s) {
  if (!s || s.length < 12) return null;
  try {
    return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(8,10)}:${s.slice(10,12)}:00Z`;
  } catch { return null; }
}

// ──────────────────────────────────────────────────────────
// API: GET /api/tfrs?lat=&lon=&radius=
// radius in nautical miles, default 100
// ──────────────────────────────────────────────────────────
app.get('/api/tfrs', async (req, res) => {
  const userLat = parseFloat(req.query.lat);
  const userLon = parseFloat(req.query.lon);
  const radiusNm = parseFloat(req.query.radius) || 100;

  if (isNaN(userLat) || isNaN(userLon)) {
    return res.status(400).json({ error: 'lat and lon are required' });
  }

  try {
    // Fetch all three sources in parallel
    const [geoRes, listRes, noShapeRes] = await Promise.allSettled([
      client.get(GEOSERVER_URL),
      client.get(TFR_LIST_URL),
      client.get(NO_SHAPE_URL),
    ]);

    // ── Geometry features (required) ──
    if (geoRes.status === 'rejected') {
      return res.status(502).json({ error: `FAA GeoServer unavailable: ${geoRes.reason?.message}` });
    }
    const geoFeatures = geoRes.value.data?.features || [];

    // ── List details (supplemental) ──
    const listItems = listRes.status === 'fulfilled' ? (listRes.value.data || []) : [];
    const noShapeItems = noShapeRes.status === 'fulfilled' ? (noShapeRes.value.data || []) : [];

    // Build a lookup map: notamId → list item
    const listByNotam = new Map();
    for (const item of listItems) {
      listByNotam.set(item.notam_id, item);
    }

    // ── Filter geometry features by distance to user ──
    const nearbyFeatures = [];

    for (const feature of geoFeatures) {
      const geom = feature.geometry;
      if (!geom) continue;

      let dist = Infinity;

      if (geom.type === 'Polygon') {
        const ring = geom.coordinates[0] || [];
        // Use the minimum distance to any vertex for edge detection
        dist = minDistToPolygon(userLat, userLon, ring);
      } else if (geom.type === 'MultiPolygon') {
        for (const poly of geom.coordinates) {
          const d = minDistToPolygon(userLat, userLon, poly[0] || []);
          if (d < dist) dist = d;
        }
      } else if (geom.type === 'Point') {
        const [lon, lat] = geom.coordinates;
        dist = distanceNm(userLat, userLon, lat, lon);
      }

      if (dist > radiusNm) continue;

      const p = feature.properties;
      const notamId = baseNotamId(p.NOTAM_KEY);
      const listItem = listByNotam.get(notamId) || {};

      // Merge geo properties with list detail
      const props = {
        notamId,
        notamKey: p.NOTAM_KEY,
        gid: p.GID,
        facility: listItem.facility || p.CNS_LOCATION_ID || '',
        state: listItem.state || p.STATE || '',
        type: listItem.type || p.LEGAL || '',
        title: p.TITLE || '',
        description: listItem.description || p.TITLE || '',
        modDate: listItem.mod_date || parseModDateTime(p.LAST_MODIFICATION_DATETIME) || '',
        isNew: listItem.is_new === 'Y',
        distanceNm: Math.round(dist),
      };

      nearbyFeatures.push({ ...feature, properties: props });
    }

    // ── Also include no-shape TFRs nearby (show in list only, no geometry) ──
    const nearbyNoShape = noShapeItems.filter(item => {
      // No geometry, so include all (they show as list entries only)
      return true;
    }).map(item => ({
      type: 'Feature',
      geometry: null,
      properties: {
        notamId: item.notam_id || '',
        notamKey: item.notam_key || '',
        gid: item.gid,
        facility: item.cns_location_id || '',
        state: item.state || '',
        type: item.legal || '',
        title: item.title || '',
        description: item.title || '',
        modDate: parseModDateTime(item.last_modification_datetime) || '',
        isNew: false,
        distanceNm: null,
        noShape: true,
      },
    }));

    // Sort nearby features by distance (closest first)
    nearbyFeatures.sort((a, b) => (a.properties.distanceNm || 0) - (b.properties.distanceNm || 0));

    res.json({
      type: 'FeatureCollection',
      features: nearbyFeatures,
      noShapeTfrs: nearbyNoShape,
      meta: {
        totalWithGeometry: geoFeatures.length,
        nearbyWithGeometry: nearbyFeatures.length,
        totalNoShape: noShapeItems.length,
        searchLat: userLat,
        searchLon: userLon,
        searchRadiusNm: radiusNm,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('TFR fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n✈  TFR Locator  →  http://localhost:${PORT}\n`);
});
