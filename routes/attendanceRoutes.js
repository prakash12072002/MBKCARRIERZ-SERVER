const express = require('express');
const router = express.Router();
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { uploadAttendance, uploadManual } = require('../config/upload');
const { Attendance, Trainer, College, Schedule, User, Student, Notification, Department, ScheduleDocument } = require('../models');
const { sendTrainingCompletionEmail } = require('../utils/emailService');
const { getGeoTagData } = require('../utils/exif');
const { verifyGeoTag } = require('../utils/verify');
const { sendNotification } = require('../services/notificationService');
const { uploadToDriveWithRetry, ensureDriveFolder } = require('../services/googleDriveService');
const {
    isTrainingDriveEnabled,
    ensureTrainingRootFolder,
    ensureDepartmentHierarchy,
    toDepartmentDayFolders,
} = require('../services/googleDriveTrainingHierarchyService');
const haversine = require('haversine-distance');

const ALLOWED_GEO_RANGE_METERS = Math.max(
    0,
    Number.parseInt(process.env.ATTENDANCE_GEO_ALLOWED_RANGE_METERS || '300', 10) || 300
);
const CHECK_OUT_ALLOWED_GEO_RANGE_METERS = Math.max(
    0,
    Number.parseInt(process.env.ATTENDANCE_CHECK_OUT_ALLOWED_RANGE_METERS || '10000', 10) || 10000
);
const ATTENDANCE_BUSINESS_TIMEZONE = String(
    process.env.ATTENDANCE_BUSINESS_TIMEZONE || 'Asia/Kolkata'
).trim() || 'Asia/Kolkata';

const DRIVE_DEFAULT_MIME_BY_EXT = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.wmv': 'video/x-ms-wmv'
};

const DRIVE_DAY_SUBFOLDERS = {
    attendance: 'Attendance',
    geoTag: 'GeoTag'
};

const GEO_TAG_FILE_FIELDS = new Set([
    'studentsPhoto',
    'signature',
    'photo',
    'photos',
    'image',
    'images',
    'checkOutGeoImage',
    'activityPhotos',
    'activityVideos',
    'checkOutSignature'
]);

const getFileMimeType = (file) => {
    if (file?.mimetype) return file.mimetype;
    const ext = path.extname(file?.originalname || file?.path || '').toLowerCase();
    return DRIVE_DEFAULT_MIME_BY_EXT[ext] || 'application/octet-stream';
};

const dedupeDriveAssetEntries = (entries = []) => {
    const deduped = new Map();

    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || typeof entry !== 'object') continue;

        const identity = entry.fileId
            || [
                entry.folderId || '',
                entry.folderType || '',
                entry.fieldName || '',
                entry.fileName || '',
                entry.localPath || entry.fileUrl || entry.webViewLink || ''
            ].join('|');

        if (!identity.replace(/\|/g, '').trim()) continue;
        if (deduped.has(identity)) {
            deduped.delete(identity);
        }
        deduped.set(identity, entry);
    }

    return Array.from(deduped.values());
};

const mergeDriveAssets = (existingAssets, syncResult) => {
    const baseAssets = existingAssets && typeof existingAssets === 'object' ? existingAssets : {};
    const existingByField = baseAssets.filesByField && typeof baseAssets.filesByField === 'object'
        ? baseAssets.filesByField
        : {};
    const mergedByField = { ...existingByField };

    for (const [fieldName, uploadedFiles] of Object.entries(syncResult.filesByField || {})) {
        if (!Array.isArray(uploadedFiles) || uploadedFiles.length === 0) continue;
        const existingFiles = Array.isArray(mergedByField[fieldName]) ? mergedByField[fieldName] : [];
        mergedByField[fieldName] = dedupeDriveAssetEntries([...existingFiles, ...uploadedFiles]);
    }

    const existingFlatFiles = Array.isArray(baseAssets.files) ? baseAssets.files : [];

    return {
        ...baseAssets,
        folderId: syncResult.dayFolderId || syncResult.folderId || baseAssets.folderId || null,
        dayFolderId: syncResult.dayFolderId || baseAssets.dayFolderId || null,
        subFolders: syncResult.subFolders || baseAssets.subFolders || null,
        filesByField: mergedByField,
        files: dedupeDriveAssetEntries([...existingFlatFiles, ...(syncResult.files || [])]),
        lastSyncedAt: syncResult.syncedAt,
        lastSyncError: null,
        lastSyncErrorAt: null
    };
};

const markDriveSyncError = (existingAssets, error) => {
    const baseAssets = existingAssets && typeof existingAssets === 'object' ? existingAssets : {};
    return {
        ...baseAssets,
        lastSyncError: error?.message || 'Drive sync failed',
        lastSyncErrorAt: new Date().toISOString()
    };
};

const resolveDriveSubFolderType = (fieldName) =>
    GEO_TAG_FILE_FIELDS.has(fieldName) ? 'geoTag' : 'attendance';

const toScheduleDocumentFileType = (folderType) => {
    const normalizedType = String(folderType || '').trim().toLowerCase();
    if (normalizedType === String(DRIVE_DAY_SUBFOLDERS.geoTag).toLowerCase()) return 'geotag';
    if (normalizedType === String(DRIVE_DAY_SUBFOLDERS.attendance).toLowerCase()) return 'attendance';
    return 'other';
};

const toScheduleDocumentStatus = (status) => {
    const normalizedStatus = String(status || '').trim().toLowerCase();
    if (normalizedStatus === 'approved') return 'verified';
    if (normalizedStatus === 'rejected') return 'rejected';
    return 'pending';
};

const toObjectIdOrNull = (value) => {
    if (!value) return null;
    return mongoose.Types.ObjectId.isValid(value) ? value : null;
};

const toFolderAssetPayload = (folder, type) => ({
    id: folder?.id || null,
    name: folder?.name || null,
    link: folder?.webViewLink || null,
    type
});

const toDayNumber = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
};

const toZonedDateKey = (value, timeZone = ATTENDANCE_BUSINESS_TIMEZONE) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);

    const year = parts.find((item) => item.type === 'year')?.value;
    const month = parts.find((item) => item.type === 'month')?.value;
    const day = parts.find((item) => item.type === 'day')?.value;

    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
};

const normalizeAssignedDateInput = (value) => {
    if (!value) return null;
    const normalized = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
        return normalized;
    }
    return toZonedDateKey(normalized);
};

const toIdString = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') {
        if (value._id) return String(value._id).trim();
        if (value.id) return String(value.id).trim();
        if (value.$oid) return String(value.$oid).trim();
    }
    const normalized = String(value).trim();
    return normalized === '[object Object]' ? '' : normalized;
};

const buildPendingCheckOutImageSlot = () => ({
    image: null,
    latitude: null,
    longitude: null,
    distance: null,
    status: 'PENDING'
});

const buildPendingCheckOutPhotoSlot = () => ({
    url: null,
    uploadedAt: null,
    validationStatus: 'pending',
    validationReason: null,
    latitude: null,
    longitude: null,
    capturedAt: null,
    distanceKm: null,
});

const ensureFixedLengthSlotArray = (items, slotCount, buildDefaultSlot) => (
    Array.from({ length: slotCount }, (_, index) => {
        const existing = Array.isArray(items) ? items[index] : null;
        return existing && typeof existing === 'object'
            ? { ...buildDefaultSlot(), ...existing }
            : buildDefaultSlot();
    })
);

const deriveUploadedImageFinalStatus = (images = []) => {
    const normalizedImages = ensureFixedLengthSlotArray(images, 3, buildPendingCheckOutImageSlot);
    const hasAllImages = normalizedImages.every((item) => String(item?.image || '').trim());
    const allVerified = hasAllImages
        && normalizedImages.every((item) => String(item?.status || 'PENDING').trim().toUpperCase() === 'VERIFIED');

    return allVerified ? 'COMPLETED' : 'PENDING';
};

const hasAttendanceDocs = (attendance) =>
    Boolean(attendance?.attendancePdfUrl || attendance?.attendanceExcelUrl);

const hasGeoTagDocs = (attendance) =>
    Boolean(
        attendance?.signatureUrl
        || attendance?.studentsPhotoUrl
        || attendance?.checkOutGeoImageUrl
        || (Array.isArray(attendance?.checkOutGeoImageUrls) && attendance.checkOutGeoImageUrls.length)
        || (Array.isArray(attendance?.activityPhotos) && attendance.activityPhotos.length)
        || (Array.isArray(attendance?.activityVideos) && attendance.activityVideos.length)
    );

const normalizeVerificationStatus = (value, fallback = 'pending') => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'approved') return 'approved';
    if (normalized === 'rejected') return 'rejected';
    return fallback;
};

const buildDocsStatusLabel = (attendance) => hasAttendanceDocs(attendance) ? 'Docs Uploaded' : 'Pending';

const buildGeoStatusLabel = (attendance) => {
    const normalized = normalizeVerificationStatus(attendance?.geoVerificationStatus);
    if (normalized === 'approved') return 'Completed';
    return 'Pending';
};

const normalizeDayStatus = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'completed') return 'completed';
    if (normalized === 'pending') return 'pending';
    if (normalized === 'not_assigned') return 'not_assigned';
    return null;
};

const buildPersistedDayStatus = (schedule, attendance) => {
    const attendanceUploaded = hasAttendanceDocs(attendance);
    const geoTagUploaded = hasGeoTagDocs(attendance);
    const hasTrainerAssigned = Boolean(schedule?.trainerId);
    const attendanceVerification = normalizeVerificationStatus(attendance?.verificationStatus, '');
    const geoVerification = normalizeVerificationStatus(attendance?.geoVerificationStatus, '');

    if (!hasTrainerAssigned || String(schedule?.status || '').trim().toLowerCase() === 'cancelled') {
        return {
            attendanceUploaded,
            geoTagUploaded,
            dayStatus: 'not_assigned'
        };
    }

    if (
        attendanceUploaded
        && geoTagUploaded
        && attendanceVerification === 'approved'
        && geoVerification === 'approved'
    ) {
        return {
            attendanceUploaded,
            geoTagUploaded,
            dayStatus: 'completed'
        };
    }

    return {
        attendanceUploaded,
        geoTagUploaded,
        dayStatus: 'pending'
    };
};

const syncScheduleDayState = async ({
    scheduleId,
    schedule = null,
    attendance = null,
    dayStatusOverride = undefined
} = {}) => {
    if (!scheduleId) return null;

    const scheduleDoc = schedule && typeof schedule === 'object' && schedule._id
        ? schedule
        : await Schedule.findById(scheduleId).select('trainerId status attendanceUploaded geoTagUploaded dayStatus');

    if (!scheduleDoc) return null;

    const attendanceDoc = attendance
        || await Attendance.findOne({ scheduleId }).sort({ createdAt: -1 });

    const derivedState = buildPersistedDayStatus(scheduleDoc, attendanceDoc);
    const normalizedOverride = normalizeDayStatus(dayStatusOverride);
    const nextState = {
        attendanceUploaded: derivedState.attendanceUploaded,
        geoTagUploaded: derivedState.geoTagUploaded,
        dayStatus: normalizedOverride || derivedState.dayStatus,
        dayStatusUpdatedAt: new Date()
    };

    const shouldUpdate =
        scheduleDoc.attendanceUploaded !== nextState.attendanceUploaded
        || scheduleDoc.geoTagUploaded !== nextState.geoTagUploaded
        || normalizeDayStatus(scheduleDoc.dayStatus) !== nextState.dayStatus;

    if (shouldUpdate) {
        await Schedule.findByIdAndUpdate(scheduleId, { $set: nextState });
    }

    return nextState;
};

const deriveScheduleLifecycleStatusFromAttendance = (attendance) => {
    const attendanceVerification = normalizeVerificationStatus(attendance?.verificationStatus, '');
    const geoVerification = normalizeVerificationStatus(attendance?.geoVerificationStatus, '');

    if (attendanceVerification === 'rejected') {
        return 'scheduled';
    }

    if (attendanceVerification === 'approved' && geoVerification === 'approved') {
        return 'COMPLETED';
    }

    if (attendanceVerification === 'approved') {
        return 'inprogress';
    }

    return 'inprogress';
};

const syncScheduleLifecycleStatusFromAttendance = async ({ scheduleId, attendance }) => {
    if (!scheduleId || !attendance) return null;
    const nextStatus = deriveScheduleLifecycleStatusFromAttendance(attendance);
    await Schedule.findByIdAndUpdate(scheduleId, { status: nextStatus });
    return nextStatus;
};

const emitAttendanceRealtimeUpdate = (req, payload = {}) => {
    const io = req?.app?.get?.('io');
    if (!io) return;
    io.emit('attendanceUpdate', payload);
};

const validateAssignedScheduleUpload = ({ schedule, trainerId, collegeId, dayNumber }) => {
    if (!schedule) {
        return { status: 404, message: 'Schedule not found' };
    }

    const scheduleTrainerId = toIdString(schedule.trainerId);
    if (!scheduleTrainerId) {
        return { status: 403, message: 'This day is not assigned to any trainer yet' };
    }

    if (trainerId && scheduleTrainerId !== toIdString(trainerId)) {
        return { status: 403, message: 'Trainer can only upload for the assigned day and batch' };
    }

    const scheduleCollegeId = toIdString(schedule.collegeId);
    if (collegeId && scheduleCollegeId && scheduleCollegeId !== toIdString(collegeId)) {
        return { status: 403, message: 'Trainer can only upload for the assigned batch and college' };
    }

    const requestedDayNumber = toDayNumber(dayNumber);
    const scheduledDayNumber = toDayNumber(schedule.dayNumber);
    if (requestedDayNumber && scheduledDayNumber && requestedDayNumber !== scheduledDayNumber) {
        return { status: 403, message: 'Trainer can only upload for the assigned day' };
    }

    return null;
};

