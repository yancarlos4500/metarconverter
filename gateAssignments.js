const { DR_AIRPORT_GATES } = require('./gates');

const VATSIM_DATA_URL = 'https://data.vatsim.net/v3/vatsim-data.json';
const REFRESH_INTERVAL_MS = 60 * 1000; // VATSIM data refreshes ~every 15s; we poll every 60s.

// Detection thresholds for "parked at a gate".
const PARKED_GROUNDSPEED_KT = 5;        // <= this groundspeed counts as stopped
const GATE_PROXIMITY_METERS = 80;       // snap radius around a stand
const AIRPORT_PROXIMITY_METERS = 6000;  // pre-filter pilots near an airport

// assignments[icao][callsign] = {
//   gate, manual, source, aircraftType, origin, lat, lon, lastSeen
// }
// source: 'manual' | 'reservation' | 'detected'
const assignments = {};

// ICAO airline codes that park at MDPC Terminal B (B-prefixed stands).
const TERMINAL_B_AIRLINES = new Set([
  'ARG', // Aerolineas Argentinas
  'AAL', // American Airlines
  'CEY', // Air Century
  'AEA', // Air Europa
  'DWI', // Arajet
  'BAW', // British Airways
  'CMP', // Copa Airlines
  'DAL', // Delta
  'EDW', // Edelweiss
  'SWA'  // Southwest
]);

// Classify a callsign into a parking preference category for MDPC.
// Returns 'B' (Terminal B), 'VIP' (general aviation → TVIP), or 'OTHER'.
function classifyCallsign(callsign) {
  if (!callsign) return 'OTHER';
  const m = callsign.match(/^([A-Z]{3})\d/); // ICAO airline code + digit(s)
  if (m) {
    return TERMINAL_B_AIRLINES.has(m[1]) ? 'B' : 'OTHER';
  }
  // No airline ICAO prefix → treat as general aviation (tail numbers like N123AB, HI-xxx).
  return 'VIP';
}

// Gates that should never be auto-assigned (manual override still allowed via API).
const MDPC_BLOCKED_AUTO_GATES = new Set([
  'B34', 'B35', 'B36', 'B37',
  'N6', 'N7', 'N8', 'N9', 'N10', 'N11', 'N12', 'N13',
  '1A', '8A', '9A', '11A',
  'B23A', 'B23B', 'B29A', 'B30A'
]);

// MDPC heavy-jet preferred stands (only these for heavies).
const MDPC_HEAVY_GATES = ['B25', 'B23', 'B30', '1', '2', '3', '4'];

// Apron 1 gates that must fill before N1–N5 are considered.
const MDPC_APRON1_BEFORE_N = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
const MDPC_NORTH_OVERFLOW = ['N1', 'N2', 'N3', 'N4', 'N5'];

// ICAO type designators considered "heavy" (or super) by ICAO wake category.
const HEAVY_TYPES = new Set([
  // Boeing
  'B741', 'B742', 'B743', 'B744', 'B748',
  'B772', 'B77L', 'B773', 'B77W', 'B778', 'B779',
  'B762', 'B763', 'B764',
  'B788', 'B789', 'B78X',
  // Airbus
  'A332', 'A333', 'A338', 'A339',
  'A342', 'A343', 'A345', 'A346',
  'A359', 'A35K',
  'A388', // super
  // McDonnell Douglas / others
  'MD11', 'DC10', 'IL96', 'A124', 'A225',
  // Common freighters
  'B74F', 'B77F', 'MD1F'
]);

function isHeavyType(aircraftType) {
  if (!aircraftType) return false;
  const t = String(aircraftType).toUpperCase().replace(/[^A-Z0-9]/g, '');
  // VATSIM types can be like "B77W/H" or "H/B77W/L"; the regex strips slashes.
  // Try to find a 4-char ICAO designator inside the string.
  for (let i = 0; i + 4 <= t.length; i++) {
    if (HEAVY_TYPES.has(t.slice(i, i + 4))) return true;
  }
  // Some pilots prefix wake category: "H/B77W"
  if (/(^|\b)H[\/-]/.test(String(aircraftType).toUpperCase())) return true;
  return HEAVY_TYPES.has(t);
}

