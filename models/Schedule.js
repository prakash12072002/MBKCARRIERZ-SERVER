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
    attendanceUploaded: {
        type: Boolean,
        default: false,
    },
    geoTagUploaded: {
        type: Boolean,
        default: false,
    },
    dayStatus: {
        type: String,
        enum: ['completed', 'pending', 'not_assigned'],
        default: 'not_assigned',
    },
    dayStatusUpdatedAt: {
        type: Date,
        default: null,
    },
    driveFolderId: {
        type: String,
        default: null,
    },
    driveFolderName: {
        type: String,
        default: null,
    },
    driveFolderLink: {
        type: String,
        default: null,
    },
    dayFolderId: {
        type: String,
        default: null,
    },
    dayFolderName: {
        type: String,
        default: null,
    },
    dayFolderLink: {
        type: String,
        default: null,
    },
    attendanceFolderId: {
        type: String,
        default: null,
    },
    attendanceFolderName: {
        type: String,
        default: null,
    },
    attendanceFolderLink: {
        type: String,
        default: null,
    },
    geoTagFolderId: {
        type: String,
        default: null,
    },
    geoTagFolderName: {
        type: String,
        default: null,
    },
    geoTagFolderLink: {
        type: String,
        default: null,
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

scheduleSchema.pre('save', function (next) {
    if (
        this.isNew
        || this.isModified('trainerId')
        || (
            (this.isModified('attendanceUploaded') || this.isModified('geoTagUploaded'))
            && !this.isModified('dayStatus')
        )
    ) {
        this.dayStatus = this.trainerId
            ? ((this.attendanceUploaded && this.geoTagUploaded) ? 'completed' : 'pending')
            : 'not_assigned';
    }
    if (
        this.isNew
        || this.isModified('trainerId')
        || this.isModified('attendanceUploaded')
        || this.isModified('geoTagUploaded')
        || this.isModified('dayStatus')
    ) {
        this.dayStatusUpdatedAt = new Date();
    }

    if (!this.dayFolderId && this.driveFolderId) {
        this.dayFolderId = this.driveFolderId;
    }
    if (!this.dayFolderName && this.driveFolderName) {
        this.dayFolderName = this.driveFolderName;
    }
    if (!this.dayFolderLink && this.driveFolderLink) {
        this.dayFolderLink = this.driveFolderLink;
    }

    if (!this.driveFolderId && this.dayFolderId) {
        this.driveFolderId = this.dayFolderId;
    }
    if (!this.driveFolderName && this.dayFolderName) {
        this.driveFolderName = this.dayFolderName;
    }
    if (!this.driveFolderLink && this.dayFolderLink) {
        this.driveFolderLink = this.dayFolderLink;
    }

    next();
});

scheduleSchema.index({ departmentId: 1, dayNumber: 1 });
scheduleSchema.index({ trainerId: 1, scheduledDate: 1 });
scheduleSchema.index({ companyId: 1, courseId: 1, collegeId: 1, departmentId: 1 });
scheduleSchema.index({ driveFolderId: 1 }, { sparse: true });

const Schedule = mongoose.model('Schedule', scheduleSchema);

module.exports = Schedule;
