const { findProjectByName, getProject, getAsanaSnapshot } = require("./asana");

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const memoryCache  = {};

/**
 * Normalize a name or GID for use as a cache key.
 */
function cacheKey(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Fetch full Asana project data and store in memory.
 * Accepts project name or numeric/string GID.
 */
async function refreshCache(projectName) {
  console.log(`[Cache] Fetching data for: "${projectName}"...`);

  // If input looks like a GID (all digits), fetch directly
  const isGid    = /^\d+$/.test(projectName.trim());
  const found    = isGid
    ? await getProject(projectName.trim())
    : await findProjectByName(projectName);

  const gid      = found.gid;
  const snapshot = await getAsanaSnapshot(gid);

  const nameKey  = cacheKey(snapshot.project.name);
  const gidKey   = String(gid);
  const entry    = { data: snapshot, expires_at: Date.now() + CACHE_TTL_MS };

  memoryCache[nameKey] = entry;
  memoryCache[gidKey]  = entry;

  console.log(`[Cache] Cached "${snapshot.project.name}" (keys: "${nameKey}", "${gidKey}")`);
  return snapshot;
}

/**
 * Get cached data for a project by name or GID.
 * Serves from memory if still fresh, otherwise re-fetches.
 */
async function getCacheForProject(projectName) {
  const key    = cacheKey(projectName);
  const cached = memoryCache[key];

  if (cached && Date.now() < cached.expires_at) {
    console.log(`[Cache] Serving "${projectName}" from memory`);
    return cached.data;
  }

  return await refreshCache(projectName);
}

module.exports = { getCacheForProject, refreshCache, cacheKey };
