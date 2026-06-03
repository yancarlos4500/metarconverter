const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const gateApi = require('./gateAssignments');

const PORT = process.env.PORT || 3000;
const MAP_HTML_PATH = path.join(__dirname, 'public', 'map.html');

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function qnhHpaToAltimeterInHgCode(qnhHpa) {
  const inHg = qnhHpa * 0.0295299830714;
  const hundredths = Math.round(inHg * 100);
  return `A${String(hundredths).padStart(4, '0')}`;
}

function convertQnhToInHgInMetar(rawMetar) {
  // Replace any QNH group like Q1014 with A2994.
  return rawMetar.replace(/\bQ(\d{4})\b/g, (_, qnh) => {
    const qnhHpa = Number(qnh);
    return qnhHpaToAltimeterInHgCode(qnhHpa);
  });
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function fetchMetars(ids) {
  const endpoint = new URL('https://aviationweather.gov/api/data/metar');
  endpoint.searchParams.set('ids', ids.join(','));
  endpoint.searchParams.set('format', 'json');

  const response = await fetch(endpoint, {
    headers: {
      Accept: 'application/json'
    }
  });

  if (response.status === 204) {
    throw new Error(`No METAR found for ICAO(s) '${ids.join(',')}'.`);
  }

  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(`AviationWeather API error: ${response.status} ${response.statusText}`);
  }

  if (!rawBody.trim()) {
    throw new Error(`No METAR found for ICAO(s) '${ids.join(',')}'.`);
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error('AviationWeather API returned malformed JSON.');
  }

  const rows = Array.isArray(data)
    ? data
    : (data && Array.isArray(data.data) ? data.data : []);

  if (rows.length === 0) {
    throw new Error(`No METAR found for ICAO(s) '${ids.join(',')}'.`);
  }

  return rows;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/metar') {
    const format = (url.searchParams.get('format') || 'xml').trim().toLowerCase();
    const idsParam = (url.searchParams.get('ids') || url.searchParams.get('icao') || '').trim().toUpperCase();
    const ids = idsParam
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (format !== 'xml') {
      res.writeHead(400, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end('<?xml version="1.0" encoding="UTF-8"?>\n<error>Invalid format. Use format=xml</error>');
      return;
    }

    if (ids.length === 0 || ids.some((id) => !/^[A-Z]{4}$/.test(id))) {
      res.writeHead(400, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end('<?xml version="1.0" encoding="UTF-8"?>\n<error>Invalid ids. Use comma-separated ICAO values, e.g. /metar?ids=MDSD,MDPC&amp;format=xml</error>');
      return;
    }

    try {
      const rows = await fetchMetars(ids);
      const metarEntries = rows
        .map((row) => {
          const station = row.icaoId || row.icao || row.station_id || '';
          const rawMetar = row.rawOb || row.raw_text;
          if (!station || !rawMetar || typeof rawMetar !== 'string') {
            return null;
          }

          const normalizedMetar = rawMetar.replace(/^\s*METAR\s+/i, '');
          const convertedMetar = convertQnhToInHgInMetar(normalizedMetar);
          return [
            '  <metar>',
            `    <icao>${escapeXml(station)}</icao>`,
            `    <raw_text>${escapeXml(convertedMetar)}</raw_text>`,
            '  </metar>'
          ].join('\n');
        })
        .filter(Boolean);

      if (metarEntries.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end('<?xml version="1.0" encoding="UTF-8"?>\n<error>No valid METAR entries found for requested ids.</error>');
        return;
      }

      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<response>',
        `  <query_ids>${escapeXml(ids.join(','))}</query_ids>`,
        '  <source>https://aviationweather.gov/data/api/#schema</source>',
        ...metarEntries,
        '</response>'
      ].join('\n');

      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(xml);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<error>${escapeXml(err.message)}</error>`);
    }
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/map')) {
    fs.readFile(MAP_HTML_PATH, (err, content) => {
      if (err) {
        sendJson(res, 500, { error: 'Failed to load map UI.' });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      message: 'METAR API is running',
      endpoints: {
        map: 'GET /  (or /map) — interactive map UI',
        metar: '/metar?ids=MDSD,MDPC&format=xml',
        listAirports: 'GET /gates',
        airportDetail: 'GET /gates/:icao',
        createAssignment: 'POST /gates/:icao/assignments  body:{callsign,gate?}',
        changeAssignment: 'PUT /gates/:icao/assignments/:callsign  body:{gate}',
        releaseAssignment: 'DELETE /gates/:icao/assignments/:callsign',
        forceRefresh: 'POST /gates/refresh'
      }
    }));
    return;
  }

  // ---- Gate assignment API (Dominican Republic airports) ----
  // GET    /gates                       -> list DR airports + counts
  // GET    /gates/:icao                 -> list gates, available, current assignments
  // POST   /gates/:icao/assignments     -> body { callsign, gate? } create/override
  // PUT    /gates/:icao/assignments/:cs -> body { gate } change gate
  // DELETE /gates/:icao/assignments/:cs -> release assignment
  // POST   /gates/refresh               -> force VATSIM refresh

  if (url.pathname === '/gates' && req.method === 'GET') {
    sendJson(res, 200, { airports: gateApi.listAirports() });
    return;
  }

  if (url.pathname === '/gates/refresh' && req.method === 'POST') {
    try {
      await gateApi.refreshFromVatsim();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return;
  }

  const gatesMatch = url.pathname.match(/^\/gates\/([A-Za-z]{4})(?:\/assignments(?:\/([^/]+))?)?\/?$/);
  if (gatesMatch) {
    const icao = gatesMatch[1].toUpperCase();
    const callsignParam = gatesMatch[2] ? decodeURIComponent(gatesMatch[2]).toUpperCase() : null;

    if (!gateApi.isDrAirport(icao)) {
      sendJson(res, 404, { error: `Airport '${icao}' is not a supported Dominican Republic airport.` });
      return;
    }

    const isAssignmentsRoot = url.pathname.match(/\/assignments\/?$/) && !callsignParam;
    const isAssignmentItem = !!callsignParam;
    const isAirportRoot = !url.pathname.includes('/assignments');

    // GET airport details
    if (isAirportRoot && req.method === 'GET') {
      sendJson(res, 200, gateApi.listAssignments(icao));
      return;
    }

    // POST new assignment (auto-pick or specified gate)
    if (isAssignmentsRoot && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const callsign = String(body.callsign || '').trim().toUpperCase();
        if (!callsign) {
          sendJson(res, 400, { error: 'Body field "callsign" is required.' });
          return;
        }
        const gate = body.gate ? String(body.gate).trim() : null;
        let assignment;
        if (gate) {
          assignment = gateApi.setAssignment(icao, callsign, gate);
        } else {
          // auto-assign next free gate using the same preference rules.
          const auto = gateApi.autoAssign(icao, callsign, {});
          if (!auto) {
            sendJson(res, 409, { error: `No available gates at ${icao}.` });
            return;
          }
          assignment = auto;
        }
        sendJson(res, 200, { icao, callsign, ...assignment });
      } catch (err) {
        sendJson(res, err.statusCode || 400, { error: err.message });
      }
      return;
    }

    // PUT change gate for a specific callsign
    if (isAssignmentItem && req.method === 'PUT') {
      try {
        const body = await readJsonBody(req);
        const gate = body.gate ? String(body.gate).trim() : null;
        if (!gate) {
          sendJson(res, 400, { error: 'Body field "gate" is required.' });
          return;
        }
        const assignment = gateApi.setAssignment(icao, callsignParam, gate);
        sendJson(res, 200, { icao, callsign: callsignParam, ...assignment });
      } catch (err) {
        sendJson(res, err.statusCode || 400, { error: err.message });
      }
      return;
    }

    // DELETE release a callsign's gate
    if (isAssignmentItem && req.method === 'DELETE') {
      const ok = gateApi.releaseAssignment(icao, callsignParam);
      if (!ok) {
        sendJson(res, 404, { error: `No assignment found for ${callsignParam} at ${icao}.` });
        return;
      }
      sendJson(res, 200, { ok: true, icao, callsign: callsignParam });
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

gateApi.startRefreshLoop();

server.listen(PORT, () => {
  console.log(`METAR API listening on http://localhost:${PORT}`);
});
