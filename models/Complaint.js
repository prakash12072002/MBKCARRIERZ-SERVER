const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema({
    trainerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    trainerName: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ['Complaint', 'Feedback'],
        required: true
    },
    category: {
        type: String,
        enum: [
            'SPOC Issue', 
            'Schedule Issue', 
            'Payment Issue', 
            'Technical Issue', 
            'Infrastructure Issue', 
            'General Feedback', 
            'Other'
        ],
        required: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        default: null
    },
    collegeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'College',
        default: null
    },
    scheduleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Schedule',
        default: null
    },
    subject: {
        type: String,
        required: true,
        trim: true,
        maxlength: 100
    },
    description: {
        type: String,
        required: true
    },
    attachmentUrl: {
        type: String, // URL to S3/Cloudinary
        default: null
    },
    priority: {
        type: String,
        enum: ['Low', 'Medium', 'High'],
        default: 'Medium'
    },
    status: {
        type: String,
        enum: ['Open', 'In Progress', 'Resolved', 'Closed'],
        default: 'Open'
    },
    adminRemarks: {
        type: String,
        default: ''
    },
    internalNotes: {
        type: String,
        default: ''
    },
    assignedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    isAnonymous: {
        type: Boolean,
        default: false
    },
    slaDeadline: {
        type: Date,
        default: null
    },
    isEscalated: {
        type: Boolean,
        default: false
    },
    resolvedAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true
});

complaintSchema.index({ trainerId: 1, createdAt: -1 });
complaintSchema.index({ assignedTo: 1, status: 1, createdAt: -1 });
complaintSchema.index({ category: 1, status: 1, createdAt: -1 });
complaintSchema.index({ status: 1, createdAt: -1 });

const Complaint = mongoose.model('Complaint', complaintSchema);

module.exports = Complaint;
