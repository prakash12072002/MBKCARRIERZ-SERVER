const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema({
    trainerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Trainer',
        default: null,
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
    },
    collegeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'College',
        required: true,
    },
    departmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Department',
        default: null,
    },
    collegeLocation: {
        address: {
            type: String,
            default: null,
        },
        lat: {
            type: Number,
            default: null,
        },
        lng: {
            type: Number,
            default: null,
        },
        mapUrl: {
            type: String,
            default: null,
        },
    },
    dayNumber: {
        type: Number,
        required: true,
        min: 0,
        max: 12,
    },
    scheduledDate: {
        type: Date,
        default: null,
    },
    startTime: {
        type: String,
        required: true,
    },
    endTime: {
        type: String,
        required: true,
    },
    subject: {
        type: String,
        default: null,
    },
    status: {
        type: String,
        enum: ['scheduled', 'inprogress', 'completed', 'cancelled', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
        default: 'scheduled',
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    dayOfWeek: {
        type: String,
        enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
        default: null,
    },
    rescheduleReason: {
        type: String,
        default: null,
    },
    reminderSent: {
        type: Boolean,
        default: false,
    },
}, {
    timestamps: true,
});

scheduleSchema.pre('save', async function (next) {
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

const Schedule = mongoose.model('Schedule', scheduleSchema);

module.exports = Schedule;
