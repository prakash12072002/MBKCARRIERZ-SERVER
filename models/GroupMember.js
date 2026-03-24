const mongoose = require('mongoose');

const groupMemberSchema = new mongoose.Schema({
    groupId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group',
        required: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    role: {
        type: String,
        enum: ['member', 'admin'],
        default: 'member'
    },
    isMuted: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

// Composite index for fast lookup and uniqueness
groupMemberSchema.index({ groupId: 1, userId: 1 }, { unique: true });
groupMemberSchema.index({ userId: 1 }); // To find all groups for a user

module.exports = mongoose.model('GroupMember', groupMemberSchema);
