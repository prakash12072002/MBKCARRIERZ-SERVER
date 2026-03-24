const mongoose = require('mongoose');

const trainerAttendanceSchema = new mongoose.Schema({
    trainerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Trainer',
        required: true,
    },
    date: {
        type: Date,
        required: true,
        default: Date.now,
    },
    status: {
        type: String,
        enum: ['Present', 'Absent', 'Leave'],
        default: 'Absent',
    },
    markedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    remarks: {
        type: String,
        default: null,
    },
}, {
    timestamps: true,
});

// Create compound unique index for trainerId and date
trainerAttendanceSchema.index({ trainerId: 1, date: 1 }, { unique: true });

const TrainerAttendance = mongoose.model('TrainerAttendance', trainerAttendanceSchema);

module.exports = TrainerAttendance;
