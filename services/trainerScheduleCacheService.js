const { redis, isAvailable } = require("../config/redis");

const CACHE_TTL_SEC = 120;
const INDEX_TTL_SEC = 300;

const memoryCache = new Map();
const memoryIndex = new Map();

const buildTrainerScheduleCacheKey = ({ trainerId, month, year, status }) => [
  "trainer-schedule",
  String(trainerId || "").trim() || "unknown",
  `month:${String(month || "all").trim() || "all"}`,
  `year:${String(year || "all").trim() || "all"}`,
  `status:${String(status || "all").trim().toLowerCase() || "all"}`,
].join(":");

const buildTrainerScheduleIndexKey = (trainerId) =>
  `trainer-schedule:index:${String(trainerId || "").trim()}`;

const forgetMemoryKey = (trainerId, cacheKey) => {
  memoryCache.delete(cacheKey);

  const trainerKey = String(trainerId || "").trim();
  const trainerKeys = memoryIndex.get(trainerKey);
  if (!trainerKeys) {
    return;
  }

  trainerKeys.delete(cacheKey);
  if (trainerKeys.size === 0) {
    memoryIndex.delete(trainerKey);
  }
};

const rememberMemoryKey = (trainerId, cacheKey) => {
  const trainerKey = String(trainerId || "").trim();
  if (!trainerKey) {
    return;
  }

  if (!memoryIndex.has(trainerKey)) {
    memoryIndex.set(trainerKey, new Set());
  }

  memoryIndex.get(trainerKey).add(cacheKey);
};

const getCachedTrainerScheduleResponse = async (params) => {
  try {
    const cacheKey = buildTrainerScheduleCacheKey(params);

    if (isAvailable()) {
      const cached = await redis.get(cacheKey);
      return cached ? JSON.parse(cached) : null;
    }

    const cached = memoryCache.get(cacheKey);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      forgetMemoryKey(params?.trainerId, cacheKey);
      return null;
    }

    return cached.value;
  } catch (error) {
    console.warn("[TrainerScheduleCache] Get error:", error.message);
    return null;
  }
};

const setCachedTrainerScheduleResponse = async (params, payload) => {
  try {
    const trainerId = String(params?.trainerId || "").trim();
    if (!trainerId) {
      return;
    }

    const cacheKey = buildTrainerScheduleCacheKey(params);

    if (isAvailable()) {
      const indexKey = buildTrainerScheduleIndexKey(trainerId);
      await redis
        .multi()
        .set(cacheKey, JSON.stringify(payload), "EX", CACHE_TTL_SEC)
        .sadd(indexKey, cacheKey)
        .expire(indexKey, INDEX_TTL_SEC)
        .exec();
      return;
    }

    memoryCache.set(cacheKey, {
      value: payload,
      expiresAt: Date.now() + CACHE_TTL_SEC * 1000,
    });
    rememberMemoryKey(trainerId, cacheKey);
    setTimeout(() => forgetMemoryKey(trainerId, cacheKey), CACHE_TTL_SEC * 1000);
  } catch (error) {
    console.warn("[TrainerScheduleCache] Set error:", error.message);
  }
};

const invalidateTrainerScheduleCache = async (trainerId) => {
  try {
    const normalizedTrainerId = String(trainerId || "").trim();
    if (!normalizedTrainerId) {
      return;
    }

    if (isAvailable()) {
      const indexKey = buildTrainerScheduleIndexKey(normalizedTrainerId);
      const cacheKeys = await redis.smembers(indexKey);

      if (cacheKeys.length) {
        await redis.del(...cacheKeys);
      }

      await redis.del(indexKey);
      return;
    }

    const cacheKeys = memoryIndex.get(normalizedTrainerId);
    if (!cacheKeys) {
      return;
    }

    Array.from(cacheKeys).forEach((cacheKey) => {
      forgetMemoryKey(normalizedTrainerId, cacheKey);
    });
  } catch (error) {
    console.warn("[TrainerScheduleCache] Invalidate error:", error.message);
  }
};

const invalidateTrainerScheduleCaches = async (trainerIds = []) => {
  const uniqueTrainerIds = Array.from(
    new Set(
      (Array.isArray(trainerIds) ? trainerIds : [trainerIds])
        .map((trainerId) => String(trainerId || "").trim())
        .filter(Boolean),
    ),
  );

  if (!uniqueTrainerIds.length) {
    return;
  }

  await Promise.all(
    uniqueTrainerIds.map((trainerId) => invalidateTrainerScheduleCache(trainerId)),
  );
};

module.exports = {
  getCachedTrainerScheduleResponse,
  setCachedTrainerScheduleResponse,
  invalidateTrainerScheduleCache,
  invalidateTrainerScheduleCaches,
};
