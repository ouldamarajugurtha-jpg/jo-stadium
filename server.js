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
const STADIUM_TIMEZONE = "Africa/Algiers";
const appHtml = path.join(__dirname, "public");

app.use(express.json({ limit: "5mb" }));
app.use(express.static(appHtml));

/*
 * Date et heure actuelles au stade.
 * Le fuseau horaire est celui de l'Algérie.
 */
function getStadiumDateTime() {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: STADIUM_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const parts = formatter.formatToParts(new Date());
  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes:
      Number(values.hour) * 60 +
      Number(values.minute),
    seconds: Number(values.second)
  };
}

/*
 * Détermine si un créneau accepte encore des réservations.
 *
 * - Les dates passées sont fermées.
 * - Les dates futures restent disponibles.
 * - Aujourd'hui, un créneau est fermé dès son heure de début.
 * - À l'heure de fin, il est également fermé.
 */
function isSlotOpen(date, slot) {
  if (!validSlot(slot)) {
    return false;
  }

  const current = getStadiumDateTime();

  if (date < current.date) {
    return false;
  }

  if (date > current.date) {
    return true;
  }

  const match = slot.match(
    /^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/
  );

  if (!match) {
    return false;
  }

  const startMinutes =
    Number(match[1]) * 60 +
    Number(match[2]);

  const endMinutes =
    Number(match[3]) * 60 +
    Number(match[4]);

  return (
    current.minutes < startMinutes &&
    current.minutes < endMinutes
  );
}

function normalizeDates(dates) {
  return Array.isArray(dates)
    ? [...new Set(
        dates.filter(date =>
          typeof date === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(date)
        )
      )].sort()
    : [];
}

function validSlot(slot) {
  return typeof slot === "string" &&
    VALID_SLOTS.has(slot);
}

function validBooking(body) {
  const players = Number(body.players);
  const dates = normalizeDates(body.dates);

  const validDates =
    dates.length > 0 &&
    dates.every(date => {
      const parsed = new Date(`${date}T12:00:00.000Z`);

      return (
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === date
      );
    });

  return (
    typeof body.name === "string" &&
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

    (body.type === "single" || body.type === "monthly")
  );
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

  return res.status(500).json({
    error: message
  });
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
      payment_method TEXT NOT NULL DEFAULT 'on_site',
      payment_status TEXT NOT NULL DEFAULT 'on_site',
      transaction_reference TEXT,
      receipt_data TEXT,
      payment_updated_at TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Migrations sûres : les réservations existantes sont conservées.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'on_site'`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'on_site'`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS transaction_reference TEXT`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS receipt_data TEXT`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_updated_at TIMESTAMPTZ`);

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

/*
 * État du serveur et de la base.
 */
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      service: "jo-stadium",
      database: "connected"
    });
  } catch (error) {
    dbError(
      res,
      error,
      "Base de données indisponible."
    );
  }
});

/*
 * Disponibilités des créneaux.
 *
 * Réponse :
 * {
 *   booked: [{ date, slot }],
 *   closed: [{ date, slot }]
 * }
 *
 * Le champ booked conserve son fonctionnement existant.
 * Le champ closed indique les créneaux dont l'heure est passée
 * ou qui ont déjà commencé aujourd'hui.
 */
app.get("/api/availability", async (req, res) => {
  try {
    const requested = String(req.query.dates || "")
      .split(",")
      .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .slice(0, 366);

    const result = await pool.query(`
      SELECT DISTINCT b.slot, d.date
      FROM bookings b
      CROSS JOIN LATERAL
        jsonb_array_elements_text(b.dates) AS d(date)
      WHERE b.status = 'confirmed'
      ${
        requested.length
          ? "AND d.date = ANY($1::text[])"
          : ""
      }
    `, requested.length ? [requested] : []);

    const booked = result.rows.map(row => ({
      date: String(row.date).slice(0, 10),
      slot: row.slot
    }));

    const datesToCheck = requested.length
      ? requested
      : [getStadiumDateTime().date];

    const closed = [];

    for (const date of datesToCheck) {
      for (const slot of VALID_SLOTS) {
        if (!isSlotOpen(date, slot)) {
          closed.push({ date, slot });
        }
      }
    }

    res.set("Cache-Control", "no-store");

    res.json({
      booked,
      closed
    });
  } catch (error) {
    dbError(
      res,
      error,
      "Impossible de vérifier les disponibilités."
    );
  }
});

/*
 * Vérification de plusieurs tickets.
 */
app.get("/api/bookings/status", async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean)
      .slice(0, 100);

    const result = await pool.query(
      `SELECT id
       FROM bookings
       WHERE id = ANY($1::text[])
         AND status = 'confirmed'`,
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
    dbError(
      res,
      error,
      "Impossible de vérifier les tickets."
    );
  }
});

/*
 * Vérification d'un ticket.
 */
app.get("/api/bookings/:id/status", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, payment_method AS "paymentMethod", payment_status AS "paymentStatus",
              transaction_reference AS "transactionReference"
       FROM bookings
       WHERE id = $1 AND status = 'confirmed'`,
      [String(req.params.id)]
    );

    res.set("Cache-Control", "no-store");
    const booking = result.rows[0];
    res.json({
      active: result.rowCount > 0,
      paymentMethod: booking?.paymentMethod || null,
      paymentStatus: booking?.paymentStatus || null,
      transactionReference: booking?.transactionReference || null
    });
  } catch (error) {
    dbError(
      res,
      error,
      "Impossible de vérifier le ticket."
    );
  }
});

