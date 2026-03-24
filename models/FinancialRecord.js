const mongoose = require('mongoose');

const financialRecordSchema = new mongoose.Schema({
    trainerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Trainer',
        required: true,
    },
    type: {
        type: String,
        enum: ['Salary', 'Bonus', 'Reimbursement', 'Advance'],
        required: true,
    },
    amount: {
        type: Number,
        required: true,
    },
    status: {
        type: String,
        enum: ['Pending', 'Processing', 'Success', 'Failed'],
        default: 'Pending',
    },
    date: {
        type: Date,
        default: Date.now,
    },
    description: {
        type: String,
        default: null,
    },
}, {
    timestamps: true,
});

const FinancialRecord = mongoose.model('FinancialRecord', financialRecordSchema);

module.exports = FinancialRecord;
