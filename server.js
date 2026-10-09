const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234"; // À remplacer par une variable Render forte.
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "bookings.json");
const VALID_SLOTS = new Set([
  "16:00 - 17:00",
  "17:00 - 18:00",
  "18:00 - 19:00",
  "19:00 - 20:00"
]);
const PRICE_PER_PLAYER = 100;

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]\n", "utf8");

const appHtml = path.join(__dirname, "public");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(appHtml));

function readBookings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Impossible de lire data/bookings.json:", error.message);
    throw new Error("Les données de réservation sont temporairement indisponibles.");
  }
}
function writeBookings(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, DATA_FILE);
}
function adminAuth(req, res, next) {
  if (req.get("x-admin-token") !== ADMIN_PASSWORD) return res.status(401).json({ error: "Session administrateur expirée. Reconnecte-toi." });
  next();
}
function normalizeDates(dates) {
  return Array.isArray(dates) ? [...new Set(dates.filter(d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort() : [];
}
function validSlot(slot) {
  return typeof slot === "string" && VALID_SLOTS.has(slot);
}
function validBooking(body) {
  const players = Number(body.players);
  const dates = normalizeDates(body.dates);
  const today = new Date(); today.setHours(0,0,0,0);
  const validDates = dates.length > 0 && dates.every(iso => {
    const d = new Date(iso + "T12:00:00");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === iso && d >= today;
  });
  return typeof body.name === "string" && body.name.trim().length >= 2 && body.name.trim().length <= 100 &&
    typeof body.phone === "string" && body.phone.trim().length >= 6 && body.phone.trim().length <= 30 &&
    validSlot(body.slot) && validDates && Number.isInteger(players) && players >= 6 && players <= 12 &&
    dates.length <= 6 && (body.type === "single" || body.type === "monthly");
}
function safeRead(res) { try { return readBookings(); } catch (e) { res.status(500).json({ error: e.message }); return null; } }

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "jo-stadium" }));
app.get("/api/availability", (req, res) => {
  const requested = String(req.query.dates || "").split(",").filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const bookings = safeRead(res); if (!bookings) return;
  const booked = [];
  for (const b of bookings) for (const date of normalizeDates(b.dates)) {
    if (!requested.length || requested.includes(date)) booked.push({ date, slot: b.slot });
  }
  res.json({ booked });
});
app.post("/api/bookings", (req, res) => {
  const body = req.body || {};
  if (!validBooking(body)) return res.status(400).json({ error: "Réservation invalide : vérifie la date, l’horaire, le nom, le téléphone et le nombre de joueurs." });
  const dates = normalizeDates(body.dates);
  const bookings = safeRead(res); if (!bookings) return;
  const conflict = bookings.some(b => b.slot === body.slot && normalizeDates(b.dates).some(d => dates.includes(d)));
  if (conflict) return res.status(409).json({ error: "Ce créneau est déjà réservé pour au moins une date sélectionnée." });
  const players = Number(body.players);
  const booking = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
    type: body.type,
    dates,
    month: typeof body.month === "string" ? body.month : null,
    weekday: body.weekday == null ? null : Number(body.weekday),
    slot: body.slot,
    players,
    name: body.name.trim(),
    phone: body.phone.trim(),
    total: players * PRICE_PER_PLAYER * dates.length,
    status: "confirmed",
    createdAt: new Date().toISOString()
  };
  bookings.unshift(booking);
  try { writeBookings(bookings); } catch (e) { console.error(e); return res.status(500).json({ error: "Impossible d’enregistrer la réservation." }); }
  res.status(201).json({ booking });
});
app.post("/api/admin/login", (req, res) => {
  if (String(req.body?.password || "") !== ADMIN_PASSWORD) return res.status(401).json({ error: "Mot de passe incorrect." });
  res.json({ ok: true, token: ADMIN_PASSWORD });
});
app.get("/api/admin/bookings", adminAuth, (req, res) => {
  const bookings = safeRead(res); if (!bookings) return;
  res.json({ bookings });
});
app.delete("/api/admin/bookings/:id", adminAuth, (req, res) => {
  const id = String(req.params.id);
  const bookings = safeRead(res); if (!bookings) return;
  const index = bookings.findIndex(b => String(b.id) === id);
  if (index === -1) return res.status(404).json({ error: "Réservation introuvable." });
  const [deleted] = bookings.splice(index, 1);
  try { writeBookings(bookings); } catch (e) { console.error(e); return res.status(500).json({ error: "Impossible d’annuler la réservation." }); }
  res.json({ ok: true, deletedId: id, booking: deleted });
});
app.post("/api/admin/logout", adminAuth, (_req, res) => res.json({ ok: true }));
app.get(["/admin", "/admin/", "/admin.html"], (_req, res) => res.redirect(302, "/#admin"));
app.get("*", (_req, res) => res.sendFile(path.join(appHtml, "index.html")));
app.listen(PORT, "0.0.0.0", () => console.log(`JO STADIUM démarré sur le port ${PORT}`));