/*
 * Création d'une réservation.
 *
 * Le serveur revérifie chaque date et chaque créneau
 * juste avant l'enregistrement.
 */
app.post("/api/bookings", async (req, res) => {
  const body = req.body || {};

  if (!validBooking(body)) {
    return res.status(400).json({
      error:
        "Réservation invalide : vérifie la date, l’horaire, le nom, le téléphone et le nombre de joueurs."
    });
  }

  const dates = normalizeDates(body.dates);
  const players = Number(body.players);
  const paymentMethod = body.paymentMethod === "baridimob" ? "baridimob" : body.paymentMethod === "on_site" ? "on_site" : null;
  const transactionReference = typeof body.transactionReference === "string" ? body.transactionReference.trim().slice(0, 100) : "";
  const receiptData = typeof body.receiptData === "string" ? body.receiptData : "";
  const receiptMatch = receiptData.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  const receiptBytes = receiptMatch ? Math.floor(receiptMatch[2].length * 3 / 4) : 0;
  if (!paymentMethod) return res.status(400).json({ error: "Choisis BaridiMob ou le paiement sur place." });
  if (paymentMethod === "baridimob" && (!transactionReference || !receiptMatch || receiptBytes > 2 * 1024 * 1024)) {
    return res.status(400).json({ error: "Pour BaridiMob, indique la référence de transaction et joins un justificatif image (2 Mo maximum)." });
  }
  if (paymentMethod === "on_site" && (transactionReference || receiptData)) {
    return res.status(400).json({ error: "Aucun justificatif n'est nécessaire pour un paiement sur place." });
  }

  // Blocage serveur des créneaux fermés.
  const closedDates = dates.filter(
    date => !isSlotOpen(date, body.slot)
  );

  if (closedDates.length > 0) {
    return res.status(409).json({
      error:
        "Ce créneau est fermé ou a déjà commencé. Choisis un autre horaire ou une date future.",
      closedDates,
      slot: body.slot
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * Verrouillage transactionnel pour éviter les doubles
     * réservations simultanées sur le même créneau.
     */
    for (const date of dates) {
      const lockKey = `${date}|${body.slot}`;

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [lockKey]
      );
    }

    /*
     * Nouvelle vérification après obtention des verrous.
     * Cela évite de laisser passer un créneau devenu fermé
     * pendant l'attente de la transaction.
     */
    const nowClosed = dates.filter(
      date => !isSlotOpen(date, body.slot)
    );

    if (nowClosed.length > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        error:
          "Le créneau est maintenant fermé. Choisis un autre horaire ou une date future.",
        closedDates: nowClosed,
        slot: body.slot
      });
    }

    const conflict = await client.query(`
      SELECT b.id
      FROM bookings b
      CROSS JOIN LATERAL
        jsonb_array_elements_text(b.dates) AS d(date)
      WHERE b.status = 'confirmed'
        AND b.slot = $1
        AND d.date = ANY($2::text[])
      LIMIT 1
    `, [body.slot, dates]);

    if (conflict.rowCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        error:
          "Ce créneau est déjà réservé pour au moins une date sélectionnée."
      });
    }

    const booking = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: body.type,
      dates,
      month:
        typeof body.month === "string"
          ? body.month
          : null,
      weekday:
        body.weekday == null
          ? null
          : Number(body.weekday),
      slot: body.slot,
      players,
      name: body.name.trim(),
      phone: body.phone.trim(),
      total: players * PRICE_PER_PLAYER * dates.length,
      status: "confirmed",
      paymentMethod,
      paymentStatus: paymentMethod === "baridimob" ? "pending" : "on_site",
      transactionReference: paymentMethod === "baridimob" ? transactionReference : null,
      receiptData: paymentMethod === "baridimob" ? receiptData : null,
      paymentUpdatedAt: null,
      createdAt: new Date().toISOString()
    };

    await client.query(`
      INSERT INTO bookings (
        id, type, dates, month, weekday, slot, players, name, phone, total,
        status, payment_method, payment_status, transaction_reference,
        receipt_data, payment_updated_at, "createdAt"
      ) VALUES (
        $1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17
      )
    `, [booking.id, booking.type, JSON.stringify(booking.dates), booking.month,
      booking.weekday, booking.slot, booking.players, booking.name, booking.phone,
      booking.total, booking.status, booking.paymentMethod, booking.paymentStatus,
      booking.transactionReference, booking.receiptData, booking.paymentUpdatedAt, booking.createdAt]);

    await client.query("COMMIT");

    res.status(201).json({ booking });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    dbError(
      res,
      error,
      "Impossible d’enregistrer la réservation."
    );
  } finally {
    client.release();
  }
});

