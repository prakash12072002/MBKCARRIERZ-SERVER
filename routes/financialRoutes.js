const express = require('express');
const router = express.Router();
const { FinancialRecord, Trainer } = require('../models');

// Get all financial records (SuperAdmin/AccouNDAnt)
router.get('/', async (req, res) => {
    try {
        const records = await FinancialRecord.find({})
            .populate({
                path: 'trainerId',
                populate: {
                    path: 'userId'
                }
            })
            .sort({ date: -1 });
        res.json(records);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching financial records', error: error.message });
    }
});

// Get records for a specific trainer
router.get('/trainer/:id', async (req, res) => {
    try {
        const records = await FinancialRecord.find({ trainerId: req.params.id })
            .sort({ date: -1 });
        res.json(records);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching trainer records', error: error.message });
    }
});

// Create a new financial record (e.g., Reimbursement)
router.post('/', async (req, res) => {
    try {
        const { trainerId, type, amount, description, date } = req.body;
        const record = await FinancialRecord.create({
            trainerId,
            type,
            amount,
            description,
            date: date || new Date(),
            status: 'Pending'
        });
        res.status(201).json(record);
    } catch (error) {
        res.status(500).json({ message: 'Error creating financial record', error: error.message });
    }
});

module.exports = router;
