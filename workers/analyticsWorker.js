const { subscribeToEvent } = require('../services/eventBusService');
const { handleNewMessageNotification } = require('../services/notificationService');

/**
 * 🧠 ANALYTICS WORKER
 * Example background process that reacts to real-time Redis events.
 * This runs completely detached from the main API threads.
 */
const startAnalyticsWorker = () => {
    console.log('🚀 [AnalyticsWorker] Starting up...');

    subscribeToEvent('chat_events', (data) => {
        const { type, payload, timestamp } = data;

        // Example Handlers
        switch(type) {
            case 'message.new':
                console.log(`📊 [Analytics] New Message in ${payload.channel_id} from ${payload.user?.name}`);
                // Fire off push/email notifications in the background
                handleNewMessageNotification(payload);
                break;

            case 'user.online':
                console.log(`👤 [Analytics] User Online: ${payload.user?.name}`);
                break;

            case 'channel.created':
                console.log(`💬 [Analytics] New Channel Created by ${payload.channel?.created_by?.name}`);
                break;
                
            default:
                // Ignore other noise
                break;
        }
    });
};

module.exports = { startAnalyticsWorker };
