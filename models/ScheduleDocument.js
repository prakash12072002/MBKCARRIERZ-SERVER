const mongoose = require('mongoose');

const scheduleDocumentSchema = new mongoose.Schema({
    scheduleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Schedule',
        required: true,
        index: true,
    },
    attendanceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Attendance',
        default: null,
        index: true,
    },
    trainerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Trainer',
        required: true,
        index: true,
    },
    fileType: {
        type: String,
        enum: ['attendance', 'geotag', 'other'],
        default: 'other',
        index: true,
    },
    fileField: {
        type: String,
        default: null,
    },
    fileName: {
        type: String,
        default: null,
    },
    driveFileId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    fileUrl: {
        type: String,
        required: true,
    },
    status: {
        type: String,
        enum: ['pending', 'verified', 'rejected'],
        default: 'pending',
        index: true,
    },
    verifiedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    verifiedAt: {
        type: Date,
        default: null,
    },
    rejectReason: {
        type: String,
        default: null,
    },
}, {
    timestamps: true,
});

scheduleDocumentSchema.index({ scheduleId: 1, fileType: 1, status: 1 });
scheduleDocumentSchema.index({ trainerId: 1, createdAt: -1 });

const ScheduleDocument = mongoose.model('ScheduleDocument', scheduleDocumentSchema);

module.exports = ScheduleDocument;
