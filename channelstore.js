/**
 * channelStore.js
 *
 * Persists channel → Asana project mappings + format preference in SQLite.
 * WAL mode for safe concurrent access across multiple bot processes.
 *
 * Database: ./asana_brain.db
 */

const Database = require("better-sqlite3");
const path     = require("path");

const DB_PATH = path.join(__dirname, "asana_brain.db");
const db      = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS channel_projects (
    channel_id   TEXT PRIMARY KEY,
    project_name TEXT NOT NULL,
    project_gid  TEXT NOT NULL,
    format       TEXT NOT NULL DEFAULT 'bullets',
    connected_at TEXT NOT NULL
  )
`);

// Migrate existing installs — add format column if it doesn't exist yet
try {
  db.exec("ALTER TABLE channel_projects ADD COLUMN format TEXT NOT NULL DEFAULT 'bullets'");
  console.log("[ChannelStore] Migrated: added format column");
} catch (_) {
  // Column already exists — fine
}

console.log(`[ChannelStore] SQLite ready at ${DB_PATH}`);

const stmtGet       = db.prepare("SELECT project_name, project_gid, format FROM channel_projects WHERE channel_id = ?");
const stmtUpsert    = db.prepare(`
  INSERT INTO channel_projects (channel_id, project_name, project_gid, format, connected_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(channel_id) DO UPDATE SET
    project_name = excluded.project_name,
    project_gid  = excluded.project_gid,
    format       = excluded.format,
    connected_at = excluded.connected_at
`);
const stmtSetFormat = db.prepare("UPDATE channel_projects SET format = ? WHERE channel_id = ?");
const stmtDelete    = db.prepare("DELETE FROM channel_projects WHERE channel_id = ?");
const stmtAll       = db.prepare("SELECT * FROM channel_projects ORDER BY connected_at DESC");

/**
 * Get the full mapping for a channel.
 * Returns { projectName, projectGid, format } or null.
 */
function getChannelMapping(channelId) {
  const row = stmtGet.get(channelId);
  if (!row) return null;
  return {
    projectName: row.project_name,
    projectGid:  row.project_gid,
    format:      row.format || "bullets"
  };
}

/**
 * Shorthand — get just the project name.
 */
function getChannelProject(channelId) {
  const m = getChannelMapping(channelId);
  return m ? m.projectName : null;
}

/**
 * Get the format preference for a channel. Defaults to "bullets".
 */
function getChannelFormat(channelId) {
  const m = getChannelMapping(channelId);
  return m ? m.format : "bullets";
}

/**
 * Set the channel → Asana project mapping.
 */
function setChannelProject(channelId, projectName, projectGid) {
  const existing = getChannelMapping(channelId);
  const format   = existing?.format || "bullets";
  stmtUpsert.run(channelId, projectName, projectGid, format, new Date().toISOString());
  console.log(`[ChannelStore] ${channelId} → "${projectName}" (GID: ${projectGid})`);
}

/**
 * Update just the format preference for a channel.
 */
function setChannelFormat(channelId, format) {
  stmtSetFormat.run(format, channelId);
  console.log(`[ChannelStore] ${channelId} format → ${format}`);
}

/**
 * Remove the mapping for a channel.
 */
function clearChannelProject(channelId) {
  stmtDelete.run(channelId);
  console.log(`[ChannelStore] Cleared mapping for ${channelId}`);
}

/**
 * List all mappings (for debugging).
 */
function listAllMappings() {
  return stmtAll.all();
}

module.exports = {
  getChannelMapping,
  getChannelProject,
  getChannelFormat,
  setChannelProject,
  setChannelFormat,
  clearChannelProject,
  listAllMappings
};
