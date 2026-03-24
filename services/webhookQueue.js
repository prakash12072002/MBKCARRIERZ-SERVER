const { getRedisClient } = require("../config/redis");

const pushWebhookEvent = async (event) => {
  try {
    const redis = getRedisClient();
    if (redis.status === "ready") {
      await redis.lpush("webhook_queue", JSON.stringify(event));
    }
  } catch (err) {
    console.warn("[WebhookQueue] Failed to push event to Redis:", err.message);
  }
};

module.exports = {
  pushWebhookEvent
};
