const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        trim: true,
        default: ''
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    members: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    chatId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Chat',
        default: null
    },
    streamChannelId: {
        type: String,
        required: true,
        unique: true
    },
    type: {
        type: String,
        enum: ['group', 'broadcast'],
        default: 'group'
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Group', groupSchema);