// --- Geo helpers ---
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestGate(icao, lat, lon) {
  const positions = gatePositions(icao);
  let best = null;
  for (const p of positions) {
    const d = haversineMeters(lat, lon, p.lat, p.lon);
    if (!best || d < best.distance) best = { gate: p.gate, distance: d };
  }
  return best;
}

// reverse lookup: gate -> callsign per airport
function gateInUse(icao, gate) {
  const a = assignments[icao] || {};
  return Object.values(a).some((entry) => entry.gate === gate);
}

function isDrAirport(icao) {
  return Object.prototype.hasOwnProperty.call(DR_AIRPORT_GATES, icao);
}

// Build the preferred gate order for a given callsign at an airport.
function preferredGateOrder(icao, callsign, meta = {}) {
  const inventory = DR_AIRPORT_GATES[icao];
  if (!inventory) return [];
  const all = inventory.gates;
  if (icao !== 'MDPC') return all;

  // Filter out gates that should never be auto-assigned.
  const allowed = all.filter((g) => !MDPC_BLOCKED_AUTO_GATES.has(g));

  // Heavy aircraft: only the heavy stands (in fixed priority order).
  if (isHeavyType(meta.aircraftType)) {
    return MDPC_HEAVY_GATES.filter((g) => allowed.includes(g));
  }

  const category = classifyCallsign(callsign);
  const terminalB = allowed.filter((g) => /^B\d/.test(g));
  const vip = allowed.filter((g) => g === 'TVIP');
  const cargo = allowed.filter((g) => /^C\d/.test(g));
  const apron1 = allowed.filter((g) => MDPC_APRON1_BEFORE_N.includes(g));
  const northOverflow = allowed.filter((g) => MDPC_NORTH_OVERFLOW.includes(g));

  // N1–N5 can only be used once apron 1 (1–11) is full.
  const apron1FullForOverflow = MDPC_APRON1_BEFORE_N
    .filter((g) => allowed.includes(g))
    .every((g) => gateInUse(icao, g));
  const northAvailable = apron1FullForOverflow ? northOverflow : [];

  // "Rest" = anything not categorized above (excludes blocked, B-stands, VIP, cargo,
  // apron1 gates, and N1-N5).
  const categorized = new Set([
    ...terminalB, ...vip, ...cargo, ...apron1, ...northOverflow
  ]);
  const rest = allowed.filter((g) => !categorized.has(g));

  if (category === 'B') {
    return [...terminalB, ...apron1, ...northAvailable, ...rest];
  }
  // Non-Terminal-B traffic must NEVER be auto-assigned a B-stand.
  if (category === 'VIP') {
    return [...vip, ...apron1, ...northAvailable, ...rest];
  }
  return [...apron1, ...northAvailable, ...rest, ...vip];
}

function pickNextGate(icao, callsign, meta = {}) {
  const order = preferredGateOrder(icao, callsign, meta);
  // Pick a random free gate from the eligible candidates rather than always
  // taking the first one. Category/heavy/blocked rules still constrain `order`.
  const free = order.filter((g) => !gateInUse(icao, g));
  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)];
}

function ensureAirportBucket(icao) {
  if (!assignments[icao]) assignments[icao] = {};
  return assignments[icao];
}

function autoAssign(icao, callsign, meta = {}) {
  const bucket = ensureAirportBucket(icao);
  if (bucket[callsign]) {
    bucket[callsign].lastSeen = Date.now();
    if (meta.aircraftType) bucket[callsign].aircraftType = meta.aircraftType;
    if (meta.origin) bucket[callsign].origin = meta.origin;
    return bucket[callsign];
  }
  const gate = pickNextGate(icao, callsign, meta);
  if (!gate) return null;
  bucket[callsign] = {
    gate,
    manual: false,
    source: 'reservation',
    aircraftType: meta.aircraftType || null,
    origin: meta.origin || null,
    lat: null,
    lon: null,
    lastSeen: Date.now()
  };
  return bucket[callsign];
}

