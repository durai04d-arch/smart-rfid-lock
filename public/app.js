const $ = (id) => document.getElementById(id);
const state = { feeds: [], cards: [], logs: [], devices: [], overviewChart: null, cardChart: null, analyticsChart: null, deferredInstall: null };
const pageInfo = {
  overview: ["Overview", "Security overview"], cards: ["Card registry", "Card registry"],
  logs: ["Access logs", "Access logs"], analytics: ["Analytics", "Security analytics"], device: ["Device status", "Device status"]
};
let toastTimer;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}
function toast(message, error = false) {
  const el = $("toast"); el.textContent = message; el.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.className = "toast", 3200);
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
function normalizeStatus(value) {
  const s = String(value ?? "").toLowerCase();
  if (s.includes("grant") || s === "1" || s === "approved") return "GRANTED";
  if (s.includes("denied") || s.includes("reject") || s === "0") return "DENIED";
  return "UNKNOWN";
}
function setCloud(ok, label) {
  $("sideCloudDot").className = `dot ${ok ? "online" : "offline"}`;
  $("sideCloudText").textContent = label;
}
function setSignedIn(email) {
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  $("adminEmail").textContent = email || "Administrator";
  loadAll();
}
function setSignedOut() {
  $("appView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  $("password").value = "";
}
async function checkSession() {
  try {
    const me = await api("/api/auth/me");
    if (me.authenticated) setSignedIn(me.email); else setSignedOut();
  } catch { setSignedOut(); }
}
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("loginMessage").textContent = "Signing in…";
  try {
    const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: $("email").value, password: $("password").value }) });
    $("loginMessage").textContent = "";
    setSignedIn(data.email);
  } catch (err) { $("loginMessage").textContent = err.message; }
});
$("logoutBtn").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  setSignedOut();
});
$("refreshBtn").addEventListener("click", loadAll);
$("analyticsRefresh").addEventListener("click", loadThingSpeak);
$("menuBtn").addEventListener("click", () => $("sidebar").classList.toggle("open"));
document.querySelectorAll("[data-nav]").forEach(a => a.addEventListener("click", () => {
  document.querySelectorAll("[data-nav]").forEach(x => x.classList.toggle("active", x === a));
  $("sidebar").classList.remove("open");
}));
function showPage(name) {
  const valid = pageInfo[name] ? name : "overview";
  Object.keys(pageInfo).forEach(key => $(`${key}Page`).classList.toggle("hidden", key !== valid));
  $("pageCrumb").textContent = pageInfo[valid][0];
  $("pageTitle").textContent = pageInfo[valid][1];
  document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("active", a.dataset.nav === valid));
  if (valid === "logs") loadLogs();
  if (valid === "cards") renderCards();
  if (valid === "analytics") renderAnalytics();
  if (valid === "device") loadDevices();
  $("sidebar").classList.remove("open");
}
window.addEventListener("hashchange", () => showPage(location.hash.slice(1) || "overview"));
$("todayLabel").textContent = new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
$("footerTime").textContent = new Date().getFullYear();

