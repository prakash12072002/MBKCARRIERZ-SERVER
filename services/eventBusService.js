const { redis, isAvailable } = require("../config/redis");
const EventEmitter = require("events");

// 🚀 In-memory fallback if Redis is down
const localBus = new EventEmitter();

// Create a dedicated Redis subscriber connection ONLY if Redis is connected
let subscriber = null;

const getSubscriber = () => {
    if (!subscriber && isAvailable()) {
        subscriber = redis.duplicate();
        subscriber.on("error", (err) => console.error("❌ Redis Subscriber error:", err.message));
    }
    return subscriber;
};

/**
 * Publish an event to a specific topic
 */
const publishEvent = async (topic, payload) => {
    try {
        if (isAvailable()) {
            await redis.publish(topic, JSON.stringify(payload));
        } else {
            localBus.emit(topic, payload);
        }
    } catch (err) {
        console.error(`[EventBus] Publishing Error to ${topic}:`, err.message);
    }
};

/**
 * Subscribe to a specific topic
 */
const subscribeToEvent = async (topic, callback) => {
    try {
        const sub = getSubscriber();
        if (sub) {
            await sub.subscribe(topic);
            sub.on("message", (channel, message) => {
                if (channel === topic) {
                    try {
                        callback(JSON.parse(message));
                    } catch (err) {
                        console.error(`[EventBus] Parse error:`, err.message);
                    }
                }
            });
        } else {
            // Purely local subscription
            localBus.on(topic, callback);
        }
    } catch (err) {
        console.error(`[EventBus] Subscribe error on ${topic}:`, err.message);
    }
};

module.exports = {
    publishEvent,
    subscribeToEvent
};
