# RFID Security Locker — Fresh Website

A new application built from scratch, not a continuation of the previous code. It provides a responsive admin dashboard, server-side login, ThingSpeak channel reading, card approval registry, backend access logs, CSV export, device heartbeat API, and an installable PWA shell.

## Important architecture note

ThingSpeak is the cloud feed for channel analytics and scan history. It is **not** used to store the authorized-card registry, because channel fields are not a suitable secure card database. The app stores card records and detailed access logs in SQLite on the server. The ESP32 should ask the authenticated backend for an access decision before activating the relay.

## Requirements

- Node.js 20+
- ThingSpeak channel ID and (if private) Read API Key
- An HTTPS deployment with persistent disk for production SQLite data
- ESP32 firmware changes for authenticated device endpoints (described below)

## Local setup

1. Extract the ZIP.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Generate a password hash:

   ```bash
   node -e "console.log(require('bcryptjs').hashSync('Replace-With-Your-Strong-Password', 12))"
   ```

5. Paste the output into `ADMIN_PASSWORD_HASH`. Set `ADMIN_EMAIL`.
6. Set a random `SESSION_SECRET` (32+ characters), `DEVICE_API_TOKEN`, `THINGSPEAK_CHANNEL_ID`, and optionally `THINGSPEAK_READ_API_KEY`.
7. Run `npm start`.
8. Open `http://localhost:3000`.

Never commit `.env` to Git. Never put the ThingSpeak Write API Key or device token in the browser frontend.

## ThingSpeak channel field mapping

The dashboard expects the channel feed to use:
- `field1`: `1` for granted, `0` for denied
- `field2`: cumulative total scan count
- `field3`: cumulative denied scan count
- `status`: optional text such as `RFID_UID:A3:7F:12:BC` to preserve the hexadecimal UID
- `field4`: optional UID only if your firmware uses a numeric encoding (the dashboard also accepts hex text in field4, but ThingSpeak channel fields are numeric in standard channels)

ThingSpeak's channel feed is fetched by the server at `/api/thingspeak/latest`. If your channel is private, put its **Read API Key** in `THINGSPEAK_READ_API_KEY`. The website does not expose that key to the browser.

ThingSpeak update intervals/rate limits depend on your account and channel plan. Avoid trying to publish every scan faster than the allowed interval. If scans can happen rapidly, queue events on the ESP32 or write each event to the backend and publish aggregate updates to ThingSpeak.

## Device API (ESP32 firmware integration required)

All device endpoints require this header:

`Authorization: Bearer YOUR_DEVICE_API_TOKEN`

### Heartbeat

`POST /api/device/heartbeat`

```json
{"deviceId":"esp32-locker","firmware":"1.0.0"}
```

Send about every 30 seconds. The dashboard treats a device as online if its last heartbeat is under 90 seconds old.

### Scan / authorization

`POST /api/device/scan`

```json
{"deviceId":"esp32-locker","uid":"A3:7F:12:BC"}
```

Example response:

```json
{
  "ok": true,
  "uid": "A3:7F:12:BC",
  "result": "GRANTED",
  "authorized": true,
  "card": {"uid":"A3:7F:12:BC","name":"Example User","details":"","status":"approved"},
  "timestamp": "2026-01-01T12:00:00.000Z"
}
```

The response result is `GRANTED` only if that UID exists in the backend database with `status: approved`. For secure operation, the ESP32 must keep the relay locked unless it receives a valid successful response and `authorized: true`. If Wi-Fi/backend is unavailable, fail closed (remain locked). Keep the device token secret in firmware as best as possible; physical firmware extraction remains a risk.

### Optional card list sync

`GET /api/device/cards` with the same Bearer token returns each UID and its approval status. This can be used if you want to cache an allowlist locally, but ensure the cache has a short expiry and consider the consequences of revocation.

## PWA

The app has a manifest, icon, and service worker. Serve it over HTTPS in production; localhost is allowed for local development. Offline caching only applies to static assets. Authenticated APIs and security decisions are intentionally not cached.

## Deploy on Render

1. Push the extracted project to a private GitHub repository.
2. Create a Render Web Service from that repository.
3. Set the environment variables shown in `.env.example` in Render's dashboard.
4. Attach a persistent disk mounted at `/var/data`, or use the provided `render.yaml` blueprint.
5. Use a strong random `SESSION_SECRET`, a bcrypt `ADMIN_PASSWORD_HASH`, a private ThingSpeak Read API Key if needed, and a separate `DEVICE_API_TOKEN`.
6. Deploy and test `/api/health`, admin login, and the ThingSpeak feed.

Do not use an ephemeral filesystem for production SQLite: redeploys can erase the database.

## Security limitations / next steps

- This is a deployable starter, not a certified access-control product.
- The session middleware uses the built-in in-memory store. For multi-instance production, use a persistent session store such as Redis.
- Add a reverse proxy/WAF and HTTPS; rotate any keys previously committed to public repositories.
- The browser displays ThingSpeak feed data and local backend access logs separately; it does not silently claim ThingSpeak scans were stored in SQLite.
- CSV includes backend access logs, not a full ThingSpeak feed export.
- The ESP32 firmware must be updated to call `/api/device/scan` and `/api/device/heartbeat`. The website alone cannot control a physical relay.