const buildAllocatedDrivePathForSchedule = async (scheduleId) => {
    if (!scheduleId) return null;

    const schedule = await Schedule.findById(scheduleId)
        .select('companyId courseId collegeId departmentId dayNumber dayFolderName attendanceFolderName geoTagFolderName')
        .populate('companyId', 'name')
        .populate('courseId', 'title')
        .populate('collegeId', 'name')
        .populate('departmentId', 'name');

    if (!schedule) return null;

    const companyName = String(schedule?.companyId?.name || '').trim() || 'Company';
    const courseName = String(schedule?.courseId?.title || '').trim() || 'Course';
    const collegeName = String(schedule?.collegeId?.name || '').trim() || 'College';
    const departmentName = String(schedule?.departmentId?.name || '').trim() || 'Department';
    const safeDayNumber = toDayNumber(schedule?.dayNumber);
    const dayName = String(schedule?.dayFolderName || '').trim() || (safeDayNumber ? `Day_${safeDayNumber}` : 'Day');
    const attendanceFolderName = String(schedule?.attendanceFolderName || '').trim() || DRIVE_DAY_SUBFOLDERS.attendance;
    const geoTagFolderName = String(schedule?.geoTagFolderName || '').trim() || DRIVE_DAY_SUBFOLDERS.geoTag;

    const basePath = [companyName, courseName, collegeName, departmentName, dayName];
    return {
        basePath: basePath.join(' > '),
        attendancePath: [...basePath, attendanceFolderName].join(' > '),
        geoTagPath: [...basePath, geoTagFolderName].join(' > ')
    };
};

const resolveTrainerDriveCode = async (attendance) => {
    const rawTrainerId = attendance?.trainerId;
    if (!rawTrainerId) return 'TRAINER';

    if (typeof rawTrainerId === 'object' && rawTrainerId?.trainerId) {
        return String(rawTrainerId.trainerId).trim() || 'TRAINER';
    }

    const trainerLookupId = typeof rawTrainerId === 'object'
        ? (rawTrainerId._id || rawTrainerId.id || rawTrainerId)
        : rawTrainerId;
    const trainerDoc = await Trainer.findById(trainerLookupId).select('trainerId');
    return String(trainerDoc?.trainerId || '').trim() || `TRN_${toIdString(trainerLookupId).slice(-6)}`;
};

const buildDriveUploadFileName = ({ trainerCode, dayNumber, fieldName, file, index = 0 }) => {
    const safeTrainerCode = String(trainerCode || 'TRAINER').trim() || 'TRAINER';
    const safeDayNumber = toDayNumber(dayNumber) || 0;
    const extension = path.extname(file?.originalname || file?.path || '').toLowerCase() || '';
    const fieldNameToKindMap = {
        attendancePdf: 'Attendance',
        attendanceExcel: 'AttendanceSheet',
        studentsPhoto: 'StudentsPhoto',
        signature: 'CheckInSignature',
        photo: 'GeoProof',
        photos: 'GeoProof',
        image: 'GeoProof',
        images: 'GeoProof',
        checkOutGeoImage: 'GeoProof',
        activityPhotos: 'ActivityPhoto',
        activityVideos: 'ActivityVideo',
        checkOutSignature: 'CheckOutSignature'
    };
    const fileKind = fieldNameToKindMap[fieldName]
        || (resolveDriveSubFolderType(fieldName) === 'attendance' ? 'Attendance' : 'Geo');
    const suffix = index > 0 ? `_${index + 1}` : '';
    return `${safeTrainerCode}_Day${safeDayNumber}_${fileKind}${suffix}${extension}`;
};

const resolveBatchFolderNameFromSchedule = ({ college, department, course, fullSchedule }) => {
    const departmentName = String(department?.name || '').trim();
    const collegeName = String(college?.name || '').trim();
    const courseName = String(course?.title || '').trim();
    if (departmentName && collegeName) return `${collegeName}-${departmentName}`;
    if (departmentName) return departmentName;
    if (collegeName && courseName) return `${collegeName}-${courseName}`;
    if (collegeName) return `Batch_${collegeName}`;
    return `Batch_${fullSchedule?.departmentId || fullSchedule?.collegeId || 'GENERAL'}`;
};

const readDayFolderEntryFromDepartment = async ({ departmentId, dayNumber }) => {
    if (!departmentId || !dayNumber) return { department: null, dayEntry: null };

    const department = await Department.findById(departmentId).select('dayFolders');
    if (!department) return { department: null, dayEntry: null };

    const dayEntry = Array.isArray(department.dayFolders)
        ? department.dayFolders.find((item) => Number(item?.day) === Number(dayNumber)) || null
        : null;

    return { department, dayEntry };
};

const persistDepartmentDayFolderEntry = async ({
    department,
    dayNumber,
    dayFolder,
    attendanceFolder,
    geoTagFolder
}) => {
    if (!department || !dayNumber) return;

    const current = Array.isArray(department.dayFolders)
        ? department.dayFolders.map((item) => (typeof item?.toObject === 'function' ? item.toObject() : { ...item }))
        : [];
    const existingIndex = current.findIndex((item) => Number(item?.day) === Number(dayNumber));
    const existing = existingIndex >= 0 ? current[existingIndex] : {};

    const nextEntry = {
        ...existing,
        day: dayNumber,
        folderId: dayFolder?.id || existing.folderId || null,
        folderName: dayFolder?.name || existing.folderName || null,
        folderLink: dayFolder?.link || existing.folderLink || null,
        attendanceFolderId: attendanceFolder?.id || existing.attendanceFolderId || null,
        attendanceFolderName: attendanceFolder?.name || existing.attendanceFolderName || null,
        attendanceFolderLink: attendanceFolder?.link || existing.attendanceFolderLink || null,
        geoTagFolderId: geoTagFolder?.id || existing.geoTagFolderId || null,
        geoTagFolderName: geoTagFolder?.name || existing.geoTagFolderName || null,
        geoTagFolderLink: geoTagFolder?.link || existing.geoTagFolderLink || null
    };

    if (existingIndex >= 0) {
        current[existingIndex] = nextEntry;
    } else {
        current.push(nextEntry);
    }

    current.sort((a, b) => Number(a.day || 0) - Number(b.day || 0));
    department.dayFolders = current;
    await department.save();
};

const ensureScheduleDriveFolders = async ({ scheduleId, scheduleDoc }) => {
    if (!scheduleId) return null;

    const fullSchedule = scheduleDoc?.departmentId && scheduleDoc?.collegeId
        ? scheduleDoc
        : await Schedule.findById(scheduleId).select('companyId courseId collegeId departmentId dayNumber dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink');
    if (!fullSchedule?.collegeId) return null;

    const dayNumber = toDayNumber(fullSchedule.dayNumber);
    if (!Number.isFinite(dayNumber) || dayNumber <= 0) return null;

    const department = fullSchedule.departmentId
        ? await Department.findById(fullSchedule.departmentId).select('_id name companyId courseId collegeId dayFolders driveFolderId driveFolderName driveFolderLink')
        : null;
    const college = await College.findById(fullSchedule.collegeId).select('_id name companyId courseId driveFolderId driveFolderName driveFolderLink');
    if (!college) return null;

    const { Company, Course } = require('../models');
    const companyIdForLookup = department?.companyId || college?.companyId || fullSchedule?.companyId || null;
    const courseIdForLookup = department?.courseId || college?.courseId || fullSchedule?.courseId || null;
    const company = companyIdForLookup
        ? await Company.findById(companyIdForLookup).select('_id name driveFolderId driveFolderName driveFolderLink')
        : null;
    const course = courseIdForLookup
        ? await Course.findById(courseIdForLookup).select('_id title driveFolderId driveFolderName driveFolderLink')
        : null;

    const hierarchy = department?._id
        ? await ensureDepartmentHierarchy({
            company: company || { _id: companyIdForLookup, name: `Company_${companyIdForLookup}` },
            course: course || null,
            college,
            department,
            totalDays: 12,
        })
        : null;

    if (hierarchy?.departmentFolder?.id) {
        const dayFolders = toDepartmentDayFolders(hierarchy?.dayFoldersByDayNumber || {});
        if (dayFolders.length) {
            department.dayFolders = dayFolders;
        }
        department.driveFolderId = hierarchy.departmentFolder.id;
        department.driveFolderName = hierarchy.departmentFolder.name;
        department.driveFolderLink = hierarchy.departmentFolder.link;
        await department.save();

        const dayEntry = dayFolders.find((item) => Number(item.day) === dayNumber) || null;
        if (!dayEntry?.folderId) return null;

        const scheduleFolderState = {
            dayFolderId: dayEntry.folderId,
            dayFolderName: dayEntry.folderName || null,
            dayFolderLink: dayEntry.folderLink || null,
            attendanceFolderId: dayEntry.attendanceFolderId || null,
            attendanceFolderName: dayEntry.attendanceFolderName || null,
            attendanceFolderLink: dayEntry.attendanceFolderLink || null,
            geoTagFolderId: dayEntry.geoTagFolderId || null,
            geoTagFolderName: dayEntry.geoTagFolderName || null,
            geoTagFolderLink: dayEntry.geoTagFolderLink || null,
            driveFolderId: dayEntry.folderId,
            driveFolderName: dayEntry.folderName || null,
            driveFolderLink: dayEntry.folderLink || null,
        };

        await Schedule.findByIdAndUpdate(scheduleId, { $set: scheduleFolderState });
        return { ...scheduleFolderState, departmentId: fullSchedule.departmentId, dayNumber };
    }

    // Fallback path for legacy schedules that are missing department mapping.
    const rootFolder = await ensureTrainingRootFolder();
    if (!rootFolder?.id) return null;

    const companyFolder = await ensureDriveFolder({
        folderName: company?.name || `Company_${fullSchedule.companyId || college.companyId || 'UNASSIGNED'}`,
        parentFolderId: rootFolder.id,
    });
    const courseFolder = await ensureDriveFolder({
        folderName: course?.title || `Course_${fullSchedule.courseId || college.courseId || 'GENERAL'}`,
        parentFolderId: companyFolder.id,
    });
    const collegeFolder = await ensureDriveFolder({
        folderName: college?.name || `College_${fullSchedule.collegeId || 'GENERAL'}`,
        parentFolderId: courseFolder.id,
    });
    const batchFolder = await ensureDriveFolder({
        folderName: resolveBatchFolderNameFromSchedule({ college, department, course, fullSchedule }),
        parentFolderId: collegeFolder.id,
    });
    const dayFolder = await ensureDriveFolder({
        folderName: `Day_${dayNumber}`,
        parentFolderId: batchFolder.id,
    });
    const attendanceFolder = await ensureDriveFolder({
        folderName: DRIVE_DAY_SUBFOLDERS.attendance,
        parentFolderId: dayFolder.id,
    });
    const geoTagFolder = await ensureDriveFolder({
        folderName: DRIVE_DAY_SUBFOLDERS.geoTag,
        parentFolderId: dayFolder.id,
    });

    const scheduleFolderState = {
        dayFolderId: dayFolder.id,
        dayFolderName: dayFolder.name || `Day_${dayNumber}`,
        dayFolderLink: dayFolder.webViewLink || null,
        attendanceFolderId: attendanceFolder.id,
        attendanceFolderName: attendanceFolder.name || DRIVE_DAY_SUBFOLDERS.attendance,
        attendanceFolderLink: attendanceFolder.webViewLink || null,
        geoTagFolderId: geoTagFolder.id,
        geoTagFolderName: geoTagFolder.name || DRIVE_DAY_SUBFOLDERS.geoTag,
        geoTagFolderLink: geoTagFolder.webViewLink || null,
        driveFolderId: dayFolder.id,
        driveFolderName: dayFolder.name || `Day_${dayNumber}`,
        driveFolderLink: dayFolder.webViewLink || null,
    };

    if (department) {
        await persistDepartmentDayFolderEntry({
            department,
            dayNumber,
            dayFolder: { id: scheduleFolderState.dayFolderId, name: scheduleFolderState.dayFolderName, link: scheduleFolderState.dayFolderLink },
            attendanceFolder: { id: scheduleFolderState.attendanceFolderId, name: scheduleFolderState.attendanceFolderName, link: scheduleFolderState.attendanceFolderLink },
            geoTagFolder: { id: scheduleFolderState.geoTagFolderId, name: scheduleFolderState.geoTagFolderName, link: scheduleFolderState.geoTagFolderLink },
        });
    }

    await Schedule.findByIdAndUpdate(scheduleId, { $set: scheduleFolderState });
    return { ...scheduleFolderState, departmentId: fullSchedule.departmentId, dayNumber };
};

const uploadAttendanceFilesToDrive = async ({ filesByField, getTargetFolder, buildFileName }) => {
    const uploadedByField = {};
    const uploadedFiles = [];

    for (const [fieldName, fieldFiles] of Object.entries(filesByField || {})) {
        const normalizedFiles = Array.isArray(fieldFiles)
            ? fieldFiles.filter(file => file?.path)
            : [];
        if (!normalizedFiles.length) continue;
        const targetFolder = getTargetFolder(fieldName);
        if (!targetFolder?.id) continue;

        const fieldUploads = [];
        for (const [index, file] of normalizedFiles.entries()) {
            console.log(
                `[ATTENDANCE][DRIVE] Uploading field=${fieldName} file="${file.originalname || path.basename(file.path)}" to folder=${targetFolder.id} (${targetFolder.name || targetFolder.type || 'unknown'})`
            );
            const fileBuffer = await fs.promises.readFile(file.path);
            const uploaded = await uploadToDriveWithRetry({
                fileBuffer,
                mimeType: getFileMimeType(file),
                originalName: file.originalname || path.basename(file.path),
                folderId: targetFolder.id,
                fileName: typeof buildFileName === 'function'
                    ? buildFileName({ fieldName, file, index })
                    : undefined
            }, { attempts: 3, initialDelayMs: 500 });
            const driveAsset = {
                ...uploaded,
                fieldName,
                folderType: targetFolder.type,
                mimeType: getFileMimeType(file),
                originalName: file.originalname || null,
                localPath: file.path,
                uploadedAt: new Date().toISOString()
            };
            fieldUploads.push(driveAsset);
            uploadedFiles.push(driveAsset);
        }

        uploadedByField[fieldName] = fieldUploads;
    }

    return {
        syncedAt: new Date().toISOString(),
        filesByField: uploadedByField,
        files: uploadedFiles
    };
};

