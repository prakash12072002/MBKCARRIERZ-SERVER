const express = require('express');
const router = express.Router();
const { Company, User, Otp, CompanyArchive } = require('../models');
const { authenticate } = require('../middleware/auth');
const { upload } = require('../config/cloudinary');
const crypto = require('crypto');
const { sendMail, sendCompanyAdminWelcomeEmail } = require('../utils/emailService');
const { cascadeDeleteCompanyHierarchy } = require('../services/hierarchyDeleteService');
const isCompanyAdminRole = (role) => ['CompanyAdmin', 'companyadmin'].includes(String(role || ''));

// @route   POST /api/companies/send-otp
// @desc    Generate OTP and send to Company Admin Email
// @access  Super Admin
router.post('/send-otp', authenticate, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ message: 'Admin email is required' });
        }

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now

        // Upsert OTP in DB (replaces any existing OTP for this email, auto-deletes at expiresAt)
        await Otp.findOneAndUpdate(
            { email },
            { otp, purpose: 'company_admin_verify', expiresAt, verified: false },
            { upsert: true, new: true }
        );

        // Send OTP email
        await sendMail(
            email,
            '🔐 Company Admin Verification OTP — MBK CarrierZ',
            `Your OTP for Company Admin account creation is: ${otp}\n\nThis OTP is valid for 5 minutes. Do not share it with anyone.`
        );

        console.log(`[COMPANY-OTP] OTP sent to ${email}: ${otp}`);
        res.json({ success: true, message: `OTP sent to ${email}` });
    } catch (error) {
        console.error('Error sending company OTP:', error);
        res.status(500).json({ message: 'Failed to send OTP', error: error.message });
    }
});

