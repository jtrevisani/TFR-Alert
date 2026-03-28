/* ── TFR Locator — frontend ── */
'use strict';

// ──────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────
let map = null;
let userMarker = null;
let radiusCircle = null;
let userLat = null;
let userLon = null;
let tfrLayers = [];
let activeNotamId = null;
let lastGeoJSON = null;

// ──────────────────────────────────────────────────────────
// TFR type → color / badge class
// ──────────────────────────────────────────────────────────
const TYPE_COLOR = {
  VIP:              '#58a6ff',
  SECURITY:         '#f85149',
  HAZARDS:          '#db6d28',
  'AIR SHOWS/SPORTS': '#a371f7',
  'SPACE OPERATIONS': '#e3b341',
  STADIUM:          '#3fb950',
};

function typeColor(type) {
  const t = (type || '').toUpperCase().trim();
  return TYPE_COLOR[t] || '#8b949e';
}

function typeBadgeClass(type) {
  const t = (type || '').toUpperCase().trim();
  if (t === 'VIP')               return 'type-vip';
  if (t === 'SECURITY')          return 'type-security';
  if (t === 'HAZARDS')           return 'type-hazard';
  if (t === 'AIR SHOWS/SPORTS')  return 'type-airshow';
  if (t === 'SPACE OPERATIONS')  return 'type-space';
  if (t === 'STADIUM')           return 'type-stadium';
  return 'type-other';
}

// ──────────────────────────────────────────────────────────
// Date / time helpers
// ──────────────────────────────────────────────────────────
function formatDate(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    if (isNaN(d)) return isoStr;
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });
  } catch { return isoStr; }
}

// Parse "MM/DD/YYYY HH:MM:SS" → Date
function parseModDate(s) {
  if (!s) return null;
  try {
    // "03/27/2026 19:48:00"  →  ISO
    const [date, time] = s.split(' ');
    if (!date) return null;
    const [m, d, y] = date.split('/');
    return new Date(`${y}-${m}-${d}T${time || '00:00:00'}Z`);
  } catch { return null; }
}

// Extract approximate effective / expire from the description string
// "CEDAR GROVE, TN, Friday, March 27, 2026 through Saturday, March 28, 2026 UTC"
function parseDatesFromDescription(desc) {
  if (!desc) return {};
  const throughMatch = desc.match(/(.+?)\s+through\s+(.+?)(?:\s+(?:UTC|Local))?$/i);
  if (throughMatch) {
    return {
      effective: throughMatch[1].replace(/^.+,\s+/, '').trim(),
      expire:    throughMatch[2].trim(),
    };
  }
  return {};
}

// ──────────────────────────────────────────────────────────
// Map init
// ──────────────────────────────────────────────────────────
function initMap(lat, lon) {
  map = L.map('map', { center: [lat, lon], zoom: 8, zoomControl: true });

  // Dark aviation-style tile
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> | TFR data: <a href="https://tfr.faa.gov">FAA</a>',
    maxZoom: 19,
  }).addTo(map);

  // User dot
  const icon = L.divIcon({
    className: '', html: '<div class="user-dot"></div>',
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  userMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 })
    .addTo(map)
    .bindPopup('<b>Your Location</b>');
}

function updateUserPosition(lat, lon) {
  if (!map) { initMap(lat, lon); return; }
  map.setView([lat, lon], map.getZoom());
  userMarker.setLatLng([lat, lon]);
}

// Draw search radius ring
function drawRadiusRing(lat, lon, radiusNm) {
  if (radiusCircle) map.removeLayer(radiusCircle);
  radiusCircle = L.circle([lat, lon], {
    radius: radiusNm * 1852,
    color: '#58a6ff', fillOpacity: 0.03, weight: 1, dashArray: '6 4', opacity: 0.4,
  }).addTo(map);
}