const persistScheduleDocumentsForDriveAssets = async ({ attendance, scheduleId, files }) => {
    if (!attendance || !scheduleId || !Array.isArray(files) || !files.length) return;
    const trainerId = attendance.trainerId || null;
    if (!trainerId) return;

    const scheduleObjectId = toObjectIdOrNull(scheduleId);
    const attendanceObjectId = toObjectIdOrNull(attendance._id);
    const trainerObjectId = toObjectIdOrNull(trainerId);
    if (!scheduleObjectId || !trainerObjectId) return;

    for (const file of files) {
        if (!file?.fileId) continue;
        const fileLink = file.webViewLink || file.fileUrl || file.downloadLink || null;
        if (!fileLink) continue;

        const updatePayload = {
            scheduleId: scheduleObjectId,
            attendanceId: attendanceObjectId,
            trainerId: trainerObjectId,
            fileType: toScheduleDocumentFileType(file.folderType),
            fileField: file.fieldName || null,
            fileName: file.fileName || file.originalName || null,
            fileUrl: fileLink
        };

        await ScheduleDocument.findOneAndUpdate(
            { driveFileId: file.fileId },
            {
                $set: updatePayload,
                $setOnInsert: {
                    driveFileId: file.fileId,
                    status: 'pending',
                    verifiedBy: null,
                    verifiedAt: null,
                    rejectReason: null
                }
            },
            {
                new: true,
                upsert: true,
                setDefaultsOnInsert: true
            }
        );
    }
};

const updateScheduleDocumentsVerificationStatus = async ({
    attendance,
    fileType,
    verificationStatus,
    verifiedBy,
    rejectReason
}) => {
    if (!attendance?.scheduleId || !fileType) return;
    const scheduleObjectId = toObjectIdOrNull(attendance.scheduleId);
    if (!scheduleObjectId) return;

    const status = toScheduleDocumentStatus(verificationStatus);
    const updatePayload = {
        status,
        verifiedAt: status === 'pending' ? null : new Date(),
        rejectReason: status === 'rejected' ? (rejectReason || null) : null
    };
    if (verifiedBy && mongoose.Types.ObjectId.isValid(verifiedBy)) {
        updatePayload.verifiedBy = verifiedBy;
    } else if (status === 'pending') {
        updatePayload.verifiedBy = null;
    }

    await ScheduleDocument.updateMany(
        { scheduleId: scheduleObjectId, fileType },
        { $set: updatePayload }
    );
};

const normalizeStoredLocalPath = (storedPath) => {
    if (!storedPath || typeof storedPath !== 'string') return null;
    const trimmed = storedPath.trim();
    if (!trimmed) return null;

    const absoluteCandidate = path.isAbsolute(trimmed)
        ? trimmed
        : path.resolve(process.cwd(), trimmed);
    if (fs.existsSync(absoluteCandidate)) return absoluteCandidate;

    const serverRelativeCandidate = path.resolve(__dirname, '..', trimmed.replace(/^[\\/]+/, ''));
    if (fs.existsSync(serverRelativeCandidate)) return serverRelativeCandidate;

    return null;
};

const toStoredFileObject = (storedPath, overrides = {}) => {
    const resolvedPath = normalizeStoredLocalPath(storedPath);
    if (!resolvedPath) return null;
    return {
        path: resolvedPath,
        originalname: overrides.originalname || path.basename(resolvedPath),
        mimetype: overrides.mimetype || undefined
    };
};