// @route   GET /api/companies
// @desc    Get all companies
// @access  Super Admin
router.get('/', authenticate, async (req, res) => {
    try {
        const companies = await Company.find({})
            .sort({ createdAt: -1 });
        res.json(companies);
    } catch (error) {
        console.error('Error fetching companies:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   GET /api/companies/:id
// @desc    Get company by ID
// @access  Super Admin
router.get('/:id', authenticate, async (req, res) => {
    try {
        const company = await Company.findById(req.params.id);
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }
        res.json(company);
    } catch (error) {
        console.error('Error fetching company:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   POST /api/companies
// @desc    Create a new company with logo and user account (requires OTP verification)
// @access  Super Admin
router.post('/', authenticate, upload.single('logo'), async (req, res) => {
    try {
        const { adminName, adminEmail: email } = req.body;

        console.log('Creating company invite for:', { adminName, email });

        // ── OTP Must Already Be Verified ───────────────────────────────────────
        const otpRecord = await Otp.findOne({
            email,
            purpose: 'company_admin_verify',
            verified: true
        });

        if (!otpRecord) {
            return res.status(400).json({
                message: 'Email not verified. Please verify OTP first.'
            });
        }

        // Clean up verified OTP record
        await Otp.deleteOne({ _id: otpRecord._id });
        // ──────────────────────────────────────────────────────────────────────

        // Allow one user to manage many companies; block only if email belongs to non-company-admin profile.
        const existingUser = await User.findOne({ email });
        if (existingUser && !isCompanyAdminRole(existingUser.role)) {
            return res.status(400).json({ message: 'Email is already used by a non-company-admin account' });
        }

        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationLink = `${process.env.FRONTEND_URL || 'http://localhost:5174'}/verify-account?token=${verificationToken}`;
        const inferredName = adminName || (email ? String(email).split('@')[0] : 'Company Admin');

        const userPayload = {
            name: inferredName,
            email,
            role: 'CompanyAdmin',
            companyId: null,
            emailVerified: false,
            isEmailVerified: false,
            emailVerificationToken: verificationToken,
            verificationToken: verificationToken,
            accountStatus: 'pending',
            isActive: true
        };

        // Create or extend user account for company admin
        let user = existingUser;
        if (!user) {
            user = await User.create(userPayload);
        } else {
            user.name = adminName || user.name;
            user.emailVerified = false;
            user.isEmailVerified = false;
            user.emailVerificationToken = verificationToken;
            user.verificationToken = verificationToken;
            user.accountStatus = 'pending';
            user.isActive = true;
            user.password = undefined;
            user.plainPassword = undefined;
            await user.save();
        }

        // Send onboarding invite email. Do not fail creation if email delivery fails.
        try {
            await sendCompanyAdminWelcomeEmail({
                adminEmail: email,
                companyName: 'Pending Setup',
                adminName: inferredName,
                phone: 'To be provided during onboarding',
                address: 'To be provided during onboarding',
                logoUrl: null,
                verificationLink
            });
        } catch (emailError) {
            console.error('Failed to send company onboarding invite email:', emailError);
        }

        console.log('Company admin invite created:', user.email);
        res.status(201).json({
            success: true,
            message: 'Company onboarding invite created successfully',
            inviteLink: verificationLink
        });
    } catch (error) {
        console.error('Error creating company invite:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// @route   GET /api/companies/:id/archive
// @desc    Get company change history archive
// @access  Super Admin
router.get('/:id/archive', authenticate, async (req, res) => {
    try {
        const archives = await CompanyArchive.find({ companyId: req.params.id })
            .sort({ createdAt: -1 });
        res.json(archives);
    } catch (error) {
        console.error('Error fetching company archive:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   PUT /api/companies/:code
// @desc    Update a company by companyCode (authorized company admin email only)
// @access  Authenticated (restricted by admin email match)
router.put('/:code', authenticate, upload.single('logo'), async (req, res) => {
    try {
        const codeParam = String(req.params.code || '');
        const code = codeParam.toUpperCase();
        const requesterEmail = String(req.user?.email || '').toLowerCase();
        if (!requesterEmail) {
            return res.status(401).json({ message: 'Authentication required' });
        }

        let company = await Company.findOne({ companyCode: code });
        // Backward-compatible fallback for legacy clients that still send ObjectId in path
        if (!company && /^[a-fA-F0-9]{24}$/.test(codeParam)) {
            company = await Company.findById(codeParam);
        }
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }

        // Only original admin email can update this company
        let adminUser = null;
        if (company.adminId) {
            adminUser = await User.findById(company.adminId).select('email');
        } else if (company.userId) {
            adminUser = await User.findById(company.userId).select('email');
        }
        if (!adminUser) {
            return res.status(403).json({ message: 'No admin account linked for this company' });
        }
        if (String(adminUser.email || '').toLowerCase() !== requesterEmail) {
            return res.status(403).json({
                message: 'You are not authorized to update this company'
            });
        }

        const previousData = company.toObject();
        
        // Only update mutable company fields
        const validFields = ['name', 'adminName', 'phone', 'address', 'status'];
        const updateData = {};
        validFields.forEach(field => {
            if (req.body[field] !== undefined) {
                updateData[field] = req.body[field];
            }
        });

        Object.assign(company, updateData);
        
        // Update logo if a new file is uploaded
        if (req.file) {
            company.logo = req.file.path; // Cloudinary URL
        } else if (req.body.logo) {
            // Preserve existing logo URL if passed in body and no new file uploaded
            company.logo = req.body.logo;
        }
        
        await company.save();

        await CompanyArchive.create({
            companyId: company._id,
            companyCode: company.companyCode,
            name: previousData.name || null,
            phone: previousData.phone || null,
            address: previousData.address || null,
            logo: previousData.logo || null,
            adminEmail: previousData.email || null,
            email: company.email,
            changeType: 'UPDATE',
            previousData,
            changedBy: req.user?._id || null
        });

        res.json(company);
    } catch (error) {
        console.error('Error updating company:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   DELETE /api/companies/:code
// @desc    Permanent delete active company after archiving history snapshot
// @access  Super Admin
router.delete('/:code', authenticate, async (req, res) => {
    try {
        const codeParam = String(req.params.code || '');
        const code = codeParam.toUpperCase();

        let company = await Company.findOne({ companyCode: code }).populate('adminId', 'email');
        // Backward-compatible fallback for legacy callers that pass _id
        if (!company && /^[a-fA-F0-9]{24}$/.test(codeParam)) {
            company = await Company.findById(codeParam).populate('adminId', 'email');
        }

        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }

        const adminEmail = company.adminId?.email || company.email || null;

        // 1) Save immutable history before delete
        await CompanyArchive.create({
            companyId: company._id,
            companyCode: company.companyCode || 'UNKNOWN',
            name: company.name || null,
            phone: company.phone || null,
            address: company.address || null,
            logo: company.logo || null,
            adminEmail,
            deletedAt: new Date(),
            email: adminEmail,
            changeType: 'DELETE',
            previousData: company.toObject(),
            changedBy: req.user?._id || null
        });

        // 2) Delete hierarchy under company (courses, colleges, departments, days/schedules, etc.)
        await cascadeDeleteCompanyHierarchy(company._id);

        // 3) Delete active company
        await company.deleteOne();
        res.json({ success: true, message: 'Company and related hierarchy deleted permanently' });
    } catch (error) {
        console.error('Error deleting company:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   POST /api/companies/:id/create-admin
// @desc    Create company admin login for existing company
// @access  Super Admin
router.post('/:id/create-admin', authenticate, async (req, res) => {
    try {
        const { adminName, email } = req.body;
        const companyId = req.params.id;

        // Check if company exists
        const company = await Company.findById(companyId);
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }

        // Allow one user to manage many companies; block only if email belongs to non-company-admin profile.
        const existingUser = await User.findOne({ email });
        if (existingUser && !isCompanyAdminRole(existingUser.role)) {
            return res.status(400).json({ message: 'Email is already used by a non-company-admin account' });
        }

        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationLink = `${process.env.FRONTEND_URL || 'http://localhost:5174'}/verify-account?token=${verificationToken}`;

        const userPayload = {
            name: adminName,
            email,
            role: 'CompanyAdmin', // Company admin role for portal access
            companyId: company._id,
            companyCode: company.companyCode || null,
            emailVerified: false,
            isEmailVerified: false,
            emailVerificationToken: verificationToken,
            verificationToken: verificationToken,
            accountStatus: 'pending',
            isActive: true
        };

        // Create user account for company admin (or attach existing admin to another company)
        let user = existingUser;
        if (!user) {
            user = await User.create({
                ...userPayload,
                companyIds: [company._id],
                companyCodes: [company.companyCode].filter(Boolean)
            });
        } else {
            user.name = adminName || user.name;
            if (!user.companyId) user.companyId = company._id;
            if (!user.companyCode) user.companyCode = company.companyCode || null;
            user.companyIds = [...new Set([...(user.companyIds || []).map(String), String(company._id)])];
            user.companyCodes = [...new Set([...(user.companyCodes || []), String(company.companyCode || '').toUpperCase()].filter(Boolean))];
            user.emailVerified = false;
            user.isEmailVerified = false;
            user.emailVerificationToken = verificationToken;
            user.verificationToken = verificationToken;
            user.accountStatus = 'pending';
            user.isActive = true;
            user.password = undefined;
            user.plainPassword = undefined;
            await user.save();
        }

        // Update company with userId
        company.userId = user._id;
        company.adminId = user._id;
        await company.save();

        try {
            await sendCompanyAdminWelcomeEmail({
                adminEmail: email,
                companyName: company.name,
                adminName,
                phone: company.phone,
                address: company.address,
                logoUrl: company.logo || null,
                verificationLink
            });
        } catch (emailError) {
            console.error('Failed to send company welcome email (create-admin):', emailError);
        }

        res.status(201).json({
            success: true,
            message: 'Company admin account created successfully',
            inviteLink: verificationLink,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Error creating company admin:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

module.exports = router;