// Snap a parked pilot to the nearest stand. Overrides any prior reservation
// for this callsign. If another callsign was holding that gate as a
// reservation, that reservation is moved to a new free gate (or dropped if
// nothing is free).
function detectGateOccupancy(icao, callsign, lat, lon, meta = {}) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const near = nearestGate(icao, lat, lon);
  if (!near || near.distance > GATE_PROXIMITY_METERS) return null;
  const bucket = ensureAirportBucket(icao);
  const now = Date.now();

  // Evict whoever is sitting on that gate by a stale reservation.
  for (const [cs, entry] of Object.entries(bucket)) {
    if (cs === callsign) continue;
    if (entry.gate !== near.gate) continue;
    if (entry.source === 'detected') {
      // Two aircraft can't physically occupy the same stand at once. Keep the
      // most recent detection; older one is released.
      delete bucket[cs];
    } else {
      // Reservation/manual: bump them to another free gate if possible.
      const alt = pickNextGate(icao, cs, { aircraftType: entry.aircraftType });
      if (alt) entry.gate = alt; else delete bucket[cs];
    }
  }

  bucket[callsign] = {
    gate: near.gate,
    manual: bucket[callsign] && bucket[callsign].manual ? true : false,
    source: 'detected',
    aircraftType: meta.aircraftType || (bucket[callsign] && bucket[callsign].aircraftType) || null,
    origin: meta.origin || (bucket[callsign] && bucket[callsign].origin) || null,
    lat, lon,
    lastSeen: now
  };
  return bucket[callsign];
}

function setAssignment(icao, callsign, gate) {
  if (!isDrAirport(icao)) {
    const err = new Error(`Unknown DR airport '${icao}'.`);
    err.statusCode = 404;
    throw err;
  }
  const inventory = DR_AIRPORT_GATES[icao];
  if (!inventory.gates.includes(gate)) {
    const err = new Error(`Gate '${gate}' does not exist at ${icao}.`);
    err.statusCode = 400;
    throw err;
  }
  const bucket = ensureAirportBucket(icao);
  // If gate is in use by another callsign, reject.
  for (const [cs, entry] of Object.entries(bucket)) {
    if (cs !== callsign && entry.gate === gate) {
      const err = new Error(`Gate '${gate}' is already assigned to ${cs}.`);
      err.statusCode = 409;
      throw err;
    }
  }
  const existing = bucket[callsign] || { aircraftType: null, origin: null, lastSeen: Date.now() };
  bucket[callsign] = {
    ...existing,
    gate,
    manual: true,
    source: 'manual',
    lastSeen: Date.now()
  };
  return bucket[callsign];
}

function releaseAssignment(icao, callsign) {
  const bucket = assignments[icao];
  if (!bucket || !bucket[callsign]) return false;
  delete bucket[callsign];
  return true;
}

function gatePositions(icao) {
  const info = DR_AIRPORT_GATES[icao];
  if (!info) return [];
  const { lat, lon, gates, gateCoords } = info;
  // If explicit per-gate coords are provided, use them.
  if (gateCoords) {
    return gates.map((gate) => {
      const c = gateCoords[gate];
      return c
        ? { gate, lat: c.lat, lon: c.lon }
        : { gate, lat, lon }; // fallback to airport ref
    });
  }
  // Otherwise lay gates in a horizontal arc just north of the airport ref point.
  const n = gates.length;
  const spread = 0.004;
  const step = n > 1 ? spread / (n - 1) : 0;
  const startLon = lon - spread / 2;
  return gates.map((gate, i) => ({
    gate,
    lat: lat + 0.0006,
    lon: startLon + step * i
  }));
}

function listAssignments(icao) {
  const inventory = DR_AIRPORT_GATES[icao];
  if (!inventory) return null;
  const bucket = assignments[icao] || {};
  const assigned = Object.entries(bucket).map(([callsign, entry]) => ({
    callsign,
    gate: entry.gate,
    manual: entry.manual,
    source: entry.source || (entry.manual ? 'manual' : 'reservation'),
    aircraftType: entry.aircraftType,
    origin: entry.origin,
    lastSeen: new Date(entry.lastSeen).toISOString()
  }));
  const used = new Set(assigned.map((a) => a.gate));
  const available = inventory.gates.filter((g) => !used.has(g));
  const positions = gatePositions(icao);
  const callsignByGate = Object.fromEntries(assigned.map((a) => [a.gate, a.callsign]));
  return {
    icao,
    name: inventory.name,
    lat: inventory.lat,
    lon: inventory.lon,
    totalGates: inventory.gates.length,
    available,
    assignments: assigned,
    gates: positions.map((p) => ({
      ...p,
      occupied: used.has(p.gate),
      callsign: callsignByGate[p.gate] || null
    }))
  };
}

