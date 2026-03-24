const { redis, isAvailable } = require("../config/redis");

const presenceCache = new Map();

const setUserOnline = async (userId) => {
  try {
    if (isAvailable()) {
      await redis.set(`online:${userId}`, "true", "EX", 60);
    } else {
      presenceCache.set(userId, true);
      setTimeout(() => presenceCache.delete(userId), 60000);
    }
  } catch (err) {
    console.warn("[Presence] error:", err.message);
  }
};

const isUserOnline = async (userId) => {
  try {
    if (isAvailable()) {
      return await redis.get(`online:${userId}`);
    } else {
      return presenceCache.has(userId) ? "true" : null;
    }
  } catch (err) {
    console.warn("[Presence] error:", err.message);
    return null;
  }
};

module.exports = {
  setUserOnline,
  isUserOnline
};