const collectAttendanceFilesForDriveSync = (attendance) => {
    if (!attendance) return {};

    const existingFiles = Array.isArray(attendance?.driveAssets?.files)
        ? attendance.driveAssets.files
        : [];
    const alreadySyncedLocalPaths = new Set(
        existingFiles
            .map((item) => normalizeStoredLocalPath(item?.localPath || item?.path || ''))
            .filter(Boolean)
    );
    const queuedLocalPaths = new Set();
    const isNotSyncedYet = (fileObj) => {
        const normalizedPath = normalizeStoredLocalPath(fileObj?.path || '');
        if (!normalizedPath) return false;
        if (alreadySyncedLocalPaths.has(normalizedPath)) return false;
        if (queuedLocalPaths.has(normalizedPath)) return false;
        queuedLocalPaths.add(normalizedPath);
        return true;
    };

    const filesByField = {};
    const pushFile = (fieldName, storedPath, overrides = {}) => {
        const fileObj = toStoredFileObject(storedPath, overrides);
        if (!fileObj || !isNotSyncedYet(fileObj)) return;
        if (!filesByField[fieldName]) filesByField[fieldName] = [];
        filesByField[fieldName].push(fileObj);
    };
    const pushMany = (fieldName, storedPaths, overrides = {}) => {
        if (!Array.isArray(storedPaths)) return;
        storedPaths.forEach((storedPath) => pushFile(fieldName, storedPath, overrides));
    };

    pushFile('attendancePdf', attendance.attendancePdfUrl, { mimetype: 'application/pdf' });
    pushFile('signature', attendance.signatureUrl);

    if (Array.isArray(attendance.studentsPhotoUrl)) {
        pushMany('studentsPhoto', attendance.studentsPhotoUrl);
    } else {
        pushFile('studentsPhoto', attendance.studentsPhotoUrl);
    }

    pushMany('checkOutGeoImage', attendance.checkOutGeoImageUrls);
    pushFile('checkOutGeoImage', attendance.checkOutGeoImageUrl);
    pushMany('activityPhotos', attendance.activityPhotos);
    pushMany('activityVideos', attendance.activityVideos);
    pushFile('checkOutSignature', attendance.checkOutSignatureUrl);

    if (attendance.attendanceExcelUrl) {
        const excelRef = String(attendance.attendanceExcelUrl).trim();
        const excelPath = normalizeStoredLocalPath(excelRef)
            || path.resolve(__dirname, '../uploads/attendance-sheets', excelRef);
        pushFile('attendanceExcel', excelPath, {
            originalname: path.basename(excelRef),
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
    }

    return filesByField;
};

const syncStoredAttendanceFilesToDrive = async (attendance, contextLabel) => {
    if (!attendance?.scheduleId) return;

    const filesByField = collectAttendanceFilesForDriveSync(attendance);
    if (!Object.keys(filesByField).length) return;

    await syncAttendanceFilesToDrive({
        attendance,
        scheduleId: attendance.scheduleId,
        filesByField,
        contextLabel
    });
    await attendance.save();
};

const syncAttendanceFilesToDrive = async ({
    attendance,
    scheduleId,
    schedule,
    filesByField,
    contextLabel = 'attendance upload'
}) => {
    if (!attendance || !filesByField || !Object.keys(filesByField).length) return;
    if (!isTrainingDriveEnabled()) return;

    const scheduleDoc = schedule?.driveFolderId || schedule?.dayFolderId
        ? schedule
        : await Schedule.findById(scheduleId).select('dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink departmentId dayNumber');
    const scheduleDayNumber = toDayNumber(scheduleDoc?.dayNumber);
    const hasScheduleFolderRefs = Boolean(
        scheduleDoc?.attendanceFolderId
        && scheduleDoc?.geoTagFolderId
        && (scheduleDoc?.dayFolderId || scheduleDoc?.driveFolderId)
    );
    const { department, dayEntry } = hasScheduleFolderRefs
        ? { department: null, dayEntry: null }
        : await readDayFolderEntryFromDepartment({
            departmentId: scheduleDoc?.departmentId,
            dayNumber: scheduleDayNumber
        });

    let dayFolderId = scheduleDoc?.dayFolderId || scheduleDoc?.driveFolderId || dayEntry?.folderId || null;
    if (scheduleId) {
        try {
            const ensured = await ensureScheduleDriveFolders({ scheduleId, scheduleDoc });
            if (ensured?.dayFolderId) {
                dayFolderId = ensured.dayFolderId;
                scheduleDoc.dayFolderId = ensured.dayFolderId;
                scheduleDoc.dayFolderName = ensured.dayFolderName;
                scheduleDoc.dayFolderLink = ensured.dayFolderLink;
                scheduleDoc.attendanceFolderId = ensured.attendanceFolderId;
                scheduleDoc.attendanceFolderName = ensured.attendanceFolderName;
                scheduleDoc.attendanceFolderLink = ensured.attendanceFolderLink;
                scheduleDoc.geoTagFolderId = ensured.geoTagFolderId;
                scheduleDoc.geoTagFolderName = ensured.geoTagFolderName;
                scheduleDoc.geoTagFolderLink = ensured.geoTagFolderLink;
                scheduleDoc.driveFolderId = ensured.dayFolderId;
                scheduleDoc.driveFolderName = ensured.dayFolderName;
                scheduleDoc.driveFolderLink = ensured.dayFolderLink;
            }
        } catch (ensureError) {
            console.error('[ATTENDANCE][DRIVE] Failed to ensure schedule drive folders:', ensureError.message);
        }
    }
    if (!dayFolderId) return;

    attendance.driveFolderId = dayFolderId;

    try {
        const attendanceFolder = scheduleDoc?.attendanceFolderId
            ? {
                id: scheduleDoc.attendanceFolderId,
                name: scheduleDoc.attendanceFolderName || DRIVE_DAY_SUBFOLDERS.attendance,
                webViewLink: scheduleDoc.attendanceFolderLink || null
            }
            : dayEntry?.attendanceFolderId
            ? {
                id: dayEntry.attendanceFolderId,
                name: dayEntry.attendanceFolderName || DRIVE_DAY_SUBFOLDERS.attendance,
                webViewLink: dayEntry.attendanceFolderLink || null
            }
            : await ensureDriveFolder({
                folderName: DRIVE_DAY_SUBFOLDERS.attendance,
                parentFolderId: dayFolderId
            });
        const geoTagFolder = scheduleDoc?.geoTagFolderId
            ? {
                id: scheduleDoc.geoTagFolderId,
                name: scheduleDoc.geoTagFolderName || DRIVE_DAY_SUBFOLDERS.geoTag,
                webViewLink: scheduleDoc.geoTagFolderLink || null
            }
            : dayEntry?.geoTagFolderId
            ? {
                id: dayEntry.geoTagFolderId,
                name: dayEntry.geoTagFolderName || DRIVE_DAY_SUBFOLDERS.geoTag,
                webViewLink: dayEntry.geoTagFolderLink || null
            }
            : await ensureDriveFolder({
                folderName: DRIVE_DAY_SUBFOLDERS.geoTag,
                parentFolderId: dayFolderId
            });
        const foldersByType = {
            attendance: toFolderAssetPayload(attendanceFolder, DRIVE_DAY_SUBFOLDERS.attendance),
            geoTag: toFolderAssetPayload(geoTagFolder, DRIVE_DAY_SUBFOLDERS.geoTag)
        };

        if (!hasScheduleFolderRefs) {
            await persistDepartmentDayFolderEntry({
                department,
                dayNumber: scheduleDayNumber,
                dayFolder: {
                    id: dayFolderId,
                    name: scheduleDoc?.dayFolderName || scheduleDoc?.driveFolderName || dayEntry?.folderName || null,
                    link: scheduleDoc?.dayFolderLink || scheduleDoc?.driveFolderLink || dayEntry?.folderLink || null
                },
                attendanceFolder: foldersByType.attendance,
                geoTagFolder: foldersByType.geoTag
            });
        }

        const nextScheduleFolderState = {
            dayFolderId,
            dayFolderName: scheduleDoc?.dayFolderName || scheduleDoc?.driveFolderName || dayEntry?.folderName || null,
            dayFolderLink: scheduleDoc?.dayFolderLink || scheduleDoc?.driveFolderLink || dayEntry?.folderLink || null,
            attendanceFolderId: foldersByType.attendance.id || null,
            attendanceFolderName: foldersByType.attendance.name || null,
            attendanceFolderLink: foldersByType.attendance.link || null,
            geoTagFolderId: foldersByType.geoTag.id || null,
            geoTagFolderName: foldersByType.geoTag.name || null,
            geoTagFolderLink: foldersByType.geoTag.link || null,
            driveFolderId: dayFolderId,
            driveFolderName: scheduleDoc?.driveFolderName || scheduleDoc?.dayFolderName || dayEntry?.folderName || null,
            driveFolderLink: scheduleDoc?.driveFolderLink || scheduleDoc?.dayFolderLink || dayEntry?.folderLink || null,
        };

        const shouldBackfillSchedule = !scheduleDoc?.dayFolderId
            || !scheduleDoc?.attendanceFolderId
            || !scheduleDoc?.geoTagFolderId
            || scheduleDoc?.driveFolderId !== nextScheduleFolderState.driveFolderId
            || scheduleDoc?.attendanceFolderId !== nextScheduleFolderState.attendanceFolderId
            || scheduleDoc?.geoTagFolderId !== nextScheduleFolderState.geoTagFolderId;

        if (shouldBackfillSchedule && scheduleId) {
            await Schedule.findByIdAndUpdate(scheduleId, { $set: nextScheduleFolderState });
        }

        const trainerCode = await resolveTrainerDriveCode(attendance);
        const syncResult = await uploadAttendanceFilesToDrive({
            filesByField,
            getTargetFolder: (fieldName) => foldersByType[resolveDriveSubFolderType(fieldName)] || null,
            buildFileName: ({ fieldName, file, index }) => buildDriveUploadFileName({
                trainerCode,
                dayNumber: scheduleDayNumber,
                fieldName,
                file,
                index
            })
        });

        if (!syncResult.files?.length) return;
        await persistScheduleDocumentsForDriveAssets({
            attendance,
            scheduleId,
            files: syncResult.files
        });
        attendance.driveAssets = mergeDriveAssets(attendance.driveAssets, {
            ...syncResult,
            dayFolderId,
            subFolders: foldersByType
        });
    } catch (error) {
        console.error(
            `[ATTENDANCE][DRIVE] Failed to sync ${contextLabel}:`,
            {
                message: error.message,
                scheduleId: scheduleId || null,
                attendanceId: attendance?._id || null,
                dayFolderId: dayFolderId || null,
                attendanceFolderId: scheduleDoc?.attendanceFolderId || dayEntry?.attendanceFolderId || null,
                geoTagFolderId: scheduleDoc?.geoTagFolderId || dayEntry?.geoTagFolderId || null
            }
        );
        attendance.driveAssets = markDriveSyncError(attendance.driveAssets, error);
    }
};

// Trainer uploads attendance with image and signature
// Check In
router.post('/check-in', uploadAttendance, async (req, res) => {
    try {
        console.log(`[CHECK-IN] Request received at ${new Date().toISOString()}`);
        console.log(`[CHECK-IN] Body keys: ${Object.keys(req.body).join(', ')}`);
        
        let { trainerId, collegeId, scheduleId, dayNumber, checkInTime, latitude, longitude, studentsPresent, studentsAbsent } = req.body;
        let checkInLocation = req.body.checkInLocation;

        if (req.files) {
            console.log(`[CHECK-IN] Files: ${Object.keys(req.files).join(', ')}`);
            if (req.files.attendancePdf) {
                console.log(`[CHECK-IN] PDF: ${req.files.attendancePdf[0].originalname}, Size: ${req.files.attendancePdf[0].size} bytes`);
            }
        }

        // Parse checkInLocation if it's a string (from FormData)
        if (typeof checkInLocation === 'string') {
            try {
                checkInLocation = JSON.parse(checkInLocation);
            } catch (e) {
                console.error('Error parsing checkInLocation:', e);
            }
        }

        // Validate required fields
        if (!trainerId || !collegeId || !scheduleId) {
            return res.status(400).json({
                success: false,
                message: 'Trainer ID, College ID, and Schedule ID are required'
            });
        }

        const schedule = await Schedule.findById(scheduleId).select('trainerId collegeId collegeLocation dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink departmentId dayNumber');
        if (!schedule) {
            return res.status(404).json({
                success: false,
                message: 'Schedule not found'
            });
        }

        const uploadAccessError = validateAssignedScheduleUpload({
            schedule,
            trainerId,
            collegeId,
            dayNumber
        });
        if (uploadAccessError) {
            return res.status(uploadAccessError.status).json({
                success: false,
                message: uploadAccessError.message
            });
        }

        // 1. DISTANCE VALIDATION (HAIVERSINE)
        try {
            if (schedule && schedule.collegeLocation && schedule.collegeLocation.lat && schedule.collegeLocation.lng) {
                const currentLat = checkInLocation?.lat || latitude;
                const currentLng = checkInLocation?.lng || longitude;

                if (currentLat && currentLng) {
                    const trainerLoc = { latitude: parseFloat(currentLat), longitude: parseFloat(currentLng) };
                    const collegeLoc = { latitude: schedule.collegeLocation.lat, longitude: schedule.collegeLocation.lng };
                    
                    console.log(`[CHECK-IN] Calculating distance: Trainer(${trainerLoc.latitude}, ${trainerLoc.longitude}) to College(${collegeLoc.latitude}, ${collegeLoc.longitude})`);
                    
                    const distance = haversine(trainerLoc, collegeLoc);

                    if (distance > 300) {
                        console.log(`[Geo-Fencing] Trainer is ${Math.round(distance)}m away (Validation Disabled)`);
                        // return res.status(400).json({
                        //     success: false,
                        //     message: `Access Denied: You are ${Math.round(distance)} meters away. Please be within 300m of the college campus to check in.`,
                        //     distance: Math.round(distance)
                        // });
                    }
                    
                    // Add distance to location data
                    if (checkInLocation) checkInLocation.distanceFromCollege = distance;
                }
            }
        } catch (distError) {
            console.error('[CHECK-IN] Distance calculation failed (non-blocking):', distError);
        }

        // LOCK: Prevent Check-In if Day is Completed
        // if (schedule.status === 'COMPLETED' || schedule.status === 'completed') {
        //      return res.status(400).json({
        //         success: false,
        //         message: 'This training day is already marked as COMPLETED. No further edits allowed.'
        //     });
        // }

        // Get file paths
        const attendancePdfUrl = req.files?.attendancePdf ? req.files.attendancePdf[0].path : null;
        const attendanceExcelUrl = req.files?.attendanceExcel ? req.files.attendanceExcel[0].path : null;

        // Parse student list if provided
        let students = [];
        if (req.body.studentList) {
            try {
                students = JSON.parse(req.body.studentList);
                
                // Auto-calculate counts if provided in the list
                if (students.length > 0) {
                     // Only override if not explicitly provided in body or if body has 0
                    if (!studentsPresent || parseInt(studentsPresent) === 0) {
                        studentsPresent = students.filter(s => s.status === 'Present').length;
                        studentsAbsent = students.filter(s => s.status === 'Absent').length;
                    }
                }
            } catch (e) {
                console.error('Error parsing studentList:', e);
            }
        }

        // Check for existing attendance (e.g. for re-check-in after rejection)
        console.log(`[CHECK-IN] Querying Attendance for scheduleId: ${scheduleId}`);
        let attendance = await Attendance.findOne({ scheduleId });

        if (attendance) {
            console.log(`[CHECK-IN] Updating existing attendance ID: ${attendance._id}`);
            // Update existing record
            attendance.checkInTime = checkInTime || new Date().toTimeString().split(' ')[0];
            if (attendancePdfUrl) attendance.attendancePdfUrl = attendancePdfUrl;
            if (attendanceExcelUrl) attendance.attendanceExcelUrl = attendanceExcelUrl;
            if (latitude) attendance.latitude = latitude;
            if (longitude) attendance.longitude = longitude;
            
            // New Structured Location
            if (checkInLocation) {
                attendance.checkIn = {
                    time: new Date(),
                    location: checkInLocation
                };
            }

            attendance.studentsPresent = studentsPresent || 0;
            attendance.studentsAbsent = studentsAbsent || 0;
            attendance.students = students; // Save student list
            attendance.verificationStatus = 'pending'; // Reset status to pending
            attendance.status = 'Pending';
            attendance.rejectionReason = undefined; // Clear previous rejection reason
            if (req.body.syllabus) attendance.syllabus = req.body.syllabus; // Save syllabus
        } else {
            console.log(`[CHECK-IN] Creating new attendance record`);
            // Create new attendance record
            attendance = new Attendance({
                trainerId,
                collegeId,
                scheduleId,
                dayNumber: dayNumber || null,
                date: new Date(),
                checkInTime: checkInTime || new Date().toTimeString().split(' ')[0],
                checkIn: checkInLocation ? {
                    time: new Date(),
                    location: checkInLocation
                } : undefined,
                attendancePdfUrl,
                attendanceExcelUrl,
                latitude: latitude || null,
                longitude: longitude || null,
                uploadedBy: 'trainer',
                isManualEntry: false,
                status: 'Pending',
                studentsPresent: studentsPresent || 0,
                studentsAbsent: studentsAbsent || 0,
                students: students, // Save student list
                verificationStatus: 'pending',
                syllabus: req.body.syllabus || null // Save syllabus
            });
        }

        await syncAttendanceFilesToDrive({
            attendance,
            scheduleId,
            schedule,
            filesByField: req.files,
            contextLabel: 'check-in'
        });
        await attendance.save();

        console.log(`[CHECK-IN] Updating Schedule ID: ${scheduleId}`);
        // Update Schedule status to 'inprogress' and update subject if provided
        const scheduleUpdate = { status: 'inprogress' };
        if (req.body.syllabus) {
            scheduleUpdate.subject = req.body.syllabus;
        }
        await Schedule.findByIdAndUpdate(scheduleId, scheduleUpdate);
        const dayState = await syncScheduleDayState({ scheduleId, attendance });
        emitAttendanceRealtimeUpdate(req, {
            type: 'DAY_STATUS_UPDATE',
            scheduleId,
            attendanceId: attendance._id,
            dayStatus: dayState?.dayStatus || null,
            attendanceUploaded: dayState?.attendanceUploaded ?? null,
            geoTagUploaded: dayState?.geoTagUploaded ?? null,
            message: `Day status updated to ${dayState?.dayStatus || 'pending'}`
        });

        console.log(`[CHECK-IN] Successful for ID: ${attendance._id}`);

        // Notify Admins
        try {
            const superAdmins = await User.find({ role: 'SuperAdmin' });
            const io = req.app.get('io');
            superAdmins.forEach(admin => {
                sendNotification(io, {
                    userId: admin._id,
                    role: admin.role,
                    title: 'New Attendance Check-In',
                    message: `A trainer has checked in.`,
                    type: 'Attendance',
                    link: '/spoc/attendance' 
                });
            });
        } catch (notifyErr) {
            console.error('Failed to dispatch check-in notification:', notifyErr);
        }

        res.status(201).json({
            success: true,
            message: attendance?.driveAssets?.lastSyncError
                ? 'Check-in saved, but Drive sync failed'
                : 'Check-in successful',
            driveSync: {
                synced: !attendance?.driveAssets?.lastSyncError,
                error: attendance?.driveAssets?.lastSyncError || null
            },
            data: attendance
        });
    } catch (error) {
        console.error('Error during check-in:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check in',
            error: error.message
        });
    }
});

const uploadSingleGeoImageHandler = async (req, res) => {
    let uploadImageStage = 'initializing request';

    try {
        uploadImageStage = 'reading request payload';
        const rawTrainerId = String(req.body?.trainerId || '').trim();
        const assignedDate = normalizeAssignedDateInput(req.body?.assignedDate);
        const imageIndex = Number.parseInt(req.body?.index, 10);

        if (!req.file?.path) {
            return res.status(400).json({
                success: false,
                message: 'GeoTag image is required'
            });
        }

        if (!rawTrainerId) {
            return res.status(400).json({
                success: false,
                message: 'trainerId is required'
            });
        }

        if (!assignedDate) {
            return res.status(400).json({
                success: false,
                message: 'assignedDate must be a valid YYYY-MM-DD value'
            });
        }

        if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex > 2) {
            return res.status(400).json({
                success: false,
                message: 'index must be 0, 1, or 2'
            });
        }

        uploadImageStage = 'resolving trainer';
        let trainer = null;
        const trainerObjectId = toObjectIdOrNull(rawTrainerId);
        if (trainerObjectId) {
            trainer = await Trainer.findById(trainerObjectId).select('_id trainerId');
        }
        if (!trainer) {
            trainer = await Trainer.findOne({ trainerId: rawTrainerId }).select('_id trainerId');
        }

        if (!trainer) {
            return res.status(404).json({
                success: false,
                message: 'Trainer not found'
            });
        }

        uploadImageStage = 'loading assigned schedule';
        const candidateSchedules = await Schedule.find({ trainerId: trainer._id })
            .select('trainerId collegeId collegeLocation dayNumber status scheduledDate')
            .sort({ scheduledDate: -1 });
        const schedule = candidateSchedules.find(
            (item) => toZonedDateKey(item?.scheduledDate) === assignedDate
        ) || null;

        if (!schedule) {
            return res.status(404).json({
                success: false,
                message: 'Assigned schedule not found for this trainer and date'
            });
        }

        if (!schedule?.collegeLocation?.lat || !schedule?.collegeLocation?.lng) {
            return res.status(400).json({
                success: false,
                message: 'College location is missing, so GeoTag validation cannot be completed.'
            });
        }

        uploadImageStage = 'loading attendance record';
        const attendance = await Attendance.findOne({ scheduleId: schedule._id }).sort({ createdAt: -1 });
        if (!attendance) {
            return res.status(404).json({
                success: false,
                message: 'Attendance record not found for this trainer and date'
            });
        }

        uploadImageStage = 'extracting exif data';
        const geoData = getGeoTagData(req.file.path);
        const validation = geoData
            ? verifyGeoTag({
                geoData,
                assignedDate,
                collegeLocation: schedule.collegeLocation,
                maxRadiusKm: CHECK_OUT_ALLOWED_GEO_RANGE_METERS / 1000,
                businessTimeZone: ATTENDANCE_BUSINESS_TIMEZONE
            })
            : {
                status: 'PENDING',
                reason: 'No GPS found',
                distance: null,
                latitude: null,
                longitude: null,
                timestamp: null
            };

        const normalizedImageData = {
            image: path.basename(req.file.path),
            latitude: Number.isFinite(geoData?.latitude) ? geoData.latitude : null,
            longitude: Number.isFinite(geoData?.longitude) ? geoData.longitude : null,
            distance: Number.isFinite(validation?.distance) ? Number(validation.distance.toFixed(2)) : null,
            status: validation.status === 'COMPLETED' ? 'VERIFIED' : 'PENDING'
        };

        const uploadedPhotoPayload = {
            url: req.file.path,
            uploadedAt: new Date(),
            validationStatus: normalizedImageData.status === 'VERIFIED' ? 'verified' : 'pending',
            validationReason: normalizedImageData.status === 'VERIFIED' ? null : (validation.reason || 'No GPS found'),
            latitude: normalizedImageData.latitude,
            longitude: normalizedImageData.longitude,
            capturedAt: validation?.timestamp ? new Date(validation.timestamp * 1000) : null,
            distanceKm: normalizedImageData.distance
        };

        uploadImageStage = 'updating attendance image slots';
        const existingCheckOut = attendance.checkOut && typeof attendance.checkOut.toObject === 'function'
            ? attendance.checkOut.toObject()
            : (attendance.checkOut || {});
        const imageSlots = ensureFixedLengthSlotArray(
            Array.isArray(attendance.images) && attendance.images.length
                ? attendance.images
                : existingCheckOut.images,
            3,
            buildPendingCheckOutImageSlot
        );
        const photoSlots = ensureFixedLengthSlotArray(existingCheckOut.photos, 3, buildPendingCheckOutPhotoSlot);

        const existingImageSlot = imageSlots[imageIndex];
        if (
            String(existingImageSlot?.status || '').trim().toUpperCase() === 'VERIFIED'
            && String(existingImageSlot?.image || '').trim()
        ) {
            if (req.file?.path && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            return res.status(409).json({
                success: false,
                message: `Image ${imageIndex + 1} is already verified and cannot be replaced`
            });
        }

        imageSlots[imageIndex] = normalizedImageData;
        photoSlots[imageIndex] = uploadedPhotoPayload;

        const nextFinalStatus = deriveUploadedImageFinalStatus(imageSlots);
        const uploadedPhotoUrls = photoSlots
            .map((item) => item?.url)
            .filter((value) => typeof value === 'string' && value.trim());

        attendance.assignedDate = assignedDate;
        attendance.images = imageSlots;
        attendance.finalStatus = nextFinalStatus;
        attendance.checkOutGeoImageUrl = uploadedPhotoUrls[0] || null;
        attendance.checkOutGeoImageUrls = uploadedPhotoUrls;
        attendance.checkOut = {
            ...existingCheckOut,
            finalStatus: nextFinalStatus,
            images: imageSlots,
            photos: photoSlots
        };

        await attendance.save();

        return res.json({
            success: true,
            message: validation.reason || (normalizedImageData.status === 'VERIFIED' ? 'Image verified' : 'Image pending'),
            data: normalizedImageData,
            images: attendance.images,
            finalStatus: attendance.finalStatus,
            checkOut: attendance.checkOut
        });
    } catch (err) {
        console.error(`Error during upload-image [stage=${uploadImageStage}]:`, err);
        return res.status(500).json({
            success: false,
            message: `Failed to upload image during ${uploadImageStage}`,
            error: err.message,
            stage: uploadImageStage
        });
    }
};

router.post('/upload-image', uploadManual, uploadSingleGeoImageHandler);

// Check Out
router.post('/check-out', uploadAttendance, async (req, res) => {
    let checkOutStage = 'initializing request';
    try {
        console.log(`[CHECK-OUT] Request received at ${new Date().toISOString()}`);
        console.log(`[CHECK-OUT] Body keys: ${Object.keys(req.body || {}).join(', ')}`);
        console.log(`[CHECK-OUT] Files: ${Object.keys(req.files || {}).join(', ')}`);

        checkOutStage = 'reading request payload';
        const { scheduleId, trainerId, collegeId, dayNumber, checkOutTime, latitude, longitude, location } = req.body;
        let checkOutLocation = req.body.checkOutLocation;

        // Parse checkInLocation if it's a string (from FormData)
        if (typeof checkOutLocation === 'string') {
            checkOutStage = 'parsing check-out location';
            try {
                checkOutLocation = JSON.parse(checkOutLocation);
            } catch (e) {
                console.error('Error parsing checkOutLocation:', e);
            }
        }

        if (!scheduleId) {
            return res.status(400).json({
                success: false,
                message: 'Schedule ID is required'
            });
        }

        checkOutStage = 'loading schedule';
        const schedule = await Schedule.findById(scheduleId).select('trainerId collegeId collegeLocation dayNumber status scheduledDate');
        let currentDistanceMeters = null;
        const currentLat = req.body.lat || checkOutLocation?.lat || latitude;
        const currentLng = req.body.lng || checkOutLocation?.lng || longitude;

        if (!schedule?.scheduledDate) {
            return res.status(400).json({
                success: false,
                message: 'Assigned date is missing for this training day. Please contact admin.'
            });
        }

        const assignedDateKey = toZonedDateKey(schedule.scheduledDate);
        if (!assignedDateKey) {
            return res.status(400).json({
                success: false,
                message: 'Unable to validate the assigned date for this check-out.'
            });
        }

        if (!schedule?.collegeLocation?.lat || !schedule?.collegeLocation?.lng) {
            return res.status(400).json({
                success: false,
                message: 'College location is missing, so GeoTag validation cannot be completed.'
            });
        }

        if (currentLat && currentLng) {
            const trainerLoc = { latitude: parseFloat(currentLat), longitude: parseFloat(currentLng) };
            const collegeLoc = { latitude: schedule.collegeLocation.lat, longitude: schedule.collegeLocation.lng };
            currentDistanceMeters = haversine(trainerLoc, collegeLoc);

            if (!Number.isFinite(currentDistanceMeters)) {
                currentDistanceMeters = null;
            }
        }

        // LOCK: Prevent Check-Out if Day is Completed
        // if (schedule.status === 'COMPLETED' || schedule.status === 'completed') {
        //      return res.status(400).json({
        //         success: false,
        //         message: 'This training day is already marked as COMPLETED. No further edits allowed.'
        //     });
        // }

        // Find attendance record for this schedule
        checkOutStage = 'loading attendance';
        const attendance = await Attendance.findOne({ scheduleId });

        if (!attendance) {
            return res.status(404).json({
                success: false,
                message: 'Attendance record not found for this schedule'
            });
        }

        const uploadAccessError = validateAssignedScheduleUpload({
            schedule,
            trainerId: trainerId || attendance.trainerId,
            collegeId: collegeId || attendance.collegeId,
            dayNumber: dayNumber || attendance.dayNumber
        });
        if (uploadAccessError) {
            return res.status(uploadAccessError.status).json({
                success: false,
                message: uploadAccessError.message
            });
        }

        const existingCheckOut = attendance.checkOut && typeof attendance.checkOut.toObject === 'function'
            ? attendance.checkOut.toObject()
            : (attendance.checkOut || {});

        // Get file paths
        checkOutStage = 'processing uploaded geo evidence';
        const photoFiles = [...(req.files?.photo || []), ...(req.files?.checkOutGeoImage || [])].slice(0, 3);
        let photoPaths = photoFiles.map(file => file.path);
        let imageGeoValidations = [];

        if (photoPaths.length > 0 && photoPaths.length !== 3) {
            return res.status(400).json({
                success: false,
                message: 'Exactly 3 GeoTag images are required to complete check-out.'
            });
        }

        if (photoPaths.length === 0) {
            const persistedImageSlots = ensureFixedLengthSlotArray(
                Array.isArray(attendance.images) && attendance.images.length
                    ? attendance.images
                    : existingCheckOut.images,
                3,
                buildPendingCheckOutImageSlot
            );
            const persistedPhotoSlots = ensureFixedLengthSlotArray(
                existingCheckOut.photos,
                3,
                buildPendingCheckOutPhotoSlot
            );
            const uploadedSlotCount = persistedImageSlots.filter((item) => String(item?.image || '').trim()).length;

            if (uploadedSlotCount !== 3) {
                return res.status(400).json({
                    success: false,
                    message: 'Upload all 3 GeoTag images before submitting check-out.'
                });
            }

            photoPaths = persistedPhotoSlots
                .map((item) => item?.url)
                .filter((value) => typeof value === 'string' && value.trim());

            imageGeoValidations = persistedImageSlots.map((item, index) => {
                const persistedPhoto = persistedPhotoSlots[index] || {};
                const normalizedStatus = String(item?.status || '').trim().toUpperCase();
                const capturedAt = persistedPhoto?.capturedAt ? new Date(persistedPhoto.capturedAt) : null;

                return {
                    imageIndex: index + 1,
                    filePath: persistedPhoto?.url || item?.image || null,
                    status: normalizedStatus === 'VERIFIED' ? 'COMPLETED' : 'PENDING',
                    reason:
                        normalizedStatus === 'VERIFIED'
                            ? 'Check-out completed'
                            : (persistedPhoto?.validationReason || 'Pending verification'),
                    distance: Number.isFinite(item?.distance) ? item.distance : (Number.isFinite(persistedPhoto?.distanceKm) ? persistedPhoto.distanceKm : null),
                    timestamp: capturedAt && !Number.isNaN(capturedAt.getTime())
                        ? Math.floor(capturedAt.getTime() / 1000)
                        : null,
                    latitude: Number.isFinite(item?.latitude) ? item.latitude : (Number.isFinite(persistedPhoto?.latitude) ? persistedPhoto.latitude : null),
                    longitude: Number.isFinite(item?.longitude) ? item.longitude : (Number.isFinite(persistedPhoto?.longitude) ? persistedPhoto.longitude : null),
                };
            });
        } else {
            imageGeoValidations = photoPaths.map((photoPath, index) => {
                const geoData = getGeoTagData(photoPath);
                const validation = verifyGeoTag({
                    geoData,
                    assignedDate: schedule.scheduledDate,
                    collegeLocation: schedule.collegeLocation,
                    maxRadiusKm: CHECK_OUT_ALLOWED_GEO_RANGE_METERS / 1000,
                    businessTimeZone: ATTENDANCE_BUSINESS_TIMEZONE
                });

                return {
                    imageIndex: index + 1,
                    filePath: photoPath,
                    ...validation
                };
            });
        }
        const pendingImageValidations = imageGeoValidations.filter((item) => item.status !== 'COMPLETED');
        const checkOutValidationErrors = pendingImageValidations.map(
            (item) => `Image ${item.imageIndex}: ${item.reason}`
        );
        const normalizedCheckOutImages = imageGeoValidations.map((item) => ({
            image: item.filePath ? path.basename(item.filePath) : null,
            latitude: Number.isFinite(item.latitude) ? item.latitude : null,
            longitude: Number.isFinite(item.longitude) ? item.longitude : null,
            distance: Number.isFinite(item.distance) ? Number(item.distance.toFixed(2)) : null,
            status: item.status === 'COMPLETED' ? 'VERIFIED' : 'PENDING'
        }));

        // Update attendance
        checkOutStage = 'updating attendance fields';
        attendance.assignedDate = assignedDateKey;
        attendance.checkOutTime = checkOutTime || new Date().toTimeString().split(' ')[0];
        
        if (photoPaths.length > 0) {
            attendance.checkOutGeoImageUrl = photoPaths[0];
            attendance.checkOutGeoImageUrls = photoPaths;
        }


        // Handle optional activity media
        if (req.files?.activityPhotos) {
            attendance.activityPhotos = [...(attendance.activityPhotos || []), ...req.files.activityPhotos.map(f => f.path)];
        }
        if (req.files?.activityVideos) {
            attendance.activityVideos = [...(attendance.activityVideos || []), ...req.files.activityVideos.map(f => f.path)];
        }

        const checkOutAutoApproved = imageGeoValidations.length === 3 && pendingImageValidations.length === 0;
        const firstImageWithLocation = imageGeoValidations.find(
            (item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
        );
        const summaryDistanceMeters = Number.isFinite(currentDistanceMeters)
            ? currentDistanceMeters
            : Number.isFinite(firstImageWithLocation?.distance)
                ? firstImageWithLocation.distance * 1000
                : null;

        // Structured Geo-Tag (ANTI-FAKE)
        attendance.checkOut = {
            time: new Date(),
            finalStatus: checkOutAutoApproved ? 'COMPLETED' : 'PENDING',
            location: {
                lat: req.body.lat || checkOutLocation?.lat || latitude || firstImageWithLocation?.latitude || null,
                lng: req.body.lng || checkOutLocation?.lng || longitude || firstImageWithLocation?.longitude || null,
                accuracy: req.body.accuracy || checkOutLocation?.accuracy,
                address: req.body.address || checkOutLocation?.address || "College Campus",
                distanceFromCollege: summaryDistanceMeters
            },
            images: normalizedCheckOutImages,
            photos: imageGeoValidations.map((item) => ({
                url: item.filePath,
                uploadedAt: new Date(),
                validationStatus: item.status === 'COMPLETED' ? 'verified' : 'pending',
                validationReason: item.status === 'COMPLETED' ? null : item.reason,
                latitude: item.latitude,
                longitude: item.longitude,
                capturedAt: item.timestamp ? new Date(item.timestamp * 1000) : null,
                distanceKm: Number.isFinite(item.distance) ? item.distance : null,
            }))
        };
        attendance.images = normalizedCheckOutImages;
        attendance.finalStatus = checkOutAutoApproved ? 'COMPLETED' : 'PENDING';

        attendance.geoVerificationStatus = checkOutAutoApproved ? 'approved' : 'pending';
        attendance.geoValidationComment = checkOutValidationErrors.length ? checkOutValidationErrors.join(' ') : null;
        attendance.status = checkOutAutoApproved ? 'Present' : 'Pending';
        attendance.completedAt = checkOutAutoApproved ? new Date() : null;

        checkOutStage = 'syncing files to Google Drive';
        await syncAttendanceFilesToDrive({
            attendance,
            scheduleId,
            schedule,
            filesByField: req.files,
            contextLabel: 'check-out'
        });

        checkOutStage = 'saving attendance record';
        await attendance.save();

        checkOutStage = 'updating schedule status';
        await syncScheduleLifecycleStatusFromAttendance({
            scheduleId,
            attendance
        });
        checkOutStage = 'syncing day state';
        const dayState = await syncScheduleDayState({ scheduleId, attendance });
        checkOutStage = 'emitting realtime update';
        emitAttendanceRealtimeUpdate(req, {
            type: 'DAY_STATUS_UPDATE',
            scheduleId,
            attendanceId: attendance._id,
            dayStatus: dayState?.dayStatus || null,
            attendanceUploaded: dayState?.attendanceUploaded ?? null,
            geoTagUploaded: dayState?.geoTagUploaded ?? null,
            message: `Day status updated to ${dayState?.dayStatus || 'pending'}`
        });

        // Notify Admins
        try {
            const superAdmins = await User.find({ role: 'SuperAdmin' });
            const io = req.app.get('io');
            superAdmins.forEach(admin => {
                sendNotification(io, {
                    userId: admin._id,
                    role: admin.role,
                    title: 'New Attendance Check-Out',
                    message: `A trainer has checked out.`,
                    type: 'Attendance',
                    link: '/spoc/attendance' 
                });
            });
        } catch (notifyErr) {
            console.error('Failed to dispatch check-out notification:', notifyErr);
        }

        res.json({
            success: true,
            message: attendance?.driveAssets?.lastSyncError
                ? `Check-out saved, but Drive sync failed. Auto status: ${checkOutAutoApproved ? 'COMPLETED' : 'PENDING'}`
                : `Check-out saved. Auto status: ${checkOutAutoApproved ? 'COMPLETED' : 'PENDING'}`,
            driveSync: {
                synced: !attendance?.driveAssets?.lastSyncError,
                error: attendance?.driveAssets?.lastSyncError || null
            },
            autoValidation: {
                status: checkOutAutoApproved ? 'completed' : 'pending',
                reasons: checkOutValidationErrors,
                verifiedImages: imageGeoValidations.filter((item) => item.status === 'COMPLETED').length,
                totalImages: imageGeoValidations.length,
                imageGeoTags: imageGeoValidations.map((item) => ({
                    imageIndex: item.imageIndex,
                    status: item.status === 'COMPLETED' ? 'verified' : 'pending',
                    reason: item.reason || null,
                    timestamp: item.timestamp ?? null,
                    latitude: item.latitude,
                    longitude: item.longitude,
                    distance: item.distance
                }))
            },
            checkoutRecord: {
                trainerId: attendance.trainerId,
                assignedDate: attendance.assignedDate,
                images: attendance.images,
                finalStatus: attendance.finalStatus
            },
            data: attendance
        });
    } catch (error) {
        console.error(`Error during check-out [stage=${checkOutStage}]:`, error);
        res.status(500).json({
            success: false,
            message: `Failed to check out during ${checkOutStage}`,
            error: error.message,
            stage: checkOutStage
        });
    }
});

// Get attendance by schedule ID
router.get('/schedule/:scheduleId', async (req, res) => {
    try {
        const attendance = await Attendance.find({ scheduleId: req.params.scheduleId })
            .populate('trainerId')
            .populate('collegeId')
            .populate('verifiedBy', 'id name')
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            data: attendance
        });
    } catch (error) {
        console.error('Error fetching attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance',
            error: error.message
        });
    }
});

