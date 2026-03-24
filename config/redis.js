const Redis = require("ioredis");

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNREFUSED",
]);

let isRedisConnected = false;
let reconnectAttempt = 0;
let fallbackLogShown = false;
let lastErrorFingerprint = null;
let lastErrorAt = 0;

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1, // Fail fast if no Redis
  connectTimeout: 10000,
  retryStrategy: (times) => {
    reconnectAttempt = times;
    isRedisConnected = false;

    if (!fallbackLogShown) {
      console.warn("[Redis] Unavailable, using in-memory fallback until reconnect.");
      fallbackLogShown = true;
    }

    // Exponential backoff up to 30s. Keep retrying for transient network issues.
    return Math.min(250 * (2 ** Math.min(times, 8)), 30000);
  },
  reconnectOnError: (err) => err?.code === "ECONNRESET",
  enableOfflineQueue: false,
});

redis.on("ready", () => {
  const wasDisconnected = !isRedisConnected || reconnectAttempt > 0;
  isRedisConnected = true;
  reconnectAttempt = 0;
  fallbackLogShown = false;

  if (wasDisconnected) {
    console.log("[Redis] Connected");
  } else {
    console.log("[Redis] Ready");
  }
});

redis.on("error", (err) => {
  const code = err?.code || "UNKNOWN";
  const message = err?.message || "Unknown Redis error";
  const fingerprint = `${code}:${message}`;
  const now = Date.now();
  const isDuplicate = fingerprint === lastErrorFingerprint && (now - lastErrorAt) < 10000;

  if (isDuplicate) {
    return;
  }

  lastErrorFingerprint = fingerprint;
  lastErrorAt = now;

  if (TRANSIENT_ERROR_CODES.has(code)) {
    console.warn(`[Redis] Transient error [${code}]: ${message}`);
    return;
  }

  console.error(`[Redis] Error [${code}]: ${message}`);
});

redis.on("close", () => {
  if (isRedisConnected) {
    console.warn("[Redis] Connection closed, using in-memory fallback.");
  }
  isRedisConnected = false;
});

redis.on("end", () => {
  isRedisConnected = false;
});

module.exports = {
  redis,
  getRedisClient: () => redis,
  isAvailable: () => isRedisConnected,
};
