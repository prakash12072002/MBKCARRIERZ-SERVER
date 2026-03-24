const express = require('express');
const router = express.Router();
const Complaint = require('../models/Complaint');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');

const upload = require('../middleware/upload'); // Assuming upload middleware exists

const { sendComplaintNotificationEmail } = require('../utils/emailService');
const { sendNotification } = require('../services/notificationService');

const College = require('../models/College'); // Import College model

// @desc    Create a new complaint
// @route   POST /api/complaints
// @access  Private (Trainer)
router.post('/', authenticate, upload.single('attachment'), async (req, res) => {
    try {
        const { type, category, companyId, collegeId, scheduleId, subject, description, priority, isAnonymous } = req.body;
        
        let attachmentUrl = null;
        if (req.file) {
            attachmentUrl = req.file.path ? req.file.path.replace(/\\/g, '/') : null; 
        }

        // Calculate SLA
        const now = new Date();
        let slaHours = 48; // Default Medium
        if (priority === 'High') slaHours = 24;
        if (priority === 'Low') slaHours = 72;
        const slaDeadline = new Date(now.getTime() + (slaHours * 60 * 60 * 1000));

        const complaint = await Complaint.create({
            trainerId: req.user._id,
            trainerName: req.user.name, // Keep real name for internal ref, simplified logic
            variableTrainerName: isAnonymous === 'true' || isAnonymous === true ? 'Anonymous' : req.user.name, // Helper field if needed, or handle in GET
            type: type || 'Complaint',
            category: category || 'Other',
            companyId: companyId || null,
            collegeId: collegeId || null,
            scheduleId: scheduleId || null,
            subject: subject || 'No Subject',
            description: description,
            attachmentUrl: attachmentUrl,
            priority: priority || 'Medium',
            status: 'Open',
            isAnonymous: isAnonymous === 'true' || isAnonymous === true,
            slaDeadline: slaDeadline
        });

        // Fetch College Name if collegeId is provided
        let collegeName = 'N/A';
        if (collegeId) {
            try {
                const college = await College.findById(collegeId).select('name');
                if (college) collegeName = college.name;
            } catch (err) { console.error('Error fetching college for email:', err); }
        }

        // Notify Super Admins
        const superAdmins = await User.find({ role: 'SuperAdmin' });
        const displayName = (isAnonymous === 'true' || isAnonymous === true) ? 'Anonymous Trainer' : req.user.name;
        
        if (superAdmins.length > 0) {
            try {
                const io = req.app.get('io');
                for (const admin of superAdmins) {
                    await sendNotification(io, {
                        userId: admin._id,
                        role: admin.role,
                        title: `New ${type}: ${subject}`,
                        message: `${displayName} submitted a ${type}. Priority: ${priority}`,
                        type: 'Complaints',
                        link: `/complaints/${complaint._id}` 
                    });
                }
            } catch (notifyErr) {
                console.error('Socket Notify Error', notifyErr);
            }
            
            // Send Email Notification
            const adminEmails = superAdmins.map(admin => admin.email).filter(email => email);
            if (adminEmails.length > 0) {
                // Do not await to avoid blocking response
                // Do not await to avoid blocking response
                sendComplaintNotificationEmail(adminEmails, {
                    trainerName: displayName,
                    type: type || 'Complaint',
                    category: category || 'Other',
                    collegeName: collegeName,
                    subject: subject || 'No Subject',
                    priority: priority || 'Medium',
                    description: description,
                    date: new Date().toISOString().split('T')[0], // Add date
                    course: 'N/A' // Course info wasn't in original call, defaulting
                }).catch(err => console.error('Failed to send complaint email:', err));
            }
        }

        res.status(201).json({ success: true, data: complaint });
    } catch (error) {
        console.error('Error creating complaint:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// @desc    Get single complaint
// @route   GET /api/complaints/:id
// @access  Private (Admin/User)
router.get('/:id', authenticate, async (req, res) => {
    try {
        const complaint = await Complaint.findById(req.params.id)
            .populate('trainerId', 'name email phone')
            .populate('companyId', 'name')
            .populate('collegeId', 'name')
            .populate('scheduleId', 'date');

        if (!complaint) {
            return res.status(404).json({ success: false, message: 'Complaint not found' });
        }

        // RBAC Check for View
        if (req.user.role === 'Trainer' && complaint.trainerId._id.toString() !== req.user.id) {
             return res.status(403).json({ success: false, message: 'Not authorized' });
        }
        if ((req.user.role === 'SPOCAdmin' || req.user.role === 'CollegeAdmin') && 
            (!complaint.assignedTo || complaint.assignedTo.toString() !== req.user.id)) {
             return res.status(403).json({ success: false, message: 'Not authorized' });
        }
        if (req.user.role === 'AccouNDAnt' && complaint.category !== 'Payment Issue') {
             return res.status(403).json({ success: false, message: 'Not authorized' });
        }
        if (req.user.role === 'Company') {
             return res.status(403).json({ success: false, message: 'Access Denied' });
        }

        res.json({ success: true, data: complaint });
    } catch (error) {
        console.error('Error fetching complaint:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

const ActivityLog = require('../models/ActivityLog'); // Import ActivityLog

// @desc    Update complaint (Admin)
// @route   PUT /api/complaints/:id
// @access  Private (Admin)
router.put('/:id', authenticate, async (req, res) => {
    try {
        const { status, adminRemarks, internalNotes, assignedTo } = req.body;
        
        // Ensure user is admin
        if (req.user.role !== 'SuperAdmin' && req.user.role !== 'SPOCAdmin') {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }

        const complaint = await Complaint.findById(req.params.id);
        if (!complaint) {
            return res.status(404).json({ success: false, message: 'Complaint not found' });
        }

        const oldStatus = complaint.status;
        let statusChanged = false;
        let changeDetails = {};

        if (status && status !== complaint.status) {
            complaint.status = status;
            statusChanged = true;
            changeDetails.status = { from: oldStatus, to: status };
            if (status === 'Resolved' || status === 'Closed') {
                complaint.resolvedAt = new Date();
            }
        }

        if (adminRemarks !== undefined && adminRemarks !== complaint.adminRemarks) {
            changeDetails.adminRemarks = { from: complaint.adminRemarks, to: adminRemarks };
            complaint.adminRemarks = adminRemarks;
        }

        if (internalNotes !== undefined && internalNotes !== complaint.internalNotes) {
             changeDetails.internalNotes = { from: complaint.internalNotes, to: internalNotes };
             complaint.internalNotes = internalNotes;
        }
        
        if (assignedTo !== undefined) {
             // For assigning, we might want to log user names, but IDs valid for now
             changeDetails.assignedTo = assignedTo; 
             complaint.assignedTo = assignedTo;
        }

        await complaint.save();

        // AUDIT LOGGING
        if (Object.keys(changeDetails).length > 0) {
            await ActivityLog.create({
                userId: req.user._id,
                userName: req.user.name,
                role: req.user.role,
                action: 'UPDATE_COMPLAINT',
                entityType: 'Complaint',
                entityId: complaint._id,
                details: changeDetails,
                ipAddress: req.ip
            });
        }

        // Notify Trainer if status changed or remarks added
        if (statusChanged || (adminRemarks && adminRemarks !== '')) {
            // DB Notification
            try {
                const io = req.app.get('io');
                await sendNotification(io, {
                    userId: complaint.trainerId,
                    role: 'Trainer',
                    title: `Complaint Updated: ${complaint.subject}`,
                    message: `Your complaint status is now ${complaint.status}. ${adminRemarks ? `Remarks: ${adminRemarks}` : ''}`,
                    type: 'Complaints',
                    link: `/trainer/complaints`
                });
            } catch (notifyErr) {
                console.error('Socket Notify Error', notifyErr);
            }

            // Email Notification
            try {
                // Populate trainer email if not already populated (it wasn't in original findById)
                const trainer = await User.findById(complaint.trainerId).select('email name');
                if (trainer && trainer.email) {
                    const { sendComplaintStatusUpdateEmail } = require('../utils/emailService');
                    sendComplaintStatusUpdateEmail(trainer.email, trainer.name, {
                        subject: complaint.subject,
                        status: complaint.status,
                        adminRemarks: complaint.adminRemarks,
                        ticketId: complaint._id
                    }).catch(e => console.error('Failed to send status email:', e));
                }
            } catch (emailErr) {
                console.error('Error retrieving trainer for email:', emailErr);
            }
        }

        res.json({ success: true, data: complaint });
    } catch (error) {
        console.error('Error updating complaint:', error);
        res.status(500).json({ success: false, message: 'Server Error', error: error.message });
    }
});

// @desc    Get all complaints (with filters)
// @route   GET /api/complaints
// @access  Private (Admin)
router.get('/', authenticate, async (req, res) => {
    try {
        const { status, category, date, search } = req.query;
        let query = {};

        // Role-Based Access Control
        if (req.user.role === 'Trainer') {
            query.trainerId = req.user.id;
        } else if (req.user.role === 'SPOCAdmin' || req.user.role === 'CollegeAdmin') {
            // SPOC: View assigned complaints only
            query.assignedTo = req.user.id;
        } else if (req.user.role === 'AccouNDAnt') {
            // AccouNDAnt: Payment-related complaints (Read-only view handled in frontend/other routes)
            query.category = 'Payment Issue';
        } else if (req.user.role === 'Company') {
             // Company: No access
             return res.status(403).json({ success: false, message: 'Access Denied' });
        } else if (req.user.role !== 'SuperAdmin') {
             // Fallback for any other unexpected role
             return res.status(403).json({ success: false, message: 'Access Denied' });
        }

        if (status) query.status = status;
        if (category) query.category = category;
        
        if (date) {
            const startDate = new Date(date);
            const endDate = new Date(date);
            endDate.setHours(23, 59, 59, 999);
            query.createdAt = { $gte: startDate, $lte: endDate };
        }

        if (search) {
            // Check if search is a valid ObjectId (for finding by specific ID directly)
            // Or regex search on text fields
            const isObjectId = /^[0-9a-fA-F]{24}$/.test(search);
            if (isObjectId) {
                query.$or = [{ _id: search }, { trainerId: search }];
            } else {
                query.$or = [
                    { variableTrainerName: { $regex: search, $options: 'i' } }, // We need to check if we can search this way easily. 
                    // Actually, simpler to just search subject/trainerName
                    { trainerName: { $regex: search, $options: 'i' } },
                    { subject: { $regex: search, $options: 'i' } }
                ];
            }
        }

        const complaints = await Complaint.find(query)
            .populate('trainerId', 'name email')
            .populate('collegeId', 'name')
            .sort({ createdAt: -1 });

        res.json({ success: true, count: complaints.length, data: complaints });
    } catch (error) {
        console.error('Error fetching complaints:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

module.exports = router;
