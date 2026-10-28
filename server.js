require("dotenv").config();

const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const DEVICE_API_TOKEN = process.env.DEVICE_API_TOKEN || "";
const CHANNEL_ID = (process.env.THINGSPEAK_CHANNEL_ID || "").trim();
const READ_KEY = (process.env.THINGSPEAK_READ_API_KEY || "").trim();
const RESULTS = Math.min(8000, Math.max(1, Number(process.env.THINGSPEAK_RESULTS || 100)));

if (isProduction) app.set("trust proxy", Number(process.env.TRUST_PROXY || 1));

const dbPath = process.env.DATABASE_PATH || "./data/rfid.sqlite";
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    uid TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,
    result TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'backend',
    device_id TEXT NOT NULL DEFAULT 'esp32-locker',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_status (
    device_id TEXT PRIMARY KEY,
    online INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT,
    firmware TEXT NOT NULL DEFAULT '',
    ip_hint TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_logs_created ON access_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_logs_uid ON access_logs(uid);
`);

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  }
}));
app.use(express.json({ limit: "50kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use(session({
  name: "rfid.sid",
  secret: SESSION_SECRET || "development-only-change-me-before-deploying",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: isProduction,
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." }
});

const requireAdmin = (req, res, next) => {
  if (req.session && req.session.adminEmail) return next();
  return res.status(401).json({ error: "Please sign in." });
};

function cleanUid(value) {
  return String(value || "").trim().replace(/\s+/g, "").replace(/-/g, ":").toUpperCase().slice(0, 80);
}
function validUid(uid) {
  return /^[0-9A-F]{2}(?::[0-9A-F]{2}){1,9}$/.test(uid);
}
function nowIso() { return new Date().toISOString(); }

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  service: "rfid-security-locker",
  thingspeakConfigured: Boolean(CHANNEL_ID),
  time: nowIso()
}));

app.get("/api/auth/me", (req, res) => {
  res.json({ authenticated: Boolean(req.session?.adminEmail), email: req.session?.adminEmail || null });
});

app.post("/api/auth/login", loginLimiter, async (req, res, next) => {
  try {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH || !SESSION_SECRET || SESSION_SECRET.length < 32) {
      return res.status(503).json({ error: "Admin authentication is not configured. Set ADMIN_EMAIL, ADMIN_PASSWORD_HASH and a 32+ character SESSION_SECRET." });
    }
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const match = email === ADMIN_EMAIL && await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!match) return res.status(401).json({ error: "Invalid email or password." });
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.adminEmail = email;
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        res.json({ ok: true, email });
      });
    });
  } catch (err) { next(err); }
});

app.post("/api/auth/logout", requireAdmin, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie("rfid.sid", { httpOnly: true, sameSite: "strict", secure: isProduction });
    res.json({ ok: true });
  });
});

app.get("/api/thingspeak/latest", requireAdmin, async (_req, res, next) => {
  if (!CHANNEL_ID) return res.status(503).json({ error: "ThingSpeak channel ID is not configured." });
  try {
    const url = new URL(`https://api.thingspeak.com/channels/${encodeURIComponent(CHANNEL_ID)}/feeds.json`);
    url.searchParams.set("results", String(RESULTS));
    if (READ_KEY) url.searchParams.set("api_key", READ_KEY);
    const upstream = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) return res.status(502).json({ error: `ThingSpeak returned HTTP ${upstream.status}.` });
    const payload = await upstream.json();
    res.set("Cache-Control", "no-store");
    res.json({
      channel: payload.channel ? { id: payload.channel.id, name: payload.channel.name } : null,
      feeds: Array.isArray(payload.feeds) ? payload.feeds : []
    });
  } catch (err) { next(err); }
});

app.get("/api/cards", requireAdmin, (req, res) => {
  const status = ["pending", "approved", "rejected"].includes(req.query.status) ? req.query.status : null;
  const rows = status
    ? db.prepare("SELECT * FROM cards WHERE status=? ORDER BY updated_at DESC").all(status)
    : db.prepare("SELECT * FROM cards ORDER BY updated_at DESC").all();
  res.json({ cards: rows });
});

app.post("/api/cards", requireAdmin, (req, res) => {
  const uid = cleanUid(req.body.uid);
  const name = String(req.body.name || "").trim().slice(0, 120);
  const details = String(req.body.details || "").trim().slice(0, 500);
  if (!validUid(uid)) return res.status(400).json({ error: "UID format invalid. Use hexadecimal bytes, e.g. A3:7F:12:BC." });
  if (!name) return res.status(400).json({ error: "Enter the card holder's name." });
  const current = nowIso();
  try {
    db.prepare(`INSERT INTO cards(uid,name,details,status,created_at,updated_at)
      VALUES(?,?,?,'pending',?,?)
      ON CONFLICT(uid) DO UPDATE SET name=excluded.name, details=excluded.details, updated_at=excluded.updated_at`)
      .run(uid, name, details, current, current);
    res.status(201).json({ ok: true, card: db.prepare("SELECT * FROM cards WHERE uid=?").get(uid) });
  } catch (err) { res.status(500).json({ error: "Could not save card." }); }
});

app.patch("/api/cards/:uid/status", requireAdmin, (req, res) => {
  const uid = cleanUid(req.params.uid);
  const status = String(req.body.status || "");
  if (!["pending", "approved", "rejected"].includes(status)) return res.status(400).json({ error: "Status must be pending, approved or rejected." });
  const result = db.prepare("UPDATE cards SET status=?, updated_at=? WHERE uid=?").run(status, nowIso(), uid);
  if (!result.changes) return res.status(404).json({ error: "Card not found." });
  res.json({ ok: true, card: db.prepare("SELECT * FROM cards WHERE uid=?").get(uid) });
});

