const mongoose = require('mongoose');

const ActivityLogSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    userName: {
        type: String,
        required: true
    },
    role: {
        type: String,
        required: true
    },
    action: {
        type: String,
        required: true
    },
    entityType: {
        type: String, // e.g., 'Complaint', 'Trainer', 'Payment'
        required: true
    },
    entityId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
    },
    details: {
        type: Object, // Store changes: { previousStatus: 'Open', newStatus: 'Resolved' }
        default: {}
    },
    ipAddress: {
        type: String,
        default: ''
    },
    userAgent: {
        type: String,
        default: ''
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('ActivityLog', ActivityLogSchema);
