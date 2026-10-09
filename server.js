const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";
const DATA_FILE = path.join(__dirname, "data", "bookings.json");

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function readBookings() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8") || "[]");
  } catch {
    return [];
  }
}

function writeBookings(list) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

function adminAuth(req, res, next) {
  const token = req.get("x-admin-token");
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorisé." });
  }
  next();
}

function normalizeDates(dates) {
  return Array.isArray(dates)
    ? [...new Set(dates.filter(Boolean).map(String))]
    : [];
}

function validBooking(body) {
  const players
