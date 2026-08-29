const Redis = require("ioredis");

const redisUrl = process.env.REDIS_URL;
let client = null;

function getClient() {
  if (!redisUrl) return null;
  if (!client) {
    client = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
    client.on("error", (err) => {
      console.error("redis error:", err.message);
    });
  }
  return client;
}

// cacheAside: checks redis first, calls fetchFn on a miss, stores the result, returns it.
// If redis is unavailable (no REDIS_URL set, or connection error), falls straight through
// to fetchFn on every call rather than failing the request, since a slower response is
// always better than a broken one.
async function cacheAside(key, ttlSeconds, fetchFn) {
  const redis = getClient();
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached !== null) {
        return { data: JSON.parse(cached), source: "cache" };
      }
    } catch (e) {
      console.error("redis get failed, falling through:", e.message);
    }
  }

  const fresh = await fetchFn();

  if (redis) {
    try {
      await redis.set(key, JSON.stringify(fresh), "EX", ttlSeconds);
    } catch (e) {
      console.error("redis set failed, continuing without caching:", e.message);
    }
  }

  return { data: fresh, source: "live" };
}

// for the magazine archive specifically, which needs to accumulate and dedupe rather than
// just expire, this reads the existing stored set, merges, prunes, and writes it back.
async function accumulateSet(key, newItems, idField, maxAgeSeconds) {
  const redis = getClient();
  let existing = [];
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) existing = JSON.parse(raw);
    } catch (e) {
      console.error("redis get failed for accumulate, starting fresh:", e.message);
    }
  }
  const byId = {};
  existing.forEach((item) => { byId[item[idField]] = item; });
  newItems.forEach((item) => { byId[item[idField]] = item; });
  const cutoff = Date.now() / 1000 - maxAgeSeconds;
  const merged = Object.values(byId).filter((item) => item.timestamp >= cutoff);
  merged.sort((a, b) => b.timestamp - a.timestamp);

  if (redis) {
    try {
      await redis.set(key, JSON.stringify(merged), "EX", maxAgeSeconds);
    } catch (e) {
      console.error("redis set failed for accumulate:", e.message);
    }
  }
  return merged;
}

module.exports = { cacheAside, accumulateSet, getClient };
