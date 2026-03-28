const mongoose = require('mongoose');

const departmentSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        default: null,
    },
    courseId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Course',
        default: null,
    },
    collegeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'College',
        required: true,
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
    dayFolders: {
        type: [{
            day: { type: Number, required: true, min: 1, max: 31 },
            folderId: { type: String, default: null },
            folderName: { type: String, default: null },
            folderLink: { type: String, default: null },
            attendanceFolderId: { type: String, default: null },
            attendanceFolderName: { type: String, default: null },
            attendanceFolderLink: { type: String, default: null },
            geoTagFolderId: { type: String, default: null },
            geoTagFolderName: { type: String, default: null },
            geoTagFolderLink: { type: String, default: null },
        }],
        default: [],
    },
    isActive: {
        type: Boolean,
        default: true,
    },
}, {
    timestamps: true,
});

departmentSchema.index({ collegeId: 1, name: 1 }, { unique: true });
departmentSchema.index({ companyId: 1, courseId: 1, collegeId: 1 });
departmentSchema.index({ driveFolderId: 1 }, { sparse: true });

const Department = mongoose.model('Department', departmentSchema);

module.exports = Department;
