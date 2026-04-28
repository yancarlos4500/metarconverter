const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

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

  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`AviationWeather API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No METAR found for ICAO(s) '${ids.join(',')}'.`);
  }

  return data;
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

          const convertedMetar = convertQnhToInHgInMetar(rawMetar);
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

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      message: 'METAR API is running',
      usage: '/metar?ids=MDSD,MDPC&format=xml'
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`METAR API listening on http://localhost:${PORT}`);
});
