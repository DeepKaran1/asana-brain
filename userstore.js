/**
 * userStore.js
 *
 * Persists per-user preferences in SQLite.
 * Shared safely across multiple bot processes via WAL mode.
 *
 * Table: user_preferences
 *   user_id    TEXT PRIMARY KEY  — Slack user ID (e.g. "U012AB3CD")
 *   format     TEXT NOT NULL     — "bullets" | "paragraphs"
 *   updated_at TEXT NOT NULL
 */

const Database = require("better-sqlite3");
const path     = require("path");

const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "asana_brain.db")
  : path.join(__dirname, "asana_brain.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id    TEXT PRIMARY KEY,
    format     TEXT NOT NULL DEFAULT 'bullets',
    updated_at TEXT NOT NULL
  )
`);

console.log("[UserStore] Ready");

const stmtGet    = db.prepare("SELECT format FROM user_preferences WHERE user_id = ?");
const stmtUpsert = db.prepare(`
  INSERT INTO user_preferences (user_id, format, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    format     = excluded.format,
    updated_at = excluded.updated_at
`);

/**
 * Get a user's format preference.
 * Returns "bullets" (default) or "paragraphs".
 */
function getUserFormat(userId) {
  const row = stmtGet.get(userId);
  return row ? row.format : "bullets";
}

/**
 * Set a user's format preference.
 */
function setUserFormat(userId, format) {
  stmtUpsert.run(userId, format, new Date().toISOString());
  console.log(`[UserStore] ${userId} → format: ${format}`);
}

module.exports = { getUserFormat, setUserFormat };
