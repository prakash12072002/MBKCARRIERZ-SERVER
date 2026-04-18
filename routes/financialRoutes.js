const express = require('express');
const router = express.Router();
const { FinancialRecord } = require('../models');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const toPositiveInteger = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
};

const clampLimit = (value) => Math.min(toPositiveInteger(value, DEFAULT_LIMIT), MAX_LIMIT);

const parseDateRangeFilter = ({ startDate, endDate }) => {
    if (!startDate && !endDate) {
        return null;
    }

    const range = {};
    if (startDate) {
        const parsed = new Date(startDate);
        if (!Number.isNaN(parsed.getTime())) {
            range.$gte = parsed;
        }
    }

    if (endDate) {
        const parsed = new Date(endDate);
        if (!Number.isNaN(parsed.getTime())) {
            const inclusiveEndDate = new Date(parsed);
            inclusiveEndDate.setHours(23, 59, 59, 999);
            range.$lte = inclusiveEndDate;
        }
    }

    return Object.keys(range).length > 0 ? range : null;
};

const buildFinancialFilter = (query = {}) => {
    const filter = {};
    const normalizedStatus = String(query.status || '').trim();
    const normalizedType = String(query.type || '').trim();
    const normalizedTrainerId = String(query.trainerId || '').trim();
    const normalizedSearch = String(query.search || '').trim();

    if (normalizedStatus) {
        filter.status = normalizedStatus;
    }

    if (normalizedType) {
        filter.type = normalizedType;
    }

    if (normalizedTrainerId) {
        filter.trainerId = normalizedTrainerId;
    }

    const dateRange = parseDateRangeFilter(query);
    if (dateRange) {
        filter.date = dateRange;
    }

    if (normalizedSearch) {
        const searchExpression = new RegExp(normalizedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [
            { description: searchExpression },
            { type: searchExpression },
            { status: searchExpression },
        ];
    }

    return filter;
};

const shouldUsePaginatedResponse = (query = {}) =>
    ['page', 'limit', 'status', 'type', 'trainerId', 'search', 'startDate', 'endDate']
        .some((key) => Object.prototype.hasOwnProperty.call(query, key));

const buildFinancialRecordsQuery = (filter = {}) =>
    FinancialRecord.find(filter)
        .select('trainerId type amount status date description createdAt updatedAt')
        .populate({
            path: 'trainerId',
            select: 'trainerId userId',
            populate: {
                path: 'userId',
                select: 'name email',
            },
        })
        .sort({ date: -1 });

// Get all financial records (SuperAdmin/Accountant)
router.get('/', async (req, res) => {
    try {
        const filter = buildFinancialFilter(req.query);
        const usePaginatedResponse = shouldUsePaginatedResponse(req.query);

        if (!usePaginatedResponse) {
            const records = await buildFinancialRecordsQuery(filter).lean();
            return res.json(records);
        }

        const page = toPositiveInteger(req.query.page, DEFAULT_PAGE);
        const limit = clampLimit(req.query.limit);
        const skip = (page - 1) * limit;

        const [records, total] = await Promise.all([
            buildFinancialRecordsQuery(filter).skip(skip).limit(limit).lean(),
            FinancialRecord.countDocuments(filter),
        ]);

        const totalPages = Math.max(1, Math.ceil(total / limit));

        return res.json({
            data: records,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
            },
        });
    } catch (error) {
        return res.status(500).json({ message: 'Error fetching financial records', error: error.message });
    }
});

router.get('/stats', async (_req, res) => {
    try {
        const aggregation = await FinancialRecord.aggregate([
            {
                $group: {
                    _id: '$status',
                    amount: { $sum: '$amount' },
                    count: { $sum: 1 },
                },
            },
        ]);

        const totals = aggregation.reduce(
            (accumulator, bucket) => {
                const status = String(bucket._id || '').trim();
                accumulator.totalAmount += Number(bucket.amount || 0);
                accumulator.totalRecords += Number(bucket.count || 0);

                if (status === 'Success') {
                    accumulator.successAmount += Number(bucket.amount || 0);
                }
                if (status === 'Pending') {
                    accumulator.pendingAmount += Number(bucket.amount || 0);
                }

                accumulator.byStatus[status || 'Unknown'] = {
                    amount: Number(bucket.amount || 0),
                    count: Number(bucket.count || 0),
                };
                return accumulator;
            },
            {
                totalAmount: 0,
                successAmount: 0,
                pendingAmount: 0,
                totalRecords: 0,
                byStatus: {},
            },
        );

        return res.json(totals);
    } catch (error) {
        return res.status(500).json({ message: 'Error fetching financial stats', error: error.message });
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
