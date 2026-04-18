const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { User, Company, Trainer, College, Job, Student, Schedule, Attendance } = require('../models');

// Deprecated Super Admin module route (UI page removed)
router.all('/colleges', authenticate, authorize('SuperAdmin'), (req, res) => {
    return res.status(410).json({
        success: false,
        message: 'Colleges dashboard page has been removed.'
    });
});

// Helper function to calculate time ago
function getTimeAgo(date) {
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min${minutes > 1 ? 's' : ''} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days > 1 ? 's' : ''} ago`;
}

async function countDistinctColleges(match = {}) {
    const pipeline = [];

    if (match && Object.keys(match).length > 0) {
        pipeline.push({ $match: match });
    }

    pipeline.push(
        {
            $project: {
                companyId: 1,
                normalizedName: {
                    $toLower: {
                        $trim: { input: { $ifNull: ['$name', ''] } }
                    }
                },
            },
        },
        {
            $match: {
                normalizedName: { $ne: '' },
                companyId: { $ne: null },
            },
        },
        {
            $lookup: {
                from: 'companies',
                localField: 'companyId',
                foreignField: '_id',
                as: 'companyRef',
            },
        },
        { $match: { 'companyRef.0': { $exists: true } } },
        {
            $group: {
                _id: {
                    companyId: '$companyId',
                    name: '$normalizedName',
                },
            },
        },
        { $count: 'count' },
    );

    const result = await College.aggregate(pipeline);
    return result[0]?.count || 0;
}

// Super Admin Dashboard Stats
router.get('/super-admin', authenticate, authorize('SuperAdmin'), async (req, res) => {
    try {
        // Active Trainers Today (trainers with attendance marked today)
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Fetch Recent Trainer Activity (Last 10 activities from today and yesterday)
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const [
            totalCompanies,
            totalColleges,
            totalTrainers,
            activeTrainersToday,
            presentCount,
            absentCount,
            pendingApprovals,
            receNDAttendance,
        ] = await Promise.all([
            Company.countDocuments(),
            countDistinctColleges(),
            Trainer.countDocuments(),
            Trainer.countDocuments({
                lastActiveDate: { $gte: today }
            }),
            Attendance.countDocuments({
                date: { $gte: today },
                status: 'Present'
            }),
            Attendance.countDocuments({
                date: { $gte: today },
                status: 'Absent'
            }),
            Trainer.countDocuments({ verificationStatus: 'pending' }),
            Attendance.find({
                createdAt: { $gte: yesterday }
            })
                .populate('trainerId', 'userId')
                .populate({
                    path: 'trainerId',
                    populate: {
                        path: 'userId',
                        select: 'name'
                    }
                })
                .populate('collegeId', 'name')
                .sort({ createdAt: -1 })
                .limit(10)
                .lean(),
        ]);

        const salaryDue = 0;

        const receNDActivity = receNDAttendance.map(att => {
            const trainerName = att.trainerId?.userId?.name || 'Unknown Trainer';
            const collegeName = att.collegeId?.name || 'Unknown College';
            const action = att.checkOutTime 
                ? `Checked out from ${collegeName}` 
                : `Checked in at ${collegeName}`;
            
            const timeAgo = getTimeAgo(att.createdAt);
            
            return {
                id: att._id,
                user: trainerName,
                action: action,
                time: timeAgo
            };
        });

        // If no activities, show default message
        if (receNDActivity.length === 0) {
            receNDActivity.push({
                id: 1,
                user: 'System',
                action: 'No recent trainer activity',
                time: 'Just now'
            });
        }

        res.json({
            success: true,
            data: {
                stats: [
                    { title: 'Total Companies', value: totalCompanies, change: '+0', changeType: 'neutral' },
                    { title: 'Total Colleges', value: totalColleges, change: '+0', changeType: 'neutral' },
                    { title: 'Total Trainers', value: totalTrainers, change: '+0', changeType: 'neutral' },
                    { title: 'Active Trainers Today', value: activeTrainersToday, change: '+0', changeType: 'positive' },
                    { title: 'Present / Absent Count', value: `${presentCount} / ${absentCount}`, change: '0%', changeType: 'neutral' },
                    { title: 'Pending Approvals', value: pendingApprovals, change: '0', changeType: 'neutral' },
                    { title: 'Salary Due Summary', value: `₹${salaryDue}`, change: '+0%', changeType: 'neutral' },
                ],
                receNDActivity
            }
        });
    } catch (error) {
        console.error('Dashboard Error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// SPOC (Company Admin) Dashboard Stats
router.get('/spoc', authenticate, authorize('SPOCAdmin', 'CollegeAdmin'), async (req, res) => {
    try {
        const company = await Company.findOne({ 
            $or: [
                { userId: req.user.id },
                { 'admin.userId': req.user.id }
            ] 
        });

        if (!company) {
            return res.json({
                success: true,
                data: {
                    stats: [
                        { name: 'Today Trainers', stat: '0', iconType: 'trainers' },
                        { name: 'Companies', stat: '0', iconType: 'companies' },
                        { name: 'Colleges', stat: '0', iconType: 'colleges' },
                        { name: 'Pending Verifications', stat: '0', iconType: 'pending' },
                        { name: 'Attendance Summary', stat: '0/0', iconType: 'attendance' }
                    ],
                    receNDActivity: []
                }
            });
        }

        const [colleges, distinctCollegeCount] = await Promise.all([
            College.find({ companyId: company._id }).select('_id').lean(),
            countDistinctColleges({ companyId: company._id }),
        ]);
        const collegeIds = colleges.map(c => c._id);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const [
            todayTrainersCount,
            pendingVerifications,
            presentToday,
            absentToday,
        ] = await Promise.all([
            Schedule.countDocuments({
                collegeId: { $in: collegeIds },
                scheduledDate: { $gte: today, $lt: tomorrow },
                status: { $ne: 'cancelled' }
            }),
            Attendance.countDocuments({
                collegeId: { $in: collegeIds },
                verificationStatus: 'pending'
            }),
            Attendance.countDocuments({
                collegeId: { $in: collegeIds },
                date: { $gte: today, $lt: tomorrow },
                status: 'Present'
            }),
            Attendance.countDocuments({
                collegeId: { $in: collegeIds },
                date: { $gte: today, $lt: tomorrow },
                status: 'Absent'
            }),
        ]);

        res.json({
            success: true,
            data: {
                stats: [
                    { name: 'Today Trainers', stat: todayTrainersCount.toString(), iconType: 'trainers' },
                    { name: 'Companies', stat: '1', iconType: 'companies' },
                    { name: 'Colleges', stat: distinctCollegeCount.toString(), iconType: 'colleges' },
                    { name: 'Pending Verifications', stat: pendingVerifications.toString(), iconType: 'pending' },
                    { name: 'Attendance Summary', stat: `${presentToday}/${absentToday}`, iconType: 'attendance' }
                ],
                receNDActivity: [
                    { id: 1, type: 'status', content: `Dashboard loaded for ${company.name}`, date: 'Just now' }
                ]
            }
        });
    } catch (error) {
        console.error('SPOC Dashboard Error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

module.exports = router;
