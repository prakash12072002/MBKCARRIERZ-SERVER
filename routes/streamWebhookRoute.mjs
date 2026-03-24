import express from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { publishEvent } = require('../services/eventBusService.js');
const { StreamChat } = require('stream-chat');

const router = express.Router();
const apiKey = process.env.STREAM_CHAT_API_KEY;
const apiSecret = process.env.STREAM_CHAT_API_SECRET;

const client = StreamChat.getInstance(apiKey, apiSecret);

/**
 * 🚀 STREAM WEBHOOK RECEIVER
 * Receives POST events from Stream Chat and pushes them to Redis Pub/Sub
 */
router.post('/stream', (req, res) => {
    try {
        const signature = req.headers['x-signature'];
        const rawBody = JSON.stringify(req.body);

        // Security Check: Verify signature from Stream
        if (!signature || !client.verifyWebhook(rawBody, signature)) {
            console.warn('[Webhook] Invalid Stream Signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        const eventPayload = req.body;
        const type = eventPayload.type; // e.g. 'message.new', 'user.online'

        // Map important events
        if (type) {
            publishEvent('chat_events', {
                type: type,
                payload: eventPayload,
                timestamp: new Date().toISOString()
            });
            console.log(`[Webhook] Published event: ${type}`);
        }

        // Always return 200 so Stream doesn't retry
        res.status(200).json({ received: true });

    } catch (err) {
        console.error('[Webhook] Processing Error:', err);
        // It's still a 200 to prevent retries if it's our processing bug
        res.status(200).json({ error: 'Internal processing error, logged.' }); 
    }
});

export default router;
