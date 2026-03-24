const mongoose = require('mongoose');

const collegeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    address: {
        type: String,
        default: null,
    },
    mapUrl: {
        type: String,
        default: null,
    },
    latitude: {
        type: Number,
        default: null,
    },
    longitude: {
        type: Number,
        default: null,
    },
    location: {
        address: {
            type: String,
            default: null,
        },
        lat: {
            type: Number,
            default: null,
        },
        lng: {
            type: Number,
            default: null,
        },
        mapUrl: {
            type: String,
            default: null,
        },
    },
    zone: {
        type: String,
        default: null,
    },
    city: {
        type: String,
        default: null,
    },
    department: {
        type: String,
        default: 'General',
        trim: true,
    },
    principalName: {
        type: String,
        default: null,
    },
    phone: {
        type: String,
        default: null,
    },
    spocName: {
        type: String,
        default: null,
    },
    spocPhone: {
        type: String,
        default: null,
    },
    email: {
        type: String,
        default: null,
    },
    website: {
        type: String,
        default: null,
    },
    coNDActInfo: {
        type: String,
        default: null,
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
    },
    companyCode: {
        type: String,
        default: null,
        index: true,
        uppercase: true,
        trim: true,
    },
    courseId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Course',
        default: null,
    },
    // Many-to-many with Trainer - store as array of references
    trainers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Trainer',
    }],
    studeNDAttendanceExcelUrl: {
        type: String,
        default: null,
    },
}, {
    timestamps: true,
});

collegeSchema.pre('validate', function (next) {
    // Sync legacy location object -> flat fields
    if (!this.address && this.location?.address) this.address = this.location.address;
    if (!this.mapUrl && this.location?.mapUrl) this.mapUrl = this.location.mapUrl;
    if (this.latitude == null && this.location?.lat != null) this.latitude = this.location.lat;
    if (this.longitude == null && this.location?.lng != null) this.longitude = this.location.lng;

    // Sync flat fields -> legacy location object for backward compatibility
    if (!this.location) this.location = {};
    if (this.address && !this.location.address) this.location.address = this.address;
    if (this.mapUrl && !this.location.mapUrl) this.location.mapUrl = this.mapUrl;
    if (this.latitude != null && this.location.lat == null) this.location.lat = this.latitude;
    if (this.longitude != null && this.location.lng == null) this.location.lng = this.longitude;

    // Sync new SPOC fields with legacy names
    if (!this.spocName && this.principalName) this.spocName = this.principalName;
    if (!this.spocPhone && this.phone) this.spocPhone = this.phone;
    if (!this.principalName && this.spocName) this.principalName = this.spocName;
    if (!this.phone && this.spocPhone) this.phone = this.spocPhone;

    next();
});

collegeSchema.pre('save', async function (next) {
    if (this.companyCode || !this.companyId) return next();
    try {
        const Company = mongoose.model('Company');
        const company = await Company.findById(this.companyId).select('companyCode');
        if (company?.companyCode) this.companyCode = company.companyCode;
        next();
    } catch (error) {
        next(error);
    }
});

const College = mongoose.model('College', collegeSchema);

module.exports = College;
