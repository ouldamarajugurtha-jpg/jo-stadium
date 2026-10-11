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

  // Tournois : tables ajoutées sans toucher aux réservations existantes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tournament_date DATE,
      description TEXT NOT NULL DEFAULT '',
      max_teams INTEGER NOT NULL CHECK (max_teams BETWEEN 4 AND 48),
      best_thirds BOOLEAN NOT NULL DEFAULT FALSE,
      group_count INTEGER NOT NULL CHECK (group_count BETWEEN 2 AND 12),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (group_count <= max_teams)
    )
  `);
  await pool.query(`ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_max_teams_check`);
  await pool.query(`ALTER TABLE tournaments ADD CONSTRAINT tournaments_max_teams_check CHECK (max_teams BETWEEN 4 AND 48)`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS best_thirds BOOLEAN NOT NULL DEFAULT FALSE`);
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
  await pool.query(`CREATE INDEX IF NOT EXISTS tournament_teams_tournament_idx ON tournament_teams (tournament_id, created_at)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS tournament_team_name_unique ON tournament_teams (tournament_id, LOWER(team_name))`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_matches (
      id TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      group_name TEXT NOT NULL,
      home_team_id TEXT NOT NULL REFERENCES tournament_teams(id) ON DELETE CASCADE,
      away_team_id TEXT NOT NULL REFERENCES tournament_teams(id) ON DELETE CASCADE,
      match_date DATE, match_time TEXT,
      home_score INTEGER, away_score INTEGER,
      home_yellow INTEGER NOT NULL DEFAULT 0, away_yellow INTEGER NOT NULL DEFAULT 0,
      home_red INTEGER NOT NULL DEFAULT 0, away_red INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','played')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (home_team_id <> away_team_id),
      CHECK (home_score IS NULL OR home_score >= 0),
      CHECK (away_score IS NULL OR away_score >= 0),
      CHECK (home_yellow >= 0 AND away_yellow >= 0 AND home_red >= 0 AND away_red >= 0)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS tournament_matches_tournament_idx ON tournament_matches(tournament_id, group_name, match_date)`);

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
function tournamentGroups(teams, groupCount) {
  const groups = Array.from({ length: Number(groupCount) }, (_, i) => ({
    name: `Groupe ${String.fromCharCode(65 + i)}`,
    teams: []
  }));
  teams.forEach((team, index) => groups[index % groups.length].teams.push(team));
  return groups;
}

app.get("/api/tournaments", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.id, t.name, t.tournament_date AS "tournamentDate", t.description,
             t.max_teams AS "maxTeams", t.group_count AS "groupCount", t.best_thirds AS "bestThirds", t.status,
             t.created_at AS "createdAt", COUNT(tt.id)::int AS "registeredTeams"
      FROM tournaments t LEFT JOIN tournament_teams tt ON tt.tournament_id = t.id
      WHERE t.status = 'open' OR EXISTS (SELECT 1 FROM tournament_matches tm WHERE tm.tournament_id=t.id)
      GROUP BY t.id ORDER BY t.created_at DESC
    `);
    res.set("Cache-Control", "no-store");
    res.json({ tournaments: result.rows });
  } catch (error) { dbError(res, error, "Impossible de charger les tournois."); }
});

