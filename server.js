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
// Les pages HTML sont servies sans cache afin que les mises à jour Render
// apparaissent aussi sur les navigateurs mobiles qui gardent parfois une ancienne page.
app.use((req, res, next) => {
  if (req.path.endsWith(".html") || ["/", "/admin", "/admin/", "/admin/tournois", "/admin/tournois/", "/tournois", "/tournois/"].includes(req.path)) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});
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

  // Tournois : tables ajoutées sans toucher aux réservations existantes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tournament_date DATE,
      registration_deadline TIMESTAMPTZ,
      description TEXT NOT NULL DEFAULT '',
      max_teams INTEGER NOT NULL CHECK (max_teams BETWEEN 4 AND 48),
      group_count INTEGER NOT NULL CHECK (group_count BETWEEN 1 AND 24),
      best_third_count INTEGER NOT NULL DEFAULT 0 CHECK (best_third_count BETWEEN 0 AND 8),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (group_count <= max_teams)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_teams (
      id TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      team_name TEXT NOT NULL,
      captain_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      ticket_code TEXT NOT NULL UNIQUE,
      payment_status TEXT NOT NULL DEFAULT 'on_site',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE tournament_teams ADD COLUMN IF NOT EXISTS group_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`CREATE INDEX IF NOT EXISTS tournament_teams_tournament_idx ON tournament_teams (tournament_id, created_at)`);
  // Migration douce des anciennes installations : conserver tournois et équipes.
  await pool.query(`ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_max_teams_check`);
  await pool.query(`ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_group_count_check`);
  await pool.query(`ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_check`);
  await pool.query(`ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_best_third_count_check`);
  await pool.query(`ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_group_count_le_max_check`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS best_third_count INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS competition_type TEXT NOT NULL DEFAULT 'cup'`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS season_format TEXT NOT NULL DEFAULT 'single'`);
  await pool.query(`ALTER TABLE tournaments ADD CONSTRAINT tournaments_max_teams_check CHECK (max_teams BETWEEN 4 AND 48)`);
  await pool.query(`ALTER TABLE tournaments ADD CONSTRAINT tournaments_group_count_check CHECK (group_count BETWEEN 1 AND 24)`);
  await pool.query(`ALTER TABLE tournaments ADD CONSTRAINT tournaments_best_third_count_check CHECK (best_third_count BETWEEN 0 AND 8)`);
  await pool.query(`ALTER TABLE tournaments ADD CONSTRAINT tournaments_group_count_le_max_check CHECK (group_count <= max_teams)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_matches (
      id TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      group_name TEXT NOT NULL DEFAULT '',
      home_team_id TEXT NOT NULL REFERENCES tournament_teams(id) ON DELETE CASCADE,
      away_team_id TEXT NOT NULL REFERENCES tournament_teams(id) ON DELETE CASCADE,
      match_date DATE,
      match_time TIME,
      home_goals INTEGER,
      away_goals INTEGER,
      home_yellow INTEGER NOT NULL DEFAULT 0,
      home_red INTEGER NOT NULL DEFAULT 0,
      away_yellow INTEGER NOT NULL DEFAULT 0,
      away_red INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','finished','bye')),
      phase TEXT NOT NULL DEFAULT 'group',
      round_name TEXT NOT NULL DEFAULT '',
      round_number INTEGER NOT NULL DEFAULT 1,
      match_number INTEGER NOT NULL DEFAULT 1,
      home_penalties INTEGER,
      away_penalties INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (home_team_id <> away_team_id),
      CHECK (home_goals IS NULL OR home_goals >= 0),
      CHECK (away_goals IS NULL OR away_goals >= 0),
      CHECK (home_yellow >= 0 AND home_red >= 0 AND away_yellow >= 0 AND away_red >= 0)
    )
  `);
  // Migrations compatibilité : certaines installations précédentes possèdent déjà
  // les tables de tournoi avec un schéma plus ancien. Ajouter les colonnes manquantes
  // évite que /api/tournaments échoue au premier SELECT après un redéploiement.
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS tournament_date DATE`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS registration_deadline TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS max_teams INTEGER NOT NULL DEFAULT 16`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS group_count INTEGER NOT NULL DEFAULT 4`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS best_third_count INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS competition_type TEXT NOT NULL DEFAULT 'cup'`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS season_format TEXT NOT NULL DEFAULT 'single'`);
  await pool.query(`ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_group_count_check`);
  await pool.query(`ALTER TABLE tournaments ADD CONSTRAINT tournaments_group_count_check CHECK (group_count BETWEEN 1 AND 24)`);
  await pool.query(`ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_competition_type_check`);
  await pool.query(`ALTER TABLE tournaments ADD CONSTRAINT tournaments_competition_type_check CHECK (competition_type IN ('cup','league'))`);
  await pool.query(`ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_season_format_check`);
  await pool.query(`ALTER TABLE tournaments ADD CONSTRAINT tournaments_season_format_check CHECK (season_format IN ('single','double'))`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  await pool.query(`ALTER TABLE tournament_teams ADD COLUMN IF NOT EXISTS captain_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE tournament_teams ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE tournament_teams ADD COLUMN IF NOT EXISTS ticket_code TEXT`);
  await pool.query(`ALTER TABLE tournament_teams ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'on_site'`);
  await pool.query(`ALTER TABLE tournament_teams ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS group_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS home_team_id TEXT`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS away_team_id TEXT`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS match_date DATE`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS match_time TIME`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS home_goals INTEGER`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS away_goals INTEGER`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS home_yellow INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS home_red INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS away_yellow INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS away_red INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'scheduled'`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE tournament_matches ALTER COLUMN home_team_id DROP NOT NULL`);
  await pool.query(`ALTER TABLE tournament_matches ALTER COLUMN away_team_id DROP NOT NULL`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'group'`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS round_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS round_number INTEGER NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS match_number INTEGER NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS home_penalties INTEGER`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS away_penalties INTEGER`);
  await pool.query(`ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS scorers JSONB NOT NULL DEFAULT '[]'::jsonb`);
  // Harmoniser les anciennes contraintes de statut : certains anciens schémas
  // n'acceptaient pas la valeur "finished", ce qui faisait échouer la sauvegarde.
  await pool.query(`DO $$ DECLARE c RECORD; BEGIN
    FOR c IN SELECT conname FROM pg_constraint
      WHERE conrelid = 'tournament_matches'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%status%'
    LOOP EXECUTE format('ALTER TABLE tournament_matches DROP CONSTRAINT %I', c.conname); END LOOP;
  END $$`);
  await pool.query(`ALTER TABLE tournament_matches ADD CONSTRAINT tournament_matches_status_valid_check CHECK (status IN ('scheduled','finished','bye'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS tournament_matches_tournament_idx ON tournament_matches (tournament_id, match_date, match_time)`);

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


/* ======================= TOURNOIS ======================= */
function groupLabel(index) { return `Groupe ${String.fromCharCode(65 + index)}`; }
function tournamentGroups(teams, groupCount) {
  const count = Math.max(1, Number(groupCount) || 1);
  const groups = Array.from({ length: count }, (_, i) => ({ name: groupLabel(i), teams: [] }));
  const byName = new Map(groups.map(g => [g.name, g]));
  const pending = [];
  // Keep persisted group assignments stable; only distribute teams with no valid group.
  for (const team of teams) {
    const saved = byName.get(String(team.groupName || '').trim());
    if (saved) saved.teams.push(team);
    else pending.push(team);
  }
  for (const team of pending) {
    const smallest = Math.min(...groups.map(g => g.teams.length));
    const target = groups.find(g => g.teams.length === smallest);
    team.groupName = target.name;
    target.teams.push(team);
  }
  return groups;
}
function compareStanding(a, b) {
  return b.points - a.points || b.goalDifference - a.goalDifference || b.goalsFor - a.goalsFor ||
    a.redCards - b.redCards || a.yellowCards - b.yellowCards || a.teamName.localeCompare(b.teamName, 'fr');
}
function calculateStandings(groups, matches, bestThirdCount = 0) {
  const byTeam = new Map();
  for (const group of groups) for (const team of group.teams) byTeam.set(team.id, {
    id: team.id, teamName: team.teamName, group: group.name, played: 0, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, yellowCards: 0, redCards: 0, rank: 0, qualification: ''
  });
  for (const m of matches) {
    if ((m.phase && m.phase !== 'group') || m.status !== 'finished' || m.homeGoals == null || m.awayGoals == null) continue;
    const h = byTeam.get(m.homeTeamId), a = byTeam.get(m.awayTeamId);
    if (!h || !a) continue;
    h.played++; a.played++;
    h.goalsFor += Number(m.homeGoals); h.goalsAgainst += Number(m.awayGoals);
    a.goalsFor += Number(m.awayGoals); a.goalsAgainst += Number(m.homeGoals);
    h.yellowCards += Number(m.homeYellow || 0); h.redCards += Number(m.homeRed || 0);
    a.yellowCards += Number(m.awayYellow || 0); a.redCards += Number(m.awayRed || 0);
    if (Number(m.homeGoals) > Number(m.awayGoals)) { h.wins++; h.points += 3; a.losses++; }
    else if (Number(m.homeGoals) < Number(m.awayGoals)) { a.wins++; a.points += 3; h.losses++; }
    else { h.draws++; a.draws++; h.points++; a.points++; }
  }
  const standingsGroups = groups.map(g => {
    const standings = g.teams.map(t => byTeam.get(t.id)).filter(Boolean);
    standings.forEach(x => { x.goalDifference = x.goalsFor - x.goalsAgainst; });
    standings.sort(compareStanding);
    standings.forEach((x, i) => { x.rank = i + 1; if (i < 2) x.qualification = 'qualified'; });
    return { name: g.name, standings };
  });
  const groupMatches = matches.filter(m => (!m.phase || m.phase === 'group'));
  const groupsComplete = groupMatches.length > 0 && groupMatches.every(m => m.status === 'finished');
  const thirds = standingsGroups.flatMap(g => g.standings.filter(x => x.rank === 3)).sort(compareStanding);
  const count = groupsComplete ? Math.min(Math.max(0, Number(bestThirdCount) || 0), 8, thirds.length) : 0;
  thirds.forEach((x, i) => { if (i < count) x.qualification = 'best-third'; else if (Number(bestThirdCount) > 0) x.qualification = 'third-candidate'; });
  return standingsGroups;
}
function mapMatch(row) {
  return {
    id: row.id, tournamentId: row.tournamentId, groupName: row.groupName, phase: row.phase || 'group',
    roundName: row.roundName || '', roundNumber: Number(row.roundNumber || 1), matchNumber: Number(row.matchNumber || 1),
    homeTeamId: row.homeTeamId, awayTeamId: row.awayTeamId,
    homeTeamName: row.homeTeamName || 'À déterminer', awayTeamName: row.awayTeamName || 'À déterminer',
    matchDate: row.matchDate, matchTime: row.matchTime, homeGoals: row.homeGoals, awayGoals: row.awayGoals,
    homeYellow: Number(row.homeYellow || 0), homeRed: Number(row.homeRed || 0),
    awayYellow: Number(row.awayYellow || 0), awayRed: Number(row.awayRed || 0),
    homePenalties: row.homePenalties == null ? null : Number(row.homePenalties),
    awayPenalties: row.awayPenalties == null ? null : Number(row.awayPenalties), scorers: Array.isArray(row.scorers) ? row.scorers : [], status: row.status
  };
}
async function getTournamentDetails(tournament, admin = false, executor = pool) {
  const teamsResult = await executor.query(`SELECT id, team_name AS "teamName", captain_name AS "captainName", phone, ticket_code AS "ticketCode", payment_status AS "paymentStatus", group_name AS "groupName", created_at AS "createdAt" FROM tournament_teams WHERE tournament_id=$1 ORDER BY created_at ASC,id ASC`, [tournament.id]);
  const teams = teamsResult.rows;
  const isLeague = tournament.competitionType === 'league';
  const groups = isLeague ? [{ name: 'Championnat', teams: teams.map(team => ({ ...team, groupName: 'Championnat' })) }] : tournamentGroups(teams, tournament.groupCount);
  const matchesResult = await executor.query(`
    SELECT m.id,m.tournament_id AS "tournamentId",m.group_name AS "groupName",m.phase,m.round_name AS "roundName",
      m.round_number AS "roundNumber",m.match_number AS "matchNumber",m.home_team_id AS "homeTeamId",m.away_team_id AS "awayTeamId",
      COALESCE(ht.team_name,'À déterminer') AS "homeTeamName",COALESCE(at.team_name,'À déterminer') AS "awayTeamName",
      m.match_date AS "matchDate",m.match_time AS "matchTime",m.home_goals AS "homeGoals",m.away_goals AS "awayGoals",
      m.home_yellow AS "homeYellow",m.home_red AS "homeRed",m.away_yellow AS "awayYellow",m.away_red AS "awayRed",
      m.home_penalties AS "homePenalties",m.away_penalties AS "awayPenalties",m.scorers,m.status
    FROM tournament_matches m LEFT JOIN tournament_teams ht ON ht.id=m.home_team_id LEFT JOIN tournament_teams at ON at.id=m.away_team_id
    WHERE m.tournament_id=$1
    ORDER BY CASE WHEN m.phase='group' THEN 0 ELSE 1 END,m.round_number,m.match_number,m.match_date NULLS LAST,m.match_time NULLS LAST,m.created_at`, [tournament.id]);
  const matches = matchesResult.rows.map(mapMatch);
  let standings = calculateStandings(groups, isLeague ? matches.map(m => m.phase==='league' ? {...m,phase:'group'} : m) : matches, tournament.bestThirdCount);
  if (isLeague) {
    const table = standings[0]?.standings || [];
    const playedHeadToHead = (a,b) => matches.filter(m => m.status === 'finished' && m.phase !== 'knockout' && ((m.homeTeamId===a.id&&m.awayTeamId===b.id)||(m.homeTeamId===b.id&&m.awayTeamId===a.id)));
    const mini = (team, tied) => { let points=0,gf=0,ga=0; for(const other of tied){if(other.id===team.id)continue;for(const m of playedHeadToHead(team,other)){const home=m.homeTeamId===team.id, own=Number(home?m.homeGoals:m.awayGoals), opp=Number(home?m.awayGoals:m.homeGoals);gf+=own;ga+=opp;if(own>opp)points+=3;else if(own===opp)points++;}}return {points,diff:gf-ga,gf}; };
    table.sort((a,b)=> { if(b.points!==a.points)return b.points-a.points; const tied=table.filter(x=>x.points===a.points); if(tied.length>1){const ma=mini(a,tied),mb=mini(b,tied);if(mb.points!==ma.points)return mb.points-ma.points;if(mb.diff!==ma.diff)return mb.diff-ma.diff;if(mb.gf!==ma.gf)return mb.gf-ma.gf;} if(b.goalDifference!==a.goalDifference)return b.goalDifference-a.goalDifference; if(b.goalsFor!==a.goalsFor)return b.goalsFor-a.goalsFor; return a.teamName.localeCompare(b.teamName,'fr'); });
    table.forEach((x,i)=>{x.rank=i+1;x.qualification='';});
    const finished=matches.filter(m=>m.phase!=='knockout');
    const expected=teams.length*(teams.length-1)/2*(tournament.seasonFormat==='double'?2:1);
    const champion=teams.length>=5 && finished.length===expected && finished.every(m=>m.status==='finished') && table.length ? table[0] : null;
    standings = [{name:'Championnat', standings:table}];
    tournament = {...tournament, champion: champion ? {id:champion.id,teamName:champion.teamName} : null, leagueComplete: Boolean(champion)};
  }
  const scorerTotals = new Map();
  for (const match of matches) {
    if (match.status !== 'finished') continue;
    for (const scorer of (match.scorers || [])) {
      const playerName = String(scorer.name || '').trim();
      const goals = Number(scorer.goals || 0);
      const teamName = String(scorer.teamName || (scorer.side === 'home' ? match.homeTeamName : match.awayTeamName) || '').trim();
      if (!playerName || !Number.isInteger(goals) || goals < 1) continue;
      const key = playerName.toLocaleLowerCase('fr');
      const item = scorerTotals.get(key) || { name: playerName, goals: 0, teams: new Set() };
      item.goals += goals;
      if (teamName) item.teams.add(teamName);
      scorerTotals.set(key, item);
    }
  }
  const topScorers = [...scorerTotals.values()].map(x => ({name:x.name, goals:x.goals, teams:[...x.teams]})).sort((x,y)=>y.goals-x.goals || x.name.localeCompare(y.name,'fr')).slice(0,50);
  const assistTotals = new Map();
  for (const match of matches) { if (match.status !== 'finished') continue; for (const player of (match.scorers || [])) { const name=String(player.name||'').trim(), assists=Number(player.assists||0), teamName=String(player.teamName || (player.side==='home'?match.homeTeamName:match.awayTeamName)||'').trim(); if(!name||!Number.isInteger(assists)||assists<1)continue; const key=name.toLocaleLowerCase('fr'); const item=assistTotals.get(key)||{name,assists:0,teams:new Set()};item.assists+=assists;if(teamName)item.teams.add(teamName);assistTotals.set(key,item); } }
  const topAssists=[...assistTotals.values()].map(x=>({name:x.name,assists:x.assists,teams:[...x.teams]})).sort((a,b)=>b.assists-a.assists||a.name.localeCompare(b.name,'fr')).slice(0,50);
  // Public clients need team names and groups, never captains' phone numbers or ticket codes.
  const visibleGroups = groups.map(group => ({
    ...group,
    teams: group.teams.map(team => admin ? team : ({ id: team.id, teamName: team.teamName, groupName: team.groupName || group.name }))
  }));
  return { ...tournament, groups: visibleGroups, standings, matches, topScorers, topAssists, teams: admin ? teams : undefined };
}
function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function makeRoundRobin(inputTeams) {
  const teams = [...inputTeams];
  if (teams.length % 2) teams.push(null);
  const rounds = [];
  const n = teams.length;
  if (n < 2) return rounds;
  let rotation = [...teams];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      let home = rotation[i], away = rotation[n - 1 - i];
      if (home && away) { if (r % 2) [home, away] = [away, home]; pairs.push([home, away]); }
    }
    rounds.push(pairs);
    rotation = [rotation[0], rotation[n - 1], ...rotation.slice(1, n - 1)];
  }
  return rounds;
}
function addDays(dateText, days) {
  const d = new Date(`${dateText}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
function normalizeTime(time) { return /^\d{2}:\d{2}$/.test(String(time || '')) ? String(time) : '16:00'; }
function roundLabel(bracketSize, roundNumber) {
  const remaining = bracketSize / (2 ** (roundNumber - 1));
  if (remaining === 2) return 'Finale';
  if (remaining === 4) return 'Demi-finales';
  if (remaining === 8) return 'Quarts de finale';
  if (remaining === 16) return 'Huitièmes de finale';
  if (remaining === 32) return 'Seizièmes de finale';
  if (remaining === 64) return 'Tour préliminaire';
  return `Phase éliminatoire · Tour ${roundNumber}`;
}
function bracketSeedOrder(size) {
  let order = [1, 2];
  for (let current = 2; current < size; current *= 2) order = order.flatMap(seed => [seed, current * 2 + 1 - seed]);
  return order;
}
async function advanceWinner(executor, tournamentId, match, winnerId) {
  if (!match || !winnerId || match.phase !== 'knockout') return;
  const nextRound = Number(match.roundNumber) + 1;
  const nextMatchNumber = Math.ceil(Number(match.matchNumber) / 2);
  const next = await executor.query(`SELECT id,home_team_id AS "homeTeamId",away_team_id AS "awayTeamId",status,round_number AS "roundNumber",match_number AS "matchNumber" FROM tournament_matches WHERE tournament_id=$1 AND phase='knockout' AND round_number=$2 AND match_number=$3 FOR UPDATE`, [tournamentId, nextRound, nextMatchNumber]);
  if (!next.rowCount) return;
  const target = next.rows[0];
  const column = Number(match.matchNumber) % 2 === 1 ? 'home_team_id' : 'away_team_id';
  if (target.status === 'bye') {
    await executor.query(`UPDATE tournament_matches SET ${column}=$2,status='scheduled',home_goals=NULL,away_goals=NULL,home_penalties=NULL,away_penalties=NULL,home_yellow=0,home_red=0,away_yellow=0,away_red=0,scorers='[]'::jsonb WHERE id=$1`, [target.id, winnerId]);
  } else {
    await executor.query(`UPDATE tournament_matches SET ${column}=$2 WHERE id=$1`, [target.id, winnerId]);
  }
  const feeders = await executor.query(`SELECT status,home_team_id,away_team_id FROM tournament_matches WHERE tournament_id=$1 AND phase='knockout' AND round_number=$2 AND match_number IN ($3,$4)`, [tournamentId, Number(match.roundNumber), nextMatchNumber * 2 - 1, nextMatchNumber * 2]);
  if (feeders.rowCount === 2 && feeders.rows.every(x => ['finished','bye'].includes(x.status))) {
    const refreshed = await executor.query(`SELECT id,home_team_id AS "homeTeamId",away_team_id AS "awayTeamId",status,round_number AS "roundNumber",match_number AS "matchNumber" FROM tournament_matches WHERE id=$1 FOR UPDATE`, [target.id]);
    const nx = refreshed.rows[0];
    if ((nx.homeTeamId && !nx.awayTeamId) || (!nx.homeTeamId && nx.awayTeamId)) {
      const autoWinner = nx.homeTeamId || nx.awayTeamId;
      await executor.query(`UPDATE tournament_matches SET status='bye' WHERE id=$1`, [nx.id]);
      await advanceWinner(executor, tournamentId, nx, autoWinner);
    }
  }
}
async function createKnockoutIfReady(executor, tournamentId, forceRebuild = false) {
  const existing = await executor.query(`SELECT id,status FROM tournament_matches WHERE tournament_id=$1 AND phase='knockout' ORDER BY round_number,match_number`, [tournamentId]);
  if (existing.rowCount) {
    if (!forceRebuild) return false;
    if (existing.rows.some(m => m.status === 'finished')) return false;
    await executor.query(`DELETE FROM tournament_matches WHERE tournament_id=$1 AND phase='knockout'`, [tournamentId]);
  }
  const total = await executor.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE status='finished')::int AS finished FROM tournament_matches WHERE tournament_id=$1 AND phase='group'`, [tournamentId]);
  if (!total.rows[0].total || total.rows[0].total !== total.rows[0].finished) return false;
  const tr = await executor.query(`SELECT id,name,group_count AS "groupCount",best_third_count AS "bestThirdCount",tournament_date AS "tournamentDate" FROM tournaments WHERE id=$1`, [tournamentId]);
  if (!tr.rowCount) return false;
  const detail = await getTournamentDetails({ ...tr.rows[0], maxTeams: 48, status: 'closed' }, true, executor);
  const expectedGroupMatches = detail.groups.reduce((sum, group) => sum + (group.teams.length * (group.teams.length - 1)) / 2, 0);
  if (total.rows[0].total !== expectedGroupMatches) return false;
  const groups = detail.standings;
  const winners = groups.flatMap(g => g.standings.filter(x => x.rank === 1));
  const runners = groups.flatMap(g => g.standings.filter(x => x.rank === 2));
  const thirds = groups.flatMap(g => g.standings.filter(x => x.rank === 3)).sort(compareStanding).slice(0, Math.min(Number(tr.rows[0].bestThirdCount) || 0, 8));
  const qualifiers = [...winners, ...runners, ...thirds];
  if (qualifiers.length < 2) return false;
  let size = 2; while (size < qualifiers.length) size *= 2;
  const seedOrder = bracketSeedOrder(size);
  const seedSlots = Array(size).fill(null);
  qualifiers.forEach((team, i) => { seedSlots[i] = team; });
  const slots = seedOrder.map(seed => seedSlots[seed - 1] || null);
  const latest = await executor.query(`SELECT MAX(match_date)::text AS date FROM tournament_matches WHERE tournament_id=$1 AND phase='group'`, [tournamentId]);
  const baseDate = latest.rows[0].date || (tr.rows[0].tournamentDate ? String(tr.rows[0].tournamentDate).slice(0,10) : new Date().toISOString().slice(0,10));
  const baseTime = '16:00';
  const rounds = Math.log2(size);
  for (let round = 1; round <= rounds; round++) {
    const count = size / (2 ** round);
    for (let matchNumber = 1; matchNumber <= count; matchNumber++) {
      let home = null, away = null, status = 'scheduled';
      if (round === 1) {
        home = slots[(matchNumber - 1) * 2] ? slots[(matchNumber - 1) * 2].id : null;
        away = slots[(matchNumber - 1) * 2 + 1] ? slots[(matchNumber - 1) * 2 + 1].id : null;
        if ((home && !away) || (!home && away)) status = 'bye';
      }
      const id = `ko-${Date.now()}-${round}-${matchNumber}-${Math.random().toString(36).slice(2,5)}`;
      await executor.query(`INSERT INTO tournament_matches(id,tournament_id,group_name,home_team_id,away_team_id,match_date,match_time,status,phase,round_name,round_number,match_number)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'knockout',$9,$10,$11)`, [id,tournamentId,roundLabel(size,round),home,away,addDays(baseDate,round),baseTime,status,roundLabel(size,round),round,matchNumber]);
    }
  }
  const byes = await executor.query(`SELECT id,home_team_id AS "homeTeamId",away_team_id AS "awayTeamId",phase,round_number AS "roundNumber",match_number AS "matchNumber",status FROM tournament_matches WHERE tournament_id=$1 AND phase='knockout' AND round_number=1 AND status='bye' ORDER BY match_number`, [tournamentId]);
  for (const bye of byes.rows) await advanceWinner(executor, tournamentId, bye, bye.homeTeamId || bye.awayTeamId);
  return true;
}
async function maybeRefreshKnockout(executor, tournamentId) {
  const old = await executor.query(`SELECT status FROM tournament_matches WHERE tournament_id=$1 AND phase='knockout'`, [tournamentId]);
  if (old.rows.some(m => m.status === 'finished')) return false;
  return createKnockoutIfReady(executor, tournamentId, old.rowCount > 0);
}
/* Ferme les inscriptions à l'échéance configurée, au début du jour du tournoi
   si aucune échéance n'a été précisée, ou dès que le quota d'équipes est atteint. */
async function closeExpiredTournamentRegistrations(executor = pool, tournamentId = null) {
  const params = [];
  let filter = '';
  if (tournamentId) { params.push(String(tournamentId)); filter = `AND t.id = $${params.length}`; }
  await executor.query(`
    UPDATE tournaments AS t SET status = 'closed'
     WHERE t.status = 'open' ${filter}
       AND (
         (t.registration_deadline IS NOT NULL AND t.registration_deadline <= NOW())
         OR (t.registration_deadline IS NULL AND t.tournament_date IS NOT NULL
             AND t.tournament_date <= (NOW() AT TIME ZONE 'Africa/Algiers')::date)
         OR (SELECT COUNT(*) FROM tournament_teams tt WHERE tt.tournament_id = t.id) >= t.max_teams
       )`, params);
}

app.get('/api/tournaments', async (_req, res) => {
  try {
    await closeExpiredTournamentRegistrations();
    const result = await pool.query(`SELECT t.id,t.name,t.tournament_date AS "tournamentDate",t.registration_deadline AS "registrationDeadline",t.description,t.max_teams AS "maxTeams",t.group_count AS "groupCount",t.best_third_count AS "bestThirdCount",t.competition_type AS "competitionType",t.season_format AS "seasonFormat",t.status,t.created_at AS "createdAt",COUNT(tt.id)::int AS "registeredTeams" FROM tournaments t LEFT JOIN tournament_teams tt ON tt.tournament_id=t.id GROUP BY t.id ORDER BY t.created_at DESC`);
    const tournaments = []; for (const t of result.rows) tournaments.push(await getTournamentDetails(t, false));
    res.set('Cache-Control','no-store'); res.json({ tournaments });
  } catch (error) { dbError(res, error, 'Impossible de charger les tournois et résultats.'); }
});
app.post('/api/tournaments/:id/register', async (req, res) => {
  const teamName = String(req.body?.teamName || '').trim(), captainName = String(req.body?.captainName || '').trim(), phone = String(req.body?.phone || '').trim();
  if (teamName.length < 2 || teamName.length > 80 || captainName.length < 2 || captainName.length > 100 || phone.length < 6 || phone.length > 30) return res.status(400).json({ error: 'Renseigne le nom de l’équipe, le responsable et un téléphone valide.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const tr = await client.query('SELECT * FROM tournaments WHERE id=$1 FOR UPDATE', [String(req.params.id)]);
    if (!tr.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tournoi introuvable.' }); }
    const tournament = tr.rows[0];
    const deadlinePassed = tournament.registration_deadline ? new Date(tournament.registration_deadline).getTime() <= Date.now() : Boolean(tournament.tournament_date && String(tournament.tournament_date).slice(0,10) <= getStadiumDateTime().date);
    const count = await client.query('SELECT COUNT(*)::int AS n FROM tournament_teams WHERE tournament_id=$1', [tournament.id]);
    if (tournament.status !== 'open' || deadlinePassed || count.rows[0].n >= tournament.max_teams) {
      if (tournament.status === 'open' && (deadlinePassed || count.rows[0].n >= tournament.max_teams)) await client.query(`UPDATE tournaments SET status='closed' WHERE id=$1`, [tournament.id]);
      await client.query('COMMIT');
      return res.status(409).json({ error: count.rows[0].n >= tournament.max_teams ? 'Ce tournoi est complet : les inscriptions sont automatiquement fermées.' : 'La date limite est passée : les inscriptions à ce tournoi sont fermées.' });
    }
    const hasDraw = await client.query(`SELECT 1 FROM tournament_matches WHERE tournament_id=$1 LIMIT 1`, [tournament.id]);
    if (hasDraw.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Le calendrier est déjà généré. Les inscriptions sont verrouillées pour préserver les matchs.' }); }
    const duplicate = await client.query('SELECT 1 FROM tournament_teams WHERE tournament_id=$1 AND LOWER(team_name)=LOWER($2)', [tournament.id, teamName]);
    if (duplicate.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Cette équipe est déjà inscrite à ce tournoi.' }); }

    // Complète les éventuelles anciennes inscriptions sans groupe, en gardant les groupes déjà attribués.
    const groups = Array.from({ length: Number(tournament.group_count) }, (_, i) => ({ name: groupLabel(i), count: 0 }));
    const groupIndex = new Map(groups.map((g, i) => [g.name, i]));
    const existingTeams = await client.query(`SELECT id,group_name AS "groupName" FROM tournament_teams WHERE tournament_id=$1 ORDER BY created_at,id FOR UPDATE`, [tournament.id]);
    for (const existingTeam of existingTeams.rows) {
      const idx = groupIndex.get(String(existingTeam.groupName || '').trim());
      if (idx !== undefined) groups[idx].count++;
      else {
        const min = Math.min(...groups.map(g => g.count));
        const candidates = groups.map((g, i) => ({ g, i })).filter(x => x.g.count === min);
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        await client.query(`UPDATE tournament_teams SET group_name=$2 WHERE id=$1`, [existingTeam.id, chosen.g.name]);
        chosen.g.count++;
      }
    }
    const minCount = Math.min(...groups.map(g => g.count));
    const eligible = groups.filter(g => g.count === minCount);
    const assignedGroup = eligible[Math.floor(Math.random() * eligible.length)].name;
    const id = `team-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, ticketCode = `JOT-${Math.random().toString(36).slice(2,6).toUpperCase()}-${Date.now().toString().slice(-6)}`;
    const inserted = await client.query(`INSERT INTO tournament_teams(id,tournament_id,team_name,captain_name,phone,ticket_code,payment_status,group_name) VALUES($1,$2,$3,$4,$5,$6,'on_site',$7) RETURNING id,team_name AS "teamName",captain_name AS "captainName",phone,ticket_code AS "ticketCode",payment_status AS "paymentStatus",group_name AS "groupName",created_at AS "createdAt"`, [id,tournament.id,teamName,captainName,phone,ticketCode,assignedGroup]);
    const newCount = Number(count.rows[0].n) + 1;
    if (newCount >= Number(tournament.max_teams)) await client.query(`UPDATE tournaments SET status='closed' WHERE id=$1`, [tournament.id]);
    await client.query('COMMIT'); res.set('Cache-Control','no-store').status(201).json({ ok: true, tournament: { id: tournament.id, name: tournament.name }, team: inserted.rows[0], registrationClosed: newCount >= Number(tournament.max_teams), paymentMessage: 'Ticket d’inscription créé. Groupe attribué automatiquement. Frais à régler sur place.' });
  } catch (error) { try { await client.query('ROLLBACK'); } catch (_) {} if (error.code === '23505') return res.status(409).json({ error: 'Cette équipe est déjà inscrite à ce tournoi.' }); dbError(res,error,'Impossible d’inscrire cette équipe.'); }
  finally { client.release(); }
});
app.get('/api/admin/tournaments', adminAuth, async (_req, res) => {
  try {
    await closeExpiredTournamentRegistrations();
    const result = await pool.query(`SELECT t.id,t.name,t.tournament_date AS "tournamentDate",t.registration_deadline AS "registrationDeadline",t.description,t.max_teams AS "maxTeams",t.group_count AS "groupCount",t.best_third_count AS "bestThirdCount",t.competition_type AS "competitionType",t.season_format AS "seasonFormat",t.status,t.created_at AS "createdAt",COUNT(tt.id)::int AS "registeredTeams" FROM tournaments t LEFT JOIN tournament_teams tt ON tt.tournament_id=t.id GROUP BY t.id ORDER BY t.created_at DESC`);
    const tournaments = []; for (const t of result.rows) tournaments.push(await getTournamentDetails(t, true));
    res.set('Cache-Control','no-store'); res.json({ tournaments });
  } catch (error) { dbError(res,error,'Impossible de charger les tournois administrateur.'); }
});
app.post('/api/admin/tournaments', adminAuth, async (req, res) => {
  const name=String(req.body?.name||'').trim(), description=String(req.body?.description||'').trim().slice(0,500), maxTeams=Number(req.body?.maxTeams), groupCount=Number(req.body?.groupCount), bestThirdCount=Number(req.body?.bestThirdCount||0), tournamentDate=req.body?.tournamentDate?String(req.body.tournamentDate):null, registrationDeadline=req.body?.registrationDeadline?String(req.body.registrationDeadline):null;
  const competitionType = req.body?.competitionType === 'league' ? 'league' : 'cup'; const seasonFormat = req.body?.seasonFormat === 'double' ? 'double' : 'single';
  const deadlineValid = !registrationDeadline || (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(registrationDeadline) && !Number.isNaN(new Date(`${registrationDeadline}:00+01:00`).getTime()));
  if (name.length<2 || name.length>100 || !Number.isInteger(maxTeams) || (competitionType==='league' ? (maxTeams<5||maxTeams>20) : (maxTeams<8||maxTeams>48)) || !Number.isInteger(groupCount) || (competitionType==='league' ? groupCount!==1 : (groupCount<2||groupCount>24||groupCount*4>maxTeams||groupCount*5<maxTeams)) || !Number.isInteger(bestThirdCount) || !(bestThirdCount===0 || (bestThirdCount>=2 && bestThirdCount<=8)) || (tournamentDate&&!/^\d{4}-\d{2}-\d{2}$/.test(tournamentDate)) || !deadlineValid) return res.status(400).json({error: competitionType==='league' ? 'Un championnat doit contenir de 5 à 20 équipes.' : 'Configuration invalide : chaque groupe doit accueillir de 4 à 5 équipes.'});
  try { const id=`tour-${Date.now()}-${Math.random().toString(36).slice(2,6)}`; const deadlineIso=registrationDeadline?new Date(`${registrationDeadline}:00+01:00`):null; const r=await pool.query(`INSERT INTO tournaments(id,name,tournament_date,registration_deadline,description,max_teams,group_count,best_third_count,competition_type,season_format,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open') RETURNING id,name,tournament_date AS "tournamentDate",registration_deadline AS "registrationDeadline",description,max_teams AS "maxTeams",group_count AS "groupCount",best_third_count AS "bestThirdCount",competition_type AS "competitionType",season_format AS "seasonFormat",status,created_at AS "createdAt"`,[id,name,tournamentDate,deadlineIso,description,maxTeams,groupCount,bestThirdCount,competitionType,seasonFormat]); res.status(201).json({tournament:{...r.rows[0],registeredTeams:0}}); }
  catch(error) { dbError(res,error,'Impossible de créer le tournoi.'); }
});
app.patch('/api/admin/tournaments/:id/status', adminAuth, async (req,res) => { const status=String(req.body?.status||''); if(!['open','closed'].includes(status)) return res.status(400).json({error:'Statut invalide.'}); try { if(status==='open'){await closeExpiredTournamentRegistrations();const current=await pool.query(`SELECT t.registration_deadline AS "registrationDeadline",t.tournament_date AS "tournamentDate",t.max_teams AS "maxTeams",COUNT(tt.id)::int AS "registeredTeams" FROM tournaments t LEFT JOIN tournament_teams tt ON tt.tournament_id=t.id WHERE t.id=$1 GROUP BY t.id`,[String(req.params.id)]);if(!current.rowCount)return res.status(404).json({error:'Tournoi introuvable.'});const x=current.rows[0];if(x.registrationDeadline&&new Date(x.registrationDeadline).getTime()<=Date.now())return res.status(409).json({error:'La date limite est passée : ce tournoi ne peut plus être rouvert.'});if(!x.registrationDeadline&&x.tournamentDate&&String(x.tournamentDate).slice(0,10)<=getStadiumDateTime().date)return res.status(409).json({error:'Le jour du tournoi est arrivé : les inscriptions ne peuvent plus être rouvertes.'});if(Number(x.registeredTeams)>=Number(x.maxTeams))return res.status(409).json({error:'Le quota maximal est atteint : les inscriptions ne peuvent plus être rouvertes.'});const scheduled=await pool.query('SELECT 1 FROM tournament_matches WHERE tournament_id=$1 LIMIT 1',[String(req.params.id)]);if(scheduled.rowCount)return res.status(409).json({error:'Les inscriptions ne peuvent pas être rouvertes après le tirage. Réinitialise le calendrier avant d’ajouter une équipe.'});} const r=await pool.query('UPDATE tournaments SET status=$2 WHERE id=$1 RETURNING id,status',[String(req.params.id),status]); if(!r.rowCount)return res.status(404).json({error:'Tournoi introuvable.'}); res.json({ok:true,tournament:r.rows[0]}); } catch(error) { dbError(res,error,'Impossible de modifier le tournoi.'); } });
app.patch('/api/admin/tournaments/:id/registration-deadline', adminAuth, async (req,res) => {
  const value = req.body?.registrationDeadline ? String(req.body.registrationDeadline) : null;
  if (value && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || Number.isNaN(new Date(`${value}:00+01:00`).getTime()))) {
    return res.status(400).json({error:'Format de date invalide. Utilise AAAA-MM-JJTHH:MM.'});
  }
  try {
    const deadline = value ? new Date(`${value}:00+01:00`) : null;
    const result = await pool.query('UPDATE tournaments SET registration_deadline=$2 WHERE id=$1 RETURNING id,status,registration_deadline AS "registrationDeadline"', [String(req.params.id), deadline]);
    if (!result.rowCount) return res.status(404).json({error:'Tournoi introuvable.'});
    await closeExpiredTournamentRegistrations(pool, String(req.params.id));
    const refreshed = await pool.query('SELECT status FROM tournaments WHERE id=$1', [String(req.params.id)]);
    res.set('Cache-Control','no-store').json({ok:true,status:refreshed.rows[0].status,registrationDeadline:result.rows[0].registrationDeadline});
  } catch(error) { dbError(res,error,'Impossible de modifier la date limite des inscriptions.'); }
});
app.delete('/api/admin/tournaments/:id', adminAuth, async (req,res) => { try { const r=await pool.query('DELETE FROM tournaments WHERE id=$1 RETURNING id',[String(req.params.id)]); if(!r.rowCount)return res.status(404).json({error:'Tournoi introuvable.'}); res.json({ok:true}); } catch(error) { dbError(res,error,'Impossible de supprimer le tournoi.'); } });
app.post('/api/admin/tournaments/:id/generate-schedule', adminAuth, async (req,res) => {
  const tournamentId=String(req.params.id), startDate=String(req.body?.startDate||''), startTime=normalizeTime(req.body?.startTime), matchesPerDay=Number(req.body?.matchesPerDay||4);
  if(startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return res.status(400).json({error:'Choisis une date de départ valide.'});
  if(!Number.isInteger(matchesPerDay)||matchesPerDay<1||matchesPerDay>6) return res.status(400).json({error:'Choisis entre 1 et 6 matchs par jour.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const tr=await client.query('SELECT id,name,group_count AS "groupCount",tournament_date AS "tournamentDate",competition_type AS "competitionType",season_format AS "seasonFormat",max_teams AS "maxTeams" FROM tournaments WHERE id=$1 FOR UPDATE',[tournamentId]);
    if(!tr.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Tournoi introuvable.'});}
    const teams=(await client.query(`SELECT id,team_name AS "teamName",group_name AS "groupName",created_at AS "createdAt" FROM tournament_teams WHERE tournament_id=$1 ORDER BY created_at,id`,[tournamentId])).rows;
    const groupCount=Number(tr.rows[0].groupCount);
    if (tr.rows[0].competitionType === 'league') {
      if (teams.length < 5 || teams.length > 20) { await client.query('ROLLBACK'); return res.status(400).json({error:`Un championnat nécessite entre 5 et 20 équipes inscrites. Actuellement : ${teams.length}.`}); }
      const old=await client.query(`SELECT status FROM tournament_matches WHERE tournament_id=$1`,[tournamentId]);
      if(old.rows.some(m=>m.status==='finished')){await client.query('ROLLBACK');return res.status(409).json({error:'Des résultats existent déjà. Le calendrier ne peut pas être remplacé.'});}
      await client.query(`DELETE FROM tournament_matches WHERE tournament_id=$1`,[tournamentId]);
      const firstLeg=makeRoundRobin(teams); const rounds=tr.rows[0].seasonFormat==='double' ? [...firstLeg,...firstLeg.map(r=>r.map(([h,a])=>[a,h]))] : firstLeg;
      const baseDate=startDate || (tr.rows[0].tournamentDate?String(tr.rows[0].tournamentDate).slice(0,10):new Date().toISOString().slice(0,10));
      const [startHour,startMinute]=startTime.split(':').map(Number); let sequence=0,created=0;
      for(let round=0;round<rounds.length;round++) for(const [home,away] of rounds[round]) {
        const dayOffset=Math.floor(sequence/matchesPerDay),slot=sequence%matchesPerDay,totalMinutes=startHour*60+startMinute+slot*90;
        const date=addDays(baseDate,dayOffset),time=`${String(Math.floor(totalMinutes/60)%24).padStart(2,'0')}:${String(totalMinutes%60).padStart(2,'0')}`;
        const id=`league-${Date.now()}-${sequence}-${Math.random().toString(36).slice(2,5)}`;
        await client.query(`INSERT INTO tournament_matches(id,tournament_id,group_name,home_team_id,away_team_id,match_date,match_time,status,phase,round_name,round_number,match_number) VALUES($1,$2,'Championnat',$3,$4,$5,$6,'scheduled','league',$7,$8,$9)`,[id,tournamentId,home.id,away.id,date,time,`Journée ${round+1}`,round+1,sequence+1]); sequence++;created++;
      }
      await client.query(`UPDATE tournaments SET status='closed' WHERE id=$1`,[tournamentId]); await client.query('COMMIT');
      return res.set('Cache-Control','no-store').json({ok:true,createdMatches:created,message:`Calendrier du championnat généré : ${created} matchs (${tr.rows[0].seasonFormat==='double'?'aller-retour':'demi-saison'}).`});
    }
    if(teams.length<groupCount*4 || teams.length>groupCount*5){await client.query('ROLLBACK');return res.status(400).json({error:`Pour ${groupCount} groupes, il faut entre ${groupCount*4} et ${groupCount*5} équipes inscrites (4 à 5 par groupe). Actuellement : ${teams.length}.`});}
    const old=await client.query(`SELECT status FROM tournament_matches WHERE tournament_id=$1`,[tournamentId]);
    if(old.rows.some(m=>m.status==='finished')){await client.query('ROLLBACK');return res.status(409).json({error:'Des résultats existent déjà. Le calendrier ne peut pas être remplacé sans supprimer ces résultats.'});}
    await client.query(`DELETE FROM tournament_matches WHERE tournament_id=$1`,[tournamentId]);
    await client.query(`UPDATE tournament_teams SET group_name='' WHERE tournament_id=$1`,[tournamentId]);
    const groups=Array.from({length:groupCount},(_,i)=>({name:groupLabel(i),teams:[]}));
    const groupByName=new Map(groups.map(g=>[g.name,g]));
    const unassigned=[];
    for(const team of teams){const target=groupByName.get(String(team.groupName||'').trim());if(target)target.teams.push(team);else unassigned.push(team);}
    // Legacy registrations without a group are randomly placed in the smallest group.
    shuffle(unassigned).forEach(team=>{const min=Math.min(...groups.map(g=>g.teams.length));const candidates=groups.filter(g=>g.teams.length===min);const target=candidates[Math.floor(Math.random()*candidates.length)];target.teams.push(team);team.groupName=target.name;});
    for(const group of groups) for(const team of group.teams) await client.query(`UPDATE tournament_teams SET group_name=$2 WHERE id=$1`,[team.id,group.name]);
    const groupRounds=groups.map(g=>({group:g,rounds:makeRoundRobin(g.teams)}));
    const maxRounds=Math.max(...groupRounds.map(x=>x.rounds.length));
    const baseDate=startDate || (tr.rows[0].tournamentDate?String(tr.rows[0].tournamentDate).slice(0,10):new Date().toISOString().slice(0,10));
    const [startHour,startMinute]=startTime.split(':').map(Number); let sequence=0,created=0;
    for(let round=0;round<maxRounds;round++) for(const entry of groupRounds) {
      for(const [home,away] of (entry.rounds[round]||[])) {
        const dayOffset=Math.floor(sequence/matchesPerDay), slot=sequence%matchesPerDay;
        const totalMinutes=startHour*60+startMinute+slot*90;
        const date=addDays(baseDate,dayOffset+round*0);
        const time=`${String(Math.floor(totalMinutes/60)%24).padStart(2,'0')}:${String(totalMinutes%60).padStart(2,'0')}`;
        const id=`match-${Date.now()}-${sequence}-${Math.random().toString(36).slice(2,5)}`;
        await client.query(`INSERT INTO tournament_matches(id,tournament_id,group_name,home_team_id,away_team_id,match_date,match_time,status,phase,round_name,round_number,match_number)
          VALUES($1,$2,$3,$4,$5,$6,$7,'scheduled','group',$8,$9,$10)`,[id,tournamentId,entry.group.name,home.id,away.id,date,time,`Phase de groupes · Journée ${round+1}`,round+1,sequence+1]);
        sequence++;created++;
      }
    }
    await client.query(`UPDATE tournaments SET status='closed' WHERE id=$1`,[tournamentId]);
    await client.query('COMMIT');
    res.set('Cache-Control','no-store').json({ok:true,createdMatches:created,groups:groups.map(g=>({name:g.name,teams:g.teams.map(t=>t.teamName)})),message:`Tirage au sort effectué. ${created} matchs de poule programmés automatiquement. Le tableau éliminatoire se créera après le dernier résultat de poule.`});
  } catch(error) { try{await client.query('ROLLBACK')}catch(_){} dbError(res,error,'Impossible de générer le tirage et le calendrier.'); }
  finally { client.release(); }
});
app.post('/api/admin/tournaments/:id/matches', adminAuth, async(req,res)=>{
  const tournamentId=String(req.params.id),homeTeamId=String(req.body?.homeTeamId||''),awayTeamId=String(req.body?.awayTeamId||''),matchDate=req.body?.matchDate?String(req.body.matchDate):null,matchTime=req.body?.matchTime?String(req.body.matchTime):null;
  if(!homeTeamId||!awayTeamId||homeTeamId===awayTeamId||(matchDate&&!/^\d{4}-\d{2}-\d{2}$/.test(matchDate))||(matchTime&&!/^\d{2}:\d{2}$/.test(matchTime)))return res.status(400).json({error:'Choisis deux équipes différentes et une date/heure valides.'});
  try { const auto=await pool.query("SELECT 1 FROM tournament_matches WHERE tournament_id=$1 AND phase='group' AND round_name LIKE 'Phase de groupes%' LIMIT 1",[tournamentId]); if(auto.rowCount)return res.status(409).json({error:'Le calendrier automatique est actif. Modifie les matchs déjà générés au lieu d’en ajouter un doublon.'}); const tr=await pool.query('SELECT group_count AS "groupCount" FROM tournaments WHERE id=$1',[tournamentId]); if(!tr.rowCount)return res.status(404).json({error:'Tournoi introuvable.'}); const all=(await pool.query('SELECT id,group_name AS "groupName",created_at AS "createdAt" FROM tournament_teams WHERE tournament_id=$1 ORDER BY created_at,id',[tournamentId])).rows; const selected=all.filter(t=>[homeTeamId,awayTeamId].includes(t.id)); if(selected.length!==2)return res.status(400).json({error:'Les deux équipes doivent appartenir à ce tournoi.'}); const groups=tournamentGroups(all,tr.rows[0].groupCount); const homeGroup=groups.find(g=>g.teams.some(t=>t.id===homeTeamId)); const awayGroup=groups.find(g=>g.teams.some(t=>t.id===awayTeamId)); if(!homeGroup||!awayGroup||homeGroup.name!==awayGroup.name)return res.status(400).json({error:'Pour un match de groupe, choisis deux équipes du même groupe.'}); const id=`match-${Date.now()}-${Math.random().toString(36).slice(2,6)}`; await pool.query(`INSERT INTO tournament_matches(id,tournament_id,group_name,home_team_id,away_team_id,match_date,match_time,phase,round_name) VALUES($1,$2,$3,$4,$5,$6,$7,'group',$3)`,[id,tournamentId,homeGroup.name,homeTeamId,awayTeamId,matchDate,matchTime]); res.status(201).json({ok:true,id}); }
  catch(error){dbError(res,error,'Impossible de programmer le match.');}
});
async function saveMatchResult(req,res,manual=false) {
  const tournamentId=String(req.params.id), body=req.body||{};
  const n={}; for(const k of ['homeGoals','awayGoals','homeYellow','homeRed','awayYellow','awayRed']) { n[k]=Number(body[k]??0); if(!Number.isInteger(n[k])||n[k]<0||n[k]>99)return res.status(400).json({error:'Les scores et cartons doivent être des nombres entiers de 0 à 99.'}); }
  const penalties={home:Number(body.homePenalties),away:Number(body.awayPenalties)};
  if(body.homePenalties!==undefined && body.homePenalties!=='' && (!Number.isInteger(penalties.home)||penalties.home<0||penalties.home>99))return res.status(400).json({error:'Tirs au but invalides.'});
  if(body.awayPenalties!==undefined && body.awayPenalties!=='' && (!Number.isInteger(penalties.away)||penalties.away<0||penalties.away>99))return res.status(400).json({error:'Tirs au but invalides.'});
  const cleanScorers = (input, side) => {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const raw of input.slice(0, 100)) {
      const name = String(raw?.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const goals = Number(raw?.goals ?? 0);
      if (!name) continue;
      const assists = Number(raw?.assists || 0);
      if (!Number.isInteger(goals) || goals < 0 || goals > 99) throw new Error('Le nombre de buts doit être un entier entre 0 et 99.');
      if (!Number.isInteger(assists) || assists < 0 || assists > 99) throw new Error('Le nombre de passes décisives doit être un entier entre 0 et 99.');
      if (goals === 0 && assists === 0) continue;
      out.push({name, goals, assists, side});
    }
    return out;
  };
  let scorers;
  try { scorers = [...cleanScorers(body.homeScorers, 'home'), ...cleanScorers(body.awayScorers, 'away')]; }
  catch (error) { return res.status(400).json({error:error.message}); }
  const homeScorerGoals = scorers.filter(x=>x.side==='home').reduce((sum,x)=>sum+x.goals,0);
  const awayScorerGoals = scorers.filter(x=>x.side==='away').reduce((sum,x)=>sum+x.goals,0);
  if (homeScorerGoals > n.homeGoals || awayScorerGoals > n.awayGoals) return res.status(400).json({error:'Le total des buts attribués aux buteurs ne peut pas dépasser le score de leur équipe.'});
  const homeAssistTotal = scorers.filter(x=>x.side==='home').reduce((sum,x)=>sum+x.assists,0);
  const awayAssistTotal = scorers.filter(x=>x.side==='away').reduce((sum,x)=>sum+x.assists,0);
  if (homeAssistTotal > n.homeGoals || awayAssistTotal > n.awayGoals) return res.status(400).json({error:'Le total des passes décisives ne peut pas dépasser le nombre de buts de l’équipe. Les buts sans passe décisive restent autorisés.'});
  const homeTeamId=String(body.homeTeamId||''),awayTeamId=String(body.awayTeamId||'');
  const date=body.matchDate?String(body.matchDate):null,time=body.matchTime?String(body.matchTime):null;
  if(manual && (!homeTeamId||!awayTeamId||homeTeamId===awayTeamId))return res.status(400).json({error:'Sélectionne deux équipes différentes.'});
  if((date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))||(time&&!/^\d{2}:\d{2}$/.test(time)))return res.status(400).json({error:'La date ou l’heure du match est invalide.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    let matchId=String(req.params.matchId||''), phase='group', groupName='', homeId=homeTeamId, awayId=awayTeamId, roundNumber=1, matchNumber=1, previousMatch=null;
    if(manual) {
      const tr=await client.query('SELECT id,group_count AS "groupCount" FROM tournaments WHERE id=$1 FOR UPDATE',[tournamentId]);
      if(!tr.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Tournoi introuvable.'});}
      const all=(await client.query(`SELECT id,group_name AS "groupName",created_at AS "createdAt" FROM tournament_teams WHERE tournament_id=$1 ORDER BY created_at,id`,[tournamentId])).rows;
      const ts=all.filter(t=>[homeTeamId,awayTeamId].includes(t.id));
      if(ts.length!==2){await client.query('ROLLBACK');return res.status(400).json({error:'Les deux équipes doivent être inscrites à ce tournoi.'});}
      const assignedGroups=tournamentGroups(all,tr.rows[0].groupCount);
      const homeGroup=assignedGroups.find(g=>g.teams.some(t=>t.id===homeTeamId));
      const awayGroup=assignedGroups.find(g=>g.teams.some(t=>t.id===awayTeamId));
      if(!homeGroup||!awayGroup||homeGroup.name!==awayGroup.name){await client.query('ROLLBACK');return res.status(400).json({error:'Les résultats de poule doivent concerner deux équipes du même groupe.'});}
      groupName=homeGroup.name;
      const existing=await client.query(`SELECT id,phase,home_team_id AS "homeTeamId",away_team_id AS "awayTeamId",round_number AS "roundNumber",match_number AS "matchNumber" FROM tournament_matches WHERE tournament_id=$1 AND phase='group' AND ((home_team_id=$2 AND away_team_id=$3) OR (home_team_id=$3 AND away_team_id=$2)) ORDER BY CASE WHEN status='scheduled' THEN 0 ELSE 1 END,created_at LIMIT 1 FOR UPDATE`,[tournamentId,homeTeamId,awayTeamId]);
      if(existing.rowCount){const old=existing.rows[0];matchId=old.id;roundNumber=Number(old.roundNumber||1);matchNumber=Number(old.matchNumber||1);if(old.homeTeamId===awayTeamId){[n.homeGoals,n.awayGoals]=[n.awayGoals,n.homeGoals];[n.homeYellow,n.awayYellow]=[n.awayYellow,n.homeYellow];[n.homeRed,n.awayRed]=[n.awayRed,n.homeRed];scorers=scorers.map(x=>({...x,side:x.side==='home'?'away':'home'}));}}
      else matchId=`match-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    } else {
      const existing=await client.query(`SELECT id,phase,group_name AS "groupName",home_team_id AS "homeTeamId",away_team_id AS "awayTeamId",round_number AS "roundNumber",match_number AS "matchNumber",status,home_goals AS "homeGoals",away_goals AS "awayGoals",home_penalties AS "homePenalties",away_penalties AS "awayPenalties" FROM tournament_matches WHERE tournament_id=$1 AND id=$2 FOR UPDATE`,[tournamentId,matchId]);
      if(!existing.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Match introuvable. Actualise la page.'});}
      const m=existing.rows[0]; previousMatch=m; phase=m.phase;groupName=m.groupName;homeId=m.homeTeamId;awayId=m.awayTeamId;roundNumber=Number(m.roundNumber||1);matchNumber=Number(m.matchNumber||1);if(m.status==='bye'){await client.query('ROLLBACK');return res.status(400).json({error:'Cette équipe est déjà qualifiée automatiquement. Aucun score à saisir pour ce passage.'});}if(!homeId||!awayId){await client.query('ROLLBACK');return res.status(400).json({error:'Les deux équipes de ce match ne sont pas encore déterminées.'});}
    }
    if(phase==='group'){const koStarted=await client.query("SELECT 1 FROM tournament_matches WHERE tournament_id=$1 AND phase='knockout' AND status='finished' LIMIT 1",[tournamentId]);if(koStarted.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'La phase éliminatoire a déjà commencé. Les résultats de poule sont verrouillés pour préserver le tableau.'});}}
    if(phase==='knockout' && n.homeGoals===n.awayGoals && (body.homePenalties==null || body.homePenalties==='' || body.awayPenalties==null || body.awayPenalties==='' || penalties.home===penalties.away)) {
      await client.query('ROLLBACK'); return res.status(400).json({error:'En phase éliminatoire, il faut un vainqueur. Si le score est nul, saisis deux scores de tirs au but différents.'});
    }
    const hp=body.homePenalties==null||body.homePenalties===''?null:penalties.home, ap=body.awayPenalties==null||body.awayPenalties===''?null:penalties.away;
    if (!manual && phase==='knockout' && previousMatch && previousMatch.status==='finished') {
      const oldWinner = Number(previousMatch.homeGoals)>Number(previousMatch.awayGoals) ? homeId : Number(previousMatch.awayGoals)>Number(previousMatch.homeGoals) ? awayId : (Number(previousMatch.homePenalties)>Number(previousMatch.awayPenalties) ? homeId : Number(previousMatch.awayPenalties)>Number(previousMatch.homePenalties) ? awayId : null);
      const newWinner = n.homeGoals>n.awayGoals ? homeId : n.awayGoals>n.homeGoals ? awayId : (penalties.home>penalties.away ? homeId : penalties.away>penalties.home ? awayId : null);
      if (oldWinner && newWinner && oldWinner!==newWinner) {
        const laterFinished=await client.query("SELECT 1 FROM tournament_matches WHERE tournament_id=$1 AND phase='knockout' AND round_number>$2 AND status='finished' LIMIT 1",[tournamentId,roundNumber]);
        if(laterFinished.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'Le vainqueur changerait un tour déjà terminé. Corrige d’abord les résultats des tours suivants, puis réenregistre ce match.'});}
      }
    }
    if(manual) {
      await client.query(`INSERT INTO tournament_matches(id,tournament_id,group_name,home_team_id,away_team_id,match_date,match_time,home_goals,away_goals,home_yellow,home_red,away_yellow,away_red,status,phase,round_name,round_number,match_number,scorers)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'finished','group',$3,$14,$15,$16::jsonb)
        ON CONFLICT(id) DO UPDATE SET match_date=EXCLUDED.match_date,match_time=EXCLUDED.match_time,home_goals=EXCLUDED.home_goals,away_goals=EXCLUDED.away_goals,home_yellow=EXCLUDED.home_yellow,home_red=EXCLUDED.home_red,away_yellow=EXCLUDED.away_yellow,away_red=EXCLUDED.away_red,scorers=EXCLUDED.scorers,status='finished'`,[matchId,tournamentId,groupName,homeTeamId,awayTeamId,date,time,n.homeGoals,n.awayGoals,n.homeYellow,n.homeRed,n.awayYellow,n.awayRed,roundNumber,matchNumber,JSON.stringify(scorers)]);
    } else {
      await client.query(`UPDATE tournament_matches SET home_goals=$3,away_goals=$4,home_yellow=$5,home_red=$6,away_yellow=$7,away_red=$8,home_penalties=$9,away_penalties=$10,scorers=$11::jsonb,status='finished' WHERE tournament_id=$1 AND id=$2`,[tournamentId,matchId,n.homeGoals,n.awayGoals,n.homeYellow,n.homeRed,n.awayYellow,n.awayRed,hp,ap,JSON.stringify(scorers)]);
    }
    const scorerTeams = await client.query('SELECT id,team_name AS name FROM tournament_teams WHERE id = ANY($1::text[])', [[homeId,awayId].filter(Boolean)]);
    const scorerTeamNames = Object.fromEntries(scorerTeams.rows.map(row=>[row.id,row.name]));
    scorers = scorers.map(x=>({...x,teamName:scorerTeamNames[x.side==='home'?homeId:awayId] || ''}));
    if(phase==='knockout') {
      const winnerId=n.homeGoals>n.awayGoals?homeId:n.awayGoals>n.homeGoals?awayId:(penalties.home>penalties.away?homeId:awayId);
      const matchRow={phase,roundNumber,matchNumber};
      await advanceWinner(client,tournamentId,matchRow,winnerId);
    } else {
      await maybeRefreshKnockout(client,tournamentId);
    }
    await client.query('COMMIT');
    res.set('Cache-Control','no-store').status(manual?201:200).json({ok:true,message:phase==='group'?'Résultat enregistré. Classement actualisé automatiquement.':'Résultat enregistré. Le vainqueur est envoyé au tour suivant.',match:{id:matchId,status:'finished'}});
  } catch(error) { try{await client.query('ROLLBACK')}catch(_){} dbError(res,error,'Impossible d’enregistrer le résultat. Aucune modification n’a été confirmée.'); }
  finally { client.release(); }
}
app.patch('/api/admin/tournaments/:id/matches/:matchId/result',adminAuth,(req,res)=>saveMatchResult(req,res,false));
app.post('/api/admin/tournaments/:id/results',adminAuth,(req,res)=>saveMatchResult(req,res,true));
app.patch('/api/admin/tournaments/:id/matches/:matchId/schedule',adminAuth,async(req,res)=>{const date=req.body?.matchDate?String(req.body.matchDate):null,time=req.body?.matchTime?String(req.body.matchTime):null;if((date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))||(time&&!/^\d{2}:\d{2}$/.test(time)))return res.status(400).json({error:'Date ou heure invalide.'});try{const r=await pool.query('UPDATE tournament_matches SET match_date=$3,match_time=$4 WHERE tournament_id=$1 AND id=$2 RETURNING id',[String(req.params.id),String(req.params.matchId),date,time]);if(!r.rowCount)return res.status(404).json({error:'Match introuvable.'});res.json({ok:true});}catch(error){dbError(res,error,'Impossible de modifier le calendrier.');}});
app.delete('/api/admin/tournaments/:id/matches/:matchId',adminAuth,async(req,res)=>{try{const r=await pool.query("DELETE FROM tournament_matches WHERE tournament_id=$1 AND id=$2 AND phase='group' AND round_name NOT LIKE 'Phase de groupes%' RETURNING id",[String(req.params.id),String(req.params.matchId)]);if(!r.rowCount)return res.status(404).json({error:'Match introuvable ou protégé par le calendrier automatique.'});res.json({ok:true});}catch(error){dbError(res,error,'Impossible de supprimer le match.');}});


/*
 * Interface d'administration.
 */
app.get(["/admin", "/admin/"], (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(appHtml, "admin.html"));
});
app.get(["/tournois", "/tournois/"], (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(appHtml, "tournaments.html"));
});
app.get(["/admin/tournois", "/admin/tournois/"], (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(appHtml, "admin-tournaments.html"));
});

/*
 * Autres pages du site.
 */
app.get("*", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(appHtml, "index.html"));
});

/*
 * Démarrage.
 */
async function startServer() {
  try {
    await initDatabase();
    await closeExpiredTournamentRegistrations();
    const registrationCloser = setInterval(() => closeExpiredTournamentRegistrations().catch(error => console.error('Échec de fermeture automatique des inscriptions :', error.message)), 30000);
    if (typeof registrationCloser.unref === 'function') registrationCloser.unref();

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
