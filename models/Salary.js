const mongoose = require('mongoose');

const salarySchema = new mongoose.Schema({
    trainerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Trainer',
        required: true,
    },
    month: {
        type: String,
        required: true,
    },
    year: {
        type: Number,
        required: true,
    },
    workingDays: {
        type: Number,
        default: 0,
    },
    presentDays: {
        type: Number,
        default: 0,
    },
    salaryPerDay: {
        type: Number,
        default: 0.00,
    },
    totalSalary: {
        type: Number,
        default: 0.00,
    },
    status: {
        type: String,
        enum: ['Pending', 'Processing', 'Paid'],
        default: 'Pending',
    },
}, {
    timestamps: true,
});

const Salary = mongoose.model('Salary', salarySchema);

module.exports = Salary;