app.post("/api/tournaments/:id/register", async (req, res) => {
  const teamName = String(req.body?.teamName || "").trim();
  const captainName = String(req.body?.captainName || "").trim();
  const phone = String(req.body?.phone || "").trim();
  if (teamName.length < 2 || teamName.length > 80 || captainName.length < 2 || captainName.length > 100 || phone.length < 6 || phone.length > 30) {
    return res.status(400).json({ error: "Renseigne le nom de l’équipe, le responsable et un téléphone valide." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tr = await client.query("SELECT * FROM tournaments WHERE id = $1 FOR UPDATE", [String(req.params.id)]);
    if (!tr.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Tournoi introuvable." }); }
    const tournament = tr.rows[0];
    if (tournament.status !== "open") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Les inscriptions à ce tournoi sont fermées." }); }
    const count = await client.query("SELECT COUNT(*)::int AS n FROM tournament_teams WHERE tournament_id = $1", [tournament.id]);
    if (count.rows[0].n >= tournament.max_teams) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Ce tournoi est complet." }); }
    const duplicate = await client.query("SELECT 1 FROM tournament_teams WHERE tournament_id = $1 AND LOWER(team_name) = LOWER($2)", [tournament.id, teamName]);
    if (duplicate.rowCount) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Cette équipe est déjà inscrite à ce tournoi." }); }
    const id = `team-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const ticketCode = `JOT-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now().toString().slice(-6)}`;
    const inserted = await client.query(`
      INSERT INTO tournament_teams (id, tournament_id, team_name, captain_name, phone, ticket_code, payment_status)
      VALUES ($1,$2,$3,$4,$5,$6,'on_site')
      RETURNING id, team_name AS "teamName", captain_name AS "captainName", phone, ticket_code AS "ticketCode", payment_status AS "paymentStatus", created_at AS "createdAt"
    `, [id, tournament.id, teamName, captainName, phone, ticketCode]);
    await client.query("COMMIT");
    res.status(201).json({ ok: true, tournament: { id: tournament.id, name: tournament.name }, team: inserted.rows[0], paymentMessage: "Ticket d’inscription créé. Frais à régler sur place." });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    if (error.code === "23505") return res.status(409).json({ error: "Cette équipe est déjà inscrite à ce tournoi." });
    dbError(res, error, "Impossible d’inscrire cette équipe.");
  } finally { client.release(); }
});

app.get("/api/admin/tournaments", adminAuth, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.id, t.name, t.tournament_date AS "tournamentDate", t.description,
             t.max_teams AS "maxTeams", t.group_count AS "groupCount", t.best_thirds AS "bestThirds", t.status,
             t.created_at AS "createdAt", COUNT(tt.id)::int AS "registeredTeams"
      FROM tournaments t LEFT JOIN tournament_teams tt ON tt.tournament_id = t.id
      GROUP BY t.id ORDER BY t.created_at DESC
    `);
    const tournaments = [];
    for (const t of result.rows) {
      const teams = await pool.query(`SELECT id, team_name AS "teamName", captain_name AS "captainName", phone, ticket_code AS "ticketCode", payment_status AS "paymentStatus", created_at AS "createdAt" FROM tournament_teams WHERE tournament_id = $1 ORDER BY created_at ASC`, [t.id]);
      tournaments.push({ ...t, groups: tournamentGroups(teams.rows, t.groupCount) });
    }
    res.json({ tournaments });
  } catch (error) { dbError(res, error, "Impossible de charger les tournois administrateur."); }
});

app.post("/api/admin/tournaments", adminAuth, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const description = String(req.body?.description || "").trim().slice(0, 500);
  const maxTeams = Number(req.body?.maxTeams);
  const groupCount = Number(req.body?.groupCount);
  const tournamentDate = req.body?.tournamentDate ? String(req.body.tournamentDate) : null;
  const bestThirds = req.body?.bestThirds === true;
  if (name.length < 2 || name.length > 100 || !Number.isInteger(maxTeams) || maxTeams < 4 || maxTeams > 48 || !Number.isInteger(groupCount) || groupCount < 2 || groupCount > 12 || groupCount > maxTeams || (tournamentDate && !/^\d{4}-\d{2}-\d{2}$/.test(tournamentDate))) {
    return res.status(400).json({ error: "Vérifie le nom, la date, le nombre d’équipes (4 à 48) et le nombre de groupes (2 à 12, sans dépasser le nombre d’équipes)." });
  }
  try {
    const id = `tour-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const result = await pool.query(`INSERT INTO tournaments (id,name,tournament_date,description,max_teams,group_count,best_thirds,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'open') RETURNING id,name,tournament_date AS "tournamentDate",description,max_teams AS "maxTeams",group_count AS "groupCount",best_thirds AS "bestThirds",status,created_at AS "createdAt"`, [id,name,tournamentDate,description,maxTeams,groupCount,bestThirds]);
    res.status(201).json({ tournament: { ...result.rows[0], registeredTeams: 0, groups: tournamentGroups([], groupCount) } });
  } catch (error) { dbError(res, error, "Impossible de créer le tournoi."); }
});


async function tournamentDetails(tournamentId) {
  const tr = await pool.query(`SELECT id,name,tournament_date AS "tournamentDate",description,max_teams AS "maxTeams",group_count AS "groupCount",best_thirds AS "bestThirds",status FROM tournaments WHERE id=$1`, [tournamentId]);
  if (!tr.rowCount) return null;
  const teamsRes = await pool.query(`SELECT id,team_name AS "teamName",captain_name AS "captainName",ticket_code AS "ticketCode" FROM tournament_teams WHERE tournament_id=$1 ORDER BY created_at,id`, [tournamentId]);
  const groups = tournamentGroups(teamsRes.rows, tr.rows[0].groupCount);
  const matchesRes = await pool.query(`
    SELECT m.id,m.group_name AS "groupName",m.match_date AS "matchDate",m.match_time AS "matchTime",
      m.home_score AS "homeScore",m.away_score AS "awayScore",m.home_yellow AS "homeYellow",
      m.away_yellow AS "awayYellow",m.home_red AS "homeRed",m.away_red AS "awayRed",m.status,
      h.team_name AS "homeTeam",a.team_name AS "awayTeam",m.home_team_id AS "homeTeamId",m.away_team_id AS "awayTeamId"
    FROM tournament_matches m JOIN tournament_teams h ON h.id=m.home_team_id JOIN tournament_teams a ON a.id=m.away_team_id
    WHERE m.tournament_id=$1 ORDER BY m.group_name,m.match_date NULLS LAST,m.match_time NULLS LAST,m.created_at`, [tournamentId]);
  const matches = matchesRes.rows;
  const standings = groups.map(g => {
    const rows = g.teams.map(team => ({id:team.id,teamName:team.teamName,played:0,wins:0,draws:0,losses:0,goalsFor:0,goalsAgainst:0,goalDifference:0,points:0,yellow:0,red:0}));
    const byId = new Map(rows.map(r=>[r.id,r]));
    for (const m of matches.filter(x=>x.groupName===g.name && x.status==='played' && x.homeScore!==null && x.awayScore!==null)) {
      const h=byId.get(m.homeTeamId), a=byId.get(m.awayTeamId); if(!h||!a) continue;
      h.played++;a.played++;h.goalsFor+=m.homeScore;h.goalsAgainst+=m.awayScore;a.goalsFor+=m.awayScore;a.goalsAgainst+=m.homeScore;
      h.yellow+=m.homeYellow;a.yellow+=m.awayYellow;h.red+=m.homeRed;a.red+=m.awayRed;
      if(m.homeScore>m.awayScore){h.wins++;h.points+=3;a.losses++}else if(m.homeScore<m.awayScore){a.wins++;a.points+=3;h.losses++}else{h.draws++;a.draws++;h.points++;a.points++}
    }
    rows.forEach(r=>r.goalDifference=r.goalsFor-r.goalsAgainst);
    rows.sort((a,b)=>b.points-a.points||b.goalDifference-a.goalDifference||b.goalsFor-a.goalsFor||a.red-b.red||a.yellow-b.yellow||a.teamName.localeCompare(b.teamName));
    rows.forEach((r,i)=>r.position=i+1);
    return {name:g.name,teams:g.teams,standings:rows};
  });
  const thirdPlaces=standings.map(g=>g.standings[2]).filter(Boolean).sort((a,b)=>b.points-a.points||b.goalDifference-a.goalDifference||b.goalsFor-a.goalsFor||a.red-b.red||a.yellow-b.yellow);
  const qualifiers = standings.flatMap(g=>g.standings.slice(0,2)).concat(tr.rows[0].bestThirds?thirdPlaces.slice(0,Math.max(0,Math.min(8,32-standings.reduce((n,g)=>n+Math.min(2,g.standings.length),0)))):[]);
  return {...tr.rows[0],registeredTeams:teamsRes.rowCount,groups:standings,matches,bestThirdsRanking:thirdPlaces,qualifiers};
}

app.get("/api/tournaments/:id/details", async (req,res)=>{
  try { const data=await tournamentDetails(String(req.params.id)); if(!data)return res.status(404).json({error:"Tournoi introuvable."}); res.set("Cache-Control","no-store"); res.json({tournament:data}); }
  catch(error){ dbError(res,error,"Impossible de charger les résultats du tournoi."); }
});

app.post("/api/admin/tournaments/:id/generate-calendar", adminAuth, async (req,res)=>{
  const tournamentId=String(req.params.id);
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const t=await client.query("SELECT id,group_count FROM tournaments WHERE id=$1 FOR UPDATE",[tournamentId]);
    if(!t.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Tournoi introuvable."});}
    const existing=await client.query("SELECT COUNT(*)::int AS n FROM tournament_matches WHERE tournament_id=$1",[tournamentId]);
    if(existing.rows[0].n){await client.query("ROLLBACK");return res.status(409).json({error:"Le calendrier existe déjà. Modifie les matchs existants plutôt que de le régénérer."});}
    const teams=await client.query("SELECT id FROM tournament_teams WHERE tournament_id=$1 ORDER BY created_at,id",[tournamentId]);
    const groups=tournamentGroups(teams.rows,t.rows[0].group_count);
    let n=0;
    for(const g of groups){
      for(let i=0;i<g.teams.length;i++)for(let j=i+1;j<g.teams.length;j++){
        const id=`match-${Date.now()}-${(++n).toString(36)}-${Math.random().toString(36).slice(2,6)}`;
        await client.query(`INSERT INTO tournament_matches(id,tournament_id,group_name,home_team_id,away_team_id) VALUES($1,$2,$3,$4,$5)`,[id,tournamentId,g.name,g.teams[i].id,g.teams[j].id]);
      }
    }
    await client.query("COMMIT"); res.json({ok:true,matchCount:n});
  }catch(error){try{await client.query("ROLLBACK")}catch(_){} dbError(res,error,"Impossible de générer le calendrier.");}
  finally{client.release();}
});

app.patch("/api/admin/tournaments/:id/matches/:matchId", adminAuth, async(req,res)=>{
  const date=req.body?.matchDate ? String(req.body.matchDate):null;
  const time=req.body?.matchTime ? String(req.body.matchTime):null;
  const hs=req.body?.homeScore===''||req.body?.homeScore==null?null:Number(req.body.homeScore);
  const as=req.body?.awayScore===''||req.body?.awayScore==null?null:Number(req.body.awayScore);
  const nums=['homeYellow','awayYellow','homeRed','awayRed'];
  const cards={}; for(const k of nums){cards[k]=Number(req.body?.[k]||0);if(!Number.isInteger(cards[k])||cards[k]<0||cards[k]>99)return res.status(400).json({error:"Nombre de cartons invalide."});}
  if((hs!==null&&(!Number.isInteger(hs)||hs<0||hs>99))||(as!==null&&(!Number.isInteger(as)||as<0||as>99)))return res.status(400).json({error:"Score invalide."});
  if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({error:"Date invalide."});
  if(time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))return res.status(400).json({error:"Heure invalide."});
  try{
    const result=await pool.query(`UPDATE tournament_matches SET match_date=$3,match_time=$4,home_score=$5,away_score=$6,home_yellow=$7,away_yellow=$8,home_red=$9,away_red=$10,status=CASE WHEN $5 IS NOT NULL AND $6 IS NOT NULL THEN 'played' ELSE 'scheduled' END WHERE id=$1 AND tournament_id=$2 RETURNING id`,[String(req.params.matchId),String(req.params.id),date,time,hs,as,cards.homeYellow,cards.awayYellow,cards.homeRed,cards.awayRed]);
    if(!result.rowCount)return res.status(404).json({error:"Match introuvable."});res.json({ok:true});
  }catch(error){dbError(res,error,"Impossible d'enregistrer le match.");}
});


app.patch("/api/admin/tournaments/:id/status", adminAuth, async (req, res) => {
  const status = String(req.body?.status || "");
  if (!['open','closed'].includes(status)) return res.status(400).json({ error: "Statut invalide." });
  try {
    const result = await pool.query(`UPDATE tournaments SET status=$2 WHERE id=$1 RETURNING id,status`, [String(req.params.id), status]);
    if (!result.rowCount) return res.status(404).json({ error: "Tournoi introuvable." });
    res.json({ ok: true, tournament: result.rows[0] });
  } catch (error) { dbError(res, error, "Impossible de modifier le tournoi."); }
});

app.delete("/api/admin/tournaments/:id", adminAuth, async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM tournaments WHERE id=$1 RETURNING id", [String(req.params.id)]);
    if (!result.rowCount) return res.status(404).json({ error: "Tournoi introuvable." });
    res.json({ ok: true });
  } catch (error) { dbError(res, error, "Impossible de supprimer le tournoi."); }
});

/*
 * Interface d'administration.
 */
app.get(["/admin", "/admin/"], (_req, res) => {
  res.sendFile(path.join(appHtml, "admin.html"));
});
app.get(["/tournois", "/tournois/"], (_req, res) => {
  res.sendFile(path.join(appHtml, "tournaments.html"));
});
app.get(["/admin/tournois", "/admin/tournois/"], (_req, res) => {
  res.sendFile(path.join(appHtml, "admin-tournaments.html"));
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
