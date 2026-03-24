require('dotenv').config();
const twilio = require('twilio');

const runCheck = async () => {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    // Replace with the specific SID returned during the test
    const sid = 'MMca62c5ba4ba8d99a9fb8fdbb3108bd2d'; 
    
    try {
        const message = await client.messages(sid).fetch();
        console.log('--- Twilio Message Status ---');
        console.log('Status:', message.status);
        console.log('Error Code:', message.errorCode);
        console.log('Error Message:', message.errorMessage);
        console.log('To:', message.to);
    } catch (e) {
        console.error('Error fetching message:', e.message);
    }
};

runCheck();