async function loadAll() {
  $("lastSync").textContent = "Syncing…";
  await Promise.allSettled([loadThingSpeak(), loadCards(), loadLogs(), loadDevices()]);
  $("lastSync").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  renderRecentLogs();
}
async function loadThingSpeak() {
  try {
    const data = await api("/api/thingspeak/latest");
    state.feeds = data.feeds || [];
    setCloud(true, "ThingSpeak connected");
    renderThingSpeak();
    renderAnalytics();
  } catch (err) {
    setCloud(false, "ThingSpeak unavailable");
    $("latestEvent").className = "latest-event empty";
    $("latestEvent").innerHTML = `<div class="event-symbol">!</div><div><b>Channel data unavailable</b><p>${escapeHtml(err.message)} Check the server ThingSpeak channel ID/read key.</p></div>`;
    $("lastSync").textContent = "Cloud unavailable";
  }
}
function feedUid(feed) {
  const status = String(feed.status || "");
  const match = status.match(/(?:RFID_UID|UID)\s*[:=]\s*([A-Fa-f0-9: -]+)/i);
  if (match) return match[1].trim().replace(/-/g, ":").toUpperCase();
  if (feed.field4 && /^[A-Fa-f0-9: -]+$/.test(String(feed.field4))) return String(feed.field4).trim().replace(/-/g, ":").toUpperCase();
  return "—";
}
function renderThingSpeak() {
  const feeds = state.feeds;
  $("analyticsReadings").textContent = feeds.length;
  if (!feeds.length) {
    $("latestUid").textContent = "—"; $("latestTime").textContent = "—"; $("latestEntry").textContent = "—";
    $("latestEvent").innerHTML = `<div class="event-symbol">⌁</div><div><b>No channel readings yet</b><p>Scan a card and send a feed update to ThingSpeak.</p></div>`;
    $("totalScans").textContent = "0"; $("grantedScans").textContent = "0"; $("deniedScans").textContent = "0";
    renderCharts(); return;
  }
  const latest = feeds[feeds.length - 1];
  const access = normalizeStatus(latest.field1);
  const total = Number(latest.field2);
  const denied = Number(latest.field3);
  const uid = feedUid(latest);
  $("latestUid").textContent = uid;
  $("latestTime").textContent = formatDate(latest.created_at);
  $("latestEntry").textContent = latest.entry_id ?? "—";
  $("latestEvent").className = `latest-event ${access === "GRANTED" ? "success" : access === "DENIED" ? "denied" : "empty"}`;
  $("latestEvent").innerHTML = `<div class="event-symbol">${access === "GRANTED" ? "✓" : access === "DENIED" ? "×" : "⌁"}</div><div><b>${access === "UNKNOWN" ? "Latest channel reading" : access === "GRANTED" ? "Access granted" : "Access denied"}</b><p>${uid !== "—" ? `UID ${escapeHtml(uid)} · ` : ""}${escapeHtml(latest.status || "No status text in feed entry.")}</p></div>`;
  $("totalScans").textContent = Number.isFinite(total) ? total.toLocaleString() : feeds.length.toLocaleString();
  $("deniedScans").textContent = Number.isFinite(denied) ? denied.toLocaleString() : "—";
  $("grantedScans").textContent = Number.isFinite(total) && Number.isFinite(denied) ? Math.max(0, total - denied).toLocaleString() : "—";
  $("analyticsGranted").textContent = $("grantedScans").textContent;
  $("analyticsDenied").textContent = $("deniedScans").textContent;
  renderCharts();
}
function chartDefaults() {
  return { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, labels: { usePointStyle: true, boxWidth: 6, color: "#7d899d", font: { size: 10, family: "DM Sans" } } } }, scales: { x: { grid: { display: false }, ticks: { color: "#9aa5b5", maxTicksLimit: 7, font: { size: 9 } }, border: { display: false } }, y: { beginAtZero: true, grid: { color: "#eef1f6" }, ticks: { color: "#9aa5b5", precision: 0, font: { size: 9 } }, border: { display: false } } } };
}
function destroyChart(key) { if (state[key]) { state[key].destroy(); state[key] = null; } }
function renderCharts() {
  if (!window.Chart) return;
  const feeds = state.feeds.slice(-40);
  const labels = feeds.map(f => new Date(f.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  const total = feeds.map(f => Number(f.field2)).map(n => Number.isFinite(n) ? n : null);
  const denied = feeds.map(f => Number(f.field3)).map(n => Number.isFinite(n) ? n : null);
  const lineOptions = chartDefaults();
  destroyChart("overviewChart");
  state.overviewChart = new Chart($("overviewChart"), { type: "line", data: { labels, datasets: [{ label: "Total scans", data: total, borderColor: "#4779f5", backgroundColor: "#4779f51a", fill: true, tension: .32, pointRadius: 2, borderWidth: 2 }, { label: "Denied", data: denied, borderColor: "#e55261", backgroundColor: "#e5526110", fill: false, tension: .32, pointRadius: 2, borderWidth: 2 }] }, options: lineOptions });
  destroyChart("analyticsChart");
  state.analyticsChart = new Chart($("analyticsChart"), { type: "line", data: { labels, datasets: [{ label: "Total scans", data: total, borderColor: "#4779f5", backgroundColor: "#4779f51a", fill: true, tension: .3, pointRadius: 2 }, { label: "Denied scans", data: denied, borderColor: "#e55261", backgroundColor: "#e5526110", fill: false, tension: .3, pointRadius: 2 }] }, options: lineOptions });
}
async function loadCards() {
  try {
    const data = await api("/api/cards");
    state.cards = data.cards || [];
    const counts = { approved: 0, pending: 0, rejected: 0 };
    state.cards.forEach(c => counts[c.status] = (counts[c.status] || 0) + 1);
    $("registeredCards").textContent = state.cards.length;
    $("approvedCards").textContent = `${counts.approved} approved`;
    $("pendingBadge").textContent = counts.pending;
    $("cardsTotal").textContent = state.cards.length;
    $("cardsPending").textContent = counts.pending;
    $("cardsApproved").textContent = counts.approved;
    $("cardsRejected").textContent = counts.rejected;
    $("legendApproved").textContent = counts.approved; $("legendPending").textContent = counts.pending; $("legendRejected").textContent = counts.rejected;
    renderCards(); renderCardChart(counts);
  } catch (err) { toast(err.message, true); }
}
function renderCardChart(counts) {
  if (!window.Chart || !$("cardChart")) return;
  destroyChart("cardChart");
  state.cardChart = new Chart($("cardChart"), { type: "doughnut", data: { labels: ["Approved", "Pending", "Rejected"], datasets: [{ data: [counts.approved, counts.pending, counts.rejected], backgroundColor: ["#16a673", "#d68a22", "#e55261"], borderWidth: 0, hoverOffset: 4 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: "72%", plugins: { legend: { display: false } } } });
}
function renderCards() {
  const q = ($("cardSearch")?.value || "").toLowerCase();
  const status = $("cardStatusFilter")?.value || "all";
  const cards = state.cards.filter(c => (status === "all" || c.status === status) && `${c.uid} ${c.name} ${c.details}`.toLowerCase().includes(q));
  if (!cards.length) { $("cardsTable").innerHTML = `<div class="empty-state"><b>No cards found</b>Add an RFID UID to begin the approval workflow.</div>`; return; }
  $("cardsTable").innerHTML = `<table class="data-table"><thead><tr><th>RFID UID</th><th>CARD HOLDER</th><th>DETAILS</th><th>STATUS</th><th>UPDATED</th><th>ACTIONS</th></tr></thead><tbody>${cards.map(c => `<tr><td><span class="uid-chip">${escapeHtml(c.uid)}</span></td><td><b>${escapeHtml(c.name)}</b></td><td>${escapeHtml(c.details || "—")}</td><td><span class="status-badge ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td><td>${escapeHtml(formatDate(c.updated_at))}</td><td><div class="table-actions">${c.status !== "approved" ? `<button class="mini-action approve" data-card-action="approved" data-uid="${escapeHtml(c.uid)}">Approve</button>` : ""}${c.status !== "rejected" ? `<button class="mini-action reject" data-card-action="rejected" data-uid="${escapeHtml(c.uid)}">Reject</button>` : ""}<button class="mini-action" data-card-action="delete" data-uid="${escapeHtml(c.uid)}">Delete</button></div></td></tr>`).join("")}</tbody></table>`;
}
$("cardSearch").addEventListener("input", renderCards);
$("cardStatusFilter").addEventListener("change", renderCards);
$("cardsTable").addEventListener("click", async e => {
  const btn = e.target.closest("[data-card-action]"); if (!btn) return;
  const uid = btn.dataset.uid, action = btn.dataset.cardAction;
  try {
    if (action === "delete") {
      if (!confirm(`Delete card ${uid}?`)) return;
      await api(`/api/cards/${encodeURIComponent(uid)}`, { method: "DELETE" }); toast("Card deleted.");
    } else {
      await api(`/api/cards/${encodeURIComponent(uid)}/status`, { method: "PATCH", body: JSON.stringify({ status: action }) });
      toast(`Card ${action}.`);
    }
    await loadCards();
  } catch (err) { toast(err.message, true); }
});
function openModal() { $("cardModal").classList.remove("hidden"); $("cardMessage").textContent = ""; $("cardForm").reset(); $("cardUid").focus(); }
function closeModal() { $("cardModal").classList.add("hidden"); }
$("newCardBtn").addEventListener("click", openModal);
$("closeModalBtn").addEventListener("click", closeModal);
$("cancelCardBtn").addEventListener("click", closeModal);
$("cardModal").addEventListener("click", e => { if (e.target === $("cardModal")) closeModal(); });
$("cardForm").addEventListener("submit", async e => {
  e.preventDefault(); $("cardMessage").textContent = "Saving…";
  try {
    await api("/api/cards", { method: "POST", body: JSON.stringify({ uid: $("cardUid").value, name: $("cardName").value, details: $("cardDetails").value }) });
    closeModal(); toast("Card saved as pending approval."); await loadCards();
  } catch (err) { $("cardMessage").textContent = err.message; }
});
async function loadLogs() {
  try {
    const params = new URLSearchParams();
    if ($("logFrom").value) params.set("from", $("logFrom").value);
    if ($("logTo").value) params.set("to", $("logTo").value);
    if ($("logUid").value.trim()) params.set("uid", $("logUid").value.trim());
    if ($("logResult").value) params.set("result", $("logResult").value);
    const data = await api(`/api/logs?${params}`);
    state.logs = data.logs || [];
    $("logCount").textContent = `${state.logs.length} event${state.logs.length === 1 ? "" : "s"} · maximum 2,000 shown`;
    renderLogs();
  } catch (err) { $("logsTable").innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`; }
}
function logsTableHtml(logs) {
  if (!logs.length) return `<div class="empty-state"><b>No access logs yet</b>Logs appear after the ESP32 submits scans to the authenticated device API.</div>`;
  return `<table class="data-table"><thead><tr><th>TIME</th><th>UID</th><th>RESULT</th><th>DEVICE</th><th>NOTE</th></tr></thead><tbody>${logs.map(l => `<tr><td>${escapeHtml(formatDate(l.created_at))}</td><td><span class="uid-chip">${escapeHtml(l.uid)}</span></td><td><span class="result ${String(l.result).toLowerCase()}">${l.result === "GRANTED" ? "✓" : "×"} ${escapeHtml(l.result)}</span></td><td>${escapeHtml(l.device_id)}</td><td>${escapeHtml(l.note || l.source || "—")}</td></tr>`).join("")}</tbody></table>`;
}
function renderLogs() { $("logsTable").innerHTML = logsTableHtml(state.logs); }
function renderRecentLogs() { $("recentLogs").innerHTML = logsTableHtml(state.logs.slice(0, 6)); }
$("applyLogFilters").addEventListener("click", loadLogs);
$("clearLogFilters").addEventListener("click", () => { $("logFrom").value = ""; $("logTo").value = ""; $("logUid").value = ""; $("logResult").value = ""; loadLogs(); });
$("exportBtn").addEventListener("click", async () => {
  const params = new URLSearchParams();
  if ($("logFrom").value) params.set("from", $("logFrom").value);
  if ($("logTo").value) params.set("to", $("logTo").value);
  if ($("logUid").value.trim()) params.set("uid", $("logUid").value.trim());
  try {
    const response = await fetch(`/api/logs.csv?${params}`, { credentials: "same-origin" });
    if (!response.ok) { const d = await response.json().catch(() => ({})); throw new Error(d.error || "CSV export failed."); }
    const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "rfid-access-logs.csv"; a.click(); URL.revokeObjectURL(url); toast("CSV export downloaded.");
  } catch (err) { toast(err.message, true); }
});
async function loadDevices() {
  try {
    const data = await api("/api/device/status"); state.devices = data.devices || [];
    const device = state.devices.find(d => d.device_id === "esp32-locker") || state.devices[0];
    const online = Boolean(device?.online);
    $("deviceBadge").className = `status-badge ${online ? "online" : "offline"}`;
    $("deviceBadge").textContent = online ? "ONLINE" : device ? "OFFLINE" : "NOT REPORTED";
    $("deviceMainStatus").textContent = online ? "Controller connected" : "Awaiting heartbeat";
    $("deviceLastSeen").textContent = device?.last_seen ? `Last seen ${formatDate(device.last_seen)}` : "Connect your ESP32 to the device API.";
    $("devicePageBadge").className = `status-badge ${online ? "online" : "neutral"}`;
    $("devicePageBadge").textContent = online ? "ONLINE" : "AWAITING DEVICE";
    $("deviceDetailStatus").textContent = online ? "Controller connected" : "Not connected";
    $("deviceDetailSeen").textContent = device?.last_seen ? `Last heartbeat: ${formatDate(device.last_seen)}` : "No heartbeat has been received yet.";
    $("deviceFirmware").textContent = `Firmware: ${device?.firmware || "unknown"}`;
  } catch {}
}
function renderAnalytics() { if (window.Chart && state.feeds.length) renderCharts(); }
window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); state.deferredInstall = event; $("installBtn").classList.remove("hidden"); });
$("installBtn").addEventListener("click", async () => {
  if (!state.deferredInstall) return;
  state.deferredInstall.prompt(); await state.deferredInstall.userChoice; state.deferredInstall = null; $("installBtn").classList.add("hidden");
});
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(err => console.warn("Service worker unavailable", err)));
checkSession();
window.addEventListener("focus", () => { if (!$("appView").classList.contains("hidden")) loadAll(); });
setInterval(() => { if (!$("appView").classList.contains("hidden")) { loadThingSpeak(); loadDevices(); $("lastSync").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`; } }, 30000);
