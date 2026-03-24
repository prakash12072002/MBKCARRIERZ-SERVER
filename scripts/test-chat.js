const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { StreamChat } = require('stream-chat');

async function testStreamChat() {
    const apiKey = process.env.STREAM_CHAT_API_KEY;
    const apiSecret = process.env.STREAM_CHAT_API_SECRET;

    console.log('Testing Stream Chat Client Initialization...');
    console.log('API Key:', apiKey ? 'Present' : 'MISSING');
    console.log('API Secret:', apiSecret ? 'Present' : 'MISSING');

    if (!apiKey || !apiSecret) {
        console.error('Cannot test without API Key and Secret.');
        process.exit(1);
    }

    try {
        const client = StreamChat.getInstance(apiKey, apiSecret);
        
        // Test token generation (offline)
        const testUserId = 'test-user-123';
        const token = client.createToken(testUserId);
        console.log('Token generated successfully.');

        // Verify client can connect (optional, depends on if we want to hit the real API)
        // For now, just verifying the environment and basic SDK usage.
        console.log('SDK initialized correctly.');
        
    } catch (error) {
        console.error('Test Failed:', error.message);
        process.exit(1);
    }
}

testStreamChat();
