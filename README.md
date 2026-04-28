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

`GET /metar?ids=MDSD,MDPC&format=xml`

Example response:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<response>
  <query_ids>MDSD,MDPC</query_ids>
  <source>https://aviationweather.gov/data/api/#schema</source>
  <metar>
    <icao>MDSD</icao>
    <raw_text>MDSD 280000Z 15006KT 9999 SCT018 BKN300 27/24 A2994</raw_text>
  </metar>
  <metar>
    <icao>MDPC</icao>
    <raw_text>MDPC 280000Z 11008KT 9999 FEW020 26/24 A2992</raw_text>
  </metar>
</response>
```
# metarconverter
