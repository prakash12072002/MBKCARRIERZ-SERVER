const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
    collegeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'College',
        required: true,
    },
    rollNo: {
        type: String,
        required: true,
    },
    registerNo: {
        type: String,
        required: true,
    },
    name: {
        type: String,
        required: true,
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        default: null,
    },
    companyCode: {
        type: String,
        default: null,
        index: true,
        uppercase: true,
        trim: true,
    },
    courseId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Course',
        default: null,
    }
}, {
    timestamps: true,
});

// Composite index to ensure unique students within a college
studentSchema.index({ collegeId: 1, registerNo: 1 }, { unique: true });

studentSchema.pre('save', async function (next) {
    if (this.companyCode || !this.companyId) return next();
    try {
        const Company = mongoose.model('Company');
        const company = await Company.findById(this.companyId).select('companyCode');
        if (company?.companyCode) this.companyCode = company.companyCode;
        next();
    } catch (error) {
        next(error);
    }
});

const Student = mongoose.model('Student', studentSchema);

module.exports = Student;
