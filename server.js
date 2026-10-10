const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;

if (!ADMIN_PASSWORD) {
  console.error("ERREUR : la variable ADMIN_PASSWORD est absente.");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("ERREUR : la variable DATABASE_URL est absente.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

const VALID_SLOTS = new Set([
  "16:00 - 17:00",
  "17:00 - 18:00",
  "18:00 - 19:00",
  "19:00 - 20:00"
]);

const PRICE_PER_PLAYER = 100;
const appHtml = path.join(__dirname, "public");

app.use(express.json({ limit: "100kb" }));
app.use(express.static(appHtml));

function normalizeDates(dates) {
  return Array.isArray(dates)
    ? [...new Set(
        dates.filter(d =>
          typeof d === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(d)
        )
      )].sort()
    : [];
}

function validSlot(slot) {
  return typeof slot === "string" && VALID_SLOTS.has(slot);
}

function validBooking(body) {
  const players = Number(body.players);
  const dates = normalizeDates(body.dates);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const validDates = dates.length > 0 && dates.every(iso => {
    const d = new Date(iso + "T12:00:00");
    return !Number.isNaN(d.getTime()) &&
      d.toISOString().slice(0, 10) === iso &&
      d >= today;
  });

  return typeof body.name === "string" &&
    body.name.trim().length >= 2 &&
    body.name.trim().length <= 100 &&
    typeof body.phone === "string" &&
    body.phone.trim().length >= 6 &&
    body.phone.trim().length <= 30 &&
    validSlot(body.slot) &&
    validDates &&
    Number.isInteger(players) &&
    players >= 6 &&
    players <= 12 &&
    dates.length <= 6 &&
    (body.type === "single" || body.type === "monthly");
}

function adminAuth(req, res, next) {
  if (req.get("x-admin-token") !== ADMIN_PASSWORD) {
    return res.status(401).json({
      error: "Session administrateur expirée. Reconnecte-toi."
    });
  }
  next();
}

function dbError(res, error, message) {
  console.error("Erreur PostgreSQL :", error.message);
  return res.status(500).json({ error: message });
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      dates JSONB NOT NULL,
      month TEXT,
      weekday INTEGER,
      slot TEXT NOT NULL,
      players INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS bookings_slot_idx
    ON bookings (slot)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_slot_locks (
      booking_date DATE NOT NULL,
      slot TEXT NOT NULL,
      PRIMARY KEY (booking_date, slot)
    )
  `);

  console.log("Base PostgreSQL initialisée.");
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "jo-stadium", database: "connected" });
  } catch (error) {
    dbError(res, error, "Base de données indisponible.");
  }
});

app.get("/api/availability", async (req, res) => {
  try {
    const requested = String(req.query.dates || "")
      .split(",")
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));

    const result = await pool.query(`
      SELECT DISTINCT b.slot, d.date
      FROM bookings b
      CROSS JOIN LATERAL jsonb_array_elements_text(b.dates) AS d(date)
      WHERE b.status = 'confirmed'
      ${requested.length ? "AND d.date = ANY($1::text[])" : ""}
    `, requested.length ? [requested] : []);

    res.json({
      booked: result.rows.map(row => ({
        date: row.date,
        slot: row.slot
      }))
    });
  } catch (error) {
    dbError(res, error, "Impossible de vérifier les disponibilités.");
  }
});

app.get("/api/bookings/status", async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean)
      .slice(0, 100);

    const result = await pool.query(
      "SELECT id FROM bookings WHERE id = ANY($1::text[]) AND status = 'confirmed'",
      [ids]
    );

    const activeIds = result.rows.map(row => row.id);
    const activeSet = new Set(activeIds);

    res.set("Cache-Control", "no-store");
    res.json({
      activeIds,
      inactiveIds: ids.filter(id => !activeSet.has(id))
    });
  } catch (error) {
    dbError(res, error, "Impossible de vérifier les tickets.");
  }
});

app.get("/api/bookings/:id/status", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id FROM bookings WHERE id = $1 AND status = 'confirmed'",
      [String(req.params.id)]
    );

    res.set("Cache-Control", "no-store");
    res.json({ active: result.rowCount > 0 });
  } catch (error) {
    dbError(res, error, "Impossible de vérifier le ticket.");
  }
});

app.post("/api/bookings", async (req, res) => {
  const body = req.body || {};

  if (!validBooking(body)) {
    return res.status(400).json({
      error: "Réservation invalide : vérifie la date, l’horaire, le nom, le téléphone et le nombre de joueurs."
    });
  }

  const dates = normalizeDates(body.dates);
  const players = Number(body.players);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * Les verrous transactionnels empêchent deux requêtes
     * de réserver simultanément le même créneau.
     */
    for (const date of dates) {
      const lockKey = `${date}|${body.slot}`;

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [lockKey]
      );
    }

    const conflict = await client.query(`
      SELECT b.id
      FROM bookings b
      CROSS JOIN LATERAL jsonb_array_elements_text(b.dates) AS d(date)
      WHERE b.status = 'confirmed'
        AND b.slot = $1
        AND d.date = ANY($2::text[])
      LIMIT 1
    `, [body.slot, dates]);

    if (conflict.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Ce créneau est déjà réservé pour au moins une date sélectionnée."
      });
    }

    const booking = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

    await client.query(`
      INSERT INTO bookings (
        id, type, dates, month, weekday, slot,
        players, name, phone, total, status, "createdAt"
      )
      VALUES (
        $1, $2, $3::jsonb, $4, $5, $6,
        $7, $8, $9, $10, $11, $12
      )
    `, [
      booking.id,
      booking.type,
      JSON.stringify(booking.dates),
      booking.month,
      booking.weekday,
      booking.slot,
      booking.players,
      booking.name,
      booking.phone,
      booking.total,
      booking.status,
      booking.createdAt
    ]);

    await client.query("COMMIT");
    res.status(201).json({ booking });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    dbError(res, error, "Impossible d’enregistrer la réservation.");
  } finally {
    client.release();
  }
});

app.post("/api/admin/login", (req, res) => {
  if (String(req.body?.password || "") !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Mot de passe incorrect." });
  }

  res.json({ ok: true, token: ADMIN_PASSWORD });
});

app.get("/api/admin/bookings", adminAuth, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, type, dates, month, weekday, slot, players,
             name, phone, total, status, "createdAt"
      FROM bookings
      ORDER BY "createdAt" DESC
    `);

    res.json({ bookings: result.rows });
  } catch (error) {
    dbError(res, error, "Impossible de charger les réservations.");
  }
});

app.delete("/api/admin/bookings/:id", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      DELETE FROM bookings
      WHERE id = $1
      RETURNING id, type, dates, month, weekday, slot, players,
                name, phone, total, status, "createdAt"
    `, [String(req.params.id)]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Réservation introuvable."
      });
    }

    res.json({
      ok: true,
      deletedId: result.rows[0].id,
      booking: result.rows[0]
    });
  } catch (error) {
    dbError(res, error, "Impossible d’annuler la réservation.");
  }
});

app.post("/api/admin/logout", adminAuth, (_req, res) => {
  res.json({ ok: true });
});

app.get(["/admin", "/admin/"], (_req, res) => {
  res.sendFile(path.join(appHtml, "admin.html"));
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(appHtml, "index.html"));
});

async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`JO STADIUM démarré sur le port ${PORT}`);
    });
  } catch (error) {
    console.error("Impossible de démarrer JO STADIUM :", error);
    process.exit(1);
  }
}

startServer();