app.delete("/api/cards/:uid", requireAdmin, (req, res) => {
  const result = db.prepare("DELETE FROM cards WHERE uid=?").run(cleanUid(req.params.uid));
  if (!result.changes) return res.status(404).json({ error: "Card not found." });
  res.json({ ok: true });
});

app.get("/api/logs", requireAdmin, (req, res) => {
  const from = String(req.query.from || "").slice(0, 10);
  const to = String(req.query.to || "").slice(0, 10);
  const uid = cleanUid(req.query.uid || "");
  const result = String(req.query.result || "").toUpperCase();
  const clauses = [];
  const params = [];
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { clauses.push("created_at >= ?"); params.push(`${from}T00:00:00.000Z`); }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { clauses.push("created_at < ?"); const d = new Date(`${to}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate()+1); params.push(d.toISOString()); }
  if (uid) { clauses.push("uid LIKE ?"); params.push(`%${uid}%`); }
  if (["GRANTED", "DENIED"].includes(result)) { clauses.push("UPPER(result) = ?"); params.push(result); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const logs = db.prepare(`SELECT * FROM access_logs ${where} ORDER BY created_at DESC LIMIT 2000`).all(...params);
  res.json({ logs });
});

app.get("/api/logs.csv", requireAdmin, (req, res) => {
  const from = String(req.query.from || "").slice(0, 10);
  const to = String(req.query.to || "").slice(0, 10);
  const uid = cleanUid(req.query.uid || "");
  const clauses = [];
  const params = [];
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { clauses.push("created_at >= ?"); params.push(`${from}T00:00:00.000Z`); }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { clauses.push("created_at < ?"); const d = new Date(`${to}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate()+1); params.push(d.toISOString()); }
  if (uid) { clauses.push("uid LIKE ?"); params.push(`%${uid}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT id,uid,result,source,device_id,note,created_at FROM access_logs ${where} ORDER BY created_at DESC LIMIT 10000`).all(...params);
  const csvCell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = ["id,uid,result,source,device_id,note,created_at", ...rows.map(row => Object.values(row).map(csvCell).join(","))].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="rfid-access-logs.csv"');
  res.send("\uFEFF" + csv);
});

app.get("/api/device/status", requireAdmin, (_req, res) => {
  const rows = db.prepare("SELECT device_id,online,last_seen,firmware FROM device_status ORDER BY last_seen DESC").all();
  const now = Date.now();
  res.json({ devices: rows.map(d => ({ ...d, online: Boolean(d.online) && d.last_seen && now - Date.parse(d.last_seen) < 90000 })) });
});

function requireDevice(req, res, next) {
  const auth = String(req.get("authorization") || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : String(req.get("x-device-token") || "");
  if (!DEVICE_API_TOKEN || token.length !== DEVICE_API_TOKEN.length || token !== DEVICE_API_TOKEN) {
    return res.status(401).json({ error: "Device authentication failed." });
  }
  next();
}
app.post("/api/device/heartbeat", requireDevice, (req, res) => {
  const deviceId = String(req.body.deviceId || "esp32-locker").slice(0, 80);
  const firmware = String(req.body.firmware || "").slice(0, 80);
  const seen = nowIso();
  db.prepare(`INSERT INTO device_status(device_id,online,last_seen,firmware) VALUES(?,1,?,?)
    ON CONFLICT(device_id) DO UPDATE SET online=1,last_seen=excluded.last_seen,firmware=excluded.firmware`)
    .run(deviceId, seen, firmware);
  res.json({ ok: true, serverTime: seen });
});
app.post("/api/device/scan", requireDevice, (req, res) => {
  const uid = cleanUid(req.body.uid);
  const deviceId = String(req.body.deviceId || "esp32-locker").slice(0, 80);
  if (!validUid(uid)) return res.status(400).json({ error: "Invalid UID." });
  const card = db.prepare("SELECT uid,name,details,status FROM cards WHERE uid=?").get(uid);
  const granted = Boolean(card && card.status === "approved");
  const result = granted ? "GRANTED" : "DENIED";
  const timestamp = nowIso();
  db.prepare("INSERT INTO access_logs(uid,result,source,device_id,note,created_at) VALUES(?,?,?,?,?,?)")
    .run(uid, result, "esp32", deviceId, card ? `${card.name} (${card.status})` : "Unknown card", timestamp);
  db.prepare(`INSERT INTO device_status(device_id,online,last_seen) VALUES(?,1,?)
    ON CONFLICT(device_id) DO UPDATE SET online=1,last_seen=excluded.last_seen`).run(deviceId, timestamp);
  res.json({ ok: true, uid, result, authorized: granted, card: card || null, timestamp });
});
app.get("/api/device/cards", requireDevice, (_req, res) => {
  const cards = db.prepare("SELECT uid,status FROM cards").all();
  res.json({ cards: cards.map(c => ({ uid: c.uid, approved: c.status === "approved", status: c.status })), generatedAt: nowIso() });
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API route not found." });
  res.sendFile(path.join(__dirname, "public", "index.html"), err => { if (err) next(err); });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => {
  console.log(`RFID Security Locker listening on port ${PORT}`);
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) console.warn("WARNING: Set SESSION_SECRET to a random string of at least 32 characters.");
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH) console.warn("WARNING: Set ADMIN_EMAIL and ADMIN_PASSWORD_HASH before logging in.");
});
