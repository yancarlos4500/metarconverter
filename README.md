# METAR API

Small Node.js API that fetches METAR from AviationWeather and returns XML with METAR text in a `raw_text` tag, converting `Qxxxx` to inHg code `Axxxx`.

Source API: https://aviationweather.gov/data/api/#schema

## Run

```bash
npm start
```

Server starts on `http://localhost:3000`.

## Deploy To Railway

1. Push this folder to a GitHub repository.
2. In Railway, create a new project and choose **Deploy from GitHub repo**.
3. Select your repository.
4. Railway will detect Node.js and use `npm start`.
5. After deploy, your public URL will be shown in Railway.

`PORT` is provided automatically by Railway, and this API already uses `process.env.PORT`.

## Endpoint

`GET /metar?icao=MDSD`

Example response:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<response>
  <icao>MDSD</icao>
  <source>https://aviationweather.gov/data/api/#schema</source>
  <raw_text>MDSD 280000Z 15006KT 9999 SCT018 BKN300 27/24 A2994</raw_text>
</response>
```
# metarconverter