// ──────────────────────────────────────────────────────────
// Draw TFR polygons on map
// ──────────────────────────────────────────────────────────
function drawTFRs(geojson) {
  tfrLayers.forEach(l => map.removeLayer(l));
  tfrLayers = [];

  const features = geojson.features || [];
  if (!features.length) return;

  features.forEach((f, idx) => {
    if (!f.geometry) return;
    const p = f.properties;
    const color = typeColor(p.type);
    const geom = f.geometry;

    let layer;

    if (geom.type === 'Polygon') {
      const latlngs = geom.coordinates[0].map(([lon, lat]) => [lat, lon]);
      layer = L.polygon(latlngs, {
        color, fillColor: color, fillOpacity: 0.18, weight: 2, opacity: 0.9,
      });
    } else if (geom.type === 'MultiPolygon') {
      const latlngsArr = geom.coordinates.map(poly =>
        poly[0].map(([lon, lat]) => [lat, lon])
      );
      layer = L.polygon(latlngsArr, {
        color, fillColor: color, fillOpacity: 0.18, weight: 2, opacity: 0.9,
      });
    } else {
      return;
    }

    const dates = parseDatesFromDescription(p.description);
    layer.bindPopup(`
      <div class="popup-notam">${p.notamId}</div>
      <div class="popup-type">${p.type || '—'} · ${p.state || ''}</div>
      <div style="margin-top:5px;font-size:12px;color:#8b949e">${p.title || ''}</div>
      ${p.distanceNm !== null ? `<div style="margin-top:4px;font-size:11px;color:#58a6ff">📍 ${p.distanceNm} NM away</div>` : ''}
      ${dates.expire ? `<div style="margin-top:4px;font-size:11px;color:#8b949e">Until: ${dates.expire}</div>` : ''}
    `);

    layer.on('click', () => {
      highlightCard(p.notamId);
      showDetail(f);
    });

    layer.addTo(map);
    layer._notamId = p.notamId;
    tfrLayers.push(layer);
  });
}

