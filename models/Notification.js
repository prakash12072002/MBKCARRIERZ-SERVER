const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        // Optional ref path if dynamically referenced via role, but typically we handle loosely
    },
    role: {
        type: String,
        required: true,
        enum: ['SuperAdmin', 'CompanyAdmin', 'CollegeAdmin', 'SPOCAdmin', 'Trainer', 'AccouNDAnt', 'Student']
    },
    title: {
        type: String,
        required: true,
        trim: true
    },
    message: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ['System', 'Attendance', 'Salary', 'Schedule', 'Approval', 'Complaints', 'Chat', 'Announcement', 'Error', 'error', 'complaint'],
        default: 'System'
    },
    isRead: {
        type: Boolean,
        default: false
    },
    link: {
        type: String,
        default: null // Optional deep link URL to navigate on click
    }
}, { timestamps: true });

// Index for efficient querying by user and unread status
notificationSchema.index({ userId: 1, isRead: 1 });
notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
