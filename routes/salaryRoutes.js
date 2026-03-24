const express = require('express');
const router = express.Router();
const { Salary, Trainer, FinancialRecord } = require('../models');

// Get all salary records
router.get('/', async (req, res) => {
    try {
        const salaries = await Salary.find({})
            .populate({
                path: 'trainerId',
                populate: {
                    path: 'userId'
                }
            })
            .sort({ year: -1, month: -1 });
        res.json(salaries);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching salaries', error: error.message });
    }
});

// Calculate Salary based on approved attendance
router.post('/calculate', async (req, res) => {
    try {
        const { month, year } = req.body;
        const { Attendance } = require('../models');
        const dayjs = require('dayjs');

        // Start and end of the month
        const startDate = dayjs(`${year}-${month}-01`).startOf('month').toDate();
        const endDate = dayjs(`${year}-${month}-01`).endOf('month').toDate();

        const trainers = await Trainer.find({});
        const results = [];

        for (const trainer of trainers) {
            // Fetch approved attendance for this trainer in this month
            const attendanceCount = await Attendance.countDocuments({
                trainerId: trainer._id,
                date: { $gte: startDate, $lte: endDate },
                status: 'Present'
            });

            const salaryPerDay = trainer.perDaySalary || 0;
            const totalSalary = attendanceCount * salaryPerDay;

            // Update or create salary record
            let salaryRecord = await Salary.findOne({
                trainerId: trainer._id,
                month,
                year
            });

            if (salaryRecord) {
                // Only update if it's still Pending
                if (salaryRecord.status === 'Pending') {
                    salaryRecord.presentDays = attendanceCount;
                    salaryRecord.salaryPerDay = salaryPerDay;
                    salaryRecord.totalSalary = totalSalary;
                    await salaryRecord.save();
                }
            } else {
                salaryRecord = await Salary.create({
                    trainerId: trainer._id,
                    month,
                    year,
                    workingDays: dayjs(endDate).date(), // Days in month
                    presentDays: attendanceCount,
                    salaryPerDay,
                    totalSalary,
                    status: 'Pending'
                });
            }
            results.push(salaryRecord);
        }

        res.json({ 
            success: true, 
            message: `Calculated salaries for ${results.length} trainers`, 
            data: results 
        });
    } catch (error) {
        console.error('Salary calculation error:', error);
        res.status(500).json({ message: 'Error calculating salaries', error: error.message });
    }
});

// Process Payment
router.post('/pay/:id', async (req, res) => {
    try {
        const salary = await Salary.findById(req.params.id);
        if (!salary) {
            return res.status(404).json({ message: 'Salary record not found' });
        }
        salary.status = 'Paid';
        await salary.save();

        // Create a corresponding Financial Record
        await FinancialRecord.create({
            trainerId: salary.trainerId,
            type: 'Salary',
            amount: salary.totalSalary,
            status: 'Success',
            description: `Salary for ${salary.month} ${salary.year}`
        });

        res.json({ message: 'Payment processed successfully', salary });
    } catch (error) {
        res.status(500).json({ message: 'Error processing payment', error: error.message });
    }
});

// Update Trainer Daily Rate
router.put('/rate/:trainerId', async (req, res) => {
    try {
        const { dailyRate } = req.body;
        const trainer = await Trainer.findById(req.params.trainerId);
        if (!trainer) {
            return res.status(404).json({ message: 'Trainer not found' });
        }
        trainer.perDaySalary = dailyRate;
        await trainer.save();
        res.json({ success: true, message: 'Daily rate updated', perDaySalary: trainer.perDaySalary });
    } catch (error) {
        res.status(500).json({ message: 'Error updating rate', error: error.message });
    }
});

module.exports = router;
