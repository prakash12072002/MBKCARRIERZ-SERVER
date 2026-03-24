const express = require('express');
const router = express.Router();
const { TrainerAttendance, Trainer, User } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');

// Mark Trainer Attendance (HR View)
router.post('/', authenticate, authorize(['SuperAdmin', 'SPOCAdmin']), async (req, res) => {
    try {
        const { trainerId, date, status, remarks } = req.body;

        // Find existing or create new
        let attendance = await TrainerAttendance.findOne({ trainerId, date });

        if (attendance) {
            // Update existing
            attendance.status = status;
            attendance.remarks = remarks;
            attendance.markedBy = req.user.id;
            await attendance.save();
        } else {
            // Create new
            attendance = await TrainerAttendance.create({
                trainerId,
                date,
                status,
                remarks,
                markedBy: req.user.id
            });
        }

        res.json({ success: true, message: 'Trainer attendance marked', attendance });
    } catch (error) {
        console.error('Error marking trainer attendance:', error);
        res.status(500).json({ success: false, message: 'Error marking attendance' });
    }
});

// Get Trainer Attendance History
router.get('/:trainerId', authenticate, async (req, res) => {
    try {
        const attendance = await TrainerAttendance.find({ trainerId: req.params.trainerId })
            .populate('markedBy', 'id name')
            .sort({ date: -1 });
        res.json({ success: true, attendance });
    } catch (error) {
        console.error('Error fetching trainer attendance:', error);
        res.status(500).json({ success: false, message: 'Error fetching attendance' });
    }
});

module.exports = router;
