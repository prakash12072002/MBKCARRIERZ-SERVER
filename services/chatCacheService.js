const { redis, isAvailable } = require("../config/redis");

const STALE_THRESHOLD_MS = 60 * 1000; // 1 minute
const CACHE_TTL_SEC = 600;            // 10 minutes

// 🚀 In-memory fallback if Redis is down
const memoryCache = new Map();

const getCachedChats = async (userId) => {
  try {
    const key = `chat:${userId}`;
    
    // Check Redis first if available
    if (isAvailable()) {
      const cached = await redis.get(key);
      if (cached) {
        const parsed = JSON.parse(cached);
        const isStale = (Date.now() - parsed.timestamp) > STALE_THRESHOLD_MS;
        return { data: parsed.data, isStale };
      }
    } else {
      // Fallback to local memory
      const cached = memoryCache.get(key);
      if (cached) {
        const isStale = (Date.now() - cached.timestamp) > STALE_THRESHOLD_MS;
        return { data: cached.data, isStale };
      }
    }
  } catch (err) {
    console.warn("[Cache] Get error:", err.message);
  }
  return null;
};

const setCachedChats = async (userId, data) => {
  try {
    const key = `chat:${userId}`;
    const payload = {
      timestamp: Date.now(),
      data: data
    };

    if (isAvailable()) {
      await redis.set(key, JSON.stringify(payload), "EX", CACHE_TTL_SEC);
    } else {
      memoryCache.set(key, payload);
      // Basic memory cleanup (primitive TTL)
      setTimeout(() => memoryCache.delete(key), CACHE_TTL_SEC * 1000);
    }
  } catch (err) {
    console.warn("[Cache] Set error:", err.message);
  }
};

module.exports = {
  getCachedChats,
  setCachedChats
};
