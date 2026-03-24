#!/usr/bin/env node
/**
 * register-webhook.js
 *
 * Usage:
 *   node register-webhook.js https://api.mbktechnologies.info
 *
 * This registers your public backend URL as the Stream Chat webhook.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const apiKey = process.env.STREAM_CHAT_API_KEY;
const apiSecret = process.env.STREAM_CHAT_API_SECRET;
const publicBaseUrl = process.argv[2];

if (!publicBaseUrl) {
  console.error('Usage: node register-webhook.js https://your-public-backend-domain');
  process.exit(1);
}

if (!apiKey || !apiSecret) {
  console.error('STREAM_CHAT_API_KEY and STREAM_CHAT_API_SECRET must be set in .env');
  process.exit(1);
}

const webhookUrl = `${publicBaseUrl.replace(/\/$/, '')}/api/chat/webhook`;
console.log(`\nRegistering webhook: ${webhookUrl}`);

async function register() {
  try {
    const { StreamChat } = require('stream-chat');
    const client = StreamChat.getInstance(apiKey, apiSecret);

    await client.updateAppSettings({
      webhook_url: webhookUrl,
    });

    console.log('Webhook registered successfully.');
    console.log(`URL set to: ${webhookUrl}`);
    console.log('\nNext steps:');
    console.log('1. Keep your backend running.');
    console.log('2. Ensure this URL is publicly reachable over HTTPS.');
    console.log('3. Verify in Stream Dashboard > Settings > Webhooks.\n');
  } catch (err) {
    console.error('Failed to register webhook via SDK:', err.message);
    console.log('\nManual steps:');
    console.log('1. Go to: https://dashboard.getstream.io/');
    console.log('2. Open your app > Settings > Webhooks');
    console.log(`3. Set webhook URL to: ${webhookUrl}`);
    console.log('4. Save and test.\n');
  }
}

register();
