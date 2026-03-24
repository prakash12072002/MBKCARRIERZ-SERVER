require('dotenv').config();
const { sendWhatsApp } = require('./services/notificationService');

const runDemo = async () => {
    console.log('--- Twilio WhatsApp Demo ---');
    console.log('Using Account SID:', process.env.TWILIO_ACCOUNT_SID);
    
    const testPhone = '+919344856356'; // From user's snippet
    
    // Variables for template "Your appointment is coming up on {{1}} at {{2}}"
    const templateVariables = {
        "1": "March 5th",
        "2": "4:00 PM"
    };

    console.log(`Sending test template message to ${testPhone}...`);
    
    const result = await sendWhatsApp(testPhone, templateVariables);
    
    console.log('--- Result ---');
    console.log(JSON.stringify(result, null, 2));
    
    if (result.success) {
        console.log('✅ Demo sent successfully! Check the WhatsApp account.');
    } else {
        console.log('❌ Demo failed.');
    }
};

runDemo();