// Get attendance by trainer ID
router.get('/trainer/:trainerId', async (req, res) => {
    try {
        const { month, year } = req.query;
        let filter = { trainerId: req.params.trainerId };

        if (month && year) {
            const startDate = new Date(year, month - 1, 1);
            const endDate = new Date(year, month, 0);
            filter.date = { $gte: startDate, $lte: endDate };
        }

        const attendance = await Attendance.find(filter)
            .populate('collegeId', 'name')
            .populate({
                path: 'scheduleId',
                populate: [
                    { path: 'courseId', select: 'title' },
                    { path: 'collegeId', select: 'name' }
                ]
            })
            .sort({ date: -1 });

        res.json({
            success: true,
            count: attendance.length,
            data: attendance
        });
    } catch (error) {
        console.error('Error fetching trainer attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance',
            error: error.message
        });
    }
});

// Get all attendance records (for SPOC Admin verification page)
router.get('/', async (req, res) => {
    try {
        const attendance = await Attendance.find({})
            .populate({
                path: 'trainerId',
                populate: { path: 'userId', select: 'name email' }
            })
            .populate({
                path: 'collegeId',
                select: 'name latitude longitude companyId',
                populate: { path: 'companyId', select: 'name' }
            })
            .populate({
                path: 'scheduleId',
                populate: { path: 'courseId', select: 'name' }
            })
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            data: attendance
        });
    } catch (error) {
        console.error('Error fetching attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance',
            error: error.message
        });
    }
});