function listAirports() {
  return Object.entries(DR_AIRPORT_GATES).map(([icao, info]) => ({
    icao,
    name: info.name,
    lat: info.lat,
    lon: info.lon,
    totalGates: info.gates.length,
    assigned: Object.keys(assignments[icao] || {}).length
  }));
}

async function refreshFromVatsim() {
  let response;
  try {
    response = await fetch(VATSIM_DATA_URL, { headers: { Accept: 'application/json' } });
  } catch (err) {
    console.error('VATSIM fetch failed:', err.message);
    return;
  }
  if (!response.ok) {
    console.error('VATSIM fetch non-OK:', response.status);
    return;
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error('VATSIM JSON parse failed:', err.message);
    return;
  }
  const pilots = Array.isArray(data.pilots) ? data.pilots : [];
  const now = Date.now();
  // For each DR airport, track which callsigns are "still around" (either filed
  // arrival OR physically near the airport). Anything else becomes stale.
  const activeByAirport = {};
  const airportEntries = Object.entries(DR_AIRPORT_GATES);

  for (const pilot of pilots) {
    const callsign = String(pilot.callsign || '').toUpperCase();
    if (!callsign) continue;
    const lat = typeof pilot.latitude === 'number' ? pilot.latitude : null;
    const lon = typeof pilot.longitude === 'number' ? pilot.longitude : null;
    const gs = typeof pilot.groundspeed === 'number' ? pilot.groundspeed : null;
    const filedArrival = pilot.flight_plan && pilot.flight_plan.arrival
      ? String(pilot.flight_plan.arrival).toUpperCase()
      : null;
    const aircraftType = pilot.flight_plan
      ? (pilot.flight_plan.aircraft_short || pilot.flight_plan.aircraft || null)
      : null;
    const origin = pilot.flight_plan ? pilot.flight_plan.departure : null;

    // 1) Filed arrival → maintain a reservation at the destination DR airport.
    if (filedArrival && isDrAirport(filedArrival)) {
      if (!activeByAirport[filedArrival]) activeByAirport[filedArrival] = new Set();
      activeByAirport[filedArrival].add(callsign);
      autoAssign(filedArrival, callsign, { aircraftType, origin });
    }

    // 2) Detect physical occupancy at ANY DR airport (regardless of flight plan).
    if (lat !== null && lon !== null && gs !== null && gs <= PARKED_GROUNDSPEED_KT) {
      for (const [icao, info] of airportEntries) {
        const dist = haversineMeters(lat, lon, info.lat, info.lon);
        if (dist > AIRPORT_PROXIMITY_METERS) continue;
        const snapped = detectGateOccupancy(icao, callsign, lat, lon, { aircraftType, origin });
        if (snapped) {
          if (!activeByAirport[icao]) activeByAirport[icao] = new Set();
          activeByAirport[icao].add(callsign);
        }
        break; // a pilot can only be at one airport at a time
      }
    }
  }

  // Release stale entries.
  // - 'detected': removed as soon as the pilot is no longer near the gate.
  // - 'reservation': 10 min grace after disappearing from VATSIM.
  // - 'manual': 2 h grace.
  for (const [icao, bucket] of Object.entries(assignments)) {
    const active = activeByAirport[icao] || new Set();
    for (const [callsign, entry] of Object.entries(bucket)) {
      if (active.has(callsign)) {
        entry.lastSeen = now;
        continue;
      }
      const ageMs = now - entry.lastSeen;
      let staleMs;
      if (entry.source === 'manual' || entry.manual) staleMs = 2 * 60 * 60 * 1000;
      else if (entry.source === 'detected') staleMs = 2 * 60 * 1000;
      else staleMs = 10 * 60 * 1000; // reservation
      if (ageMs > staleMs) {
        delete bucket[callsign];
      }
    }
  }
}

function startRefreshLoop() {
  // fire-and-forget; errors handled inside.
  refreshFromVatsim();
  return setInterval(refreshFromVatsim, REFRESH_INTERVAL_MS);
}

module.exports = {
  isDrAirport,
  listAirports,
  listAssignments,
  setAssignment,
  autoAssign,
  releaseAssignment,
  refreshFromVatsim,
  startRefreshLoop,
  DR_AIRPORT_GATES
};