// ──────────────────────────────────────────────────────────
// Sidebar card list
// ──────────────────────────────────────────────────────────
function renderList(geojson) {
  const list = document.getElementById('tfr-list');
  const countEl = document.getElementById('tfr-count');
  const fetchTimeEl = document.getElementById('fetch-time');

  const features = geojson.features || [];
  const noShape = geojson.noShapeTfrs || [];
  const meta = geojson.meta || {};

  // Deduplicate by notamId (multiple polygons per NOTAM)
  const byNotam = new Map();
  for (const f of features) {
    const id = f.properties.notamId;
    if (!byNotam.has(id) || (f.properties.distanceNm < byNotam.get(id).properties.distanceNm)) {
      byNotam.set(id, f);
    }
  }

  const count = byNotam.size;
  countEl.textContent = count;
  countEl.className = 'tfr-count' + (count === 0 ? ' count-zero' : '');

  if (meta.fetchedAt) {
    const t = new Date(meta.fetchedAt);
    fetchTimeEl.textContent = t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  list.innerHTML = '';

  if (count === 0 && noShape.length === 0) {
    list.innerHTML = `
      <div class="placeholder">
        <div class="placeholder-icon">✅</div>
        <p>No TFRs within ${meta.searchRadiusNm || '?'} NM of your location.</p>
      </div>`;
    return;
  }

  // Render geometry TFRs sorted by distance
  const sorted = [...byNotam.values()].sort(
    (a, b) => (a.properties.distanceNm || 999) - (b.properties.distanceNm || 999)
  );

  for (const f of sorted) {
    const p = f.properties;
    const dates = parseDatesFromDescription(p.description);
    list.appendChild(makeTFRCard(p, dates, false));
  }

  // Render no-shape TFRs in a separate section
  if (noShape.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'section-sep';
    sep.innerHTML = `<span>NATIONWIDE / NO GEOMETRY (${noShape.length})</span>`;
    list.appendChild(sep);

    for (const f of noShape) {
      const p = f.properties;
      list.appendChild(makeTFRCard(p, {}, true));
    }
  }
}

function makeTFRCard(p, dates, isNoShape) {
  const card = document.createElement('div');
  card.className = 'tfr-card' + (isNoShape ? ' no-shape' : '');
  card.dataset.notamId = p.notamId;

  const distLabel = p.distanceNm !== null && p.distanceNm !== undefined
    ? `<span class="card-dist">${p.distanceNm} NM</span>` : '';

  const expireText = dates.expire ? `Until ${dates.expire}` : (p.modDate ? `Updated ${p.modDate}` : '');

  card.innerHTML = `
    <div class="card-top">
      <span class="card-notam">${p.notamId}</span>
      <span class="card-type-badge ${typeBadgeClass(p.type)}">${p.type || 'TFR'}</span>
      <span class="card-state">${p.state || ''}</span>
      ${distLabel}
    </div>
    <div class="card-desc">${p.title || p.description || 'No description'}</div>
    ${expireText ? `<div class="card-meta"><span class="card-time">${expireText}</span></div>` : ''}
    ${p.isNew ? '<span class="badge-new">NEW</span>' : ''}`;

  if (!isNoShape) {
    card.addEventListener('click', () => {
      const f = lastGeoJSON?.features?.find(x => x.properties.notamId === p.notamId);
      if (f) showDetail(f);
      highlightCard(p.notamId);
      zoomToNotam(p.notamId);
    });
  }
  return card;
}

function highlightCard(notamId) {
  document.querySelectorAll('.tfr-card').forEach(c => c.classList.remove('active'));
  const card = document.querySelector(`.tfr-card[data-notam-id="${notamId}"]`);
  if (card) {
    card.classList.add('active');
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  activeNotamId = notamId;
}

// ──────────────────────────────────────────────────────────
// Detail panel
// ──────────────────────────────────────────────────────────
function showDetail(feature) {
  const p = feature.properties;
  const panel = document.getElementById('detail-panel');
  document.getElementById('detail-notam-id').textContent = p.notamId;

  const dates = parseDatesFromDescription(p.description || p.title);
  const modDate = parseModDate(p.modDate);
  const polyCount = lastGeoJSON?.features?.filter(f => f.properties.notamId === p.notamId).length || 1;

  document.getElementById('detail-body').innerHTML = `
    <div class="detail-grid">
      <div class="detail-section">
        <div class="detail-label">Type</div>
        <div class="detail-value">${p.type || '—'}</div>
      </div>
      <div class="detail-section">
        <div class="detail-label">Facility (ARTCC)</div>
        <div class="detail-value mono">${p.facility || '—'}</div>
      </div>
      <div class="detail-section">
        <div class="detail-label">State</div>
        <div class="detail-value">${p.state || '—'}</div>
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-label">Description</div>
      <div class="detail-value">${p.title || p.description || '—'}</div>
    </div>
    <div class="detail-grid">
      <div class="detail-section">
        <div class="detail-label">Effective</div>
        <div class="detail-value">${dates.effective || '—'}</div>
      </div>
      <div class="detail-section">
        <div class="detail-label">Expires</div>
        <div class="detail-value">${dates.expire || '—'}</div>
      </div>
      <div class="detail-section">
        <div class="detail-label">Distance</div>
        <div class="detail-value">${p.distanceNm !== null ? p.distanceNm + ' NM' : '—'}</div>
      </div>
    </div>
    <div class="detail-grid">
      <div class="detail-section">
        <div class="detail-label">NOTAM Last Modified</div>
        <div class="detail-value">${modDate ? formatDate(modDate.toISOString()) : p.modDate || '—'}</div>
      </div>
      <div class="detail-section">
        <div class="detail-label">Polygons</div>
        <div class="detail-value">${polyCount}</div>
      </div>
      <div class="detail-section">
        <div class="detail-label">NOTAM Key</div>
        <div class="detail-value mono" style="font-size:11px">${p.notamKey || '—'}</div>
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-label">Official Source</div>
      <div class="detail-value">
        <a href="https://tfr.faa.gov/tfr3/" target="_blank" rel="noopener" style="color:#58a6ff">
          tfr.faa.gov ↗
        </a>
        &nbsp;·&nbsp;
        <a href="https://notams.aim.faa.gov/notamSearch/search?notamNumber=${encodeURIComponent(p.notamId.replace('/','-'))}" target="_blank" rel="noopener" style="color:#58a6ff">
          FAA NOTAM Search ↗
        </a>
      </div>
    </div>`;

  panel.classList.remove('hidden');
}

function zoomToNotam(notamId) {
  if (!map || !lastGeoJSON) return;
  const features = lastGeoJSON.features.filter(f => f.properties.notamId === notamId && f.geometry);
  if (!features.length) return;

  const allLatLngs = [];
  for (const f of features) {
    const geom = f.geometry;
    if (geom.type === 'Polygon') {
      geom.coordinates[0].forEach(([lon, lat]) => allLatLngs.push([lat, lon]));
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach(poly => poly[0].forEach(([lon, lat]) => allLatLngs.push([lat, lon])));
    }
  }
  if (allLatLngs.length) {
    map.fitBounds(L.polygon(allLatLngs).getBounds(), { padding: [40, 40] });
  }
}

// ──────────────────────────────────────────────────────────
// Status banner
// ──────────────────────────────────────────────────────────
function showBanner(msg, type = '') {
  const el = document.getElementById('status-banner');
  el.textContent = msg;
  el.className = 'status-banner' + (type ? ` ${type}` : '');
}
function hideBanner() {
  document.getElementById('status-banner').className = 'status-banner hidden';
}

// ──────────────────────────────────────────────────────────
// Load TFRs from backend
// ──────────────────────────────────────────────────────────
async function loadTFRs() {
  if (userLat === null || userLon === null) return;

  const radius = document.getElementById('radius-select').value;
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  document.body.classList.add('refreshing');
  hideBanner();

  const countEl = document.getElementById('tfr-count');
  countEl.textContent = '…';
  countEl.className = 'tfr-count count-pending';

  // Draw the search ring
  drawRadiusRing(userLat, userLon, parseInt(radius));

  try {
    const res = await fetch(`/api/tfrs?lat=${userLat}&lon=${userLon}&radius=${radius}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const geojson = await res.json();
    if (geojson.error) throw new Error(geojson.error);

    lastGeoJSON = geojson;
    drawTFRs(geojson);
    renderList(geojson);

    const meta = geojson.meta || {};
    if (meta.nearbyWithGeometry === 0 && (geojson.noShapeTfrs || []).length === 0) {
      showBanner(`No TFRs within ${radius} NM. Total active nationwide: ${meta.totalWithGeometry}.`, 'warning');
    } else if (meta.totalWithGeometry > 0) {
      showBanner(
        `${meta.nearbyWithGeometry} TFR${meta.nearbyWithGeometry !== 1 ? 's' : ''} near you · ${meta.totalNoShape} nationwide · ${meta.totalWithGeometry} total active`,
        ''
      );
    }
  } catch (err) {
    console.error('TFR load error:', err);
    showBanner(`Failed to load TFRs: ${err.message}`, 'error');
    countEl.textContent = '!';
    countEl.className = 'tfr-count';
    document.getElementById('tfr-list').innerHTML = `
      <div class="placeholder">
        <div class="placeholder-icon">⚠️</div>
        <p>Could not load TFR data.<br><small>${err.message}</small></p>
      </div>`;
  } finally {
    btn.disabled = false;
    document.body.classList.remove('refreshing');
  }
}

// ──────────────────────────────────────────────────────────
// Geolocation
// ──────────────────────────────────────────────────────────
function setLocation(lat, lon, label) {
  userLat = lat;
  userLon = lon;
  document.getElementById('location-display').textContent = label;
  updateUserPosition(lat, lon);
  loadTFRs();
}

function geolocate() {
  if (!navigator.geolocation) {
    showBanner('Geolocation not supported — using US default.', 'warning');
    setLocation(37.5, -97.5, 'United States (default)');
    return;
  }

  document.getElementById('location-display').textContent = 'Locating…';

  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const latStr = lat.toFixed(4) + '°' + (lat >= 0 ? 'N' : 'S');
      const lonStr = Math.abs(lon).toFixed(4) + '°' + (lon >= 0 ? 'E' : 'W');
      setLocation(lat, lon, `${latStr}  ${lonStr}`);
    },
    err => {
      console.warn('Geolocation error:', err.code, err.message);
      showBanner('Location unavailable — showing US. Enable location for accurate results.', 'warning');
      setLocation(37.5, -97.5, 'United States (default)');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

// ──────────────────────────────────────────────────────────
// Event wiring
// ──────────────────────────────────────────────────────────
document.getElementById('refresh-btn').addEventListener('click', loadTFRs);
document.getElementById('radius-select').addEventListener('change', loadTFRs);
document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-panel').classList.add('hidden');
  document.querySelectorAll('.tfr-card').forEach(c => c.classList.remove('active'));
  activeNotamId = null;
});

// ──────────────────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────────────────
geolocate();