// Get pending attendance for verification
router.get('/pending', async (req, res) => {
    try {
        const attendance = await Attendance.find({ verificationStatus: 'pending' })
            .populate({
                path: 'trainerId',
                populate: { path: 'userId', select: 'name email' }
            })
            .populate('collegeId', 'name latitude longitude company')
            .populate({
                path: 'scheduleId',
                populate: { path: 'courseId' } // Changed from 'course' to 'courseId' if that's the field name
            })
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            data: attendance
        });
    } catch (error) {
        console.error('Error fetching pending attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch pending attendance',
            error: error.message
        });
    }
});

// Get uploaded drive documents tracked per schedule/day
router.get('/documents', async (req, res) => {
    try {
        const { scheduleId, attendanceId, trainerId, status, fileType } = req.query;
        const filters = {};

        const objectIdParams = [
            ['scheduleId', scheduleId],
            ['attendanceId', attendanceId],
            ['trainerId', trainerId]
        ];
        for (const [key, value] of objectIdParams) {
            if (!value) continue;
            if (!mongoose.Types.ObjectId.isValid(value)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid ${key}`
                });
            }
            filters[key] = value;
        }

        if (status) {
            const normalizedStatus = String(status).trim().toLowerCase();
            if (!['pending', 'verified', 'rejected'].includes(normalizedStatus)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid status filter. Use pending, verified, or rejected.'
                });
            }
            filters.status = normalizedStatus;
        }

        if (fileType) {
            const normalizedFileType = String(fileType).trim().toLowerCase();
            if (!['attendance', 'geotag', 'other'].includes(normalizedFileType)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid fileType filter. Use attendance, geotag, or other.'
                });
            }
            filters.fileType = normalizedFileType;
        }

        const documents = await ScheduleDocument.find(filters)
            .populate('attendanceId', 'verificationStatus geoVerificationStatus status date')
            .populate({
                path: 'trainerId',
                select: 'userId trainerCode',
                populate: { path: 'userId', select: 'name email' }
            })
            .populate('scheduleId', 'companyId courseId collegeId departmentId dayNumber scheduledDate startTime endTime status')
            .populate('verifiedBy', 'name email role')
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            count: documents.length,
            data: documents
        });
    } catch (error) {
        console.error('Error fetching attendance documents:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance documents',
            error: error.message
        });
    }
});

// SPOC verifies uploaded document
router.post('/verify-document', async (req, res) => {
    try {
        const { documentId, spocId } = req.body;
        if (!documentId || !mongoose.Types.ObjectId.isValid(documentId)) {
            return res.status(400).json({
                success: false,
                message: 'Valid documentId is required'
            });
        }

        const verifiedBy = spocId || req.user?.id || null;
        if (verifiedBy && !mongoose.Types.ObjectId.isValid(verifiedBy)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid spocId'
            });
        }

        const document = await ScheduleDocument.findById(documentId);
        if (!document) {
            return res.status(404).json({
                success: false,
                message: 'Document not found'
            });
        }

        document.status = 'verified';
        document.verifiedBy = verifiedBy || null;
        document.verifiedAt = new Date();
        document.rejectReason = null;
        await document.save();

        if (document.scheduleId) {
            const attendance = document.attendanceId
                ? await Attendance.findById(document.attendanceId)
                : await Attendance.findOne({ scheduleId: document.scheduleId }).sort({ createdAt: -1 });
            const dayState = await syncScheduleDayState({
                scheduleId: document.scheduleId,
                attendance
            });
            emitAttendanceRealtimeUpdate(req, {
                type: 'DOCUMENT_VERIFICATION_UPDATE',
                scheduleId: document.scheduleId,
                attendanceId: document.attendanceId || null,
                dayStatus: dayState?.dayStatus || null,
                attendanceUploaded: dayState?.attendanceUploaded ?? null,
                geoTagUploaded: dayState?.geoTagUploaded ?? null,
                message: 'Document verified successfully'
            });
        }

        res.json({
            success: true,
            message: 'Document verified successfully',
            data: document
        });
    } catch (error) {
        console.error('Error verifying attendance document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to verify document',
            error: error.message
        });
    }
});

// SPOC rejects uploaded document
router.post('/reject-document', async (req, res) => {
    try {
        const { documentId, spocId, rejectReason } = req.body;
        if (!documentId || !mongoose.Types.ObjectId.isValid(documentId)) {
            return res.status(400).json({
                success: false,
                message: 'Valid documentId is required'
            });
        }

        const verifiedBy = spocId || req.user?.id || null;
        if (verifiedBy && !mongoose.Types.ObjectId.isValid(verifiedBy)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid spocId'
            });
        }

        const document = await ScheduleDocument.findById(documentId);
        if (!document) {
            return res.status(404).json({
                success: false,
                message: 'Document not found'
            });
        }

        document.status = 'rejected';
        document.verifiedBy = verifiedBy || null;
        document.verifiedAt = new Date();
        document.rejectReason = rejectReason || 'Rejected by SPOC';
        await document.save();

        if (document.scheduleId) {
            const attendance = document.attendanceId
                ? await Attendance.findById(document.attendanceId)
                : await Attendance.findOne({ scheduleId: document.scheduleId }).sort({ createdAt: -1 });
            const dayState = await syncScheduleDayState({
                scheduleId: document.scheduleId,
                attendance,
                dayStatusOverride: 'pending'
            });
            emitAttendanceRealtimeUpdate(req, {
                type: 'DOCUMENT_VERIFICATION_UPDATE',
                scheduleId: document.scheduleId,
                attendanceId: document.attendanceId || null,
                dayStatus: dayState?.dayStatus || null,
                attendanceUploaded: dayState?.attendanceUploaded ?? null,
                geoTagUploaded: dayState?.geoTagUploaded ?? null,
                message: 'Document rejected successfully'
            });
        }

        res.json({
            success: true,
            message: 'Document rejected successfully',
            data: document
        });
    } catch (error) {
        console.error('Error rejecting attendance document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reject document',
            error: error.message
        });
    }
});

// Manual attendance entry (SPOC Admin)
router.post('/manual', uploadManual, async (req, res) => {
    try {
        const {
            trainerId,
            collegeId,
            scheduleId,
            dayNumber,
            date,
            status,
            remarks,
            studentsPresent,
            studentsAbsent,
            syllabus
        } = req.body;

        if (!trainerId || !collegeId || !date) {
            return res.status(400).json({
                success: false,
                message: 'Trainer ID, College ID, and Date are required'
            });
        }

        const attendance = await Attendance.create({
            trainerId,
            collegeId,
            scheduleId: scheduleId || null,
            dayNumber: dayNumber || null,
            date: new Date(date),
            status: status || 'Present',
            remarks,
            uploadedBy: 'admin',
            isManualEntry: true,
            studentsPresent: studentsPresent || 0,
            studentsAbsent: studentsAbsent || 0,
            verificationStatus: 'approved',
            verifiedAt: new Date(),
            syllabus: syllabus || null
        });

        if (scheduleId) {
            const dayState = await syncScheduleDayState({ scheduleId, attendance });
            emitAttendanceRealtimeUpdate(req, {
                type: 'DAY_STATUS_UPDATE',
                scheduleId,
                attendanceId: attendance._id,
                dayStatus: dayState?.dayStatus || null,
                attendanceUploaded: dayState?.attendanceUploaded ?? null,
                geoTagUploaded: dayState?.geoTagUploaded ?? null,
                message: `Day status updated to ${dayState?.dayStatus || 'pending'}`
            });
        }

        res.status(201).json({
            success: true,
            message: 'Manual attendance created successfully',
            data: attendance
        });
    } catch (error) {
        console.error('Error creating manual attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create manual attendance',
            error: error.message
        });
    }
});

// Daily attendance entry for HR (no college required)
router.post('/trainer-daily', async (req, res) => {
    try {
        const { trainerId, date, status, remarks } = req.body;

        if (!trainerId || !date || !status) {
            return res.status(400).json({
                success: false,
                message: 'Trainer ID, Date, and Status are required'
            });
        }

        // Check if attendance already exists for this trainer and date
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        let attendance = await Attendance.findOne({
            trainerId,
            date: { $gte: startOfDay, $lte: endOfDay },
            collegeId: null // Only check for general attendance
        });

        if (attendance) {
            attendance.status = status;
            attendance.remarks = remarks;
            attendance.verifiedAt = new Date(); // Auto-verify
            await attendance.save();
        } else {
            attendance = await Attendance.create({
                trainerId,
                date: new Date(date),
                status,
                remarks,
                uploadedBy: 'admin',
                isManualEntry: true,
                verificationStatus: 'approved',
                verifiedAt: new Date(),
                collegeId: null // Explicitly null for general attendance
            });
        }

        res.json({
            success: true,
            message: 'Attendance marked successfully',
            data: attendance
        });
    } catch (error) {
        console.error('Error marking daily attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark attendance',
            error: error.message
        });
    }
});

// Get attendance by college
router.get('/college/:collegeId', async (req, res) => {
    try {
        const attendance = await Attendance.find({ collegeId: req.params.collegeId })
            .populate('trainerId')
            .populate('scheduleId')
            .populate('verifiedBy', 'name')
            .sort({ date: -1 });

        res.json({
            success: true,
            data: attendance
        });
    } catch (error) {
        console.error('Error fetching college attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance',
            error: error.message
        });
    }
});

// Admin uploads/updates attendance (PDF, Image, GeoTag)
router.post('/admin-upload', uploadAttendance, async (req, res) => {
    try {
        const { scheduleId, trainerId, collegeId, latitude, longitude, date } = req.body;



        if (!scheduleId) {
            return res.status(400).json({ success: false, message: 'Schedule ID is required' });
        }
        const schedule = await Schedule.findById(scheduleId).select('dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink departmentId dayNumber');
        if (!schedule) {
            return res.status(404).json({ success: false, message: 'Schedule not found' });
        }

        let attendance = await Attendance.findOne({ scheduleId });

        const attendancePdfUrl = req.files?.attendancePdf ? req.files.attendancePdf[0].path : undefined;
        const attendanceExcelUrl = req.files?.attendanceExcel ? req.files.attendanceExcel[0].path : undefined;
        const studentsPhotoUrl = req.files?.studentsPhoto ? req.files.studentsPhoto[0].path : undefined;

        let checkOutGeoImageUrls = undefined;
        let checkOutGeoImageUrl = undefined;
        if (req.files?.checkOutGeoImage) {
            checkOutGeoImageUrls = req.files.checkOutGeoImage.map(file => file.path);
            checkOutGeoImageUrl = checkOutGeoImageUrls[0];
        }

        if (attendance) {
            // Update existing
            if (attendancePdfUrl) attendance.attendancePdfUrl = attendancePdfUrl;
            if (attendanceExcelUrl) attendance.attendanceExcelUrl = attendanceExcelUrl;
            if (studentsPhotoUrl) attendance.studentsPhotoUrl = studentsPhotoUrl;
            if (checkOutGeoImageUrls) {
                attendance.checkOutGeoImageUrls = checkOutGeoImageUrls;
                attendance.checkOutGeoImageUrl = checkOutGeoImageUrl;
                // Reset verification status if new images are uploaded
                attendance.geoVerificationStatus = 'pending';
            }
            if (latitude) attendance.latitude = latitude;
            if (longitude) attendance.longitude = longitude;

            // Update statuses if provided
            if (req.body.verificationStatus) {
                attendance.verificationStatus = req.body.verificationStatus;
            }
            if (req.body.geoVerificationStatus) {
                attendance.geoVerificationStatus = req.body.geoVerificationStatus;
                // Sync main status with Geo Tag status
                if (req.body.geoVerificationStatus === 'approved') {
                    attendance.status = 'Present';
                } else if (req.body.geoVerificationStatus === 'rejected') {
                    attendance.status = 'Absent';
                }
            }
            
            if (req.body.syllabus) attendance.syllabus = req.body.syllabus;

        } else {
            // Create new
            if (!trainerId || !collegeId) {
                return res.status(400).json({ success: false, message: 'Trainer ID and College ID are required for new attendance' });
            }

            attendance = new Attendance({
                scheduleId,
                trainerId,
                collegeId,
                date: date ? new Date(date) : new Date(),
                attendancePdfUrl,
                attendanceExcelUrl,
                studentsPhotoUrl,
                latitude,
                longitude,
                checkOutGeoImageUrl,
                checkOutGeoImageUrls,
                verificationStatus: req.body.verificationStatus || 'pending',
                geoVerificationStatus: req.body.geoVerificationStatus || 'pending',
                status: req.body.geoVerificationStatus === 'approved' ? 'Present' : (req.body.geoVerificationStatus === 'rejected' ? 'Absent' : 'Pending'),
                verifiedBy: req.user ? req.user.id : undefined,
                verifiedAt: (req.body.verificationStatus === 'approved' || req.body.geoVerificationStatus === 'approved') ? new Date() : undefined,
                uploadedBy: 'admin'
            });

        }

        await syncAttendanceFilesToDrive({
            attendance,
            scheduleId,
            schedule,
            filesByField: req.files,
            contextLabel: 'admin-upload'
        });
        await attendance.save();
        const dayState = await syncScheduleDayState({ scheduleId, attendance });
        emitAttendanceRealtimeUpdate(req, {
            type: 'DAY_STATUS_UPDATE',
            scheduleId,
            attendanceId: attendance._id,
            dayStatus: dayState?.dayStatus || null,
            attendanceUploaded: dayState?.attendanceUploaded ?? null,
            geoTagUploaded: dayState?.geoTagUploaded ?? null,
            message: `Day status updated to ${dayState?.dayStatus || 'pending'}`
        });

        res.json({
            success: true,
            message: attendance?.driveAssets?.lastSyncError
                ? 'Attendance saved, but Drive sync failed'
                : 'Attendance uploaded successfully',
            driveSync: {
                synced: !attendance?.driveAssets?.lastSyncError,
                error: attendance?.driveAssets?.lastSyncError || null
            },
            data: attendance
        });

    } catch (error) {
        console.error('Error uploading attendance:', error);
        res.status(500).json({ success: false, message: 'Failed to upload attendance', error: error.message });
    }
});

// SPOC Admin verifies attendance (Approve/Reject)
router.put('/:id/verify', async (req, res) => {
    try {
        let { status, comment } = req.body;
        const attendanceId = req.params.id;

        // Normalize status - trim whitespace and convert to lowercase
        if (status) {
            status = status.toString().trim().toLowerCase();
        }

        // Validate status
        if (!status || !['approved', 'rejected', 'pending'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be "approved", "rejected", or "pending". Received: "${status}"`,
            });
        }

        // Use findByIdAndUpdate to update directly
        const updateData = {
            verificationStatus: status,
            verificationComment: comment || '',
            approvedBy: req.body.approvedBy || null,
            verifiedAt: new Date()
        };

        // If Check-In is rejected, automatically reject Check-Out too
        if (status === 'rejected') {
            updateData.geoVerificationStatus = 'rejected';
            updateData.status = 'Absent';
        }

        // If Check-In is approved, mark as Present
        if (status === 'approved') {
            updateData.status = 'Present';
        }

        const attendance = await Attendance.findByIdAndUpdate(
            attendanceId,
            updateData,
            { new: true, runValidators: true }
        );

        if (!attendance) {
            return res.status(404).json({
                success: false,
                message: 'Attendance record not found'
            });
        }

        // Ensure verified check-in/check-out documents are synced to Drive hierarchy.
        await syncStoredAttendanceFilesToDrive(attendance, `verify-check-in-${status}`);
        await updateScheduleDocumentsVerificationStatus({
            attendance,
            fileType: 'attendance',
            verificationStatus: status,
            verifiedBy: req.body.approvedBy || req.user?.id || null,
            rejectReason: status === 'rejected' ? comment : null
        });
        if (status === 'rejected') {
            await updateScheduleDocumentsVerificationStatus({
                attendance,
                fileType: 'geotag',
                verificationStatus: 'rejected',
                verifiedBy: req.body.approvedBy || req.user?.id || null,
                rejectReason: comment || 'Check-in rejected'
            });
        }

        // Notify Trainer on rejection
        if (status === 'rejected') {
            try {
                const populatedAttendance = await Attendance.findById(attendanceId)
                    .populate({
                        path: 'trainerId',
                        populate: { path: 'userId' }
                    })
                    .populate('collegeId');

                if (populatedAttendance && populatedAttendance.trainerId?.userId) {
                    await Notification.create({
                        userId: populatedAttendance.trainerId.userId._id,
                        title: 'Attendance Rejected',
                        message: `Your Check-In for Day ${populatedAttendance.dayNumber || 'N/A'} at ${populatedAttendance.collegeId?.name || 'College'} was rejected. Reason: ${comment || 'No reason provided'}`,
                        type: 'error',
                        link: '/trainer/schedule'
                    });
                }
            } catch (notifyError) {
                console.error('Error sending rejection notification:', notifyError);
            }
        }

        if (attendance.scheduleId) {
            await syncScheduleLifecycleStatusFromAttendance({
                scheduleId: attendance.scheduleId,
                attendance
            });
        }

        // If approved and both document streams are verified, notify Trainer of completion
        if (status === 'approved'
            && attendance.scheduleId
            && normalizeVerificationStatus(attendance?.geoVerificationStatus, '') === 'approved') {
            try {
                // Send Bell Notification to Trainer
                const populatedAttendance = await Attendance.findById(attendanceId)
                    .populate({
                        path: 'trainerId',
                        populate: { path: 'userId' }
                    })
                    .populate('collegeId')
                    .populate('scheduleId');

                if (populatedAttendance && populatedAttendance.trainerId?.userId) {
                    const courseName = populatedAttendance.scheduleId?.courseId?.name || 'Training';
                    await Notification.create({
                        userId: populatedAttendance.trainerId.userId._id,
                        title: '✅ Attendance Verified',
                        message: `Your attendance for Day ${populatedAttendance.dayNumber} at ${populatedAttendance.collegeId?.name || 'College'} has been approved.`,
                        type: 'success',
                        link: '/trainer/schedule'
                    });
                }
            } catch (syncError) {
                console.error('Error syncing schedule status or sending notification:', syncError);
            }
        }

        const dayState = attendance.scheduleId
            ? await syncScheduleDayState({ scheduleId: attendance.scheduleId, attendance })
            : null;

        // Notify via socket
        emitAttendanceRealtimeUpdate(req, {
            type: 'VERIFICATION_UPDATE',
            attendanceId: attendance._id,
            scheduleId: attendance.scheduleId || null,
            status: attendance.verificationStatus,
            dayStatus: dayState?.dayStatus || null,
            attendanceUploaded: dayState?.attendanceUploaded ?? null,
            geoTagUploaded: dayState?.geoTagUploaded ?? null,
            message: `Attendance verification status updated to ${attendance.verificationStatus}`
        });

        const allocatedDrivePath = await buildAllocatedDrivePathForSchedule(attendance.scheduleId);

        res.json({
            success: true,
            message: 'Attendance verification status updated',
            data: attendance,
            driveSync: {
                synced: !attendance?.driveAssets?.lastSyncError,
                error: attendance?.driveAssets?.lastSyncError || null
            },
            allocatedDrivePath
        });
    } catch (error) {
        console.error('Error verifying attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to verify attendance',
            error: error.message
        });
    }
});

