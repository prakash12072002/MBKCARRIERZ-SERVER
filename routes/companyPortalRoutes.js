const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireCompanyAdmin, companyViewOnly } = require('../middleware/companyAuthMiddleware');
const Schedule = require('../models/Schedule');
const Trainer = require('../models/Trainer');
const Course = require('../models/Course');
const College = require('../models/College');
const Company = require('../models/Company');
const TrainerAttendance = require('../models/TrainerAttendance');

// GET /api/company-portal/today-monitoring
// Returns today's trainer assignments with real-time status
router.get('/today-monitoring', async (req, res) => {
    try {
        const companyId = req.user.companyId;
        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID not found' });
        }

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(todayStart);
        todayEnd.setHours(23, 59, 59, 999);

        // Find schedules for today for this company
        const schedules = await Schedule.find({
            companyId,
            scheduledDate: { $gte: todayStart, $lte: todayEnd },
            isActive: true
        })
        .populate('trainerId', 'name email phone')
        .populate('collegeId', 'name address location')
        .populate('courseId', 'name code')
        .sort({ 'collegeId.name': 1 });

        // Get attendance record for these schedules to get check-in/out times
        const scheduleIds = schedules.map(s => s._id);
        const attendanceRecords = await TrainerAttendance.find({
            scheduleId: { $in: scheduleIds }
        });

        // Format the monitoring data
        const monitoringData = schedules.map(schedule => {
            const attendance = attendanceRecords.find(
                a => a.scheduleId.toString() === schedule._id.toString()
            );

            return {
                id: schedule._id,
                trainer: {
                    name: schedule.trainerId?.name || 'Unassigned',
                    phone: schedule.trainerId?.phone || 'N/A'
                },
                college: {
                    name: schedule.collegeId?.name || 'N/A',
                    location: schedule.collegeId?.location || schedule.collegeId?.address || 'N/A'
                },
                course: schedule.courseId?.name || 'N/A',
                status: schedule.status, // This usually comes from schedule.status or attendance.status
                attendanceStatus: attendance?.status || 'Not Started',
                checkIn: attendance?.checkInTime || null,
                checkOut: attendance?.checkOutTime || null,
                sessionTime: `${schedule.startTime || ''} - ${schedule.endTime || ''}`.trim() || 'Not Set'
            };
        });

        res.json({
            success: true,
            data: monitoringData,
            count: monitoringData.length
        });
    } catch (error) {
        console.error('Monitoring error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch monitoring data', error: error.message });
    }
});

// Apply authentication and view-only middleware to all routes
router.use(authenticate);
router.use(requireCompanyAdmin);
router.use(companyViewOnly);

// GET /api/company-portal/dashboard - Dashboard metrics
router.get('/dashboard', async (req, res) => {
    try {
        const companyId = req.user.companyId;

        if (!companyId) {
            return res.status(400).json({
                success: false,
                message: 'Company ID not found for this user'
            });
        }

        // Get all colleges for this company
        const colleges = await College.find({ companyId }).select('_id');
        const collegeIds = colleges.map(c => c._id);

        // Get all schedules for these colleges
        const totalSessions = await Schedule.countDocuments({
            collegeId: { $in: collegeIds },
            isActive: true
        });

        const completedSessions = await Schedule.countDocuments({
            collegeId: { $in: collegeIds },
            status: { $in: ['completed', 'COMPLETED'] },
            isActive: true
        });

        const pendingSessions = await Schedule.countDocuments({
            collegeId: { $in: collegeIds },
            status: { $in: ['scheduled', 'ASSIGNED', 'inprogress', 'IN_PROGRESS'] },
            isActive: true
        });

        // Get unique trainers
        const uniqueTrainers = await Schedule.distinct('trainerId', {
            collegeId: { $in: collegeIds },
            trainerId: { $ne: null },
            isActive: true
        });

        // Get unique courses
        const uniqueCourses = await Schedule.distinct('courseId', {
            collegeId: { $in: collegeIds },
            courseId: { $ne: null },
            isActive: true
        });

        // Get monthly statistics (last 6 months)
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        const monthlyStats = await Schedule.aggregate([
            {
                $match: {
                    collegeId: { $in: collegeIds },
                    scheduledDate: { $gte: sixMonthsAgo },
                    isActive: true
                }
            },
            {
                $group: {
                    _id: {
                        year: { $year: '$scheduledDate' },
                        month: { $month: '$scheduledDate' }
                    },
                    total: { $sum: 1 },
                    completed: {
                        $sum: {
                            $cond: [
                                { $in: ['$status', ['completed', 'COMPLETED']] },
                                1,
                                0
                            ]
                        }
                    }
                }
            },
            {
                $sort: { '_id.year': 1, '_id.month': 1 }
            }
        ]);

        res.json({
            success: true,
            data: {
                totalSessions,
                completedSessions,
                pendingSessions,
                activeTrainers: uniqueTrainers.length,
                activeCourses: uniqueCourses.length,
                totalColleges: colleges.length,
                monthlyStats
            }
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch dashboard data',
            error: error.message
        });
    }
});

