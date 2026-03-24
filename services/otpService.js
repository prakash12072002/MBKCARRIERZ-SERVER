const plivo = require('plivo');
const Otp = require('../models/Otp');

// Only initialize Plivo client if credentials are provided
let client = null;
if (process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN) {
    client = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);
    console.log('✅ Plivo SMS service initialized');
} else {
    console.log('⚠️  Plivo credentials not found. SMS service disabled.');
}

const generateOtp = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

const sendOtp = async (phone) => {
    const otp = generateOtp();

    // Save to DB (upsert to replace existing OTP for this phone)
    await Otp.findOneAndUpdate(
        { phone },
        { otp, createdAt: Date.now() },
        { upsert: true, new: true }
    );

    // Send via Plivo if credentials exist
    if (client && process.env.PLIVO_SOURCE_NUMBER) {
        try {
            await client.messages.create({
                src: process.env.PLIVO_SOURCE_NUMBER,
                dst: phone,
                text: `Your verification code is ${otp}`
            });
            console.log(`OTP sent to ${phone}: ${otp}`); // Log for debugging
        } catch (error) {
            console.error('Plivo Error:', error);
            // Fallback: Log OTP to console if SMS fails (for dev/testing)
            console.log(`[FALLBACK] OTP for ${phone}: ${otp}`);
        }
    } else {
        // Dev mode: Log OTP to console
        console.log(`[DEV] OTP for ${phone}: ${otp}`);
    }

    return true;
};

const verifyOtp = async (phone, code) => {
    const record = await Otp.findOne({ phone });

    if (!record) {
        return false;
    }

    if (record.otp === code) {
        // Delete OTP after successful verification
        await Otp.deleteOne({ _id: record._id });
        return true;
    }

    return false;
};

module.exports = {
    sendOtp,
    verifyOtp
};
