const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    firstName: {
        type: String,
        trim: true,
    },
    lastName: {
        type: String,
        trim: true,
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
    },
    password: {
        type: String,
        required: true,
    },
    role: {
        type: String,
        enum: ['SuperAdmin', 'Admin', 'Trainer', 'CollegeAdmin', 'SPOCAdmin', 'Student', 'CompanyAdmin', 'admin', 'spoc', 'trainer'],
        default: 'Student',
    },
    blockedUsers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    }],
    isActive: {
        type: Boolean,
        default: true,
    },
    emailVerified: {
        type: Boolean,
        default: false,
    },
    isEmailVerified: {
        type: Boolean,
        default: false,
    },
    accountStatus: {
        type: String,
        enum: ['pending', 'active', 'suspended'],
        default: 'active',
    },
    phone: {
        type: String,
        trim: true,
    },
    phoneNumber: {
        type: String,
        trim: true,
    },
    plainPassword: {
        type: String,
        default: null,
    },
    verificationToken: {
        type: String,
        default: null,
    },
    emailVerificationToken: {
        type: String,
        default: null,
    },
    resetPasswordOTP: {
        type: String,
        default: null,
    },
    resetPasswordOTPExpires: {
        type: Date,
        default: null,
    },
    resetPasswordToken: {
        type: String,
        default: null,
    },
    resetPasswordExpires: {
        type: Date,
        default: null,
    },
    emailOtp: {
        type: String,
        default: null,
    },
    emailOtpExpires: {
        type: Date,
        default: null,
    },
    firebaseUid: {
        type: String,
        default: null,
    },
    profilePicture: {
        type: String,
        default: null,
    },
    lastLogin: {
        type: Date,
    },
}, {
    timestamps: true,
});

// Hash password before saving
userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (err) {
        next(err);
    }
});

// Method to compare passwords
userSchema.methods.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', userSchema);

module.exports = User;
