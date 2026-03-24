const mongoose = require('mongoose');

const checkInSchema = new mongoose.Schema({
    trainerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Trainer',
        required: true
    },
    scheduleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Schedule',
        default: null
    },
    checkInTime: {
        type: Date,
        default: Date.now
    },
    location: {
        latitude: Number,
        longitude: Number,
        address: String
    },
    photoUrl: {
        type: String,
        default: null
    },
    deviceInfo: {
        type: String,
        default: ''
    }
}, {
    timestamps: true
});

const CheckIn = mongoose.model('CheckIn', checkInSchema);

module.exports = CheckIn;
