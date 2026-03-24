const mongoose = require('mongoose');

const checkOutSchema = new mongoose.Schema({
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
    checkOutTime: {
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
    },
    workSummary: {
        type: String,
        default: ''
    }
}, {
    timestamps: true
});

const CheckOut = mongoose.model('CheckOut', checkOutSchema);

module.exports = CheckOut;
