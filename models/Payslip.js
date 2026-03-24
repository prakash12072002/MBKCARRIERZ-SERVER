const mongoose = require('mongoose');

const payslipSchema = new mongoose.Schema({
    salaryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Salary',
        required: true
    },
    trainerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Trainer',
        required: true
    },
    month: {
        type: String,
        required: true
    },
    year: {
        type: Number,
        required: true
    },
    totalAmount: {
        type: Number,
        required: true
    },
    components: {
        base: Number,
        allowances: Number,
        deductions: Number
    },
    pdfUrl: {
        type: String,
        default: null
    },
    status: {
        type: String,
        enum: ['Generated', 'Sent', 'Downloaded'],
        default: 'Generated'
    }
}, {
    timestamps: true
});

const Payslip = mongoose.model('Payslip', payslipSchema);

module.exports = Payslip;