// Verify Geo Tag (SPOC Admin)
router.put('/:id/verify-geo', async (req, res) => {
    try {
        const autoValidatedAttendance = await Attendance.findById(req.params.id)
            .select('geoVerificationStatus geoValidationComment status completedAt scheduleId');

        if (!autoValidatedAttendance) {
            return res.status(404).json({
                success: false,
                message: 'Attendance record not found'
            });
        }

        return res.status(410).json({
            success: false,
            message: 'Manual check-out approval is no longer available. Check-out status is auto-validated by date and location rules.',
            data: {
                attendanceId: autoValidatedAttendance._id,
                geoVerificationStatus: autoValidatedAttendance.geoVerificationStatus,
                geoValidationComment: autoValidatedAttendance.geoValidationComment || null,
                status: autoValidatedAttendance.status,
                completedAt: autoValidatedAttendance.completedAt || null,
                scheduleId: autoValidatedAttendance.scheduleId || null
            }
        });

        const { status, comment } = req.body;
        const attendanceId = req.params.id;

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Must be approved or rejected'
            });
        }

        // CRITICAL: Check if check-in is approved before allowing check-out approval
        if (status === 'approved') {
            const attendance = await Attendance.findById(attendanceId);
            if (!attendance) {
                return res.status(404).json({
                    success: false,
                    message: 'Attendance record not found'
                });
            }

            if (attendance.verificationStatus !== 'approved') {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot approve check-out: Check-in must be approved first. Current check-in status: ' + (attendance.verificationStatus || 'pending')
                });
            }
        }

        // Determine attendance status based on verification
        let attendanceStatus = undefined;
        if (status === 'approved') {
            attendanceStatus = 'Present';
        } else if (status === 'rejected') {
            attendanceStatus = 'Absent';
        }

        const updateData = {
            geoVerificationStatus: status,
            verificationComment: comment || '',
            approvedBy: req.body.approvedBy || null,
            verifiedAt: new Date()
        };

        if (attendanceStatus) {
            updateData.status = attendanceStatus;
        }

        const attendance = await Attendance.findByIdAndUpdate(
            attendanceId,
            updateData,
            { new: true, runValidators: true }
        );

        if (!attendance) {
            return res.status(404).json({
                success: false,
                message: 'Attendance record not found'
            });
        }

        // Ensure verified geo-tag evidence is synced to Drive hierarchy.
        await syncStoredAttendanceFilesToDrive(attendance, `verify-geo-${status}`);
        await updateScheduleDocumentsVerificationStatus({
            attendance,
            fileType: 'geotag',
            verificationStatus: status,
            verifiedBy: req.body.approvedBy || req.user?.id || null,
            rejectReason: status === 'rejected' ? comment : null
        });

        // Notify Trainer on rejection
        if (status === 'rejected') {
            try {
                const populatedAttendance = await Attendance.findById(attendanceId)
                    .populate({
                        path: 'trainerId',
                        populate: { path: 'userId' }
                    })
                    .populate('collegeId');

                if (populatedAttendance && populatedAttendance.trainerId?.userId) {
                    await Notification.create({
                        userId: populatedAttendance.trainerId.userId._id,
                        title: 'Geo-Tag Rejected',
                        message: `Your Check-Out / Geo-Tag for Day ${populatedAttendance.dayNumber || 'N/A'} at ${populatedAttendance.collegeId?.name || 'College'} was rejected. Reason: ${comment || 'No reason provided'}`,
                        type: 'error',
                        link: '/trainer/schedule'
                    });
                }
            } catch (notifyError) {
                console.error('Error sending geo-tag rejection notification:', notifyError);
            }
        }

        if (attendance.scheduleId) {
            await syncScheduleLifecycleStatusFromAttendance({
                scheduleId: attendance.scheduleId,
                attendance
            });
        }

        // Update Schedule status to 'COMPLETED' when check-out is approved
        if (status === 'approved' && attendance.scheduleId) {
            try {
                // Set completedAt timestamp and status
                attendance.completedAt = new Date();
                attendance.attendanceStatus = 'PRESENT'; // New Field
                await attendance.save();

                // Load schedule after lifecycle sync for downstream notifications.
                const schedule = await Schedule.findById(attendance.scheduleId)
                    .populate('courseId collegeId');

                // Send Bell Notification to Trainer
                try {
                    const populatedAttendance = await Attendance.findById(attendanceId)
                        .populate({
                            path: 'trainerId',
                            populate: { path: 'userId' }
                        })
                        .populate('collegeId')
                        .populate('courseId')
                        .populate({
                            path: 'scheduleId',
                            populate: { path: 'courseId' }
                        });

                    if (populatedAttendance && populatedAttendance.trainerId?.userId) {
                        const courseName = populatedAttendance.courseId?.name || populatedAttendance.courseId?.title || populatedAttendance.scheduleId?.courseId?.name || populatedAttendance.scheduleId?.courseId?.title || 'N/A';
                         const dayVal = `Day ${populatedAttendance.dayNumber || 'N/A'}`;

                        await Notification.create({
                            userId: populatedAttendance.trainerId.userId._id,
                            title: '✅ Training Day Completed',
                            message: `
Course: ${courseName}
College: ${populatedAttendance.collegeId?.name || 'N/A'}
Day: ${dayVal}
Date: ${new Date(populatedAttendance.date).toLocaleDateString()}
Status: Completed
`,
                            type: 'success',
                            link: '/trainer/schedule'
                        });

                        // Send Email Notification using Helper
                        await sendTrainingCompletionEmail(
                            populatedAttendance.trainerId.userId.email, 
                            populatedAttendance.trainerId.userId.name,
                            {
                                course: courseName,
                                college: populatedAttendance.collegeId?.name || 'N/A',
                                day: dayVal,
                                date: new Date(populatedAttendance.date).toLocaleDateString(),
                                status: 'COMPLETED',
                                portalUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/trainer/schedule`
                            }
                        );
                    }
                } catch (notifyError) {
                    console.error('Error sending completion notification:', notifyError);
                }
            } catch (scheduleError) {
                console.error('Error updating schedule status:', scheduleError);
            }
        }

        const dayState = attendance.scheduleId
            ? await syncScheduleDayState({ scheduleId: attendance.scheduleId, attendance })
            : null;
        emitAttendanceRealtimeUpdate(req, {
            type: 'GEO_VERIFICATION_UPDATE',
            attendanceId: attendance._id,
            scheduleId: attendance.scheduleId || null,
            status: attendance.geoVerificationStatus,
            dayStatus: dayState?.dayStatus || null,
            attendanceUploaded: dayState?.attendanceUploaded ?? null,
            geoTagUploaded: dayState?.geoTagUploaded ?? null,
            message: `Geo Tag verification status updated to ${attendance.geoVerificationStatus}`
        });

        res.json({
            success: true,
            message: 'Geo Tag verification status updated',
            data: attendance
        });
    } catch (error) {
        console.error('Error verifying geo tag:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to verify geo tag',
            error: error.message
        });
    }
});

// Submit Attendance (Trainer) - Replaces check-in/check-out flow for Student System
router.post('/submit', uploadAttendance, async (req, res) => {
    try {
        const { 
            scheduleId, trainerId, collegeId, dayNumber, 
            studentsPresent, studentsAbsent, studentList,
            latitude, longitude, locationCapturedAt
        } = req.body;

        if (!scheduleId || !trainerId || !collegeId) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const schedule = await Schedule.findById(scheduleId).select('trainerId collegeId collegeLocation dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink departmentId dayNumber');
        if (!schedule) {
            return res.status(404).json({ success: false, message: 'Invalid scheduleId' });
        }

        const uploadAccessError = validateAssignedScheduleUpload({
            schedule,
            trainerId,
            collegeId,
            dayNumber
        });
        if (uploadAccessError) {
            return res.status(uploadAccessError.status).json({
                success: false,
                message: uploadAccessError.message
            });
        }

        let distance = null;
        if (schedule.collegeLocation?.lat && schedule.collegeLocation?.lng && latitude && longitude) {
            try {
                distance = haversine(
                    { latitude: parseFloat(latitude), longitude: parseFloat(longitude) },
                    { latitude: schedule.collegeLocation.lat, longitude: schedule.collegeLocation.lng }
                );
            } catch (distanceError) {
                console.error('[SUBMIT] Distance calculation failed (non-blocking):', distanceError);
            }
        }

        // Parse student list
        let students = [];
        if (studentList) {
            try {
                students = JSON.parse(studentList);
            } catch (e) {
                console.error('Error parsing student list:', e);
            }
        }

        // Handle files
        let generatedAttendanceSheetFile = null;
        const attendancePdfUrl = req.files?.attendancePdf ? req.files.attendancePdf[0].path : undefined;
        const attendanceExcelUrl = req.files?.attendanceExcel ? req.files.attendanceExcel[0].path : undefined;
        let studentsPhotoUrl = undefined;
        if (req.files?.studentsPhoto) {
            studentsPhotoUrl = req.files.studentsPhoto.map(f => f.path); // Store generic photos
        }
        
        // Handle Signature
        const signatureUrl = req.files?.signature ? req.files.signature[0].path : undefined;

        // Activity evidence
        let activityPhotos = [];
        if (req.files?.activityPhotos) {
            activityPhotos = req.files.activityPhotos.map(f => f.path);
        }
        let activityVideos = [];
        if (req.files?.activityVideos) {
            activityVideos = req.files.activityVideos.map(f => f.path);
        }

        // Find or Create Attendance
        let attendance = await Attendance.findOne({ scheduleId });

        if (!attendance) {
            attendance = new Attendance({
                scheduleId,
                trainerId,
                collegeId,
                dayNumber,
                date: new Date(),
                uploadedBy: 'trainer'
            });
        }

        // Update fields
        const submitGeoInvalid = Number.isFinite(distance) && distance > ALLOWED_GEO_RANGE_METERS;
        attendance.checkInTime = new Date().toTimeString().split(' ')[0];
        attendance.checkOutTime = new Date().toTimeString().split(' ')[0]; // Auto checkout for this flow?
        attendance.status = submitGeoInvalid ? 'Pending' : 'Present';
        attendance.verificationStatus = 'pending';
        attendance.geoVerificationStatus = submitGeoInvalid ? 'pending' : 'approved';
        attendance.geoValidationComment = submitGeoInvalid
            ? `Location mismatch: you are ${Math.round(distance)} meters away from the assigned college.`
            : null;
        attendance.studentsPresent = studentsPresent || 0;
        attendance.studentsAbsent = studentsAbsent || 0;
        attendance.students = students; // Save detailed list
        
        if (attendancePdfUrl) attendance.attendancePdfUrl = attendancePdfUrl;
        if (attendanceExcelUrl) attendance.attendanceExcelUrl = attendanceExcelUrl;
        if (signatureUrl) attendance.signatureUrl = signatureUrl;
        if (latitude) attendance.latitude = latitude;
        if (longitude) attendance.longitude = longitude;
        if (locationCapturedAt) attendance.locationCapturedAt = locationCapturedAt;
        
        if (activityPhotos.length > 0) attendance.activityPhotos = activityPhotos;
        if (activityVideos.length > 0) attendance.activityVideos = activityVideos;

        // Generate Attendance Excel
        if (students.length > 0) {
            try {
                // Create Workbook
                const wb = xlsx.utils.book_new();
                
                // Format Data for Excel
                const excelData = students.map(s => ({
                    'Roll No': s.rollNo,
                    'Register No': s.registerNo,
                    'Student Name': s.name,
                    'Status': s.status
                }));

                const ws = xlsx.utils.json_to_sheet(excelData);
                xlsx.utils.book_append_sheet(wb, ws, "Attendance");

                // Define Path
                // Ensure directory exists
                const uploadDir = path.join(__dirname, '../uploads/attendance-sheets');
                if (!fs.existsSync(uploadDir)) {
                    fs.mkdirSync(uploadDir, { recursive: true });
                }

                // Filename: College_DayX_Date.xlsx
                const dateStr = new Date().toISOString().split('T')[0];
                const fileName = `Attendance_${collegeId}_Day${dayNumber}_${dateStr}_${Date.now()}.xlsx`;
                const filePath = path.join(uploadDir, fileName);

                // Write File
                xlsx.writeFile(wb, filePath);

                // Save URL (relative path for serving)
                // We'll need to serve specific route for this
                attendance.attendanceExcelUrl = fileName; 
                generatedAttendanceSheetFile = {
                    path: filePath,
                    originalname: fileName,
                    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                };

            } catch (err) {
                console.error('Error generating Excel:', err);
            }
        }

        const driveSyncFilesByField = { ...(req.files || {}) };
        if (generatedAttendanceSheetFile) {
            driveSyncFilesByField.attendanceExcel = [generatedAttendanceSheetFile];
        }

        await syncAttendanceFilesToDrive({
            attendance,
            scheduleId,
            schedule,
            filesByField: driveSyncFilesByField,
            contextLabel: 'submit'
        });
        await attendance.save();

        // Update Schedule status
        await Schedule.findByIdAndUpdate(scheduleId, { status: 'completed' });
        const dayState = await syncScheduleDayState({ scheduleId, attendance });
        emitAttendanceRealtimeUpdate(req, {
            type: 'DAY_STATUS_UPDATE',
            scheduleId,
            attendanceId: attendance._id,
            dayStatus: dayState?.dayStatus || null,
            attendanceUploaded: dayState?.attendanceUploaded ?? null,
            geoTagUploaded: dayState?.geoTagUploaded ?? null,
            message: `Day status updated to ${dayState?.dayStatus || 'pending'}`
        });

        res.json({
            success: true,
            message: attendance?.driveAssets?.lastSyncError
                ? 'Attendance submitted, but Drive sync failed'
                : 'Attendance submitted successfully',
            driveSync: {
                synced: !attendance?.driveAssets?.lastSyncError,
                error: attendance?.driveAssets?.lastSyncError || null
            },
            data: attendance
        });

    } catch (error) {
        console.error('Error submitting attendance:', error);
        res.status(500).json({ success: false, message: 'Failed to submit attendance', error: error.message });
    }
});

// Export Attendance to Excel (Dynamic)
router.get('/:id/export-excel', async (req, res) => {
    try {
        const attendance = await Attendance.findById(req.params.id)
            .populate({
                path: 'trainerId',
                populate: { path: 'userId', select: 'name' }
            })
            .populate('collegeId', 'name')
            .populate('scheduleId', 'subject courseId');
            
        if (!attendance) return res.status(404).json({ success: false, message: 'Attendance not found' });

        const wb = xlsx.utils.book_new();
        
        // Prepare Summary Header
        const aoaData = [
            ['ATTENDANCE REPORT'],
            ['Trainer', attendance.trainerId?.userId?.name || 'N/A'],
            ['College', attendance.collegeId?.name || 'N/A'],
            ['Topic', attendance.scheduleId?.subject || 'N/A'],
            ['Date', attendance.date ? new Date(attendance.date).toLocaleDateString() : 'N/A'],
            ['Check-In Time', attendance.checkInTime || 'N/A'],
            ['Check-In Dist', attendance.checkIn?.location?.distanceFromCollege ? `${Math.round(attendance.checkIn.location.distanceFromCollege)}m` : 'N/A'],
            ['Check-Out Time', attendance.checkOutTime || 'N/A'],
            ['Check-Out Dist', attendance.checkOut?.location?.distanceFromCollege ? `${Math.round(attendance.checkOut.location.distanceFromCollege)}m` : 'N/A'],
            ['Total Present', attendance.studentsPresent || 0],
            ['Total Absent', attendance.studentsAbsent || 0],
            [], // Spacer
            ['RollNo', 'RegisterNo', 'StudentName', 'Status'] // Header strictly as requested
        ];

        // Process Students
        let studentsToUse = [];
        if (attendance.students && attendance.students.length > 0) {
            // Sort numerically first
            studentsToUse = [...attendance.students].sort((a, b) => {
                const aNum = parseInt(a.rollNo?.replace(/\D/g, '') || '0') || 0;
                const bNum = parseInt(b.rollNo?.replace(/\D/g, '') || '0') || 0;
                return aNum - bNum;
            });
        } else {
            const filter = { collegeId: attendance.collegeId };
            if (attendance.courseId) filter.courseId = attendance.courseId;
            else if (attendance.scheduleId?.courseId) filter.courseId = attendance.scheduleId.courseId;
            studentsToUse = await Student.find(filter);
            // Sort numerically
            studentsToUse.sort((a, b) => {
                const aNum = parseInt(a.rollNo?.replace(/\D/g, '') || '0') || 0;
                const bNum = parseInt(b.rollNo?.replace(/\D/g, '') || '0') || 0;
                return aNum - bNum;
            });
        }

        const totalPresent = attendance.studentsPresent || 0;
        const totalAbsent = attendance.studentsAbsent || 0;

        studentsToUse.forEach((s, index) => {
            // Use sequential Index as RollNo for auditor clarity
            const rollNo = index + 1; 
            
            // Status distribution if session-specific data is missing
            let status = s.status;
            if (!status) {
                if (index < totalPresent) status = 'Present';
                else if (index < (totalPresent + totalAbsent)) status = 'Absent';
                else status = '-';
            }

            aoaData.push([
                rollNo,
                s.registerNo || '-',
                s.name || '-',
                status
            ]);
        });

        const ws = xlsx.utils.aoa_to_sheet(aoaData);
        xlsx.utils.book_append_sheet(wb, ws, "Attendance");
        
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        
        const collegeName = attendance.collegeId?.name || 'College';
        const dateStr = attendance.date ? new Date(attendance.date).toLocaleDateString().replace(/\//g, '-') : 'Date';
        const filename = `Attendance_${collegeName}_${dateStr}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.send(buffer);
    } catch (err) {
        console.error('Excel Export Error:', err);
        res.status(500).json({ success: false, message: 'Failed to generate excel', error: err.message });
    }
});

router.uploadSingleGeoImageMiddleware = uploadManual;
router.uploadSingleGeoImageHandler = uploadSingleGeoImageHandler;

module.exports = router;

