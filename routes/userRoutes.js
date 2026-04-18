const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const {
    sendVerificationEmail,
    sendTrainerDocumentReminderEmail
} = require('../utils/emailService');
// const admin = require('../config/firebaseAdmin'); // Removed Firebase
const { authenticate } = require('../middleware/auth');
const { REQUIRED_TRAINER_DOCUMENTS } = require('../utils/trainerDocumentWorkflow');
const {
    autoCreateTrainerAdminChannels,
    cleanupDeletedUserChatArtifacts,
} = require('../services/streamChatService');

// Verify Password (for sensitive actions like delete)
router.post('/verify-password', authenticate, async (req, res) => {
    try {
        const { password } = req.body;
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid password' });
        }

        res.json({ success: true, message: 'Password verified' });
    } catch (error) {
        console.error('Password verification error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get all users (for admin panel)
router.get('/', async (req, res) => {
    try {
        const users = await User.find({})
            .select('id name email role isActive emailVerified plainPassword createdAt updatedAt');

        res.json({
            success: true,
            users
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch users'
        });
    }
});

// Get pending trainers (Super Admin only)
router.get('/pending', authenticate, async (req, res) => {
    try {
        if (req.user.role !== 'SuperAdmin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const pendingUsers = await User.find({
            role: 'Trainer',
            accountStatus: 'pending'
        }).select('name email role createdAt accountStatus');

        res.json({ success: true, users: pendingUsers });
    } catch (error) {
        console.error('[ERROR] GET /users/pending failed:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

router.post('/:id/document-reminder', authenticate, async (req, res) => {
    try {
        if (req.user.role !== 'SuperAdmin') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const user = await User.findById(req.params.id).select('name email role');
        if (!user || user.role !== 'Trainer') {
            return res.status(404).json({ success: false, message: 'Trainer user not found' });
        }

        await sendTrainerDocumentReminderEmail({
            trainerEmail: user.email,
            trainerName: user.name,
            missingDocuments: REQUIRED_TRAINER_DOCUMENTS.map((item) => item.label),
            loginUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/trainer/profile`
        });

        res.json({
            success: true,
            message: 'Document reminder email sent successfully'
        });
    } catch (error) {
        console.error('Error sending pending user document reminder:', error);
        res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
});

// Get rejected users
router.get('/rejected', authenticate, async (req, res) => {
    try {
        const users = await User.find({ accountStatus: 'rejected' })
            .select('name email role createdAt');
        res.json({ success: true, users });
    } catch (error) {
        console.error('Error fetching rejected users:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Bulk Approve All Pending
router.put('/approve-all', authenticate, async (req, res) => {
    try {
        const result = await User.updateMany(
            { accountStatus: 'pending' },
            { $set: { accountStatus: 'active', isActive: true } }
        );

        res.json({
            success: true,
            message: `Approved ${result.modifiedCount} users successfully`,
            count: result.modifiedCount
        });
    } catch (error) {
        console.error('Error approving all users:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get single user by ID
router.get('/:id', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('-password');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        res.json({ success: true, user });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});



// Create new user (Super Admin creating Trainer/SPOC accounts)
router.post('/', authenticate, async (req, res) => {
    try {
        const { name, email, role } = req.body;
        const requesterRole = req.user.role;

        // Validate required fields
        if (!name || !email || !role) {
            return res.status(400).json({
                success: false,
                message: 'Name, email, and role are required'
            });
        }

        // Enforce Role Hierarchy
        if (requesterRole === 'SuperAdmin') {
            // SuperAdmin can create SPOCAdmin, Trainer, and other SuperAdmins
            if (!['SPOCAdmin', 'Trainer', 'SuperAdmin', 'AccouNDAnt', 'Company'].includes(role)) {
                return res.status(403).json({
                    success: false,
                    message: 'Super Admin can only create valid roles (SPOC, Trainer, AccouNDAnt, Company, SuperAdmin).'
                });
            }
        } else if (requesterRole === 'SPOCAdmin' || requesterRole === 'CollegeAdmin') {
            // SPOCAdmin (or CollegeAdmin) can ONLY create Trainers
            if (role !== 'Trainer') {
                return res.status(403).json({
                    success: false,
                    message: 'SPOC Admin can only create Trainers.'
                });
            }
        } else {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to create users.'
            });
        }

        // Check if email already exists in MongoDB
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'Email already exists'
            });
        }

        // Use provided password or generate random
        const passwordToUse = req.body.password || crypto.randomBytes(16).toString('hex');

        // Generate verification token
        const verificationToken = crypto.randomBytes(32).toString('hex');



        // Firebase creation logic removed. Using MongoDB only.
        const firebaseUid = 'legacy_removed_' + Date.now(); // Placeholder if schema requires it

        // Create user in MongoDB
        const user = await User.create({
            name,
            email,
            role,
            role,
            password: passwordToUse,
            plainPassword: passwordToUse, // Store visible password
            firebaseUid: firebaseUid, // Save Firebase UID
            emailVerificationToken: verificationToken,
            emailVerificationToken: verificationToken,
            emailVerified: req.body.emailVerified !== undefined ? req.body.emailVerified : false,
            isActive: true,
            isActive: true,
            createdBy: req.user.id // Track who created this user
        });

        // Send invitation email
        try {
            // In a real app, this link would point to the frontend URL
            // For this environment, we'll log it clearly
            const inviteLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-account?token=${verificationToken}`;
            await sendVerificationEmail(email, name, verificationToken);
            console.log(`INVITATION LINK for ${email}: ${inviteLink}`);
        } catch (emailError) {
            console.error('Failed to send verification email:', emailError);
        }

        res.status(201).json({
            success: true,
            message: 'User created successfully in Firebase and Database.',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                firebaseUid: user.firebaseUid,
                emailVerified: user.emailVerified,
                isActive: user.isActive
            }
        });

        // 🔥 Auto-create Chat Channel if a Trainer is created by an Admin
        if (role === 'Trainer') {
            try {
                const adminUser = await User.findById(req.user.id);
                if (adminUser) {
                    await autoCreateTrainerAdminChannels(user, [adminUser]);
                }
            } catch (chatErr) {
                console.error('Failed to auto-create Stream Chat channel on Trainer creation:', chatErr);
            }
        }
    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create user: ' + error.message
        });
    }
});



// Approve user
router.put('/:id/approve', authenticate, async (req, res) => {
    try {
        if (req.user.role !== 'SuperAdmin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        user.accountStatus = 'active';
        user.isActive = true;
        await user.save();

        // If user is a Trainer, ensure a Trainer profile exists
        if (user.role === 'Trainer') {
            const Trainer = require('../models/Trainer');
            const existingTrainer = await Trainer.findOne({ userId: user._id });

            if (!existingTrainer) {
                await Trainer.create({
                    userId: user._id,
                    verificationStatus: 'VERIFIED', // Set to verified on approval
                    // trainerId will be auto-generated by Mongoose pre-save hook or default
                });
                console.log(`[INFO] Auto-created Trainer profile for approved user: ${user.email}`);
            } else {
                existingTrainer.verificationStatus = 'VERIFIED';
                await existingTrainer.save();
            }
        }

        res.json({ success: true, message: 'User approved successfully' });

        // Notification logic (Async)
        try {
            if (user.role === 'Trainer') {
                const { sendTrainerApprovalEmail } = require('../utils/emailService');
                const loginUrl = `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/login`;
                await sendTrainerApprovalEmail(user.email, user.name, loginUrl);
            }
        } catch (notifyError) {
            console.error('Failed to notify trainer of approval:', notifyError);
        }

        // 🔥 Auto-create Chat Channels with SuperAdmins on Approval
        if (user.role === 'Trainer') {
            try {
                const superAdmins = await User.find({ role: 'SuperAdmin', isActive: true });
                if (superAdmins.length > 0) {
                    await autoCreateTrainerAdminChannels(user, superAdmins);
                }
            } catch (chatErr) {
                console.error('Failed to auto-create Stream Chat channels on Trainer approval:', chatErr);
            }
        }
    } catch (error) {
        console.error('Error approving user:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Reject user
router.put('/:id/reject', authenticate, async (req, res) => {
    try {
        if (req.user.role !== 'SuperAdmin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        user.accountStatus = 'rejected';
        user.isActive = false;
        await user.save();

        // Sync status to Trainer profile
        if (user.role === 'Trainer') {
            const Trainer = require('../models/Trainer');
            await Trainer.findOneAndUpdate({ userId: user._id }, { verificationStatus: 'REJECTED' });
        }

        res.json({ success: true, message: 'User rejected successfully' });
    } catch (error) {
        console.error('Error rejecting user:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Update user
router.put('/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`[DEBUG] Received PUT update for User ID: ${id}`);
        console.log(`[DEBUG] Update Payload:`, req.body);
        const { name, email, role, isActive, emailVerified, otpEnabled, phoneNumber, city, specialization } = req.body;

        const user = await User.findById(id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Check email uniqueness if changing email
        if (email && email !== user.email) {
            const existingUser = await User.findOne({ email });
            if (existingUser) {
                return res.status(400).json({
                    success: false,
                    message: 'Email already exists'
                });
            }
        }

        // Update user
        user.name = name || user.name;
        user.email = email || user.email;
        if (role) user.role = role;
        if (isActive !== undefined) user.isActive = isActive;
        if (emailVerified !== undefined) user.emailVerified = emailVerified;
        if (otpEnabled !== undefined) user.otpEnabled = otpEnabled;
        if (city !== undefined) user.city = city;
        if (specialization !== undefined) user.specialization = specialization;

        // Check phone uniqueness if changing phone
        if (phoneNumber && phoneNumber !== user.phoneNumber) {
             const existingUser = await User.findOne({ phoneNumber });
             if (existingUser && existingUser.id !== id) {
                 return res.status(400).json({ 
                     success: false, 
                     message: `Phone Number is already in use by another account (${existingUser.name})` 
                 });
             }
             user.phoneNumber = phoneNumber;
        }

        // Update password if provided
        if (req.body.password) {
            user.password = req.body.password; // Model pre-save hook will hash this
            user.plainPassword = req.body.password; // Store visible password
        }

        await user.save();

        // If this is a Trainer completing their profile for the first time, mark it
        // Changed logic: Lock profile after ANY save if it wasn't locked before.
        if (user.role === 'Trainer' && !user.profileCompletedOnce) {
            user.profileCompletedOnce = true;
            await user.save();
        }

        res.json({
            success: true,
            message: 'User updated successfully',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                isActive: user.isActive,
                emailVerified: user.emailVerified,
                otpEnabled: user.otpEnabled,
                city: user.city,
                phoneNumber: user.phoneNumber,
                specialization: user.specialization,
                profileCompletedOnce: user.profileCompletedOnce
            }
        });
    } catch (error) {
        // DETAILED DEBUG LOGGING TO FILE
        const fs = require('fs');
        const logData = `
timestamp: ${new Date().toISOString()}
error: ${error.message}
stack: ${error.stack}
body: ${JSON.stringify(req.body, null, 2)}
params: ${JSON.stringify(req.params, null, 2)}
----------------------------------------
`;
        try { fs.appendFileSync('debug_put_error.log', logData); } catch (e) { console.error('Log write failed', e); }

        console.error('CRITICAL ERROR in PUT /users/:id:', error);

        // Handle Duplicate Key Error (E11000)
        if (error.code === 11000 || error.code === '11000' || error.message.includes('E11000')) {
            let field = 'Field';
            if (error.keyPattern) {
                field = Object.keys(error.keyPattern)[0];
            } else if (error.message.includes('phoneNumber')) {
                field = 'phoneNumber';
            } else if (error.message.includes('email')) {
                field = 'email';
            }

            return res.status(400).json({
                success: false,
                message: `${field === 'phoneNumber' ? 'Phone Number' : field} is already in use by another account.`
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to update user: ' + error.message
        });
    }
});

// Toggle active status
router.put('/:id/toggle-status', authenticate, async (req, res) => {
    try {
        if (req.user.role !== 'SuperAdmin') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        user.isActive = !user.isActive;
        await user.save();

        res.json({
            success: true,
            message: `Account ${user.isActive ? 'activated' : 'deactivated'} successfully`,
            isActive: user.isActive
        });
    } catch (error) {
        console.error('Error toggling status:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Delete user
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const user = await User.findById(id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        try {
            await cleanupDeletedUserChatArtifacts(user);
        } catch (chatCleanupError) {
            console.warn('User chat cleanup failed during delete:', chatCleanupError.message);
        }

        // Cascading deletion
        if (user.role === 'Trainer') {
            try {
                const Trainer = require('../models/Trainer');
                const deleteResult = await Trainer.findOneAndDelete({ userId: user._id });
                if (deleteResult) {
                    console.log(`[INFO] Deleted associated Trainer profile for user: ${user.email}`);
                }
            } catch (cascadeError) {
                console.error('Error deleting associated Trainer profile:', cascadeError);
                // Continue with user deletion even if trainer deletion fails (or maybe specific error handling needed?)
                // For now, we log and proceed to ensure the User account is at least removed.
            }
        }

        await user.deleteOne();

        res.json({
            success: true,
            message: 'User and associated data deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete user'
        });
    }
});

module.exports = router;

