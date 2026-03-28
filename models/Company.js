const mongoose = require('mongoose');
const CompanyArchive = require('./CompanyArchive');
const CompanyCodeCounter = require('./CompanyCodeCounter');

function generateCompanyCode(year, sequence) {
    return `MBK${year}${String(sequence).padStart(4, '0')}`;
}

async function getNextCompanyCodeCandidate() {
    const year = new Date().getFullYear();

    const counter = await CompanyCodeCounter.findOneAndUpdate(
        { year },
        { $inc: { seq: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return generateCompanyCode(year, counter.seq);
}

async function createUniqueCompanyCode() {
    let code;
    let exists = true;

    while (exists) {
        code = await getNextCompanyCodeCandidate();

        const active = await mongoose.model('Company').findOne({ companyCode: code }).select('_id');
        const archived = await CompanyArchive.findOne({ companyCode: code }).select('_id');

        exists = !!(active || archived);
    }

    return code;
}

const companySchema = new mongoose.Schema({
    companyCode: {
        type: String,
        unique: true,
        required: true,
        uppercase: true,
        trim: true,
    },
    name: {
        type: String,
        required: true,
    },
    adminName: {
        type: String,
        default: null,
    },
    email: {
        type: String,
        unique: true,
        sparse: true, // Allows null values while maiNDAining uniqueness
        default: null,
    },
    phone: {
        type: String,
        default: null,
    },
    address: {
        type: String,
        default: null,
    },
    logo: {
        type: String,
        default: null,
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'Active', 'Inactive'],
        default: 'active',
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    // Legacy field kept for compatibility with existing routes
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    driveFolderId: {
        type: String,
        default: null,
    },
    driveFolderName: {
        type: String,
        default: null,
    },
    driveFolderLink: {
        type: String,
        default: null,
    },
}, {
    timestamps: true,
});

companySchema.pre('validate', async function (next) {
    if (this.companyCode) return next();

    try {
        this.companyCode = await createUniqueCompanyCode();
        next();
    } catch (error) {
        next(error);
    }
});

companySchema.statics.generateCompanyCode = generateCompanyCode;
companySchema.statics.createUniqueCompanyCode = createUniqueCompanyCode;

companySchema.index({ name: 1 });
companySchema.index({ driveFolderId: 1 }, { sparse: true });

companySchema.pre('save', function (next) {
    // Keep adminId and legacy userId in sync
    if (this.adminId && !this.userId) this.userId = this.adminId;
    if (this.userId && !this.adminId) this.adminId = this.userId;
    next();
});

const Company = mongoose.model('Company', companySchema);

module.exports = Company;
