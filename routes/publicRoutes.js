const express = require('express');
const router = express.Router();
const { User, Trainer } = require('../models');
// const admin = require('../config/firebaseAdmin'); // Removed Firebase
const crypto = require('crypto');
const otpService = require('../services/otpService');

// POST /api/public/send-otp
// @desc Send OTP for phone verification
// @access Public
router.post('/send-otp', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ message: 'Phone number is required' });
        }

        await otpService.sendOtp(phone);
        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (error) {
        console.error('Send OTP error:', error);
        res.status(500).json({ message: 'Failed to send OTP' });
    }
});

// POST /api/public/verify-otp
// @desc Verify OTP
// @access Public
router.post('/verify-otp', async (req, res) => {
    try {
        const { phone, otp } = req.body;
        if (!phone || !otp) {
            return res.status(400).json({ message: 'Phone and OTP are required' });
        }

        const isValid = await otpService.verifyOtp(phone, otp);
        if (isValid) {
            res.json({ success: true, message: 'Phone verified successfully' });
        } else {
            res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }
    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({ message: 'Verification failed' });
    }
});

// POST /api/public/signup-trainer
// @desc Register a new trainer (Public)
// @access Public
router.post('/signup-trainer', async (req, res) => {
    try {
        const { name, email, password, phone } = req.body;


        if (!name || !email || !password || !phone) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        // 1. Check if user exists in MongoDB
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: 'User with this email already exists' });
        }

        // 2. Create user in Firebase - REMOVED
        const firebaseUid = 'legacy_removed_' + Date.now();
        // Firebase logic removed. Using MongoDB only.

        // 3. Create User in MongoDB
        const user = await User.create({
            name,
            email,
            password, // Pass password (will be hashed by pre-save hook)
            role: 'Trainer',
            firebaseUid,
            accountStatus: 'pending', // Explicitly pending
            isActive: true,
            emailVerified: true // Bypass email verification for now, rely on Admin Approval
        });

        // 4. Create Trainer Profile
        await Trainer.create({
            userId: user._id,
            phone,
            verificationStatus: 'pending'
        });

        res.status(201).json({
            success: true,
            message: 'Registration successful. Please wait for Admin approval.'
        });

    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

module.exports = router;