/*
 * Connexion administrateur.
 */
app.post("/api/admin/login", (req, res) => {
  if (String(req.body?.password || "") !== ADMIN_PASSWORD) {
    return res.status(401).json({
      error: "Mot de passe incorrect."
    });
  }

  res.json({
    ok: true,
    token: ADMIN_PASSWORD
  });
});

/*
 * Liste des réservations administrateur.
 */
app.get(
  "/api/admin/bookings",
  adminAuth,
  async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, type, dates, month, weekday, slot, players, name, phone, total, status,
               payment_method AS "paymentMethod", payment_status AS "paymentStatus",
               transaction_reference AS "transactionReference", receipt_data AS "receiptData",
               payment_updated_at AS "paymentUpdatedAt", "createdAt"
        FROM bookings
        ORDER BY "createdAt" DESC
      `);

      res.json({
        bookings: result.rows
      });
    } catch (error) {
      dbError(
        res,
        error,
        "Impossible de charger les réservations."
      );
    }
  }
);

/* Mise à jour du statut de paiement, sans modifier le statut du créneau. */
app.patch("/api/admin/bookings/:id/payment", adminAuth, async (req, res) => {
  const allowed = new Set(["pending", "verified", "on_site", "rejected"]);
  const paymentStatus = String(req.body?.paymentStatus || "");
  if (!allowed.has(paymentStatus)) return res.status(400).json({ error: "Statut de paiement invalide." });
  try {
    const result = await pool.query(`
      UPDATE bookings SET payment_status = $2, payment_updated_at = NOW()
      WHERE id = $1
      RETURNING id, payment_method AS "paymentMethod", payment_status AS "paymentStatus",
                transaction_reference AS "transactionReference", payment_updated_at AS "paymentUpdatedAt"
    `, [String(req.params.id), paymentStatus]);
    if (!result.rowCount) return res.status(404).json({ error: "Réservation introuvable." });
    res.json({ ok: true, booking: result.rows[0] });
  } catch (error) { dbError(res, error, "Impossible de mettre à jour le paiement."); }
});

/*
 * Annulation d'une réservation.
 * Les autres réservations ne sont pas touchées.
 */
app.delete(
  "/api/admin/bookings/:id",
  adminAuth,
  async (req, res) => {
    try {
      const result = await pool.query(`
        DELETE FROM bookings
        WHERE id = $1
        RETURNING id, type, dates, month, weekday,
                  slot, players, name, phone, total,
                  status, "createdAt"
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
      dbError(
        res,
        error,
        "Impossible d’annuler la réservation."
      );
    }
  }
);

/*
 * Déconnexion administrateur.
 */
app.post(
  "/api/admin/logout",
  adminAuth,
  (_req, res) => {
    res.json({ ok: true });
  }
);

/*
 * Interface d'administration.
 */
app.get(["/admin", "/admin/"], (_req, res) => {
  res.sendFile(path.join(appHtml, "admin.html"));
});

/*
 * Autres pages du site.
 */
app.get("*", (_req, res) => {
  res.sendFile(path.join(appHtml, "index.html"));
});

/*
 * Démarrage.
 */
async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `JO STADIUM démarré sur le port ${PORT}`
      );

      console.log(
        `Fuseau horaire : ${STADIUM_TIMEZONE}`
      );
    });
  } catch (error) {
    console.error(
      "Impossible de démarrer JO STADIUM :",
      error
    );

    process.exit(1);
  }
}

startServer();
