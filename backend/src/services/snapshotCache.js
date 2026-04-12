const cache = new Map(); // key -> { data, timestamp }
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function getCachedSnapshot(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

export function setCachedSnapshot(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

export function invalidateSnapshot(key) {
  cache.delete(key);
}
