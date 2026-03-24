const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');

// Connect to DB for the worker since it runs standalone
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Worker DB connected'))
  .catch(err => console.error('❌ Worker DB error:', err));

const { getRedisClient } = require('../config/redis');
const { setUserOnline } = require('../services/presenceService');

const processEvent = async (event) => {
  console.log("📨 Processing:", event.type);

  try {
    if (event.type === "user.presence.changed") {
      const user = event.user;
      if (user?.online) await setUserOnline(user.id);
    }
    // Add more event handlers here (e.g., message.new -> save to DB)
  } catch (err) {
    console.error("❌ Process Error:", err.message);
  }
};

const startWorker = async () => {
  console.log("🚀 Webhook Worker started");
  const redis = getRedisClient();

  // Wait for Redis to be ready
  while (redis.status !== "ready") {
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log("✅ Worker connected to Redis... Listening for events.");

  while (true) {
    try {
      const data = await redis.rpop("webhook_queue");

      if (data) {
        const event = JSON.parse(data);
        await processEvent(event);
      } else {
        await new Promise(r => setTimeout(r, 100)); // avoid CPU overload
      }
    } catch (err) {
      console.error("❌ Worker Loop Error:", err.message);
      await new Promise(r => setTimeout(r, 1000)); // backoff on error
    }
  }
};

startWorker();
