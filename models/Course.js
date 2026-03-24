const mongoose = require('mongoose');

const courseSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
    },
    description: {
        type: String,
        default: null,
    },
    image: {
        type: String,
        default: null,
    },
    duration: {
        type: Number,
        default: null,
        comment: 'Duration in hours or days',
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
    },
    companyCode: {
        type: String,
        default: null,
        index: true,
        uppercase: true,
        trim: true,
    },
    // Many-to-many with College - store as array of references
    colleges: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'College',
    }],
}, {
    timestamps: true,
});

courseSchema.pre('save', async function (next) {
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

const Course = mongoose.model('Course', courseSchema);

module.exports = Course;
