const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
    scheduleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Schedule',
        default: null,
    },
    trainerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Trainer',
        required: true,
    },
    collegeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'College',
        default: null,
    },
    courseId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Course',
        default: null,
    },
    dayNumber: {
        type: Number,
        default: null,
    },
    area: {
        type: String,
        default: null, // For SPOC filtering (e.g., "North Zone")
    },
    date: {
        type: Date,
        required: true,
    },
    status: {
        type: String,
        enum: ['Present', 'Absent', 'Leave', 'Late', 'Pending'],
        default: 'Absent', // Legacy Support
    },
    syllabus: {
        type: String,
        default: null,
    },
    attendanceStatus: {
        type: String,
        enum: ['PRESENT', 'ABSENT'],
    },
    studentsPresent: {
        type: Number,
        default: 0,
    },
    studentsAbsent: {
        type: Number,
        default: 0,
    },
    verificationStatus: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
    },
    geoVerificationStatus: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
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
    verificationComment: {
        type: String,
        default: null,
    },
    approvedBy: {
        type: String,
        default: null,
    },
    // File uploads
    attendancePdfUrl: {
        type: String,
        default: null,
    },
    studentsPhotoUrl: {
        type: String,
        default: null,
    },
    signatureUrl: {
        type: String,
        default: null,
    },
    activityPhotos: {
        type: [String],
        default: [],
    },
    activityVideos: {
        type: [String],
        default: [],
    },
    // Location data (Legacy)
    latitude: {
        type: Number,
        default: null,
    },
    longitude: {
        type: Number,
        default: null,
    },
    locationCapturedAt: {
        type: Date,
        default: null,
    },
    location: {
        type: String,
        default: null,
    },
    // New Structured Geo-Location (MANDATORY)
    checkIn: {
        time: { type: Date, default: null },
        location: {
            lat: { type: Number, default: null },
            lng: { type: Number, default: null },
            accuracy: { type: Number, default: null },
            address: { type: String, default: null },
            distanceFromCollege: { type: Number, default: null } // distance in meters
        }
    },
    checkOut: {
        time: { type: Date, default: null },
        location: {
            lat: { type: Number, default: null },
            lng: { type: Number, default: null },
            accuracy: { type: Number, default: null },
            address: { type: String, default: null },
            distanceFromCollege: { type: Number, default: null } // distance in meters
        },
        photos: [{
            url: { type: String, default: null },
            uploadedAt: { type: Date, default: null }
        }]
    },
    // Legacy fields
    imageUrl: {
        type: String,
        default: null,
    },
    checkOutGeoImageUrl: {
        type: String,
        default: null,
    },
    checkOutGeoImageUrls: {
        type: [String],
        default: [],
    },
    uploadedBy: {
        type: String,
        enum: ['trainer', 'admin'],
        default: 'trainer',
    },
    remarks: {
        type: String,
        default: null,
    },
    isManualEntry: {
        type: Boolean,
        default: false,
    },
    checkInTime: {
        type: String,
        default: null,
    },
    checkOutTime: {
        type: String,
        default: null,
    },
    // New fields for Student Attendance System
    students: [{
        studentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Student'
        },
        rollNo: String,
        registerNo: String,
        name: String,
        status: {
            type: String,
            enum: ['Present', 'Absent'],
            default: 'Absent'
        }
    }],
    scannedAttendancePdfUrl: {
        type: String,
        default: null
    },
    attendanceExcelUrl: {
        type: String,
        default: null
    },
    completedAt: {
        type: Date,
        default: null,
    },
}, {
    timestamps: true,
});

const Attendance = mongoose.model('Attendance', attendanceSchema);

module.exports = Attendance;