// GET /api/company-portal/training-sessions - List all training sessions
router.get('/training-sessions', async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const {
            page = 1,
            limit = 10,
            search = '',
            courseId,
            collegeId,
            trainerId,
            status,
            startDate,
            endDate
        } = req.query;

        if (!companyId) {
            return res.status(400).json({
                success: false,
                message: 'Company ID not found for this user'
            });
        }

        // Get all colleges for this company
        const colleges = await College.find({ companyId }).select('_id');
        const collegeIds = colleges.map(c => c._id);

        // Build query
        const query = {
            collegeId: { $in: collegeIds },
            isActive: true
        };

        // Apply filters
        if (courseId) query.courseId = courseId;
        if (collegeId) query.collegeId = collegeId;
        if (trainerId) query.trainerId = trainerId;
        if (status) query.status = status;

        if (startDate || endDate) {
            query.scheduledDate = {};
            if (startDate) query.scheduledDate.$gte = new Date(startDate);
            if (endDate) query.scheduledDate.$lte = new Date(endDate);
        }

        // Get total count
        const total = await Schedule.countDocuments(query);

        // Get paginated results
        const sessions = await Schedule.find(query)
            .populate('trainerId', 'name email phone')
            .populate('courseId', 'name code duration')
            .populate('collegeId', 'name address')
            .populate('companyId', 'name')
            .sort({ scheduledDate: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        res.json({
            success: true,
            data: sessions,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Training sessions error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch training sessions',
            error: error.message
        });
    }
});

// GET /api/company-portal/workflow-reports - Workflow reports
router.get('/workflow-reports', async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const {
            page = 1,
            limit = 10,
            trainerId,
            courseId,
            startDate,
            endDate
        } = req.query;

        if (!companyId) {
            return res.status(400).json({
                success: false,
                message: 'Company ID not found for this user'
            });
        }

        // Get all colleges for this company
        const colleges = await College.find({ companyId }).select('_id');
        const collegeIds = colleges.map(c => c._id);

        // Build query for schedules
        const scheduleQuery = {
            collegeId: { $in: collegeIds },
            isActive: true
        };

        if (trainerId) scheduleQuery.trainerId = trainerId;
        if (courseId) scheduleQuery.courseId = courseId;

        if (startDate || endDate) {
            scheduleQuery.scheduledDate = {};
            if (startDate) scheduleQuery.scheduledDate.$gte = new Date(startDate);
            if (endDate) scheduleQuery.scheduledDate.$lte = new Date(endDate);
        }

        // Get schedules
        const schedules = await Schedule.find(scheduleQuery)
            .populate('trainerId', 'name email phone')
            .populate('courseId', 'name code')
            .populate('collegeId', 'name')
            .sort({ scheduledDate: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        // Get attendance data for these schedules
        const scheduleIds = schedules.map(s => s._id);
        const attendanceRecords = await TrainerAttendance.find({
            scheduleId: { $in: scheduleIds }
        });

        // Map attendance to schedules
        const reportsWithAttendance = schedules.map(schedule => {
            const attendance = attendanceRecords.find(
                a => a.scheduleId.toString() === schedule._id.toString()
            );

            return {
                schedule: schedule,
                attendance: attendance || null,
                checkIn: attendance?.checkInTime || null,
                checkOut: attendance?.checkOutTime || null,
                attendanceStatus: attendance?.status || 'Not Marked'
            };
        });

        const total = await Schedule.countDocuments(scheduleQuery);

        res.json({
            success: true,
            data: reportsWithAttendance,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Workflow reports error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch workflow reports',
            error: error.message
        });
    }
});

