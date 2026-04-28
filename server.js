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

async function fetchMetar(icao) {
  const endpoint = new URL('https://aviationweather.gov/api/data/metar');
  endpoint.searchParams.set('ids', icao);
  endpoint.searchParams.set('format', 'json');

  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`AviationWeather API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No METAR found for ICAO '${icao}'.`);
  }

  const first = data[0];
  const rawMetar = first.rawOb || first.raw_text;
  if (!rawMetar || typeof rawMetar !== 'string') {
    throw new Error('METAR response did not include a raw METAR text field.');
  }

  return rawMetar;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/metar') {
    const icao = (url.searchParams.get('icao') || '').trim().toUpperCase();

    if (!icao || !/^[A-Z]{4}$/.test(icao)) {
      res.writeHead(400, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end('<?xml version="1.0" encoding="UTF-8"?>\n<error>Invalid ICAO. Use 4-letter ICAO code, e.g. /metar?icao=MDSD</error>');
      return;
    }

    try {
      const rawMetar = await fetchMetar(icao);
      const convertedMetar = convertQnhToInHgInMetar(rawMetar);

      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<response>',
        `  <icao>${escapeXml(icao)}</icao>`,
        '  <source>https://aviationweather.gov/data/api/#schema</source>',
        `  <raw_text>${escapeXml(convertedMetar)}</raw_text>`,
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
      usage: '/metar?icao=MDSD'
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`METAR API listening on http://localhost:${PORT}`);
});