// GET /api/company-portal/download/:type - Download reports
router.get('/download/:type', async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const { type } = req.params;
        const { startDate, endDate, format = 'excel' } = req.query;

        if (!companyId) {
            return res.status(400).json({
                success: false,
                message: 'Company ID not found for this user'
            });
        }

        // Get all colleges for this company
        const colleges = await College.find({ companyId }).select('_id name');
        const collegeIds = colleges.map(c => c._id);

        let data = [];
        let filename = '';

        switch (type) {
            case 'training-sessions':
                const query = {
                    collegeId: { $in: collegeIds },
                    isActive: true
                };

                if (startDate || endDate) {
                    query.scheduledDate = {};
                    if (startDate) query.scheduledDate.$gte = new Date(startDate);
                    if (endDate) query.scheduledDate.$lte = new Date(endDate);
                }

                data = await Schedule.find(query)
                    .populate('trainerId', 'name email')
                    .populate('courseId', 'name code')
                    .populate('collegeId', 'name')
                    .sort({ scheduledDate: -1 });

                filename = `training-sessions-${Date.now()}.${format === 'pdf' ? 'pdf' : 'xlsx'}`;
                break;

            case 'workflow-report':
                // Similar to workflow-reports endpoint
                const schedules = await Schedule.find({
                    collegeId: { $in: collegeIds },
                    isActive: true
                })
                    .populate('trainerId', 'name email')
                    .populate('courseId', 'name code')
                    .populate('collegeId', 'name')
                    .sort({ scheduledDate: -1 });

                const scheduleIds = schedules.map(s => s._id);
                const attendanceRecords = await TrainerAttendance.find({
                    scheduleId: { $in: scheduleIds }
                });

                data = schedules.map(schedule => {
                    const attendance = attendanceRecords.find(
                        a => a.scheduleId.toString() === schedule._id.toString()
                    );

                    return {
                        ...schedule.toObject(),
                        checkIn: attendance?.checkInTime || 'N/A',
                        checkOut: attendance?.checkOutTime || 'N/A',
                        attendanceStatus: attendance?.status || 'Not Marked'
                    };
                });

                filename = `workflow-report-${Date.now()}.${format === 'pdf' ? 'pdf' : 'xlsx'}`;
                break;

            default:
                return res.status(400).json({
                    success: false,
                    message: 'Invalid download type'
                });
        }

        // For now, return JSON data
        // In production, you would generate Excel/PDF here
        res.json({
            success: true,
            message: 'Download data prepared',
            data,
            filename,
            note: 'Excel/PDF generation to be implemented'
        });
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to prepare download',
            error: error.message
        });
    }
});

// GET /api/company-portal/colleges - Get company's colleges
router.get('/colleges', async (req, res) => {
    try {
        const companyId = req.user.companyId;

        if (!companyId) {
            return res.status(400).json({
                success: false,
                message: 'Company ID not found for this user'
            });
        }

        const colleges = await College.find({ companyId, isActive: true })
            .select('name address phone email');

        res.json({
            success: true,
            data: colleges
        });
    } catch (error) {
        console.error('Colleges error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch colleges',
            error: error.message
        });
    }
});

// GET /api/company-portal/courses - Get courses
router.get('/courses', async (req, res) => {
    try {
        const courses = await Course.find({ isActive: true })
            .select('name code duration description');

        res.json({
            success: true,
            data: courses
        });
    } catch (error) {
        console.error('Courses error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch courses',
            error: error.message
        });
    }
});

// GET /api/company-portal/trainers - Get trainers
router.get('/trainers', async (req, res) => {
    try {
        const companyId = req.user.companyId;

        if (!companyId) {
            return res.status(400).json({
                success: false,
                message: 'Company ID not found for this user'
            });
        }

        // Get all colleges for this company
        const colleges = await College.find({ companyId }).select('_id');
        const collegeIds = colleges.map(c => c._id);

        // Get unique trainers who have taught at these colleges
        const trainerIds = await Schedule.distinct('trainerId', {
            collegeId: { $in: collegeIds },
            trainerId: { $ne: null }
        });

        const trainers = await Trainer.find({
            _id: { $in: trainerIds }
        }).select('name email phone city specialization');

        res.json({
            success: true,
            data: trainers
        });
    } catch (error) {
        console.error('Trainers error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch trainers',
            error: error.message
        });
    }
});

module.exports = router;
